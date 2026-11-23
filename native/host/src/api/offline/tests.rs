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
                    check_camera: j["frameSequence"].is_number(),
                    size,
                    samples: j["samples"].as_u64().unwrap() as u32,
                    camera,
                    display,
                    revisions,
                    scene_key: j["sceneRevision"].as_u64().unwrap_or(0),
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
