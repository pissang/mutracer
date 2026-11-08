use super::*;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use super::lifecycle_tests::fixture;

struct Identity(bool);
impl CustomDenoiser for Identity {
    fn gpu_inputs(&self) -> bool {
        self.0
    }
    fn denoise(
        &self,
        input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        assert_eq!(input.normal.len(), input.color.len());
        assert_eq!(input.albedo.len(), input.color.len());
        if self.0 {
            let buffer = input.device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: (input.color.len() * 4) as u64,
                usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let mut encoder = input.device.create_command_encoder(&Default::default());
            encoder.copy_buffer_to_buffer(
                &input.buffers.as_ref().unwrap().color,
                0,
                &buffer,
                0,
                buffer.size(),
            );
            input.gpu.submit([encoder.finish()]);
            Ok(DenoiseOutput::Gpu(buffer))
        } else {
            Ok(DenoiseOutput::Cpu(input.color))
        }
    }
}

#[test]
fn custom_output_rejects_bad_lengths_and_nonfinite_values() {
    assert!(super::custom_denoise::validate(vec![0.; 4], [2, 1]).is_err());
    assert!(super::custom_denoise::validate(vec![f32::NAN; 4], [1, 1]).is_err());
    assert_eq!(
        super::custom_denoise::validate(vec![0.; 4], [1, 1]).unwrap(),
        vec![0.; 4]
    );
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn backlog_custom_cpu_and_gpu_outputs() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture();
    engine.set_scene(&crate::scene::tests::input()).unwrap();
    engine.update().unwrap();
    for gpu in [false, true] {
        render
            .set_custom_denoiser(Some(Arc::new(Identity(gpu))), DenoiseSchedule::Converged)
            .unwrap();
        render.converge(ConvergeOptions::new(2)).unwrap();
        let output = render.read_pixels(PixelKind::Denoised).unwrap();
        assert_eq!(output.data.len(), 8 * 6 * 4);
        assert!(output.data.iter().all(|v| v.is_finite()));
        assert_eq!(render.denoise_report().unwrap().backend, "custom");
    }
}

struct Held {
    entered: mpsc::Sender<CancelToken>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl CustomDenoiser for Held {
    fn denoise(
        &self,
        input: DenoiseInput,
        cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        self.entered.send(cancel).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(15))
            .unwrap();
        Ok(DenoiseOutput::Cpu(vec![42.; input.color.len()]))
    }
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn backlog_custom_cancel_clear_and_dispose_do_not_join_callbacks() {
    let _lock = crate::abi_test_lock();
    for action in [0, 1, 2, 3, 4] {
        let (engine, render) = fixture();
        engine.set_scene(&crate::scene::tests::input()).unwrap();
        engine.update().unwrap();
        if action == 3 {
            // Exercise timeout while the callback is held, after compilation and
            // target preparation. A cold shader under concurrent CI build load
            // can otherwise consume the timeout before any callback is invoked.
            render.converge(ConvergeOptions::new(1)).unwrap();
        }
        let (entered, receive) = mpsc::channel();
        let (release, released) = mpsc::channel();
        render
            .set_custom_denoiser(
                Some(Arc::new(Held {
                    entered,
                    release: Mutex::new(released),
                })),
                DenoiseSchedule::Converged,
            )
            .unwrap();
        let token = CancelToken::new();
        let cancel = token.clone();
        let other = render.clone();
        let worker = std::thread::spawn(move || {
            let mut options = ConvergeOptions::new(1);
            options.cancel = Some(cancel);
            if action == 3 {
                options.timeout_ms = 1500;
            }
            other.converge(options)
        });
        let callback_cancel = receive
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or_else(|error| {
                panic!(
                    "Callback entry failed for action {action}: {error}; converge finished: {}",
                    worker.is_finished()
                )
            });
        let started = Instant::now();
        match action {
            0 => token.cancel(),
            1 => {
                engine.clear_scene().unwrap();
                engine.update().unwrap();
            }
            2 => engine.dispose(),
            3 => {}
            _ => render
                .set_custom_denoiser(None, DenoiseSchedule::Converged)
                .unwrap(),
        }
        let result = worker.join().unwrap();
        if action == 4 {
            assert!(result.is_ok());
        } else {
            assert!(result.is_err());
        }
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(callback_cancel.is_cancelled());
        release.send(()).unwrap();
        if action == 1 {
            engine.set_scene(&crate::scene::tests::input()).unwrap();
            engine.update().unwrap();
            render
                .set_custom_denoiser(None, DenoiseSchedule::Converged)
                .unwrap();
            render.converge(ConvergeOptions::new(1)).unwrap();
            assert!(render.denoise_report().is_none());
        }
    }
}

struct Bad(u8);
impl CustomDenoiser for Bad {
    fn denoise(
        &self,
        _: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        match self.0 {
            0 => Err("filter failure".into()),
            1 => Ok(DenoiseOutput::Cpu(vec![])),
            _ => panic!("filter panic"),
        }
    }
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn backlog_filter_failures_and_finished_loop_replacement() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture();
    engine.set_scene(&crate::scene::tests::input()).unwrap();
    engine.update().unwrap();
    for failure in 0..3 {
        render
            .set_custom_denoiser(Some(Arc::new(Bad(failure))), DenoiseSchedule::Converged)
            .unwrap();
        assert_eq!(
            render.converge(ConvergeOptions::new(1)).unwrap_err().status,
            Status::Error
        );
        assert!(render.denoise_report().unwrap().error.is_some());
        assert!(engine.last_error().is_some());
        assert_eq!(render.samples(), 1); // Keep the original accumulation.
        assert_eq!(
            render.read_pixels(PixelKind::Hdr).unwrap().data.len(),
            8 * 6 * 4
        );
    }
    let mut render_loop = RenderLoop::new(&engine, RenderLoopOptions::default()).unwrap();
    render_loop.converge(ConvergeOptions::new(1)).unwrap();
    let final_render = render_loop.final_render().clone();
    final_render
        .set_settings(RenderSettings {
            max_samples: 1,
            ..Default::default()
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while render_loop.needs_tick() {
        render_loop.tick().unwrap();
        assert!(Instant::now() < deadline);
    }
    for _ in 0..2 {
        final_render
            .set_custom_denoiser(Some(Arc::new(Identity(false))), DenoiseSchedule::Converged)
            .unwrap();
        assert!(render_loop.needs_tick());
        while render_loop.needs_tick() {
            render_loop.tick().unwrap();
            assert!(Instant::now() < deadline);
        }
        assert_eq!(final_render.denoise_report().unwrap().backend, "custom");
    }
    engine.clear_scene().unwrap();
    assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Idle);
    assert!(!render_loop.needs_tick());
}
