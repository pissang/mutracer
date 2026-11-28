use super::*;
use std::path::Path;
use wgpu::util::DeviceExt;

/// Replay a directory of consecutive frame folders containing the Web capture buffers.
#[test]
#[ignore = "requires frozen temporal inputs and a real GPU"]
fn frozen_offline_replay() {
    let dir = PathBuf::from(std::env::var_os("MUTRACER_TEMPORAL_REPLAY").unwrap());
    let output = PathBuf::from(std::env::var_os("MUTRACER_TEMPORAL_OUTPUT").unwrap());
    std::fs::create_dir_all(&output).unwrap();
    let engine =
        super::super::aov_tests::aov_engine(if std::env::var_os("MUTRACER_AOV_HWRT").is_some() {
            crate::api::Backend::Hardware
        } else {
            crate::api::Backend::Software
        });
    let weights = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../oidn/weights/rt_hdr_calb_cnrm_large.tza");
    let mut denoiser = TemporalDenoiser::new(
        &engine,
        Default::default(),
        TemporalSpatial::Oidn(Some(weights)),
    )
    .unwrap();
    let mut frames = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|p| p.is_dir())
        .collect::<Vec<_>>();
    frames.sort();
    for folder in frames {
        let j: serde_json::Value =
            serde_json::from_slice(&std::fs::read(folder.join("meta.json")).unwrap()).unwrap();
        let index: u32 = folder
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .trim_start_matches("frame_")
            .parse()
            .unwrap();
        let size = [
            j["width"].as_u64().unwrap() as u32,
            j["height"].as_u64().unwrap() as u32,
        ];
        let mut camera = [0.; 20];
        for (dst, value) in camera
            .iter_mut()
            .zip(j["viewProjection"].as_array().unwrap())
        {
            *dst = value.as_f64().unwrap() as f32;
        }
        camera[16] = size[1] as f32 * j["projection"][5].as_f64().unwrap() as f32 * 0.5;
        camera[17] = j["apertureRadius"].as_f64().unwrap() as f32;
        camera[18] = j["focusDistance"].as_f64().unwrap() as f32;
        let revisions = serde_json::from_value(
            j.get("revisions")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
        )
        .unwrap();
        let display = DisplaySettings {
            tone_mapping_exposure: j["display"]["toneMappingExposure"].as_f64().unwrap_or(1.9)
                as f32,
            ..Default::default()
        };
        let guides = [
            "centerDepth",
            "centerNormal",
            "roughness",
            "albedo",
            "hdr",
            "motion",
            "id",
            "normal",
            "centerPosition",
        ]
        .map(|name| {
            let data = std::fs::read(folder.join(format!("{name}.bin"))).unwrap();
            assert_eq!(data.len(), (size[0] * size[1] * 16) as usize);
            engine
                .inner
                .gpu
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(name),
                    contents: &data,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                })
        });
        denoiser
            .push_capture(
                index,
                Capture {
                    raw: false,
                    reflections: None,
                    check_camera: j["frameSequence"].is_number(),
                    size,
                    sample_tiles: None,
                    samples: j["samples"].as_u64().unwrap() as u32,
                    camera,
                    display,
                    revisions,
                    scene_key: j["sceneRevision"].as_u64().unwrap_or(0),
                    lighting_key: j["lightingRevision"].as_u64().unwrap_or(0),
                    emissions: Default::default(),
                    guides,
                },
            )
            .unwrap();
        while let Some(f) = denoiser.drain() {
            save(&output, f);
        }
    }
    while let Some(f) = denoiser.flush().unwrap() {
        save(&output, f);
    }
}
fn save(output: &Path, frame: OfflineFrame) {
    let image = frame.read_pixels(false).unwrap();
    if std::env::var("MUTRACER_TEMPORAL_DUMP")
        .ok()
        .and_then(|s| s.parse().ok())
        == Some(frame.index)
    {
        for (name, data) in [
            ("denoised", image.data.clone()),
            ("accumulated", frame.read_pixels(true).unwrap().data),
        ] {
            std::fs::write(
                output.join(format!("{name}.f32")),
                bytemuck::cast_slice(&data),
            )
            .unwrap();
        }
    }
    let mut rgb = Vec::with_capacity((image.width * image.height * 3) as usize);
    for p in image.data.chunks_exact(4) {
        for &v in &p[..3] {
            let s = if v <= 0.0031308 {
                12.92 * v
            } else {
                1.055 * v.powf(1. / 2.4) - 0.055
            };
            rgb.push((s.clamp(0., 1.) * 255.).round() as u8);
        }
    }
    let file = std::fs::File::create(output.join(format!("frame_{:04}.png", frame.index))).unwrap();
    let mut encoder = png::Encoder::new(file, image.width, image.height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&rgb)
        .unwrap();
}

