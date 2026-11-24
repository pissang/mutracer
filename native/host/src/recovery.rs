//! Retry Metal sampling before credit. Guarded flights restore a verified
//! checkpoint and replay the batch; other eligible paths fill missing pixels
//! using the existing adaptive target and per-pixel random sequence.
use crate::{
    GpuScene, Result, Target, layout,
    native_completion::{Batch, FailureKind},
};
use std::time::{Duration, Instant};

const ADAPTIVE_TARGETS: usize = 26;
pub(super) const TIME_LIMIT: Duration = Duration::from_secs(10);
pub(super) const MAX_RETRIES: u32 = 12;

#[cfg(test)]
#[derive(Default)]
pub(crate) struct Injection {
    pub failed_stage: Option<&'static str>,
    pub partial_sample: Option<u32>,
    pub silent_sample: Option<u32>,
    pub query_window: bool,
    pub repair_failures: u32,
    pub restore_failures: u32,
    pub replayed_ranges: Vec<std::ops::Range<u32>>,
    pub submissions: u32,
    pub repairs: u32,
}

impl GpuScene {
    /// Native completion must already have reported a retryable Metal error.
    /// Drain the device before replacing a queue, including uploads/other renders.
    /// Bound the whole flight, including waits and backoff, rather than each sample.
    pub(crate) fn repair_target(
        &self,
        target: &Target,
        start: u32,
        end: u32,
        failed: &Batch,
        original: Box<dyn std::error::Error>,
    ) -> Result<()> {
        if !self.gpu.queue.observed.available()
            || failed.failure_kind() == FailureKind::Unrecoverable
        {
            return Err(original);
        }
        if let Some(checkpoint) = &failed.caustic_checkpoint {
            return checkpoint.replay(self, target, start, end, failed.failure_kind(), original);
        }
        if target.caustics.is_some() {
            return Err(crate::status::fail(
                crate::Status::ContextFailed,
                format!("{original}; no verified caustic checkpoint"),
            ));
        }
        if failed.checkpoint.is_some() {
            return crate::query_guard::repair(self, target, start, end, failed, original);
        }
        let texture = self.textures.get(&ADAPTIVE_TARGETS).filter(|t| {
            t.width() == 1
                && t.height() == 1
                && t.format() == wgpu::TextureFormat::R32Float
                && t.usage().contains(wgpu::TextureUsages::COPY_DST)
        });
        let Some(texture) = texture else {
            return Err(original);
        };
        let begun = Instant::now();
        let deadline = begun + TIME_LIMIT;
        let mut retries = 0;
        let mut renewed = false;
        #[cfg(test)]
        {
            self.gpu.recovery_test.lock().unwrap().repairs += 1;
        }
        let device = &self.gpu.device;
        let queue = &self.gpu.queue;
        let uniform = &target.buffers[&layout::resource::TRACE_UNIFORM];
        let adaptive = layout::ray_uniform::ADAPTIVE_SAMPLING as u64;
        let set_target = |value: f32| {
            queue.write_texture(
                texture.as_image_copy(),
                &value.to_le_bytes(),
                wgpu::TexelCopyBufferLayout::default(),
                wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
            )
        };
        let wait = || -> Result<()> {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or("Flight repair exceeded its 10 second deadline")?;
            device.poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(remaining),
            })?;
            self.gpu.loss.check()?;
            Ok(())
        };
        let result = (|| -> Result<()> {
            wait()?;
            if failed.failure_kind() == FailureKind::SubmissionsIgnored {
                queue.renew()?;
                renewed = true;
            }
            for sample in start..end {
                let frame = &target.frames[sample as usize];
                loop {
                    if Instant::now() >= deadline {
                        return Err("Flight repair exceeded its 10 second deadline".into());
                    }
                    // Record before writes: wgpu may submit uploads/barriers too.
                    let recording = crate::native_completion::Recording::new();
                    set_target((sample + 1) as f32);
                    queue.write_buffer(uniform, adaptive, &1i32.to_le_bytes());
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
                        device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("MuTracer path trace repair"),
                        });
                    #[allow(unused_mut)]
                    let mut injected = false;
                    #[cfg(test)]
                    {
                        let mut hook = self.gpu.recovery_test.lock().unwrap();
                        hook.submissions += 1;
                        if hook.repair_failures > 0 {
                            hook.repair_failures -= 1;
                            injected = true;
                        }
                    }
                    if !injected {
                        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                            label: Some("MuTracer path trace repair"),
                            ..Default::default()
                        });
                        pass.set_pipeline(target.pipeline.as_ref().unwrap_or(&self.pipeline));
                        for (i, group) in [
                            &self.groups[layout::group::SCENE],
                            &self.groups[layout::group::TEXTURES],
                            &target.groups[0],
                            &target.groups[1],
                        ]
                        .iter()
                        .enumerate()
                        {
                            pass.set_bind_group(i as u32, *group, &[]);
                        }
                        pass.dispatch_workgroups(
                            target.width.div_ceil(target.workgroup_size),
                            target.height.div_ceil(target.workgroup_size),
                            1,
                        );
                    }
                    queue.submit([encoder.finish()]);
                    #[allow(unused_mut)]
                    let mut batch = recording.finish();
                    #[cfg(test)]
                    if injected {
                        batch.injected_error = Some("controlled persistent repair failure".into());
                        batch.injected_kind = Some(crate::native_completion::FailureKind::Retry);
                    }
                    wait()?;
                    match batch.require_success("flight repair") {
                        Ok(()) => break,
                        Err(error) => {
                            if retries == MAX_RETRIES
                                || batch.failure_kind() == FailureKind::Unrecoverable
                            {
                                return Err(error);
                            }
                            retries += 1;
                            if batch.failure_kind() == FailureKind::SubmissionsIgnored {
                                queue.renew()?;
                                renewed = true;
                            } else if !injected {
                                let delay = Duration::from_millis(
                                    (25u64 << (retries - 1).min(6)).min(1000),
                                );
                                std::thread::sleep(
                                    delay.min(deadline.saturating_duration_since(Instant::now())),
                                );
                            }
                        }
                    }
                }
            }
            Ok(())
        })();
        // Queue writes are ordered before the next ordinary submission. Restore
        // on failure too, so subsequent targets never inherit repair state.
        queue.write_buffer(uniform, adaptive, &0i32.to_le_bytes());
        set_target(0.);
        native_log!(
            "{}",
            serde_json::json!({"nativeFlightRecovery": {
                "flight": [start, end], "retries": retries, "renewedQueue": renewed,
                "milliseconds": begun.elapsed().as_secs_f64() * 1000.,
                "reason": original.to_string(), "recovered": result.is_ok(),
                "error": result.as_ref().err().map(ToString::to_string),
            }})
        );
        result.map_err(|error| {
            crate::status::fail(
                crate::Status::ContextFailed,
                format!("{original}; flight repair failed: {error}"),
            )
        })
    }
}

