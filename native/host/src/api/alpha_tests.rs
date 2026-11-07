use super::tests::{assert_bytes, expected_descriptor, images, lit_scene, oracle};
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};

fn set(bytes: &mut [u8], word: usize, value: u32) {
    bytes[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
fn properties(bytes: &mut Vec<u8>, material: usize, entries: &[[u32; 4]]) {
    set(bytes, material + 19, entries.len() as u32);
    let offset = bytes.len() as u32 / 4;
    set(bytes, material + 20, offset);
    bytes.extend(entries.iter().flatten().flat_map(|v| v.to_le_bytes()));
    let length = bytes.len() as u32 / 4;
    set(bytes, 1, length);
}
fn scene(spectral: bool) -> Vec<u8> {
    let mut bytes = lit_scene();
    // Two large quads: an opaque back at z=0 and a .25-coverage front at z=1.
    for (mesh, z) in [(44, 0f32), (65, 1.)] {
        for k in [0, 5] {
            set(&mut bytes, mesh + 4 + k, 20f32.to_bits());
        }
        set(&mut bytes, mesh + 4 + 10, 1f32.to_bits());
        set(&mut bytes, mesh + 4 + 12, 0);
        set(&mut bytes, mesh + 4 + 13, 0);
        set(&mut bytes, mesh + 4 + 14, z.to_bits());
    }
    for (material, color) in [(86, [0.1f32, 0.3, 0.8]), (110, [0.8, 0.2, 0.1])] {
        for (i, v) in color.into_iter().enumerate() {
            set(&mut bytes, material + i, v.to_bits());
            set(&mut bytes, material + 7 + i, v.to_bits());
        }
        set(&mut bytes, material + 10, 1f32.to_bits());
    }
    set(&mut bytes, 123, 0.25f32.to_bits());
    properties(
        &mut bytes,
        86,
        &[
            [52, 1, 0, 0],
            [15, f32::from(spectral).to_bits(), 0, 0],
            [10, f32::from(spectral).to_bits(), 0, 0],
        ],
    );
    properties(
        &mut bytes,
        110,
        &[[52, 1, 0, 0], [41, 3, 0, 0], [42, 0.5f32.to_bits(), 0, 0]],
    );
    bytes
}
#[track_caller]
fn color(render: &Render, expected: [f32; 4]) {
    for pixel in render
        .read_pixels(PixelKind::Hdr)
        .unwrap()
        .data
        .chunks_exact(4)
    {
        for (v, e) in pixel.iter().zip(expected) {
            assert!((v - e).abs() < 0.00001, "{pixel:?} vs {expected:?}");
        }
    }
}
// Fresh independent L0 scene plus a target with the requested strategy. L0's
// public settings remain unchanged; the strategy belongs to upper-level targets.
fn fresh(
    scene: &[u8],
    settings: &RenderSettings,
    samples: u32,
    gpu: crate::GpuDevice,
) -> [Vec<f32>; 3] {
    let input = expected_descriptor(scene, [8, 6], settings.quality(), None);
    let camera = &input[162 * 4..194 * 4].try_into().unwrap();
    let owner = crate::context::create_with_gpu(gpu.clone(), 0).unwrap();
    let target = crate::context::create_with_gpu(gpu, 0).unwrap();
    let l0settings = settings.l0(settings.sample_cap(samples), 0);
    unsafe {
        super::test_support::l0_blocking(|e, n| {
            crate::context::mt_context_commit_with_settings(
                owner,
                input.as_ptr(),
                input.len(),
                &l0settings,
                e,
                n,
            )
        })
        .unwrap();
    }
    super::context_blocking(|| {
        crate::context::set_target(
            target,
            owner,
            &l0settings,
            [8, 6],
            settings.quality(),
            settings.alpha_blend_strategy as u32,
            camera,
        )
    })
    .unwrap();
    let mut job = 0;
    unsafe {
        super::test_support::l0_blocking(|e, n| {
            crate::context::mt_context_submit(target, samples, &mut job, e, n)
        })
        .unwrap();
    }
    let mut info = crate::context::JobInfo {
        struct_size: std::mem::size_of::<crate::context::JobInfo>() as u32,
        state: 0,
        requested_samples: 0,
        submitted_samples: 0,
        completed_samples: 0,
        base_samples: 0,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        unsafe {
            super::test_support::l0_blocking(|e, n| crate::context::mt_job_poll(job, 64, e, n))
                .unwrap();
            super::test_support::l0_blocking(|e, n| {
                crate::context::mt_job_info(job, &mut info, e, n)
            })
            .unwrap();
        }
        if info.state == 2 {
            break;
        }
        assert!(info.state < 2 && std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_micros(100));
    }
    let result = super::tests::context_images(target, [8, 6]);
    for handle in [target, owner] {
        unsafe {
            super::test_support::l0_blocking(|e, n| {
                crate::context::mt_context_destroy(handle, e, n)
            })
            .unwrap();
        }
    }
    result
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn alpha_strategies_split_primary_coverage_and_keep_shared_targets_independent() {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let front = [0.8f32, 0.2, 0.1, 1.];
    let back = [0.1f32, 0.3, 0.8, 1.];
    let mixed = std::array::from_fn(|i| back[i] * 0.75 + front[i] * 0.25);
    for backend in [Backend::Software, Backend::Hardware] {
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let preparations = Arc::new(AtomicU32::new(0));
        let count = preparations.clone();
        let _events = engine.on(move |event| {
            if matches!(event, EngineEvent::Progress {progress, ..} if *progress == 0.) {
                count.fetch_add(1, Ordering::Relaxed);
            }
        });
        let settings = RenderSettings {
            size: RenderSize::Fixed {
                width: 8,
                height: 6,
            },
            max_samples: 8,
            ..Default::default()
        };
        let stochastic = Render::new(&engine, settings.clone()).unwrap();
        let mut deterministic = settings.clone();
        deterministic.alpha_blend_strategy = AlphaBlendStrategy::DeterministicSourceOver;
        let blended = Render::new(&engine, deterministic.clone()).unwrap();
        let mut input = scene(false);
        engine.set_scene(&input).unwrap();
        engine.update().unwrap();
        stochastic.converge(ConvergeOptions::new(1)).unwrap();
        assert_eq!(stochastic.backend().unwrap().0, backend);
        let untouched = images(&stochastic);
        let prepared = preparations.load(Ordering::Relaxed);
        blended.converge(ConvergeOptions::new(1)).unwrap();
        color(&blended, mixed);
        assert_ne!(untouched[0], images(&blended)[0]);
        assert_bytes(
            &images(&stochastic),
            &untouched,
            "other target must stay unchanged",
        );
        assert_eq!(stochastic.samples(), 1);
        assert_eq!(preparations.load(Ordering::Relaxed), prepared);
        if backend == Backend::Software {
            let expected = expected_descriptor(&input, [8, 6], settings.quality(), None);
            assert_bytes(
                &untouched,
                &oracle(0, &expected, &settings.l0(4096, 0), 1),
                "default stochastic stays L0 identical",
            );
            assert_bytes(
                &images(&blended),
                &fresh(&input, &deterministic, 1, engine.inner.gpu.clone()),
                "deterministic fresh L0 target",
            );
        }
        // A policy edit restarts only this accumulation, and switching back
        // recovers the original random stream rather than keeping mixed pixels.
        blended.set_settings(settings.clone()).unwrap();
        engine.update().unwrap();
        assert_eq!(blended.samples(), 0);
        assert_eq!(stochastic.samples(), 1);
        blended.converge(ConvergeOptions::new(1)).unwrap();
        assert_bytes(
            &images(&blended),
            &untouched,
            "switching back to stochastic",
        );
        blended.set_settings(deterministic.clone()).unwrap();
        blended.converge(ConvergeOptions::new(2)).unwrap();
        color(&blended, mixed);
        assert_eq!(preparations.load(Ordering::Relaxed), prepared);
        // The shared scene can serve both policies under every sampling pattern.
        for pattern in [SamplingPattern::Random, SamplingPattern::ZSobol] {
            let mut options = deterministic.clone();
            options.sampling_pattern = pattern;
            blended.set_settings(options).unwrap();
            blended.converge(ConvergeOptions::new(2)).unwrap();
            color(&blended, mixed);
        }
        blended.set_settings(deterministic.clone()).unwrap();
        for (coverage, expected) in [(0f32, back), (1., front)] {
            set(&mut input, 123, coverage.to_bits());
            engine.set_scene(&input).unwrap();
            engine.update().unwrap();
            blended.converge(ConvergeOptions::new(1)).unwrap();
            color(&blended, expected);
        }
        // Explicit opaque and mask modes do not become blend coverage.
        set(&mut input, 123, 0.25f32.to_bits());
        for (mode, expected) in [(1u32, front), (2, back)] {
            let properties =
                u32::from_le_bytes(input[130 * 4..131 * 4].try_into().unwrap()) as usize;
            set(&mut input, properties + 5, mode);
            engine.set_scene(&input).unwrap();
            engine.update().unwrap();
            blended.converge(ConvergeOptions::new(1)).unwrap();
            color(&blended, expected);
        }
        // Exercise the spectral integrator with both hero and three wavelengths.
        let spectral = scene(true);
        engine.set_scene(&spectral).unwrap();
        engine.update().unwrap();
        for wavelengths in [1, 3] {
            let mut options = deterministic.clone();
            options.dispersion_wavelengths = wavelengths;
            options.sampling_pattern = SamplingPattern::Random;
            blended.set_settings(options.clone()).unwrap();
            blended.converge(ConvergeOptions::new(3)).unwrap();
            let pixels = images(&blended);
            assert!(pixels.iter().flatten().all(|v| v.is_finite()));
            if backend == Backend::Software {
                assert_bytes(
                    &pixels,
                    &fresh(&spectral, &options, 3, engine.inner.gpu.clone()),
                    "spectral fresh target",
                );
            }
        }
        engine.dispose();
    }
}
