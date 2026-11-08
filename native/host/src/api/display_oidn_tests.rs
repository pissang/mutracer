//! Fixed-input regressions for viewer display-domain OIDN and the SDK HDR path.
use super::*;
use crate::api::{Backend, DisplaySettings, EngineOptions, PixelKind, ToneMapping};

fn fixture() -> ([u32; 2], [Vec<f32>; 3], [u32; 2]) {
    if let Some(path) = std::env::var_os("MUTRACER_OIDN_DISPLAY_INPUT") {
        let root = std::path::PathBuf::from(path);
        let images = ["hdr", "albedo", "normal"].map(|name| {
            std::fs::read(root.join(format!("{name}.f32")))
                .unwrap()
                .chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                .collect::<Vec<_>>()
        });
        assert!(images.iter().all(|v| v.len() == 827 * 767 * 4));
        return ([827, 767], images, [644, 463]);
    }
    let size = [192, 128];
    let mut color = Vec::new();
    let mut albedo = Vec::new();
    let mut normal = Vec::new();
    for y in 0..size[1] {
        for x in 0..size[0] {
            let noise = ((x * 17 + y * 31) % 13) as f32 * 0.0005;
            color.extend([0.1 + noise, 0.08 + noise, 0.06 + noise, 1.]);
            albedo.extend([0.4, 0.3, 0.2, 1.]);
            normal.extend([0., 0., 1., 1.]);
        }
    }
    let center = [128, 64];
    let at = ((center[1] * size[0] + center[0]) * 4) as usize;
    color[at..at + 3].copy_from_slice(&[1.26e21, 1.05e21, 8.26e20]);
    (size, [color, albedo, normal], center)
}
fn bright_near(pixels: &[u8], size: [u32; 2], center: [u32; 2]) -> usize {
    pixels
        .chunks_exact(4)
        .enumerate()
        .filter(|(i, p)| {
            let x = (*i as u32 % size[0]) as i32 - center[0] as i32;
            let y = (*i as u32 / size[0]) as i32 - center[1] as i32;
            x * x + y * y > 4 && x * x + y * y < 60 * 60 && p[..3].iter().all(|v| *v >= 240)
        })
        .count()
}
fn save(name: &str, pixels: &[u8], size: [u32; 2], floats: &[f32]) {
    if let Some(path) = std::env::var_os("MUTRACER_TEST_CAPTURE") {
        let root = std::path::PathBuf::from(path);
        std::fs::create_dir_all(&root).unwrap();
        let mut encoder = png::Encoder::new(
            std::fs::File::create(root.join(format!("{name}.png"))).unwrap(),
            size[0],
            size[1],
        );
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(pixels)
            .unwrap();
        std::fs::write(
            root.join(format!("{name}.f32")),
            floats
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        )
        .unwrap();
    }
}

fn install_input(render: &Render, size: [u32; 2], images: &[Vec<f32>; 3]) {
    render
        .with(|state, id| {
            let r = state.renders.get_mut(&id).unwrap();
            let (buffers, _, _) = context::denoise_buffers(r.context)
                .map_err(|e| error(Status::Error, e.to_string()))?;
            for (buffer, image) in buffers.iter().zip(images) {
                let bottom = flip_rows(image, size[0], size[1]);
                state.gpu.queue.write_buffer(
                    buffer,
                    0,
                    &bottom
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                );
            }
            r.needs_capture = true;
            assert!(capture(r)?);
            Ok(())
        })
        .unwrap();
}

