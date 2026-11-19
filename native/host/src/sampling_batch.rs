//! Group short Metal HWRT dispatches without adding a normal CPU wait. Each
//! dispatch reads its own uniform range; uploads are ordered before its buffer.
//! Callers retire each buffer before submitting another sampling flight.
use crate::{GpuDevice, GpuScene, Mutex, Result, Target, layout, native_completion, profiling};

const DEFAULT_DISPATCHES: u32 = 4;

// Hosts can wrap the same wgpu device in more than one engine. Hold a weak
// registry of live admissions so dropping the last engine releases its device.
pub(super) struct Admission {
    device: wgpu::Device,
    pub(super) flight: Mutex<Option<Pending>>,
}
impl Admission {
    pub(super) fn for_device(device: &wgpu::Device) -> std::sync::Arc<Self> {
        use std::sync::{Arc, Weak};
        static DEVICES: Mutex<Vec<Weak<Admission>>> = Mutex::new(Vec::new());
        let mut devices = DEVICES.lock().unwrap();
        devices.retain(|d| d.strong_count() != 0);
        if let Some(existing) = devices
            .iter()
            .filter_map(Weak::upgrade)
            .find(|a| a.device == *device)
        {
            return existing;
        }
        let admission = Arc::new(Self {
            device: device.clone(),
            flight: Mutex::new(None),
        });
        devices.push(Arc::downgrade(&admission));
        admission
    }
}
pub(super) struct Pending {
    native: native_completion::Batch,
    done: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Pending {
    pub(super) fn new(
        native: native_completion::Batch,
        done: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        Self { native, done }
    }
    pub(super) fn is_retired(&self) -> bool {
        self.done.load(std::sync::atomic::Ordering::Acquire) && self.native.is_retired()
    }
    pub(super) fn check_deadline(&self) -> Result<()> {
        self.native.check_deadline()
    }
    pub(super) fn belongs_to(&self, done: &std::sync::Arc<std::sync::atomic::AtomicBool>) -> bool {
        std::sync::Arc::ptr_eq(&self.done, done)
    }
}

pub(super) fn for_target(
    gpu: &GpuDevice,
    hardware: bool,
    trace: &[u8],
    caustics: bool,
) -> Option<Mutex<State>> {
    (hardware && gpu.info.backend == wgpu::Backend::Metal && !caustics)
        .then(|| Mutex::new(State::new(trace)))
}

pub(super) struct State {
    trace: Vec<u8>,
    bindings: Option<Bindings>,
    standby: Option<Bindings>,
    limit: u32,
    adaptive: bool,
    sample_ms: Option<f64>,
    upshift_streak: u8,
    pub(super) checkpoint: Option<std::sync::Arc<crate::query_guard::Checkpoint>>,
    pub(super) verified: u32,
    pub(super) mirror_pending: bool,
    continuous: bool,
}
impl State {
    fn new(trace: &[u8]) -> Self {
        Self {
            trace: trace.to_vec(),
            bindings: None,
            standby: None,
            limit: DEFAULT_DISPATCHES,
            adaptive: true,
            sample_ms: None,
            upshift_streak: 0,
            checkpoint: None,
            verified: 0,
            mirror_pending: false,
            continuous: false,
        }
    }
    pub(super) fn continuous(&mut self, enabled: bool) {
        self.continuous = enabled && self.adaptive;
        if !self.continuous && self.limit > 32 {
            self.limit = 32;
        }
    }
    pub(super) fn logical_count(&self, maximum: u32) -> u32 {
        if self.continuous && self.limit > 32 {
            maximum.min(self.limit)
        } else {
            maximum
        }
    }
    pub(super) fn long_flight(&self) -> bool {
        self.sample_ms
            .is_some_and(|ms| ms * f64::from(DEFAULT_DISPATCHES) > 16.)
    }
    pub(super) fn limit(&self) -> u32 {
        self.limit
    }
    #[cfg(test)]
    pub(super) fn set_limit(&mut self, limit: u32) {
        assert!([4, 8, 32].contains(&limit));
        self.limit = limit;
        self.bindings = None;
        self.standby = None;
        self.adaptive = false;
        self.sample_ms = None;
        self.upshift_streak = 0;
    }
    pub(super) fn write_trace(&mut self, offset: usize, bytes: &[u8]) {
        self.checkpoint = None;
        self.verified = 0;
        self.mirror_pending = false;
        self.trace[offset..offset + bytes.len()].copy_from_slice(bytes);
        self.reset_adaptation();
    }
    pub(super) fn reset_accumulation(&mut self) {
        self.checkpoint = None;
        self.verified = 0;
        self.mirror_pending = false;
        self.reset_adaptation();
    }
    pub(super) fn reset_adaptation(&mut self) {
        if !self.adaptive {
            return;
        }
        self.limit = DEFAULT_DISPATCHES;
        self.sample_ms = None;
        self.upshift_streak = 0;
    }
    pub(super) fn observe(
        &mut self,
        samples: u32,
        gpu_ms: Option<f64>,
        elapsed: Option<std::time::Duration>,
        repaired: bool,
    ) {
        if !self.adaptive {
            return;
        }
        if repaired {
            self.reset_adaptation();
            return;
        }
        if samples == 0 {
            return;
        }
        let measured = gpu_ms
            .filter(|ms| ms.is_finite() && *ms > 0.)
            .or_else(|| elapsed.map(|time| time.as_secs_f64() * 1000.));
        let Some(ms) = measured
            .filter(|ms| ms.is_finite() && *ms > 0.)
            .map(|ms| ms / f64::from(samples))
        else {
            return;
        };
        // Slow work lowers the cap immediately. Faster observations decay the
        // conservative estimate gradually; two healthy observations and a 25%
        // margin are required before increasing the physical buffer size.
        let estimate = self
            .sample_ms
            .map_or(ms, |old| ms.max(old * 0.75 + ms * 0.25));
        self.sample_ms = Some(estimate);
        let tier = |budget| {
            [32, 8, 4]
                .into_iter()
                .find(|n| estimate * f64::from(*n) <= budget)
                .unwrap_or(4)
        };
        // An indivisible physical batch need not round a duration budget down
        // to the previous power-of-two tier. Keep the existing hard deadline.
        let stable_cap = |budget: f64| {
            if self.continuous && self.limit >= 32 {
                let capacity = (budget / estimate).floor().clamp(0., 64.) as u32;
                (capacity > 32).then_some(capacity)
            } else {
                None
            }
        };
        let safe = stable_cap(16.).unwrap_or_else(|| tier(16.));
        if safe < self.limit {
            self.limit = safe;
            self.upshift_streak = 0;
        } else {
            let higher = stable_cap(15.5).unwrap_or_else(|| tier(12.));
            if higher > self.limit {
                self.upshift_streak = self.upshift_streak.saturating_add(1);
                if self.upshift_streak >= 2 {
                    self.limit = higher;
                    self.upshift_streak = 0;
                }
            } else {
                self.upshift_streak = 0;
            }
        }
    }
}

pub(super) fn completed(
    target: &Target,
    samples: u32,
    gpu_ms: Option<f64>,
    batch: &native_completion::Batch,
    repaired: bool,
) {
    if let Some(state) = &target.sampling_batch {
        let mut state = state.lock().unwrap();
        if batch.health.is_some() {
            state.verified = target.samples + samples;
        }
        state.observe(
            samples,
            gpu_ms,
            batch.sampling_started.map(|start| start.elapsed()),
            repaired,
        );
    }
}

struct Bindings {
    #[cfg(target_os = "macos")]
    shared: Option<crate::query_guard::SharedFlag>,
    uniform: wgpu::Buffer,
    groups: Vec<wgpu::BindGroup>,
    bytes: Vec<u8>,
    stride: usize,
    #[cfg(test)]
    audit: Option<AuditBindings>,
}
impl Bindings {
    fn new(scene: &GpuScene, target: &Target, capacity: u32, shared_uniform: bool) -> Self {
        let device = &scene.gpu.device;
        let alignment = device.limits().min_uniform_buffer_offset_alignment as usize;
        let stride = layout::ray_uniform::BYTES.div_ceil(alignment) * alignment;
        let capacity = capacity.next_multiple_of(8);
        let bytes = vec![0; stride * capacity as usize];
        let descriptor = wgpu::BufferDescriptor {
            label: Some("MuTracer sample batch uniforms"),
            size: bytes.len() as u64,
            usage: wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::UNIFORM
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        };
        #[cfg(target_os = "macos")]
        let (uniform, shared) = shared_uniform
            .then(|| crate::query_guard::SharedFlag::allocate(device, &descriptor))
            .flatten()
            .map(|(b, r)| (b, Some(r)))
            .unwrap_or_else(|| (device.create_buffer(&descriptor), None));
        #[cfg(not(target_os = "macos"))]
        let uniform = device.create_buffer(&descriptor);
        let pipeline = target.pipeline.as_ref().unwrap_or(&scene.pipeline);
        let group_layout = pipeline.get_bind_group_layout(layout::group::FRAME as u32);
        let groups = (0..capacity)
            .map(|index| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("MuTracer sample batch frame"),
                    layout: &group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: layout::frame_binding::CAMERA as u32,
                            resource: target.buffers[&layout::resource::CAMERA].as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: layout::frame_binding::TRACE_UNIFORM as u32,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &uniform,
                                offset: u64::from(index) * stride as u64,
                                size: std::num::NonZeroU64::new(layout::ray_uniform::BYTES as u64),
                            }),
                        },
                        wgpu::BindGroupEntry {
                            binding: layout::frame_binding::LIGHT_UNIFORM as u32,
                            resource: scene.buffers[&layout::resource::LIGHT_UNIFORM]
                                .as_entire_binding(),
                        },
                    ],
                })
            })
            .collect();
        Self {
            uniform,
            #[cfg(target_os = "macos")]
            shared,
            groups,
            bytes,
            stride,
            #[cfg(test)]
            audit: None,
        }
    }
    fn can_prepare(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.shared.is_some()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }
    fn pack(&mut self, trace: &[u8], frames: &[[u8; 16]]) {
        for (slot, frame) in frames.iter().enumerate() {
            let at = slot * self.stride;
            self.bytes[at..at + trace.len()].copy_from_slice(trace);
            for (source, destination) in [
                (0, layout::ray_uniform::SAMPLE_COUNT),
                (4, layout::ray_uniform::BOUNCES),
                (8, layout::ray_uniform::SEQUENCE_SEED),
            ] {
                self.bytes[at + destination..at + destination + 4]
                    .copy_from_slice(&frame[source..source + 4]);
            }
        }
    }
    fn upload(&mut self, scene: &GpuScene, trace: &[u8], frames: &[[u8; 16]]) {
        self.pack(trace, frames);
        // Reusing the slots is safe: pending writes precede the next submission,
        // after the previous submission's reads. Never overwrite one range for
        // different dispatches within the same command buffer.
        scene
            .gpu
            .queue
            .write_buffer(&self.uniform, 0, &self.bytes[..frames.len() * self.stride]);
    }
}

