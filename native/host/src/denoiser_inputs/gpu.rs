use super::*;
use crate::{GpuDevice, Result};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
/// Separate one-sample guide textures, top row first. Use the validity texture
/// before consuming surface data; missing guides return None.
pub enum Guide {
    /// Linear HDR radiance, alpha 1, before display exposure.
    NoisyColor,
    /// Oriented world shading normal xyz and perceptual specular roughness w.
    /// Supported clearcoat weights the base and coat roughness by their reflectance.
    NormalRoughness,
    /// Directional diffuse reflectance RGB; validity is in the validity texture.
    DiffuseAlbedo,
    /// Directional specular reflectance RGB; validity is in the validity texture.
    SpecularAlbedo,
    /// Camera-forward distance in scene units, zero on miss.
    LinearDepth,
    /// Previous-current unjittered input pixels, x right and y down.
    Motion,
    /// Not currently produced; consult capabilities before requesting it.
    SpecularHitDistance,
    /// Virtual-image motion xy in input pixels, validity z and first reflected
    /// segment length w. Consult the per-pixel validity flags.
    SpecularReflection,
    /// `temporal_validity` bit flags, not an SDK-specific validity encoding.
    Validity,
}
impl Guide {
    pub fn format(self) -> wgpu::TextureFormat {
        use wgpu::TextureFormat::*;
        match self {
            Self::NoisyColor
            | Self::NormalRoughness
            | Self::DiffuseAlbedo
            | Self::SpecularAlbedo
            | Self::SpecularReflection => Rgba32Float,
            Self::LinearDepth | Self::SpecularHitDistance => R32Float,
            Self::Motion => Rg32Float,
            Self::Validity => R32Uint,
        }
    }
}
pub(crate) struct GuideTexture {
    pub kind: Guide,
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
}
pub(crate) struct GpuFrameResources {
    device: DeviceKey,
    pub extent: [u32; 2],
    pub stable_ids: Option<wgpu::Buffer>,
    pub guides: Vec<GuideTexture>,
    /// Only allocated for explicitly requested optical records.
    pub glass: Option<wgpu::Buffer>,
    pub optical_events: Option<wgpu::Buffer>,
    pub gpu_bytes: u64,
    /// Immutable producer resources; never aliases the progressive outputs.
    pub producer_buffers: Vec<wgpu::Buffer>,
}
impl GpuFrameResources {
    pub fn allocate(
        gpu: &GpuDevice,
        extent: [u32; 2],
        guides: &[Guide],
        glass_records: u32,
        event_capacity: u32,
    ) -> Result<Self> {
        gpu.loss.check()?;
        let limits = gpu.device.limits();
        if extent.contains(&0) || extent.iter().any(|n| *n > limits.max_texture_dimension_2d) {
            return Err("Unsupported frame input extent".into());
        }
        if guides
            .iter()
            .enumerate()
            .any(|(i, g)| guides[..i].contains(g))
        {
            return Err("Duplicate frame guide".into());
        }
        if glass_records as u64 > extent[0] as u64 * extent[1] as u64
            || (event_capacity != 0 && glass_records == 0)
        {
            return Err("Invalid optical record capacity".into());
        }
        let glass_bytes = glass_records as u64 * size_of::<GlassPixelRecord>() as u64;
        let event_bytes = event_capacity as u64 * size_of::<OpticalEventRecord>() as u64;
        for bytes in [glass_bytes, event_bytes] {
            if bytes > limits.max_storage_buffer_binding_size as u64
                || bytes > limits.max_buffer_size
            {
                return Err("Optical records exceed device storage limits".into());
            }
        }
        let usage = wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST;
        let mut gpu_bytes = glass_bytes + event_bytes;
        let guides = guides
            .iter()
            .map(|kind| {
                let format = kind.format();
                gpu_bytes += extent[0] as u64
                    * extent[1] as u64
                    * format.block_copy_size(None).unwrap() as u64;
                let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("MuTracer frame guide"),
                    size: wgpu::Extent3d {
                        width: extent[0],
                        height: extent[1],
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage,
                    view_formats: &[],
                });
                let view = texture.create_view(&Default::default());
                GuideTexture {
                    kind: *kind,
                    texture,
                    view,
                }
            })
            .collect();
        let buffer = |size| {
            (size != 0).then(|| {
                gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("MuTracer frame optical records"),
                    size,
                    usage: wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::COPY_SRC
                        | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
        };
        Ok(Self {
            device: gpu.frame_device,
            stable_ids: None,
            extent,
            guides,
            glass: buffer(glass_bytes),
            optical_events: buffer(event_bytes),
            gpu_bytes,
            producer_buffers: Vec::new(),
        })
    }
    pub fn guide(&self, kind: Guide) -> Option<&GuideTexture> {
        self.guides.iter().find(|g| g.kind == kind)
    }
}

pub(crate) type GpuFrame = InputFrame<GpuFrameResources>;
pub(crate) type GpuFrameHistory = FrameHistory<GpuFrameResources>;

/// A submitted producer ticket owns its exact frame and queue dependency.
/// A bare SubmissionIndex from an arbitrary queue is deliberately insufficient.
pub(crate) struct ProducerTicket {
    frame: Arc<GpuFrame>,
    pub index: wgpu::SubmissionIndex,
}
pub(crate) enum ProducerDependency {
    Commands {
        frame: Arc<GpuFrame>,
        commands: Vec<wgpu::CommandBuffer>,
    },
    Submitted(ProducerTicket),
}
impl ProducerDependency {
    fn frame(&self) -> &Arc<GpuFrame> {
        match self {
            Self::Commands { frame, .. } => frame,
            Self::Submitted(ticket) => &ticket.frame,
        }
    }
    pub fn submit_producer(self, gpu: &GpuDevice) -> Result<Self> {
        check_device(gpu, self.frame())?;
        match self {
            Self::Commands { frame, commands } => {
                let index = gpu.queue.submit(commands);
                let keep_alive = frame.clone();
                gpu.queue.on_submitted_work_done(move || drop(keep_alive));
                Ok(Self::Submitted(ProducerTicket { frame, index }))
            }
            submitted => Ok(submitted),
        }
    }
}

/// All commands here must be encoded separately from the producer. An SDK bridge
/// puts raw Vulkan work in its own encoder, never in a wgpu compute encoder.
pub(crate) struct EvaluatedCommands {
    pub native: Vec<wgpu::CommandBuffer>,
    pub consumer: Vec<wgpu::CommandBuffer>,
}
pub(crate) struct FrameSubmission<R> {
    frame: Arc<InputFrame<R>>,
    complete: Arc<AtomicBool>,
}
impl<R> FrameSubmission<R> {
    pub fn key(&self) -> FrameKey {
        self.frame.key()
    }
    pub fn retired(&self) -> bool {
        self.complete.load(Ordering::Acquire)
    }
    #[cfg(test)]
    pub(super) fn test_submission(frame: Arc<InputFrame<R>>) -> Self {
        Self {
            frame,
            complete: Default::default(),
        }
    }
}
fn check_device(gpu: &GpuDevice, frame: &GpuFrame) -> Result<()> {
    gpu.loss.check()?;
    if frame.key().device != gpu.frame_device || frame.current.resources.device != gpu.frame_device
    {
        return Err("Frame producer belongs to another device generation".into());
    }
    if frame.current.metadata.input_extent != frame.current.resources.extent {
        return Err("Frame resource extent does not match metadata".into());
    }
    Ok(())
}

impl GpuFrameHistory {
    /// Evaluate/encode errors reject the pending frame and invalidate backend
    /// history. A previously submitted producer retains its lease until done.
    pub fn evaluate_and_submit(
        &mut self,
        gpu: &GpuDevice,
        producer: ProducerDependency,
        evaluate: impl FnOnce(&GpuFrame) -> Result<EvaluatedCommands>,
    ) -> Result<FrameSubmission<GpuFrameResources>> {
        self.submit_with_acceptance(gpu, producer, evaluate, true)
    }
    pub fn submit_pending(
        &mut self,
        gpu: &GpuDevice,
        producer: ProducerDependency,
        evaluate: impl FnOnce(&GpuFrame) -> Result<EvaluatedCommands>,
    ) -> Result<FrameSubmission<GpuFrameResources>> {
        self.submit_with_acceptance(gpu, producer, evaluate, false)
    }
    fn submit_with_acceptance(
        &mut self,
        gpu: &GpuDevice,
        producer: ProducerDependency,
        evaluate: impl FnOnce(&GpuFrame) -> Result<EvaluatedCommands>,
        accept: bool,
    ) -> Result<FrameSubmission<GpuFrameResources>> {
        let frame = producer.frame().clone();
        let key = frame.key();
        self.pending(key)?;
        let result = (|| {
            check_device(gpu, &frame)?;
            let evaluated = evaluate(&frame)?;
            gpu.loss.check()?;
            let producer_commands = match producer {
                ProducerDependency::Commands { commands, .. } => commands,
                ProducerDependency::Submitted(_) => Vec::new(),
            };
            // Same queue orders a separately submitted producer too. No CPU wait,
            // per-frame readback, or mixed wgpu/HAL encoder is required.
            gpu.queue.submit(
                producer_commands
                    .into_iter()
                    .chain(evaluated.native)
                    .chain(evaluated.consumer),
            );
            let complete = Arc::new(AtomicBool::new(false));
            let signal = complete.clone();
            let keep_alive = frame.clone();
            gpu.queue.on_submitted_work_done(move || {
                drop(keep_alive);
                signal.store(true, Ordering::Release);
            });
            Ok(FrameSubmission { frame, complete })
        })();
        match result {
            Ok(receipt) => {
                if let Err(error) = gpu.loss.check() {
                    self.device_lost();
                    return Err(error);
                }
                if accept {
                    self.accept(&receipt)?;
                }
                Ok(receipt)
            }
            Err(error) => {
                self.reject(key)?;
                if gpu.loss.reason().is_some() {
                    self.device_lost();
                }
                Err(error)
            }
        }
    }
}
