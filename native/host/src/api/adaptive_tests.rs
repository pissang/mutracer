//! Adaptive timing through asynchronous filter completion.
use super::*;
use crate::api::{Backend, PixelKind, tests::*};
#[test]
#[ignore = "requires real GPU"]
fn adaptive_preview_includes_filter_latency_before_the_next_camera() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let engine = super::super::aov_tests::aov_engine(Backend::Software);
    engine.display().set_size(64, 48).unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Scale(0.5),
            adaptive_resolution: Some(super::super::AdaptiveResolution {
                target_frame_ms: 80.,
                min_scale: 0.125,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while render.samples() == 0 {
        render.refine().unwrap();
        // Use a controlled start time without sleeping or relying on GPU
        // speed. The completed trace itself is reported as a fast 1 ms.
        render
            .with(|state, id| {
                if let Some(flight) = state.renders.get_mut(&id).unwrap().job.as_mut() {
                    flight.started = Instant::now() - Duration::from_millis(320);
                }
                Ok(())
            })
            .unwrap();
        while !render.collect().unwrap() {
            assert!(Instant::now() < deadline);
        }
        assert!(Instant::now() < deadline);
    }
    let pixels = render.read_pixels(PixelKind::Hdr).unwrap();
    let (send, receive) = mpsc::channel();
    render
        .with(|state, id| {
            let r = state.renders.get_mut(&id).unwrap();
            r.adaptive.frame.as_mut().unwrap().elapsed_ms = 1.;
            r.denoise.options = Some(DenoiserOptions {
                backend: crate::oidn_webgpu::BACKEND,
                schedule: DenoiseSchedule::EverySample,
                ..Default::default()
            });
            r.denoise.worker = Some((1, receive));
            Ok(())
        })
        .unwrap();
    // Inference owns this pose: neither the image nor its scale may change.
    render.refine().unwrap();
    assert!(render.denoising());
    assert_eq!((render.width(), render.height()), (32, 24));
    // Exercise the same queue-completion collection path as oidn-webgpu.
    send.send((
        Ok(DenoisedImage::Cpu(pixels.data, None)),
        "controlled-filter".into(),
        319.,
    ))
    .unwrap();
    assert!(render.denoise_current().unwrap());
    assert_eq!(render.denoise_report().unwrap().samples, 1);
    engine.display().present(&render).unwrap().unwrap();
    let mut camera = super::super::Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] += 0.1;
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    assert!(
        render.width() <= 16 && render.width() >= 8,
        "fast tracing hid slow inference: {}",
        render.width()
    );
}

#[test]
#[ignore = "requires real GPU"]
fn adaptive_oidn_feedback_waits_for_gpu_completion_and_excludes_later_idle() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let engine = super::super::aov_tests::aov_engine(Backend::Software);
    engine.display().set_size(512, 384).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            ..super::super::RenderLoop::preview_settings()
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while render.samples() == 0 {
        render.refine().unwrap();
        while !render.collect().unwrap() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(Instant::now() < deadline);
    }
    let original = render.read_pixels(PixelKind::Hdr).unwrap().data;
    let trace_ms = render
        .with(|state, id| {
            Ok(state.renders[&id]
                .adaptive
                .frame
                .as_ref()
                .unwrap()
                .elapsed_ms)
        })
        .unwrap();
    render
        .set_denoiser(Some(DenoiserOptions {
            backend: crate::oidn_webgpu::BACKEND,
            library: Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../oidn/weights/rt_hdr_alb_nrm_small.tza"),
            ),
            schedule: DenoiseSchedule::EverySample,
            ..Default::default()
        }))
        .unwrap();
    while !render.denoise_current().unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let report = render.denoise_report().unwrap();
    assert_eq!(report.backend, "oidn-webgpu");
    assert!(report.error.is_none());
    let feedback_ms = render
        .with(|state, id| {
            let frame = state
                .renders
                .get_mut(&id)
                .unwrap()
                .adaptive
                .frame
                .as_mut()
                .unwrap();
            let elapsed = frame.elapsed_ms;
            // Move the clock origin back after completion: later idle must not
            // be counted by another collection of the same denoised preview.
            frame.started -= Duration::from_secs(10);
            Ok(elapsed)
        })
        .unwrap();
    assert!(
        feedback_ms + 0.01 >= trace_ms + report.milliseconds,
        "feedback {feedback_ms} excluded trace {trace_ms} or inference {}",
        report.milliseconds
    );
    assert!(render.denoise_current().unwrap());
    render
        .with(|state, id| {
            assert_eq!(
                state.renders[&id]
                    .adaptive
                    .frame
                    .as_ref()
                    .unwrap()
                    .elapsed_ms,
                feedback_ms
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap().data, original);
    assert!(
        render
            .read_pixels(PixelKind::Denoised)
            .unwrap()
            .data
            .iter()
            .all(|v| v.is_finite())
    );
    println!(
        "small OIDN: trace={trace_ms:.3} ms, inference={:.3} ms, adaptive frame={feedback_ms:.3} ms",
        report.milliseconds
    );
}