pub(super) struct Prepared {
    command: wgpu::CommandBuffer,
    mirrored: bool,
    checkpoint: std::sync::Arc<crate::query_guard::Checkpoint>,
    start: u32,
    count: u32,
    limit: u32,
    timer: Option<profiling::GpuTimer>,
    receipt: Option<crate::query_guard::Receipt>,
}
impl Prepared {
    pub(super) fn matches(&self, target: &Target, start: u32, count: u32) -> bool {
        self.start == start
            && self.count == count
            && self.checkpoint.captured.elapsed() < crate::query_guard::INTERVAL
            && target.sampling_batch.as_ref().is_some_and(|state| {
                let s = state.lock().unwrap();
                s.limit == self.limit
                    && s.bindings.is_some()
                    && s.checkpoint
                        .as_ref()
                        .is_some_and(|c| std::sync::Arc::ptr_eq(c, &self.checkpoint))
            })
    }
    pub(super) fn commit(
        self,
        scene: &GpuScene,
        target: &Target,
    ) -> (native_completion::Batch, Option<profiling::GpuTimer>) {
        let begun = std::time::Instant::now();
        let completion = native_completion::Recording::new();
        let mut state = target.sampling_batch.as_ref().unwrap().lock().unwrap();
        let State {
            bindings, standby, ..
        } = &mut *state;
        std::mem::swap(bindings, standby);
        state.mirror_pending = !self.mirrored;
        scene.gpu.queue.submit([self.command]);
        let mut batch = completion.finish();
        batch.deadline = Some(begun + std::time::Duration::from_secs(30));
        batch.sampling_started = Some(begun);
        batch.checkpoint = Some(self.checkpoint);
        if let Some(r) = self.receipt {
            r.map();
            batch.health = Some(r);
        }
        #[cfg(test)]
        {
            scene.gpu.recovery_test.lock().unwrap().submissions += 1;
        }
        (batch, self.timer)
    }
}
impl GpuScene {
    pub(super) fn native_sampling_time(&self) -> bool {
        self.query_guard.is_some() && self.gpu.queue.observed.available()
    }
    pub(super) fn write_last_sample(&self, target: &Target, end: u32) {
        let last = &target.frames[(end - 1) as usize];
        let original = &target.buffers[&layout::resource::TRACE_UNIFORM];
        for (source, destination) in [
            (0, layout::ray_uniform::SAMPLE_COUNT),
            (4, layout::ray_uniform::BOUNCES),
            (8, layout::ray_uniform::SEQUENCE_SEED),
        ] {
            self.gpu
                .queue
                .write_buffer(original, destination as u64, &last[source..source + 4]);
        }
    }
    fn encode_samples(
        &self,
        target: &Target,
        pipeline: &wgpu::ComputePipeline,
        output: &wgpu::BindGroup,
        bindings: &Bindings,
        first: u32,
        until: u32,
        timer: Option<&profiling::GpuTimer>,
        pair: u32,
        resolve: bool,
        #[cfg(test)] partial: Option<u32>,
    ) -> wgpu::CommandEncoder {
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("MuTracer sampling batch"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("MuTracer batched path trace"),
                timestamp_writes: timer.map(|t| t.pass(pair)),
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &self.groups[0], &[]);
            pass.set_bind_group(1, &self.groups[1], &[]);
            pass.set_bind_group(3, output, &[]);
            for sample in first..until {
                #[cfg(test)]
                if partial.is_some_and(|s| sample > s) {
                    continue;
                }
                #[cfg(test)]
                if bindings.audit.is_some() {
                    pass.set_pipeline(pipeline);
                    pass.set_bind_group(0, &self.groups[0], &[]);
                    pass.set_bind_group(1, &self.groups[1], &[]);
                    pass.set_bind_group(3, output, &[]);
                }
                let slot = (sample - first) as usize;
                pass.set_bind_group(2, &bindings.groups[slot], &[]);
                let rows = self.sampling_group_rows(target);
                #[cfg(test)]
                let rows = if partial == Some(sample) {
                    rows / 2
                } else {
                    rows
                };
                pass.dispatch_workgroups(target.width.div_ceil(target.workgroup_size), rows, 1);
                #[cfg(test)]
                if let (Some(audit), Some(binding)) = (&target.dispatch_audit, &bindings.audit) {
                    pass.set_pipeline(&audit.pipeline);
                    pass.set_bind_group(0, &binding.groups[slot], &[]);
                    pass.dispatch_workgroups(1, 1, 1);
                }
            }
        }
        if resolve {
            if let Some(timer) = timer {
                timer.resolve(&mut encoder);
            }
        }
        encoder
    }
    pub(super) fn prepare_next(
        &self,
        target: &Target,
        start: u32,
        count: u32,
        terminal: bool,
    ) -> Option<Prepared> {
        if count == 0 {
            return None;
        }
        #[cfg(test)]
        if target.dispatch_audit.is_some()
            || self
                .gpu
                .recovery_test
                .lock()
                .unwrap()
                .partial_sample
                .is_some()
            || crate::query_guard::injects(&self.gpu, start, start + count)
        {
            return None;
        }
        let mut state = target.sampling_batch.as_ref()?.lock().unwrap();
        let checkpoint = state.checkpoint.clone()?;
        #[cfg(target_os = "macos")]
        if checkpoint.shared.is_none() {
            return None;
        }
        if checkpoint.captured.elapsed() >= crate::query_guard::INTERVAL || count > state.limit {
            return None;
        }
        let limit = state.limit;
        let state_is_slow = state.long_flight();
        let State { trace, standby, .. } = &mut *state;
        // Only the retired slot can be filled by the CPU. Preparing a second
        // command never changes the uniform memory of the active flight.
        if standby
            .as_ref()
            .is_none_or(|b| !b.can_prepare() || b.groups.len() < (limit as usize))
        {
            *standby = Some(Bindings::new(self, target, limit, true));
        }
        let bindings = standby.as_mut()?;
        if !bindings.can_prepare() {
            return None;
        }
        bindings.pack(
            trace,
            &target.frames[start as usize..(start + count) as usize],
        );
        #[cfg(target_os = "macos")]
        bindings
            .shared
            .as_mut()?
            .fill_idle(&bindings.bytes[..count as usize * bindings.stride]);
        let timer = if self.native_sampling_time() {
            None
        } else {
            profiling::GpuTimer::realtime(&self.gpu.device, 1, false)
        };
        let pipeline = target.pipeline.as_ref().unwrap_or(&self.pipeline);
        let mut encoder = self.encode_samples(
            target,
            pipeline,
            &checkpoint.group,
            bindings,
            start,
            start + count,
            timer.as_ref(),
            0,
            true,
            #[cfg(test)]
            None,
        );
        // Updating the frame uniform in a long sampling buffer costs one blit and
        // avoids scheduling a separate upload when a checkpoint becomes due.
        let mirror = terminal || state_is_slow;
        if mirror {
            encoder.copy_buffer_to_buffer(
                &bindings.uniform,
                (count - 1) as u64 * bindings.stride as u64,
                &target.buffers[&layout::resource::TRACE_UNIFORM],
                0,
                trace.len() as u64,
            );
        }
        let receipt = terminal.then(|| {
            checkpoint.direct_receipt().unwrap_or_else(|| {
                crate::query_guard::Receipt::copy(&self.gpu, &checkpoint.flag, &mut encoder)
            })
        });
        let command = encoder.finish();
        Some(Prepared {
            mirrored: mirror,
            command,
            checkpoint: checkpoint.clone(),
            start,
            count,
            limit: state.limit,
            timer,
            receipt,
        })
    }
}
impl GpuScene {
    pub(super) fn dispatch_target_batched(
        &self,
        target: &Target,
        start: u32,
        additional: u32,
        timer: Option<&profiling::GpuTimer>,
    ) -> Result<native_completion::Batch> {
        self.dispatch_target_checkpointed(target, start, additional, timer, None)
    }
    pub(super) fn dispatch_target_checkpointed(
        &self,
        target: &Target,
        start: u32,
        additional: u32,
        timer: Option<&profiling::GpuTimer>,
        checkpoint: Option<std::sync::Arc<crate::query_guard::Checkpoint>>,
    ) -> Result<native_completion::Batch> {
        let started = std::time::Instant::now();
        let end = start + additional;
        let replay = checkpoint.is_some();
        let refresh = if checkpoint.is_none() && self.query_guard.is_some() {
            target
                .sampling_batch
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .checkpoint
                .as_ref()
                .is_none_or(|saved| {
                    saved.start > start || saved.captured.elapsed() >= crate::query_guard::INTERVAL
                })
        } else {
            false
        };
        let repaired_prefix = if refresh {
            self.verify_sampling_target(target, start)?
        } else {
            false
        };
        let mut state = target.sampling_batch.as_ref().unwrap().lock().unwrap();
        let checkpoint = checkpoint.or_else(|| {
            self.query_guard.as_ref().map(|_| {
                if refresh {
                    state.checkpoint = Some(std::sync::Arc::new(
                        crate::query_guard::Checkpoint::capture(self, target, start),
                    ));
                    state.verified = start;
                }
                state.checkpoint.as_ref().unwrap().clone()
            })
        });
        state.mirror_pending = false;
        let State {
            trace,
            bindings,
            limit,
            ..
        } = &mut *state;
        let limit = *limit;
        if additional > limit {
            return Err("Sampling flight exceeds one Metal command buffer".into());
        }
        if bindings
            .as_ref()
            .is_none_or(|b| b.groups.len() < (limit as usize))
        {
            *bindings = Some(Bindings::new(self, target, limit, false));
        }
        let bindings = bindings.as_mut().unwrap();
        #[cfg(test)]
        bindings.prepare_audit(self, target);
        #[cfg(test)]
        let partial = {
            let mut hook = self.gpu.recovery_test.lock().unwrap();
            hook.partial_sample
                .filter(|s| (start..end).contains(s))
                .inspect(|_| hook.partial_sample = None)
        };
        let pipeline = if replay {
            checkpoint.as_ref().unwrap().replay_pipeline(self, target)
        } else {
            target.pipeline.as_ref().unwrap_or(&self.pipeline)
        };
        let completion = native_completion::Recording::new();
        // Preserve the original uniform's post-flight metadata for AOV/producer
        // passes. Sampling itself reads the immutable per-dispatch ranges below.
        self.write_last_sample(target, end);
        for (pair, first) in (start..end).step_by(limit as usize).enumerate() {
            let until = (first + limit).min(end);
            bindings.upload(self, trace, &target.frames[first as usize..until as usize]);
            #[cfg(test)]
            bindings.upload_audit(self, first, until);
            let output = checkpoint.as_ref().map_or(&target.groups[1], |c| &c.group);
            // Force every ray (including the canary) to miss during this physical batch.
            #[cfg(test)]
            let fault = (checkpoint.is_some()
                && crate::query_guard::injects(&self.gpu, first, until))
            .then(|| crate::query_guard::Checkpoint::pipeline(self, target, ("MT_TEST_MISS", 1.)));
            #[cfg(test)]
            let pipeline = fault.as_ref().unwrap_or(pipeline);
            let encoder = self.encode_samples(
                target,
                pipeline,
                output,
                bindings,
                first,
                until,
                timer,
                pair as u32,
                until == end,
                #[cfg(test)]
                partial,
            );
            let command = encoder.finish();
            self.gpu.queue.submit([command]);
            #[cfg(test)]
            {
                self.gpu.recovery_test.lock().unwrap().submissions += 1;
            }
        }
        #[allow(unused_mut)]
        let mut batch = completion.finish();
        {
            if checkpoint.is_some() {
                batch.sampling_started = Some(started);
                batch.deadline = Some(started + std::time::Duration::from_secs(30));
            }
            batch.checkpoint = checkpoint;
            batch.repaired_prefix = repaired_prefix;
        }
        #[cfg(test)]
        if partial.is_some() {
            batch.injected_error = Some("controlled partial flight failure".into());
            batch.injected_kind = Some(native_completion::FailureKind::Retry);
        }
        Ok(batch)
    }
}

