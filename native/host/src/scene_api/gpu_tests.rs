use super::*;
use crate::api::{
    Backend, Camera, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
    RenderSize,
};
#[test]
#[ignore = "requires a real GPU; run separately"]
fn software_scene_object_incremental_matches_full() {
    let mut s = Scene::new();
    let g = s
        .add_geometry(Geometry::new(
            vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
            vec![0, 1, 2],
        ))
        .unwrap();
    s.geometry_mut(g).unwrap().uv[0] = vec![0., 0., 1., 0., 0.5, 1.].into();
    let t = s
        .add_texture(Texture::rgba8(1, 1, vec![255, 200, 150, 255]))
        .unwrap();
    let mut material = OpenPbrMaterial::default();
    material.textures[0] = Some(t);
    let mat = s.add_material(material).unwrap();
    let mesh = s.add_mesh(Mesh::new(g, mat)).unwrap();
    let hdr = s
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(vec![0.4, 0.5, 0.6, 1.].into()),
            ..Texture::rgba8(1, 1, vec![])
        })
        .unwrap();
    s.set_environment(Environment {
        texture: Some(hdr),
        background: Some(hdr),
        ..Environment::default()
    })
    .unwrap();
    let light = s
        .add_light(Light::Directional {
            color: [1.; 3],
            intensity: 2.,
            transform: Mat4::IDENTITY,
        })
        .unwrap();
    s.mesh_mut(mesh).unwrap().instances = Some(Instances {
        transforms: vec![
            Mat4::IDENTITY,
            Mat4::from_translation(Vec3::new(0.3, 0., -0.2)),
        ]
        .into(),
        colors: Some(vec![1.; 6].into()),
    });
    let ies: Arc<[u8]> =
        b"IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 3 1 1 2 0 0 0 1 1 20\n0 45 90\n0\n100 50 0\n"
            .as_slice()
            .into();
    let spot = s
        .add_light(Light::Spot {
            color: [1.; 3],
            intensity: 1.,
            inner: 10.,
            outer: 30.,
            transform: Mat4::from_translation(Vec3::new(0., 0., 2.)),
            ies: ies.clone(),
        })
        .unwrap();
    let mut camera = Camera::default();
    camera.world_matrix[14] = 3.;
    s.set_default_camera(Some(camera));
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    let settings = RenderSettings {
        max_samples: 8,
        size: RenderSize::Fixed {
            width: 32,
            height: 24,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    engine.set_scene_object(&s).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(8)).unwrap();
    for edit in 0..20 {
        match edit {
            0 => s.material_mut(mat).unwrap().values.roughness = 0.6,
            1 => {
                s.mesh_mut(mesh).unwrap().transform = Mat4::from_translation(Vec3::new(0.1, 0., 0.))
            }
            2 => {
                Arc::make_mut(&mut s.geometry_mut(g).unwrap().positions)[0] -= 0.2;
            }
            3 => s.texture_mut(t).unwrap().scale = [2., 3.],
            4 => {
                s.texture_mut(t).unwrap().pixels =
                    TexturePixels::Rgba8(vec![150, 200, 255, 255].into())
            }
            5 => {
                *s.light_mut(light).unwrap() = Light::Directional {
                    color: [1., 0.8, 0.7],
                    intensity: 3.,
                    transform: Mat4::IDENTITY,
                }
            }
            6 => {
                s.add_light(Light::Sphere {
                    color: [1.; 3],
                    intensity: 1.,
                    radius: 0.1,
                    transform: Mat4::from_translation(Vec3::new(0., 1., 2.)),
                })
                .unwrap();
            }
            7 => s.remove_light(light).unwrap(),
            8 => {
                s.texture_mut(hdr).unwrap().pixels =
                    TexturePixels::Rgba32F(vec![0.7, 0.5, 0.2, 1.].into())
            }
            9 => {
                camera.fov = 50.;
                s.set_default_camera(Some(camera));
            }
            10 => {
                let i = s.mesh_mut(mesh).unwrap().instances.as_mut().unwrap();
                Arc::make_mut(&mut i.transforms)[1] =
                    Mat4::from_translation(Vec3::new(0.4, 0., -0.2));
            }
            11 => {
                let i = s.mesh_mut(mesh).unwrap().instances.as_mut().unwrap();
                Arc::make_mut(i.colors.as_mut().unwrap())[0] = 0.6;
            }
            12 => {
                let t = s.texture_mut(hdr).unwrap();
                t.width = 2;
                t.pixels =
                    TexturePixels::Rgba32F(vec![0.4, 0.5, 0.6, 1., 0.7, 0.8, 0.9, 1.].into());
            }
            13 => {
                *s.light_mut(spot).unwrap() = Light::Spot {
                    color: [0.8, 1., 0.9],
                    intensity: 2.,
                    inner: 12.,
                    outer: 40.,
                    transform: Mat4::from_translation(Vec3::new(0., 0., 2.)),
                    ies: ies.clone(),
                };
            }
            14 => {
                s.set_environment(Environment {
                    texture: Some(hdr),
                    background: Some(hdr),
                    color: [0.1, 0.2, 0.3, 1.],
                })
                .unwrap();
            }
            15 => s.material_mut(mat).unwrap().values.emission_strength = 2.,
            16..=19 => {
                let mut controls = s.environment_settings();
                match edit {
                    16 => controls.intensity = 2.5,
                    17 => controls.rotation = 1.2,
                    18 => controls.background_intensity = 0.25,
                    _ => controls.background_rotation = -0.8,
                }
                s.set_environment_settings(controls).unwrap();
            }
            _ => unreachable!(),
        }
        let expected = CommitKind::Incremental;
        assert_eq!(
            s.pending_commit_kind().unwrap(),
            expected,
            "edit {edit} prediction"
        );
        engine.set_scene_object(&s).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        assert_eq!(
            render.last_commit().unwrap(),
            Some(expected),
            "edit {edit} actual"
        );
        let fresh = Engine::new(EngineOptions {
            backend: Backend::Software,
        })
        .unwrap();
        let reference = Render::new(&fresh, settings.clone()).unwrap();
        fresh.set_scene_object(&s).unwrap();
        fresh.update().unwrap();
        reference.converge(ConvergeOptions::new(8)).unwrap();
        for kind in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo] {
            let a = render.read_pixels(kind).unwrap();
            let b = reference.read_pixels(kind).unwrap();
            assert_eq!(
                a.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                b.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                "edit {edit} {kind:?}"
            );
        }
    }
}