/// Scratch photon grids and splats are regenerated by the normal passes at each
/// sample. Both light sums, including the pre-compose beauty sum, survive samples.
#[derive(Clone)]
pub(crate) struct CausticCheckpoint {
    pub(super) proof: Batch,
    planes: Vec<(wgpu::Buffer, Option<wgpu::Buffer>)>,
}

impl CausticCheckpoint {
    pub(super) fn capture(
        scene: &GpuScene,
        target: &Target,
        caustics: &crate::caustics::State,
        start: u32,
    ) -> Self {
        let gpu = &scene.gpu;
        let proof = crate::native_completion::Recording::new();
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Caustic flight checkpoint"),
            });
        let planes = (layout::resource::COLOR..=layout::resource::SHADOW_CATCHER)
            .map(|id| &target.buffers[&id])
            .chain(caustics.light_accumulations())
            .map(|buffer| {
                let copy = (start != 0).then(|| {
                    let copy = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("Caustic checkpoint image"),
                        size: buffer.size(),
                        usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    });
                    encoder.copy_buffer_to_buffer(buffer, 0, &copy, 0, buffer.size());
                    copy
                });
                (buffer.clone(), copy)
            })
            .collect();
        // Isolate pending camera/target uploads from the replayable sample writes.
        gpu.queue.submit([encoder.finish()]);
        Self {
            proof: proof.finish(),
            planes,
        }
    }

    fn replay(
        &self,
        scene: &GpuScene,
        target: &Target,
        start: u32,
        end: u32,
        mut kind: FailureKind,
        original: Box<dyn std::error::Error>,
    ) -> Result<()> {
        let begun = Instant::now();
        let deadline = begun + TIME_LIMIT;
        let gpu = &scene.gpu;
        let wait = || crate::query_guard::wait(scene, deadline);
        let mut attempts = 0;
        let result = (|| -> Result<()> {
            wait()?;
            self.proof.require_success("caustic checkpoint")?;
            while attempts < MAX_RETRIES && Instant::now() < deadline {
                if kind == FailureKind::SubmissionsIgnored {
                    gpu.queue.renew()?;
                }
                attempts += 1;
                let recording = crate::native_completion::Recording::new();
                let mut encoder =
                    gpu.device
                        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("Restore caustic accumulations"),
                        });
                for (buffer, copy) in &self.planes {
                    if let Some(copy) = copy {
                        encoder.copy_buffer_to_buffer(copy, 0, buffer, 0, buffer.size());
                    } else {
                        encoder.clear_buffer(buffer, 0, None);
                    }
                }
                gpu.queue.submit([encoder.finish()]);
                let restore = recording.finish();
                wait()?;
                let mut batch = restore;
                let mut sample = start;
                loop {
                    if let Err(error) = batch.require_success("caustic flight replay") {
                        kind = batch.failure_kind();
                        if kind == FailureKind::Unrecoverable || attempts == MAX_RETRIES {
                            return Err(error);
                        }
                        break;
                    }
                    if sample == end {
                        return Ok(());
                    }
                    batch = scene.dispatch_single_samples(target, sample, sample + 1, None)?;
                    wait()?;
                    sample += 1;
                }
            }
            Err("Caustic replay exceeded its bound".into())
        })();
        native_log!(
            "{}",
            serde_json::json!({"nativeFlightRecovery": {
                "flight": [start, end], "checkpoint": start, "retries": attempts,
                "reason": original.to_string(), "recovered": result.is_ok(), "caustics": true,
                "milliseconds": begun.elapsed().as_secs_f64()*1000.,
                "error": result.as_ref().err().map(ToString::to_string),
            }})
        );
        result.map_err(|e| {
            crate::status::fail(
                crate::Status::ContextFailed,
                format!("{original}; caustic checkpoint replay failed: {e}"),
            )
        })
    }
}
