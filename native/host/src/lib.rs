//! Headless native experiments for raw descriptors and prepared MuTracer scenes.
//! Blocking probes and persistent contexts expose experimental subsets of MuTracer.
#![recursion_limit = "256"]
#[cfg(not(target_endian = "little"))]
compile_error!("Native byte conversions require a little-endian target");

use serde_json::json;
use std::{
    borrow::Cow,
    collections::HashMap,
    ffi::{CStr, c_char},
    fs,
    path::Path,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use wgpu::util::DeviceExt;
#[macro_use]
pub mod logging;
mod aov;
pub mod api;
mod caustics;
mod commit_plan;
mod compilation;
pub mod context;
pub mod denoise;
mod denoise_ffi;
mod denoiser_inputs;
mod depth;
mod device_loss;
pub mod display;
mod hardware;
mod hdr;
pub mod hit_diagnostics;
mod image_limits;
mod oidn_webgpu;
pub mod picking;
#[cfg(test)]
mod sample_audit;
#[cfg(test)]
mod test_support;
#[rustfmt::skip]
pub mod layout;
mod material_properties;
mod postprocess;
mod profiling;
mod runtime;
mod scene;
pub mod scene_api;
pub mod settings;
pub mod status;
pub mod submission;
mod tinybvh;
#[doc(hidden)]
pub mod viewer_math;
use status::{Status, classify, fail, rejected};
use submission::GpuQueue;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum AssetId {
    Packet(usize),
    GeometryPositions(usize),
    HardwareMap,
    HardwareShader,
    #[cfg(test)]
    Diagnostic(usize),
}
impl std::fmt::Display for AssetId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Packet(id) => write!(f, "native-{id}"),
            Self::GeometryPositions(id) => write!(f, "native-hwrt-positions-{id}"),
            Self::HardwareMap => write!(f, "native-hwrt-map"),
            Self::HardwareShader => write!(f, "native-hwrt-shader"),
            #[cfg(test)]
            Self::Diagnostic(id) => write!(f, "diagnostic-{id}"),
        }
    }
}
impl serde::Serialize for AssetId {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}
impl Default for AssetId {
    fn default() -> Self {
        Self::Packet(0)
    }
}
type Assets = HashMap<AssetId, Vec<u8>>;

// C callers and headless threads need not have Cocoa's event-loop pool. Drain
// temporary Metal objects per operation; persistent resources own their handles.
fn platform_scope<T>(body: impl FnOnce() -> T) -> T {
    #[cfg(target_os = "macos")]
    {
        objc2::rc::autoreleasepool(|_| body())
    }
    #[cfg(not(target_os = "macos"))]
    {
        body()
    }
}

unsafe extern "C" {
    fn mt_core_init();
    fn mt_core_reset();
    fn mt_core_collect();
    fn mt_core_frame(
        sample: f64,
        bounces: f64,
        seed: u32,
        output: *mut *const u8,
        size: *mut usize,
    );

}
// scriptc init initializes module globals on every invocation. Initialize once
// so a later GPU upload/context cannot erase another scene's rooted TS state.
fn init_core() {
    static INITIALIZED: std::sync::Once = std::sync::Once::new();
    INITIALIZED.call_once(|| unsafe { mt_core_init() });
}
// Diagnostic and blocking raw-scene operations serialize their probe state. The AOT heap
// itself is confined to runtime.rs, independently of context/GPU operations.
static ENTRY_LOCK: Mutex<()> = Mutex::new(());
// ABI tests share process-global AOT/registry state even on Rust's test workers.
#[cfg(test)]
static ABI_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Textures a retained lighting update may recreate at a new shape.
const RESIZABLE_TEXTURES: [usize; 4] = [
    layout::resource::ENVIRONMENT,
    layout::resource::ENVIRONMENT_CDF,
    layout::resource::BACKGROUND,
    layout::resource::LIGHT_SAMPLING,
];
#[derive(Clone)]
struct Scene {
    width: u32,
    height: u32,
    shader: AssetId,
    entry_point: String,
    buffers: Vec<Buffer>,
    textures: Vec<Texture>,
    samplers: Vec<usize>,
    bind_groups: Vec<Group>,
    rt_uniform: usize,
    hwrt: Option<hardware::Capture>,
    native_layout: Option<hardware::NativeLayout>,
}
/// Internal execution settings; flag4 requires authoritative HWRT.
#[derive(Clone, Copy, serde::Serialize)]
struct RenderOptions {
    pub flags: u32,
    pub samples: u32,
    pub seed: u32,
    pub bounces: f32,
}
impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            flags: 0,
            samples: 0,
            seed: 12345,
            bounces: 6.0,
        }
    }
}
unsafe fn copy_core_result(pointer: *const u8, size: usize, expected: usize) -> Result<Vec<u8>> {
    if pointer.is_null() || size != expected {
        return Err("Invalid AOT command length".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer, size) }.to_vec();
    unsafe {
        mt_core_reset();
    }
    Ok(bytes)
}
#[derive(Clone)]
struct Buffer {
    id: usize,
    size: u64,
    usage: u32,
    resource: AssetId,
}
#[derive(Clone)]
struct Texture {
    id: usize,
    width: u32,
    height: u32,
    depth: u32,
    format: wgpu::TextureFormat,
    usage: u32,
    writes: Vec<TextureWrite>,
}
#[derive(Clone)]
struct Group {
    layout: Vec<wgpu::BindGroupLayoutEntry>,
    entries: Vec<Binding>,
}
#[derive(Clone)]
struct Binding {
    binding: u32,
    kind: BindingKind,
    id: usize,
}

