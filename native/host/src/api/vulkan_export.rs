//! Same-device Vulkan foreign image/timeline imports.
//!
//! The wrapper intentionally keeps native ownership with the host.  wgpu-hal's
//! Vulkan external-memory texture path is used only after the engine has
//! imported the exact host VkDevice.
use super::{Engine, OutputKind, PixelKind, Render, Result, Status, error};
use ash::vk;
use ash::vk::Handle;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use wgpu::hal::api::Vulkan;
use wgpu::util::DeviceExt;

fn invalid(message: &str) -> super::Error {
    error(Status::InvalidArgument, message)
}
fn unavailable() -> super::Error {
    error(Status::Unavailable, "Vulkan GPU export is unavailable")
}

/// Borrowed wrapper for a host-owned Vulkan image imported on an engine device.
#[derive(Clone)]
pub struct VulkanImage {
    pub(super) engine: Engine,
    pub(super) texture: wgpu::Texture,
    pub(super) raw_id: usize,
}

/// Borrowed wrapper for a host-owned Vulkan timeline semaphore.
#[derive(Clone)]
pub struct VulkanTimeline {
    pub(super) engine: Engine,
    pub(super) semaphore: vk::Semaphore,
    pub(super) last_signal: Arc<Mutex<u64>>,
}

/// Export state is kept on the engine so timelines remain canonical across
/// repeated imports and completion can be polled without a blocking wait.
pub(crate) struct State {
    pub(super) sequence: u64,
    pub(super) completed: u64,
    pending: Vec<Pending>,
    pub(super) pipelines: HashMap<(wgpu::TextureFormat, u8, bool), wgpu::ComputePipeline>,
    pub(super) timelines: HashMap<u64, Arc<Mutex<u64>>>,
}
impl State {
    pub(super) fn new() -> Self {
        Self { sequence: 0, completed: 0, pending: vec![], pipelines: HashMap::new(), timelines: HashMap::new() }
    }
}
struct Pending {
    sequence: u64,
    complete: Arc<AtomicBool>,
    done: VulkanTimeline,
    value: u64,
    _images: Vec<wgpu::Texture>,
    _sources: Vec<Source>,
    _ready: Option<VulkanTimeline>,
}
enum Source {
    Hdr([wgpu::Buffer; 3], [u32; 4]),
    Texture(wgpu::Texture),
}
impl Source {
    fn size(&self) -> wgpu::Extent3d {
        match self {
            Self::Hdr(_, p) => wgpu::Extent3d { width: p[0], height: p[1], depth_or_array_layers: 1 },
            Self::Texture(t) => t.size(),
        }
    }
}

fn format(format: vk::Format) -> Result<wgpu::TextureFormat> {
    match format {
        vk::Format::R32G32B32A32_SFLOAT => Ok(wgpu::TextureFormat::Rgba32Float),
        vk::Format::R16G16B16A16_SFLOAT => Ok(wgpu::TextureFormat::Rgba16Float),
        vk::Format::R32_SFLOAT => Ok(wgpu::TextureFormat::R32Float),
        vk::Format::R8G8B8A8_UNORM => Ok(wgpu::TextureFormat::Rgba8Unorm),
        _ => Err(unavailable()),
    }
}