#[test]
#[ignore = "requires exported sequence descriptors and a real GPU"]
fn render_offline_sequence() {
    use crate::api::{
        Backend, Camera, CausticSettings, ConvergeOptions, RenderSettings, RenderSize,
    };
    crate::logging::stderr();
    let dir = PathBuf::from(std::env::var_os("MUTRACER_TEMPORAL_SCENE").unwrap());
    let output = PathBuf::from(std::env::var_os("MUTRACER_TEMPORAL_OUTPUT").unwrap());
    std::fs::create_dir_all(&output).unwrap();
    let engine =
        super::super::aov_tests::aov_engine(if std::env::var_os("MUTRACER_AOV_HWRT").is_some() {
            Backend::Hardware
        } else {
            Backend::Software
        });
    let dining = dir.join("descriptor.bin").is_file();
    let control = std::env::var("MUTRACER_TEMPORAL_CONTROL").ok();
    let spp = control
        .as_deref()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(32);
    let (width, height) = if std::env::var_os("MUTRACER_TEMPORAL_1080").is_some() {
        (1920, 1080)
    } else if dining || std::env::var_os("MUTRACER_TEMPORAL_720").is_some() {
        (1280, 720)
    } else {
        (640, 368)
    };
    let weights = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../oidn/weights/rt_hdr_calb_cnrm_large.tza");
    let mut denoiser = TemporalDenoiser::new(
        &engine,
        Default::default(),
        TemporalSpatial::Oidn(Some(weights.clone())),
    )
    .unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            size: RenderSize::Fixed { width, height },
            max_samples: spp,
            aovs: TemporalDenoiser::AOVS,
            bounces: if dining { 10 } else { 6 },
            caustics: CausticSettings {
                light_tracing: dining,
                photon_mapping: dining,
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();
    engine
        .display()
        .set_settings(DisplaySettings {
            tone_mapping_exposure: if dining { 1.9 } else { 1. },
            ..Default::default()
        })
        .unwrap();
    if control.is_some() && spp == 32 {
        render
            .set_viewer_denoiser(Some(crate::api::DenoiserOptions {
                backend: crate::api::DENOISE_OIDN_WEBGPU,
                library: Some(weights.clone()),
                max_tile_size: 432,
                ..Default::default()
            }))
            .unwrap();
    }
    // Reuse the exact samples and guides on both sides of the dining highlight comparison.
    let mut highlight_control =
        if dining && std::env::var_os("MUTRACER_TEMPORAL_HIGHLIGHT").is_some() {
            Some(
                TemporalDenoiser::new(
                    &engine,
                    TemporalOptions {
                        stabilize_sparkle: false,
                        ..Default::default()
                    },
                    TemporalSpatial::Oidn(Some(weights)),
                )
                .unwrap(),
            )
        } else {
            None
        };
    let mut peak = 0;
    if dining {
        engine
            .set_scene(&std::fs::read(dir.join("descriptor.bin")).unwrap())
            .unwrap();
    }
    for i in if dining { 76..192 } else { 0..54 } {
        if std::env::var("MUTRACER_TEMPORAL_LIMIT")
            .ok()
            .and_then(|s| s.parse().ok())
            .is_some_and(|last: u32| i > last)
        {
            break;
        }
        if spp > 32 && !(18..44).contains(&i) {
            continue;
        }
        eprintln!("Rendering input frame {i}");
        if dining {
            let bytes = std::fs::read(dir.join(format!("frame_{i:04}.camera"))).unwrap();
            engine
                .set_camera(Some(Camera::from_bytes(&bytes).unwrap()))
                .unwrap();
        } else {
            let bytes = std::fs::read(dir.join(format!("frame_{i:04}.bin"))).unwrap();
            engine.set_scene(&bytes).unwrap();
        }
        engine.update().unwrap();
        let mut options = ConvergeOptions::new(spp);
        options.sample_sequence_offset = if spp == 32 {
            i * 32
        } else {
            (1 << 22) + i * 1024 + if spp == 256 { 1 << 22 } else { 0 }
        };
        render.converge(options).unwrap();
        if control.is_some() {
            std::fs::write(
                output.join(format!("frame_{i:04}.png")),
                engine.display().encode_png(&render).unwrap(),
            )
            .unwrap();
            if spp > 32 {
                let hdr = render.read_pixels(crate::api::PixelKind::Hdr).unwrap();
                std::fs::write(
                    output.join(format!("frame_{i:04}.f32")),
                    bytemuck::cast_slice(&hdr.data),
                )
                .unwrap();
            }
            if [1, 18, 24, 30].contains(&i) && spp == 32 {
                let motion = render.read_pixels(crate::api::PixelKind::Motion).unwrap();
                std::fs::write(
                    output.join(format!("motion_{i:04}.f32")),
                    bytemuck::cast_slice(&motion.data),
                )
                .unwrap();
            }
            continue;
        }
        if let Some(control) = &mut highlight_control {
            if (130..=169).contains(&i) {
                control.push(i, &render).unwrap();
                while let Some(frame) = control.drain() {
                    if frame.index == 150 {
                        let path = output.join("sparkle-disabled");
                        std::fs::create_dir_all(&path).unwrap();
                        save(&path, frame);
                    }
                }
            }
        }
        denoiser.push(i, &render).unwrap();
        #[cfg(target_os = "macos")]
        {
            use objc2_metal::MTLDevice;
            let device =
                unsafe { engine.inner.gpu.device.as_hal::<wgpu::hal::api::Metal>() }.unwrap();
            peak = peak.max(device.raw_device().currentAllocatedSize());
        }
        while let Some(f) = denoiser.drain() {
            save(&output, f);
        }
    }
    println!("Metal peak sampled after push: {peak} bytes at {width}x{height}");
    while let Some(f) = denoiser.flush().unwrap() {
        save(&output, f);
    }
}

#[cfg(target_os = "macos")]
fn recovery_fixture() -> (Engine, Render) {
    use crate::api::{Backend, RenderSettings, RenderSize};
    let engine = super::super::aov_tests::aov_engine(Backend::Hardware);
    engine.set_scene(&super::super::tests::lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            size: RenderSize::Fixed {
                width: 32,
                height: 24,
            },
            max_samples: 2,
            aovs: TemporalDenoiser::AOVS,
            ..Default::default()
        },
    )
    .unwrap();
    (engine, render)
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires a real Metal GPU"]
fn converge_rejects_failed_auxiliary_submissions() {
    use crate::api::{ConvergeOptions, DENOISE_OIDN_WEBGPU, DenoiserOptions};
    for stage in [
        "surface AOV",
        "display capture",
        "converge denoising",
        "display readback",
    ] {
        let (engine, render) = recovery_fixture();
        if stage == "converge denoising" {
            render
                .set_viewer_denoiser(Some(DenoiserOptions {
                    backend: DENOISE_OIDN_WEBGPU,
                    ..Default::default()
                }))
                .unwrap();
        }
        engine.inner.gpu.recovery_test.lock().unwrap().failed_stage = Some(stage);
        let result = render
            .converge(ConvergeOptions::new(2))
            .and_then(|_| engine.display().encode_png(&render));
        let error = result.unwrap_err();
        assert_eq!(error.status, crate::Status::ContextFailed, "{error}");
        assert!(error.to_string().contains(stage), "{error}");
        if stage != "display readback" {
            assert!(!render.converged());
            assert!(render.read_pixels(crate::api::PixelKind::Denoised).is_err());
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires a real Metal GPU"]
fn cached_temporal_frames_survive_rejected_inputs_and_exclude_failed_outputs() {
    use crate::api::ConvergeOptions;
    let (engine, render) = recovery_fixture();
    let shot = || {
        TemporalDenoiser::new(
            &engine,
            TemporalOptions {
                history_radius: HistoryRadius::Fixed(2),
                post_radius: 1,
                ..Default::default()
            },
            TemporalSpatial::None,
        )
        .unwrap()
    };
    let (mut reference, mut history, mut damaged, mut tail) = (shot(), shot(), shot(), shot());
    for i in 0..3 {
        let mut options = ConvergeOptions::new(2);
        options.sample_sequence_offset = i * 2;
        render.converge(options).unwrap();
        for denoiser in [&mut reference, &mut history, &mut damaged, &mut tail] {
            denoiser.push(i, &render).unwrap();
        }
    }
    let fail = |stage| engine.inner.gpu.recovery_test.lock().unwrap().failed_stage = Some(stage);
    fail("temporal input capture");
    assert!(
        history
            .push(3, &render)
            .unwrap_err()
            .to_string()
            .contains("temporal input capture")
    );
    fail("temporal window");
    assert!(
        damaged
            .push(3, &render)
            .unwrap_err()
            .to_string()
            .contains("temporal window")
    );
    assert!(damaged.drain().is_none());
    assert!(damaged.flush().is_err());
    fail("temporal flush");
    assert!(tail.flush().is_err());
    assert!(tail.drain().is_none());

    {
        let mut hook = engine.inner.gpu.recovery_test.lock().unwrap();
        hook.partial_sample = Some(0);
        hook.repair_failures = 13;
    }
    assert!(render.converge(ConvergeOptions::new(2)).is_err());
    assert!(history.push(3, &render).is_err());
    for i in 0..3 {
        let a = reference.flush().unwrap().unwrap();
        let b = history.flush().unwrap().unwrap();
        assert_eq!((a.index, b.index), (i, i));
        for accumulated in [true, false] {
            let bits = |f: &OfflineFrame| {
                f.read_pixels(accumulated)
                    .unwrap()
                    .data
                    .into_iter()
                    .map(f32::to_bits)
                    .collect::<Vec<_>>()
            };
            assert_eq!(bits(&a), bits(&b));
        }
    }
    assert!(history.flush().unwrap().is_none());
}

/// Use the same moving footprint and packed guide inputs as exerciseForwardMotionSeed on Web.
#[test]
#[ignore = "requires a hardware ray-query GPU"]
fn window_guides_match_web_packed_guides() {
    let engine = super::super::aov_tests::aov_engine(crate::api::Backend::Hardware);
    let gpu = engine.inner.gpu.clone();
    let size = [16, 8];
    let options = TemporalOptions {
        history_radius: HistoryRadius::Fixed(8),
        post_radius: 0,
        stabilize_sparkle: false,
        ..Default::default()
    };
    let plan = options.plan(size, 0, &gpu.device.limits()).unwrap();
    let passes = Passes::new(gpu.clone(), size, plan, 0, false, true, false, false, 0, false).unwrap();
    let mut camera = [0.; 20];
    for i in [0, 5, 10, 15, 18] {
        camera[i] = 1.;
    }
    camera[16] = 4.;
    for (frame, start, brightness) in [(0, 4, 1.), (1, 7, 3.)] {
        let data: [Vec<[f32; 4]>; 9] = std::array::from_fn(|kind| {
            (0..128)
                .map(|i| {
                    let inside = (start..start + 2).contains(&(i % 16));
                    let grey = if inside { brightness / 4. } else { 0. };
                    match kind {
                        0 => [1., 0., 0., 1.],
                        1 => [0., 0., 1., 1.],
                        2 => [0.5, 0., 0., 1.],
                        3 if i < 16 => [1.; 4],
                        3 => [grey, grey, grey, if frame == 0 { 0.5 } else { 1. }],
                        4 => [brightness, brightness, brightness, 1.],
                        5 if inside => [-3., 0., 1., 3.],
                        5 => [0.; 4],
                        6 => [f32::from_bits(if inside { 1 } else { 9 }), 0., f32::from_bits(1), 0.],
                        7 if inside => [0.5, 0.5, 0.5 + grey / 2., 1.],
                        7 => [0.; 4],
                        _ => [0., 0., 0., 1.],
                    }
                })
                .collect()
        });
        let resources = data.map(|values| {
            Resource::Buffer(gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Window guide parity input"),
                contents: bytemuck::cast_slice(&values),
                usage: wgpu::BufferUsages::STORAGE,
            }))
        });
        passes.capture(frame, &resources, &camera, &[], false);
    }
    passes.clear("rejects", 0, 64);
    passes.window(0, 0, 0, true, false);
    passes.window(0, 1, 1, true, false);
    passes.window(0, 0, 2, true, false);
    let output = ["Color", "Albedo", "Normal"].map(|name| passes.alloc(name, passes.bytes));
    passes.pack(0, 2, &passes["window"], &output);
    let albedo = passes.read::<[f32; 4]>(&output[1]).unwrap()[4 * 16 + 4];
    let normal = passes.read::<[f32; 4]>(&output[2]).unwrap()[4 * 16 + 4];
    let expected = (1. + 3. * 8. / 9.) / (1. + 8. / 9.) / 2.;
    assert!(albedo[..3].iter().all(|c| (c - expected).abs() < 1e-6));
    assert_eq!(albedo[3], 1.);
    assert_eq!(normal[..2], [0.; 2]);
    assert!((normal[2] - expected).abs() < 1e-6);
    assert_eq!(normal[3], 2.);
    println!("Packed guide parity: {}", serde_json::json!({ "albedo": albedo, "normal": normal }));
    passes.window(0, 0, 0, true, false);
    passes.window(0, 1, 1, true, true);
    passes.window(0, 0, 2, true, false);
    let checked = passes.read::<[f32; 4]>(&passes["sum"]).unwrap();
    assert_eq!(checked[4 * 16 + 4][3], 1., "lighting step accepted a tap");
}

/// Center-only supplements raise the current frame's center weight by their
/// count relative to the base count. History and its weights stay base-only.
#[test]
#[ignore = "requires a hardware ray-query GPU"]
fn supplement_samples_join_only_their_own_center() {
    let engine = super::super::aov_tests::aov_engine(crate::api::Backend::Hardware);
    let gpu = engine.inner.gpu.clone();
    let size = [16, 8];
    let pixels = 128;
    let options = TemporalOptions {
        history_radius: HistoryRadius::Fixed(1),
        post_radius: 0,
        stabilize_sparkle: false,
        ..Default::default()
    };
    let plan = options.plan(size, 0, &gpu.device.limits()).unwrap();
    let passes = Passes::new(gpu.clone(), size, plan, 0, false, false, false, false, 0, true).unwrap();
    let mut camera = [0.; 20];
    for i in [0, 5, 10, 15, 18] {
        camera[i] = 1.;
    }
    camera[16] = 4.;
    let buffer = |values: &[[f32; 4]]| {
        gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplement test input"),
            contents: bytemuck::cast_slice(values),
            usage: wgpu::BufferUsages::STORAGE,
        })
    };
    // A static surface whose base radiance is 1, 2 and 1 in three frames.
    for (frame, brightness) in [(0, 1.), (1, 2.), (2, 1.)] {
        let data: [Vec<[f32; 4]>; 9] = std::array::from_fn(|kind| {
            vec![
                match kind {
                    0 => [1., 0., 0., 1.],
                    1 => [0., 0., 1., 1.],
                    2 => [0.5, 0., 0., 1.],
                    3 => [0.5, 0.5, 0.5, 1.],
                    4 => [brightness, brightness, brightness, 1.],
                    5 => [0., 0., 1., 3.],
                    6 => [f32::from_bits(1), 0., f32::from_bits(1), 0.],
                    7 => [0.5, 0.5, 1., 1.],
                    _ => [0., 0., 0., 1.],
                };
                pixels
            ]
        });
        passes.capture(frame, &data.map(|values| Resource::Buffer(buffer(&values))), &camera, &[], false);
    }
    // The past half of frame 2 sees one neighbor at weight 1/2. Mirrored, the
    // pixel reaches two frames, so a goal of three frames at 3 spp needs 3 more.
    passes.window(2, 2, 0, true, false);
    passes.window(2, 1, 1, true, false);
    let (list, info) = passes.supplement_need(2, 3, 16, 3., 2., 0, None, false, true).unwrap();
    let info = info.unwrap();
    assert_eq!(list.len(), pixels);
    assert!(list.iter().all(|packed| packed >> 24 == 3));
    assert_eq!(info[..4], [1.5, 1.5, 0., 3.]);
    // Held counts follow the static motion: the next frame keeps floor(0.7 · 3)
    // samples on each surface although its own support meets a goal of one.
    passes.supplement_need(2, 3, 16, 3., 2., 0, Some((0.7, false)), false, false).unwrap();
    let (held, _) = passes.supplement_need(1, 3, 16, 1., 2., 0, Some((0.7, true)), false, false).unwrap();
    assert_eq!(held.len(), pixels);
    assert!(held.iter().all(|packed| packed >> 24 == 2));
    let (fresh, _) = passes.supplement_need(1, 3, 16, 1., 2., 0, Some((0.7, false)), false, false).unwrap();
    assert!(fresh.is_empty());
    // The sparse estimate visits even pixels only. Every pixel still finds a
    // visited neighbor and requests the same samples.
    passes.window_estimate(2, 2, 0, false, true);
    passes.window_estimate(2, 1, 1, false, true);
    let (sparse, _) = passes.supplement_need(2, 3, 16, 3., 2., 0, None, true, false).unwrap();
    assert_eq!(sparse.len(), pixels);
    assert!(sparse.iter().all(|packed| packed >> 24 == 3));
    // Uniform support has no edge, so a feather changes nothing.
    let (feathered, _) = passes.supplement_need(2, 3, 16, 3., 2., 2 << 16, None, false, false).unwrap();
    assert_eq!(feathered.len(), pixels);
    assert!(feathered.iter().all(|packed| packed >> 24 == 3));
    // Six supplemental samples with mean 4 at one pixel of frame 1 (base 3 spp).
    let [x, y] = [5u32, 3u32];
    let mut colors = vec![[0.; 4]; pixels];
    let mut counts = vec![[0.; 4]; pixels];
    let source = ((size[1] - 1 - y) * size[0] + x) as usize;
    colors[source] = [24., 24., 24., 6.];
    counts[source] = [0., 0., 0., 6.];
    let raw = [buffer(&colors), buffer(&counts), buffer(&counts)];
    let entries = passes.supplement_gather(&[x | y << 12 | 6 << 24], 3, &raw, None);
    let window = |i: u32, neighbors: &[u32], supplement: bool| {
        passes.clear("rejects", 0, 64);
        passes.window(i, i, 0, true, false);
        for &j in neighbors {
            passes.window(i, j, 1, true, false);
        }
        if supplement {
            passes.supplement_blend(&entries, 1);
        }
        passes.window(i, i, 2, true, false);
        passes.read::<[f32; 4]>(&passes["window"]).unwrap()
    };
    let center = window(1, &[0, 2], true);
    let at = (y * size[0] + x) as usize;
    // (2 + ½ + ½ + 2·4) / (1 + ½ + ½ + 2): the supplement weighs 6/3.
    assert!((center[at][0] - 2.75).abs() < 1e-5, "{:?}", center[at]);
    assert!((center[0][0] - 1.5).abs() < 1e-5, "{:?}", center[0]);
    // Frame 0 still reuses frame 1's base radiance at its base weight.
    let neighbor = window(0, &[1], false);
    assert!((neighbor[at][0] - 4. / 3.).abs() < 1e-5, "{:?}", neighbor[at]);
}

