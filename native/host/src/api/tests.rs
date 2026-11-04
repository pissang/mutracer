use super::display::{Selection, select};
use super::engine::camera_offset;
use super::render::{Readiness, flip_rows};
use super::test_support::{l0, l0_blocking, status_from};
use super::*;
use crate::context;
use crate::layout::header as h;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

#[test]
fn handles_can_move_between_threads() {
    fn shared<T: Send + Sync>() {}
    shared::<Engine>();
    shared::<Render>();
    shared::<Display>();
    shared::<CancelToken>();
    fn movable<T: Send>() {}
    movable::<RenderLoop>();
}

#[test]
fn defaults_match_the_browser_library() {
    let settings = RenderSettings::default();
    assert_eq!(settings.max_samples, 2048);
    assert_eq!(settings.bounces, 3);
    assert_eq!(settings.clamping, 0.);
    assert_eq!(settings.sampling_pattern, SamplingPattern::Sobol);
    assert_eq!(
        settings.alpha_blend_strategy,
        AlphaBlendStrategy::Stochastic
    );
    assert_eq!(settings.direct_light_candidates, 4);
    assert!(settings.bevel);
    assert_eq!(settings.bevel_samples, 8);
    assert_eq!(settings.dispersion_wavelengths, 3);
    assert_eq!(settings.transmissive_output_alpha_min, 1.);
    assert_eq!(settings.time_budget_ms, 21.);
    assert!(!settings.allow_multiple_samples_per_frame);
    assert_eq!(settings.size, RenderSize::Scale(1.));
    assert_eq!(settings.seed, 12345);
    assert!(settings.validate().is_ok());
    let display = DisplaySettings::default();
    assert_eq!(display.tone_mapping, ToneMapping::Agx);
    assert_eq!(display.tone_mapping_exposure, 1.);
    assert_eq!((display.contrast, display.saturation), (1., 1.));
    assert_eq!((display.temperature, display.tint), (0., 0.));
    assert_eq!(display.channel, Channel::Final);
    assert_eq!(EngineOptions::default().backend, Backend::Hardware);
    assert_eq!(ConvergeOptions::new(9).samples_per_batch, 8);
    assert_eq!(ConvergeOptions::new(9).timeout_ms, 600_000);
    assert_eq!(
        DenoiserOptions::default().schedule,
        DenoiseSchedule::Converged
    );
}

#[test]
fn settings_validation_rejects_out_of_range_values() {
    let cases: [fn(&mut RenderSettings); 10] = [
        |s| s.max_samples = 0,
        |s| s.max_samples = 16385,
        |s| s.dispersion_wavelengths = 2,
        |s| s.clamping = -1.,
        |s| s.clamping = f64::NAN,
        |s| s.transmissive_output_alpha_min = f64::INFINITY,
        |s| s.time_budget_ms = 0.,
        |s| s.size = RenderSize::Scale(0.),
        |s| s.size = RenderSize::Scale(f64::NAN),
        |s| {
            s.size = RenderSize::Fixed {
                width: 0,
                height: 4,
            }
        },
    ];
    for (index, change) in cases.iter().enumerate() {
        let mut settings = RenderSettings::default();
        change(&mut settings);
        let failure = settings.validate().unwrap_err();
        assert_eq!(failure.status, Status::InvalidArgument, "case {index}");
    }
    // Values the shared TS core clamps are accepted as given.
    let clamped = RenderSettings {
        bounces: 99,
        direct_light_candidates: 0,
        bevel_samples: 1000,
        max_samples: 4096,
        ..Default::default()
    };
    assert!(clamped.validate().is_ok());
}

#[test]
fn settings_map_to_l0_record_quality_bits_and_size() {
    let settings = RenderSettings {
        sampling_pattern: SamplingPattern::Random,
        seed: 7,
        bounces: 5,
        direct_light_candidates: 2,
        bevel_samples: 3,
        clamping: 4.5,
        transmissive_output_alpha_min: 0.25,
        ..Default::default()
    };
    let record = settings.l0(17, 9);
    assert_eq!(record.sampling_pattern, 2);
    assert_eq!(record.seed, 7);
    assert_eq!(record.max_samples, 17);
    assert_eq!(record.sample_sequence_offset, 9);
    assert_eq!(record.bounces, 5);
    assert_eq!(record.direct_light_candidates, 2);
    assert_eq!(record.bevel_samples, 3);
    assert_eq!(record.clamping, 4.5);
    assert_eq!(record.transmissive_output_alpha_min, 0.25);
    assert_eq!(
        record.struct_size,
        crate::settings::RenderSettings::default().struct_size
    );
    assert_eq!(
        RenderSettings {
            sampling_pattern: SamplingPattern::ZSobol,
            ..Default::default()
        }
        .l0(1, 0)
        .sampling_pattern,
        1
    );
    assert_eq!(settings.quality(), 3);
    let plain = RenderSettings {
        bevel: false,
        dispersion_wavelengths: 1,
        ..Default::default()
    };
    assert_eq!(plain.quality(), 0);
    let scaled = RenderSettings {
        size: RenderSize::Scale(0.5),
        ..Default::default()
    };
    assert_eq!(scaled.resolve_size([301, 3]), [151, 2]);
    let tiny = RenderSettings {
        size: RenderSize::Scale(0.01),
        ..Default::default()
    };
    assert_eq!(tiny.resolve_size([10, 10]), [1, 1]);
    let fixed = RenderSettings {
        size: RenderSize::Fixed {
            width: 7,
            height: 5,
        },
        ..Default::default()
    };
    assert_eq!(fixed.resolve_size([300, 150]), [7, 5]);
}