impl Engine {
    /// Wrap a host-owned VkImage from this engine's imported VkDevice.
    ///
    /// The wrapper does not destroy the image or its memory. The host must
    /// retain both through all accepted exports and until the wrapper is
    /// released; storage usage, one mip/layer/sample and the declared layout
    /// are required. A host consumer on another queue must use concurrent
    /// sharing or explicit queue-family ownership transfers around the
    /// imported ready/done timeline values.
    ///
    /// # Safety
    /// `image` and its memory must remain valid until the returned wgpu work is
    /// retired. They must be created by the same VkDevice as this engine.
    pub unsafe fn import_vulkan_image(
        &self,
        image: vk::Image,
        image_format: vk::Format,
        width: u32,
        height: u32,
        initial_layout: vk::ImageLayout,
    ) -> Result<VulkanImage> {
        self.check_device()?;
        if image.is_null() || width == 0 || height == 0 {
            return Err(invalid("Null Vulkan image or invalid dimensions"));
        }
        let format = format(image_format)?;
        let limits = self.inner.gpu.device.limits();
        if width > limits.max_texture_dimension_2d || height > limits.max_texture_dimension_2d {
            return Err(invalid("Vulkan image exceeds device limits"));
        }
        let hal = unsafe { self.inner.gpu.device.as_hal::<Vulkan>() }.ok_or_else(unavailable)?;
        let desc = wgpu::hal::TextureDescriptor {
            label: Some("MuTracer imported Vulkan image"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUses::STORAGE_WRITE_ONLY | wgpu::TextureUses::RESOURCE,
            memory_flags: wgpu::hal::MemoryFlags::empty(),
            view_formats: vec![],
        };
        // External memory and a callback are both required: None would make
        // wgpu-hal destroy the host VkImage.
        let raw = unsafe {
            hal.texture_from_raw(
                image,
                &desc,
                Some(Box::new(|| {})),
                wgpu::hal::vulkan::TextureMemory::External,
            )
        };
        let initial = if initial_layout == vk::ImageLayout::UNDEFINED {
            wgpu::TextureUses::UNINITIALIZED
        } else {
            wgpu::TextureUses::RESOURCE
        };
        let texture = unsafe {
            self.inner.gpu.device.create_texture_from_hal::<Vulkan>(
                raw,
                &wgpu::TextureDescriptor {
                    label: Some("MuTracer imported Vulkan image"),
                    size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                initial,
            )
        };
        Ok(VulkanImage { engine: self.clone(), texture, raw_id: image.as_raw() as usize })
    }

    /// Import a host-owned Vulkan timeline semaphore. The device identity is
    /// established by the engine's imported VkDevice; the handle is never
    /// closed. The semaphore must have the Vulkan timeline feature enabled;
    /// signal values are strictly increasing and `u64::MAX` is reserved.
    ///
    /// # Safety
    /// `semaphore` must be a valid timeline semaphore created by the exact
    /// imported VkDevice and must remain alive until all accepted exports have
    /// drained and the wrapper has been released.
    pub unsafe fn import_vulkan_timeline(&self, semaphore: vk::Semaphore) -> Result<VulkanTimeline> {
        self.check_device()?;
        if semaphore.is_null() {
            return Err(invalid("Null Vulkan timeline semaphore"));
        }
        let hal = unsafe { self.inner.gpu.device.as_hal::<Vulkan>() }.ok_or_else(unavailable)?;
        let value = unsafe { hal.raw_device().get_semaphore_counter_value(semaphore) }
            .map_err(|e| error(Status::InvalidArgument, format!("Vulkan semaphore is not a timeline: {e}")))?;
        Ok(VulkanTimeline { engine: self.clone(), semaphore, last_signal: Arc::new(Mutex::new(value)) })
    }
}

impl Render {
    pub(super) fn export_vulkan(
        &self,
        images: &[(VulkanImage, u32, u32)],
        ready: Option<(&VulkanTimeline, u64)>,
        done: (&VulkanTimeline, u64),
    ) -> Result<u64> {
        let engine = self.engine().clone();
        if images.is_empty() || images.len() > 8 || !Arc::ptr_eq(&engine.inner, &done.0.engine.inner) {
            return Err(invalid("Invalid Vulkan export images or done timeline"));
        }
        if done.1 == 0 || done.1 == u64::MAX {
            return Err(invalid("Invalid Vulkan done value"));
        }
        if let Some((r, value)) = ready {
            if !Arc::ptr_eq(&engine.inner, &r.engine.inner) || value == u64::MAX {
                return Err(invalid("Invalid Vulkan ready timeline"));
            }
        }
        let mut sources = Vec::new();
        for (image, kind, rows) in images {
            if !Arc::ptr_eq(&engine.inner, &image.engine.inner) || *rows > 1 {
                return Err(invalid("Vulkan image belongs to another engine or has invalid row order"));
            }
            let source = match *kind {
                0 => { let (buffers, params) = self.metal_hdr_inputs()?; Source::Hdr(buffers, params) },
                1 => Source::Texture(self.get_aov_texture(PixelKind::Depth)?.ok_or_else(|| error(Status::InvalidState, "No completed depth image"))?),
                2 => Source::Texture(self.get_output_texture(OutputKind::Display)?.ok_or_else(|| error(Status::InvalidState, "No composed display image"))?),
                3 => Source::Texture(self.get_aov_texture(PixelKind::CenterDepth)?.ok_or_else(|| error(Status::InvalidState, "No completed center depth image"))?),
                _ => return Err(invalid("Unknown Vulkan output kind")),
            };
            if source.size() != image.texture.size() {
                return Err(invalid("Vulkan export dimensions do not match"));
            }
            let valid = match *kind {
                0 => matches!(image.texture.format(), wgpu::TextureFormat::Rgba32Float | wgpu::TextureFormat::Rgba16Float),
                1 | 3 => matches!(image.texture.format(), wgpu::TextureFormat::R32Float | wgpu::TextureFormat::Rgba32Float),
                2 => image.texture.format() == wgpu::TextureFormat::Rgba8Unorm,
                _ => false,
            };
            if !valid { return Err(invalid("Vulkan export format does not match output kind")); }
            sources.push(source);
        }
        let mut state_guard = engine.inner.vulkan.lock().unwrap();
        let state = state_guard.as_mut().ok_or_else(unavailable)?;
        if state.pending.len() >= 32 { return Err(error(Status::Busy, "32 GPU exports are pending")); }
        let mut last = done.0.last_signal.lock().unwrap();
        if done.1 <= *last { return Err(invalid("Vulkan done values must strictly increase")); }
        let gpu = &engine.inner.gpu;
        let images_ref = images;
        gpu.queue.exclusive_submit(|queue| -> Result<u64> {
            let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("MuTracer Vulkan output export") });
            for ((image, kind, rows), source) in images_ref.iter().zip(&sources) {
                let format = image.texture.format();
                let key = (format, *kind as u8, *rows == 1);
                let pipeline = state.pipelines.entry(key).or_insert_with(|| {
                    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("Vulkan output conversion"), source: wgpu::ShaderSource::Wgsl(shader(format, *kind as u8, *rows == 1).into()) });
                    let mut entries = Vec::new();
                    if *kind == 0 {
                        for binding in 0..3 { entries.push(wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None }); }
                        entries.push(wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None });
                    } else { entries.push(wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None }); }
                    entries.push(wgpu::BindGroupLayoutEntry { binding: 4, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format, view_dimension: wgpu::TextureViewDimension::D2 }, count: None });
                    let layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &entries });
                    let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
                    gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some("Vulkan host image export"), layout: Some(&pl), module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None })
                });
                let input = match source { Source::Texture(t) => Some(t.create_view(&Default::default())), Source::Hdr(_, _) => None };
                let params = match source { Source::Hdr(_, p) => Some(gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(p), usage: wgpu::BufferUsages::UNIFORM })), _ => None };
                let mut bindings = Vec::new();
                match source { Source::Hdr(bufs, _) => { for (i, b) in bufs.iter().enumerate() { bindings.push(wgpu::BindGroupEntry { binding: i as u32, resource: b.as_entire_binding() }); } bindings.push(wgpu::BindGroupEntry { binding: 3, resource: params.as_ref().unwrap().as_entire_binding() }); }, Source::Texture(_) => bindings.push(wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(input.as_ref().unwrap()) }) }
                let output = image.texture.create_view(&Default::default());
                bindings.push(wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&output) });
                let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipeline.get_bind_group_layout(0), entries: &bindings });
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { ..Default::default() });
                pass.set_pipeline(pipeline); pass.set_bind_group(0, &group, &[]); pass.dispatch_workgroups(source.size().width.div_ceil(8), source.size().height.div_ceil(8), 1);
            }
            let command = encoder.finish();
            let sequence = state.sequence.checked_add(1).ok_or_else(|| error(Status::Error, "GPU sequence exhausted"))?;
            let complete = Arc::new(AtomicBool::new(false));
            let flag = complete.clone();
            let hal = unsafe { queue.as_hal::<Vulkan>() }.ok_or_else(unavailable)?;
            if let Some((r, value)) = ready { hal.add_wait_semaphore(r.semaphore, Some(value), vk::PipelineStageFlags::ALL_COMMANDS); }
            hal.add_signal_semaphore(done.0.semaphore, Some(done.1));
            *last = done.1; state.sequence = sequence;
            let retained_images = images.iter().map(|(i, _, _)| i.texture.clone()).collect();
            let pending = Pending { sequence, complete, done: done.0.clone(), value: done.1, _images: retained_images, _sources: sources, _ready: ready.map(|(r, _)| r.clone()) };
            state.pending.push(pending);
            queue.submit([command]);
            queue.on_submitted_work_done(move || { flag.store(true, Ordering::Release); });
            Ok(sequence)
        })
    }
}