#[test]
#[ignore = "requires real GPU"]
fn reflection_window_accumulates_a_translating_highlight_in_both_directions() {
    let engine =
        super::super::aov_tests::aov_engine(if std::env::var_os("MUTRACER_AOV_HWRT").is_some() {
            crate::api::Backend::Hardware
        } else {
            crate::api::Backend::Software
        });
    let gpu = engine.inner.gpu.clone();
    let size = [16, 8];
    let pixels = 128;
    let options = TemporalOptions {
        history_radius: HistoryRadius::Fixed(1),
        post_radius: 0,
        stabilize_sparkle: false,
        reflection_motion: true,
        ..Default::default()
    };
    let plan = options.plan(size, 0, &gpu.device.limits()).unwrap();
    let passes = Passes::new(gpu.clone(), size, plan, 0, false, false, true, false, 0, false).unwrap();
    let mut camera = [0.; 20];
    for i in [0, 5, 10, 15, 18] {
        camera[i] = 1.;
    }
    camera[16] = 4.;
    let buffer = |values: &[[f32; 4]]| {
        gpu.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Synthetic reflection window input"),
                contents: bytemuck::cast_slice(values),
                usage: wgpu::BufferUsages::STORAGE,
            })
    };
    for (frame, at, intensity) in [(0, 8, 3.), (1, 6, 1.)] {
        let color: Vec<_> = (0..pixels)
            .map(|i| {
                let highlight = if [1, 2, 3].contains(&(i / 16)) {
                    10
                } else {
                    at
                };
                let v = if i % 16 == highlight { intensity } else { 0. };
                [v, v, v, 1.]
            })
            .collect();
        let mut records = vec![[0.; 4]; pixels * 6];
        for (i, entry) in records[4 * pixels..].chunks_exact_mut(2).enumerate() {
            entry[0] = [
                f32::from_bits(1),
                f32::from_bits(2),
                6.,
                f32::from_bits(0x3c000000),
            ];
            // Center capture is bottom-first. The dielectric and one metal
            // row have invalid optical motion. Another has valid zero motion.
            entry[1] = if frame == 0 || [5, 6].contains(&(i / 16)) {
                [1e20; 4]
            } else if i / 16 == 4 {
                [0.; 4]
            } else {
                [2., 0., 2., 0.]
            };
        }
        let guides = [
            vec![[1., 0., 0., 1.]; pixels],
            vec![[0., 0., 1., 1.]; pixels],
            (0..pixels)
                .map(|i| [0., if i / 16 == 1 { 0. } else { 1. }, 0., 1.])
                .collect(),
            vec![[1.; 4]; pixels],
            color.clone(),
            vec![[0., 0., 1., 3.]; pixels],
            vec![[f32::from_bits(1), 0., 0., 0.]; pixels],
            vec![[0.5, 0.5, 1., 1.]; pixels],
            vec![[0., 0., 0., 1.]; pixels],
        ]
        .map(|values| Resource::Buffer(buffer(&values)));
        passes.capture(frame, &guides, &camera, &[], false);
        let reflected: Vec<_> = color.chunks_exact(16).rev().flatten().copied().collect();
        passes.capture_reflections(
            frame,
            1,
            buffer(&reflected),
            buffer(&records),
            &guides[3],
            &guides[4],
        );
        if frame == 1 {
            assert!(!passes.camera_cut(frame, &guides[8]).unwrap());
        }
    }
    for (frame, at, expected, current) in [(0, 8, 7. / 3., 3.), (1, 6, 5. / 3., 1.)] {
        passes.window(frame, frame, 0, true, false);
        passes.window(frame, 1 - frame, 1, true, false);
        passes.window(frame, frame, 2, true, false);
        let result = passes.read::<[f32; 4]>(&passes["window"]).unwrap();
        for (index, expected) in [
            (4 * 16 + at, expected),
            (3 * 16 + 10, expected),
            (2 * 16 + 10, current),
            (16 + 10, expected),
        ] {
            let pixel = result[index];
            assert!(
                pixel[..3].iter().all(|v| (v - expected).abs() < 1e-6),
                "frame {frame}, pixel {index}: expected {expected}, got {pixel:?}"
            );
            assert_eq!(pixel[3], 1.);
        }
    }
}

