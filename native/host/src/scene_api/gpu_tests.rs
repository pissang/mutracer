use super::*;
use crate::api::{
    Backend, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings, RenderSize,
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
        let expected = if edit == 15 {
            CommitKind::Full
        } else {
            CommitKind::Incremental
        };
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
