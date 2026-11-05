use super::*;
pub(super) fn plane() -> Vec<u8> {
    let mut w: Vec<_> = tests::lit_scene()
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    w[5] = 1;
    w[6] = 1;
    for (i, v) in [-10f32, 10., 0., 10., 10., 0., -10., -10., 0., 10., -10., 0.]
        .iter()
        .enumerate()
    {
        w[192 + i] = v.to_bits();
    }
    w[204..210].copy_from_slice(&[0, 2, 1, 2, 3, 1]);
    for (i, v) in [1f32, 1., 1., 0.4, 0.2].iter().enumerate() {
        w[84 + i] = v.to_bits();
    }
    let mut camera = Camera::default();
    camera.world_matrix[14] = 4.;
    camera.far_clip = 100.;
    w[160..192].copy_from_slice(
        &camera
            .to_bytes()
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>(),
    );
    w[24] = w.len() as u32;
    w.push(0xfffffffe);
    w[25] = w.len() as u32;
    w.push(0x800001ff);
    w[1] = w.len() as u32;
    w.into_iter().flat_map(u32::to_le_bytes).collect()
}
#[test]
fn aov_display_options_validate_ranges_without_a_device() {
    let defaults = DisplaySettings::default();
    for aov in [
        AovDisplayOptions {
            depth_range: [2., 1.],
            ..Default::default()
        },
        AovDisplayOptions {
            position_scale: 0.,
            ..Default::default()
        },
        AovDisplayOptions {
            motion_scale: f32::NAN,
            ..Default::default()
        },
    ] {
        assert!(aov.validate().is_err());
    }
    assert_eq!(Channel::Depth.aov_kind(), Some(PixelKind::Depth));
    assert_eq!(Channel::Motion.aov_kind(), Some(PixelKind::Motion));
    assert_eq!(Channel::Albedo.aov_kind(), None);
    assert_eq!(defaults.aov.depth_range, [0., 10.]);
}
fn display_channels(backend: Backend) {
    let _lock = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = super::aov_tests::aov_engine(backend);
    engine.display().set_size(48, 32).unwrap();
    engine.set_scene(&plane()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 4,
            bounces: 1,
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let before = render.read_pixels(PixelKind::Hdr).unwrap();
    let display = engine.display();
    let mut settings = display.settings();
    settings.channel = Channel::Depth;
    display.set_settings(settings).unwrap();
    assert_eq!(
        display.read_rgba8(&render).unwrap_err().status,
        Status::InvalidState
    );
    let mut options = render.settings().unwrap();
    options.aovs = 127;
    options.aov_samples = 4;
    render.set_settings(options).unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    assert_eq!(render.backend().unwrap().0, backend);
    let id = render.read_pixels(PixelKind::Id).unwrap();
    let mut displayed = Vec::new();
    for channel in [
        Channel::Depth,
        Channel::Position,
        Channel::Roughness,
        Channel::DiffuseAlbedo,
        Channel::SpecularAlbedo,
        Channel::Id,
        Channel::Motion,
    ] {
        settings.channel = channel;
        display.set_settings(settings).unwrap();
        display.present(&render).unwrap();
        let (_, _, pixels) = display.read_rgba8(&render).unwrap();
        if channel == Channel::Depth {
            assert!(
                pixels
                    .chunks_exact(4)
                    .all(|p| (p[0] as i32 - 102).abs() <= 1
                        && p[0] == p[1]
                        && p[1] == p[2]
                        && p[3] == 255)
            );
        }
        if channel == Channel::Roughness {
            assert!(
                pixels
                    .chunks_exact(4)
                    .all(|p| (p[0] as i32 - 102).abs() <= 1
                        && (p[1] as i32 - 51).abs() <= 1
                        && p[2] == 0)
            );
        }
        if channel == Channel::Motion {
            assert!(pixels.iter().all(|v| *v == 0));
        }
        displayed.push((format!("{channel:?}"), pixels[..4].to_vec()));
        assert_eq!(render.read_pixels(PixelKind::Id).unwrap(), id);
        assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), before);
        assert_eq!(render.samples(), 4);
    }
    settings.channel = Channel::Depth;
    settings.aov.depth_range = [0., 8.];
    settings.tone_mapping_exposure = 50.;
    settings.bloom_intensity = 3.;
    settings.vignette = 1.;
    display.set_settings(settings).unwrap();
    let (_, _, pixels) = display.read_rgba8(&render).unwrap();
    assert!(pixels[..3].iter().all(|v| (*v as i32 - 128).abs() <= 1));
    assert_eq!(pixels[3], 255);
    let hdr = display
        .compose_mode(&render, false, true)
        .unwrap()
        .unwrap()
        .texture;
    let gpu = &engine.inner.gpu;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 256,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        hdr.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
    let index = gpu.queue.submit([encoder.finish()]);
    let (tx, rx) = std::sync::mpsc::channel();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        tx.send(r).unwrap();
    });
    gpu.device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(index),
            timeout: Some(std::time::Duration::from_secs(10)),
        })
        .unwrap();
    rx.recv().unwrap().unwrap();
    {
        let bytes = buffer.get_mapped_range(..).unwrap();
        let bits = u16::from_le_bytes(bytes[..2].try_into().unwrap());
        let value = (1024 + (bits & 1023)) as f32 * 2f32.powi(((bits >> 10) & 31) as i32 - 25);
        assert!((value - 0.21404114).abs() < 0.001);
    }
    buffer.unmap();
    let mut bad = settings;
    bad.aov.depth_range = [2., 1.];
    assert_eq!(
        display.set_settings(bad).unwrap_err().status,
        Status::InvalidArgument
    );
    assert_eq!(display.settings(), settings);
    settings.channel = Channel::Id;
    settings.aov.id_component = AovIdComponent::Primitive;
    display.set_settings(settings).unwrap();
    let (_, _, ids) = display.read_rgba8(&render).unwrap();
    let colors: std::collections::HashSet<_> =
        ids.chunks_exact(4).map(|p| p[..3].to_vec()).collect();
    assert_eq!(colors.len(), 2);
    if let Ok(dir) = std::env::var("MUTRACER_AOV_DISPLAY_EVIDENCE") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/native-{backend:?}.json"),
            serde_json::to_vec(&displayed).unwrap(),
        )
        .unwrap();
    }
}
#[test]
#[ignore = "requires real GPU"]
fn software_aov_display_preserves_raw_samples_and_maps_all_channels() {
    display_channels(Backend::Software);
}
#[test]
#[ignore = "requires real hardware ray-query GPU"]
fn hardware_aov_display_preserves_raw_samples_and_maps_all_channels() {
    display_channels(Backend::Hardware);
}
