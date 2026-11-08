use super::tests::{context_outputs, lit_scene};
use super::*;
use crate::layout::{header as h, material as m, texture as t};

fn set(scene: &mut [u8], word: usize, value: u32) {
    scene[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
fn scene(case: usize) -> Vec<u8> {
    let mut scene = lit_scene();
    let opaque = matches!(case, 1 | 2 | 3 | 5);
    for (i, v) in [0.2f32, 0.3, 0.4, f32::from(opaque)]
        .into_iter()
        .enumerate()
    {
        set(&mut scene, 16 + i, v.to_bits());
    }
    let material = u32::from_le_bytes(
        scene[h::MATERIAL_OFFSET * 4..h::MATERIAL_OFFSET * 4 + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    set(&mut scene, material + m::ROUGHNESS, 0.4f32.to_bits());
    let mut properties = vec![41u32, 3, 0, 0]; // Blend coverage, independently of path alpha.
    if case >= 4 {
        properties.extend([51, 1, 0, 0]);
    } // Real catcher receiver.
    let offset = scene.len() as u32 / 4;
    set(
        &mut scene,
        material + m::EXTENSION_COUNT,
        properties.len() as u32 / 4,
    );
    set(&mut scene, material + m::EXTENSION_OFFSET, offset);
    scene.extend(properties.into_iter().flat_map(u32::to_le_bytes));
    if case == 2 {
        let offset = scene.len() as u32 / 4;
        set(&mut scene, h::TEXTURE_COUNT, 1);
        set(&mut scene, h::TEXTURE_OFFSET, offset);
        set(&mut scene, h::BACKGROUND_TEXTURE, 1);
        let mut texture = vec![0u32; t::WORDS];
        texture[t::WIDTH] = 1;
        texture[t::HEIGHT] = 1;
        texture[t::STORAGE] = 1;
        texture[t::PIXELS] = offset + t::WORDS as u32;
        texture[t::UV_SCALE] = 1f32.to_bits();
        texture[t::UV_SCALE + 1] = 1f32.to_bits();
        scene.extend(texture.into_iter().flat_map(u32::to_le_bytes));
        scene.extend(
            [0.2f32, 0.3, 0.4, 1.]
                .into_iter()
                .flat_map(|v| v.to_le_bytes()),
        );
    }
    if case == 3 {
        set(&mut scene, h::QUALITY_FLAGS, 4);
    }
    let words = scene.len() as u32 / 4;
    set(&mut scene, 1, words);
    scene
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn l1_hdr_matches_ts_coverage_and_background_without_changing_l0() {
    let _lock = crate::abi_test_lock();
    for backend in [Backend::Software, Backend::Hardware] {
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let render = Render::new(
            &engine,
            RenderSettings {
                size: RenderSize::Fixed {
                    width: 13,
                    height: 9,
                },
                max_samples: 8,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(render.read_pixels(PixelKind::Hdr).is_err());
        for case in 0..6 {
            engine.set_scene(&scene(case)).unwrap();
            engine.update().unwrap();
            // Non-power-of-two counts also exercise the public L0 conversion.
            let samples = if case == 2 { 7 } else { 8 };
            render
                .converge(ConvergeOptions::new(samples))
                .unwrap_or_else(|error| panic!("case {case}: {error}"));
            assert_eq!(render.backend().unwrap().0, backend);
            let context = engine.lock().renders[&render.id()].context();
            let raw = context_outputs(context, [13, 9], false);
            let mut expected = raw[0].clone();
            let mut partial = false;
            for (pixel, (normal, albedo)) in expected
                .chunks_exact_mut(4)
                .zip(raw[1].chunks_exact(4).zip(raw[2].chunks_exact(4)))
            {
                let count = normal[3];
                let hits = albedo[3];
                if count <= 0. {
                    pixel.fill(0.);
                    continue;
                }
                let total = count.max(1. / samples as f32);
                let coverage = (hits / total).clamp(0., 1.);
                partial |= coverage > 0. && coverage < 1.;
                let divisor = if hits > 0. { hits } else { total };
                for channel in &mut pixel[..3] {
                    *channel /= divisor;
                    if matches!(case, 1 | 5) && coverage > 0. {
                        *channel *= coverage;
                    }
                }
                pixel[3] /= total;
            }
            if case == 0 {
                assert!(partial, "fixture needs mixed primary coverage");
            }
            let actual = render.read_pixels(PixelKind::Hdr).unwrap().data;
            assert_eq!(actual, expected, "{backend:?} background case {case}");
            assert_eq!(
                render.read_pixels(PixelKind::Denoised).unwrap().data,
                actual
            );
            assert_eq!(render.samples(), samples);
            assert_eq!(
                context_outputs(context, [13, 9], false),
                raw,
                "L0 changed after L1 readback"
            );
            if case == 0 {
                assert_ne!(
                    actual, raw[0],
                    "transparent edges must change HDR semantics"
                );
            }
            // Compare with the independently GPU-resolved WebGPU image. CPU HDR
            // restores flat-background misses; alpha is never multiplied twice.
            let texture = render.get_output_texture(OutputKind::Hdr).unwrap().unwrap();
            let gpu = crate::test_support::read_texture(&engine.inner.gpu, &texture);
            for (i, pixel) in gpu.chunks_exact(16).enumerate() {
                let mut value: [f32; 4] = std::array::from_fn(|c| {
                    f32::from_le_bytes(pixel[c * 4..c * 4 + 4].try_into().unwrap())
                });
                let coverage =
                    (raw[2][i * 4 + 3] / raw[1][i * 4 + 3].max(1. / samples as f32)).clamp(0., 1.);
                if matches!(case, 1 | 5) && coverage > 0. {
                    for c in &mut value[..3] {
                        *c *= coverage;
                    }
                }
                for (a, b) in value.iter().zip(&actual[i * 4..i * 4 + 4]) {
                    assert!(
                        (a - b).abs() <= 0.000002 * b.abs().max(1.),
                        "{backend:?} case {case}: {value:?} vs {:?}",
                        &actual[i * 4..i * 4 + 4]
                    );
                }
            }
            engine
                .display()
                .set_settings(DisplaySettings {
                    vignette: 0.7,
                    bloom_intensity: 0.2,
                    shadow_catcher_alpha: 0.3,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap().data, actual);
        }
        engine.dispose();
    }
}
