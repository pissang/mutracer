//! Replay only missing whole-pixel invocations, using the megakernel's existing
//! adaptive target and per-pixel random sequence. Separate output stores are not
//! a transaction: real driver resets still require image-statistics validation.
use crate::{
    GpuScene, Result, Target, layout,
    native_completion::{Batch, FailureKind},
};
use std::time::{Duration, Instant};

const ADAPTIVE_TARGETS: usize = 26;
const TIME_LIMIT: Duration = Duration::from_secs(10);
const MAX_RETRIES: u32 = 12;

#[cfg(test)]
#[derive(Default)]
pub(crate) struct Injection {
    pub partial_sample: Option<u32>,
    pub repair_failures: u32,
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
        if target.caustics.is_some()
            || !self.gpu.queue.observed.available()
            || failed.failure_kind() == FailureKind::Unrecoverable
        {
            return Err(original);
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
