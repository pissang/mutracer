use super::*;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

struct EarlyFailure {
    status: std::sync::Mutex<Option<DenoiseFrameStatus>>,
    dropped: mpsc::Sender<(bool, std::thread::ThreadId)>,
}
impl CustomDenoiser for EarlyFailure {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::ResidentGpu
    }
    fn denoise(
        &self,
        input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        *self.status.lock().unwrap() = Some(input.resident.as_ref().unwrap().status());
        let mut commands = input.device.create_command_encoder(&Default::default());
        let buffer = input.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 16,
            usage: wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        commands.clear_buffer(&buffer, 0, None);
        input.gpu.submit([commands.finish()]);
        Err("Evaluation failed before a result was sealed".into())
    }
}
impl Drop for EarlyFailure {
    fn drop(&mut self) {
        let retired = self
            .status
            .get_mut()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_retired();
        let _ = self.dropped.send((retired, std::thread::current().id()));
    }
}
#[test]
#[ignore = "requires real GPU; run npm run native:ci:gpu"]
fn resident_custom_early_failure_keeps_filter_until_retirement_without_future_ticks() {
    let _lock = crate::abi_test_lock();
    let caller = std::thread::current().id();
    let (engine, render) =
        super::custom_gpu_tests::fixture(super::custom_gpu_tests::native_backend());
    let (dropped, receive) = mpsc::channel();
    render
        .set_custom_denoiser(
            Some(Arc::new(EarlyFailure {
                status: Default::default(),
                dropped,
            })),
            DenoiseSchedule::Converged,
        )
        .unwrap();
    assert!(render.converge(ConvergeOptions::new(2)).is_err());
    render
        .set_custom_denoiser(None, DenoiseSchedule::Converged)
        .unwrap();
    drop(render);
    drop(engine);
    let (retired, thread) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        retired,
        "foreign filter released before its early GPU work retired"
    );
    assert_ne!(thread, caller, "foreign release ran on the API caller");
}

struct Failing {
    mode: u8,
    status: mpsc::Sender<DenoiseFrameStatus>,
}
impl CustomDenoiser for Failing {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::ResidentGpu
    }
    fn denoise(
        &self,
        input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        let early_submission = input.gpu;
        let input = input.resident.unwrap();
        self.status.send(input.status()).unwrap();
        match self.mode {
            0 => {
                let wrong = input.device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: 4,
                    usage: wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                });
                input.submit([], wrong).map(DenoiseOutput::Resident)
            }
            1 => {
                let source = input.buffers.color.clone();
                let _submitted = input.submit([], source)?;
                Err("Failure after GPU submission".into())
            }
            3 | 4 => {
                let mut commands = input.device.create_command_encoder(&Default::default());
                let marker = input.device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: 16,
                    usage: wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                commands.clear_buffer(&marker, 0, None);
                let submission = if self.mode == 3 {
                    &input.gpu
                } else {
                    &early_submission
                };
                submission.submit([commands.finish()]);
                if self.mode == 4 {
                    panic!("SDK failure after early queue submission");
                }
                Err("SDK failure before sealing the output".into())
            }
            5 => {
                let scope = input.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let buffer = input.device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: 16,
                    usage: wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                let mut commands = input.device.create_command_encoder(&Default::default());
                commands.copy_buffer_to_buffer(&buffer, 0, &buffer, 0, 16);
                let invalid = commands.finish();
                assert!(pollster::block_on(scope.pop()).is_some());
                input.gpu.submit([invalid]);
                Err("Rejected command submission".into())
            }
            _ => panic!("GPU filter panic"),
        }
    }
}

#[test]
#[ignore = "requires real GPU; run npm run native:ci:gpu"]
fn resident_custom_failures_reject_frames_and_keep_original_images() {
    let _lock = crate::abi_test_lock();
    let (engine, render) =
        super::custom_gpu_tests::fixture(super::custom_gpu_tests::native_backend());
    render.converge(ConvergeOptions::new(2)).unwrap();
    let original = render.read_pixels(PixelKind::Hdr).unwrap();
    for mode in 0..6 {
        let (send, receive) = mpsc::channel();
        render
            .set_custom_denoiser(
                Some(Arc::new(Failing { mode, status: send })),
                DenoiseSchedule::Converged,
            )
            .unwrap();
        assert!(render.converge(ConvergeOptions::new(2)).is_err());
        let status = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(status.acceptance(), DenoiseAcceptance::Rejected);
        assert!(render.denoise_report().unwrap().error.is_some());
        assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), original);
        {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !status.is_retired() {
                engine.poll_device();
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
        }
    }
    render
        .set_custom_denoiser(None, DenoiseSchedule::Converged)
        .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
}

#[test]
#[ignore = "requires real GPU; run npm run native:ci:gpu"]
fn resident_custom_shared_filter_has_isolated_target_ids_and_resize_generations() {
    let _lock = crate::abi_test_lock();
    let (engine, a) = super::custom_gpu_tests::fixture(super::custom_gpu_tests::native_backend());
    let b = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            size: RenderSize::Fixed {
                width: 7,
                height: 5,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let (send, receive) = mpsc::channel();
    let filter = Arc::new(super::custom_gpu_tests::Gpu {
        transform: true,
        events: send,
    });
    a.set_custom_denoiser(Some(filter.clone()), DenoiseSchedule::Converged)
        .unwrap();
    b.set_custom_denoiser(Some(filter.clone()), DenoiseSchedule::Converged)
        .unwrap();
    a.converge(ConvergeOptions::new(2)).unwrap();
    let (a1, sa1) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    let image_a = a.read_pixels(PixelKind::Denoised).unwrap();
    b.converge(ConvergeOptions::new(2)).unwrap();
    let (b1, sb1) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_ne!(a1.target, b1.target);
    assert_ne!(a1.frame, b1.frame);
    assert_eq!(a1.device, b1.device);
    assert_eq!(sa1.acceptance(), DenoiseAcceptance::Accepted);
    assert_eq!(sb1.acceptance(), DenoiseAcceptance::Accepted);
    assert_eq!(a.read_pixels(PixelKind::Denoised).unwrap(), image_a);
    a.set_settings(RenderSettings {
        max_samples: 2,
        size: RenderSize::Fixed {
            width: 10,
            height: 7,
        },
        ..Default::default()
    })
    .unwrap();
    a.converge(ConvergeOptions::new(2)).unwrap();
    let (a2, sa2) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(a1.target, a2.target);
    assert!(a2.generation > a1.generation);
    assert_ne!(a1.frame, a2.frame);
    assert_eq!(sa2.acceptance(), DenoiseAcceptance::Accepted);
    assert_eq!(
        a.read_pixels(PixelKind::Denoised).unwrap().data.len(),
        10 * 7 * 4
    );
    assert_eq!(
        b.read_pixels(PixelKind::Denoised).unwrap().data.len(),
        7 * 5 * 4
    );
}