/// A rough metal surface window with a mirror reflection lobe whose virtual
/// image moves two pixels per frame while the surface is static. With
/// `garbage`, every history slot and window buffer first holds stale values.
fn curved_mirror_window(
    gpu: &crate::GpuDevice,
    reflection_motion: bool,
    curvature: f32,
    garbage: bool,
) -> [Vec<[f32; 4]>; 2] {
    let size = [16, 8];
    let pixels = 128;
    let buffer = |values: &[[f32; 4]]| {
        gpu.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Synthetic curved reflection input"),
                contents: bytemuck::cast_slice(values),
                usage: wgpu::BufferUsages::STORAGE,
            })
    };
    let options = TemporalOptions {
        history_radius: HistoryRadius::Fixed(1),
        post_radius: 0,
        stabilize_sparkle: false,
        reflection_motion,
        ..Default::default()
    };
    let plan = options.plan(size, 0, &gpu.device.limits()).unwrap();
    let passes = Passes::new(
        gpu.clone(),
        size,
        plan,
        0,
        false,
        false,
        reflection_motion,
        false,
        0,
        false,
    )
    .unwrap();
    let mut camera = [0.; 20];
    for i in [0, 5, 10, 15, 18] {
        camera[i] = 1.;
    }
    // Four pixels per world unit, so the curvature is in inverse world units.
    camera[16] = 4.;
    let normals: Vec<_> = (0..pixels)
        .map(|i| {
            let angle = (curvature * ((i % 16) as f32 - 8.) / 4.).clamp(-1.5, 1.5);
            [angle.sin(), 0., angle.cos(), 1.]
        })
        .collect();
    let capture = |frame: u32, at: usize, stale: bool| {
        let value = |i: usize| match (stale, i % 16 == at) {
            (true, _) => f32::NAN,
            (false, true) => 3.,
            (false, false) => 0.5,
        };
        let color: Vec<_> = (0..pixels)
            .map(|i| {
                let v = value(i);
                [v, v, v, 1.]
            })
            .collect();
        let mut records = vec![[0.; 4]; pixels * 6];
        for entry in records[4 * pixels..].chunks_exact_mut(2) {
            entry[0] = [
                f32::from_bits(1),
                f32::from_bits(2),
                if stale { 0.5 } else { 6. },
                f32::from_bits(0x3c000000),
            ];
            entry[1] = if frame == 0 && !stale {
                [1e20; 4]
            } else {
                [2., 0., 2., 0.]
            };
        }
        let guides = [
            vec![[1., 0., 0., 1.]; pixels],
            normals.clone(),
            vec![[0.3, 1., 0., 1.]; pixels],
            vec![[1.; 4]; pixels],
            color.clone(),
            vec![[0., 0., 1., 3.]; pixels],
            vec![[f32::from_bits(1), 0., 0., 0.]; pixels],
            vec![[0.5, 0.5, 1., 1.]; pixels],
            vec![[0., 0., 0., 1.]; pixels],
        ]
        .map(|values| Resource::Buffer(buffer(&values)));
        passes.capture(frame, &guides, &camera, &[], false);
        if reflection_motion {
            let reflected: Vec<_> = color.chunks_exact(16).rev().flatten().copied().collect();
            passes.capture_reflections(
                frame,
                1,
                buffer(&reflected),
                buffer(&records),
                &guides[3],
                &guides[4],
            );
        }
    };
    if garbage {
        for frame in 0..plan.slots() {
            capture(frame, 0, true);
        }
        let stale = vec![[f32::NAN; 4]; pixels];
        for name in ["window", "sum"]
            .into_iter()
            .chain(reflection_motion.then_some("reflectedTotal"))
        {
            passes.write(name, 0, &stale);
        }
    }
    for (frame, at) in [(0, 8), (1, 6)] {
        capture(frame, at, false);
    }
    [0, 1].map(|frame| {
        passes.window(frame, frame, 0, true, false);
        passes.window(frame, 1 - frame, 1, true, false);
        passes.window(frame, frame, 2, true, false);
        passes.read::<[f32; 4]>(&passes["window"]).unwrap()
    })
}