fn word(bytes: &[u8], index: usize) -> u32 {
    u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap())
}
fn set_word(bytes: &mut [u8], index: usize, value: u32) {
    bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn scene_header_checks_reject_malformed_descriptors() {
    let scene = lit_scene();
    assert_eq!(camera_offset(&scene).unwrap(), 160 * 4);
    assert!(camera_offset(&scene[..64]).is_err());
    assert!(camera_offset(&scene[..scene.len() - 2]).is_err());
    let mut version = scene.clone();
    set_word(&mut version, h::VERSION, 3);
    assert!(camera_offset(&version).is_err());
    let mut outside = scene.clone();
    set_word(
        &mut outside,
        h::CAMERA_OFFSET,
        (scene.len() / 4 - 31) as u32,
    );
    let failure = camera_offset(&outside).unwrap_err();
    assert_eq!(failure.status, Status::InvalidArgument);
}

#[test]
fn camera_record_round_trips_and_matches_c_default() {
    let camera = Camera::default();
    let bytes = camera.to_bytes();
    assert_eq!(Camera::from_bytes(&bytes), Some(camera));
    assert_eq!(Camera::from_bytes(&bytes[..127]), None);
    // mt_camera_v4_default(): perspective, 45°, 0.1–1000, unit ortho box, zoom 1.
    assert_eq!(word(&bytes, 0), 0);
    assert_eq!(f32::from_bits(word(&bytes, 1)), 45.);
    assert_eq!(f32::from_bits(word(&bytes, 10)), 10.);
    assert_eq!(f32::from_bits(word(&bytes, 11)), 24.);
    assert_eq!(f32::from_bits(word(&bytes, 16)), 1.);
    assert_eq!(f32::from_bits(word(&bytes, 31)), 1.);
    let scene = lit_scene();
    let at = camera_offset(&scene).unwrap();
    let parsed = Camera::from_bytes(&scene[at..at + 128]).unwrap();
    assert_eq!(parsed.to_bytes(), scene[at..at + 128]);
}

#[test]
fn present_selection_follows_the_browser_rule() {
    let none = Readiness::default();
    let complete = Readiness {
        complete: true,
        presentable: false,
    };
    let ready = Readiness {
        complete: true,
        presentable: true,
    };
    // No fallback: the final channel needs only a complete image.
    assert_eq!(select(true, complete, None), Some(Selection::Render));
    assert_eq!(select(true, none, None), None);
    // With a fallback, the final channel waits for a presentable render.
    assert_eq!(
        select(true, complete, Some(ready)),
        Some(Selection::Fallback)
    );
    assert_eq!(select(true, ready, Some(ready)), Some(Selection::Render));
    assert_eq!(select(true, none, Some(complete)), None);
    assert_eq!(select(true, none, Some(none)), None);
    // Other channels use completeness for both.
    assert_eq!(
        select(false, complete, Some(ready)),
        Some(Selection::Render)
    );
    assert_eq!(
        select(false, none, Some(complete)),
        Some(Selection::Fallback)
    );
    assert_eq!(select(false, none, Some(none)), None);
}

#[test]
fn rows_flip_to_top_first() {
    let data: Vec<f32> = (0..2 * 3 * 4).map(|v| v as f32).collect();
    let flipped = flip_rows(&data, 2, 3);
    assert_eq!(&flipped[..8], &data[16..24]);
    assert_eq!(&flipped[8..16], &data[8..16]);
    assert_eq!(&flipped[16..], &data[..8]);
    assert_eq!(flip_rows(&flipped, 2, 3), data);
}

#[test]
fn display_settings_map_to_the_shared_composition() {
    let settings = DisplaySettings {
        tone_mapping: ToneMapping::Reinhard,
        tone_mapping_exposure: 2.,
        contrast: 1.5,
        saturation: 0.5,
        temperature: -0.25,
        tint: 0.75,
        channel: Channel::Albedo,
        ..Default::default()
    };
    let composition = settings.composition();
    assert_eq!(composition.tone_mapping, 3);
    assert_eq!(composition.output, 2);
    assert_eq!(composition.exposure, 2.);
    assert_eq!(composition.contrast, 1.5);
    assert_eq!(composition.saturation, 0.5);
    assert_eq!(composition.temperature, -0.25);
    assert_eq!(composition.tint, 0.75);
    assert!(composition.preserve_alpha);
    for (mode, code) in [
        (ToneMapping::Agx, 0),
        (ToneMapping::Aces, 1),
        (ToneMapping::Cineon, 2),
        (ToneMapping::Linear, 4),
    ] {
        let s = DisplaySettings {
            tone_mapping: mode,
            ..Default::default()
        };
        assert_eq!(s.composition().tone_mapping, code);
    }
    assert_eq!(
        DisplaySettings {
            channel: Channel::Normal,
            ..Default::default()
        }
        .composition()
        .output,
        1
    );
}

/// 16×12 lit scene: a diffuse quad, a small emissive quad and a directional light,
/// seen by an off-axis camera so rows and columns differ.
pub(super) fn lit_scene() -> Vec<u8> {
    let mut w = vec![0u32; 210];
    let f = |x: f32| x.to_bits();
    w[..15].copy_from_slice(&[4, 210, 16, 12, 1, 2, 2, 1, 0, 32, 44, 84, 132, 160, 160]);
    w[16..20].copy_from_slice(&[f(0.05), f(0.07), f(0.1), f(1.)]);
    w[32..36].copy_from_slice(&[4, 6, 192, 204]);
    for (mesh, material, transform) in [
        (
            44,
            0,
            [
                1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
            ],
        ),
        (
            64,
            1,
            [
                0.3, 0., 0., 0., 0., 0.3, 0., 0., 0., 0., 0.3, 0., 0.5, 0.4, 0.6, 1.,
            ],
        ),
    ] {
        w[mesh + 1] = material;
        for (k, v) in transform.into_iter().enumerate() {
            w[mesh + 4 + k] = f(v);
        }
    }
    for (material, base, emission, luminance) in [
        (84, [0.8, 0.6, 0.4], [0., 0., 0.], 0.),
        (108, [1., 1., 1.], [1., 0.9, 0.7], 4.),
    ] {
        for k in 0..3 {
            w[material + k] = f(base[k]);
            w[material + 7 + k] = f(emission[k]);
        }
        w[material + 3] = f(0.5);
        w[material + 6] = f(1.5);
        w[material + 10] = f(luminance);
        w[material + 13] = f(1.);
        for k in 15..19 {
            w[material + k] = u32::MAX;
        }
    }
    w[132] = 2;
    w[133..137].copy_from_slice(&[f(1.), f(1.), f(1.), f(3.)]);
    for k in [0, 5, 10, 15] {
        w[144 + k] = f(1.);
    }
    for (k, x) in [
        (1, 45.),
        (2, 0.1),
        (3, 100.),
        (4, -1.),
        (5, 1.),
        (6, -1.),
        (7, 1.),
        (8, 1.),
        (10, 10.),
        (11, 24.),
        (12, 1.),
    ] {
        w[160 + k] = f(x);
    }
    for k in [0, 5, 10, 15] {
        w[176 + k] = f(1.);
    }
    w[176 + 12] = f(0.2);
    w[176 + 13] = f(0.1);
    w[176 + 14] = f(4.);
    for (k, x) in [-1., -1., 0., 1., -1., 0., 1., 1., 0., -1., 1., 0.]
        .into_iter()
        .enumerate()
    {
        w[192 + k] = f(x);
    }
    w[204..210].copy_from_slice(&[0, 1, 2, 0, 2, 3]);
    w.into_iter().flat_map(u32::to_le_bytes).collect()
}

// ---- GPU oracle: L1 images equal a fresh L0 context given the same overridden
// descriptor and settings, byte for byte (software; fixed seed).

pub(super) fn software_engine(backend: Backend) -> Option<Engine> {
    // Native CPU CI must not turn the presence of WARP/llvmpipe into an
    // unplanned rendering run. native:ci:gpu executes these same image oracles.
    if std::env::var("MUTRACER_TEST_CPU_ONLY").as_deref() == Ok("1") {
        return None;
    }
    Engine::new(EngineOptions { backend }).ok()
}
/// The descriptor a fresh L0 context commits to reproduce a render: the scene with
/// the render's size, bevel/dispersion bits and camera.
pub(super) fn expected_descriptor(
    scene: &[u8],
    size: [u32; 2],
    quality: u32,
    camera: Option<&Camera>,
) -> Vec<u8> {
    let mut bytes = scene.to_vec();
    set_word(&mut bytes, h::WIDTH, size[0]);
    set_word(&mut bytes, h::HEIGHT, size[1]);
    let flags = word(scene, h::QUALITY_FLAGS) & 4;
    set_word(&mut bytes, h::QUALITY_FLAGS, flags | quality);
    if let Some(camera) = camera {
        let at = word(scene, h::CAMERA_OFFSET) as usize * 4;
        bytes[at..at + 128].copy_from_slice(&camera.to_bytes());
    }
    bytes
}
fn l0_check(code: i32, error: &[i8]) {
    let message: Vec<u8> = error
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    assert_eq!(code, 0, "{}", String::from_utf8_lossy(&message));
}
/// Fresh L0 accumulation with the L1 HDR conversion; top row first.
pub(super) fn oracle(
    backend: u32,
    descriptor: &[u8],
    settings: &crate::settings::RenderSettings,
    samples: u32,
) -> [Vec<f32>; 3] {
    oracle_audited(backend, descriptor, settings, samples, false).0
}
/// [`oracle`]; with `audit`, traces one sample per call and returns each sample's
/// audit when the preparation installed it.
fn oracle_audited(
    backend: u32,
    descriptor: &[u8],
    settings: &crate::settings::RenderSettings,
    samples: u32,
    audit: bool,
) -> (
    [Vec<f32>; 3],
    Vec<Option<[usize; 3]>>,
    crate::sample_audit::History,
) {
    oracle_inputs(backend, descriptor, settings, samples, audit, true)
}
fn raw_oracle(
    backend: u32,
    descriptor: &[u8],
    settings: &crate::settings::RenderSettings,
    samples: u32,
) -> [Vec<f32>; 3] {
    oracle_inputs(backend, descriptor, settings, samples, false, false).0
}
fn oracle_inputs(
    backend: u32,
    descriptor: &[u8],
    settings: &crate::settings::RenderSettings,
    samples: u32,
    audit: bool,
    resolved: bool,
) -> (
    [Vec<f32>; 3],
    Vec<Option<[usize; 3]>>,
    crate::sample_audit::History,
) {
    let mut hits = Vec::new();
    let mut error = [0i8; 1024];
    let mut handle = 0;
    unsafe {
        // A pending engine preparation can briefly publish under REGISTRY while
        // this fresh oracle is created or committed. Retry only L0 Busy, as L1
        // callers do; publication can race either registry acquisition.
        l0_blocking(|e, n| context::mt_context_create_with_backend(backend, &mut handle, e, n))
            .unwrap();
        l0_blocking(|e, n| {
            context::mt_context_commit_with_settings(
                handle,
                descriptor.as_ptr(),
                descriptor.len(),
                settings,
                e,
                n,
            )
        })
        .unwrap();
        if audit {
            for sample in 0..samples {
                l0_check(
                    context::mt_context_render(handle, 1, error.as_mut_ptr(), error.len()),
                    &error,
                );
                hits.push(context::audit_sample(handle, sample));
            }
        } else {
            l0_check(
                context::mt_context_render(handle, samples, error.as_mut_ptr(), error.len()),
                &error,
            );
        }
    }
    let size = [word(descriptor, h::WIDTH), word(descriptor, h::HEIGHT)];
    let images = context_outputs(handle, size, resolved);
    let history = if context::AUDIT_HISTORY_SAMPLES.load(std::sync::atomic::Ordering::Relaxed) > 0 {
        assert_hardware_context(handle);
        context::audit_history(handle, samples)
    } else {
        Default::default()
    };
    unsafe {
        l0_check(
            context::mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
            &error,
        );
    }
    (images, hits, history)
}
fn assert_hardware_context(handle: u64) {
    let mut backend = 0;
    let mut reason = [0; 1024];
    l0(|e, n| unsafe {
        context::mt_context_backend(
            handle,
            &mut backend,
            reason.as_mut_ptr(),
            reason.len(),
            e,
            n,
        )
    })
    .unwrap();
    assert_eq!(backend, 1, "HWRT test fell back to software: {reason:?}");
}
pub(super) fn context_images(handle: u64, size: [u32; 2]) -> [Vec<f32>; 3] {
    context_outputs(handle, size, true)
}
pub(super) fn context_outputs(handle: u64, size: [u32; 2], resolved: bool) -> [Vec<f32>; 3] {
    let mut error = [0i8; 1024];
    [0, 1, 2].map(|kind| {
        if kind == 0 && resolved {
            let pixels = context_blocking(|| context::read_hdr(handle)).unwrap();
            return flip_rows(&pixels, size[0], size[1]);
        }
        let mut bytes = vec![0u8; size[0] as usize * size[1] as usize * 16];
        let mut written = 0;
        unsafe {
            l0_check(
                context::mt_context_read_pixels(
                    handle,
                    kind,
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut written,
                    error.as_mut_ptr(),
                    error.len(),
                ),
                &error,
            );
        }
        let data: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        flip_rows(&data, size[0], size[1])
    })
}
pub(super) fn images(render: &Render) -> [Vec<f32>; 3] {
    [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo]
        .map(|kind| render.read_pixels(kind).unwrap().data)
}
pub(super) fn assert_bytes(actual: &[Vec<f32>; 3], expected: &[Vec<f32>; 3], what: &str) {
    for (kind, (a, b)) in ["hdr", "normal", "albedo"]
        .iter()
        .zip(actual.iter().zip(expected))
    {
        assert_eq!(a.len(), b.len(), "{what}: {kind} length");
        let first = a
            .iter()
            .zip(b)
            .position(|(x, y)| x.to_bits() != y.to_bits());
        assert!(
            first.is_none(),
            "{what}: {kind} differs at float {first:?}: {:?} vs {:?}",
            first.map(|i| a[i]),
            first.map(|i| b[i])
        );
    }
}
pub(super) fn finish(render: &Render) -> RenderStatus {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let status = render.refine().unwrap();
        if matches!(status, RenderStatus::Finished | RenderStatus::Error) {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "render did not finish: {status:?}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
/// `last_commit` of the engine's shared scene context.
fn last_commit(render: &Render) -> u32 {
    let handle = render.engine().lock().shared.context().unwrap();
    let mut info = context::ContextInfo {
        struct_size: std::mem::size_of::<context::ContextInfo>() as u32,
        width: 0,
        height: 0,
        samples: 0,
        state: 0,
        last_commit: 0,
    };
    let mut error = [0i8; 256];
    unsafe {
        l0_check(
            context::mt_context_info(handle, &mut info, error.as_mut_ptr(), error.len()),
            &error,
        );
    }
    info.last_commit
}

fn primary_oracle(backend: Backend) -> Option<Vec<String>> {
    let engine = software_engine(backend)?;
    let code = backend.code();
    let mut notes = Vec::new();
    let display = engine.display();
    display.set_size(16, 12).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = events.clone();
    let _subscription = engine.on(move |event| recorded.lock().unwrap().push(event.clone()));
    let first = RenderSettings {
        max_samples: 6,
        allow_multiple_samples_per_frame: true,
        ..Default::default()
    };
    let second = RenderSettings {
        max_samples: 5,
        bevel: false,
        dispersion_wavelengths: 1,
        sampling_pattern: SamplingPattern::ZSobol,
        seed: 7,
        direct_light_candidates: 2,
        bounces: 4,
        size: RenderSize::Fixed {
            width: 10,
            height: 7,
        },
        ..Default::default()
    };
    let a = Render::new(&engine, first.clone()).unwrap();
    let b = Render::new(&engine, second.clone()).unwrap();
    assert_eq!(a.status(), RenderStatus::Idle);
    assert_eq!(a.refine().unwrap(), RenderStatus::Idle);
    assert!(display.present(&a).unwrap().is_none());
    let samples = Arc::new(Mutex::new(Vec::new()));
    let seen = samples.clone();
    let _sample_subscription = a.on_sample(move |event| seen.lock().unwrap().push(*event));

    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    assert!(engine.update().unwrap());
    assert!(!engine.update().unwrap());
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_eq!(finish(&b), RenderStatus::Finished);
    assert_eq!((a.samples(), b.samples()), (6, 5));
    assert!(a.converged());
    assert_eq!(
        (a.width(), a.height(), b.width(), b.height()),
        (16, 12, 10, 7)
    );
    let sample_events = samples.lock().unwrap().clone();
    assert_eq!(sample_events.last().unwrap().samples, 6);
    assert!(sample_events[0].is_first_frame && !sample_events.last().unwrap().is_first_frame);
    notes.push(format!(
        "sample batches of render A: {:?}",
        sample_events.iter().map(|e| e.samples).collect::<Vec<_>>()
    ));
    let expected_a = oracle(
        code,
        &expected_descriptor(&scene, [16, 12], 3, None),
        &first.l0(6, 0),
        6,
    );
    let actual_a = images(&a);
    assert!(
        actual_a[0].chunks(4).any(|p| p[0] != actual_a[0][0]),
        "test scene renders a uniform image"
    );
    assert_bytes(&actual_a, &expected_a, "render A");
    assert_bytes(
        &images(&b),
        &oracle(
            code,
            &expected_descriptor(&scene, [10, 7], 0, None),
            &second.l0(5, 0),
            5,
        ),
        "render B",
    );
    notes.push(
        "multiple renders: A (scale, multi-sample batches) and B (fixed, other settings) exact"
            .into(),
    );
    // Row order: L1 row 0 is L0's last row.
    let hdr = a.read_pixels(PixelKind::Hdr).unwrap();
    let row = 16 * 4;
    assert_eq!((hdr.width, hdr.height), (16, 12));
    let bottom_first = flip_rows(&expected_a[0], 16, 12);
    assert_ne!(hdr.data, bottom_first, "test image is vertically symmetric");
    for y in 0..12 {
        assert_eq!(
            hdr.data[y * row..(y + 1) * row],
            bottom_first[(11 - y) * row..(12 - y) * row]
        );
    }

    // Display: present and export the same composition as the existing display path.
    let presented = display.present(&a).unwrap().unwrap();
    assert_eq!(
        presented,
        Presented {
            fallback: false,
            width: 16,
            height: 12,
            samples: 6
        }
    );
    let texture = display.texture().unwrap();
    assert_eq!((texture.width(), texture.height()), (16, 12));
    let (width, height, rgba) = display.read_rgba8(&a).unwrap();
    assert_eq!((width, height), (16, 12));
    let mut reference = None;
    let mut error = [0i8; 512];
    let mut handle = 0;
    let descriptor = expected_descriptor(&scene, [16, 12], 3, None);
    unsafe {
        l0_check(
            context::mt_context_create_with_backend(code, &mut handle, error.as_mut_ptr(), 512),
            &error,
        );
        l0_check(
            context::mt_context_commit_with_settings(
                handle,
                descriptor.as_ptr(),
                descriptor.len(),
                &first.l0(6, 0),
                error.as_mut_ptr(),
                512,
            ),
            &error,
        );
        l0_check(
            context::mt_context_render(handle, 6, error.as_mut_ptr(), 512),
            &error,
        );
    }
    assert!(context::capture_display(handle, &mut reference).unwrap());
    let composition = display.settings().composition();
    assert_eq!(
        reference.as_ref().unwrap().read_rgba(&composition).unwrap(),
        rgba
    );
    unsafe {
        l0_check(
            context::mt_context_destroy(handle, error.as_mut_ptr(), 512),
            &error,
        );
    }
    let png = display.encode_png(&a).unwrap();
    assert_eq!(&png[1..4], b"PNG");
    // Linear scaling to a larger display; B is smaller than the display.
    assert!(display.present(&b).unwrap().is_some());
    notes.push("display read_rgba8 equals display.rs composition of a fresh L0 capture".into());

    // Incremental material edit: synchronous in update, then exact.
    let mut edited = scene.clone();
    set_word(&mut edited, 84 + 1, 0.2f32.to_bits());
    engine.set_scene(&edited).unwrap();
    assert!(engine.update().unwrap());
    assert_eq!(last_commit(&a), context::COMMIT_INCREMENTAL);
    assert_eq!(last_commit(&b), context::COMMIT_INCREMENTAL);
    assert_eq!(a.status(), RenderStatus::Converging);
    assert_eq!(a.samples(), 0);
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_eq!(finish(&b), RenderStatus::Finished);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [16, 12], 3, None),
            &first.l0(6, 0),
            6,
        ),
        "render A after material edit",
    );
    assert_bytes(
        &images(&b),
        &oracle(
            code,
            &expected_descriptor(&edited, [10, 7], 0, None),
            &second.l0(5, 0),
            5,
        ),
        "render B after material edit",
    );
    // Engine camera: incremental camera record replacement in every render.
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] = -0.3;
    camera.fov = 40.;
    engine.set_camera(Some(camera)).unwrap();
    assert!(engine.update().unwrap());
    assert_eq!(last_commit(&a), context::COMMIT_INCREMENTAL);
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [16, 12], 3, Some(&camera)),
            &first.l0(6, 0),
            6,
        ),
        "render A after camera edit",
    );
    notes.push("incremental material and camera edits: COMMIT_INCREMENTAL, exact".into());

    // Settings change: a new target on the same scene, without preparation.
    let changed = RenderSettings {
        max_samples: 4,
        bounces: 2,
        bevel_samples: 3,
        ..first.clone()
    };
    a.set_settings(changed.clone()).unwrap();
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_eq!(last_commit(&a), context::COMMIT_INCREMENTAL);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [16, 12], 3, Some(&camera)),
            &changed.l0(4, 0),
            4,
        ),
        "render A after settings change",
    );
    // Display resize: the scale-based render follows; the fixed render does not.
    display.set_size(20, 9).unwrap();
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_eq!((a.width(), a.height()), (20, 9));
    assert_eq!(finish(&b), RenderStatus::Finished);
    assert_eq!(b.width(), 10);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [20, 9], 3, Some(&camera)),
            &changed.l0(4, 0),
            4,
        ),
        "render A after display resize",
    );
    notes.push("settings change and display resize: target only, no preparation, exact".into());

    // Restart keeps settings and reproduces the same accumulation.
    a.restart().unwrap();
    assert_eq!(a.samples(), 0);
    assert!(display.present(&a).unwrap().is_none());
    assert_eq!(finish(&a), RenderStatus::Finished);
    assert_bytes(
        &images(&a),
        &oracle(
            code,
            &expected_descriptor(&edited, [20, 9], 3, Some(&camera)),
            &changed.l0(4, 0),
            4,
        ),
        "render A after restart",
    );
    let events = events.lock().unwrap().clone();
    assert!(events.contains(&EngineEvent::Progress {
        stage: ProgressStage::Preparation,
        progress: 1.
    }));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, EngineEvent::Error { .. })),
        "{events:?}"
    );
    Some(notes)
}

