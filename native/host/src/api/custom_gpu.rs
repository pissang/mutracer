//! Same-device custom filtering without a CPU image in the scheduling path.
use super::{CancelToken, CustomDenoiser, DenoiseBuffers, DenoiseGpu};
use crate::{GpuDevice, Result};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU8, Ordering},
};

/// Inputs requested by a custom filter. Default [`Self::Cpu`] retains the
/// existing CPU callback and optional upload behavior.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DenoiseInputMode {
    #[default]
    Cpu,
    /// GPU averages of the completed accumulation and its OIDN normal/albedo
    /// guides, bottom row first. These are not 1-spp temporal/RR guides.
    ResidentGpu,
    /// Separate 1-spp guides and frame records in `GpuDenoiseInput::temporal`.
    /// Requires a pinhole camera. Output is the input size by default.
    TemporalGpu,
}

/// Identity of an immutable custom-filter snapshot. Each invocation is unique,
/// including invocations on the same accumulation after filter replacement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DenoiseFrameId {
    /// Process-unique library device context. Separate Engine::on_device wrappers
    /// may have distinct contexts on the same caller-owned native device.
    pub device: u64,
    /// Stable library render-target identity.
    pub target: u64,
    /// Changes when the target publishes new camera/size/settings resources.
    pub generation: u64,
    /// Process-unique invocation identity.
    pub frame: u64,
}
/// CPU publication decision; independent of GPU completion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenoiseAcceptance {
    Pending,
    Accepted,
    Rejected,
}