fn gpu_test_engine() -> Engine {
    super::super::aov_tests::aov_engine(if std::env::var_os("MUTRACER_AOV_HWRT").is_some() {
        crate::api::Backend::Hardware
    } else {
        crate::api::Backend::Software
    })
}

#[test]
#[ignore = "requires real GPU"]
fn reflection_window_falls_back_to_the_surface_window_on_curved_mirrors() {
    let engine = gpu_test_engine();
    let gpu = &engine.inner.gpu;
    let differs = |a: &[[f32; 4]], b: &[[f32; 4]]| {
        (7..=9).any(|x| (0..3).any(|c| (a[3 * 16 + x][c] - b[3 * 16 + x][c]).abs() > 1e-3))
    };
    // On a flat mirror the virtual image replaces the surface fallback.
    let flat = curved_mirror_window(gpu, true, 0., false);
    let surface = curved_mirror_window(gpu, false, 0., false);
    assert!(differs(&flat[1], &surface[1]));
    // With a three-per-unit curvature the planar landing would miss by more
    // than a pixel, so both frames use the default surface window.
    let curved = curved_mirror_window(gpu, true, 3., false);
    let surface = curved_mirror_window(gpu, false, 3., false);
    for frame in 0..2 {
        for x in 7..=9 {
            let (a, b) = (curved[frame][3 * 16 + x], surface[frame][3 * 16 + x]);
            assert!(
                (0..4).all(|c| (a[c] - b[c]).abs() < 1e-5),
                "frame {frame}, x {x}: reflection motion {a:?}, surface window {b:?}"
            );
        }
    }
}