#[test]
fn renders_match_fresh_l0_contexts_across_edits_settings_and_sizes() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(notes) = primary_oracle(Backend::Software) {
        for note in notes {
            println!("software oracle: {note}");
        }
    }
}

/// Known Metal HWRT limitations make this a recorded observation, run explicitly.
#[test]
#[ignore]
fn hardware_renders_match_fresh_l0_contexts() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let engine = software_engine(Backend::Hardware).unwrap();
    assert!(engine.info().hardware_ray_query, "no hardware ray queries");
    drop(engine);
    for note in primary_oracle(Backend::Hardware).unwrap() {
        println!("hardware oracle: {note}");
    }
}

/// S2 oracle: renders with different sizes, settings and shader variants share
/// one prepared scene. Every image equals a fresh L0 context committed with the
/// render's descriptor and settings, through incremental edits of every kind,
/// full preparation, converge with a sequence offset and camera, and restart;
/// the scene is prepared exactly once per full commit whatever the render count.
fn shared_scene_oracle(backend: Backend) -> Option<Vec<String>> {
    let engine = software_engine(backend)?;
    let code = backend.code();
    let mut notes = Vec::new();
    engine.display().set_size(16, 12).unwrap();
    let preparations = Arc::new(Mutex::new(0));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let (counted, failed) = (preparations.clone(), errors.clone());
    let _events = engine.on(move |event| match event {
        EngineEvent::Progress {
            stage: ProgressStage::Preparation,
            progress,
        } if *progress == 0. => *counted.lock().unwrap() += 1,
        EngineEvent::Error { message } => failed.lock().unwrap().push(message.clone()),
        _ => {}
    });
    let settings = [
        RenderSettings {
            max_samples: 4,
            ..Default::default()
        },
        RenderSettings {
            max_samples: 3,
            bounces: 5,
            bevel: false,
            dispersion_wavelengths: 1,
            direct_light_candidates: 2,
            clamping: 2.5,
            seed: 99,
            transmissive_output_alpha_min: 0.5,
            sampling_pattern: SamplingPattern::Random,
            size: RenderSize::Fixed {
                width: 10,
                height: 7,
            },
            ..Default::default()
        },
        RenderSettings {
            max_samples: 4,
            sampling_pattern: SamplingPattern::ZSobol,
            bevel_samples: 3,
            seed: 3,
            size: RenderSize::Fixed {
                width: 12,
                height: 9,
            },
            ..Default::default()
        },
        RenderSettings {
            max_samples: 2,
            bounces: 1,
            bevel_samples: 12,
            direct_light_candidates: 8,
            size: RenderSize::Scale(0.5),
            ..Default::default()
        },
    ];
    let renders: Vec<Render> = settings
        .iter()
        .map(|s| Render::new(&engine, s.clone()).unwrap())
        .collect();
    let check = |scene: &[u8], camera: Option<&Camera>, what: &str| {
        for (index, (render, settings)) in renders.iter().zip(&settings).enumerate() {
            assert_eq!(
                finish(render),
                RenderStatus::Finished,
                "{what}: render {index}"
            );
            let size = settings.resolve_size([16, 12]);
            let cap = settings.sample_cap(settings.max_samples);
            assert_bytes(
                &images(render),
                &oracle(
                    code,
                    &expected_descriptor(scene, size, settings.quality(), camera),
                    &settings.l0(cap, 0),
                    settings.max_samples,
                ),
                &format!("{what}: render {index}"),
            );
        }
    };
    let mut scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    check(&scene, None, "first commit");
    assert_eq!(*preparations.lock().unwrap(), 1);
    assert_eq!(renders[0].last_commit().unwrap(), Some(CommitKind::Full));
    notes.push("4 renders (sizes, bounces, bevel, dispersion, candidates, clamping, seed, alpha, Random/ZSobol, bevel samples 3/12): one preparation, exact".into());

    // Incremental edits of every kind reach every target.
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] = -0.25;
    camera.fov = 38.;
    let edits: [(&str, fn(&mut Vec<u8>)); 5] = [
        ("material", |s| set_word(s, 84 + 1, 0.3f32.to_bits())),
        ("light", |s| set_word(s, 136, 5f32.to_bits())),
        ("environment", |s| set_word(s, 16, 0.3f32.to_bits())),
        ("transform", |s| set_word(s, 64 + 4 + 12, 0.2f32.to_bits())),
        ("descriptor camera", |s| {
            set_word(s, 160 + 1, 50f32.to_bits())
        }),
    ];
    let all = || renders.iter().map(images).collect::<Vec<_>>();
    for (what, edit) in edits {
        let before = all();
        edit(&mut scene);
        engine.set_scene(&scene).unwrap();
        assert!(engine.update().unwrap());
        assert_eq!(
            renders[0].last_commit().unwrap(),
            Some(CommitKind::Incremental),
            "{what}"
        );
        check(&scene, None, what);
        assert_ne!(all(), before, "{what} edit changes no image");
    }
    let before = all();
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    check(&scene, Some(&camera), "engine camera");
    assert_ne!(all(), before, "engine camera changes no image");
    assert_eq!(*preparations.lock().unwrap(), 1);
    notes.push("material, light, environment, transform, descriptor and engine camera edits: incremental, every render exact".into());

    // Settings and display size change only the targets.
    renders[0]
        .set_settings(RenderSettings {
            bevel_samples: 6,
            sampling_pattern: SamplingPattern::ZSobol,
            ..settings[0].clone()
        })
        .unwrap();
    renders[0].set_settings(settings[0].clone()).unwrap();
    engine.display().set_size(18, 10).unwrap();
    for render in &renders {
        finish(render);
    }
    assert_eq!(*preparations.lock().unwrap(), 1);
    engine.display().set_size(16, 12).unwrap();

    // Full preparation: every target follows the new scene.
    scene = full_edit(&scene);
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    check(&scene, Some(&camera), "full preparation");
    assert_eq!(*preparations.lock().unwrap(), 2);
    assert_eq!(renders[0].last_commit().unwrap(), Some(CommitKind::Full));
    notes.push("full preparation: one for all renders, exact".into());

    // Converge with a sequence offset and its own camera, without preparation.
    let mut other = camera;
    other.world_matrix[13] = 0.3;
    let mut options = ConvergeOptions::new(5);
    options.sample_sequence_offset = 7;
    options.camera = Some(other);
    options.samples_per_batch = 2;
    renders[1].converge(options).unwrap();
    assert_bytes(
        &images(&renders[1]),
        &oracle(
            code,
            &expected_descriptor(&scene, [10, 7], settings[1].quality(), Some(&other)),
            &settings[1].l0(settings[1].sample_cap(5), 7),
            5,
        ),
        "converge with offset and camera",
    );
    let mut options = ConvergeOptions::new(3);
    options.sample_sequence_offset = 2;
    renders[2].converge(options).unwrap();
    assert_bytes(
        &images(&renders[2]),
        &oracle(
            code,
            &expected_descriptor(&scene, [12, 9], settings[2].quality(), Some(&camera)),
            &settings[2].l0(settings[2].sample_cap(3), 2),
            3,
        ),
        "ZSobol converge with offset",
    );
    assert_eq!(*preparations.lock().unwrap(), 2);
    notes.push("converge with sample_sequence_offset and camera: no preparation, exact".into());

    // Restart reproduces each accumulation; other renders keep theirs.
    let kept = images(&renders[3]);
    renders[0].restart().unwrap();
    assert_eq!(renders[0].samples(), 0);
    assert_eq!(renders[3].samples(), 2);
    assert_bytes(
        &images(&renders[3]),
        &kept,
        "untouched render after restart",
    );
    check(&scene, Some(&camera), "restart");
    assert_eq!(*preparations.lock().unwrap(), 2);
    assert!(
        errors.lock().unwrap().is_empty(),
        "{:?}",
        errors.lock().unwrap()
    );
    notes.push("restart and the untouched renders after converge: exact".into());
    Some(notes)
}