#[derive(Clone)]
struct UdimImage {
    width: u32,
    height: u32,
    pixels: Vec<f32>,
}
fn udim_solid(width: u32, height: u32, color: [f32; 4]) -> UdimImage {
    UdimImage {
        width,
        height,
        pixels: color.repeat((width * height) as usize),
    }
}
fn udim_cases() -> Vec<(
    &'static str,
    Vec<(u32, UdimImage)>,
    (f32, f32),
    [f32; 2],
    [f32; 2],
    Vec<UdimImage>,
)> {
    let red = udim_solid(4, 4, [1., 0., 0., 1.]);
    let green = udim_solid(4, 4, [0., 1., 0., 1.]);
    let blue = udim_solid(4, 4, [0., 0., 1., 1.]);
    let black = udim_solid(4, 4, [0., 0., 0., 0.]);
    vec![
        (
            "boundary",
            vec![(1001, red.clone()), (1002, green.clone())],
            (0., 2.),
            [1., 1.],
            [0., 0.],
            vec![red.clone(), green.clone()],
        ),
        (
            "missing",
            vec![(1001, red.clone()), (1003, blue.clone())],
            (0., 3.),
            [1., 1.],
            [0., 0.],
            vec![red.clone(), black.clone(), blue.clone()],
        ),
        (
            "negative",
            vec![(1001, green.clone())],
            (-1., 1.),
            [1., 1.],
            [0., 0.],
            vec![black.clone(), green.clone()],
        ),
        (
            "domain",
            vec![(1010, red.clone())],
            (9., 11.),
            [1., 1.],
            [0., 0.],
            vec![red.clone(), black.clone()],
        ),
        (
            "transform",
            vec![(1002, green.clone()), (1003, blue.clone())],
            (0., 1.),
            [2., 1.],
            [1., 0.],
            vec![green.clone(), blue.clone()],
        ),
        (
            "sizes",
            vec![
                (1001, udim_solid(1, 2, [1., 128. / 255., 0., 1.])),
                (1002, udim_solid(4, 1, [128. / 255., 0., 1., 1.])),
            ],
            (0., 2.),
            [1., 1.],
            [0., 0.],
            vec![
                udim_solid(4, 2, [1., 128. / 255., 0., 1.]),
                udim_solid(4, 2, [128. / 255., 0., 1., 1.]),
            ],
        ),
    ]
}
fn add_udim_texture(
    scene: &mut Scene,
    tiles: &[(u32, UdimImage)],
    scale: [f32; 2],
    offset: [f32; 2],
) -> TextureId {
    let width = tiles.iter().map(|(_, tile)| tile.width).max().unwrap() * 10;
    let height = tiles.iter().map(|(_, tile)| tile.height).max().unwrap() * 10;
    let mut pixels = vec![0f32; (width * height * 4) as usize];
    for (number, image) in tiles {
        let tile = number - 1001;
        let tw = width / 10;
        let th = height / 10;
        for y in 0..th {
            let sy = (((y as f64 + 0.5) * image.height as f64 / th as f64).floor() as u32)
                .min(image.height - 1);
            for x in 0..tw {
                let sx = (((x as f64 + 0.5) * image.width as f64 / tw as f64).floor() as u32)
                    .min(image.width - 1);
                let from = ((sy * image.width + sx) * 4) as usize;
                let to = (((tile / 10 * th + y) * width + tile % 10 * tw + x) * 4) as usize;
                pixels[to..to + 4].copy_from_slice(&image.pixels[from..from + 4]);
            }
        }
    }
    scene
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(pixels.into()),
            width,
            height,
            uv: 0,
            scale,
            offset,
            wrap: [0, 0],
            flip_y: false,
            udim: true,
        })
        .unwrap()
}
fn udim_plane(
    scene: &mut Scene,
    uv: (f32, f32),
    texture: TextureId,
    position: f32,
    width: f32,
) -> MeshId {
    let mut geometry = Geometry::new(
        vec![-1., -1., 0., 1., -1., 0., -1., 1., 0., 1., 1., 0.],
        vec![0, 1, 2, 2, 1, 3],
    );
    geometry.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1.].into();
    geometry.uv[0] = vec![uv.0, 0., uv.1, 0., uv.0, 1., uv.1, 1.].into();
    let geometry = scene.add_geometry(geometry).unwrap();
    let mut material = OpenPbrMaterial::default();
    material.values.unlit = true;
    material.values.double_sided = true;
    material.values.emission_strength = 4.;
    material.textures[0] = Some(texture);
    material.textures[3] = Some(texture);
    let material = scene.add_material(material).unwrap();
    let mut mesh = Mesh::new(geometry, material);
    mesh.transform = Mat4::from_scale_rotation_translation(
        Vec3::new(width, 1., 1.),
        glam::Quat::IDENTITY,
        Vec3::new(position, 0., 0.),
    );
    scene.add_mesh(mesh).unwrap()
}
fn capture_udim(
    backend: Backend,
    tiles: &[(u32, UdimImage)],
    uv: (f32, f32),
    scale: [f32; 2],
    offset: [f32; 2],
    references: &[UdimImage],
    udim: bool,
    case: &str,
) -> Vec<f32> {
    let mut scene = Scene::new();
    if udim {
        let map = add_udim_texture(&mut scene, tiles, scale, offset);
        let count = references.len() as f32;
        udim_plane(&mut scene, uv, map, 0., count);
    } else {
        let count = references.len() as f32;
        for (i, image) in references.iter().enumerate() {
            let texture = scene
                .add_texture(Texture {
                    pixels: TexturePixels::Rgba32F(image.pixels.clone().into()),
                    width: image.width,
                    height: image.height,
                    ..Texture::rgba8(image.width, image.height, vec![])
                })
                .unwrap();
            udim_plane(
                &mut scene,
                (0., 1.),
                texture,
                i as f32 * 2. - count + 1.,
                1.,
            );
        }
    }
    let mut camera = Camera::default();
    camera.projection = 1;
    camera.left = -(references.len() as f32);
    camera.right = references.len() as f32;
    camera.bottom = -1.;
    camera.top = 1.;
    camera.world_matrix[14] = 3.;
    scene.set_default_camera(Some(camera));
    let engine = Engine::new(EngineOptions { backend }).unwrap();
    let settings = RenderSettings {
        seed: 0,
        max_samples: 4,
        bounces: 1,
        bevel: true,
        dispersion_wavelengths: 3,
        direct_light_candidates: 4,
        sampling_pattern: crate::api::SamplingPattern::Sobol,
        size: RenderSize::Fixed {
            width: 72,
            height: 24,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings).unwrap();
    engine.set_scene_object(&scene).unwrap();
    engine.update().unwrap();
    render
        .converge(ConvergeOptions {
            samples: 4,
            sample_sequence_offset: 0,
            ..ConvergeOptions::new(4)
        })
        .unwrap();
    let data = render.read_pixels(PixelKind::Hdr).unwrap().data;
    if let Ok(path) = std::env::var("MUTRACER_UDIM_OUTPUT") {
        std::fs::create_dir_all(&path).unwrap();
        let name = format!(
            "{}-{}-{}.f32",
            if backend == Backend::Software {
                "software"
            } else {
                "hwrt"
            },
            case,
            if udim { "udim" } else { "reference" }
        );
        let bytes: &[u8] = bytemuck::cast_slice(&data);
        std::fs::write(std::path::Path::new(&path).join(name), bytes).unwrap();
    }
    data
}
#[test]
#[ignore = "requires a real GPU; run through gpu-lock.sh"]
fn udim_sampling_matches_split_geometry_on_both_backends() {
    for backend in [Backend::Software, Backend::Hardware] {
        for (name, tiles, uv, scale, offset, reference) in udim_cases() {
            let actual = capture_udim(backend, &tiles, uv, scale, offset, &reference, true, name);
            let expected =
                capture_udim(backend, &tiles, uv, scale, offset, &reference, false, name);
            assert_eq!(actual.len(), expected.len());
            assert!(expected.iter().all(|value| value.is_finite()));
            assert!(
                expected
                    .chunks_exact(4)
                    .any(|pixel| pixel[..3].iter().any(|value| *value > 1e-5)),
                "{backend:?} split reference {name} rendered no nonzero RGB"
            );
            let distinct_rgb = expected
                .chunks_exact(4)
                .map(|pixel| [pixel[0].to_bits(), pixel[1].to_bits(), pixel[2].to_bits()])
                .collect::<std::collections::BTreeSet<_>>();
            assert!(
                distinct_rgb.len() > 1,
                "{backend:?} split reference {name} did not show distinct tile colors"
            );
            let max_error = actual
                .iter()
                .zip(&expected)
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            eprintln!("UDIM {backend:?} {name}: maxAbs={max_error}");
            assert!(
                max_error <= 2e-5,
                "{backend:?} UDIM {name} vs split geometry: {max_error}"
            );
        }
    }
}

#[test]
#[ignore = "requires a real GPU; run through gpu-lock.sh"]
fn raw_v5_texture_record_renders_on_both_backends() {
    let words = crate::scene::small_fixture();
    let mut words = words
        .chunks_exact(4)
        .map(|word| u32::from_le_bytes(word.try_into().unwrap()))
        .collect::<Vec<_>>();
    let texture_offset = words.len();
    words.extend_from_slice(&[
        1,
        1,
        0,
        (texture_offset + 12) as u32,
        0,
        0,
        1f32.to_bits(),
        1f32.to_bits(),
        0,
        0,
        0,
        0,
        u32::MAX,
    ]);
    words[crate::layout::header::VERSION] = 5;
    words[crate::layout::header::LENGTH] = words.len() as u32;
    words[crate::layout::header::TEXTURE_COUNT] = 1;
    words[crate::layout::header::TEXTURE_OFFSET] = texture_offset as u32;
    let raw = words
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect::<Vec<_>>();

    for backend in [Backend::Software, Backend::Hardware] {
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        engine.set_scene(&raw).unwrap();
        engine.update().unwrap();
        let render = Render::new(
            &engine,
            RenderSettings {
                max_samples: 1,
                size: RenderSize::Fixed {
                    width: 8,
                    height: 8,
                },
                ..Default::default()
            },
        )
        .unwrap();
        render.converge(ConvergeOptions::new(1)).unwrap();
        let image = render.read_pixels(PixelKind::Hdr).unwrap();
        assert!(image.data.iter().all(|value| value.is_finite()));
        assert!(image.data.chunks_exact(4).all(|pixel| pixel[3] == 1.));
    }
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn software_displacement_map_edits_match_prediction() {
    for scale in [0.1, 0.] {
        let mut s = Scene::new();
        let g = s
            .add_geometry(Geometry::new(
                vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        s.geometry_mut(g).unwrap().uv[0] = vec![0., 0., 1., 0., 0.5, 1.].into();
        let color = s
            .add_texture(Texture::rgba8(1, 1, vec![255, 200, 150, 255]))
            .unwrap();
        let height = s.add_texture(Texture::rgba8(1, 1, vec![128; 4])).unwrap();
        let mut material = OpenPbrMaterial::default();
        material.textures[0] = Some(color);
        material.textures[8] = Some(height);
        material.values.layers.displacement_scale = scale;
        let mat = s.add_material(material).unwrap();
        s.add_mesh(Mesh::new(g, mat)).unwrap();
        s.add_light(Light::Directional {
            color: [1.; 3],
            intensity: 2.,
            transform: Mat4::IDENTITY,
        })
        .unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        s.set_default_camera(Some(camera));
        let engine = Engine::new(EngineOptions {
            backend: Backend::Software,
        })
        .unwrap();
        let render = Render::new(
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
        .unwrap();
        engine.set_scene_object(&s).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(4)).unwrap();
        for edit in 0..3 {
            let expected = match edit {
                0 => {
                    s.texture_mut(color).unwrap().pixels =
                        TexturePixels::Rgba8(vec![100, 150, 200, 255].into());
                    CommitKind::Incremental
                }
                1 => {
                    s.texture_mut(height).unwrap().pixels =
                        TexturePixels::Rgba8(vec![200; 4].into());
                    CommitKind::Full
                }
                2 => {
                    s.texture_mut(height).unwrap().scale = [2., 2.];
                    CommitKind::Full
                }
                _ => unreachable!(),
            };
            assert_eq!(
                s.pending_commit_kind().unwrap(),
                expected,
                "scale {scale} edit {edit} prediction"
            );
            engine.set_scene_object(&s).unwrap();
            engine.update().unwrap();
            render.converge(ConvergeOptions::new(4)).unwrap();
            assert_eq!(
                render.last_commit().unwrap(),
                Some(expected),
                "scale {scale} edit {edit} actual"
            );
        }
    }
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn hardware_displaced_geometry_updates_match_full_commit() {
    let mut scene = Scene::new();
    let geometry = scene
        .add_geometry(Geometry::new(
            vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
            vec![0, 1, 2],
        ))
        .unwrap();
    scene.geometry_mut(geometry).unwrap().uv[0] = vec![0., 0., 1., 0., 0.5, 1.].into();
    let height = scene
        .add_texture(Texture::rgba8(1, 1, vec![128; 4]))
        .unwrap();
    let mut material = OpenPbrMaterial::default();
    material.textures[8] = Some(height);
    material.values.layers.displacement_scale = 0.1;
    let material = scene.add_material(material).unwrap();
    scene.add_mesh(Mesh::new(geometry, material)).unwrap();
    scene
        .add_light(Light::Directional {
            color: [1.; 3],
            intensity: 2.,
            transform: Mat4::IDENTITY,
        })
        .unwrap();
    let mut camera = Camera::default();
    camera.world_matrix[14] = 3.;
    scene.set_default_camera(Some(camera));
    let engine = Engine::new(EngineOptions {
        backend: Backend::Hardware,
    })
    .unwrap();
    let settings = RenderSettings {
        max_samples: 4,
        size: RenderSize::Fixed {
            width: 16,
            height: 12,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    engine.set_scene_object(&scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    Arc::make_mut(&mut scene.geometry_mut(geometry).unwrap().positions)[0] -= 0.2;
    assert_eq!(
        scene.pending_commit_kind().unwrap(),
        CommitKind::Incremental
    );
    engine.set_scene_object(&scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Incremental));
    let fresh = Engine::new(EngineOptions {
        backend: Backend::Hardware,
    })
    .unwrap();
    let reference = Render::new(&fresh, settings).unwrap();
    fresh.set_scene_object(&scene).unwrap();
    fresh.update().unwrap();
    reference.converge(ConvergeOptions::new(4)).unwrap();
    for kind in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo] {
        let actual = render.read_pixels(kind).unwrap();
        let expected = reference.read_pixels(kind).unwrap();
        assert_eq!(
            actual.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected
                .data
                .iter()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>(),
            "{kind:?}"
        );
    }
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn selected_adapter_renders_4k_and_environment_controls() {
    let adapters = Engine::adapters();
    let adapter = adapters
        .iter()
        .find(|a| {
            !matches!(
                a.get_info().device_type,
                wgpu::DeviceType::Cpu | wgpu::DeviceType::Other
            )
        })
        .expect("hardware adapter");
    println!(
        "4K adapter: {:?}; limits: {:?}",
        adapter.get_info(),
        adapter.limits()
    );
    let engine = Engine::on_adapter(
        adapter,
        EngineOptions {
            backend: Backend::Software,
        },
    )
    .unwrap();
    assert_eq!(engine.info().adapter_name, adapter.get_info().name);
    let mut s = Scene::new();
    let g = s
        .add_geometry(Geometry::new(
            vec![-1., -1., -2., 1., -1., -2., 0., 1., -2.],
            vec![0, 1, 2],
        ))
        .unwrap();
    let mat = s.add_material(OpenPbrMaterial::default()).unwrap();
    let mut mesh = Mesh::new(g, mat);
    mesh.transform = Mat4::from_translation(Vec3::new(100., 0., 0.)); // Every camera ray misses.
    s.add_mesh(mesh).unwrap();
    let hdr = s
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(vec![0.25, 0.5, 1., 1.].into()),
            ..Texture::rgba8(1, 1, vec![])
        })
        .unwrap();
    s.set_environment(Environment {
        texture: Some(hdr),
        background: Some(hdr),
        ..Default::default()
    })
    .unwrap();
    s.set_environment_settings(EnvironmentSettings {
        intensity: 3.,
        rotation: 0.7,
        background_intensity: 2.,
        background_rotation: -0.4,
    })
    .unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            bounces: 1,
            bevel: false,
            size: RenderSize::Fixed {
                width: 3840,
                height: 2160,
            },
            ..Default::default()
        },
    )
    .unwrap();
    engine.set_scene_object(&s).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    let image = render.read_pixels(PixelKind::Hdr).unwrap();
    assert_eq!([image.width, image.height], [3840, 2160]);
    assert_eq!(image.data.len(), 3840 * 2160 * 4);
    for pixel in image.data.chunks_exact(4) {
        assert_eq!(pixel, &[0.5, 1., 2., 1.]);
    }
    // Removing an explicit identity settings block preserves default fixed-seed pixels.
    let original = s.descriptor().unwrap();
    s.set_environment_settings(EnvironmentSettings::default())
        .unwrap();
    let with_default = s.descriptor().unwrap();
    let mut omitted = with_default.as_ref().clone();
    omitted[h::ENVIRONMENT_SETTINGS * 4..h::ENVIRONMENT_SETTINGS * 4 + 4].fill(0);
    let small = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Fixed {
                width: 8,
                height: 6,
            },
            ..Default::default()
        },
    )
    .unwrap();
    engine.set_scene(&with_default).unwrap();
    engine.update().unwrap();
    small.converge(ConvergeOptions::new(1)).unwrap();
    let expected = small.read_pixels(PixelKind::Hdr).unwrap();
    engine.set_scene(&omitted).unwrap();
    engine.update().unwrap();
    small.converge(ConvergeOptions::new(1)).unwrap();
    assert_eq!(small.read_pixels(PixelKind::Hdr).unwrap(), expected);
    assert_ne!(*original, *with_default);
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn dispatch_audit_tail_marker_preserves_hdr_and_counts_each_sample() {
    let _guard = crate::abi_test_lock();
    let key = "MUTRACER_NATIVE_DISPATCH_AUDIT";
    let previous = std::env::var_os(key);
    let render = |audit: bool| {
        unsafe {
            if audit {
                std::env::set_var(key, "1");
            } else {
                std::env::remove_var(key);
            }
        }
        let mut scene = Scene::new();
        let geometry = scene
            .add_geometry(Geometry::new(
                vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let mut material = OpenPbrMaterial::default();
        material.values.emission_strength = 1.;
        let material = scene.add_material(material).unwrap();
        scene.add_mesh(Mesh::new(geometry, material)).unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        scene.set_default_camera(Some(camera));
        let engine = Engine::new(EngineOptions {
            backend: Backend::Hardware,
        })
        .unwrap();
        assert!(engine.info().hardware_ray_query, "no hardware ray queries");
        let settings = RenderSettings {
            max_samples: 4,
            size: RenderSize::Fixed {
                width: 16,
                height: 12,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings).unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(4)).unwrap();
        render.read_pixels(PixelKind::Hdr).unwrap().data
    };
    let ordinary = render(false);
    let audited = render(true);
    match previous {
        Some(value) => unsafe { std::env::set_var(key, value) },
        None => unsafe { std::env::remove_var(key) },
    }
    if let Some(path) = std::env::var_os("MUTRACER_TEST_CAPTURE") {
        let path = std::path::PathBuf::from(path);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("dispatch-audit-off.rgba32f"),
            bytemuck::cast_slice(&ordinary),
        )
        .unwrap();
        std::fs::write(
            path.join("dispatch-audit-on.rgba32f"),
            bytemuck::cast_slice(&audited),
        )
        .unwrap();
    }
    assert_eq!(
        ordinary
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        audited
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        "the diagnostic tail pass must not change HDR output"
    );
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn openpbr_parameter_commits_match_full_on_both_backends() {
    let _guard = crate::abi_test_lock();
    for backend in [Backend::Software, Backend::Hardware] {
        let mut scene = Scene::new();
        let mut geometry =
            Geometry::new(vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.], vec![0, 1, 2]);
        geometry.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1.].into();
        geometry.uv[0] = vec![0., 0., 1., 0., 0.5, 1.].into();
        geometry.tangents = vec![1., 0., 0., 1., 1., 0., 0., 1., 1., 0., 0., 1.].into();
        let g = scene.add_geometry(geometry).unwrap();
        let mut material = OpenPbrMaterial::default();
        material.values.alpha_cutoff = 0.;
        material.values.double_sided = true;
        // Keep every shader feature needed by numeric edits active, including
        // medium/dispersion and non-opaque coverage. First-use tests follow.
        for (id, value) in [
            (10, 0.2),
            (12, 0.3),
            (15, 0.1),
            (17, 0.2),
            (22, 0.2),
            (25, 0.2),
            (31, 0.2),
            (36, 0.8),
            (9, 0.2),
            (71, 0.1),
            (28, 0.2),
            (72, 0.1),
            (53, 0.01),
        ] {
            material.set_float(id, [value, 0., 0.]).unwrap();
        }
        let id = scene.add_material(material).unwrap();
        scene.add_mesh(Mesh::new(g, id)).unwrap();
        // A receiver makes the zero/nonzero emission transition observable
        // through light sampling as well as through direct camera visibility.
        let receiver = scene.add_material(OpenPbrMaterial::default()).unwrap();
        let mut mesh = Mesh::new(g, receiver);
        mesh.transform = Mat4::from_translation(Vec3::new(0., -1., 1.));
        scene.add_mesh(mesh).unwrap();
        scene
            .add_light(Light::Directional {
                color: [1.; 3],
                intensity: 2.,
                transform: Mat4::IDENTITY,
            })
            .unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        scene.set_default_camera(Some(camera));
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let settings = RenderSettings {
            max_samples: 8,
            size: RenderSize::Fixed {
                width: 1280,
                height: 720,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        assert_eq!(render.backend().unwrap().0, backend);
        let mut edits: Vec<(u32, [f32; 3])> = Vec::new();
        for property in 1..=36 {
            let kind = crate::material_properties::MATERIAL_PROPERTIES[property as usize].0;
            let value = match property {
                8 => 1.7,
                16 => 30.,
                29 => 1.8,
                32 => 0.6,
                33 => 1.5,
                _ => 0.4,
            };
            edits.push((
                property,
                if kind == 1 {
                    [0.4, 0.5, 0.6]
                } else {
                    [value, 0., 0.]
                },
            ));
        }
        edits.extend([
            (53, [0.02, 0., 0.]),
            (45, [0.7, 0.8, 0.]),
            (62, [0.2, 0., 0.]),
            (75, [0.8, 0.7, 0.]),
        ]);
        edits.extend([
            (71, [0.3, 0., 0.]),
            (72, [0.3, 0., 0.]),
            (35, [0., 0., 0.]),
            (35, [0.6, 0., 0.]),
            (25, [0., 0., 0.]),
            (25, [0.2, 0., 0.]),
        ]);
        for (property, value) in edits {
            // Encode before the edit: the prediction is against this snapshot.
            scene.descriptor().unwrap();
            scene
                .material_mut(id)
                .unwrap()
                .set_float(property, value)
                .unwrap();
            assert_eq!(
                scene.pending_commit_kind().unwrap(),
                CommitKind::Incremental,
                "property {property}"
            );
            engine.set_scene_object(&scene).unwrap();
            engine.update().unwrap();
            render.converge(ConvergeOptions::new(8)).unwrap();
            assert_eq!(
                render.last_commit().unwrap(),
                Some(CommitKind::Incremental),
                "{backend:?} property {property}"
            );
            let fresh = Engine::new(EngineOptions { backend }).unwrap();
            let reference = Render::new(&fresh, settings.clone()).unwrap();
            fresh.set_scene_object(&scene).unwrap();
            fresh.update().unwrap();
            reference.converge(ConvergeOptions::new(8)).unwrap();
            let a = render.read_pixels(PixelKind::Hdr).unwrap();
            let b = reference.read_pixels(PixelKind::Hdr).unwrap();
            assert_material_hdr(
                &render,
                &reference,
                &a.data,
                &b.data,
                &format!("{backend:?}-property-{property}"),
            );
            println!("OPENPBR_EQUIVALENCE {backend:?} property={property} bits=equal");
        }
    }
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn openpbr_first_use_and_transport_changes_keep_full_fallback() {
    let _guard = crate::abi_test_lock();
    for backend in [Backend::Software, Backend::Hardware] {
        let mut scene = Scene::new();
        let g = scene
            .add_geometry(Geometry::new(
                vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let mut values = OpenPbrMaterial::default();
        values.values.alpha_cutoff = 0.;
        values.values.double_sided = true;
        let material = scene.add_material(values).unwrap();
        scene.add_mesh(Mesh::new(g, material)).unwrap();
        scene
            .add_light(Light::Directional {
                color: [1.; 3],
                intensity: 2.,
                transform: Mat4::IDENTITY,
            })
            .unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        scene.set_default_camera(Some(camera));
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let settings = RenderSettings {
            max_samples: 8,
            size: RenderSize::Fixed {
                width: 1280,
                height: 720,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        for (property, value, expected) in [
            (25, 0.3, CommitKind::Full),
            (22, 0.3, CommitKind::Incremental),
            (31, 0.3, CommitKind::Full),
            (31, 0., CommitKind::Incremental),
            (31, 0.2, CommitKind::Incremental),
            (17, 0.3, CommitKind::Full),
            (10, 0.3, CommitKind::Incremental),
            (15, 0.2, CommitKind::Full),
            (15, 0., CommitKind::Full),
            (36, 0.8, CommitKind::Full),
            (36, 0.5, CommitKind::Incremental),
            (36, 1., CommitKind::Full),
            (37, 1., CommitKind::Full),
            (37, 0., CommitKind::Full),
            (
                38,
                0.,
                if backend == Backend::Hardware {
                    CommitKind::Full
                } else {
                    CommitKind::Incremental
                },
            ),
            (
                38,
                1.,
                if backend == Backend::Hardware {
                    CommitKind::Full
                } else {
                    CommitKind::Incremental
                },
            ),
            (51, 1., CommitKind::Full),
            (51, 0., CommitKind::Incremental),
            (52, 1., CommitKind::Incremental),
            (52, 0., CommitKind::Incremental),
        ] {
            scene.descriptor().unwrap();
            let m = scene.material_mut(material).unwrap();
            if matches!(property, 37 | 38 | 51 | 52) {
                m.set_uint(property, value as u32).unwrap();
            } else {
                m.set_float(property, [value, 0., 0.]).unwrap();
            }
            // Scene prediction lacks the engine's compiled support and therefore
            // reports a candidate; the actual commit enforces that support.
            assert_eq!(
                scene.pending_commit_kind().unwrap(),
                CommitKind::Incremental
            );
            engine.set_scene_object(&scene).unwrap();
            engine.update().unwrap();
            render.converge(ConvergeOptions::new(8)).unwrap();
            assert_eq!(
                render.last_commit().unwrap(),
                Some(expected),
                "{backend:?} property={property} value={value}"
            );
            assert_eq!(render.backend().unwrap().0, backend);
            let fresh = Engine::new(EngineOptions { backend }).unwrap();
            let reference = Render::new(&fresh, settings.clone()).unwrap();
            fresh.set_scene_object(&scene).unwrap();
            fresh.update().unwrap();
            reference.converge(ConvergeOptions::new(8)).unwrap();
            let a = render.read_pixels(PixelKind::Hdr).unwrap();
            let b = reference.read_pixels(PixelKind::Hdr).unwrap();
            assert_material_hdr(
                &render,
                &reference,
                &a.data,
                &b.data,
                &format!("{backend:?}-property-{property}-value-{value}"),
            );
            println!(
                "OPENPBR_FALLBACK {backend:?} property={property} value={value} actual={expected:?} bits=equal"
            );
        }
    }
}

// Keep strict comparisons, but capture repeat controls before failing so a
// transient HWRT miss can be distinguished from a retained-parameter mismatch.
fn assert_material_hdr(retained: &Render, full: &Render, a: &[f32], b: &[f32], label: &str) {
    let differences = |x: &[f32], y: &[f32]| {
        x.iter()
            .zip(y)
            .filter(|(x, y)| x.to_bits() != y.to_bits())
            .count()
    };
    let count = differences(a, b);
    if count != 0 {
        let directory = std::env::var_os("MUTRACER_TEST_CAPTURE")
            .map(|p| std::path::PathBuf::from(p).join(label));
        if let Some(p) = &directory {
            std::fs::create_dir_all(p).unwrap();
            std::fs::write(p.join("retained.rgba32f"), bytemuck::cast_slice(a)).unwrap();
            std::fs::write(p.join("full.rgba32f"), bytemuck::cast_slice(b)).unwrap();
        }
        for round in 0..3 {
            retained.restart().unwrap();
            full.restart().unwrap();
            retained.converge(ConvergeOptions::new(8)).unwrap();
            full.converge(ConvergeOptions::new(8)).unwrap();
            let c = retained.read_pixels(PixelKind::Hdr).unwrap();
            let d = full.read_pixels(PixelKind::Hdr).unwrap();
            println!(
                "OPENPBR_REPEAT_CONTROL {label} round={round} retained_repeat={} full_repeat={} pair={}",
                differences(a, &c.data),
                differences(b, &d.data),
                differences(&c.data, &d.data)
            );
            if let Some(p) = &directory {
                std::fs::write(
                    p.join(format!("retained-repeat-{round}.rgba32f")),
                    bytemuck::cast_slice(&c.data),
                )
                .unwrap();
                std::fs::write(
                    p.join(format!("full-repeat-{round}.rgba32f")),
                    bytemuck::cast_slice(&d.data),
                )
                .unwrap();
            }
        }
    }
    assert_eq!(count, 0, "{label}: HDR words differ");
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn recreated_mesh_identity_commit_matches_fresh_on_both_backends() {
    let _guard = crate::abi_test_lock();
    for backend in [Backend::Software, Backend::Hardware] {
        let mut scene = Scene::new();
        let g = scene
            .add_geometry(Geometry::new(
                vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let material = scene.add_material(OpenPbrMaterial::default()).unwrap();
        let mesh = scene.add_mesh(Mesh::new(g, material)).unwrap();
        scene
            .add_light(Light::Directional {
                color: [1.; 3],
                intensity: 2.,
                transform: Mat4::IDENTITY,
            })
            .unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        scene.set_default_camera(Some(camera));
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let settings = RenderSettings {
            max_samples: 8,
            size: RenderSize::Fixed {
                width: 1280,
                height: 720,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        let values = scene.mesh_mut(mesh).unwrap().clone();
        scene.remove_mesh(mesh).unwrap();
        scene.add_mesh(values).unwrap();
        // The new handle references resident geometry and material, so the
        // membership edit stays incremental.
        assert_eq!(
            scene.pending_commit_kind().unwrap(),
            CommitKind::Incremental
        );
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Incremental));
        assert_eq!(render.backend().unwrap().0, backend);
        let fresh = Engine::new(EngineOptions { backend }).unwrap();
        let reference = Render::new(&fresh, settings).unwrap();
        fresh.set_scene_object(&scene).unwrap();
        fresh.update().unwrap();
        reference.converge(ConvergeOptions::new(8)).unwrap();
        let a = render.read_pixels(PixelKind::Hdr).unwrap();
        let b = reference.read_pixels(PixelKind::Hdr).unwrap();
        assert_material_hdr(
            &render,
            &reference,
            &a.data,
            &b.data,
            &format!("{backend:?}-recreated-mesh"),
        );
        println!("MESH_IDENTITY_EQUIVALENCE {backend:?} actual=Incremental bits=equal");
    }
}

/// Dirty scene-object commits against whole-scene comparison: the dirty engine
/// commits each batch at once (with deltas and batched transforms), the other
/// engine commits the same edits one at a time from plain descriptors. Commit
/// kinds and images must be identical; Full commits also match a fresh engine.
#[test]
#[ignore = "requires a real GPU; run separately"]
fn dirty_scene_commits_match_whole_scene_and_full_on_both_backends() {
    use CommitKind::{Full, Incremental};
    for backend in [Backend::Software, Backend::Hardware] {
        let mut s = Scene::new();
        let quad = |x: f32| {
            let mut g = Geometry::new(
                vec![x, -0.5, 0., x + 0.4, -0.5, 0., x, 0.5, 0., x + 0.4, 0.5, 0.],
                vec![0, 1, 2, 2, 1, 3],
            );
            g.uv[0] = vec![0., 0., 1., 0., 0., 1., 1., 1.].into();
            g
        };
        let geometries: Vec<_> = (0..3)
            .map(|i| s.add_geometry(quad(-1. + i as f32 * 0.5)).unwrap())
            .collect();
        let t = s
            .add_texture(Texture::rgba8(1, 1, vec![255, 200, 150, 255]))
            .unwrap();
        let materials: Vec<_> = (0..3)
            .map(|i| {
                let mut m = OpenPbrMaterial::default();
                m.values.color = [0.3 + 0.2 * i as f32, 0.5, 0.7];
                s.add_material(m).unwrap()
            })
            .collect();
        let mut meshes: Vec<_> = (0..4)
            .map(|i| {
                let mut mesh = Mesh::new(geometries[i % 3], materials[i % 3]);
                mesh.transform = Mat4::from_translation(Vec3::new(0., i as f32 * 0.2 - 0.3, 0.));
                s.add_mesh(mesh).unwrap()
            })
            .collect();
        let instanced = s
            .add_mesh(Mesh {
                instances: Some(Instances {
                    transforms: (0..140)
                        .map(|i| {
                            Mat4::from_translation(Vec3::new(
                                (i % 14) as f32 * 0.1 - 0.7,
                                (i / 14) as f32 * 0.08 - 0.4,
                                -0.5,
                            )) * Mat4::from_scale(Vec3::splat(0.2))
                        })
                        .collect::<Vec<_>>()
                        .into(),
                    colors: None,
                }),
                ..Mesh::new(geometries[0], materials[1])
            })
            .unwrap();
        let light = s
            .add_light(Light::Rect {
                color: [1.; 3],
                intensity: 3.,
                width: 1.,
                height: 1.,
                spread: 1.,
                transform: Mat4::from_translation(Vec3::new(0., 0., 2.)),
                texture: None,
            })
            .unwrap();
        s.add_light(Light::Directional {
            color: [1.; 3],
            intensity: 1.,
            transform: Mat4::IDENTITY,
        })
        .unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        s.set_default_camera(Some(camera));
        let settings = RenderSettings {
            max_samples: 8,
            size: RenderSize::Fixed {
                width: 32,
                height: 24,
            },
            ..Default::default()
        };
        let engine = || Engine::new(EngineOptions { backend }).unwrap();
        let (dirty, whole) = (engine(), engine());
        let (dirty_render, whole_render) = (
            Render::new(&dirty, settings.clone()).unwrap(),
            Render::new(&whole, settings.clone()).unwrap(),
        );
        eprintln!(
            "DIRTY_AUDIT_TARGETS backend={backend:?} dirty_context={:?} whole_context={:?}",
            dirty_render.audit_context_id(),
            whole_render.audit_context_id()
        );
        let commit = |e: &Engine, r: &Render| {
            e.update().unwrap();
            r.converge(ConvergeOptions::new(8)).unwrap();
            r.last_commit().unwrap()
        };
        // The whole-scene engine commits each edit separately.
        let sequential = |s: &Scene| {
            whole.set_scene_shared(s.descriptor().unwrap()).unwrap();
            commit(&whole, &whole_render)
        };
        dirty.set_scene_object(&s).unwrap();
        commit(&dirty, &dirty_render);
        sequential(&s);
        for step in 0..13 {
            let expected = match step {
                0 => {
                    s.mesh_mut(meshes[0]).unwrap().transform =
                        Mat4::from_translation(Vec3::new(0.1, -0.3, 0.));
                    Some(Incremental)
                }
                1 => {
                    // One dirty commit: several meshes, an instance and two materials.
                    for (k, &mesh) in meshes.iter().enumerate().skip(1) {
                        s.mesh_mut(mesh).unwrap().transform = Mat4::from_translation(Vec3::new(
                            0.05 * k as f32,
                            k as f32 * 0.2 - 0.3,
                            0.1,
                        ));
                        sequential(&s);
                    }
                    let i = s.mesh_mut(instanced).unwrap().instances.as_mut().unwrap();
                    Arc::make_mut(&mut i.transforms)[5] =
                        Mat4::from_translation(Vec3::new(0., 0.3, -0.4))
                            * Mat4::from_scale(Vec3::splat(0.3));
                    sequential(&s);
                    s.material_mut(materials[0]).unwrap().values.roughness = 0.7;
                    sequential(&s);
                    s.material_mut(materials[2])
                        .unwrap()
                        .set_float(4, [0.4, 0., 0.])
                        .unwrap();
                    Some(Incremental)
                }
                2 => {
                    // Edited and restored before the commit.
                    let original = s.mesh(meshes[1]).unwrap().transform;
                    s.mesh_mut(meshes[1]).unwrap().transform = Mat4::IDENTITY;
                    s.mesh_mut(meshes[1]).unwrap().transform = original;
                    None
                }
                3 => {
                    if let Light::Rect { intensity, .. } = s.light_mut(light).unwrap() {
                        *intensity = 4.;
                    }
                    sequential(&s);
                    camera.world_matrix[12] = 0.1;
                    s.set_default_camera(Some(camera));
                    Some(Incremental)
                }
                4 => {
                    Arc::make_mut(&mut s.geometry_mut(geometries[1]).unwrap().positions)[1] -= 0.1;
                    Some(Incremental)
                }
                5 => {
                    // Two snapshots before one update: the delta spans both.
                    s.mesh_mut(meshes[0]).unwrap().transform =
                        Mat4::from_translation(Vec3::new(0.2, -0.3, 0.));
                    dirty.set_scene_object(&s).unwrap();
                    sequential(&s);
                    s.material_mut(materials[1]).unwrap().values.color = [0.9, 0.2, 0.2];
                    Some(Incremental)
                }
                6 => {
                    // Added and removed in one batch.
                    let added = s.add_mesh(Mesh::new(geometries[2], materials[0])).unwrap();
                    s.remove_mesh(added).unwrap();
                    None
                }
                7 => {
                    // Same record under a new identity.
                    let mesh = s.mesh(meshes[3]).unwrap().clone();
                    s.remove_mesh(meshes[3]).unwrap();
                    meshes[3] = s.add_mesh(mesh).unwrap();
                    Some(Incremental)
                }
                8 => {
                    s.material_mut(materials[2]).unwrap().textures[0] = Some(t);
                    Some(Incremental)
                }
                9 => {
                    // More than 64 but at most half of the batch: one refit.
                    for k in 0..66 {
                        let i = s.mesh_mut(instanced).unwrap().instances.as_mut().unwrap();
                        let m = &mut Arc::make_mut(&mut i.transforms)[k * 2];
                        *m = Mat4::from_translation(Vec3::new(0.05, 0., 0.)) * *m;
                        if k == 32 {
                            sequential(&s);
                        }
                    }
                    Some(Incremental)
                }
                12 => {
                    let i = s.mesh_mut(instanced).unwrap().instances.as_mut().unwrap();
                    for m in Arc::make_mut(&mut i.transforms) {
                        *m = Mat4::from_translation(Vec3::new(0., 0.03, 0.)) * *m;
                    }
                    Some(Full)
                }
                10 => {
                    // A rejected snapshot leaves both engines unchanged.
                    s.material_mut(materials[0]).unwrap().values.roughness = 2.;
                    assert_eq!(
                        dirty.set_scene_object(&s).unwrap_err().status,
                        Status::InvalidArgument
                    );
                    assert!(s.descriptor().is_err());
                    s.material_mut(materials[0]).unwrap().values.roughness = 0.5;
                    s.mesh_mut(meshes[2]).unwrap().transform =
                        Mat4::from_translation(Vec3::new(0., 0.1, 0.2));
                    // The rejected snapshot dropped the scene's cache, so the
                    // prediction is Full while the engines still update in place.
                    None
                }
                _ => {
                    let mut controls = s.environment_settings();
                    controls.intensity = 2.;
                    s.set_environment_settings(controls).unwrap();
                    sequential(&s);
                    s.material_mut(materials[1])
                        .unwrap()
                        .values
                        .emission_strength = 0.5;
                    Some(Incremental)
                }
            };
            let predicted = s.pending_commit_kind().unwrap();
            if let Some(expected) = expected {
                assert_eq!(predicted, expected, "{backend:?} step {step} prediction");
            }
            dirty.set_scene_object(&s).unwrap();
            let committed = commit(&dirty, &dirty_render);
            if step != 10 {
                assert_eq!(committed, Some(predicted), "{backend:?} step {step} actual");
            }
            assert_eq!(
                sequential(&s),
                committed,
                "{backend:?} step {step} whole-scene kind"
            );
            let fresh = engine();
            let reference = Render::new(&fresh, settings.clone()).unwrap();
            eprintln!(
                "DIRTY_AUDIT_TARGETS backend={backend:?} step={step} fresh_full_context={:?}",
                reference.audit_context_id()
            );
            fresh.set_scene_object(&s).unwrap();
            commit(&fresh, &reference);
            for kind in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo] {
                let a = dirty_render.read_pixels(kind).unwrap();
                let mut others = vec![(&whole_render, "whole-scene")];
                // Incremental refits keep the previous TLAS topology, so only
                // full preparations are compared with a fresh engine.
                if committed == Some(Full) {
                    others.push((&reference, "fresh full"));
                }
                for (other, name) in others {
                    let b = other.read_pixels(kind).unwrap();
                    let differing = (a.data.iter().zip(&b.data))
                        .filter(|(x, y)| x.to_bits() != y.to_bits())
                        .count();
                    if differing != 0 {
                        if let Some(root) = std::env::var_os("MUTRACER_TEST_CAPTURE") {
                            let root = std::path::PathBuf::from(root);
                            std::fs::create_dir_all(&root).unwrap();
                            let label = format!("{backend:?}-step{step}-{kind:?}-vs-{name}");
                            std::fs::write(
                                root.join(format!("{label}-dirty.rgba32f")),
                                bytemuck::cast_slice(&a.data),
                            )
                            .unwrap();
                            std::fs::write(
                                root.join(format!("{label}-other.rgba32f")),
                                bytemuck::cast_slice(&b.data),
                            )
                            .unwrap();
                            std::fs::write(
                                root.join(format!("{label}.json")),
                                serde_json::to_vec_pretty(&serde_json::json!({
                                    "backend": format!("{backend:?}"),
                                    "step": step,
                                    "pixelKind": format!("{kind:?}"),
                                    "comparison": name,
                                    "differentValues": differing,
                                    "dirtyContext": dirty_render.audit_context_id(),
                                    "otherContext": other.audit_context_id(),
                                    "wholeContext": whole_render.audit_context_id(),
                                    "freshFullContext": (committed == Some(Full))
                                        .then(|| reference.audit_context_id()),
                                }))
                                .unwrap(),
                            )
                            .unwrap();
                        }
                    }
                    assert_eq!(
                        differing, 0,
                        "{backend:?} step {step} {kind:?}: {differing} values differ from {name}"
                    );
                }
            }
        }
    }
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn resident_membership_matches_fresh_hdr_id_and_picking_on_both_backends() {
    use CommitKind::Incremental;
    for backend in [Backend::Software, Backend::Hardware] {
        let mut scene = Scene::new();
        let geometry = scene
            .add_geometry(Geometry::new(
                vec![-0.35, -0.35, 0., 0.35, -0.35, 0., 0., 0.35, 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let mut multi = Geometry::new(
            vec![
                -0.35, -0.35, 0., 0.35, -0.35, 0., 0., 0.35, 0., -0.3, -0.3, -0.1, 0.3, -0.3, -0.1,
                0., 0.3, -0.1,
            ],
            vec![0, 1, 2, 3, 4, 5],
        );
        multi.material_indices = vec![0, 0, 0, 1, 1, 1].into();
        let multi = scene.add_geometry(multi).unwrap();
        let material = scene.add_material(OpenPbrMaterial::default()).unwrap();
        let mut emission = OpenPbrMaterial::default();
        emission.values.emission_strength = 1.5;
        let emission = scene.add_material(emission).unwrap();
        let uploaded = scene
            .add_texture(Texture::rgba8(1, 1, vec![255, 0, 0, 255]))
            .unwrap();
        let same_size = scene
            .add_texture(Texture::rgba8(1, 1, vec![0, 255, 0, 255]))
            .unwrap();
        let larger = scene
            .add_texture(Texture::rgba8(2, 2, [0, 0, 255, 255].repeat(4)))
            .unwrap();
        for texture in [uploaded, same_size, larger] {
            let mut holder = OpenPbrMaterial::default();
            holder.textures[0] = Some(texture);
            let holder = scene.add_material(holder).unwrap();
            let mut resident = Mesh::new(geometry, holder);
            resident.visible = false;
            scene.add_mesh(resident).unwrap();
        }
        let mut left = Mesh::new(geometry, material);
        left.transform = Mat4::from_translation(Vec3::new(-0.55, 0., 0.));
        let left = scene.add_mesh(left).unwrap();
        let mut emitter = Mesh::new(geometry, emission);
        emitter.transform = Mat4::from_translation(Vec3::new(0.55, 0., 0.));
        let emitter = scene.add_mesh(emitter).unwrap();
        let mut reserve_a = Mesh::new(geometry, material);
        reserve_a.visible = false;
        let reserve_a = scene.add_mesh(reserve_a).unwrap();
        let mut reserve_b = Mesh::new(multi, material);
        reserve_b.materials = vec![material, emission];
        reserve_b.visible = false;
        let reserve_b = scene.add_mesh(reserve_b).unwrap();
        scene
            .add_light(Light::Directional {
                color: [1.; 3],
                intensity: 1.,
                transform: Mat4::IDENTITY,
            })
            .unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        scene.set_default_camera(Some(camera));
        let settings = RenderSettings {
            max_samples: 4,
            aovs: 32,
            aov_samples: 1,
            size: RenderSize::Fixed {
                width: 32,
                height: 24,
            },
            ..Default::default()
        };
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let render = Render::new(&engine, settings.clone()).unwrap();
        let commit = |engine: &Engine, render: &Render, scene: &Scene, label: &str| {
            eprintln!("MEMBERSHIP_ORACLE {backend:?} {label} begin");
            let predicted = scene.pending_commit_kind().unwrap();
            eprintln!("MEMBERSHIP_ORACLE {backend:?} {label} predicted={predicted:?}");
            assert_eq!(predicted, Incremental, "{backend:?} {label} prediction");
            engine.set_scene_object(scene).unwrap();
            engine.update().unwrap();
            eprintln!("MEMBERSHIP_ORACLE {backend:?} {label} updated");
            render.converge(ConvergeOptions::new(4)).unwrap();
            eprintln!("MEMBERSHIP_ORACLE {backend:?} {label} converged");
            assert_eq!(
                render.last_commit().unwrap(),
                Some(Incremental),
                "{backend:?} {label} actual"
            );
            let fresh = Engine::new(EngineOptions { backend }).unwrap();
            let reference = Render::new(&fresh, settings.clone()).unwrap();
            fresh.set_scene_object(scene).unwrap();
            fresh.update().unwrap();
            reference.converge(ConvergeOptions::new(4)).unwrap();
            for kind in [PixelKind::Hdr, PixelKind::Id] {
                let a = render.read_pixels(kind).unwrap();
                let b = reference.read_pixels(kind).unwrap();
                let differing = a
                    .data
                    .iter()
                    .zip(&b.data)
                    .filter(|(x, y)| x.to_bits() != y.to_bits())
                    .count();
                assert_eq!(differing, 0, "{backend:?} {label} {kind:?}");
                assert_eq!(a.id_data, b.id_data, "{backend:?} {label} ID");
            }
            for x in [0.25, 0.5, 0.75] {
                assert_eq!(
                    format!("{:?}", engine.pick_surface(x, 0.5).unwrap()),
                    format!("{:?}", fresh.pick_surface(x, 0.5).unwrap()),
                    "{backend:?} {label} pick {x}"
                );
            }
        };
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(4)).unwrap();

        scene.remove_mesh(left).unwrap();
        commit(&engine, &render, &scene, "delete");
        let mut added = Mesh::new(geometry, material);
        added.transform = Mat4::from_translation(Vec3::new(-0.55, 0., 0.));
        let added = scene.add_mesh(added).unwrap();
        commit(&engine, &render, &scene, "add-resident");
        scene.remove_mesh(emitter).unwrap();
        commit(&engine, &render, &scene, "delete-emissive");
        scene.remove_mesh(reserve_a).unwrap();
        commit(&engine, &render, &scene, "release-reserved-slot");
        let mut instances = Mesh::new(geometry, material);
        instances.instances = Some(Instances {
            transforms: vec![
                Mat4::from_translation(Vec3::new(0.45, 0., 0.)),
                Mat4::from_translation(Vec3::new(0.65, 0., 0.)),
            ]
            .into(),
            colors: None,
        });
        let instances = scene.add_mesh(instances).unwrap();
        commit(&engine, &render, &scene, "add-instance-batch");
        scene.remove_mesh(instances).unwrap();
        commit(&engine, &render, &scene, "delete-instance-batch");
        let mut mm = Mesh::new(multi, material);
        mm.materials = vec![material, emission];
        let mm = scene.add_mesh(mm).unwrap();
        commit(&engine, &render, &scene, "add-multi-material");
        scene.remove_mesh(mm).unwrap();
        commit(&engine, &render, &scene, "delete-multi-material");
        scene.remove_mesh(reserve_b).unwrap();
        commit(&engine, &render, &scene, "delete-final-reserve");
        scene.set_mesh_visible(added, false).unwrap();
        commit(&engine, &render, &scene, "visibility-after-membership");
        // One commit restores the only mesh and moves it: the transform step runs
        // while every instance is still hidden.
        scene.set_mesh_visible(added, true).unwrap();
        scene.mesh_mut(added).unwrap().transform =
            Mat4::from_translation(Vec3::new(-0.45, 0.1, 0.));
        commit(
            &engine,
            &render,
            &scene,
            "restore-and-transform-after-membership",
        );
        scene.material_mut(material).unwrap().textures[0] = Some(uploaded);
        commit(&engine, &render, &scene, "texture-uploaded-reference");
        scene.material_mut(material).unwrap().textures[0] = Some(same_size);
        commit(&engine, &render, &scene, "texture-same-size-reference");
        scene.material_mut(material).unwrap().textures[0] = Some(larger);
        commit(&engine, &render, &scene, "texture-larger-reference");

        let mut over_capacity = Mesh::new(geometry, material);
        over_capacity.instances = Some(Instances {
            transforms: (0..8)
                .map(|i| Mat4::from_translation(Vec3::new(i as f32 * 0.05, 0., 0.)))
                .collect::<Vec<_>>()
                .into(),
            colors: None,
        });
        scene.add_mesh(over_capacity).unwrap();
        assert_eq!(
            scene.pending_commit_kind().unwrap(),
            Incremental,
            "{backend:?} over-capacity descriptor prediction"
        );
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(4)).unwrap();
        assert_eq!(
            render.last_commit().unwrap(),
            Some(CommitKind::Full),
            "{backend:?} over-capacity actual"
        );
    }
}

/// Full preparation with hidden mesh records physically removed. Retains stable
/// ID tables and all resource records, exactly as Scene::remove_mesh does.
fn removed_hidden_descriptor(bytes: &[u8]) -> Vec<u8> {
    use crate::layout::{batch as b, mesh as m};
    let mut words = bytemuck::pod_collect_to_vec::<u8, u32>(bytes);
    let original = words.clone();
    let count = words[h::MESH_COUNT] as usize;
    let mo = words[h::MESH_OFFSET] as usize;
    let bo = words[h::BATCH_OFFSET] as usize;
    let ids = words[h::MESH_AOV_IDS] as usize;
    let mut next = 0;
    for i in 0..count {
        if original[mo + i * m::WORDS + m::FLAGS] != 0 {
            continue;
        }
        words[mo + next * m::WORDS..mo + (next + 1) * m::WORDS]
            .copy_from_slice(&original[mo + i * m::WORDS..mo + (i + 1) * m::WORDS]);
        if bo != 0 {
            words[bo + next * b::WORDS..bo + (next + 1) * b::WORDS]
                .copy_from_slice(&original[bo + i * b::WORDS..bo + (i + 1) * b::WORDS]);
        }
        if ids != 0 {
            words[ids + next] = original[ids + i];
        }
        next += 1;
    }
    if next == 0 {
        // The native descriptor requires a mesh record. An empty instance batch
        // is the full-preparation representation of a scene with no surfaces.
        assert_ne!(bo, 0);
        words[mo + m::FLAGS] = 0;
        words[bo..bo + b::WORDS].fill(0);
        next = 1;
    }
    words[h::MESH_COUNT] = next as u32;
    bytemuck::cast_slice(&words).to_vec()
}
#[test]
#[ignore = "requires a real GPU; run separately"]
fn visibility_matches_removed_full_preparation_on_both_backends() {
    crate::logging::stderr();
    for backend in [Backend::Software, Backend::Hardware] {
        let mut s = Scene::new();
        let geometry = s
            .add_geometry(Geometry::new(
                vec![-0.4, -0.4, 0., 0.4, -0.4, 0., 0., 0.4, 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let mat = s.add_material(OpenPbrMaterial::default()).unwrap();
        let mut light = OpenPbrMaterial::default();
        light.values.emission_strength = 2.;
        let emitter = s.add_material(light).unwrap();
        let mut meshes = Vec::new();
        for i in 0..4 {
            let mut m = Mesh::new(geometry, if i == 1 { emitter } else { mat });
            m.transform =
                Mat4::from_translation(Vec3::new((i as f32 - 1.5) * 0.5, 0., i as f32 * -0.1));
            if i == 2 {
                m.instances = Some(Instances {
                    transforms: vec![Mat4::IDENTITY, Mat4::from_translation(Vec3::Y * 0.7)].into(),
                    colors: None,
                });
            }
            if i == 3 {
                let mut g = Geometry::new(
                    vec![
                        -0.4, -0.4, 0., 0.4, -0.4, 0., 0., 0.4, 0., -0.4, 0.4, 0., 0.4, 0.4, 0.,
                        0., 0.8, 0.,
                    ],
                    vec![0, 1, 2, 3, 4, 5],
                );
                g.material_indices = vec![0, 0, 0, 1, 1, 1].into();
                m.geometry = s.add_geometry(g).unwrap();
                m.materials = vec![mat, emitter];
            }
            meshes.push(s.add_mesh(m).unwrap());
        }
        let mut camera = Camera::default();
        camera.world_matrix[14] = 3.;
        s.set_default_camera(Some(camera));
        s.add_light(Light::Directional {
            color: [1.; 3],
            intensity: 1.,
            transform: Mat4::IDENTITY,
        })
        .unwrap();
        let settings = RenderSettings {
            max_samples: 8,
            aovs: 32,
            aov_samples: 1,
            size: RenderSize::Fixed {
                width: 48,
                height: 40,
            },
            ..Default::default()
        };
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let render = Render::new(&engine, settings.clone()).unwrap();
        engine.set_scene_object(&s).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        for step in 0..12 {
            match step {
                0..=3 => s.set_mesh_visible(meshes[step], false).unwrap(),
                4..=7 => s.set_mesh_visible(meshes[step - 4], true).unwrap(),
                8 => {
                    s.set_mesh_visible(meshes[2], false).unwrap();
                    s.mesh_mut(meshes[0]).unwrap().transform =
                        Mat4::from_translation(Vec3::new(-0.6, 0.1, 0.));
                    s.material_mut(mat).unwrap().values.color = [0.2, 0.5, 0.8];
                }
                9 => {
                    s.mesh_mut(meshes[2]).unwrap().transform =
                        Mat4::from_translation(Vec3::new(0.5, 0.1, 0.));
                    s.material_mut(emitter).unwrap().values.emission_strength = 0.5;
                }
                10 => s.set_mesh_visible(meshes[2], true).unwrap(),
                _ => {
                    for &m in &meshes {
                        s.set_mesh_visible(m, false).unwrap();
                    }
                }
            }
            engine.set_scene_object(&s).unwrap();
            engine.update().unwrap();
            render.converge(ConvergeOptions::new(8)).unwrap();
            assert_eq!(
                render.last_commit().unwrap(),
                Some(CommitKind::Incremental),
                "{backend:?} step {step}"
            );
            let full = Engine::new(EngineOptions { backend }).unwrap();
            let reference = Render::new(&full, settings.clone()).unwrap();
            full.set_scene(&removed_hidden_descriptor(&s.descriptor().unwrap()))
                .unwrap();
            full.update().unwrap();
            reference.converge(ConvergeOptions::new(8)).unwrap();
            for kind in [
                PixelKind::Hdr,
                PixelKind::Normal,
                PixelKind::Albedo,
                PixelKind::Id,
            ] {
                let a = render.read_pixels(kind).unwrap();
                let b = reference.read_pixels(kind).unwrap();
                if let Some(directory) = std::env::var_os("MUTRACER_TEST_CAPTURE") {
                    let directory =
                        std::path::PathBuf::from(directory).join(format!("{backend:?}-{step}"));
                    std::fs::create_dir_all(&directory).unwrap();
                    for (label, image) in [("hidden", &a), ("removed", &b)] {
                        let bytes: &[u8] = if let Some(ids) = &image.id_data {
                            bytemuck::cast_slice(ids)
                        } else {
                            bytemuck::cast_slice(&image.data)
                        };
                        std::fs::write(directory.join(format!("{label}-{kind:?}.bin")), bytes)
                            .unwrap();
                    }
                }
                assert_eq!(
                    a.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                    b.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                    "{backend:?} step {step} {kind:?}"
                );
                assert_eq!(a.id_data, b.id_data, "{backend:?} step {step} ID");
            }
            for x in [6., 18., 30., 42.] {
                assert_eq!(
                    format!("{:?}", engine.pick_surface(x / 48., 0.5).unwrap()),
                    format!("{:?}", full.pick_surface(x / 48., 0.5).unwrap()),
                    "{backend:?} step {step} pick"
                );
            }
            println!("VISIBILITY {backend:?} step {step}: HDR/normal/albedo/ID/pick exact");
        }
        // Start fully hidden, then show without preparing resident resources again.
        let hidden = Engine::new(EngineOptions { backend }).unwrap();
        let hr = Render::new(&hidden, settings.clone()).unwrap();
        hidden.set_scene_object(&s).unwrap();
        hidden.update().unwrap();
        hr.converge(ConvergeOptions::new(8)).unwrap();
        for &m in &meshes {
            s.set_mesh_visible(m, true).unwrap();
        }
        hidden.set_scene_object(&s).unwrap();
        hidden.update().unwrap();
        hr.converge(ConvergeOptions::new(8)).unwrap();
        assert_eq!(hr.last_commit().unwrap(), Some(CommitKind::Incremental));
        engine.set_scene_object(&s).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        for kind in [PixelKind::Hdr, PixelKind::Id] {
            assert_eq!(
                hr.read_pixels(kind).unwrap(),
                render.read_pixels(kind).unwrap(),
                "{backend:?} initially hidden {kind:?}"
            );
        }
    }
}