#[test]
#[ignore = "requires real GPU"]
fn reflection_window_ignores_unwritten_history() {
    let engine = gpu_test_engine();
    let gpu = &engine.inner.gpu;
    for (reflection_motion, curvature) in [(true, 0.), (true, 3.), (false, 0.)] {
        let fresh = curved_mirror_window(gpu, reflection_motion, curvature, false);
        let stale = curved_mirror_window(gpu, reflection_motion, curvature, true);
        for frame in 0..2 {
            assert!(
                fresh[frame]
                    .iter()
                    .zip(&stale[frame])
                    .all(|(a, b)| a.iter().zip(b).all(|(a, b)| a.to_bits() == b.to_bits())),
                "reflection motion {reflection_motion}, curvature {curvature}, frame {frame}"
            );
        }
    }
}

#[test]
#[ignore = "requires a real hardware ray-query GPU"]
fn offline_sample_tiles_count_each_pixel_and_reset_for_uniform_convergence() {
    use crate::api::{Backend, ConvergeOptions, RenderSettings, RenderSize};

    let engine = super::super::aov_tests::aov_engine(Backend::Hardware);
    engine.set_scene(&super::super::tests::lit_scene()).unwrap();
    engine.update().unwrap();
    let (width, height) = (10, 6);
    let render = Render::new(
        &engine,
        RenderSettings {
            size: RenderSize::Fixed { width, height },
            max_samples: 3,
            ..Default::default()
        },
    )
    .unwrap();
    let counts = || {
        let ([_, _, normal], _, _) =
            crate::context::denoise_buffers(render.audit_context_id().unwrap()).unwrap();
        let gpu = &engine.inner.gpu;
        let bytes = gpu
            .queue
            .read_buffer(&gpu.device, normal.slice(..))
            .unwrap();
        bytemuck::pod_collect_to_vec::<u8, f32>(&bytes)
            .chunks_exact(4)
            .map(|value| value[3] as u32)
            .collect::<Vec<_>>()
    };
    let tiles = [3, 4, 5, 6, 7, 8];
    let mut options = ConvergeOptions::new(3);
    options.sample_sequence_offset = 32;
    render
        .experimental_converge_tiles(options, tiles.to_vec())
        .unwrap();
    assert_eq!(render.backend().unwrap().0, Backend::Hardware);
    let expected = (0..height)
        .rev()
        .flat_map(|y| (0..width).map(move |x| tiles[(y / 4 * width.div_ceil(4) + x / 4) as usize]))
        .collect::<Vec<_>>();
    assert_eq!(counts(), expected);

    render.converge(ConvergeOptions::new(3)).unwrap();
    assert_eq!(counts(), vec![3; (width * height) as usize]);
}