/// Owned status handle. Cancellation/replacement can reject a result while its
/// submitted GPU work is still running. Polling never waits for the device.
#[derive(Clone)]
pub struct DenoiseFrameStatus {
    accepted: Arc<AtomicU8>,
    retired: Arc<AtomicBool>,
    work: Arc<Mutex<RetirementWork>>,
}
#[derive(Default)]
struct RetirementWork {
    pending: usize,
    closed: bool,
}
impl DenoiseFrameStatus {
    fn new() -> Self {
        Self {
            accepted: Default::default(),
            retired: Default::default(),
            work: Default::default(),
        }
    }
    pub(super) fn begin(&self) -> bool {
        let mut work = self.work.lock().unwrap();
        if work.closed {
            return false;
        }
        work.pending += 1;
        true
    }
    pub(super) fn close(&self) {
        let mut work = self.work.lock().unwrap();
        work.closed = true;
        if work.pending == 0 {
            self.retired.store(true, Ordering::Release);
        }
    }
    pub(super) fn complete(&self) {
        let mut work = self.work.lock().unwrap();
        work.pending -= 1;
        if work.pending == 0 && work.closed {
            self.retired.store(true, Ordering::Release);
        }
    }
    pub fn acceptance(&self) -> DenoiseAcceptance {
        match self.accepted.load(Ordering::Acquire) {
            1 => DenoiseAcceptance::Accepted,
            2 => DenoiseAcceptance::Rejected,
            _ => DenoiseAcceptance::Pending,
        }
    }
    /// True after the frame closes and every coordinated submission completes,
    /// including early submissions when no output could be sealed.
    pub fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }
    pub(super) fn reject(&self) {
        let _ = self
            .accepted
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
    }
    pub(super) fn accept(&self) {
        let _ = self
            .accepted
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire);
    }
    pub(super) fn maintain_retirement(&self, gpu: &GpuDevice) {
        // A final cancelled result may be the device's last user. Drive its
        // completion off-thread so queue callbacks cannot form an orphaned
        // resource/device cycle when the Engine is destroyed without another tick.
        while !self.is_retired() {
            if gpu.loss.check().is_err() || gpu.device.poll(wgpu::PollType::Poll).is_err() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}

/// An owned snapshot on the rendering device. Buffers hold per-sample averaged
/// linear RGBA32F color/coverage and the existing normal/albedo guides. They are
/// immutable after publication; do not destroy or write through their handles.
/// This mode has no camera jitter/depth/motion or optical-path claims.
pub struct GpuDenoiseInput {
    /// Present only in TemporalGpu mode. Guides describe an independently sampled frame.
    pub temporal: Option<super::TemporalFrame>,
    /// Declared normalized AOV snapshots; empty unless requested by the filter.
    pub aovs: Vec<super::GpuAov>,
    pub id: DenoiseFrameId,
    pub size: [u32; 2],
    pub(super) output_size: [u32; 2],
    pub samples: u32,
    pub buffers: DenoiseBuffers,
    pub device: wgpu::Device,
    pub gpu: DenoiseGpu,
    status: DenoiseFrameStatus,
    loss: crate::device_loss::DeviceLossNotifier,
    cancel: CancelToken,
}
impl GpuDenoiseInput {
    pub(super) fn new(
        gpu: &GpuDevice,
        target: u64,
        generation: u64,
        size: [u32; 2],
        samples: u32,
        buffers: DenoiseBuffers,
        filter: Arc<dyn CustomDenoiser>,
        cancel: CancelToken,
    ) -> Self {
        let status = DenoiseFrameStatus::new();
        let lease = super::custom_gpu_submission::SubmissionLease::new(
            status.clone(),
            &buffers,
            gpu.loss.clone(),
            filter,
        );
        // Raw snapshot copies were submitted before constructing this input.
        // Their lease is part of retirement even if the callback fails early.
        lease.producer_submitted(&gpu.queue);
        Self {
            aovs: Vec::new(),
            temporal: None,
            id: DenoiseFrameId {
                device: gpu.frame_device.id,
                target,
                generation,
                frame: crate::denoiser_inputs::identity(),
            },
            size,
            output_size: size,
            samples,
            buffers,
            device: gpu.device.clone(),
            gpu: DenoiseGpu(gpu.queue.clone(), Some(lease)),
            status,
            loss: gpu.loss.clone(),
            cancel,
        }
    }
    pub fn status(&self) -> DenoiseFrameStatus {
        self.status.clone()
    }
    /// Required width and height of the sealed resident result.
    pub fn output_size(&self) -> [u32; 2] {
        self.output_size
    }
    pub(super) fn retain_buffers(&self) {
        let mut buffers = super::custom_gpu_submission::SubmissionLease::copies(&self.buffers);
        buffers.extend(self.aovs.iter().map(|a| a.buffer.clone()));
        *self.gpu.1.as_ref().unwrap().buffers.lock().unwrap() = buffers;
        *self.gpu.1.as_ref().unwrap().temporal.lock().unwrap() = self.temporal.clone();
        // The averaging producer was submitted immediately before this call.
        self.gpu.1.as_ref().unwrap().producer_submitted(&self.gpu.0);
    }
    /// Submits separate producer/SDK/consumer command buffers in iterator order
    /// on the rendering queue. All result writes must be included here or have
    /// already been submitted through this input's DenoiseGpu. This does not
    /// wait for GPU completion; a paused submission gate can block submission.
    ///
    /// Output is bottom-row-first, finite, linear RGBA32F color with the input
    /// coverage semantics, COPY_SRC, on this device. The filter is responsible
    /// for finite values; explicit pixel exports validate them on readback.
    /// The returned result belongs to this exact invocation and cannot be reused.
    pub fn submit(
        self,
        commands: impl IntoIterator<Item = wgpu::CommandBuffer>,
        output: wgpu::Buffer,
    ) -> std::result::Result<GpuDenoiseOutput, String> {
        if self.cancel.is_cancelled() {
            self.status.reject();
            return Err("Custom GPU frame was cancelled".into());
        }
        self.loss.check().map_err(|e| e.to_string())?;
        let bytes = self.output_size[0] as u64 * self.output_size[1] as u64 * 16;
        if output.size() < bytes || !output.usage().contains(wgpu::BufferUsages::COPY_SRC) {
            self.status.reject();
            return Err("Invalid resident custom denoiser output buffer".into());
        }
        // Copy into an owned buffer, freezing the result against the caller's
        // later writes and letting validation catch foreign-device resources.
        let frozen = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Custom GPU denoiser result lease"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut copy = self.device.create_command_encoder(&Default::default());
        copy.copy_buffer_to_buffer(&output, 0, &frozen, 0, bytes);
        let gpu = self.gpu.0.clone();
        self.gpu.submit(commands.into_iter().chain([copy.finish()]));
        // Resolving a validation scope does not wait for GPU completion.
        let validation = pollster::block_on(scope.pop());
        let status = self.status.clone();
        let id = self.id;
        let size = self.output_size;
        let held_result = frozen.clone();
        gpu.on_submitted_work_done(move || {
            // Foreign SDK/Drop code never runs inside a wgpu poll callback.
            std::thread::spawn(move || drop((self, output, held_result)));
        });
        if let Some(error) = validation {
            status.reject();
            return Err(error.to_string());
        }
        Ok(GpuDenoiseOutput {
            id,
            size,
            buffer: frozen,
            status,
        })
    }
}
impl Drop for GpuDenoiseInput {
    fn drop(&mut self) {
        self.status.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acceptance_and_retirement_are_independent_terminal_states() {
        let status = DenoiseFrameStatus::new();
        assert_eq!(status.acceptance(), DenoiseAcceptance::Pending);
        status.reject();
        status.accept();
        assert_eq!(status.acceptance(), DenoiseAcceptance::Rejected);
        assert!(!status.is_retired());
        assert!(status.begin());
        status.close();
        assert!(!status.is_retired());
        status.complete();
        assert!(status.is_retired());
        assert_eq!(status.acceptance(), DenoiseAcceptance::Rejected);
    }
    #[test]
    fn early_submission_completion_does_not_retire_an_open_frame() {
        let status = DenoiseFrameStatus::new();
        assert!(status.begin());
        status.complete();
        assert!(!status.is_retired());
        assert!(status.begin());
        assert!(status.begin());
        status.close();
        status.complete();
        assert!(!status.is_retired());
        status.complete();
        assert!(status.is_retired());
        assert!(!status.begin());
        let unused = DenoiseFrameStatus::new();
        unused.close();
        assert!(unused.is_retired());
    }
    #[test]
    fn accumulation_snapshot_shader_validates_and_emits_for_both_native_backends() {
        let module =
            naga::front::wgsl::parse_str(include_str!("custom-gpu-snapshot.wgsl")).unwrap();
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .unwrap();
        let spv = naga::back::spv::write_vec(&module, &info, &Default::default(), None).unwrap();
        assert!(!spv.is_empty());
        let mut hlsl = String::new();
        naga::back::hlsl::Writer::new(&mut hlsl, &Default::default(), &Default::default())
            .write(&module, &info, None)
            .unwrap();
        assert!(!hlsl.is_empty());
    }
}

/// A sealed same-device result, constructed by [`GpuDenoiseInput::submit`].
/// Dropping an unpublished result rejects it, independently of GPU retirement.
pub struct GpuDenoiseOutput {
    pub(super) id: DenoiseFrameId,
    pub(super) size: [u32; 2],
    pub(super) buffer: wgpu::Buffer,
    pub(super) status: DenoiseFrameStatus,
}
impl Drop for GpuDenoiseOutput {
    fn drop(&mut self) {
        self.status.reject();
    }
}

/// GPU resolve of the existing accumulation guides, independent of the tracer's
/// random streams. This is not the temporal first-surface guide producer.
pub(crate) fn snapshot_pipeline(device: &wgpu::Device) -> wgpu::ComputePipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Custom GPU accumulation snapshot"),
        source: wgpu::ShaderSource::Wgsl(include_str!("custom-gpu-snapshot.wgsl").into()),
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("Custom GPU accumulation snapshot"),
        module: &module,
        layout: None,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    })
}

pub(crate) fn snapshot_buffers(
    gpu: &GpuDevice,
    pipeline: &wgpu::ComputePipeline,
    sources: [&wgpu::Buffer; 3],
    size: [u32; 2],
    samples: u32,
) -> Result<DenoiseBuffers> {
    use wgpu::util::DeviceExt;
    gpu.loss.check()?;
    let bytes = size[0] as u64 * size[1] as u64 * 16;
    let allocate = || {
        gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Custom GPU immutable guide snapshot"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    };
    let buffers = DenoiseBuffers {
        color: allocate(),
        normal: allocate(),
        albedo: allocate(),
    };
    let values = [samples, size[0], size[1], 0];
    let uniform = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(&values),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let resources = [
        sources[0],
        sources[1],
        sources[2],
        &buffers.color,
        &buffers.normal,
        &buffers.albedo,
        &uniform,
    ];
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &resources
            .iter()
            .enumerate()
            .map(|(binding, b)| wgpu::BindGroupEntry {
                binding: binding as u32,
                resource: b.as_entire_binding(),
            })
            .collect::<Vec<_>>(),
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(size[0].div_ceil(8), size[1].div_ceil(8), 1);
    }
    gpu.queue.submit([encoder.finish()]);
    Ok(buffers)
}