#[test]
fn shared_scene_renders_match_fresh_l0_contexts() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(notes) = shared_scene_oracle(Backend::Software) {
        for note in notes {
            println!("software S2 oracle: {note}");
        }
    }
}

/// HWRT is an open problem on Metal (whole-sample misses); run explicitly.
#[test]
#[ignore]
fn hardware_shared_scene_renders_match_fresh_l0_contexts() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for note in shared_scene_oracle(Backend::Hardware).unwrap() {
        println!("hardware S2 oracle: {note}");
    }
}

#[test]
fn next_preview_scale_matches_the_browser_rule() {
    use super::render::next_preview_scale;
    // On target: kept. Four times too slow: half the scale, on the 1/16 grid.
    assert_eq!(next_preview_scale(0.5, 80., 80., 0.5, 0.5, 0.125), 0.5);
    assert_eq!(next_preview_scale(0.5, 320., 80., 0.5, 0.5, 0.125), 0.25);
    // Below 0.25 the grid is 1/128; the minimum bounds it.
    assert_eq!(
        next_preview_scale(0.25, 1000., 80., 0.5, 0.25, 0.125),
        0.125
    );
    assert_eq!(
        next_preview_scale(0.25, 200., 80., 0.5, 0.25, 0.01),
        0.15625
    );
    // Within 15% of the current scale: kept.
    assert_eq!(next_preview_scale(0.5, 75., 80., 0.5, 0.5, 0.125), 0.5);
    // Faster: up to the maximum.
    assert_eq!(next_preview_scale(0.25, 20., 80., 0.5, 0.25, 0.125), 0.5);
    assert_eq!(next_preview_scale(0.25, 1., 80., 0.5, 0.25, 0.125), 0.5);
}

#[test]
fn adaptive_preview_uses_collected_frame_before_the_next_camera_commit() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for backend in [Backend::Software, Backend::Hardware] {
        adaptive_moving_preview(backend);
    }
}

