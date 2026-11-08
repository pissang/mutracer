use super::*;
use crate::*;

pub(super) fn set(input: &mut [u8], word: usize, value: u32) {
    input[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
fn offset(input: &[u8], word: usize) -> usize {
    u32::from_le_bytes(input[word * 4..word * 4 + 4].try_into().unwrap()) as usize
}
pub(super) fn plane(thin: bool, orthographic: bool, normal_mapped: bool) -> Vec<u8> {
    let mut input = scene::tests::input();
    let geometry = offset(&input, layout::header::GEOMETRY_OFFSET);
    let material = offset(&input, layout::header::MATERIAL_OFFSET);
    let camera = offset(&input, layout::header::CAMERA_OFFSET);
    let positions = offset(&input, geometry + layout::geometry::POSITION);
    for (i, v) in [-4f32, -4., -3., 4., -4., -3., 0., 4., -3.]
        .iter()
        .enumerate()
    {
        set(&mut input, positions + i, v.to_bits());
    }
    for (i, v) in [0.25f32, 0.5, 0.75, 1.0].iter().enumerate() {
        set(&mut input, 16 + i, v.to_bits());
    }
    set(
        &mut input,
        material + layout::material::TRANSMISSION,
        if thin { 1f32 } else { 0f32 }.to_bits(),
    );
    set(
        &mut input,
        material + layout::material::THIN_WALLED,
        thin as u32,
    );
    if orthographic {
        set(&mut input, camera + layout::camera::PROJECTION, 1);
        for (i, v) in [(4, -2f32), (5, 2f32), (6, -2f32), (7, 2f32)] {
            set(&mut input, camera + i, v.to_bits());
        }
    }
    // A finite sphere light makes path RNG changes observable in radiance.
    let offset = input.len() / 4;
    input.resize(input.len() + layout::light::WORDS * 4, 0);
    set(
        &mut input,
        layout::header::LENGTH,
        (offset + layout::light::WORDS) as u32,
    );
    set(&mut input, layout::header::LIGHT_COUNT, 1);
    set(&mut input, layout::header::LIGHT_OFFSET, offset as u32);
    set(&mut input, offset + layout::light::TYPE, 1);
    for (i, value) in [
        (layout::light::COLOR, 0.9f32),
        (layout::light::COLOR + 1, 0.7),
        (layout::light::COLOR + 2, 0.5),
        (layout::light::INTENSITY, 20.),
        (layout::light::SIZE, 0.4),
    ] {
        set(&mut input, offset + i, value.to_bits());
    }
    for i in [0, 5, 10, 15] {
        set(
            &mut input,
            offset + layout::light::TRANSFORM + i,
            1f32.to_bits(),
        );
    }
    set(
        &mut input,
        offset + layout::light::TRANSFORM + 12,
        (-2f32).to_bits(),
    );
    set(
        &mut input,
        offset + layout::light::TRANSFORM + 13,
        1f32.to_bits(),
    );
    if normal_mapped {
        let uv = input.len() / 4;
        for value in [0f32, 0., 1., 0., 0.5, 1.] {
            input.extend_from_slice(&value.to_le_bytes());
        }
        set(&mut input, geometry + layout::geometry::UV, uv as u32);
        let texture = input.len() / 4;
        input.resize(input.len() + layout::texture::WORDS * 4, 0);
        set(&mut input, layout::header::TEXTURE_COUNT, 1);
        set(&mut input, layout::header::TEXTURE_OFFSET, texture as u32);
        set(&mut input, texture, 1);
        set(&mut input, texture + 1, 1);
        set(
            &mut input,
            texture + layout::texture::PIXELS,
            (texture + layout::texture::WORDS) as u32,
        );
        set(
            &mut input,
            texture + layout::texture::UV_SCALE,
            1f32.to_bits(),
        );
        set(
            &mut input,
            texture + layout::texture::UV_SCALE + 1,
            1f32.to_bits(),
        );
        input.extend_from_slice(&[191, 128, 255, 255]);
        set(&mut input, material + layout::material::NORMAL_MAP, 0);
        let length = input.len() / 4;
        set(&mut input, 1, length as u32);
    }
    input
}
pub(super) fn values(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}
pub(super) fn camera_metadata(camera: &[u8], ortho: bool) -> CameraSnapshot {
    let f = values(camera);
    let world = glam::Mat4::from_cols_slice(&f[16..32]);
    let vp_inverse = glam::Mat4::from_cols_slice(&f[..16]);
    let view = world.inverse();
    let projection_inverse = view * vp_inverse;
    CameraSnapshot {
        view: view.to_cols_array(),
        projection: projection_inverse.inverse().to_cols_array(),
        view_inverse: world.to_cols_array(),
        projection_inverse: projection_inverse.to_cols_array(),
        near: 0.1,
        far: 100.,
        kind: if ortho {
            Projection::Orthographic
        } else {
            Projection::Perspective
        },
        aperture_radius: 0.0,
    }
}
pub(super) use crate::test_support::read_texture;

#[test]
#[ignore = "requires real Vulkan and DX12 GPUs; run npm run native:ci:gpu"]
fn first_surface_reflectance_matches_independent_hemisphere_quadrature() {
    let _lock = crate::abi_test_lock();
    for backend in if cfg!(target_os = "macos") {
        vec![wgpu::Backends::METAL]
    } else {
        vec![wgpu::Backends::VULKAN, wgpu::Backends::DX12]
    } {
        let Some(gpu) = test_gpu(backend) else {
            continue;
        };
        let cases: [(f32, f32, f32, f32, f32, bool); 9] = [
            (0.3, 0., 1., 0., 0., false),
            (0.04, 0., 1.5, 0., 0., false),
            (0.3, 0., 1.1, 0., 0., false),
            (0.3, 0., 2.5, 0., 0.9, false),
            (0.6, 0.5, 1.5, 0., 0., false),
            (1., 1., 1.5, 0., 0.7, false),
            (0.15, 1., 1.5, 0., 0., false),
            (0.3, 0., 1.5, 1., 0., true),
            (0.6, 0., 1.5, 1., 0.7, false),
        ];
        for (case, (roughness, metalness, ior, transmission, angle, thin)) in
            cases.into_iter().enumerate()
        {
            let mut input = plane(thin, false, false);
            let geometry = offset(&input, layout::header::GEOMETRY_OFFSET);
            let positions = offset(&input, geometry + layout::geometry::POSITION);
            let material = offset(&input, layout::header::MATERIAL_OFFSET);
            let camera = offset(&input, layout::header::CAMERA_OFFSET);
            for (i, value) in [-400f32, -400., -3., 400., -400., -3., 0., 400., -3.]
                .into_iter()
                .enumerate()
            {
                set(&mut input, positions + i, value.to_bits());
            }
            for (i, value) in [
                (0, 0.15f32),
                (1, 0.5),
                (2, 0.9),
                (3, roughness),
                (4, metalness),
                (5, transmission),
                (6, ior),
            ] {
                set(&mut input, material + i, value.to_bits());
            }
            for (i, value) in glam::Mat4::from_rotation_y(angle)
                .to_cols_array()
                .into_iter()
                .enumerate()
            {
                set(
                    &mut input,
                    camera + layout::camera::TRANSFORM + i,
                    value.to_bits(),
                );
            }
            let (description, assets) =
                scene::prepare_frame_inputs(&input, &settings::RenderSettings::default()).unwrap();
            let source = String::from_utf8(
                assets[&AssetId::Packet(layout::resource::SOFTWARE_FRAME_SHADER)].clone(),
            )
            .unwrap();
            let reference_source = source
                .replace("fn mtFrameReflectance(", "fn mtFrameReflectanceBaseline(")
                + include_str!("reflectance-oracle.wgsl");
            let camera = &assets[&AssetId::Packet(layout::resource::CAMERA)];
            let trace = &assets[&AssetId::Packet(layout::resource::TRACE_UNIFORM)];
            let (scene, _) =
                GpuScene::new(description, &RenderOptions::default(), &assets, gpu.clone())
                    .unwrap();
            let mut metadata = super::tests::metadata();
            metadata.camera = camera_metadata(camera, false);
            let run = |source| {
                let producer = FrameProducer::new(&scene, source).unwrap();
                let mut history = GpuFrameHistory::new(gpu.frame_device, [8, 8]);
                let (frame, _) = producer
                    .produce(
                        &scene,
                        &mut history,
                        metadata.clone(),
                        GeometrySnapshot::default(),
                        camera,
                        trace,
                    )
                    .unwrap();
                let read = |guide| {
                    values(&read_texture(
                        &gpu,
                        &frame.current.resources.guide(guide).unwrap().texture,
                    ))
                };
                (read(Guide::DiffuseAlbedo), read(Guide::SpecularAlbedo))
            };
            let actual = run(source);
            let reference = run(reference_source);
            let mut errors = [0f32; 2];
            for (channel, (actual, expected)) in
                [(&actual.0, &reference.0), (&actual.1, &reference.1)]
                    .into_iter()
                    .enumerate()
            {
                for (a, b) in actual.iter().zip(expected) {
                    assert!(a.is_finite() && b.is_finite());
                    errors[channel] = errors[channel].max((a - b).abs());
                }
                assert!(
                    errors[channel] < 0.01,
                    "case {case}, channel {channel}, reflectance integration error {}",
                    errors[channel]
                );
            }
            if case == 0 {
                // With eta=1 the smooth-diffuse material is Lambertian. This
                // additional closed-form oracle does not evaluate shader BSDFs.
                for pixel in actual.0.chunks_exact(4) {
                    for (value, expected) in pixel[..3].iter().zip([0.15f32, 0.5, 0.9]) {
                        assert!(
                            (value - expected).abs() < 0.015,
                            "Lambertian reflectance {value}, expected {expected}; pixel {pixel:?}"
                        );
                    }
                }
                assert!(actual.1.iter().all(|v| v.abs() < 1e-5));
            }
            println!(
                "reflectance {:?} case {case}: diffuse/specular max absolute error {errors:?}",
                gpu.info.backend
            );
            if let Ok(root) = std::env::var("MUTRACER_FRAME_EVIDENCE") {
                let directory =
                    Path::new(&root).join(format!("reflectance-{:?}-{case}", gpu.info.backend));
                fs::create_dir_all(&directory).unwrap();
                for (name, data) in [
                    ("diffuse.f32", &actual.0),
                    ("specular.f32", &actual.1),
                    ("reference-diffuse.f32", &reference.0),
                    ("reference-specular.f32", &reference.1),
                ] {
                    fs::write(
                        directory.join(name),
                        data.iter()
                            .flat_map(|v| v.to_le_bytes())
                            .collect::<Vec<_>>(),
                    )
                    .unwrap();
                }
                fs::write(directory.join("parameters.json"), serde_json::to_vec_pretty(&json!({"adapter":format!("{:?}",gpu.info),"roughness":roughness,"metalness":metalness,"ior":ior,"transmission":transmission,"angle":angle,"thin":thin,"maxAbsoluteErrors":errors,"baselineSamples":256,"oracleGrid":[128,128]})).unwrap()).unwrap();
            }
        }
    }
}

#[test]
fn first_surface_record_and_resolve_have_matching_layouts() {
    assert_eq!(size_of::<FramePixelRecord>(), 240);
    assert_eq!(std::mem::offset_of!(FramePixelRecord, identity), 128);
    assert_eq!(
        std::mem::offset_of!(FramePixelRecord, unclamped_radiance),
        160
    );
    let module =
        naga::front::wgsl::parse_str(&crate::postprocess::sources().unwrap().frame_resolve)
            .unwrap();
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .unwrap();
    let record = module
        .types
        .iter()
        .find_map(|(_, ty)| (ty.name.as_deref() == Some("FramePixel")).then_some(ty))
        .unwrap();
    match &record.inner {
        naga::TypeInner::Struct { span, members } => {
            assert_eq!(*span as usize, size_of::<FramePixelRecord>());
            assert_eq!(
                members[8].offset as usize,
                std::mem::offset_of!(FramePixelRecord, identity)
            );
        }
        _ => panic!("FramePixel must be a struct"),
    }
}

pub(super) fn test_gpu(backend: wgpu::Backends) -> Option<GpuDevice> {
    if cfg!(target_os = "macos") && backend != wgpu::Backends::METAL
        || cfg!(target_os = "linux") && backend == wgpu::Backends::DX12
    {
        return None;
    }
    let mut descriptor = wgpu::InstanceDescriptor {
        backends: backend,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    };
    if backend == wgpu::Backends::DX12 {
        descriptor.backend_options.dx12.shader_compiler = wgpu::Dx12Compiler::DynamicDxc {
            dxc_path: std::env::var("MUTRACER_TEST_DXC")
                .unwrap_or_else(|_| "dxcompiler.dll".into()),
        };
    }
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .unwrap();
    assert!(!matches!(
        adapter.get_info().device_type,
        wgpu::DeviceType::Cpu | wgpu::DeviceType::Other
    ));
    let gpu = GpuDevice::for_adapter(&adapter, 0).unwrap();
    println!("first-surface producer: {:?}", gpu.info);
    Some(gpu)
}

#[test]
#[ignore = "requires real Vulkan and DX12 GPUs; run npm run native:ci:gpu"]
fn real_frame_inputs_match_plane_oracle_and_preserve_path_rng() {
    let _lock = crate::abi_test_lock();
    for backend in if cfg!(target_os = "macos") {
        vec![wgpu::Backends::METAL]
    } else {
        vec![wgpu::Backends::VULKAN, wgpu::Backends::DX12]
    } {
        let Some(gpu) = test_gpu(backend) else {
            continue;
        };
        for (thin, ortho, normal_mapped) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            for pattern in 0..3 {
                let input = plane(thin, ortho, normal_mapped);
                let settings = settings::RenderSettings {
                    sampling_pattern: pattern,
                    ..Default::default()
                };
                let (description, assets) = scene::prepare_frame_inputs(&input, &settings).unwrap();
                let source = String::from_utf8(
                    assets[&AssetId::Packet(layout::resource::SOFTWARE_FRAME_SHADER)].clone(),
                )
                .unwrap();
                // Same uniform jitter and integrator, with recording disabled. A/B
                // executes both shaders on the GPU; it does not inspect source text.
                let control_source = source.replace("  mtFrameSurface(si, ma, ray);\n", "");
                let camera = &assets[&AssetId::Packet(layout::resource::CAMERA)];
                let trace = &assets[&AssetId::Packet(layout::resource::TRACE_UNIFORM)];
                let (scene, mut target) =
                    GpuScene::new(description, &RenderOptions::default(), &assets, gpu.clone())
                        .unwrap();
                scene.add_samples(&mut target, 1).unwrap();
                let raw_before = scene.read_target(&target, 0).unwrap();
                if !thin && !ortho && !normal_mapped && pattern == 0 {
                    // A rejected PSO must not become a successful cache hit or
                    // leave a validation scope open on the shared device.
                    for _ in 0..2 {
                        assert!(FrameProducer::new(&scene, "invalid WGSL".into()).is_err());
                    }
                }
                let producer = FrameProducer::new(&scene, source).unwrap();
                let control = FrameProducer::new(&scene, control_source).unwrap();
                let mut m = super::tests::metadata();
                m.camera = camera_metadata(camera, ortho);
                m.seed = 12345;
                m.sample_index = 7;
                let mut history = GpuFrameHistory::new(gpu.frame_device, [8, 8]);
                let (frame, dependency) = producer
                    .produce(
                        &scene,
                        &mut history,
                        m.clone(),
                        GeometrySnapshot::default(),
                        camera,
                        trace,
                    )
                    .unwrap();
                let receipt = history
                    .evaluate_and_submit(&gpu, dependency, |_| {
                        Ok(EvaluatedCommands {
                            native: vec![],
                            consumer: vec![],
                        })
                    })
                    .unwrap();
                let mut control_history = GpuFrameHistory::new(gpu.frame_device, [8, 8]);
                let (control_frame, _) = control
                    .produce(
                        &scene,
                        &mut control_history,
                        m.clone(),
                        GeometrySnapshot::default(),
                        camera,
                        trace,
                    )
                    .unwrap();
                let raw =
                    hit_diagnostics::read_raw(&gpu, &frame.current.resources.producer_buffers[2])
                        .unwrap();
                let reference = hit_diagnostics::read_raw(
                    &gpu,
                    &control_frame.current.resources.producer_buffers[2],
                )
                .unwrap();
                let color_error = values(&raw)
                    .iter()
                    .zip(values(&reference))
                    .map(|(a, b)| (a - b).abs())
                    .fold(0f32, f32::max);
                assert!(
                    values(&raw)
                        .iter()
                        .zip(values(&reference))
                        .all(|(a, b)| (a - b).abs() <= 2e-6 * b.abs().max(1.)),
                    "guide recording color error {color_error}"
                );
                assert_eq!(
                    scene.read_target(&target, 0).unwrap(),
                    raw_before,
                    "frame producer changed progressive accumulation"
                );
                let records =
                    hit_diagnostics::read_raw(&gpu, &frame.current.resources.producer_buffers[6])
                        .unwrap();
                let control_records = hit_diagnostics::read_raw(
                    &gpu,
                    &control_frame.current.resources.producer_buffers[6],
                )
                .unwrap();
                for (actual, expected) in records
                    .chunks_exact(size_of::<FramePixelRecord>())
                    .zip(control_records.chunks_exact(size_of::<FramePixelRecord>()))
                {
                    assert_eq!(
                        &actual[176..208],
                        &expected[176..208],
                        "guide recording changed path RNG state/dimensions"
                    );
                }
                let depth = values(&read_texture(
                    &gpu,
                    &frame
                        .current
                        .resources
                        .guide(Guide::LinearDepth)
                        .unwrap()
                        .texture,
                ));
                let normal = values(&read_texture(
                    &gpu,
                    &frame
                        .current
                        .resources
                        .guide(Guide::NormalRoughness)
                        .unwrap()
                        .texture,
                ));
                let validity = read_texture(
                    &gpu,
                    &frame
                        .current
                        .resources
                        .guide(Guide::Validity)
                        .unwrap()
                        .texture,
                );
                let color = values(&read_texture(
                    &gpu,
                    &frame
                        .current
                        .resources
                        .guide(Guide::NoisyColor)
                        .unwrap()
                        .texture,
                ));
                let packed = values(camera);
                let inverse =
                    glam::DMat4::from_cols_array(&std::array::from_fn(|i| packed[i] as f64));
                let mut hits = 0;
                for y in 0..8u32 {
                    for x in 0..8u32 {
                        let index = (x + y * 8) as usize;
                        let top_index = (x + (7 - y) * 8) as usize;
                        let uv = glam::DVec2::new(
                            (x as f64 + 0.5 + m.jitter_pixels[0] as f64) / 8.,
                            (y as f64 + 0.5 - m.jitter_pixels[1] as f64) / 8.,
                        );
                        let a = inverse * glam::DVec4::new(uv.x * 2. - 1., uv.y * 2. - 1., -1., 1.);
                        let b = inverse * glam::DVec4::new(uv.x * 2. - 1., uv.y * 2. - 1., 1., 1.);
                        let origin = a.truncate() / a.w;
                        let direction = (b.truncate() / b.w - origin).normalize();
                        let point = origin + direction * ((-3. - origin.z) / direction.z);
                        // Analytic triangle edges for (-4,-4), (4,-4), (0,4).
                        let expected = point.y >= -4.
                            && point.y <= 4.
                            && point.x.abs() <= (4. - point.y) * 0.5;
                        let flags = u32::from_le_bytes(
                            validity[top_index * 4..top_index * 4 + 4]
                                .try_into()
                                .unwrap(),
                        );
                        assert_eq!(flags & 1 != 0, expected, "primary mask mismatch ({x},{y})");
                        assert_eq!(color[top_index * 4 + 3], 1.0);
                        if !expected {
                            assert_eq!(depth[top_index], 0.);
                            assert_eq!(
                                &normal[top_index * 4..top_index * 4 + 4],
                                &[0., 0., 0., 1.]
                            );
                            continue;
                        }
                        hits += 1;
                        assert!((depth[top_index] - 3.).abs() < 1e-5);
                        let expected_normal = if normal_mapped {
                            glam::DVec3::new(2. * 191. / 255. - 1., 2. * 128. / 255. - 1., 1.)
                                .normalize()
                        } else {
                            glam::DVec3::Z
                        };
                        for c in 0..3 {
                            assert!(
                                (normal[top_index * 4 + c] as f64 - expected_normal[c]).abs()
                                    < 2e-5,
                                "mapped first-surface normal mismatch"
                            );
                        }
                        assert!((normal[top_index * 4 + 3] - 0.3).abs() < 1e-6);
                        let stride = size_of::<FramePixelRecord>();
                        let record = values(&records[index * stride..(index + 1) * stride]);
                        for c in 0..3 {
                            assert!((record[8 + c] as f64 - point[c]).abs() < 2e-5);
                        }
                        assert_eq!(record[23], if thin { 1. } else { 0. });
                        assert!((record[26] - 1.).abs() < 1e-6 && (record[27] - 1.5).abs() < 1e-6);
                    }
                }
                assert!(hits > 0);
                assert!(receipt.retired());
                if let Ok(root) = std::env::var("MUTRACER_FRAME_EVIDENCE") {
                    let dir = Path::new(&root).join(format!(
                        "{:?}-thin{thin}-ortho{ortho}-normal{normal_mapped}-pattern{pattern}",
                        gpu.info.backend
                    ));
                    fs::create_dir_all(&dir).unwrap();
                    fs::write(dir.join("records.bin"), &records).unwrap();
                    fs::write(dir.join("raw-color.bin"), &raw).unwrap();
                    fs::write(dir.join("control-color.bin"), &reference).unwrap();
                    fs::write(
                        dir.join("depth.f32"),
                        depth
                            .iter()
                            .flat_map(|v| v.to_le_bytes())
                            .collect::<Vec<_>>(),
                    )
                    .unwrap();
                    fs::write(dir.join("parameters.json"),serde_json::to_vec_pretty(&json!({"adapter":format!("{:?}",gpu.info),"jitter":m.jitter_pixels,"sample":m.sample_index,"hits":hits,"gpuBytes":frame.current.resources.gpu_bytes,"maxColorRoundingError":color_error,"pathRngStateAndDimensionsMatch":true,"albedoOracle":false,"motion":false,"glassBranches":false})).unwrap()).unwrap();
                }
                println!(
                    "first surface thin={thin}, orthographic={ortho}, normalMapped={normal_mapped}, pattern={pattern}: {hits} oracle hits, identical path RNG/accumulation, color rounding={color_error}"
                );
            }
        }
    }
}