impl Engine {
    pub(super) fn poll_vulkan_exports(&self, sequence: u64) -> Result<bool> {
        self.poll_device();
        self.check_device()?;
        let mut guard = self.inner.vulkan.lock().unwrap();
        let state = guard.as_mut().ok_or_else(unavailable)?;
        if sequence > state.sequence { return Err(invalid("Unknown Vulkan GPU export sequence")); }
        let hal = unsafe { self.inner.gpu.device.as_hal::<Vulkan>() }.ok_or_else(unavailable)?;
        while let Some(work) = state.pending.first() {
            let signaled = unsafe { hal.raw_device().get_semaphore_counter_value(work.done.semaphore) }.unwrap_or(0);
            if !work.complete.load(Ordering::Acquire) || signaled < work.value { break; }
            state.completed = work.sequence;
            state.pending.remove(0);
        }
        Ok(state.completed >= if sequence == 0 { state.sequence } else { sequence })
    }
}

fn shader(format: wgpu::TextureFormat, kind: u8, flip: bool) -> String {
    let output = match format { wgpu::TextureFormat::Rgba32Float => "rgba32float", wgpu::TextureFormat::Rgba16Float => "rgba16float", wgpu::TextureFormat::R32Float => "r32float", _ => "rgba8unorm" };
    let input = if kind == 0 { include_str!("metal-hdr-resolve.wgsl") } else { "@group(0) @binding(0) var input: texture_2d<f32>;" };
    let convert = if kind == 1 {
        if format == wgpu::TextureFormat::R32Float { "v.x" } else { "vec4f(v.x,0,0,v.y)" }
    } else { "v" };
    format!("{input}\n@group(0) @binding(4) var output: texture_storage_2d<{output},write>;\n@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {{ let size=textureDimensions(output); if(any(id.xy>=size)){{return;}} let src=vec2u(id.x,{}); let v={}; textureStore(output,vec2i(id.xy),{}); }}", if flip { "size.y-1u-id.y" } else { "id.y" }, if kind == 0 { "loadHdr(src)" } else { "textureLoad(input,vec2i(src),0)" }, convert)
}
