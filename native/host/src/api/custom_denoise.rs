use super::CancelToken;

/// One requested AOV in CPU memory, bottom row first. IDs use `id_data`.
pub struct DenoiseAov {
    pub kind: super::PixelKind,
    pub data: Vec<f32>,
    pub id_data: Option<Vec<u32>>,
}
/// Normalized GPU AOV, bottom row first; ID uses RGBA32UI, other kinds RGBA32F.
#[derive(Clone)]
pub struct GpuAov {
    pub kind: super::PixelKind,
    pub buffer: wgpu::Buffer,
}
/// Custom-filter inputs. Cpu mode supplies owned linear RGBA32F images, bottom
/// row first: raw per-sample averaged color/background and coverage alpha, with
/// existing L0 guides. GPU modes supply `resident` and empty arrays.
pub struct DenoiseInput {
    /// Requested AOV images in Cpu mode; empty in ResidentGpu mode.
    pub aovs: Vec<DenoiseAov>,
    /// Normalized AOV buffers when Cpu mode requests `gpu_inputs`; otherwise empty.
    pub aov_buffers: Vec<GpuAov>,
    /// Width and height in pixels.
    pub size: [u32; 2],
    /// RGBA color, `width * height * 4` floats.
    pub color: Vec<f32>,
    /// Normal guide, same layout.
    pub normal: Vec<f32>,
    /// Albedo guide, same layout.
    pub albedo: Vec<f32>,
    /// Opt-in copies on the rendering device, STORAGE | COPY_SRC buffers.
    pub buffers: Option<DenoiseBuffers>,
    /// Cloned rendering device for optional GPU filtering. Cpu mode reads back
    /// on the worker; opt-in buffers upload there. Never destroy the device.
    pub device: wgpu::Device,
    /// Queue access for GPU filtering on `device`.
    pub gpu: DenoiseGpu,
    /// Present only for ResidentGpu mode. CPU arrays are empty and `buffers` is
    /// None in that mode; the owned snapshot is in this object's buffers.
    pub resident: Option<super::GpuDenoiseInput>,
}
/// Owned copies with the same layout as CPU inputs. Do not destroy these buffers
/// while submitted work still uses them; submit through DenoiseGpu.
pub struct DenoiseBuffers {
    pub color: wgpu::Buffer,
    pub normal: wgpu::Buffer,
    pub albedo: wgpu::Buffer,
}
/// Submission access coordinated with window reconfiguration.
pub struct DenoiseGpu(
    pub(crate) crate::GpuQueue,
    pub(super) Option<std::sync::Arc<super::custom_gpu_submission::SubmissionLease>>,
);
impl DenoiseGpu {
    pub(super) fn duplicate(&self) -> Self {
        Self(self.0.clone(), self.1.clone())
    }
    /// Submits command buffers on the rendering queue, coordinated with window
    /// reconfiguration.
    pub fn submit(
        &self,
        commands: impl IntoIterator<Item = wgpu::CommandBuffer>,
    ) -> wgpu::SubmissionIndex {
        let _retirement = self.1.as_ref().map(|lease| lease.begin(&self.0));
        self.0.submit(commands)
    }
    /// Queues a buffer write on the rendering queue.
    pub fn write_buffer(&self, buffer: &wgpu::Buffer, offset: u64, data: &[u8]) {
        self.0.write_buffer(buffer, offset, data);
    }
}
/// Filtered image returned by [`CustomDenoiser::denoise`].
pub enum DenoiseOutput {
    /// Exactly width*height*4 finite values, same orientation and alpha semantics.
    Cpu(Vec<f32>),
    /// Same layout in a COPY_SRC buffer on the input device, at offset zero.
    /// Submit all writes before returning; ownership transfers to the worker.
    Gpu(wgpu::Buffer),
    /// GPU-resident result sealed to this invocation. No scheduling readback or
    /// CPU upload; construct with GpuDenoiseInput::submit.
    Resident(super::GpuDenoiseOutput),
}
/// User filter invoked on detached library threads. Calls may overlap after
/// cancellation/replacement. Keep all referenced resources owned by this object.
/// Cancellation is cooperative: API cancellation/destruction never joins a
/// callback, and cancelled results are discarded. A stuck callback keeps its
/// inputs and Arc alive; hosts must stop it before unloading callback code.
pub trait CustomDenoiser: Send + Sync + 'static {
    /// Required AOV bit mask, as in RenderSettings::aovs. Default 0.
    fn aovs(&self) -> u32 {
        0
    }

    /// Default Cpu. ResidentGpu supplies accumulation averages; TemporalGpu also
    /// supplies an independently sampled frame through `GpuDenoiseInput::temporal`.
    /// Called during registration, outside the engine lock; re-register to change mode.
    fn input_mode(&self) -> super::DenoiseInputMode {
        super::DenoiseInputMode::Cpu
    }
    /// Samples in each independent TemporalGpu frame. Default 1. Pinhole
    /// cameras can also use 2 or 4, sharing one jitter and first-sample guides.
    /// Called during registration outside the engine lock, only in TemporalGpu mode.
    fn temporal_sample_count(&self) -> u32 {
        1
    }
    /// Linear output scale for a resident temporal result. Default 1. Scale 2
    /// doubles both axes while keeping trace and raw exports at the input size.
    /// When the doubled capture exceeds device limits, the output scale is 1.
    /// Called during registration outside the engine lock, only in TemporalGpu.
    fn temporal_output_scale(&self) -> u32 {
        1
    }
    /// Request the diagnostic thin-pane and parallel-slab correspondence
    /// buffer. Default false. Applies only to pinhole perspective TemporalGpu.
    fn temporal_transmission_motion(&self) -> bool {
        false
    }
    /// Selects the material guide model for independently sampled opaque
    /// surfaces. Default Physical. Unsupported first hits keep physical guides.
    /// Unsupported continuations keep the first-hit guides.
    /// Called during registration outside the engine lock, only in TemporalGpu.
    fn temporal_guide_model(&self) -> super::TemporalGuideModel {
        super::TemporalGuideModel::Physical
    }
    /// Default false. True additionally uploads CPU inputs as GPU storage buffers
    /// on the worker. This is a readback+upload path, with extra memory/copy cost.
    /// Applies only to Cpu mode; ResidentGpu already supplies GPU snapshots.
    fn gpu_inputs(&self) -> bool {
        false
    }
    /// Filters on a library thread. Resident temporal results use the declared
    /// output size; other modes use the input size. Poll `cancel` to stop early; results of
    /// cancelled calls are discarded.
    fn denoise(
        &self,
        input: DenoiseInput,
        cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String>;
}

pub(super) fn validate(pixels: Vec<f32>, size: [u32; 2]) -> std::result::Result<Vec<f32>, String> {
    if pixels.len() != size[0] as usize * size[1] as usize * 4
        || pixels.iter().any(|v| !v.is_finite())
    {
        return Err("Custom denoiser must return finite RGBA pixels of the input size".into());
    }
    Ok(pixels)
}

// User Drop/release code is as unbounded as the filter call itself. Retire its
// final API-owned reference off-thread too, including failed registration.
#[derive(Default)]
pub(super) struct Filter(pub Option<std::sync::Arc<dyn CustomDenoiser>>);
impl Drop for Filter {
    fn drop(&mut self) {
        if let Some(filter) = self.0.take() {
            std::thread::spawn(move || drop(filter));
        }
    }
}