#[derive(Clone)]
struct TextureWrite {
    resource: AssetId,
    origin: wgpu::Origin3d,
    size: wgpu::Extent3d,
    layout: wgpu::TexelCopyBufferLayout,
}
#[derive(Clone, Copy)]
enum BindingKind {
    Buffer,
    Texture,
    Sampler,
}
fn storage_layout(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn with_error_scopes<T>(
    device: &wgpu::Device,
    operation: impl FnOnce() -> Result<T>,
    scope_error: impl FnOnce(wgpu::Error) -> Box<dyn std::error::Error>,
) -> Result<T> {
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let result = operation();
    let validation = pollster::block_on(validation.pop());
    let memory = pollster::block_on(memory.pop());
    match validation.or(memory) {
        Some(error) => Err(scope_error(error)),
        None => result,
    }
}

fn read_average(
    device: &wgpu::Device,
    queue: &GpuQueue,
    buffer: &wgpu::Buffer,
    width: u32,
    height: u32,
    samples: u32,
) -> Result<Vec<u8>> {
    let bytes = queue.read_buffer(
        device,
        buffer.slice(..u64::from(width) * u64::from(height) * 16),
    )?;
    let mut values: Vec<f32> = bytemuck::pod_collect_to_vec(&bytes);
    for value in &mut values {
        *value /= samples as f32;
        if !value.is_finite() {
            return Err("Non-finite native output".into());
        }
    }
    let values = bytemuck::cast_slice(&values).to_vec();
    Ok(values)
}

// Device-local keys compare the full source/layout as well as hashing them, so
// collisions cannot reuse an incompatible shader. Keep retained variants bounded.
#[derive(Hash, PartialEq, Eq)]
struct PipelineKey {
    source: String,
    entry: String,
    layout: Vec<Vec<wgpu::BindGroupLayoutEntry>>,
    hardware: bool,
}
#[derive(Clone)]
struct CachedPipeline {
    aov_pipelines: aov::PipelineCache,
    _shader: wgpu::ShaderModule,
    layouts: Vec<wgpu::BindGroupLayout>,
    pipeline: wgpu::ComputePipeline,
}
#[derive(Clone)]
struct GpuDevice {
    /// Clones share this identity; a recreated device never accepts old frames.
    frame_device: denoiser_inputs::DeviceKey,
    custom_snapshot_pipeline: Arc<std::sync::OnceLock<wgpu::ComputePipeline>>,
    loss: device_loss::DeviceLossNotifier,
    device: wgpu::Device,
    queue: GpuQueue,
    info: wgpu::AdapterInfo,
    hardware_ray_query: bool,
    adapter: wgpu::Adapter,
    pipelines: Arc<Mutex<HashMap<PipelineKey, CachedPipeline>>>,
    pipeline_cache: Option<wgpu::PipelineCache>,
    compilation: Arc<compilation::Compilation>,
}
impl GpuDevice {
    fn wait(device: &wgpu::Device) -> Result<()> {
        device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
        Ok(())
    }

    /// Wraps a host-owned device without replacing its device-loss callback.
    fn on_device(
        adapter: &wgpu::Adapter,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        gate: Option<Arc<submission::SubmissionGate>>,
    ) -> Self {
        Self {
            frame_device: denoiser_inputs::DeviceKey::new(),
            custom_snapshot_pipeline: Default::default(),
            loss: Default::default(),
            device: device.clone(),
            queue: GpuQueue::new(queue.clone(), gate),
            info: adapter.get_info(),
            adapter: adapter.clone(),
            hardware_ray_query: device
                .features()
                .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
            pipelines: Arc::new(Mutex::new(HashMap::new())),
            compilation: Default::default(),
            pipeline_cache: None,
        }
    }
    fn new(use_hwrt: bool) -> Result<Self> {
        Self::with_backend(if use_hwrt { 1 } else { 0 })
    }
    fn with_backend(mode: u32) -> Result<Self> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
            ..Default::default()
        }))?;
        Self::for_adapter(&adapter, mode)
    }
    fn adapters(instance: &wgpu::Instance) -> Vec<wgpu::Adapter> {
        let mut adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
        adapters.sort_by_key(|adapter| {
            let info = adapter.get_info();
            (
                format!("{:?}", info.backend),
                info.vendor,
                info.device,
                info.name,
            )
        });
        adapters
    }
    fn for_adapter(adapter: &wgpu::Adapter, mode: u32) -> Result<Self> {
        let info = adapter.get_info();
        native_log!(
            "Native adapter: {} ({:?}, {:?})",
            info.name,
            info.backend,
            info.device_type
        );
        let hardware_ray_query = adapter
            .features()
            .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
        let use_hwrt = mode != 0 && hardware_ray_query;
        let profile_features = adapter.features() & wgpu::Features::TIMESTAMP_QUERY
            | if profiling::gpu_enabled() {
                adapter.features() & wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS
            } else {
                wgpu::Features::empty()
            };
        let cache_feature = if info.backend == wgpu::Backend::Vulkan {
            adapter.features() & wgpu::Features::PIPELINE_CACHE
        } else {
            wgpu::Features::empty()
        };
        let denoise_features =
            oidn_webgpu::required_features() | oidn_webgpu::recommended_features(adapter);
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("MuTracer native feasibility"),
                required_limits: {
                    let mut limits = adapter.limits();
                    // wgpu 30 indirect validation addresses buffers with u32.
                    limits.max_buffer_size = limits.max_buffer_size.min(u32::MAX as u64);
                    limits
                },
                required_features: profile_features
                    | denoise_features
                    | cache_feature
                    | if use_hwrt {
                        wgpu::Features::EXPERIMENTAL_RAY_QUERY
                    } else {
                        wgpu::Features::empty()
                    },
                experimental_features: if use_hwrt
                    || denoise_features.contains(wgpu::Features::EXPERIMENTAL_COOPERATIVE_MATRIX)
                {
                    unsafe { wgpu::ExperimentalFeatures::enabled() }
                } else {
                    wgpu::ExperimentalFeatures::disabled()
                },
                ..Default::default()
            }))?;
        if profiling::gpu_enabled() {
            native_log!(
                "{}",
                json!({"nativeGpuCapabilities": {"timestampQuery": device.features().contains(wgpu::Features::TIMESTAMP_QUERY),"encoderTimestamps": device.features().contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)}})
            );
        }
        // No external cache bytes are accepted; wgpu owns the cache's lifetime.
        let pipeline_cache = if cache_feature.is_empty() {
            None
        } else {
            Some(unsafe {
                device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
                    label: Some("MuTracer device pipeline cache"),
                    data: None,
                    fallback: true,
                })
            })
        };
        let loss = device_loss::DeviceLossNotifier::default();
        let notify = loss.clone();
        device.set_device_lost_callback(move |reason, message| {
            notify.notify(format!("{reason:?}: {message}"));
        });
        Ok(Self {
            frame_device: denoiser_inputs::DeviceKey::new(),
            custom_snapshot_pipeline: Default::default(),
            loss,
            pipelines: Arc::new(Mutex::new(HashMap::new())),
            compilation: Default::default(),
            pipeline_cache,
            adapter: adapter.clone(),
            device,
            queue: GpuQueue::new(queue, None),
            info,
            hardware_ray_query,
        })
    }
}
/// Compiles (or reuses) the pipeline of `source` for the scene's group layouts.
/// Returns the pipeline and whether the device cache already held it.
fn compile_pipeline(
    gpu: &GpuDevice,
    scene: &Scene,
    source: String,
    hardware: bool,
) -> Result<(CachedPipeline, bool)> {
    let device = &gpu.device;
    let key = PipelineKey {
        source,
        entry: scene.entry_point.clone(),
        layout: scene.bind_groups.iter().map(|g| g.layout.clone()).collect(),
        hardware,
    };
    let mut cache = gpu.pipelines.lock().unwrap();
    if let Some(cached) = cache.get(&key) {
        gpu.compilation
            .hits
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return Ok((cached.clone(), true));
    }
    let _compiling = gpu.compilation.begin();
    let layouts: Vec<_> = scene
        .bind_groups
        .iter()
        .enumerate()
        .map(|(index, group)| {
            let mut entries: Vec<_> = group.layout.clone();
            if index == layout::group::SCENE && hardware {
                entries.extend([
                    wgpu::BindGroupLayoutEntry {
                        binding: layout::hwrt_binding::ACCELERATION as u32,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::AccelerationStructure {
                            vertex_return: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: layout::hwrt_binding::INDICES as u32,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ]);
            }
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("MuTracer capture layout"),
                entries: &entries,
            })
        })
        .collect();
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("MuTracer capture pipeline layout"),
        bind_group_layouts: &layouts.iter().map(Some).collect::<Vec<_>>(),
        ..Default::default()
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("MuTracer path tracer"),
        source: wgpu::ShaderSource::Wgsl(key.source.as_str().into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("MuTracer native path tracer"),
        layout: Some(&layout),
        module: &shader,
        entry_point: Some(&scene.entry_point),
        compilation_options: Default::default(),
        cache: gpu.pipeline_cache.as_ref(),
    });
    let compiled = CachedPipeline {
        aov_pipelines: Default::default(),
        _shader: shader,
        layouts,
        pipeline,
    };
    if cache.len() >= 32 {
        cache.clear();
    }
    cache.insert(key, compiled.clone());
    gpu.compilation
        .cached
        .store(cache.len(), std::sync::atomic::Ordering::Release);
    Ok((compiled, false))
}
/// One render's view of a shared scene (S2): its camera and trace uniforms,
/// accumulation outputs 10..13, the FRAME/OUTPUT groups binding them, and the
/// pipeline of its pattern/bevel-sample variant when it differs from the scene's.
struct Target {
    workgroup_size: u32,
    caustics: Option<caustics::State>,
    aov_shader: wgpu::ShaderModule,
    aov_pipelines: aov::PipelineCache,
    width: u32,
    height: u32,
    buffers: HashMap<usize, wgpu::Buffer>,
    pipeline: Option<wgpu::ComputePipeline>,
    /// FRAME and OUTPUT groups.
    groups: [wgpu::BindGroup; 2],
    samples: u32,
    frames: Vec<[u8; 16]>,
    /// Disabled targets allocate no frame guides or geometry history.
    frame_inputs: Option<Box<denoiser_inputs::GpuFrameHistory>>,
}
impl Target {
    #[allow(dead_code)]
    fn enable_frame_inputs(&mut self, gpu: &GpuDevice) -> &mut denoiser_inputs::GpuFrameHistory {
        self.frame_inputs.get_or_insert_with(|| {
            Box::new(denoiser_inputs::GpuFrameHistory::new(
                gpu.frame_device,
                [self.width, self.height],
            ))
        })
    }
    fn output(&self, kind: u32) -> Result<&wgpu::Buffer> {
        let id = match kind {
            0 => layout::resource::COLOR,
            1 => layout::resource::NORMAL,
            2 => layout::resource::ALBEDO,
            3 => layout::resource::SHADOW_CATCHER,
            _ => return Err("Unknown image kind".into()),
        };
        self.buffers
            .get(&id)
            .ok_or_else(|| "Missing output buffer".into())
    }
}
struct GpuScene {
    aov_pipelines: aov::PipelineCache,
    depth_shader: wgpu::ShaderModule,
    depth_pipeline: Arc<std::sync::OnceLock<depth::Pipeline>>,
    display_trace: Vec<u8>,
    retained: Option<scene::PreparedState>,
    gpu: GpuDevice,
    scene: Scene,
    buffers: HashMap<usize, wgpu::Buffer>,
    pipeline: wgpu::ComputePipeline,
    /// Layouts of `pipeline`; render targets bind their frame/output groups with them.
    layouts: Vec<wgpu::BindGroupLayout>,
    /// Whether `pipeline` is the HWRT production shader.
    hwrt_shader: bool,
    groups: Vec<wgpu::BindGroup>,
    textures: HashMap<usize, wgpu::Texture>,
    samplers: HashMap<usize, wgpu::Sampler>,
    hardware: Option<hardware::Resources>,
    compile_seconds: f64,
}
impl GpuScene {
    fn new(
        scene: Scene,
        options: &RenderOptions,
        assets: &Assets,
        gpu: GpuDevice,
    ) -> Result<(Self, Target)> {
        let (scene, target) = Self::new_reusing(scene, options, assets, gpu, None, None, true)?;
        Ok((scene, target.unwrap()))
    }
    fn new_reusing(
        scene: Scene,
        options: &RenderOptions,
        assets: &Assets,
        gpu: GpuDevice,
        reusable: Option<&HashMap<usize, wgpu::Buffer>>,
        reusable_hw: Option<&HashMap<hardware::HardwareBufferId, wgpu::Buffer>>,
        own_target: bool,
    ) -> Result<(Self, Option<Target>)> {
        // Drain validation/OOM errors before making a candidate scene visible to a context.
        with_error_scopes(
            &gpu.device,
            || {
                Self::upload(
                    scene,
                    options,
                    assets,
                    gpu.clone(),
                    reusable,
                    reusable_hw,
                    own_target,
                )
            },
            |error| {
                gpu.pipelines.lock().unwrap().clear();
                gpu.compilation
                    .cached
                    .store(0, std::sync::atomic::Ordering::Release);
                error.to_string().into()
            },
        )
    }