fn finish_filter(render: &Render) {
    let start = std::time::Instant::now();
    while !render.denoise_current().unwrap() {
        assert!(
            start.elapsed() < Duration::from_secs(60),
            "Display denoise timeout"
        );
        assert!(
            render.denoise_report().is_none_or(|r| r.error.is_none()),
            "{:?}",
            render.denoise_report()
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
#[ignore = "requires real GPU inference with oidn-webgpu-native"]
fn viewer_display_oidn_contains_firefly_spread_and_preserves_sdk_hdr() {
    let _test = crate::abi_test_lock();
    let (size, images, center) = fixture();
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    engine.display().set_size(size[0], size[1]).unwrap();
    engine.set_scene(&crate::api::tests::lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Fixed {
                width: size[0],
                height: size[1],
            },
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    // Both paths consume these exact same immutable means. No resampling or clamp
    // can make this regression pass by removing the outlier from the accumulator.
    install_input(&render, size, &images);
    let raw = render.read_pixels(PixelKind::Hdr).unwrap().data;
    assert_eq!(raw, images[0]);
    let raw_guides =
        [PixelKind::Albedo, PixelKind::Normal].map(|k| render.read_pixels(k).unwrap().data);
    let options = DenoiserOptions {
        backend: DENOISE_OIDN_WEBGPU,
        max_tile_size: 512,
        ..Default::default()
    };
    render.set_denoiser(Some(options.clone())).unwrap();
    finish_filter(&render);
    let hdr_filtered = render.read_pixels(PixelKind::Denoised).unwrap().data;
    let before = engine.display().read_rgba8(&render).unwrap().2;
    save("before-hdr-oidn", &before, size, &hdr_filtered);
    render
        .set_denoiser_domain(Some(options.clone()), true)
        .unwrap();
    finish_filter(&render);
    let display_filtered = render.read_pixels(PixelKind::Denoised).unwrap().data;
    let after = engine.display().read_rgba8(&render).unwrap().2;
    save("after-display-oidn", &after, size, &display_filtered);
    let counts = [
        bright_near(&before, size, center),
        bright_near(&after, size, center),
    ];
    eprintln!(
        "Same-input bright neighbourhood pixels: HDR={} display={}",
        counts[0], counts[1]
    );
    assert!(
        counts[0] > 100,
        "Fixture did not reproduce a spread-out HDR blotch: {counts:?}"
    );
    assert!(
        counts[1] * 20 < counts[0],
        "Display OIDN spread remains: {counts:?}"
    );
    assert!(
        display_filtered
            .iter()
            .all(|v| v.is_finite() && *v >= 0. && *v < 4.)
    );
    assert!(hdr_filtered.iter().any(|v| *v > 1e6));
    assert_eq!(raw, render.read_pixels(PixelKind::Hdr).unwrap().data);
    assert_eq!(render.samples(), 1);
    for (kind, guide) in [PixelKind::Albedo, PixelKind::Normal]
        .into_iter()
        .zip(&raw_guides)
    {
        assert_eq!(*guide, render.read_pixels(kind).unwrap().data);
    }
    // The displayed output encodes the filtered display-linear image once.
    for (pixel, value) in after.chunks_exact(4).zip(display_filtered.chunks_exact(4)) {
        assert_eq!(pixel[3], (value[3] * 255.).round() as u8);
        for c in 0..3 {
            let x = value[c].max(0.);
            let encoded = if x <= 0.0031308 {
                x * 12.92
            } else {
                1.055 * x.powf(1. / 2.4) - 0.055
            };
            assert!(
                (i32::from(pixel[c]) - (encoded.clamp(0., 1.) * 255.).round() as i32).abs() <= 1
            );
        }
    }
    // Color controls invalidate only display-domain inference, without tracing.
    let changed = DisplaySettings {
        tone_mapping: ToneMapping::Reinhard,
        tone_mapping_exposure: 0.4,
        ..Default::default()
    };
    engine.display().set_settings(changed).unwrap();
    assert!(render.denoise_report().is_none());
    finish_filter(&render);
    assert_ne!(
        display_filtered,
        render.read_pixels(PixelKind::Denoised).unwrap().data
    );
    assert_eq!(raw, render.read_pixels(PixelKind::Hdr).unwrap().data);
    assert_eq!(render.samples(), 1);
    // Switching back to the unchanged SDK API returns the same HDR result.
    render.set_denoiser(Some(options)).unwrap();
    finish_filter(&render);
    assert_eq!(
        hdr_filtered,
        render.read_pixels(PixelKind::Denoised).unwrap().data
    );
    if let Some(path) = std::env::var_os("MUTRACER_TEST_CAPTURE") {
        let result = serde_json::json!({"passed":true,"size":size,"outlier":center,"brightNeighbourhoodPixels":{"before":counts[0],"after":counts[1]},"rawHdrAndGuidesUnchanged":true,"sdkHdrUnchanged":true});
        std::fs::write(
            std::path::PathBuf::from(path).join("comparison.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
    }
}

#[test]
#[ignore = "requires real GPU inference with oidn-webgpu-native"]
fn viewer_display_oidn_models_keep_alpha_and_reject_stale_color_settings() {
    let _test = crate::abi_test_lock();
    let size = [65, 33];
    let images: [Vec<f32>; 3] = std::array::from_fn(|kind| {
        (0..size[0] * size[1])
            .flat_map(|i| match kind {
                0 => [0.2, 0.1, 0.05, [0., 0.25, 0.5, 1.][i as usize % 4]],
                1 => [0.4, 0.3, 0.2, 1.],
                _ => [0., 0., 1., 1.],
            })
            .collect()
    });
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    engine.display().set_size(size[0], size[1]).unwrap();
    engine.set_scene(&crate::api::tests::lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Fixed {
                width: size[0],
                height: size[1],
            },
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    install_input(&render, size, &images);
    let raw = render.read_pixels(PixelKind::Hdr).unwrap().data;
    let weights = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../oidn/weights");
    for (index, name) in [
        None,
        Some("rt_hdr_alb_nrm_small.tza"),
        Some("rt_hdr_calb_cnrm_large.tza"),
    ]
    .into_iter()
    .enumerate()
    {
        render
            .set_denoiser_domain(
                Some(DenoiserOptions {
                    backend: DENOISE_OIDN_WEBGPU,
                    library: name.map(|n| weights.join(n)),
                    max_tile_size: if index == 1 { 16 } else { 512 },
                    ..Default::default()
                }),
                true,
            )
            .unwrap();
        assert!(!render.denoise_current().unwrap());
        assert!(
            render
                .with(|s, id| Ok(s.renders[&id].denoise.worker.is_some()))
                .unwrap()
        );
        // Multiple color edits keep one job pending and reject its old settings stamp.
        for exposure in [0.5, 2.] {
            engine
                .display()
                .set_settings(DisplaySettings {
                    tone_mapping_exposure: exposure,
                    ..Default::default()
                })
                .unwrap();
            assert!(
                render
                    .with(|s, id| Ok(s.renders[&id].denoise.worker.is_some()))
                    .unwrap()
            );
        }
        finish_filter(&render);
        render
            .with(|s, id| {
                let Some((_, DenoisedImage::DisplayGpu { settings, .. })) =
                    &s.renders[&id].denoise.denoised
                else {
                    panic!("Missing display output");
                };
                assert!(*settings == s.display.settings.composition());
                Ok(())
            })
            .unwrap();
        let output = render.read_pixels(PixelKind::Denoised).unwrap().data;
        assert!(output.iter().all(|v| v.is_finite() && *v >= 0. && *v < 4.));
        for (a, b) in output.chunks_exact(4).zip(images[0].chunks_exact(4)) {
            assert_eq!(a[3], b[3]);
        }
        let png = engine.display().read_rgba8(&render).unwrap().2;
        for (pixel, source) in png.chunks_exact(4).zip(images[0].chunks_exact(4)) {
            assert_eq!(pixel[3], (source[3] * 255.).round() as u8);
            if pixel[3] == 0 {
                assert_eq!(&pixel[..3], &[0, 0, 0]);
            }
        }
        assert_eq!(raw, render.read_pixels(PixelKind::Hdr).unwrap().data);
        assert_eq!(render.samples(), 1);
        engine
            .display()
            .set_settings(DisplaySettings::default())
            .unwrap();
    }
}
