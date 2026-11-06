//! Host Metal device, texture and timeline imports. See `native/docs/metal.md`.
// Device import and event staging adapted from oidn-webgpu-native 0.2.0,
// src/gpu_capi/metal.rs, Copyright (c) 2024 pissang, MIT.
// Source: https://github.com/pissang/oidn-webgpu (native 0.2.0).
use super::{Backend, Engine, EngineOptions, OutputKind, PixelKind, Render, Result, Status, error};
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_metal::{
    MTLCommandQueue, MTLDevice, MTLEvent, MTLHazardTrackingMode, MTLPixelFormat, MTLResource,
    MTLSharedEvent, MTLStorageMode, MTLTexture, MTLTextureType, MTLTextureUsage,
};
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use wgpu::hal::api::Metal;
use wgpu::util::DeviceExt;

fn invalid(s: &str) -> super::Error {
    error(Status::InvalidArgument, s)
}
fn unavailable() -> super::Error {
    error(
        Status::Unavailable,
        "Requires an engine imported from Metal",
    )
}

pub(super) struct State {
    order: Retained<ProtocolObject<dyn MTLSharedEvent>>,
    sequence: u64,
    completed: u64,
    pending: Vec<Pending>,
    timers: Vec<(
        u64,
        crate::profiling::GpuTimer,
        std::sync::mpsc::Receiver<std::result::Result<(), wgpu::BufferAsyncError>>,
    )>,
    pipelines: HashMap<(wgpu::TextureFormat, u8, bool), wgpu::ComputePipeline>,
    // Canonicalize repeated imports so releasing/reimporting an event cannot
    // reset signal monotonicity. Kept until engine disposal.
    timelines: HashMap<usize, Arc<Event>>,
}
impl State {
    fn new(order: Retained<ProtocolObject<dyn MTLSharedEvent>>) -> Self {
        Self {
            order,
            sequence: 0,
            completed: 0,
            pending: vec![],
            timers: vec![],
            pipelines: HashMap::new(),
            timelines: HashMap::new(),
        }
    }
}
// Native done is authoritative: a completion callback can also follow a failed
// Metal command buffer without its external signals. Keep imports independently
// alive until BOTH completion conditions hold; a callback alone is not success.
struct Pending {
    sequence: u64,
    completed: Arc<AtomicBool>,
    done: Arc<Event>,
    value: u64,
    _textures: Vec<wgpu::Texture>,
    _sources: Vec<Source>,
    _ready: Option<Arc<Event>>,
}
struct Event {
    raw: Retained<ProtocolObject<dyn MTLSharedEvent>>,
    last_signal: Mutex<u64>,
}
/// Imported host texture. Drop releases its import; queued work retains the texture.
/// Do not alias it through another import or modify it until its done timeline arrives.
#[derive(Clone)]
pub struct MetalImage {
    engine: Engine,
    texture: wgpu::Texture,
    raw_id: usize,
}
/// Imported host timeline. Drop releases this import; the engine retains its event
/// and signal history until disposal. Only one producer may signal this timeline.
#[derive(Clone)]
pub struct MetalTimeline {
    engine: Engine,
    event: Arc<Event>,
}
/// GPU image to export. Depth requires the render's depth AOV to be enabled and ready.
#[derive(Clone, Copy, Debug)]
pub enum MetalOutput {
    /// Raw linear RGBA, matching `Render::read_pixels(PixelKind::Hdr)`.
    Hdr,
    /// Camera-forward distance; RGBA destinations also retain coverage.
    Depth,
    /// Composed RGBA8; call `Display::present` first.
    Display,
}
/// Output row order. Default top first matches `Render::read_pixels`.
#[derive(Clone, Copy, Debug, Default)]
pub enum MetalRowOrder {
    /// Row zero is the image top (default), matching engine readback.
    #[default]
    TopFirst,
    /// Row zero is the image bottom, for lower-left image coordinates.
    BottomFirst,
}
/// One image in an atomic export batch; no scaling. Default row order is top first.
pub struct MetalExportImage<'a> {
    /// Destination import, on the render's engine; no default.
    pub image: &'a MetalImage,
    /// HDR, enabled depth or composed display; no default.
    pub kind: MetalOutput,
    /// Top first by convention; set BottomFirst for GL-style consumers.
    pub rows: MetalRowOrder,
}