#[cfg(test)]
struct AuditBindings {
    indices: wgpu::Buffer,
    bytes: Vec<u8>,
    stride: usize,
    groups: Vec<wgpu::BindGroup>,
}
#[cfg(test)]
impl Bindings {
    fn prepare_audit(&mut self, scene: &GpuScene, target: &Target) {
        let Some(audit) = &target.dispatch_audit else {
            return;
        };
        if self.audit.is_some() {
            return;
        }
        let device = &scene.gpu.device;
        let stride = device.limits().min_uniform_buffer_offset_alignment as usize;
        let capacity = self.groups.len();
        let bytes = vec![0; stride * capacity];
        let indices = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test-only batch sample indices"),
            size: bytes.len() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group_layout = audit.pipeline.get_bind_group_layout(0);
        let groups = (0..capacity)
            .map(|index| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("test-only batch tail marker"),
                    layout: &group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: audit.counts.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &indices,
                                offset: index as u64 * stride as u64,
                                size: std::num::NonZeroU64::new(4),
                            }),
                        },
                    ],
                })
            })
            .collect();
        self.audit = Some(AuditBindings {
            indices,
            bytes,
            stride,
            groups,
        });
    }
    fn upload_audit(&mut self, scene: &GpuScene, first: u32, until: u32) {
        let Some(audit) = &mut self.audit else {
            return;
        };
        for (slot, sample) in (first..until).enumerate() {
            audit.bytes[slot * audit.stride..slot * audit.stride + 4]
                .copy_from_slice(&sample.to_le_bytes());
        }
        scene.gpu.queue.write_buffer(
            &audit.indices,
            0,
            &audit.bytes[..(until - first) as usize * audit.stride],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn automatic() -> State {
        let mut state = State::new(&[]);
        state.adaptive = true;
        state.reset_adaptation();
        state
    }
    #[test]
    fn automatic_batches_calibrate_then_bound_growth_and_back_off_on_slow_work() {
        let mut state = automatic();
        state.observe(4, Some(0.4), None, false);
        assert_eq!(state.limit(), 4);
        state.observe(4, Some(0.4), None, false);
        assert_eq!(state.limit(), 32);
        state.observe(32, Some(32.), None, false);
        assert_eq!(state.limit(), 8);
        state.observe(8, Some(160.), None, false);
        assert_eq!(state.limit(), 4);
    }
    #[test]
    fn missing_timestamps_use_completed_wall_time_and_failed_work_never_enlarges_batches() {
        let mut state = automatic();
        for _ in 0..2 {
            state.observe(
                4,
                Some(f64::NAN),
                Some(std::time::Duration::from_millis(1)),
                false,
            );
        }
        assert_eq!(state.limit(), 32);
        state.observe(0, Some(1.), None, false);
        assert_eq!(state.limit(), 32);
        state.observe(32, Some(0.1), None, true);
        assert_eq!(state.limit(), 4);
        state.observe(4, Some(0.4), None, false);
        assert_eq!(state.limit(), 4);
        state.write_trace(0, &[]);
        state.observe(4, Some(0.4), None, false);
        assert_eq!(state.limit(), 4);
    }
    #[test]
    fn hysteresis_and_explicit_caps_keep_submission_sizes_stable() {
        let mut state = automatic();
        for _ in 0..8 {
            state.observe(4, Some(1.6), None, false);
        }
        assert_eq!(
            state.limit(),
            8,
            "32 dispatches do not fit the growth margin"
        );
        for cap in [4, 8, 32] {
            state.set_limit(cap);
            for _ in 0..3 {
                state.observe(4, Some(0.004), None, false);
                state.observe(4, Some(400.), None, true);
            }
            assert_eq!(state.limit(), cap);
        }
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn adaptive_large_flight_repair_and_partial_tail_preserve_all_accumulations() {
        let _test = crate::abi_test_lock();
        let _entry = crate::entry_lock();
        let gpu = GpuDevice::with_backend(1).unwrap();
        if gpu.info.backend != wgpu::Backend::Metal {
            return;
        }
        let (mut scene, mut assets, _) =
            crate::scene::prepare_retained(&crate::scene::tests::translated_camera_input(), true)
                .unwrap();
        scene.hwrt = Some(
            crate::hardware::capture_from_resources(
                &mut assets,
                scene.native_layout.as_ref().unwrap(),
            )
            .unwrap(),
        );
        let (renderer, mut target) = GpuScene::new(
            scene,
            &crate::RenderOptions {
                flags: 4,
                ..Default::default()
            },
            &assets,
            gpu.clone(),
        )
        .unwrap();
        let read = |target: &Target| {
            (0..4)
                .map(|i| {
                    gpu.queue
                        .read_buffer(&gpu.device, target.output(i).unwrap().slice(..))
                        .unwrap()
                })
                .collect::<Vec<_>>()
        };
        renderer.add_samples(&mut target, 65).unwrap();
        let expected = read(&target);
        renderer.reset_target(&mut target).unwrap();
        {
            let mut state = target.sampling_batch.as_ref().unwrap().lock().unwrap();
            state.adaptive = true;
            state.reset_adaptation();
            for _ in 0..2 {
                state.observe(4, Some(0.4), None, false);
            }
            assert_eq!(state.limit(), 32);
        }
        gpu.recovery_test.lock().unwrap().replayed_ranges.clear();
        gpu.recovery_test.lock().unwrap().silent_sample = Some(20);
        renderer.add_samples(&mut target, 65).unwrap();
        assert_eq!(
            read(&target),
            expected,
            "adaptive slot growth or rollback changed samples"
        );
        assert!(
            !gpu.recovery_test.lock().unwrap().replayed_ranges.is_empty(),
            "tail failure must replay from the checkpoint"
        );
    }

    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn batch_uniform_updates_and_slot_reuse_match_unbatched_outputs() {
        let _test = crate::abi_test_lock();
        let _entry = crate::entry_lock();
        for backend in [0, 1] {
            let gpu = GpuDevice::with_backend(backend).unwrap();
            let (mut scene, mut assets, retained) = crate::scene::prepare_retained(
                &crate::scene::tests::translated_camera_input(),
                backend == 1,
            )
            .unwrap();
            if backend == 1 {
                scene.hwrt = Some(
                    crate::hardware::capture_from_resources(
                        &mut assets,
                        scene.native_layout.as_ref().unwrap(),
                    )
                    .unwrap(),
                );
            }
            let (mut renderer, mut target) = GpuScene::new(
                scene,
                &crate::RenderOptions {
                    flags: if backend == 1 { 4 } else { 0 },
                    ..Default::default()
                },
                &assets,
                gpu.clone(),
            )
            .unwrap();
            renderer.retained = Some(retained);
            // Exercise the encoder on Software too, independently of its
            // production eligibility (Metal hardware ray queries only).
            target.sampling_batch = Some(Mutex::new(State::new(&renderer.display_trace)));
            let read = |renderer: &GpuScene, target: &Target| {
                (0..3)
                    .map(|kind| renderer.read_target(target, kind).unwrap())
                    .collect::<Vec<_>>()
            };
            renderer.add_samples(&mut target, 65).unwrap();
            let before = read(&renderer, &target);
            let environment: Vec<_> = [
                1u32,
                0,
                0,
                0,
                0.15f32.to_bits(),
                0.65f32.to_bits(),
                0.3f32.to_bits(),
                1f32.to_bits(),
                0,
                0,
                0,
                0,
            ]
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect();
            let updates = renderer
                .retained
                .as_ref()
                .unwrap()
                .environment(&environment)
                .unwrap();
            renderer.validate_lighting(&updates, Some(&target)).unwrap();
            renderer.update_lighting(&updates, Some(&target)).unwrap();
            renderer
                .retained
                .as_ref()
                .unwrap()
                .accept_lighting()
                .unwrap();
            renderer.reset_target(&mut target).unwrap();
            renderer.add_samples(&mut target, 65).unwrap();
            let changed = read(&renderer, &target);
            assert_ne!(changed[0], before[0], "background update was not visible");
            let cache = target.sampling_batch.take();
            renderer.reset_target(&mut target).unwrap();
            for _ in 0..65 {
                renderer.add_samples(&mut target, 1).unwrap();
            }
            assert_eq!(
                read(&renderer, &target),
                changed,
                "backend={backend}: stale trace parameters"
            );
            target.sampling_batch = cache;
            target.dispatch_audit = Some(crate::DispatchAudit::new(&gpu.device));
            for limit in [4, 8, 32] {
                target
                    .sampling_batch
                    .as_ref()
                    .unwrap()
                    .lock()
                    .unwrap()
                    .set_limit(limit);
                renderer.reset_target(&mut target).unwrap();
                gpu.recovery_test.lock().unwrap().replayed_ranges.clear();
                for count in [limit - 1, limit + 1, 65 - 2 * limit] {
                    renderer.add_samples(&mut target, count).unwrap();
                }
                assert_eq!(
                    read(&renderer, &target),
                    changed,
                    "backend={backend} limit={limit}: cached slots or partial batches"
                );
                crate::query_guard::assert_audit_attempts(
                    &gpu,
                    0,
                    &renderer.read_dispatch_audit(&target, 0, 65).unwrap(),
                );
            }
            let uniform = gpu
                .queue
                .read_buffer(
                    &gpu.device,
                    target.buffers[&layout::resource::TRACE_UNIFORM].slice(..),
                )
                .unwrap();
            for (source, destination) in [
                (0, layout::ray_uniform::SAMPLE_COUNT),
                (4, layout::ray_uniform::BOUNCES),
                (8, layout::ray_uniform::SEQUENCE_SEED),
            ] {
                assert_eq!(
                    &uniform[destination..destination + 4],
                    &target.frames[64][source..source + 4]
                );
            }
        }
    }
}