    fn upload(
        scene: Scene,
        options: &RenderOptions,
        assets: &Assets,
        gpu: GpuDevice,
        reusable: Option<&HashMap<usize, wgpu::Buffer>>,
        reusable_hw: Option<&HashMap<hardware::HardwareBufferId, wgpu::Buffer>>,
        own_target: bool,
    ) -> Result<(Self, Option<Target>)> {
        let read = |name: &AssetId| -> Result<Cow<'_, [u8]>> {
            assets
                .get(name)
                .map(|data| Cow::Borrowed(data.as_slice()))
                .ok_or_else(|| format!("Missing native resource {name:?}").into())
        };
        if scene.width == 0 || scene.height == 0 {
            return Err("Invalid capture".into());
        }
        let use_hwrt = options.flags & 4 != 0;
        if use_hwrt
            && !scene
                .hwrt
                .as_ref()
                .is_some_and(|capture| capture.eligible && capture.authoritative)
        {
            return Err(
                "Capture is not eligible for authoritative HWRT; use the raw scene API".into(),
            );
        }
        let device = &gpu.device;
        let queue = &gpu.queue;
        crate::image_limits::validate_target([scene.width, scene.height], &device.limits())?;
        for buffer in &scene.buffers {
            if buffer.size > device.limits().max_buffer_size
                || buffer.usage & wgpu::BufferUsages::STORAGE.bits() != 0
                    && buffer.size > u64::from(device.limits().max_storage_buffer_binding_size)
            {
                return Err("Scene buffer exceeds the selected GPU's buffer limits".into());
            }
        }
        for texture in &scene.textures {
            if texture.width.max(texture.height) > device.limits().max_texture_dimension_2d
                || texture.depth > device.limits().max_texture_array_layers
            {
                return Err("Scene texture exceeds the selected GPU's texture limits".into());
            }
        }
        runtime::init();
        let target_ids: Vec<_> = scene.bind_groups[layout::group::FRAME..]
            .iter()
            .flat_map(|group| &group.entries)
            .filter(|entry| {
                matches!(entry.kind, BindingKind::Buffer)
                    && entry.id != layout::resource::LIGHT_UNIFORM
            })
            .map(|entry| entry.id)
            .collect();
        let mut buffers = HashMap::new();
        let mut reused_bytes = 0u64;
        let mut allocated_bytes = 0u64;
        for buffer in &scene.buffers {
            if !own_target && target_ids.contains(&buffer.id) {
                continue;
            }
            let data = read(&buffer.resource)?;
            if data.len() as u64 != buffer.size {
                return Err("Capture buffer length mismatch".into());
            }
            let mut usage =
                wgpu::BufferUsages::from_bits(buffer.usage).ok_or("Invalid buffer usage")?;
            if use_hwrt && buffer.id == 3 && scene.native_layout.as_ref().is_some_and(|l| l.indexed)
            {
                usage |= wgpu::BufferUsages::BLAS_INPUT;
            }
            usage |= wgpu::BufferUsages::COPY_DST;
            let existing = reusable
                .and_then(|buffers| buffers.get(&buffer.id))
                .filter(|b| b.size() == buffer.size && b.usage() == usage);
            let gpu_buffer = if let Some(existing) = existing {
                queue.write_buffer(existing, 0, &data);
                reused_bytes += buffer.size;
                existing.clone()
            } else {
                allocated_bytes += buffer.size;
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(&format!("MuTracer {:?}", buffer.resource)),
                    contents: &data,
                    usage,
                })
            };
            buffers.insert(buffer.id, gpu_buffer);
        }
        let mut textures = HashMap::new();
        let mut views = HashMap::new();
        for texture in &scene.textures {
            let gpu_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("MuTracer texture"),
                size: wgpu::Extent3d {
                    width: texture.width,
                    height: texture.height,
                    depth_or_array_layers: texture.depth,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: texture.format,
                usage: wgpu::TextureUsages::from_bits(texture.usage)
                    .ok_or("Invalid texture usage")?,
                view_formats: &[],
            });
            for write in &texture.writes {
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &gpu_texture,
                        mip_level: 0,
                        origin: write.origin,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &read(&write.resource)?,
                    write.layout,
                    write.size,
                );
            }
            views.insert(
                texture.id,
                gpu_texture.create_view(&wgpu::TextureViewDescriptor::default()),
            );
            textures.insert(texture.id, gpu_texture);
        }
        let mut samplers = HashMap::new();
        for sampler in &scene.samplers {
            samplers.insert(
                *sampler,
                device.create_sampler(&wgpu::SamplerDescriptor {
                    label: Some("MuTracer maps"),
                    mag_filter: wgpu::FilterMode::Linear,
                    min_filter: wgpu::FilterMode::Linear,
                    ..Default::default()
                }),
            );
        }
        let hardware = if use_hwrt
            && !scene
                .hwrt
                .as_ref()
                .is_some_and(|capture| capture.authoritative && capture.instances.is_empty())
        {
            Some(hardware::prepare_reusing(
                &device,
                &queue,
                scene.hwrt.as_ref().unwrap(),
                assets,
                Some(&buffers),
                reusable_hw,
            )?)
        } else {
            None
        };
        let source = String::from_utf8(
            read(if use_hwrt {
                scene
                    .hwrt
                    .as_ref()
                    .unwrap()
                    .shader
                    .as_ref()
                    .ok_or("Missing HWRT shader")?
            } else {
                &scene.shader
            })?
            .into_owned(),
        )?;
        let shader_started = Instant::now();
        let (compiled, cache_hit) = compile_pipeline(&gpu, &scene, source, hardware.is_some())?;
        let CachedPipeline {
            aov_pipelines,
            layouts,
            pipeline,
            _shader: depth_shader,
        } = compiled;
        let compile_seconds = shader_started.elapsed().as_secs_f64();
        if std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1") {
            native_log!(
                "{}",
                json!({"nativeReuseProfile": {"pipelineCacheHit": cache_hit,
                "reusedBufferBytes": reused_bytes,"allocatedBufferBytes": allocated_bytes}})
            );
        }
        let groups: Vec<_> = scene
            .bind_groups
            .iter()
            .take(if own_target {
                scene.bind_groups.len()
            } else {
                layout::group::FRAME
            })
            .zip(layouts.iter())
            .enumerate()
            .map(|(index, (group, layout))| {
                let mut entries: Vec<_> = group
                    .entries
                    .iter()
                    .map(|entry| wgpu::BindGroupEntry {
                        binding: entry.binding,
                        resource: match entry.kind {
                            BindingKind::Buffer => buffers[&entry.id].as_entire_binding(),
                            BindingKind::Texture => {
                                wgpu::BindingResource::TextureView(&views[&entry.id])
                            }
                            BindingKind::Sampler => {
                                wgpu::BindingResource::Sampler(&samplers[&entry.id])
                            }
                        },
                    })
                    .collect();
                if index == layout::group::SCENE {
                    if let Some(resources) = &hardware {
                        entries.extend([
                            wgpu::BindGroupEntry {
                                binding: layout::hwrt_binding::ACCELERATION as u32,
                                resource: resources.tlas.as_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: layout::hwrt_binding::INDICES as u32,
                                resource: resources.mapping.as_entire_binding(),
                            },
                        ]);
                    }
                }
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("MuTracer capture resources"),
                    layout,
                    entries: &entries,
                })
            })
            .collect();
        let display_trace = read(&AssetId::Packet(scene.rt_uniform))?.into_owned();
        let mut groups = groups;
        let target = if own_target {
            let target_buffers = target_ids
                .into_iter()
                .filter_map(|id| buffers.remove(&id).map(|b| (id, b)))
                .collect();
            Some(Target {
                workgroup_size: 8,
                caustics: None,
                aov_shader: depth_shader.clone(),
                aov_pipelines: aov_pipelines.clone(),
                width: scene.width,
                height: scene.height,
                buffers: target_buffers,
                pipeline: None,
                groups: [
                    groups[layout::group::FRAME].clone(),
                    groups[layout::group::OUTPUT].clone(),
                ],
                samples: 0,
                frames: runtime::frames(options.bounces, options.seed)?,
                frame_inputs: None,
            })
        } else {
            None
        };
        groups.truncate(layout::group::FRAME);
        Ok((
            Self {
                aov_pipelines,
                depth_shader,
                depth_pipeline: Default::default(),
                display_trace,
                retained: None,
                gpu,
                scene,
                buffers,
                pipeline,
                layouts,
                hwrt_shader: use_hwrt,
                groups,
                textures,
                samplers,
                hardware,
                compile_seconds,
            },
            target,
        ))
    }
    fn add_samples(&self, target: &mut Target, additional: u32) -> Result<()> {
        let timer = profiling::GpuTimer::new(
            &self.gpu.device,
            additional * target.caustics.as_ref().map_or(1, |c| c.pass_count()),
            false,
        );
        self.dispatch_target(target, target.samples, additional, timer.as_ref())?;
        crate::GpuDevice::wait(&self.gpu.device)?;
        if profiling::gpu_enabled() {
            let gpu_ms = timer
                .as_ref()
                .and_then(|t| t.optional_milliseconds(&self.gpu.device, &self.gpu.queue));
            native_log!(
                "{}",
                json!({"nativeRenderProfile": {"firstSample": target.samples, "samples": additional, "kernelGpuMs": gpu_ms}})
            );
        }
        target.samples += additional;
        Ok(())
    }
    /// L1 coverage/background conversion; L0 remains a raw average.
    fn read_hdr(&self, target: &Target) -> Result<Vec<f32>> {
        hdr::read(
            &self.gpu,
            [target.output(0)?, target.output(1)?, target.output(2)?],
            [target.width, target.height],
            target.samples,
            display::Metadata::from_trace(&self.display_trace).opaque_background(),
        )
    }
    /// Builds a render target from its AOT packet, reusing `previous` buffers of
    /// the same size. The accumulation restarts.
    fn target(
        &self,
        packet: scene::TargetPacket,
        size: [u32; 2],
        previous: Option<Target>,
    ) -> Result<Target> {
        with_error_scopes(
            &self.gpu.device,
            || self.build_target(packet, size, previous),
            |error| error.to_string().into(),
        )
    }
    fn build_target(
        &self,
        packet: scene::TargetPacket,
        size: [u32; 2],
        previous: Option<Target>,
    ) -> Result<Target> {
        use layout::resource as res;
        crate::image_limits::validate_target(size, &self.gpu.device.limits())?;
        if self.scene.bind_groups[layout::group::OUTPUT].entries.len() != 4 {
            return Err("Render targets do not support instrumented scene outputs".into());
        }
        let device = &self.gpu.device;
        let queue = &self.gpu.queue;
        let caustic_packet = packet.caustics;
        let workgroup_size = caustic_packet
            .as_ref()
            .map_or(8, |p| p.metadata.workgroup_size);
        let target_scene = caustic_packet
            .as_ref()
            .map(|p| caustics::State::extend_scene(&self.scene, p))
            .unwrap_or_else(|| self.scene.clone());
        let (pipeline, layouts, aov_shader, aov_pipelines) = match packet.shader {
            Some(source) => {
                let (compiled, _) =
                    compile_pipeline(&self.gpu, &target_scene, source, self.hardware.is_some())?;
                (
                    Some(compiled.pipeline),
                    compiled.layouts,
                    compiled._shader,
                    compiled.aov_pipelines,
                )
            }
            None => (
                None,
                self.layouts.clone(),
                self.depth_shader.clone(),
                self.aov_pipelines.clone(),
            ),
        };
        let pixels = size[0] as u64 * size[1] as u64;
        let (mut reusable, mut frame_inputs) = previous
            .map(|t| (t.buffers, t.frame_inputs))
            .unwrap_or_default();
        if let Some(history) = &mut frame_inputs {
            history.resize(size);
        }
        let mut buffers = HashMap::new();
        let mut clear = Vec::new();
        for (id, bytes) in [
            (res::CAMERA, 144),
            (res::TRACE_UNIFORM, layout::ray_uniform::BYTES as u64),
            (res::COLOR, pixels * 16),
            (res::NORMAL, pixels * 16),
            (res::ALBEDO, pixels * 16),
            (res::SHADOW_CATCHER, pixels * 48),
        ] {
            let usage = wgpu::BufferUsages::from_bits(
                self.scene
                    .buffers
                    .iter()
                    .find(|b| b.id == id)
                    .ok_or("Missing target buffer declaration")?
                    .usage,
            )
            .ok_or("Invalid target buffer usage")?
                | wgpu::BufferUsages::COPY_DST;
            let buffer = match reusable.remove(&id).filter(|b| b.size() == bytes) {
                Some(buffer) => {
                    clear.push(id);
                    buffer
                }
                None => device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("MuTracer render target"),
                    size: bytes,
                    usage,
                    mapped_at_creation: false,
                }),
            };
            buffers.insert(id, buffer);
        }
        queue.write_buffer(&buffers[&res::CAMERA], 0, &packet.camera);
        queue.write_buffer(&buffers[&res::TRACE_UNIFORM], 0, &packet.trace);
        if !clear.is_empty() {
            let mut encoder = device.create_command_encoder(&Default::default());
            for id in clear.into_iter().filter(|id| *id >= res::COLOR) {
                encoder.clear_buffer(&buffers[&id], 0, None);
            }
            queue.submit([encoder.finish()]);
        }
        let caustics = caustic_packet
            .map(|packet| {
                caustics::State::new(
                    &self.gpu,
                    packet,
                    &layouts,
                    &self.scene,
                    &self.buffers,
                    &self.textures,
                    &self.samplers,
                    &buffers,
                    size,
                )
            })
            .transpose()?;
        let group = |index: usize, entries: &[(usize, &wgpu::Buffer)]| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("MuTracer render target resources"),
                layout: &layouts[index],
                entries: &entries
                    .iter()
                    .map(|(binding, buffer)| wgpu::BindGroupEntry {
                        binding: *binding as u32,
                        resource: buffer.as_entire_binding(),
                    })
                    .collect::<Vec<_>>(),
            })
        };
        let frame = group(
            layout::group::FRAME,
            &[
                (layout::frame_binding::CAMERA, &buffers[&res::CAMERA]),
                (
                    layout::frame_binding::TRACE_UNIFORM,
                    &buffers[&res::TRACE_UNIFORM],
                ),
                (
                    layout::frame_binding::LIGHT_UNIFORM,
                    &self.buffers[&res::LIGHT_UNIFORM],
                ),
            ],
        );
        let output = group(
            layout::group::OUTPUT,
            &[
                (
                    layout::output_binding::COLOR,
                    caustics
                        .as_ref()
                        .and_then(|c| c.pt_color.as_ref())
                        .unwrap_or(&buffers[&res::COLOR]),
                ),
                (layout::output_binding::NORMAL, &buffers[&res::NORMAL]),
                (layout::output_binding::ALBEDO, &buffers[&res::ALBEDO]),
                (
                    layout::output_binding::SHADOW_CATCHER,
                    &buffers[&res::SHADOW_CATCHER],
                ),
            ],
        );
        Ok(Target {
            workgroup_size,
            caustics,
            aov_shader,
            aov_pipelines,
            width: size[0],
            height: size[1],
            buffers,
            pipeline,
            groups: [frame, output],
            samples: 0,
            frames: packet.frames,
            frame_inputs,
        })
    }
    /// Submits samples `start..start + additional` of a target without waiting.
    fn dispatch_target(
        &self,
        target: &Target,
        start: u32,
        additional: u32,
        timer: Option<&profiling::GpuTimer>,
    ) -> Result<()> {
        let end = start
            .checked_add(additional)
            .ok_or("Sample count overflow")?;
        if additional == 0 || end > 16384 {
            return Err("Total samples must be 1..16384".into());
        }
        let device = &self.gpu.device;
        let queue = &self.gpu.queue;
        let samples = start..end;
        let groups = [
            &self.groups[layout::group::SCENE],
            target
                .caustics
                .as_ref()
                .map(|c| &c.textures)
                .unwrap_or(&self.groups[layout::group::TEXTURES]),
            &target.groups[0],
            &target.groups[1],
        ];
        let uniform = &target.buffers[&layout::resource::TRACE_UNIFORM];
        let pipeline = target.pipeline.as_ref().unwrap_or(&self.pipeline);
        for sample in samples {
            let frame = &target.frames[sample as usize];
            queue.write_buffer(
                uniform,
                layout::ray_uniform::SAMPLE_COUNT as u64,
                &frame[0..4],
            );
            queue.write_buffer(uniform, layout::ray_uniform::BOUNCES as u64, &frame[4..8]);
            queue.write_buffer(
                uniform,
                layout::ray_uniform::SEQUENCE_SEED as u64,
                &frame[8..12],
            );
            let mut encoder =
                device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            let pair = (sample - start) * target.caustics.as_ref().map_or(1, |c| c.pass_count());
            let pt_pair = pair + target.caustics.as_ref().map_or(0, |c| c.pt_pair());
            let batch = f32::from_le_bytes(frame[..4].try_into().unwrap()).max(0.) as u32;
            if let Some(c) = &target.caustics {
                c.before(
                    &self.gpu,
                    &mut encoder,
                    [groups[0], groups[1], groups[2]],
                    sample,
                    batch,
                    timer,
                    pair,
                );
            }
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    timestamp_writes: timer.map(|t| t.pass(pt_pair)),
                    ..Default::default()
                });
                pass.set_pipeline(pipeline);
                for (index, group) in groups.iter().enumerate() {
                    pass.set_bind_group(index as u32, *group, &[]);
                }
                pass.dispatch_workgroups(
                    target.width.div_ceil(target.workgroup_size),
                    target.height.div_ceil(target.workgroup_size),
                    1,
                );
            }
            if let Some(c) = &target.caustics {
                c.after(
                    &self.gpu,
                    &mut encoder,
                    [groups[0], groups[1], groups[2]],
                    batch,
                    timer,
                    pt_pair + 1,
                );
            }
            if sample + 1 == end {
                if let Some(t) = timer {
                    t.resolve(&mut encoder);
                }
            }
            queue.submit([encoder.finish()]);
        }
        Ok(())
    }
    fn read_target(&self, target: &Target, kind: u32) -> Result<Vec<u8>> {
        if target.samples == 0 {
            return Err("No completed samples".into());
        }
        read_average(
            &self.gpu.device,
            &self.gpu.queue,
            target.output(kind)?,
            target.width,
            target.height,
            target.samples,
        )
    }
    fn reset_target(&self, target: &mut Target) -> Result<()> {
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        for id in layout::resource::COLOR..=layout::resource::SHADOW_CATCHER {
            encoder.clear_buffer(&target.buffers[&id], 0, None);
        }
        self.gpu.queue.submit([encoder.finish()]);
        crate::GpuDevice::wait(&self.gpu.device)?;
        target.samples = 0;
        Ok(())
    }
    fn validate_lighting(
        &self,
        updates: &scene::LightingUpdates,
        target: Option<&Target>,
    ) -> Result<()> {
        use layout::resource as res;
        for (id, offset, width, height, data) in updates {
            if *id < layout::resource::ATLAS {
                let size = if let Some(buffer) = self
                    .buffers
                    .get(id)
                    .or_else(|| target.and_then(|t| t.buffers.get(id)))
                {
                    buffer.size()
                } else if target.is_none() && matches!(*id, res::CAMERA | res::TRACE_UNIFORM) {
                    // Shared scenes validate declaration sizes; update_lighting
                    // then skips CAMERA/TRACE_UNIFORM writes without a target.
                    self.scene
                        .buffers
                        .iter()
                        .find(|b| b.id == *id)
                        .ok_or("Missing updated scene buffer")?
                        .size
                } else {
                    return Err("Missing updated scene buffer".into());
                };
                if *offset > size || data.len() as u64 > size - offset {
                    return Err("Full scene commit required: scene write exceeds buffer".into());
                }
            } else {
                let texture = self.textures.get(id).ok_or("Missing lighting texture")?;
                // A texture write's destination is its array layer.
                if *offset >= u64::from(texture.depth_or_array_layers()) {
                    return Err("Texture write layer out of range".into());
                }
                // Environment, background and light sampling textures are
                // recreated at the new shape; other textures need a full commit.
                if (texture.width() != *width || texture.height() != *height)
                    && !RESIZABLE_TEXTURES.contains(id)
                {
                    return Err("Full scene commit required: texture shape changed".into());
                }
                let bpp = texture.format().block_copy_size(None).unwrap_or(0) as usize;
                if data.len() != *width as usize * *height as usize * bpp {
                    return Err("Lighting texture size mismatch".into());
                }
            }
        }
        Ok(())
    }
    fn prepare_geometry_hardware(
        &self,
        updates: &scene::LightingUpdates,
    ) -> Result<
        Option<(
            hardware::Resources,
            hardware::Capture,
            wgpu::BindGroup,
            Option<wgpu::Buffer>,
        )>,
    > {
        let Some(current) = self.scene.hwrt.as_ref().filter(|_| self.hardware.is_some()) else {
            return Ok(None);
        };
        if updates.changed_blases.is_some() {
            return with_error_scopes(
                &self.gpu.device,
                || -> Result<_> {
                    let resources = self.hardware.as_ref().unwrap().rebuild_changed(
                        &self.gpu.device,
                        &self.gpu.queue,
                        current,
                        updates,
                    )?;
                    let entries = [
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: self.buffers[&1].as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: self.buffers[&2].as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: self.buffers[&3].as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: self.buffers[&4].as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: layout::hwrt_binding::ACCELERATION as u32,
                            resource: resources.tlas.as_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: layout::hwrt_binding::INDICES as u32,
                            resource: resources.mapping.as_entire_binding(),
                        },
                    ];
                    let group = self
                        .gpu
                        .device
                        .create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("MuTracer changed geometry bindings"),
                            layout: &self.pipeline.get_bind_group_layout(0),
                            entries: &entries,
                        });
                    Ok(Some((resources, current.clone(), group, None)))
                },
                |error| {
                    format!("Full scene commit required: changed BLAS preparation: {error}").into()
                },
            );
        }
        let (capture, assets) = self
            .retained
            .as_ref()
            .ok_or("Missing retained geometry")?
            .hardware_geometry(updates)
            .map_err(|error| format!("Full scene commit required: {error}"))?;
        let device = &self.gpu.device;
        with_error_scopes(
            device,
            || {
                let attributes = if capture.indexed {
                    Some(
                        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("MuTracer candidate attributes"),
                            contents: assets
                                .get(&AssetId::Packet(3))
                                .ok_or("Missing updated attributes")?,
                            usage: self.buffers[&3].usage(),
                        }),
                    )
                } else {
                    None
                };
                let mut candidate_buffers = self.buffers.clone();
                if let Some(buffer) = &attributes {
                    candidate_buffers.insert(3, buffer.clone());
                }
                let result = hardware::prepare(
                    device,
                    &self.gpu.queue,
                    &capture,
                    &assets,
                    Some(&candidate_buffers),
                )
                .map(|resources| {
                    let mut entries: Vec<_> = (0..4)
                        .map(|i| wgpu::BindGroupEntry {
                            binding: i,
                            resource: candidate_buffers[&(i as usize + 1)].as_entire_binding(),
                        })
                        .collect();
                    entries.extend([
                        wgpu::BindGroupEntry {
                            binding: layout::hwrt_binding::ACCELERATION as u32,
                            resource: resources.tlas.as_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: layout::hwrt_binding::INDICES as u32,
                            resource: resources.mapping.as_entire_binding(),
                        },
                    ]);
                    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("MuTracer updated geometry"),
                        layout: &self.pipeline.get_bind_group_layout(0),
                        entries: &entries,
                    });
                    (resources, capture, group, attributes)
                });
                result.map(Some)
            },
            |error| {
                format!("Full scene commit required: hardware geometry preparation: {error}").into()
            },
        )
    }
    fn update_lighting(
        &mut self,
        updates: &scene::LightingUpdates,
        target: Option<&Target>,
    ) -> Result<()> {
        if let Some(layout) = &updates.native_layout {
            self.scene.native_layout = Some(layout.clone());
        }
        if profiling::enabled() {
            native_log!(
                "{}",
                json!({"nativeUploadProfile": {"writeBytes": updates.iter().map(|(_,_,_,_,data)| data.len()).sum::<usize>(), "resources": updates.iter().map(|(id,offset,_,_,data)| json!({"id": id,"offset":offset,"bytes": data.len()})).collect::<Vec<_>>()}})
            );
        }
        let mut replaced = Vec::new();
        for (id, _, width, height, _) in updates {
            let Some(current) = self
                .textures
                .get(id)
                .filter(|t| t.width() != *width || t.height() != *height)
            else {
                continue;
            };
            let texture = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("MuTracer texture"),
                size: wgpu::Extent3d {
                    width: *width,
                    height: *height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: current.format(),
                usage: current.usage(),
                view_formats: &[],
            });
            if let Some(record) = self.scene.textures.iter_mut().find(|t| t.id == *id) {
                (record.width, record.height) = (*width, *height);
            }
            self.textures.insert(*id, texture);
            replaced.push(*id);
        }
        if !replaced.is_empty() {
            self.rebind_textures(&replaced)?;
        }
        for (id, offset, width, height, data) in updates {
            if *id == self.scene.rt_uniform {
                let at = *offset as usize;
                self.display_trace[at..at + data.len()].copy_from_slice(data);
            }
            if *id < layout::resource::ATLAS {
                if let Some(buffer) = self
                    .buffers
                    .get(id)
                    .or_else(|| target.and_then(|t| t.buffers.get(id)))
                {
                    self.gpu.queue.write_buffer(buffer, *offset, data);
                }
            } else {
                let texture = &self.textures[id];
                self.gpu.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d {
                            x: 0,
                            y: 0,
                            z: *offset as u32,
                        },
                        aspect: wgpu::TextureAspect::All,
                    },
                    data,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(
                            *width * texture.format().block_copy_size(None).unwrap_or(0),
                        ),
                        rows_per_image: Some(*height),
                    },
                    wgpu::Extent3d {
                        width: *width,
                        height: *height,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }
        Ok(())
    }
    /// Rebuilds the bind groups that sample any of the `replaced` textures.
    fn rebind_textures(&mut self, replaced: &[usize]) -> Result<()> {
        let views: HashMap<_, _> = self
            .textures
            .iter()
            .map(|(id, texture)| (*id, texture.create_view(&Default::default())))
            .collect();
        for (index, group) in self.scene.bind_groups.iter().enumerate() {
            let uses = |entry: &Binding| {
                matches!(entry.kind, BindingKind::Texture) && replaced.contains(&entry.id)
            };
            if !group.entries.iter().any(uses) {
                continue;
            }
            if index == layout::group::SCENE {
                return Err("Scene group textures cannot be resized".into());
            }
            let entries: Vec<_> = group
                .entries
                .iter()
                .map(|entry| wgpu::BindGroupEntry {
                    binding: entry.binding,
                    resource: match entry.kind {
                        BindingKind::Buffer => self.buffers[&entry.id].as_entire_binding(),
                        BindingKind::Texture => {
                            wgpu::BindingResource::TextureView(&views[&entry.id])
                        }
                        BindingKind::Sampler => {
                            wgpu::BindingResource::Sampler(&self.samplers[&entry.id])
                        }
                    },
                })
                .collect();
            self.groups[index] = self
                .gpu
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("MuTracer capture resources"),
                    layout: &self.pipeline.get_bind_group_layout(index as u32),
                    entries: &entries,
                });
        }
        Ok(())
    }
    fn update_material(&mut self, packed: &[u8]) -> Result<()> {
        let buffer = self
            .buffers
            .get(&layout::resource::MATERIALS)
            .ok_or("Missing raw material buffer")?;
        if buffer.size() != packed.len() as u64 {
            return Err("Material buffer size mismatch".into());
        }
        self.gpu.queue.write_buffer(buffer, 0, packed);
        Ok(())
    }
}