fn adaptive_moving_preview(backend: Backend) {
    let Some(engine) = software_engine(backend) else {
        return;
    };
    engine.display().set_size(64, 48).unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Scale(0.5),
            adaptive_resolution: Some(AdaptiveResolution {
                target_frame_ms: 1e-6,
                min_scale: 0.125,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    // Viewer holds each pose until collect/present completes, then commits the
    // next camera before calling refine again. No idle refine consumes timing.
    let frame = || {
        while render.samples() == 0 {
            render.refine().unwrap();
            while !render.collect().unwrap() {
                assert!(Instant::now() < deadline, "preview collection timed out");
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        assert_eq!(render.samples(), 1);
    };
    frame();
    assert_eq!((render.width(), render.height()), (32, 24));
    camera.world_matrix[12] += 0.01;
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    frame();
    assert_eq!(
        (render.width(), render.height()),
        (8, 6),
        "collected preview timing was lost on camera movement"
    );
    assert_bytes(
        &images(&render),
        &oracle(
            backend.code(),
            &expected_descriptor(&scene, [8, 6], 0, Some(&camera)),
            &RenderSettings::default().l0(1, 0),
            1,
        ),
        "adapted moving preview",
    );

    let mut settings = render.settings().unwrap();
    settings
        .adaptive_resolution
        .as_mut()
        .unwrap()
        .target_frame_ms = 1e9;
    render.set_settings(settings).unwrap();
    let mut widths = vec![8];
    for _ in 0..24 {
        camera.world_matrix[12] += 0.01;
        engine.set_camera(Some(camera)).unwrap();
        engine.update().unwrap();
        frame();
        widths.push(render.width());
    }
    assert!(
        widths.iter().any(|&w| w > 8),
        "fast moving previews never recovered: {widths:?}"
    );
    assert!(
        widths.iter().all(|&w| w <= 32),
        "exceeded preview cap: {widths:?}"
    );
    assert!(
        widths
            .windows(2)
            .all(|w| w[1] as f64 <= w[0] as f64 * 1.25 + 1.),
        "recovery jumped too far: {widths:?}"
    );
}

#[test]
fn adaptive_resolution_follows_frame_time_without_preparation() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(64, 48).unwrap();
    let invalid = |size, target, min| {
        RenderSettings {
            size,
            adaptive_resolution: Some(AdaptiveResolution {
                target_frame_ms: target,
                min_scale: min,
            }),
            ..Default::default()
        }
        .validate()
        .unwrap_err()
        .status
    };
    let fixed = RenderSize::Fixed {
        width: 4,
        height: 4,
    };
    assert_eq!(invalid(fixed, 80., 0.1), Status::InvalidArgument);
    assert_eq!(
        invalid(RenderSize::Scale(0.5), 80., 0.6),
        Status::InvalidArgument
    );
    assert_eq!(
        invalid(RenderSize::Scale(0.5), 0., 0.1),
        Status::InvalidArgument
    );
    let preparations = Arc::new(Mutex::new(0));
    let counted = preparations.clone();
    let _progress = engine.on(move |event| {
        if matches!(event, EngineEvent::Progress { stage: ProgressStage::Preparation, progress } if *progress == 0.) {
            *counted.lock().unwrap() += 1;
        }
    });
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    // An unreachable frame time shrinks the image to the minimum scale.
    let slow = RenderSettings {
        max_samples: 4096,
        size: RenderSize::Scale(0.5),
        adaptive_resolution: Some(AdaptiveResolution {
            target_frame_ms: 1e-6,
            min_scale: 0.125,
        }),
        ..Default::default()
    };
    let render = Render::new(&engine, slow.clone()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while render.width() != 8 {
        render.refine().unwrap();
        assert!(Instant::now() < deadline, "scale never reached its minimum");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!((render.width(), render.height()), (8, 6));
    // A generous frame time grows it back, at most 25% per four fast batches.
    let mut widths = vec![8];
    render
        .set_settings(RenderSettings {
            adaptive_resolution: Some(AdaptiveResolution {
                target_frame_ms: 1e9,
                min_scale: 0.125,
            }),
            ..slow.clone()
        })
        .unwrap();
    // It stops within 15% of the maximum, like the browser.
    while (render.width() as f64) < 32. / 1.15 {
        render.refine().unwrap();
        if widths.last() != Some(&render.width()) {
            widths.push(render.width());
        }
        assert!(
            Instant::now() < deadline,
            "scale never returned: {widths:?}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        widths
            .windows(2)
            .all(|w| w[1] as f64 <= w[0] as f64 * 1.25 + 1.),
        "{widths:?}"
    );
    assert_eq!(*preparations.lock().unwrap(), 1);
    // Each adapted size renders exactly like a fresh context of that size.
    render
        .set_settings(RenderSettings {
            max_samples: 3,
            adaptive_resolution: None,
            ..slow
        })
        .unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [32, 24], 3, None),
            &RenderSettings::default().l0(4096, 0),
            3,
        ),
        "after adaptation",
    );
}

#[test]
fn full_preparation_keeps_the_previous_image_and_publishes_atomically() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(16, 12).unwrap();
    let settings = RenderSettings {
        max_samples: 3,
        ..Default::default()
    };
    let small = RenderSettings {
        max_samples: 2,
        size: RenderSize::Fixed {
            width: 8,
            height: 6,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    let other = Render::new(&engine, small.clone()).unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
    assert_eq!(finish(&other), RenderStatus::Finished);
    assert!(display.present(&render).unwrap().is_some());
    let shown = display.read_rgba8(&render).unwrap();
    let before = images(&render);
    let other_before = images(&other);

    // A shader feature edit needs full preparation of the shared scene; hold it.
    let resume = hold_preparation();
    let edited = full_edit(&scene);
    engine.set_scene(&edited).unwrap();
    engine.update().unwrap();
    let changed = RenderSettings {
        bevel_samples: 4,
        ..settings.clone()
    };
    render.set_settings(changed.clone()).unwrap();
    for _ in 0..20 {
        assert_eq!(render.refine().unwrap(), RenderStatus::Preparing);
        assert_eq!(other.refine().unwrap(), RenderStatus::Preparing);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(render.samples(), 0);
    assert!(display.present(&render).unwrap().is_none());
    assert!(display.read_rgba8(&render).is_err());
    // Every render keeps its previous accumulation readable.
    assert_bytes(
        &images(&render),
        &before,
        "previous image during preparation",
    );
    assert_bytes(
        &images(&other),
        &other_before,
        "other render's previous image during preparation",
    );
    resume.send(()).unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
    assert_eq!(finish(&other), RenderStatus::Finished);
    assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Full));
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&edited, [16, 12], 3, None),
            &changed.l0(4096, 0),
            3,
        ),
        "after preparation",
    );
    assert_bytes(
        &images(&other),
        &oracle(
            0,
            &expected_descriptor(&edited, [8, 6], 3, None),
            &small.l0(4096, 0),
            2,
        ),
        "other render after preparation",
    );
    assert!(display.present(&render).unwrap().is_some());
    assert_ne!(display.read_rgba8(&render).unwrap(), shown);
}

#[test]
fn converge_matches_l0_and_reports_progress_and_cancellation() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let settings = RenderSettings {
        size: RenderSize::Fixed {
            width: 12,
            height: 9,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    assert_eq!(
        render.converge(ConvergeOptions::new(3)).unwrap_err().status,
        Status::InvalidState
    );
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[13] = 0.4;
    let progress = Arc::new(Mutex::new(Vec::new()));
    let recorded = progress.clone();
    let mut options = ConvergeOptions::new(7);
    options.samples_per_batch = 3;
    options.sample_sequence_offset = 2;
    options.camera = Some(camera);
    options.on_progress = Some(Box::new(move |p| recorded.lock().unwrap().push(p)));
    assert_eq!(
        render.converge(options).unwrap(),
        ConvergeResult { samples: 7 }
    );
    assert_eq!(render.status(), RenderStatus::Finished);
    assert_eq!(render.samples(), 7);
    let progress: Vec<u32> = progress.lock().unwrap().iter().map(|p| p.samples).collect();
    assert_eq!(progress, vec![3, 6, 7]);
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [12, 9], 3, Some(&camera)),
            &settings.l0(7, 2),
            7,
        ),
        "converge",
    );
    // The same converge again restarts and reproduces the image.
    let mut again = ConvergeOptions::new(7);
    again.samples_per_batch = 64;
    again.sample_sequence_offset = 2;
    again.camera = Some(camera);
    render.converge(again).unwrap();
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [12, 9], 3, Some(&camera)),
            &settings.l0(7, 2),
            7,
        ),
        "repeated converge",
    );
    // Cancellation from the progress callback.
    let token = CancelToken::new();
    let cancel = token.clone();
    let mut cancelled = ConvergeOptions::new(40);
    cancelled.samples_per_batch = 2;
    cancelled.cancel = Some(token);
    cancelled.on_progress = Some(Box::new(move |_| cancel.cancel()));
    assert_eq!(
        render.converge(cancelled).unwrap_err().status,
        Status::Cancelled
    );
    assert_eq!(render.status(), RenderStatus::Error);
    // The cancelled converge used the interactive key (Sobol, offset 0, no camera),
    // so refine keeps its partial accumulation, as in the browser library.
    let interactive = RenderSettings {
        max_samples: 2,
        ..settings
    };
    render.set_settings(interactive.clone()).unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
    let kept = render.samples();
    assert!(kept >= 2, "{kept}");
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [12, 9], 3, None),
            &interactive.l0(interactive.sample_cap(2), 0),
            kept,
        ),
        "refine after cancelled converge",
    );
}

#[test]
fn fallback_is_presented_until_the_render_is_complete() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(16, 12).unwrap();
    let preview = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Scale(0.5),
            ..Default::default()
        },
    )
    .unwrap();
    let main = Render::new(
        &engine,
        RenderSettings {
            max_samples: 4,
            ..Default::default()
        },
    )
    .unwrap();
    main.set_fallback(Some(&preview)).unwrap();
    assert_eq!(
        preview.set_fallback(Some(&main)).unwrap_err().status,
        Status::InvalidArgument
    );
    assert_eq!(
        main.set_fallback(Some(&main)).unwrap_err().status,
        Status::InvalidArgument
    );
    let third = Render::new(&engine, RenderSettings::default()).unwrap();
    assert_eq!(
        third.set_fallback(Some(&main)).unwrap_err().status,
        Status::InvalidArgument
    );
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    // Only the main render is refined; it drives its fallback.
    assert_eq!(finish(&main), RenderStatus::Finished);
    assert!(!display.present(&main).unwrap().unwrap().fallback);

    // While the main render has no sample of its new target and cannot finish one
    // within its budget, refining it refines the fallback, which is shown.
    main.set_settings(RenderSettings {
        max_samples: 4,
        bevel_samples: 5,
        time_budget_ms: 1e-6,
        ..Default::default()
    })
    .unwrap();
    preview.restart().unwrap();
    assert_eq!(preview.samples(), 0);
    assert_eq!(main.refine().unwrap(), RenderStatus::Converging);
    let deadline = Instant::now() + Duration::from_secs(60);
    while !preview.collect().unwrap() {
        assert!(Instant::now() < deadline, "fallback sample never completed");
        std::thread::sleep(Duration::from_millis(1));
    }
    let presented = display.present(&main).unwrap().unwrap();
    assert_eq!(
        presented,
        Presented {
            fallback: true,
            width: 8,
            height: 6,
            samples: 1
        }
    );
    assert_eq!(preview.samples(), 1);
    // The fallback stops at one sample.
    for _ in 0..5 {
        main.refine().unwrap();
    }
    assert_eq!(preview.samples(), 1);
    assert_eq!(finish(&main), RenderStatus::Finished);
    assert!(!display.present(&main).unwrap().unwrap().fallback);
    // Dropping the fallback detaches it.
    drop(preview);
    assert!(engine.lock().renders[&main.id()].fallback.is_none());
    // Another engine's render is rejected.
    if let Some(other) = software_engine(Backend::Software) {
        let foreign = Render::new(&other, RenderSettings::default()).unwrap();
        assert_eq!(
            display.present(&foreign).unwrap_err().status,
            Status::InvalidArgument
        );
        assert_eq!(
            main.set_fallback(Some(&foreign)).unwrap_err().status,
            Status::InvalidArgument
        );
    }
    engine.dispose();
    assert_eq!(main.refine().unwrap_err().status, Status::InvalidHandle);
    assert_eq!(engine.update().unwrap_err().status, Status::InvalidHandle);
    assert_eq!(main.status(), RenderStatus::Error);
}

#[test]
fn invalid_scenes_report_errors_without_stopping_other_renders() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    assert_eq!(
        engine.set_scene(&[0; 16]).unwrap_err().status,
        Status::InvalidArgument
    );
    let errors = Arc::new(Mutex::new(0));
    let counted = errors.clone();
    engine
        .on(move |event| {
            if matches!(event, EngineEvent::Error { .. }) {
                *counted.lock().unwrap() += 1;
            }
        })
        .detach();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Fixed {
                width: 4,
                height: 4,
            },
            ..Default::default()
        },
    )
    .unwrap();
    // A bad mesh reference passes the header check and fails preparation.
    let mut broken = lit_scene();
    set_word(&mut broken, 44, 9);
    engine.set_scene(&broken).unwrap();
    engine.update().unwrap();
    assert_eq!(finish(&render), RenderStatus::Error);
    assert!(engine.last_error().is_some());
    assert_eq!(*errors.lock().unwrap(), 1);
    // Refining the same failed inputs does not report again.
    assert_eq!(render.refine().unwrap(), RenderStatus::Error);
    assert_eq!(*errors.lock().unwrap(), 1);
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    assert_eq!(finish(&render), RenderStatus::Finished);
}

