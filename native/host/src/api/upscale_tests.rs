use super::*;
use std::sync::Arc;

fn engine(backend: Backend, size: [u32; 2]) -> Engine {
    let engine = super::aov_tests::aov_engine(backend);
    engine.display().set_size(size[0], size[1]).unwrap();
    engine
        .set_scene(&super::aov_display_tests::plane())
        .unwrap();
    engine.update().unwrap();
    engine
}
fn channel_range(pixels: &[u8]) -> [[u8; 2]; 4] {
    std::array::from_fn(|c| {
        let values = pixels.chunks_exact(4).map(|p| p[c]);
        [values.clone().min().unwrap(), values.max().unwrap()]
    })
}

fn display_aovs_and_upscale(backend: Backend) {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let engine = engine(backend, [48, 32]);
    let fixed = Render::new(
        &engine,
        RenderSettings {
            size: RenderSize::Fixed {
                width: 24,
                height: 16,
            },
            aov_resolution: AovResolution::Display,
            ..Default::default()
        },
    );
    assert_eq!(fixed.err().unwrap().status, Status::InvalidArgument);
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 8,
            bounces: 1,
            size: RenderSize::Scale(0.5),
            aovs: 1 | 8 | 16,
            aov_resolution: AovResolution::Display,
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(8)).unwrap();
    // Display AOVs follow the display size and stop at their sample cap.
    assert_eq!(render.aov_samples_rendered(), DISPLAY_AOV_SAMPLE_CAP);
    let depth = render.read_pixels(PixelKind::Depth).unwrap();
    assert_eq!([depth.width, depth.height], [48, 32]);
    assert!(
        depth
            .data
            .chunks_exact(4)
            .all(|p| (p[0] - 4.).abs() < 1e-3 && p[3] == 1.)
    );
    // Display reflectance is the resolved texture albedo: base color times
    // (1 - metalness) for diffuse, half precision.
    let diffuse = render.read_pixels(PixelKind::DiffuseAlbedo).unwrap();
    assert!(
        diffuse
            .data
            .chunks_exact(4)
            .all(|p| (p[0] - 0.8).abs() < 2e-3 && p[3] == 1.)
    );
    for kind in [
        PixelKind::Depth,
        PixelKind::DiffuseAlbedo,
        PixelKind::SpecularAlbedo,
    ] {
        let texture = render.get_aov_texture(kind).unwrap().unwrap();
        assert_eq!([texture.width(), texture.height()], [48, 32]);
    }
    assert_eq!(
        render
            .get_aov_texture(PixelKind::Position)
            .unwrap_err()
            .status,
        Status::InvalidArgument
    );

    let display = engine.display();
    let (width, height, low) = display.read_rgba8(&render).unwrap();
    assert_eq!([width, height], [24, 16]);
    let range = channel_range(&low);
    let mut images = Vec::new();
    for albedo_detail in [false, true] {
        let pass = display
            .add_upscale(EasuOptions {
                albedo_detail,
                ..Default::default()
            })
            .unwrap();
        display.present(&render).unwrap();
        let texture = display.texture().unwrap();
        assert_eq!([texture.width(), texture.height()], [48, 32]);
        let (width, height, pixels) = display.read_rgba8(&render).unwrap();
        assert_eq!([width, height], [48, 32]);
        // EASU clamps to its 2x2 input neighborhood.
        for (c, [min, max]) in channel_range(&pixels).into_iter().enumerate() {
            assert!(
                i32::from(min) + 1 >= i32::from(range[c][0])
                    && i32::from(max) <= i32::from(range[c][1]) + 1,
                "{c}"
            );
        }
        images.push(pixels);
        drop(pass);
    }
    // Uniform albedo has a compensation ratio of 1.
    assert!(
        images[0]
            .iter()
            .zip(&images[1])
            .all(|(a, b)| a.abs_diff(*b) <= 1)
    );
    assert!(engine.last_error().is_none());

    // Two display-size passes ping-pong; the copy keeps the EASU image.
    let _upscale = display.add_upscale(EasuOptions::default()).unwrap();
    let _copy = display
        .add_post_process(|ctx| {
            assert_ne!(ctx.input, ctx.output);
            assert_eq!(ctx.input.size(), ctx.output.size());
            assert_eq!([ctx.width, ctx.height], [24, 16]);
            ctx.encoder.copy_texture_to_texture(
                ctx.input.as_image_copy(),
                ctx.output.as_image_copy(),
                ctx.input.size(),
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(display.read_rgba8(&render).unwrap().2, images[0]);
    drop((_upscale, _copy));

    // An invalid size discards the whole chain and keeps the composed image.
    let invalid = display
        .add_post_process_with(
            PostProcessOptions {
                output_size: Some(Arc::new(|_, _| [0, 1])),
            },
            |_| panic!("passes after an invalid size must not run"),
        )
        .unwrap();
    assert_eq!(display.read_rgba8(&render).unwrap(), (24, 16, low.clone()));
    assert!(engine.last_error().unwrap().contains("dimensions"));
    drop(invalid);
}

/// Larger inputs are area averaged and same-size inputs copied.
fn downsample_and_copy(backend: Backend) {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let engine = engine(backend, [24, 16]);
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            bounces: 1,
            size: RenderSize::Fixed {
                width: 48,
                height: 32,
            },
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    let display = engine.display();
    let (_, _, high) = display.read_rgba8(&render).unwrap();
    let pass = display.add_upscale(EasuOptions::default()).unwrap();
    let (width, height, low) = display.read_rgba8(&render).unwrap();
    assert_eq!([width, height], [24, 16]);
    for y in 0..16 {
        for x in 0..24 {
            for c in 0..4 {
                let average = [(0, 0), (1, 0), (0, 1), (1, 1)]
                    .iter()
                    .map(|(dx, dy)| high[((2 * y + dy) * 48 + 2 * x + dx) * 4 + c] as f32)
                    .sum::<f32>()
                    / 4.;
                let value = low[(y * 24 + x) * 4 + c] as f32;
                assert!((value - average).abs() <= 1.5, "{x} {y} {c}");
            }
        }
    }
    drop(pass);
    let mut settings = render.settings().unwrap();
    settings.size = RenderSize::Fixed {
        width: 24,
        height: 16,
    };
    render.set_settings(settings).unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    let original = display.read_rgba8(&render).unwrap();
    let _pass = display.add_upscale(EasuOptions::default()).unwrap();
    assert_eq!(display.read_rgba8(&render).unwrap(), original);
}

#[test]
fn easu_options_validate_without_a_device() {
    for options in [
        EasuOptions {
            ratio_range: [0., 1.],
            ..Default::default()
        },
        EasuOptions {
            ratio_range: [1.2, 1.1],
            ..Default::default()
        },
        EasuOptions {
            depth_threshold: f32::NAN,
            ..Default::default()
        },
        EasuOptions {
            coverage_threshold: 1.5,
            ..Default::default()
        },
    ] {
        assert_eq!(
            EasuPass::new(options).err().unwrap().status,
            Status::InvalidArgument
        );
    }
    assert!(EasuPass::new(EasuOptions::default()).is_ok());
}
#[test]
#[ignore = "requires real GPU"]
fn display_aovs_and_upscale_software() {
    display_aovs_and_upscale(Backend::Software);
}
#[test]
#[ignore = "requires real hardware ray-query GPU"]
fn display_aovs_and_upscale_hardware() {
    display_aovs_and_upscale(Backend::Hardware);
}
#[test]
#[ignore = "requires real GPU"]
fn upscale_downsamples_and_copies() {
    downsample_and_copy(Backend::Software);
}

/// While display AOV pipelines compile, sampling skips them and the upscale
/// shows EASU alone; a finished render keeps refining until they are ready.
fn display_aovs_compile_off_thread(backend: Backend) {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let engine = engine(backend, [48, 32]);
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 4,
            bounces: 1,
            size: RenderSize::Scale(0.5),
            aovs: 1 | 8 | 16,
            aov_resolution: AovResolution::Display,
            ..Default::default()
        },
    )
    .unwrap();
    let display = engine.display();
    let gate = crate::aov::DISPLAY_COMPILE_GATE
        .write()
        .unwrap_or_else(|e| e.into_inner());
    let mut status = RenderStatus::Preparing;
    let started = std::time::Instant::now();
    while render.samples() < 4 || status == RenderStatus::Preparing {
        assert!(started.elapsed().as_secs() < 60, "beauty never finished");
        status = render.refine().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert_eq!(render.samples(), 4);
    assert_eq!(status, RenderStatus::Converging, "waits for display AOVs");
    assert_eq!(render.aov_samples_rendered(), 0);
    assert!(render.get_aov_texture(PixelKind::Depth).unwrap().is_none());
    let easu = display.add_upscale(EasuOptions::default()).unwrap();
    let alone = display.read_rgba8(&render).unwrap();
    drop(easu);
    let _detail = display
        .add_upscale(EasuOptions {
            albedo_detail: true,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(display.read_rgba8(&render).unwrap(), alone);
    drop(gate);
    let started = std::time::Instant::now();
    while render.refine().unwrap() != RenderStatus::Finished {
        assert!(
            started.elapsed().as_secs() < 60,
            "display AOVs never compiled"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(render.aov_samples_rendered(), DISPLAY_AOV_SAMPLE_CAP);
    let depth = render.get_aov_texture(PixelKind::Depth).unwrap().unwrap();
    assert_eq!([depth.width(), depth.height()], [48, 32]);
    assert_eq!(display.read_rgba8(&render).unwrap().0, 48);
    assert!(engine.last_error().is_none());
}
#[test]
#[ignore = "requires real GPU"]
fn display_aovs_compile_off_thread_software() {
    display_aovs_compile_off_thread(Backend::Software);
}
#[test]
#[ignore = "requires real hardware ray-query GPU"]
fn display_aovs_compile_off_thread_hardware() {
    display_aovs_compile_off_thread(Backend::Hardware);
}