enum Source {
    Hdr([wgpu::Buffer; 3], [u32; 4]),
    Texture(wgpu::Texture),
}
impl Source {
    fn size(&self) -> wgpu::Extent3d {
        match self {
            Self::Hdr(_, p) => wgpu::Extent3d {
                width: p[0],
                height: p[1],
                depth_or_array_layers: 1,
            },
            Self::Texture(t) => t.size(),
        }
    }
}
fn shader(format: wgpu::TextureFormat, kind: u8, flip: bool) -> String {
    let output = match format {
        wgpu::TextureFormat::Rgba32Float => "rgba32float",
        wgpu::TextureFormat::Rgba16Float => "rgba16float",
        wgpu::TextureFormat::R32Float => "r32float",
        _ => "rgba8unorm",
    };
    let input = if kind == 0 {
        include_str!("metal-hdr-resolve.wgsl")
    } else {
        "@group(0) @binding(0) var input: texture_2d<f32>;"
    };
    format!(
        "{input}\n@group(0) @binding(4) var output: texture_storage_2d<{output},write>;\n@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {{ let size=textureDimensions(output); if(any(id.xy>=size)){{return;}} let src=vec2u(id.x,{}); let v={}; textureStore(output,vec2i(id.xy),{}); }}",
        if flip { "size.y-1u-id.y" } else { "id.y" },
        if kind == 0 {
            "loadHdr(src)"
        } else {
            "textureLoad(input,vec2i(src),0)"
        },
        if kind == 1 {
            "vec4f(v.x,0,0,v.y)"
        } else if format == wgpu::TextureFormat::Rgba16Float {
            "vec4f(unpack2x16float(pack2x16float(v.xy)),unpack2x16float(pack2x16float(v.zw)))"
        } else {
            "v"
        }
    )
}
impl Engine {
    /// Retains a host `id<MTLDevice>` and optional `id<MTLCommandQueue>` (NULL creates
    /// a library queue). Hardware requests ray queries when available, else Software.
    /// Calls on this engine are serialized as usual; if sharing a queue, serialize
    /// host submissions with library calls and do not use it during preparation.
    ///
    /// # Safety
    /// Pointers must be valid Objective-C objects on the same device. The host owns
    /// them; imports retain references. Keep native resources usable until all GPU
    /// work completes. Never destroy the underlying device while imports exist.
    pub unsafe fn on_metal(
        device: *mut c_void,
        queue: *mut c_void,
        options: EngineOptions,
    ) -> Result<Self> {
        let raw = unsafe { Retained::retain(device.cast::<ProtocolObject<dyn MTLDevice>>()) }
            .ok_or_else(|| invalid("Null Metal device"))?;
        let native_queue = if queue.is_null() {
            raw.newCommandQueueWithMaxCommandBufferCount(4096)
                .ok_or_else(unavailable)?
        } else {
            unsafe { Retained::retain(queue.cast::<ProtocolObject<dyn MTLCommandQueue>>()) }
                .ok_or_else(|| invalid("Null Metal queue"))?
        };
        if native_queue.device().registryID() != raw.registryID() {
            return Err(invalid("Metal queue belongs to another device"));
        }
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = wgpu::Backends::METAL;
        let instance = wgpu::Instance::new(desc);
        let adapter = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::METAL))
            .into_iter()
            .find(|a| unsafe {
                a.as_hal::<Metal>()
                    .is_some_and(|h| h.raw_device().registryID() == raw.registryID())
            })
            .ok_or_else(unavailable)?;
        let supported = adapter.features();
        let mut features = crate::oidn_webgpu::required_features()
            | crate::oidn_webgpu::recommended_features(&adapter)
            | (supported & wgpu::Features::TIMESTAMP_QUERY);
        if supported.contains(crate::INDEPENDENT_TEXTURE_FEATURES) {
            features |= crate::INDEPENDENT_TEXTURE_FEATURES;
        }
        if options.backend == Backend::Hardware {
            features |= supported & wgpu::Features::EXPERIMENTAL_RAY_QUERY;
        }
        if !supported.contains(features) {
            return Err(unavailable());
        }
        let mut limits = adapter.limits();
        limits.max_buffer_size = limits.max_buffer_size.min(u32::MAX as u64);
        let order = raw.newSharedEvent().ok_or_else(unavailable)?;
        let hal_device =
            unsafe { wgpu::hal::metal::Device::device_from_raw(raw, features, &limits) };
        let hal_queue = unsafe { wgpu::hal::metal::Queue::queue_from_raw(native_queue, 1.0) };
        hal_queue
            .enable_strict_event_sync()
            .map_err(|e| error(Status::Unavailable, e.to_string()))?;
        let (device, queue) = unsafe {
            adapter.create_device_from_hal::<Metal>(
                wgpu::hal::OpenDevice {
                    device: hal_device,
                    queue: hal_queue,
                },
                &wgpu::DeviceDescriptor {
                    label: Some("MuTracer imported Metal device"),
                    required_features: features,
                    required_limits: limits,
                    experimental_features: wgpu::ExperimentalFeatures::enabled(),
                    ..Default::default()
                },
            )
        }
        .map_err(|e| error(Status::Unavailable, e.to_string()))?;
        let engine = Engine::on_device(&adapter, &device, &queue, options, None);
        *engine.inner.metal.lock().unwrap() = Some(State::new(order));
        let loss = engine.device_loss_notifier();
        device.set_device_lost_callback(move |reason, message| {
            loss.notify(format!("{reason:?}: {message}"))
        });
        Ok(engine)
    }
    fn metal_registry(&self) -> Result<u64> {
        self.check_device()?;
        if self.inner.metal.lock().unwrap().is_none() {
            return Err(unavailable());
        }
        Ok(unsafe { self.inner.gpu.device.as_hal::<Metal>() }
            .ok_or_else(unavailable)?
            .raw_device()
            .registryID())
    }
    /// Retains a host 2D texture, without copying pixels. Supports RGBA32F, RGBA16F,
    /// R32F and RGBA8Unorm; requires shader-write usage, one mip/layer/sample and
    /// tracked private/shared storage. Dimensions must match each exported source.
    ///
    /// # Safety
    /// `texture` must be a valid `id<MTLTexture>` on this engine's native device.
    /// Synchronize all external reads/writes with export's ready/done timeline;
    /// do not purge/reallocate its backing storage while an import or work exists.
    pub unsafe fn import_metal_image(&self, texture: *mut c_void) -> Result<MetalImage> {
        let registry = self.metal_registry()?;
        let raw = unsafe { Retained::retain(texture.cast::<ProtocolObject<dyn MTLTexture>>()) }
            .ok_or_else(|| invalid("Null Metal texture"))?;
        if raw.device().registryID() != registry
            || raw.textureType() != MTLTextureType::Type2D
            || raw.sampleCount() != 1
            || raw.mipmapLevelCount() != 1
            || raw.arrayLength() != 1
            || !raw.usage().contains(MTLTextureUsage::ShaderWrite)
            || ![MTLStorageMode::Private, MTLStorageMode::Shared].contains(&raw.storageMode())
            || raw.hazardTrackingMode() == MTLHazardTrackingMode::Untracked
        {
            return Err(invalid(
                "Metal texture device, type, usage, storage or hazard tracking is incompatible",
            ));
        }
        let format = match raw.pixelFormat() {
            MTLPixelFormat::RGBA32Float => wgpu::TextureFormat::Rgba32Float,
            MTLPixelFormat::RGBA16Float => wgpu::TextureFormat::Rgba16Float,
            MTLPixelFormat::R32Float => wgpu::TextureFormat::R32Float,
            MTLPixelFormat::RGBA8Unorm => wgpu::TextureFormat::Rgba8Unorm,
            _ => return Err(invalid("Unsupported Metal texture format")),
        };
        let size = wgpu::Extent3d {
            width: raw.width() as u32,
            height: raw.height() as u32,
            depth_or_array_layers: 1,
        };
        if size.width == 0
            || size.height == 0
            || size.width > self.inner.gpu.device.limits().max_texture_dimension_2d
            || size.height > self.inner.gpu.device.limits().max_texture_dimension_2d
        {
            return Err(invalid("Invalid texture dimensions"));
        }
        let texture_id = Retained::as_ptr(&raw) as usize;
        let texture = unsafe {
            self.inner.gpu.device.create_texture_from_hal::<Metal>(
                wgpu::hal::metal::Device::texture_from_raw(
                    raw,
                    format,
                    MTLTextureType::Type2D,
                    1,
                    1,
                    wgpu::hal::CopyExtent {
                        width: size.width,
                        height: size.height,
                        depth: 1,
                    },
                    None,
                ),
                &wgpu::TextureDescriptor {
                    label: Some("MuTracer host image"),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::STORAGE_BINDING,
                    view_formats: &[],
                },
                wgpu::TextureUses::UNINITIALIZED,
            )
        };
        Ok(MetalImage {
            engine: self.clone(),
            texture,
            raw_id: texture_id,
        })
    }
    /// Retains an MTLSharedEvent and canonicalizes its increasing signal history.
    /// A separate timeline is recommended for each producer. UINT64_MAX is reserved.
    ///
    /// # Safety
    /// `event` must be a valid `id<MTLSharedEvent>` compatible with this device.
    pub unsafe fn import_metal_timeline(&self, event: *mut c_void) -> Result<MetalTimeline> {
        let registry = self.metal_registry()?;
        let raw = unsafe { Retained::retain(event.cast::<ProtocolObject<dyn MTLSharedEvent>>()) }
            .ok_or_else(|| invalid("Null Metal timeline"))?;
        if raw.device().is_some_and(|d| d.registryID() != registry) {
            return Err(invalid("Metal event belongs to another device"));
        }
        let mut state = self.inner.metal.lock().unwrap();
        let event = state
            .as_mut()
            .unwrap()
            .timelines
            .entry(event as usize)
            .or_insert_with(|| {
                Arc::new(Event {
                    raw,
                    last_signal: Mutex::new(0),
                })
            })
            .clone();
        Ok(MetalTimeline {
            engine: self.clone(),
            event,
        })
    }
    /// Polls without waiting; sequence 0 means all accepted exports. Unknown future
    /// sequences are InvalidArgument. A lost device is Unavailable, never completion.
    /// Call regularly to retire resources. At most 32 batches may be in flight.
    pub fn poll_metal_exports(&self, sequence: u64) -> Result<bool> {
        self.metal_registry()?;
        self.poll_device();
        self.check_device()?;
        let mut state = self.inner.metal.lock().unwrap();
        let state = state.as_mut().unwrap();
        if let Err(e) = state.collect() {
            self.inner.gpu.loss.notify(e.message.clone());
            return Err(e);
        }
        state
            .timers
            .retain(|(sequence, timer, receiver)| match receiver.try_recv() {
                Ok(Ok(())) => {
                    let ms = timer.mapped_milliseconds(&self.inner.gpu.queue);
                    native_log!(
                        "{}",
                        serde_json::json!({"metalExportSequence": sequence, "metalExportGpuMs": ms})
                    );
                    false
                }
                Ok(Err(_)) | Err(std::sync::mpsc::TryRecvError::Disconnected) => false,
                Err(std::sync::mpsc::TryRecvError::Empty) => true,
            });
        if sequence > state.sequence {
            return Err(invalid("Unknown GPU export sequence"));
        }
        Ok(state.completed
            >= if sequence == 0 {
                state.sequence
            } else {
                sequence
            })
    }
}
impl State {
    fn collect(&mut self) -> Result<()> {
        if self.pending.iter().any(|work| {
            work.completed.load(Ordering::Acquire)
                && (self.order.signaledValue() < work.sequence
                    || work.done.raw.signaledValue() < work.value)
        }) {
            return Err(error(
                Status::Unavailable,
                "Metal export completed without its timeline signals; GPU submission failed, rebuild the device",
            ));
        }
        while self.pending.first().is_some_and(|work| {
            work.completed.load(Ordering::Acquire)
                && self.order.signaledValue() >= work.sequence
                && work.done.raw.signaledValue() >= work.value
        }) {
            self.completed = self.pending.remove(0).sequence;
        }
        Ok(())
    }
}
impl Render {
    /// Exports 1..=8 images on the GPU without waiting for another sample. Uses the
    /// latest published HDR/display and ready depth AOV; does not change refinement.
    /// Exact source size is required. HDR: RGBA32F/16F; depth: R32F or RGBA32F
    /// (distance,0,0,coverage); display: RGBA8Unorm after composition.
    ///
    /// Optional ready and required done are GPU waits/signals. Done must increase
    /// beyond the event's observed and previously accepted value (not UINT64_MAX).
    /// Encoding precedes acceptance: errors touch no external sync. After acceptance,
    /// cancellation cannot revoke done. Device loss or a submit failure has unknown
    /// outcome and may never signal. Do not wait forever after device failure.
    /// Imports may be dropped after return; queued work retains their native objects.
    /// Drain exports before engine disposal; C destruction returns Busy until drained.
    /// Host ready signals must be submitted independently to avoid cyclic waits.
    pub fn export_metal(
        &self,
        images: &[MetalExportImage<'_>],
        ready: Option<(&MetalTimeline, u64)>,
        done: (&MetalTimeline, u64),
    ) -> Result<u64> {
        let engine = self.engine();
        engine.metal_registry()?;
        if images.is_empty() || images.len() > 8 {
            return Err(invalid("Export needs 1..=8 images"));
        }
        let same = |other: &Engine| Arc::ptr_eq(&engine.inner, &other.inner);
        if !same(&done.0.engine) || done.1 == 0 || done.1 == u64::MAX {
            return Err(invalid("Invalid done timeline or value"));
        }
        if let Some((ready, value)) = ready {
            if !same(&ready.engine)
                || value == u64::MAX
                || (Arc::ptr_eq(&ready.event, &done.0.event) && value >= done.1)
            {
                return Err(invalid("Invalid ready timeline or cyclic value"));
            }
        }
        // Resolve sources before taking the Metal state/submit lock: resolving may
        // itself submit. The ordinary one-thread-at-a-time engine rule applies.
        let mut sources = Vec::new();
        for (i, item) in images.iter().enumerate() {
            if !same(&item.image.engine) {
                return Err(invalid("Image belongs to another engine"));
            }
            if images[..i]
                .iter()
                .any(|other| other.image.raw_id == item.image.raw_id)
            {
                return Err(invalid("Duplicate destination image"));
            }
            let source = match item.kind {
                MetalOutput::Hdr => {
                    let (buffers, p) = self.metal_hdr_inputs()?;
                    Source::Hdr(buffers, p)
                }
                MetalOutput::Depth => Source::Texture(
                    self.get_aov_texture(PixelKind::Depth)?
                        .ok_or_else(|| error(Status::InvalidState, "No completed depth image"))?,
                ),
                MetalOutput::Display => Source::Texture(
                    self.get_output_texture(OutputKind::Display)?
                        .ok_or_else(|| error(Status::InvalidState, "No composed display image"))?,
                ),
            };
            let format = item.image.texture.format();
            let valid = match item.kind {
                MetalOutput::Hdr => matches!(
                    format,
                    wgpu::TextureFormat::Rgba32Float | wgpu::TextureFormat::Rgba16Float
                ),
                MetalOutput::Depth => matches!(
                    format,
                    wgpu::TextureFormat::R32Float | wgpu::TextureFormat::Rgba32Float
                ),
                MetalOutput::Display => format == wgpu::TextureFormat::Rgba8Unorm,
            };
            if !valid || source.size() != item.image.texture.size() {
                return Err(invalid("Export format or dimensions do not match source"));
            }
            sources.push(source);
        }
        engine.poll_device();
        engine.check_device()?;
        let mut guard = engine.inner.metal.lock().unwrap();
        let state = guard.as_mut().unwrap();
        if let Err(e) = state.collect() {
            engine.inner.gpu.loss.notify(e.message.clone());
            return Err(e);
        }
        if state.pending.len() >= 32 {
            return Err(error(
                Status::Busy,
                "32 GPU exports are pending; poll before retrying",
            ));
        }
        let mut last = done.0.event.last_signal.lock().unwrap();
        if done.1 <= (*last).max(done.0.event.raw.signaledValue()) {
            return Err(invalid("Done signal values must strictly increase"));
        }
        let gpu = &engine.inner.gpu;
        // Strict Metal waits attach a relay value when encoding begins, not when
        // submit runs. No background submit may advance that relay between them.
        gpu.queue.exclusive_submit(|queue| -> Result<u64> {
            let timer = crate::profiling::GpuTimer::new(&gpu.device, 1, false);
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            for (pair, (item, source)) in images.iter().zip(&sources).enumerate() {
                let kind = match item.kind {
                    MetalOutput::Hdr => 0,
                    MetalOutput::Depth => 1,
                    MetalOutput::Display => 2,
                };
                let flip = matches!(item.rows, MetalRowOrder::BottomFirst);
                let format = item.image.texture.format();
                let pipeline = state
                    .pipelines
                    .entry((format, kind, flip))
                    .or_insert_with(|| {
                        let module =
                            gpu.device
                                .create_shader_module(wgpu::ShaderModuleDescriptor {
                                    label: Some("Metal output conversion"),
                                    source: wgpu::ShaderSource::Wgsl(
                                        shader(format, kind, flip).into(),
                                    ),
                                });
                        let mut entries = Vec::new();
                        if kind == 0 {
                            for binding in 0..3 {
                                entries.push(wgpu::BindGroupLayoutEntry {
                                    binding,
                                    visibility: wgpu::ShaderStages::COMPUTE,
                                    ty: wgpu::BindingType::Buffer {
                                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                                        has_dynamic_offset: false,
                                        min_binding_size: None,
                                    },
                                    count: None,
                                });
                            }
                            entries.push(wgpu::BindGroupLayoutEntry {
                                binding: 3,
                                visibility: wgpu::ShaderStages::COMPUTE,
                                ty: wgpu::BindingType::Buffer {
                                    ty: wgpu::BufferBindingType::Uniform,
                                    has_dynamic_offset: false,
                                    min_binding_size: None,
                                },
                                count: None,
                            });
                        } else {
                            entries.push(wgpu::BindGroupLayoutEntry {
                                binding: 0,
                                visibility: wgpu::ShaderStages::COMPUTE,
                                ty: wgpu::BindingType::Texture {
                                    sample_type: wgpu::TextureSampleType::Float {
                                        filterable: false,
                                    },
                                    view_dimension: wgpu::TextureViewDimension::D2,
                                    multisampled: false,
                                },
                                count: None,
                            });
                        }
                        entries.push(wgpu::BindGroupLayoutEntry {
                            binding: 4,
                            visibility: wgpu::ShaderStages::COMPUTE,
                            ty: wgpu::BindingType::StorageTexture {
                                access: wgpu::StorageTextureAccess::WriteOnly,
                                format,
                                view_dimension: wgpu::TextureViewDimension::D2,
                            },
                            count: None,
                        });
                        let layout =
                            gpu.device
                                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                                    label: None,
                                    entries: &entries,
                                });
                        let layout =
                            gpu.device
                                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                                    label: None,
                                    bind_group_layouts: &[Some(&layout)],
                                    immediate_size: 0,
                                });
                        gpu.device
                            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                                label: Some("Export host Metal image"),
                                layout: Some(&layout),
                                module: &module,
                                entry_point: Some("main"),
                                compilation_options: Default::default(),
                                cache: None,
                            })
                    });
                let input = match source {
                    Source::Texture(t) => Some(t.create_view(&Default::default())),
                    _ => None,
                };
                let parameters = match source {
                    Source::Hdr(_, p) => Some(gpu.device.create_buffer_init(
                        &wgpu::util::BufferInitDescriptor {
                            label: None,
                            contents: bytemuck::cast_slice(p),
                            usage: wgpu::BufferUsages::UNIFORM,
                        },
                    )),
                    _ => None,
                };
                let output = item.image.texture.create_view(&Default::default());
                let mut entries = Vec::new();
                match source {
                    Source::Hdr(buffers, _) => {
                        for (binding, buffer) in buffers.iter().enumerate() {
                            entries.push(wgpu::BindGroupEntry {
                                binding: binding as u32,
                                resource: buffer.as_entire_binding(),
                            });
                        }
                        entries.push(wgpu::BindGroupEntry {
                            binding: 3,
                            resource: parameters.as_ref().unwrap().as_entire_binding(),
                        });
                    }
                    Source::Texture(_) => entries.push(wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(input.as_ref().unwrap()),
                    }),
                }
                entries.push(wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&output),
                });
                let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &pipeline.get_bind_group_layout(0),
                    entries: &entries,
                });
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    timestamp_writes: timer.as_ref().and_then(|t| {
                        // Span the batch: a tiny depth pass can quantize to zero
                        // duration when timed separately on Metal.
                        if pair != 0 && pair + 1 != images.len() {
                            return None;
                        }
                        let mut writes = t.pass(0);
                        if pair != 0 {
                            writes.beginning_of_pass_write_index = None;
                        }
                        if pair + 1 != images.len() {
                            writes.end_of_pass_write_index = None;
                        }
                        Some(writes)
                    }),
                    ..Default::default()
                });
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(
                    source.size().width.div_ceil(8),
                    source.size().height.div_ceil(8),
                    1,
                );
            }
            if let Some(timer) = &timer {
                timer.resolve(&mut encoder);
            }
            let commands = encoder.finish(); // No encoding remains after acceptance.
            let sequence = state
                .sequence
                .checked_add(1)
                .ok_or_else(|| error(Status::Error, "GPU sequence exhausted"))?;
            let completed = Arc::new(AtomicBool::new(false));
            let flag = completed.clone();
            let textures: Vec<_> = images.iter().map(|i| i.image.texture.clone()).collect();
            let hal = unsafe { queue.as_hal::<Metal>() }.ok_or_else(unavailable)?;
            // Serialize exports even when consecutive batches have disjoint images.
            // Metal may overlap command buffers; a later done must not overtake.
            if sequence > 1 {
                hal.add_wait_event(state.order.clone(), sequence - 1);
            }
            if let Some((ready, value)) = ready {
                hal.add_wait_event(ready.event.raw.clone(), value);
            }
            hal.add_signal_event(done.0.event.raw.clone(), done.1);
            // Publish the library dependency last: its value certifies that the
            // external done is already signalled, including across later submits.
            hal.add_signal_event(state.order.clone(), sequence);
            *last = done.1;
            state.sequence = sequence;
            gpu.queue.set_metal_barrier(state.order.clone(), sequence);
            state.pending.push(Pending {
                sequence,
                completed,
                done: done.0.event.clone(),
                value: done.1,
                _textures: textures,
                _sources: sources,
                _ready: ready.map(|r| r.0.event.clone()),
            });
            // A panic here has unknown submission outcome; quarantine the engine.
            let submit =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| queue.submit([commands])));
            queue.on_submitted_work_done(move || {
                flag.store(true, Ordering::Release);
            });
            if submit.is_err() {
                hal.remove_signal_event(&done.0.event.raw);
                if let Some((ready, _)) = ready {
                    hal.remove_wait_event(&ready.event.raw);
                }
                gpu.loss.notify("Metal export submission outcome unknown");
                return Err(error(
                    Status::Unavailable,
                    "Metal export submission outcome unknown; signals may not arrive",
                ));
            }
            if let Some(timer) = timer {
                let receiver = timer.map();
                state.timers.push((sequence, timer, receiver));
            }
            Ok(sequence)
        })
    }
}

#[cfg(test)]
#[path = "metal_tests.rs"]
mod tests;