/// Needs `MUTRACER_OIDN_LIBRARY`; uses CPU OIDN so the direct filter is a byte oracle.
#[test]
fn converged_oidn_matches_direct_filtering_of_the_same_inputs() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(library) = std::env::var_os("MUTRACER_OIDN_LIBRARY") else {
        return;
    };
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let settings = RenderSettings {
        max_samples: 4,
        size: RenderSize::Fixed {
            width: 16,
            height: 12,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    let options = DenoiserOptions {
        backend: 1,
        library: Some(library.clone().into()),
        schedule: DenoiseSchedule::Converged,
        max_tile_size: 0,
    };
    assert_eq!(
        render
            .set_denoiser(Some(DenoiserOptions {
                backend: 6,
                ..options.clone()
            }))
            .unwrap_err()
            .status,
        Status::InvalidArgument
    );
    render.set_denoiser(Some(options.clone())).unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let mut statuses = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let status = render.refine().unwrap();
        if statuses.last() != Some(&status) {
            statuses.push(status);
        }
        if status == RenderStatus::Finished {
            break;
        }
        assert_ne!(status, RenderStatus::Error, "{:?}", engine.last_error());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(statuses.contains(&RenderStatus::Denoising), "{statuses:?}");
    assert!(!render.denoising());
    let inputs = raw_oracle(
        0,
        &expected_descriptor(&scene, [16, 12], 3, None),
        &settings.l0(4, 0),
        4,
    )
    .map(|image| flip_rows(&image, 16, 12));
    let mut filter = crate::denoise::Denoiser::from_library(library.as_ref(), 1).unwrap();
    let expected = flip_rows(
        &filter
            .run([16, 12], &inputs[0], &inputs[1], &inputs[2])
            .unwrap(),
        16,
        12,
    );
    let denoised = render.read_pixels(PixelKind::Denoised).unwrap().data;
    assert_eq!(
        denoised.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    assert_ne!(denoised, render.read_pixels(PixelKind::Hdr).unwrap().data);
    let presented = engine.display().present(&render).unwrap().unwrap();
    assert_eq!(presented.samples, 4);
    // Converge filters before returning and reports the denoising stage.
    let stages = Arc::new(Mutex::new(Vec::new()));
    let recorded = stages.clone();
    let mut converge = ConvergeOptions::new(4);
    converge.on_progress = Some(Box::new(move |p| recorded.lock().unwrap().push(p.stage)));
    render.converge(converge).unwrap();
    assert_eq!(
        stages.lock().unwrap().last(),
        Some(&ConvergeStage::Denoising)
    );
    let again = render.read_pixels(PixelKind::Denoised).unwrap().data;
    assert_eq!(
        again.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    // Disabling the denoiser falls back to HDR.
    render.set_denoiser(None).unwrap();
    assert_eq!(
        render.read_pixels(PixelKind::Denoised).unwrap(),
        render.read_pixels(PixelKind::Hdr).unwrap()
    );
}

#[test]
fn sample_cap_changes_images_only_for_zsobol() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if software_engine(Backend::Software).is_none() {
        return;
    }
    let descriptor = expected_descriptor(&lit_scene(), [16, 12], 3, None);
    for (pattern, independent) in [
        (SamplingPattern::Sobol, true),
        (SamplingPattern::Random, true),
        (SamplingPattern::ZSobol, false),
    ] {
        let settings = RenderSettings {
            sampling_pattern: pattern,
            ..Default::default()
        };
        let small = oracle(0, &descriptor, &settings.l0(5, 0), 5);
        for cap in [6, 64, 4096] {
            let large = oracle(0, &descriptor, &settings.l0(cap, 0), 5);
            if independent {
                assert_bytes(&large, &small, &format!("{pattern:?} cap {cap}"));
            } else if cap == 4096 {
                assert_ne!(large[0], small[0], "zsobol cap had no effect");
            }
        }
    }
}

fn l0_samples(handle: u64) -> std::result::Result<u32, Status> {
    let mut info = context::ContextInfo {
        struct_size: std::mem::size_of::<context::ContextInfo>() as u32,
        width: 0,
        height: 0,
        samples: 0,
        state: 0,
        last_commit: 0,
    };
    let mut error = [0i8; 256];
    let code =
        unsafe { context::mt_context_info(handle, &mut info, error.as_mut_ptr(), error.len()) };
    if code == 0 {
        Ok(info.samples)
    } else {
        Err(status_from(code))
    }
}
/// Holds the next full preparation until the returned sender is used or dropped.
fn hold_preparation() -> mpsc::SyncSender<()> {
    let (resume, resumed) = mpsc::sync_channel(1);
    *context::PREPARATION_GATE.lock().unwrap() = Some(resumed);
    resume
}
/// `scene` with the background hidden: a shader feature change that only full
/// preparation applies.
fn full_edit(scene: &[u8]) -> Vec<u8> {
    let mut edited = scene.to_vec();
    let flags = word(&edited, h::QUALITY_FLAGS);
    set_word(&mut edited, h::QUALITY_FLAGS, flags ^ 4);
    edited
}
/// Refines until a batch is in flight right after the call.
fn refine_until_in_flight(render: &Render) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        render.refine().unwrap();
        let busy = render.engine().lock().renders[&render.id()].in_flight();
        if busy && render.samples() > 0 {
            return;
        }
        assert!(Instant::now() < deadline, "no batch in flight");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn full_preparation_with_a_batch_in_flight_keeps_reads_and_releases_the_context() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(64, 48).unwrap();
    let settings = RenderSettings {
        allow_multiple_samples_per_frame: true,
        time_budget_ms: 1000.,
        ..Default::default()
    };
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let render = Render::new(&engine, settings.clone()).unwrap();
    let handle = render.engine().lock().renders[&render.id()].context();
    refine_until_in_flight(&render);

    // A full preparation while a batch runs: the batch completes on the previous
    // scene and stays readable.
    let resume = hold_preparation();
    engine.set_scene(&full_edit(&scene)).unwrap();
    engine.update().unwrap();
    assert_eq!(render.refine().unwrap(), RenderStatus::Preparing);
    let during = images(&render);
    let previous = l0_samples(handle).unwrap();
    assert!(previous > 0);
    // Dropping the render while the scene prepares destroys its target context.
    drop(render);
    assert_eq!(l0_samples(handle), Err(Status::InvalidHandle));
    resume.send(()).unwrap();
    assert_bytes(
        &during,
        &oracle(
            0,
            &expected_descriptor(&scene, [64, 48], 3, None),
            &settings.l0(settings.sample_cap(settings.max_samples), 0),
            previous,
        ),
        "previous image while preparing",
    );
    let scene = full_edit(&scene);

    // A rejected render target keeps the previous image readable.
    let render = Render::new(&engine, settings.clone()).unwrap();
    refine_until_in_flight(&render);
    render
        .set_settings(RenderSettings {
            size: RenderSize::Fixed {
                width: 9000,
                height: 4,
            },
            ..settings.clone()
        })
        .unwrap();
    assert_eq!(finish(&render), RenderStatus::Error);
    assert!(engine.last_error().is_some());
    let handle = render.engine().lock().renders[&render.id()].context();
    let previous = l0_samples(handle).unwrap();
    assert_bytes(
        &images(&render),
        &oracle(
            0,
            &expected_descriptor(&scene, [64, 48], 3, None),
            &settings.l0(settings.sample_cap(settings.max_samples), 0),
            previous,
        ),
        "previous image after a rejected preparation",
    );
    drop(render);
    assert_eq!(l0_samples(handle), Err(Status::InvalidHandle));
}

#[test]
fn callbacks_may_call_back_into_the_api() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        let render = Arc::new(
            Render::new(
                &engine,
                RenderSettings {
                    max_samples: 4,
                    size: RenderSize::Fixed {
                        width: 16,
                        height: 12,
                    },
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (reader, recorded) = (render.clone(), seen.clone());
        let samples = render.on_sample(move |event| {
            recorded.lock().unwrap().push(event.samples);
            // Waits for the next in-flight batch, whose event is queued meanwhile.
            assert!(!reader.read_pixels(PixelKind::Hdr).unwrap().data.is_empty());
        });
        let updates = Arc::new(Mutex::new(0));
        let (updater, counted) = (engine.clone(), updates.clone());
        let progress = engine.on(move |event| {
            if matches!(event, EngineEvent::Progress { .. }) {
                assert!(!updater.update().unwrap());
                *counted.lock().unwrap() += 1;
            }
        });
        engine.set_scene(&lit_scene()).unwrap();
        engine.update().unwrap();
        let status = finish(&render);
        let seen = seen.lock().unwrap().clone();
        let updates = *updates.lock().unwrap();
        drop((samples, progress));
        done.send((status, seen, updates)).unwrap();
    });
    let (status, seen, updates) = finished
        .recv_timeout(Duration::from_secs(120))
        .expect("a callback that calls the API deadlocked");
    assert_eq!(status, RenderStatus::Finished);
    assert_eq!(seen, vec![1, 2, 3, 4]);
    assert_eq!(updates, 4);
}

#[test]
fn raising_max_samples_continues_except_for_zsobol() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let preparations = Arc::new(Mutex::new(0));
    let counted = preparations.clone();
    let _progress = engine.on(move |event| {
        if *event
            == (EngineEvent::Progress {
                stage: ProgressStage::Preparation,
                progress: 0.,
            })
        {
            *counted.lock().unwrap() += 1;
        }
    });
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let descriptor = expected_descriptor(&scene, [16, 12], 3, None);
    for pattern in [
        SamplingPattern::Sobol,
        SamplingPattern::Random,
        SamplingPattern::ZSobol,
    ] {
        let settings = RenderSettings {
            sampling_pattern: pattern,
            max_samples: 3,
            size: RenderSize::Fixed {
                width: 16,
                height: 12,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        assert_eq!(finish(&render), RenderStatus::Finished);
        let before = *preparations.lock().unwrap();
        let raised = RenderSettings {
            max_samples: 6,
            ..settings.clone()
        };
        render.set_settings(raised.clone()).unwrap();
        assert_eq!(render.refine().unwrap(), RenderStatus::Converging);
        // ZSobol restarts its target; the shared scene is never prepared again.
        if pattern == SamplingPattern::ZSobol {
            assert_eq!(render.samples(), 0);
        } else {
            assert!(render.samples() >= 3, "{pattern:?} restarted");
        }
        assert_eq!(finish(&render), RenderStatus::Finished);
        assert_eq!(*preparations.lock().unwrap(), before);
        assert_bytes(
            &images(&render),
            &oracle(0, &descriptor, &raised.l0(6, 0), 6),
            &format!("{pattern:?} after raising max_samples"),
        );
        // Converge reuses the prepared scene.
        render.converge(ConvergeOptions::new(5)).unwrap();
        assert_eq!(*preparations.lock().unwrap(), before);
        assert_bytes(
            &images(&render),
            &oracle(0, &descriptor, &raised.l0(5, 0), 5),
            &format!("{pattern:?} converge"),
        );
    }
}

#[test]
fn denoise_schedules_choose_the_browser_sample_targets() {
    use super::render::sample_target;
    let converged = Some(DenoiseSchedule::Converged);
    let progressive = Some(DenoiseSchedule::Progressive);
    let every = Some(DenoiseSchedule::EverySample);
    assert_eq!(sample_target(None, 3, 64, 0, None), 64);
    assert_eq!(sample_target(converged, 3, 64, 2, None), 64);
    assert_eq!(sample_target(every, 3, 64, 3, None), 4);
    assert_eq!(sample_target(every, 64, 64, 64, None), 64);
    // Progressive: 1, then max(4, 2 × denoised), capped at max_samples.
    assert_eq!(sample_target(progressive, 0, 64, 0, None), 1);
    let recent = Some(Duration::from_secs(1));
    assert_eq!(sample_target(progressive, 1, 64, 1, recent), 4);
    assert_eq!(sample_target(progressive, 4, 64, 4, recent), 8);
    assert_eq!(sample_target(progressive, 40, 64, 40, recent), 64);
    assert_eq!(sample_target(progressive, 2, 3, 1, recent), 3);
    // Ten seconds without a result: the next sample.
    let stale = Some(Duration::from_secs(10));
    assert_eq!(sample_target(progressive, 9, 64, 8, stale), 10);
}

/// Needs `MUTRACER_OIDN_LIBRARY`; CPU OIDN makes direct filtering a byte oracle.
#[test]
fn progressive_denoising_pauses_sampling_and_keeps_the_last_result() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(library) = std::env::var_os("MUTRACER_OIDN_LIBRARY") else {
        return;
    };
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    for (schedule, expected) in [
        (DenoiseSchedule::Progressive, vec![1, 4, 8, 10]),
        (DenoiseSchedule::EverySample, vec![1, 2, 3]),
    ] {
        let settings = RenderSettings {
            max_samples: *expected.last().unwrap(),
            allow_multiple_samples_per_frame: true,
            time_budget_ms: 1000.,
            size: RenderSize::Fixed {
                width: 16,
                height: 12,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        render
            .set_denoiser(Some(DenoiserOptions {
                backend: 1,
                library: Some(library.clone().into()),
                schedule,
                max_tile_size: 0,
            }))
            .unwrap();
        let mut denoised_at = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let before = render.samples();
            let filtering = render.denoising();
            let status = render.refine().unwrap();
            assert_ne!(status, RenderStatus::Error, "{:?}", engine.last_error());
            if filtering && render.denoising() {
                // Sampling pauses while the filter runs.
                assert_eq!(
                    render.samples(),
                    before,
                    "{schedule:?} traced while denoising"
                );
            }
            if let Some(report) = render.denoise_report() {
                assert!(report.error.is_none(), "{report:?}");
                if denoised_at.last() != Some(&report.samples) {
                    denoised_at.push(report.samples);
                    // Every result equals direct filtering of the same inputs.
                    let inputs = raw_oracle(
                        0,
                        &expected_descriptor(&scene, [16, 12], 3, None),
                        &settings.l0(settings.sample_cap(settings.max_samples), 0),
                        report.samples,
                    )
                    .map(|image| flip_rows(&image, 16, 12));
                    let mut filter =
                        crate::denoise::Denoiser::from_library(library.as_ref(), 1).unwrap();
                    let expected = flip_rows(
                        &filter
                            .run([16, 12], &inputs[0], &inputs[1], &inputs[2])
                            .unwrap(),
                        16,
                        12,
                    );
                    let actual = render.read_pixels(PixelKind::Denoised).unwrap().data;
                    assert_eq!(
                        actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                        expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                        "{schedule:?} at {}",
                        report.samples
                    );
                    assert_eq!(report.backend, "OIDN CPU");
                }
            }
            if status == RenderStatus::Finished && !render.denoising() {
                break;
            }
            assert!(Instant::now() < deadline, "{schedule:?} did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(denoised_at, expected, "{schedule:?} denoise points");
        // The presented image is the last denoised one.
        let presented = engine.display().present(&render).unwrap().unwrap();
        assert_eq!(presented.samples, settings.max_samples);
        // Disabling and re-enabling keeps the device and filters again.
        render.set_denoiser(None).unwrap();
        assert!(render.denoise_report().is_none());
    }
}

/// Pausing filters the current samples once without tracing; resuming continues
/// the progressive points from there. Denoised images are uploaded once each and
/// stay presented through later captures.
#[test]
fn denoise_current_filters_paused_samples_and_progressive_resumes() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(library) = std::env::var_os("MUTRACER_OIDN_LIBRARY") else {
        return;
    };
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    // One sample per batch, so the pause lands between progressive points.
    let settings = RenderSettings {
        max_samples: 12,
        allow_multiple_samples_per_frame: false,
        size: RenderSize::Fixed {
            width: 16,
            height: 12,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    assert!(!render.denoise_current().unwrap(), "no denoiser");
    render
        .set_denoiser(Some(DenoiserOptions {
            backend: 1,
            library: Some(library.clone().into()),
            schedule: DenoiseSchedule::Progressive,
            max_tile_size: 0,
        }))
        .unwrap();
    let mut filter = crate::denoise::Denoiser::from_library(library.as_ref(), 1).unwrap();
    let mut check = |samples: u32| {
        let inputs = raw_oracle(
            0,
            &expected_descriptor(&scene, [16, 12], 3, None),
            &settings.l0(settings.sample_cap(settings.max_samples), 0),
            samples,
        )
        .map(|image| flip_rows(&image, 16, 12));
        let expected = flip_rows(
            &filter
                .run([16, 12], &inputs[0], &inputs[1], &inputs[2])
                .unwrap(),
            16,
            12,
        );
        let actual = render.read_pixels(PixelKind::Denoised).unwrap().data;
        assert_eq!(
            actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            "denoised at {samples}"
        );
    };
    let uploads = || engine.lock().renders[&render.id()].display_uploads();
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut denoised_at = Vec::new();
    let record = |render: &Render, denoised_at: &mut Vec<u32>| {
        if let Some(report) = render.denoise_report() {
            assert!(report.error.is_none(), "{report:?}");
            if denoised_at.last() != Some(&report.samples) {
                denoised_at.push(report.samples);
                return Some(report.samples);
            }
        }
        None
    };
    // Run until the 4-sample result is shown and one more sample is in flight.
    loop {
        assert_ne!(render.refine().unwrap(), RenderStatus::Error);
        let in_flight = engine.lock().renders[&render.id()].in_flight();
        if let Some(samples) = record(&render, &mut denoised_at) {
            if samples == 4 && render.samples() == 4 && in_flight {
                // Reading pixels would wait for the batch in flight.
                break;
            }
            check(samples);
        }
        assert!(Instant::now() < deadline, "did not reach 4 samples");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(denoised_at, [1, 4]);
    // Paused: the batch in flight is collected, then its samples are filtered once.
    while !render.denoise_current().unwrap() {
        assert!(render.samples() <= 5, "traced while paused");
        assert!(Instant::now() < deadline, "paused filter did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(render.samples(), 5);
    assert_eq!(record(&render, &mut denoised_at), Some(5));
    check(5);
    assert!(uploads().1, "display shows the denoised image");
    for _ in 0..3 {
        assert!(render.denoise_current().unwrap());
        assert!(!render.denoising());
    }
    assert_eq!(render.samples(), 5);
    let shown = engine.display().read_rgba8(&render).unwrap();
    // Resumed: progressive points continue from the paused result. Captures in
    // between keep the denoised image without uploading it again.
    let mut compared = false;
    loop {
        let status = render.refine().unwrap();
        assert_ne!(status, RenderStatus::Error, "{:?}", engine.last_error());
        let presented = engine.lock().renders[&render.id()].presented_samples();
        if !compared && presented > 5 && denoised_at.last() == Some(&5) {
            assert_eq!(engine.display().read_rgba8(&render).unwrap(), shown);
            compared = true;
        }
        if let Some(samples) = record(&render, &mut denoised_at) {
            check(samples);
        }
        if status == RenderStatus::Finished && !render.denoising() {
            break;
        }
        assert!(Instant::now() < deadline, "did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        compared,
        "no capture between the paused and the next result"
    );
    assert_eq!(denoised_at, [1, 4, 5, 10, 12]);
    assert_eq!(uploads(), (5, true), "one upload per denoised image");
}

/// A shared scene reaches the L0 context without copies, and `update` treats a new
/// Arc as a change without comparing bytes.
#[test]
fn shared_scenes_are_committed_without_copies() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let settings = RenderSettings {
        max_samples: 3,
        size: RenderSize::Fixed {
            width: 16,
            height: 12,
        },
        ..Default::default()
    };
    // Already the render's size and quality bits, so the render needs no override.
    let bytes = expected_descriptor(&lit_scene(), [16, 12], settings.quality(), None);
    let scene = Arc::new(bytes.clone());
    engine.set_scene_shared(scene.clone()).unwrap();
    let render = Render::new(&engine, settings.clone()).unwrap();
    assert!(engine.update().unwrap());
    assert_eq!(finish(&render), RenderStatus::Finished);
    // The caller, the engine's pending and committed scene, and the L0 context.
    assert_eq!(Arc::strong_count(&scene), 4);
    let expected = oracle(0, &bytes, &settings.l0(3, 0), 3);
    assert_bytes(&images(&render), &expected, "shared scene");
    // The same Arc changes nothing; an equal new one is a change.
    engine.set_scene_shared(scene.clone()).unwrap();
    assert!(!engine.update().unwrap());
    assert_eq!(render.samples(), 3);
    let next = Arc::new(bytes.clone());
    engine.set_scene_shared(next.clone()).unwrap();
    assert!(engine.update().unwrap());
    assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Incremental));
    assert_eq!(Arc::strong_count(&scene), 1);
    assert_eq!(Arc::strong_count(&next), 4);
    assert_eq!(finish(&render), RenderStatus::Finished);
    assert_bytes(&images(&render), &expected, "shared scene after an edit");
    // A copied scene with equal bytes is unchanged, as before.
    engine.set_scene(&bytes).unwrap();
    assert!(!engine.update().unwrap());
}

/// Loop repro of the viewer's intermittent HWRT mismatches: full preparations of an
/// L1 render presented every frame against fresh L0
/// contexts. `MT_LOOP_ITERATIONS` (default 2000); `MT_LOOP_EXTRA=1` keeps a second
/// HWRT engine rendering meanwhile. `MT_LOOP_L0=1` bypasses the upper API and
/// uses the old viewer's L0 job polling (one sample per poll). `MT_LOOP_REAL_CAP=1`
/// uses the actual Sobol cap in the L0 control. `MT_LOOP_BATCHED=1` enables L1
/// time-budget batches; `MT_LOOP_ORACLE_BATCH=1` batches the oracle. The complete
/// GPU history is read after the render, including samples inside a batch.
/// `MUTRACER_TEST_CAPTURE` saves mismatching AOVs and full audit records for replay.
/// Mismatches fail the test; this remains ignored because it needs real HWRT and
/// the Metal fault is intermittent.
#[test]
#[ignore]
fn hardware_loop_against_fresh_l0_contexts() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let iterations: usize = std::env::var("MT_LOOP_ITERATIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2000);
    let direct = std::env::var_os("MT_LOOP_L0").is_some();
    let real_cap = std::env::var_os("MT_LOOP_REAL_CAP").is_some();
    assert!(!real_cap || direct, "MT_LOOP_REAL_CAP requires MT_LOOP_L0");
    assert!(iterations > 0, "MT_LOOP_ITERATIONS must be positive");
    let extra = std::env::var_os("MT_LOOP_EXTRA").is_some();
    // The audit instruments a context's own outputs; render targets reject it,
    // so only the L0 mode and the oracle record it.
    context::AUDIT_PREPARATIONS.store(direct, std::sync::atomic::Ordering::Relaxed);
    context::AUDIT_HISTORY_SAMPLES.store(
        if direct { 4 } else { 0 },
        std::sync::atomic::Ordering::Relaxed,
    );
    struct AuditGuard;
    impl Drop for AuditGuard {
        fn drop(&mut self) {
            context::AUDIT_PREPARATIONS.store(false, std::sync::atomic::Ordering::Relaxed);
            context::AUDIT_HISTORY_SAMPLES.store(0, std::sync::atomic::Ordering::Relaxed);
        }
    }
    let _audit = AuditGuard;
    let engine = software_engine(Backend::Hardware).unwrap();
    assert!(engine.info().hardware_ray_query, "no hardware ray queries");
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    let other = extra.then(|| {
        let other = software_engine(Backend::Hardware).unwrap();
        other.set_scene(&scene).unwrap();
        let render = Render::new(&other, RenderSettings::default()).unwrap();
        (other, render)
    });
    let base = RenderSettings {
        max_samples: 4,
        allow_multiple_samples_per_frame: std::env::var_os("MT_LOOP_BATCHED").is_some(),
        time_budget_ms: 1000.,
        size: RenderSize::Fixed {
            width: 96,
            height: 64,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, base.clone()).unwrap();
    let display = engine.display();
    display.set_size(96, 64).unwrap();
    let mut failures = Vec::new();
    let mut typical = None;
    // A plain context for the L0 mode: render contexts are targets of the shared scene.
    let mut direct_handle = 0;
    if direct {
        l0(|e, n| unsafe { context::mt_context_create_with_backend(1, &mut direct_handle, e, n) })
            .unwrap();
    }
    for i in 0..iterations {
        let settings = RenderSettings {
            bounces: 3 + (i % 2) as u32,
            ..base.clone()
        };
        // Alternate a shader feature so every L1 iteration fully prepares the scene.
        let scene = if i % 2 == 1 {
            full_edit(&scene)
        } else {
            scene.clone()
        };
        let descriptor = expected_descriptor(&scene, [96, 64], settings.quality(), None);
        let l0_settings = settings.l0(
            if real_cap {
                settings.max_samples
            } else {
                settings.sample_cap(settings.max_samples)
            },
            0,
        );
        let handle = if direct {
            direct_handle
        } else {
            engine.lock().shared.context().unwrap_or(0)
        };
        let actual = if direct {
            l0(|e, n| unsafe {
                context::mt_context_commit_with_settings(
                    handle,
                    descriptor.as_ptr(),
                    descriptor.len(),
                    &l0_settings,
                    e,
                    n,
                )
            })
            .unwrap();
            let mut job = 0;
            l0(|e, n| unsafe {
                context::mt_context_submit(handle, settings.max_samples, &mut job, e, n)
            })
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                assert!(Instant::now() < deadline, "L0 iteration {i} did not finish");
                l0(|e, n| unsafe { context::mt_job_poll(job, 1, e, n) }).unwrap();
                if l0_samples(handle).unwrap() == settings.max_samples {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            context_images(handle, [96, 64])
        } else {
            render.set_settings(settings.clone()).unwrap();
            engine.set_scene(&scene).unwrap();
            engine.update().unwrap();
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                let status = render.refine().unwrap();
                assert_ne!(status, RenderStatus::Error, "{:?}", engine.last_error());
                while !render.collect().unwrap() {
                    assert!(Instant::now() < deadline, "iteration {i} did not finish");
                    std::thread::sleep(Duration::from_micros(200));
                }
                let samples = render.samples();
                display.present(&render).unwrap();
                if let Some((_, other)) = &other {
                    if other.refine().unwrap() == RenderStatus::Finished {
                        other.restart().unwrap();
                    }
                }
                if samples >= settings.max_samples {
                    break;
                }
                assert!(Instant::now() < deadline, "iteration {i} did not finish");
            }
            images(&render)
        };
        let handle = if direct {
            direct_handle
        } else {
            engine.lock().shared.context().unwrap()
        };
        assert_hardware_context(handle);
        let hits = if direct {
            context::audit_history(handle, settings.max_samples)
        } else {
            Default::default()
        };
        let (expected, oracle_hits, oracle_history) = oracle_audited(
            1,
            &descriptor,
            &l0_settings,
            settings.max_samples,
            std::env::var_os("MT_LOOP_ORACLE_BATCH").is_none(),
        );
        let differ: Vec<usize> = (0..3)
            .map(|k| {
                assert_eq!(actual[k].len(), expected[k].len(), "AOV {k} dimensions");
                actual[k]
                    .iter()
                    .zip(&expected[k])
                    .filter(|(a, b)| a.to_bits() != b.to_bits())
                    .count()
            })
            .collect();
        if differ.iter().any(|&d| d > 0) {
            let counts = actual[1]
                .chunks_exact(4)
                .map(|p| p[3] * settings.max_samples as f32)
                .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), count| {
                    (min.min(count), max.max(count))
                });
            let failure = format!(
                "iteration {i}: differing floats {differ:?}, GPU count range {counts:?}, history {hits:?}, oracle history {oracle_history:?}, last-sample audit {oracle_hits:?}"
            );
            println!("{failure}");
            if let Some(root) = std::env::var_os("MUTRACER_TEST_CAPTURE") {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let directory = std::path::PathBuf::from(root)
                    .join(format!("hardware-loop-{}-{i}-{stamp}", std::process::id()));
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(directory.join("scene.bin"), &descriptor).unwrap();
                std::fs::write(directory.join("actual-audit.bin"), &hits.records).unwrap();
                std::fs::write(directory.join("oracle-audit.bin"), &oracle_history.records)
                    .unwrap();
                for (side, images) in [("actual", &actual), ("oracle", &expected)] {
                    for (kind, image) in images.iter().enumerate() {
                        let bytes: Vec<_> = image.iter().flat_map(|v| v.to_le_bytes()).collect();
                        std::fs::write(directory.join(format!("{side}-aov{kind}.bin")), bytes)
                            .unwrap();
                    }
                }
                let metadata = serde_json::json!({
                    "iteration": i,
                    "width": 96,
                    "height": 64,
                    "samples": settings.max_samples,
                    "l0Control": direct,
                    "actual": hits.samples,
                    "oracle": oracle_history.samples,
                    "settings": {
                        "samplingPattern": l0_settings.sampling_pattern,
                        "seed": l0_settings.seed,
                        "maxSamples": l0_settings.max_samples,
                        "bounces": l0_settings.bounces,
                        "directLightCandidates": l0_settings.direct_light_candidates,
                        "bevelSamples": l0_settings.bevel_samples,
                        "sampleSequenceOffset": l0_settings.sample_sequence_offset,
                        "clamping": l0_settings.clamping,
                        "transmissiveOutputAlphaMin": l0_settings.transmissive_output_alpha_min,
                    },
                    "differingFloats": differ,
                    "actualGpuCountRange": counts,
                    "aovRowOrder": "top-first",
                    "auditRowOrder": "bottom-first",
                    "auditLayout": "u32x4: execution count, pixel sample index, primary hit, interior hit; first plane = last sample; following planes indexed by submitted sample",
                });
                std::fs::write(
                    directory.join("failure.json"),
                    serde_json::to_vec_pretty(&metadata).unwrap(),
                )
                .unwrap();
                println!("captured {}", directory.display());
            }
            failures.push(failure);
        } else if typical.is_none() {
            typical = Some(format!("{hits:?}"));
        }
    }
    if direct {
        l0(|e, n| unsafe { context::mt_context_destroy(direct_handle, e, n) }).unwrap();
    }
    println!(
        "hardware loop: {} of {iterations} mismatched (extra engine {extra}, L0 {direct}, real cap {real_cap}); passing audit {}",
        failures.len(),
        typical.unwrap_or_default()
    );
    assert!(
        failures.is_empty(),
        "{} HWRT image mismatches; see per-sample history above",
        failures.len()
    );
}