#[test]
#[ignore = "requires a real hardware ray-query GPU"]
fn offline_window_rejects_unexplained_bright_history_behind_foreground() {
    use crate::api::Backend;
    let engine = super::super::aov_tests::aov_engine(Backend::Hardware);
    let gpu = &engine.inner.gpu;
    let options = TemporalOptions {
        history_radius: HistoryRadius::Fixed(1),
        post_radius: 0,
        stabilize_sparkle: false,
        ..Default::default()
    };
    let mut filter = TemporalDenoiser::new(&engine, options, TemporalSpatial::None).unwrap();
    let size = [11, 4];
    let mut camera = [0.; 20];
    for i in [0, 5, 10, 15, 18] {
        camera[i] = 1.;
    }
    for index in 0..2 {
        let guides = std::array::from_fn(|channel| {
            let pixels = (0..size[0] * size[1])
                .flat_map(|pixel| {
                    let x = pixel % size[0];
                    let foreground = index == 0 && matches!(x, 6 | 9);
                    let depth = if foreground { 0.5 } else { 1. };
                    let value = if index == 0 && x == 6 {
                        48.
                    } else if x == 1 || index == 0 && matches!(x, 3 | 5 | 8) {
                        24.
                    } else {
                        0.2
                    };
                    match channel {
                        0 => [depth, 0., 0., 1.],
                        1 => [0., 0., 1., 1.],
                        2 => [0.7, 0., 0., 1.],
                        3 => [0.3, 0.3, 0.3, 1.],
                        4 => [value, value, value, 1.],
                        5 => [0., 0., 1., 3.],
                        6 => [
                            f32::from_bits(1 + u32::from(foreground)),
                            0.,
                            f32::from_bits(1),
                            0.,
                        ],
                        _ => [0., 0., 1., 1.],
                    }
                })
                .collect::<Vec<f32>>();
            gpu.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Bright history at an occlusion edge"),
                    contents: bytemuck::cast_slice(&pixels),
                    usage: wgpu::BufferUsages::STORAGE,
                })
        });
        filter
            .push_capture(
                index,
                Capture {
                    raw: false,
                    reflections: None,
                    check_camera: false,
                    size,
                    samples: 3,
                    sample_tiles: None,
                    camera,
                    display: Default::default(),
                    revisions: Vec::new(),
                    scene_key: 0,
                    lighting_key: 0,
                    emissions: Default::default(),
                    guides,
                },
            )
            .unwrap();
    }
    assert_eq!(filter.drain().unwrap().index, 0);
    let frame = filter.flush().unwrap().unwrap();
    assert_eq!(frame.index, 1);
    let pixels = frame.read_pixels(true).unwrap().data;
    assert_eq!(pixels[1 * 4], 24.);
    assert!(
        pixels[3 * 4] > 5.,
        "Retain the bright tap away from the edge"
    );
    assert!((pixels[5 * 4] - 0.2).abs() < 0.001);
    assert!(
        pixels[8 * 4] > 5.,
        "Retain the bright tap next to a dim foreground"
    );
}

#[test]
fn emission_steps_distinguish_cuts_from_small_or_dim_changes() {
    let before = BTreeMap::from([(1, [0.5, 2., 0.8]), (2, [60., 46., 25.])]);
    let gradual = BTreeMap::from([(1, [0.4, 1.9, 0.7]), (2, [55., 43., 22.])]);
    let slide = BTreeMap::from([(1, [2., 1.2, 0.3]), (2, [60., 46., 25.])]);
    let off = BTreeMap::from([(2, [60., 46., 25.])]);
    assert!(!has_emission_step(&before, &gradual));
    assert!(has_emission_step(&before, &slide));
    assert!(has_emission_step(&before, &off));
    assert!(has_emission_step(&off, &before));
    assert!(!has_emission_step(
        &BTreeMap::new(),
        &BTreeMap::from([(1, [0.001, 0., 0.])])
    ));
}