fn render_scene(
    scene: Scene,
    output: &Path,
    options: &RenderOptions,
    assets: &Assets,
) -> Result<()> {
    let samples = options.samples;
    if samples == 0 || samples > 16384 {
        return Err("Samples must be 1..16384".into());
    }
    fs::create_dir_all(output)?;
    let start = Instant::now();
    let use_hwrt = options.flags & 4 != 0;
    let gpu = GpuDevice::new(use_hwrt)?;
    let (gpu_scene, mut target) = GpuScene::new(scene, options, assets, gpu)?;
    let compile_seconds = gpu_scene.compile_seconds;
    let hardware_ray_query = gpu_scene.gpu.hardware_ray_query;
    native_log!("Native pipeline ready in {compile_seconds:.2}s; tracing {samples} samples...");
    let render_started = Instant::now();
    gpu_scene.add_samples(&mut target, samples)?;
    let scene = &gpu_scene.scene;
    let info = &gpu_scene.gpu.info;
    let averaged = gpu_scene.read_target(&target, 0)?;
    let mapped = &averaged;
    let mut aov_outputs = Vec::new();
    for (name, id) in [
        ("normal", layout::resource::NORMAL),
        ("albedo", layout::resource::ALBEDO),
    ] {
        let values = read_average(
            &gpu_scene.gpu.device,
            &gpu_scene.gpu.queue,
            target.buffers.get(&id).ok_or("Missing AOV buffer")?,
            scene.width,
            scene.height,
            samples,
        )?;
        fs::write(output.join(format!("{name}.rgba32f")), values)?;
        aov_outputs.push(name);
    }
    let hdr = mapped.clone();
    let mut rgb = Vec::with_capacity(scene.width as usize * scene.height as usize * 3);
    let mut minimum = f32::INFINITY;
    let mut maximum = f32::NEG_INFINITY;
    let mut mean = 0.0f64;
    for pixel in mapped.chunks_exact(16) {
        for channel in 0..4 {
            let v = f32::from_le_bytes(pixel[channel * 4..channel * 4 + 4].try_into()?);
            if !v.is_finite() {
                return Err("Non-finite native HDR pixel".into());
            }
            if channel < 3 {
                minimum = minimum.min(v);
                maximum = maximum.max(v);
                mean += v as f64;
                // Preview only: Reinhard plus sRGB. HDR is the comparison artifact.
                let linear = v.max(0.0) / (1.0 + v.max(0.0));
                let srgb = if linear <= 0.0031308 {
                    12.92 * linear
                } else {
                    1.055 * linear.powf(1.0 / 2.4) - 0.055
                };
                rgb.push((srgb.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
            }
        }
    }
    let render_seconds = render_started.elapsed().as_secs_f64();
    fs::write(output.join("render.rgba32f"), &hdr)?;
    // MuTracer's tracing coordinates have a bottom-left origin; PNG is top-left.
    let row_bytes = scene.width as usize * 3;
    for y in 0..scene.height as usize / 2 {
        let opposite = scene.height as usize - 1 - y;
        let (top, bottom) = rgb.split_at_mut(opposite * row_bytes);
        top[y * row_bytes..(y + 1) * row_bytes].swap_with_slice(&mut bottom[..row_bytes]);
    }
    let mut png = png::Encoder::new(
        fs::File::create(output.join("render.png"))?,
        scene.width,
        scene.height,
    );
    png.set_color(png::ColorType::Rgb);
    png.set_depth(png::BitDepth::Eight);
    png.write_header()?.write_image_data(&rgb)?;
    fs::write(
        output.join("result.json"),
        serde_json::to_vec_pretty(&json!({
            "width": scene.width, "height": scene.height, "samples": samples,
            "adapter": info.name, "backend": format!("{:?}", info.backend),
            "hardwareRayQuerySupported": hardware_ray_query, "hardwareRayTracingUsed": use_hwrt,
            "intersectionBackend": if use_hwrt { "authoritative HWRT" } else { "software BVH" },
            "shaderCompileSeconds": compile_seconds, "renderReadbackSeconds": render_seconds,
            "totalSeconds": start.elapsed().as_secs_f64(), "rgbMin": minimum, "rgbMax": maximum,
            "rgbMean": mean / (scene.width as f64 * scene.height as f64 * 3.0),
            "finitePixels": scene.width as u64 * scene.height as u64,
            "nativeSceneConstruction": true,
            "aot": "native input decoding, shared scene assembly/BLAS/TLAS/attributes/materials/atlas/lights/camera/full WGSL, sampling and frame packing",
            "nativeOptions": options,
            "buildTimeJavaScript": "none for scene construction or rendering",
            "runtime": "native Rust + scriptc machine code + wgpu; no Node/JS engine",
            "preview": "Reinhard + sRGB; compare render.rgba32f for numerical validation",
            "aovOutputs": aov_outputs,
            "hdrLayout": "little-endian f32 RGBA, bottom row first; linear sample average",
            "wholeLibraryNative": false
        }))?,
    )?;
    native_log!("Saved {}", output.join("render.png").display());
    Ok(())
}
