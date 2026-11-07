use super::*;
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn display_effects_real_catcher_tracks_shared_targets_and_scene_edits() {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for backend in [Backend::Software, Backend::Hardware] {
        let mut scene = crate::scene::tests::input();
        scene.extend([51u32, 1, 0, 0].into_iter().flat_map(u32::to_le_bytes));
        let set = |scene: &mut Vec<u8>, word: usize, value: u32| {
            scene[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes())
        };
        set(&mut scene, 1, 137);
        set(&mut scene, 84, 1);
        set(&mut scene, 85, 133);
        set(&mut scene, 119, 3f32.to_bits());
        set(&mut scene, 118, 0.5f32.to_bits());
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let display = engine.display();
        display.set_size(8, 8).unwrap();
        let defaults = display.settings();
        for change in [
            |s: &mut DisplaySettings| s.vignette = 1.01,
            |s: &mut DisplaySettings| s.bloom_intensity = -0.1,
            |s: &mut DisplaySettings| s.bloom_threshold = f32::NAN,
            |s: &mut DisplaySettings| s.bloom_radius = -0.01,
            |s: &mut DisplaySettings| s.shadow_catcher_color[1] = f32::INFINITY,
            |s: &mut DisplaySettings| s.shadow_catcher_alpha = 1.1,
        ] {
            let mut settings = defaults;
            change(&mut settings);
            assert_eq!(
                display.set_settings(settings).unwrap_err().status,
                Status::InvalidArgument
            );
            assert_eq!(display.settings(), defaults);
        }

        let a = Render::new(
            &engine,
            RenderSettings {
                max_samples: 8,
                ..Default::default()
            },
        )
        .unwrap();
        let b = Render::new(
            &engine,
            RenderSettings {
                max_samples: 8,
                size: RenderSize::Fixed {
                    width: 5,
                    height: 3,
                },
                ..Default::default()
            },
        )
        .unwrap();
        for (color, alpha) in [
            ([0.2f32, 0.4, 0.7], 0.),
            ([0.2, 0.4, 0.7], 1.),
            ([0.6, 0.1, 0.3], 1.),
        ] {
            for (i, v) in color.into_iter().chain([alpha]).enumerate() {
                set(&mut scene, 16 + i, v.to_bits());
            }
            engine.set_scene(&scene).unwrap();
            engine.update().unwrap();
            for render in [&a, &b] {
                render.converge(ConvergeOptions::new(8)).unwrap();
                let raw = render.read_pixels(PixelKind::Hdr).unwrap();
                for pixel in raw.data.chunks_exact(4) {
                    for (value, expected) in pixel.iter().zip([
                        color[0] * alpha,
                        color[1] * alpha,
                        color[2] * alpha,
                        alpha,
                    ]) {
                        assert!((value - expected).abs() < 0.00001, "{backend:?}: {pixel:?}");
                    }
                }
                display
                    .set_settings(DisplaySettings {
                        channel: Channel::ShadowCatcher,
                        ..Default::default()
                    })
                    .unwrap();
                let mask = display.read_rgba8(render).unwrap().2;
                assert!(
                    mask.chunks_exact(4).any(|p| p[0] > 0),
                    "{backend:?}: receiver missing"
                );
                display
                    .set_settings(DisplaySettings {
                        vignette: 0.7,
                        ..Default::default()
                    })
                    .unwrap();
                let rgba = display.read_rgba8(render).unwrap().2;
                let encode = |v: f32| {
                    if v <= 0.0031308 {
                        v * 12.92
                    } else {
                        1.055 * v.powf(1. / 2.4) - 0.055
                    }
                };
                for pixel in rgba.chunks_exact(4) {
                    for (value, expected) in pixel.iter().zip([
                        encode(color[0]) * alpha,
                        encode(color[1]) * alpha,
                        encode(color[2]) * alpha,
                        alpha,
                    ]) {
                        assert!(
                            (*value as f32 - expected * 255.).abs() < 1.1,
                            "{backend:?}: {pixel:?}"
                        );
                    }
                }
                assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), raw);
            }
        }
        // Disabling the receiver may be incremental; its old stable mask must disappear.
        set(&mut scene, 134, 0);
        engine.set_scene(&scene).unwrap();
        engine.update().unwrap();
        a.converge(ConvergeOptions::new(8)).unwrap();
        display
            .set_settings(DisplaySettings {
                channel: Channel::ShadowCatcher,
                ..Default::default()
            })
            .unwrap();
        assert!(display.read_rgba8(&a).unwrap().2.iter().all(|v| *v == 0));
        engine.dispose();
    }
}
