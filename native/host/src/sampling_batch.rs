//! Group short Metal HWRT dispatches without adding a normal CPU wait. Each
//! dispatch reads its own uniform range; uploads are ordered before its buffer.
use crate::{GpuDevice, GpuScene, Mutex, Result, Target, layout, native_completion, profiling};

pub(super) const MAX_DISPATCHES: u32 = 4;

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
}
impl State {
    fn new(trace: &[u8]) -> Self {
        Self {
            trace: trace.to_vec(),
            bindings: None,
        }
    }
    pub(super) fn write_trace(&mut self, offset: usize, bytes: &[u8]) {
        self.trace[offset..offset + bytes.len()].copy_from_slice(bytes);
    }
}

struct Bindings {
    uniform: wgpu::Buffer,
    groups: Vec<wgpu::BindGroup>,
    bytes: Vec<u8>,
    stride: usize,
    #[cfg(test)]
    audit: Option<AuditBindings>,
}
impl Bindings {
    fn new(scene: &GpuScene, target: &Target) -> Self {
        let device = &scene.gpu.device;
        let alignment = device.limits().min_uniform_buffer_offset_alignment as usize;
        let stride = layout::ray_uniform::BYTES.div_ceil(alignment) * alignment;
        let bytes = vec![0; stride * MAX_DISPATCHES as usize];
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("MuTracer sample batch uniforms"),
            size: bytes.len() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let pipeline = target.pipeline.as_ref().unwrap_or(&scene.pipeline);
        let group_layout = pipeline.get_bind_group_layout(layout::group::FRAME as u32);
        let groups = (0..MAX_DISPATCHES)
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
            groups,
            bytes,
            stride,
            #[cfg(test)]
            audit: None,
        }
    }
    fn upload(&mut self, scene: &GpuScene, trace: &[u8], frames: &[[u8; 16]]) {
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
        // Reusing the slots is safe: pending writes precede the next submission,
        // after the previous submission's reads. Never overwrite one range for
        // different dispatches within the same command buffer.
        scene
            .gpu
            .queue
            .write_buffer(&self.uniform, 0, &self.bytes[..frames.len() * self.stride]);
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
        let end = start + additional;
        let mut state = target.sampling_batch.as_ref().unwrap().lock().unwrap();
        let State { trace, bindings } = &mut *state;
        let bindings = bindings.get_or_insert_with(|| Bindings::new(self, target));
        #[cfg(test)]
        bindings.prepare_audit(self, target);
        #[cfg(test)]
        let partial = {
            let mut hook = self.gpu.recovery_test.lock().unwrap();
            hook.partial_sample
                .filter(|s| (start..end).contains(s))
                .inspect(|_| hook.partial_sample = None)
        };
        let pipeline = target.pipeline.as_ref().unwrap_or(&self.pipeline);
        let completion = native_completion::Recording::new();
        // Preserve the original uniform's post-flight metadata for AOV/producer
        // passes. Sampling itself reads the immutable per-dispatch ranges below.
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
        for (pair, first) in (start..end).step_by(MAX_DISPATCHES as usize).enumerate() {
            let until = (first + MAX_DISPATCHES).min(end);
            bindings.upload(self, trace, &target.frames[first as usize..until as usize]);
            #[cfg(test)]
            bindings.upload_audit(self, first, until);
            let mut encoder =
                self.gpu
                    .device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("MuTracer sampling batch"),
                    });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("MuTracer batched path trace"),
                    timestamp_writes: timer.map(|t| t.pass(pair as u32)),
                });
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &self.groups[0], &[]);
                pass.set_bind_group(1, &self.groups[1], &[]);
                pass.set_bind_group(3, &target.groups[1], &[]);
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
                        pass.set_bind_group(3, &target.groups[1], &[]);
                    }
                    let slot = (sample - first) as usize;
                    pass.set_bind_group(2, &bindings.groups[slot], &[]);
                    let rows = target.height.div_ceil(target.workgroup_size);
                    #[cfg(test)]
                    let rows = if partial == Some(sample) {
                        rows / 2
                    } else {
                        rows
                    };
                    pass.dispatch_workgroups(target.width.div_ceil(target.workgroup_size), rows, 1);
                    #[cfg(test)]
                    if let (Some(audit), Some(binding)) = (&target.dispatch_audit, &bindings.audit)
                    {
                        pass.set_pipeline(&audit.pipeline);
                        pass.set_bind_group(0, &binding.groups[slot], &[]);
                        pass.dispatch_workgroups(1, 1, 1);
                    }
                }
            }
            if until == end {
                if let Some(timer) = timer {
                    timer.resolve(&mut encoder);
                }
            }
            self.gpu.queue.submit([encoder.finish()]);
            #[cfg(test)]
            {
                self.gpu.recovery_test.lock().unwrap().submissions += 1;
            }
        }
        #[allow(unused_mut)]
        let mut batch = completion.finish();
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
        let bytes = vec![0; stride * MAX_DISPATCHES as usize];
        let indices = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test-only batch sample indices"),
            size: bytes.len() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group_layout = audit.pipeline.get_bind_group_layout(0);
        let groups = (0..MAX_DISPATCHES)
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
                                offset: u64::from(index) * stride as u64,
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
            renderer.add_samples(&mut target, 17).unwrap();
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
            renderer.add_samples(&mut target, 17).unwrap();
            let changed = read(&renderer, &target);
            assert_ne!(changed[0], before[0], "background update was not visible");
            let cache = target.sampling_batch.take();
            renderer.reset_target(&mut target).unwrap();
            renderer.add_samples(&mut target, 17).unwrap();
            assert_eq!(
                read(&renderer, &target),
                changed,
                "backend={backend}: stale trace parameters"
            );
            target.sampling_batch = cache;
            target.dispatch_audit = Some(crate::DispatchAudit::new(&gpu.device));
            renderer.reset_target(&mut target).unwrap();
            for count in [7, 2, 8] {
                renderer.add_samples(&mut target, count).unwrap();
            }
            assert_eq!(
                read(&renderer, &target),
                changed,
                "backend={backend}: cached slots or partial batches"
            );
            assert_eq!(
                renderer.read_dispatch_audit(&target, 0, 17).unwrap(),
                vec![1; 17]
            );
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
                    &target.frames[16][source..source + 4]
                );
            }
        }
    }
}
