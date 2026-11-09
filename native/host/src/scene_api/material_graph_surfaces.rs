// Real-GPU surface/shadow contracts use the same scenes as materialGraphOpacity.ts.
fn graph_plane(segments: usize, constant_uv: bool) -> Geometry {
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    let mut normals = Vec::new();
    let mut uv = Vec::new();
    for y in 0..=segments {
        for x in 0..=segments {
            let s = x as f32 / segments as f32;
            let t = y as f32 / segments as f32;
            positions.extend([2. * s - 1., 2. * t - 1., 0.]);
            normals.extend([0., 0., 1.]);
            uv.extend(if constant_uv { [0.37; 2] } else { [s, t] });
            if x < segments && y < segments {
                let i = (x + y * (segments + 1)) as u32;
                let next = i + segments as u32 + 1;
                indices.extend([i, i + 1, next, next, i + 1, next + 1]);
            }
        }
    }
    let mut geometry = Geometry::new(positions, indices);
    geometry.normals = normals.into();
    geometry.uv[0] = uv.into();
    geometry
}
#[test]
#[ignore = "requires a real GPU; run separately"]
fn material_graph_gpu_opacity_surface_shadow_and_lit_fallback() {
    check_opacity_and_lit(true);
}
#[test]
#[ignore = "requires a real GPU; run separately"]
fn constant_material_opacity_surface_shadow_and_lit_control() {
    check_opacity_and_lit(false);
}
fn check_opacity_and_lit(use_graph: bool) {
    use crate::api::{
        Backend, Camera, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
        RenderSize,
    };
    use crate::scene_api::{Environment, Light, Texture, TexturePixels};
    let _lock = crate::abi_test_lock();
    crate::logging::stderr();
    let destination =
        std::env::var_os("MUTRACER_GRAPH_MATRIX_OUTPUT").map(std::path::PathBuf::from);
    for backend in [Backend::Software, Backend::Hardware] {
        let mut results = Vec::new();
        for (mode, label, cutoff, scale, mapped) in [
            (0, "auto", 0., 1., false),
            (1, "opaque", 0., 1., false),
            (2, "mask", 0.25, 1., false),
            (2, "mask", 0.5, 1., false),
            (3, "blend", 0., 1., false),
            (3, "blend", 0., 1., true),
            (3, "blend", 0., 2., false),
        ] {
            let mut scene = Scene::new();
            let blocker_geometry = scene.add_geometry(graph_plane(1, true)).unwrap();
            let receiver_geometry = scene.add_geometry(graph_plane(4, false)).unwrap();
            let mut graph = coverage_graph();
            graph.nodes.truncate(2);
            graph.inputs.truncate(3);
            graph.parameters.truncate(2);
            graph.author_ids.truncate(2);
            graph.terminals.retain(|t| t.port == terminal::OPACITY);
            let mut blocker = OpenPbrMaterial::default();
            blocker.values.color = [0.7, 0.15, 0.05];
            blocker.values.roughness = 0.5;
            blocker.values.alpha_mode = mode;
            blocker.values.alpha_cutoff = cutoff;
            blocker.set_float(56, [scale, 1., 0.]).unwrap();
            if !use_graph {
                blocker.values.opacity = 0.37 * scale;
            }
            blocker.graph = use_graph.then_some(graph);
            if mapped {
                let mut texture = Texture::rgba8(1, 1, vec![]);
                texture.pixels = TexturePixels::Rgba32F(vec![0.5, 0.5, 0.5, 1.].into());
                let texture = scene.add_texture(texture).unwrap();
                blocker.set_texture(40, Some(texture)).unwrap();
            }
            let blocker = scene.add_material(blocker).unwrap();
            let mut receiver = OpenPbrMaterial::default();
            receiver.values.color = [0.5, 0.6, 0.7];
            receiver.values.roughness = 0.7;
            let receiver = scene.add_material(receiver).unwrap();
            let mut mesh = Mesh::new(blocker_geometry, blocker);
            mesh.transform = glam::Mat4::from_scale_rotation_translation(
                glam::Vec3::new(0.4, 0.4, 1.),
                glam::Quat::IDENTITY,
                glam::Vec3::new(0., 0., 0.6),
            );
            let blocker_mesh = scene.add_mesh(mesh).unwrap();
            let receiver_mesh = scene
                .add_mesh(Mesh::new(receiver_geometry, receiver))
                .unwrap();
            scene.aov_handles.insert(receiver_mesh.0, 1);
            scene.aov_handles.insert(blocker_mesh.0, 2);
            scene.aov_handles.insert(receiver.0, 3);
            scene.aov_handles.insert(blocker.0, 4);
            scene
                .add_light(Light::Sphere {
                    color: [1.; 3],
                    intensity: 8.,
                    radius: 0.,
                    transform: glam::Mat4::from_translation(glam::Vec3::new(1.5, 1., 2.)),
                })
                .unwrap();
            scene
                .set_environment(Environment {
                    color: [0.2, 0.3, 0.4, 1.],
                    ..Default::default()
                })
                .unwrap();
            let engine = Engine::new(EngineOptions { backend }).unwrap();
            let render = Render::new(
                &engine,
                RenderSettings {
                    seed: 0,
                    bounces: 3,
                    max_samples: 32,
                    direct_light_candidates: 1,
                    aovs: 32,
                    aov_samples: 1,
                    size: RenderSize::Fixed {
                        width: 48,
                        height: 48,
                    },
                    ..Default::default()
                },
            )
            .unwrap();
            let mut camera = Camera {
                projection: 1,
                ..Default::default()
            };
            camera.world_matrix[14] = 3.;
            engine.set_camera(Some(camera)).unwrap();
            let settle = |scene: &Scene| {
                engine.set_scene_object(scene).unwrap();
                engine.update().unwrap();
                finish(&engine, &render);
                render.converge(ConvergeOptions::new(32)).unwrap();
                render.read_pixels(PixelKind::Hdr).unwrap().data
            };
            let actual = settle(&scene);
            assert_eq!(
                render.backend().unwrap().0,
                backend,
                "{label}: traversal backend"
            );
            assert!(
                engine.diagnostics().material_graphs.is_empty(),
                "{label}: {:?}",
                engine.diagnostics().material_graphs
            );
            let ids = render.read_pixels(PixelKind::Id).unwrap().id_data;
            let name = format!(
                "opacity-{label}-{cutoff}-{scale}{}",
                if mapped { "-map" } else { "" }
            );
            if let Some(path) = &destination {
                std::fs::create_dir_all(path).unwrap();
                std::fs::write(
                    path.join(format!("{backend:?}-{name}.f32")),
                    actual
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                )
                .unwrap();
                std::fs::write(
                    path.join(format!("{backend:?}-{name}-id.json")),
                    serde_json::to_vec(&ids).unwrap(),
                )
                .unwrap();
            }
            {
                let m = scene.material_mut(blocker).unwrap();
                m.graph = None;
                m.values.opacity = 0.37 * scale;
            }
            let reference = settle(&scene);
            let reference_ids = render.read_pixels(PixelKind::Id).unwrap().id_data;
            if let Some(path) = &destination {
                std::fs::write(
                    path.join(format!("{backend:?}-{name}-reference-id.json")),
                    serde_json::to_vec(&reference_ids).unwrap(),
                )
                .unwrap();
            }
            let max_error = actual
                .iter()
                .zip(&reference)
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            if max_error >= 0.003 {
                if let Some(path) = &destination {
                    std::fs::write(
                        path.join(format!("{backend:?}-{name}-reference.f32")),
                        reference
                            .iter()
                            .flat_map(|v| v.to_le_bytes())
                            .collect::<Vec<_>>(),
                    )
                    .unwrap();
                }
            }
            assert!(max_error < 0.003, "{backend:?}/{name}: {max_error}");
            {
                let m = scene.material_mut(blocker).unwrap();
                m.values.alpha_mode = 1;
                m.values.opacity = 1.;
            }
            let solid = settle(&scene);
            {
                let m = scene.material_mut(blocker).unwrap();
                m.values.alpha_mode = 3;
                m.values.opacity = 0.;
            }
            let clear = settle(&scene);
            let mut coverage = 0f32;
            let mut shadow = 0f32;
            for (i, (a, b)) in solid.iter().zip(&clear).enumerate() {
                let d = (a - b).abs();
                coverage = coverage.max(d);
                if i / 4 % 48 <= 10 && i % 4 < 3 {
                    shadow = shadow.max(d);
                }
            }
            assert!(
                coverage > 0.01 && shadow > 0.01,
                "{backend:?}/{name}: coverage {coverage} shadow {shadow}"
            );
            results.push(serde_json::json!({"name":name,"maxError":max_error,"coverageDifference":coverage,"shadowDifference":shadow}));
            // Lit emission uses the same explicit constant-material fallback.
            let m = scene.material_mut(blocker).unwrap();
            m.values.alpha_mode = 1;
            m.values.opacity = 1.;
            m.values.emission_strength = 1.;
            m.values.emission = [0.2; 3];
            m.graph = use_graph.then(|| emission_graph(0.9, false));
            let lit = settle(&scene);
            assert_eq!(
                engine
                    .diagnostics()
                    .material_graphs
                    .iter()
                    .any(|d| d.code == "unsupported-emission-graph"),
                use_graph
            );
            scene.material_mut(blocker).unwrap().graph = None;
            let reference = settle(&scene);
            let differences = lit
                .iter()
                .zip(&reference)
                .filter(|(a, b)| a.to_bits() != b.to_bits())
                .count();
            let lit_error = lit
                .iter()
                .zip(&reference)
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            if differences > 0 {
                if let Some(path) = &destination {
                    for (side, image) in [("graph", &lit), ("constant", &reference)] {
                        std::fs::write(
                            path.join(format!("{backend:?}-{name}-lit-{side}.f32")),
                            image
                                .iter()
                                .flat_map(|v| v.to_le_bytes())
                                .collect::<Vec<_>>(),
                        )
                        .unwrap();
                    }
                }
            }
            assert_eq!(
                differences, 0,
                "{backend:?}/{name} lit fallback: {differences} components, max error {lit_error}"
            );
        }
        if let Some(path) = &destination {
            std::fs::write(
                path.join(format!("{backend:?}-opacity.json")),
                serde_json::to_vec_pretty(&results).unwrap(),
            )
            .unwrap();
        }
    }
}
#[test]
#[ignore = "requires a real GPU; run separately"]
fn material_graph_gpu_transport_fallback_matches_constant_material() {
    use crate::api::{
        Backend, Camera, CausticSettings, ConvergeOptions, Engine, EngineOptions, PixelKind,
        Render, RenderSettings, RenderSize,
    };
    use crate::scene_api::Light;
    let _lock = crate::abi_test_lock();
    crate::logging::stderr();
    for backend in [Backend::Software, Backend::Hardware] {
        for photons in [false, true] {
            let mut scene = Scene::new();
            let geometry = scene.add_geometry(graph_plane(1, false)).unwrap();
            let mut material = OpenPbrMaterial::default();
            material.values.color = [0.5, 0.6, 0.7];
            material.values.roughness = 0.7;
            let mut graph = emission_graph(0.9, false);
            graph.terminals[0].port = terminal::BASE_COLOR;
            material.graph = Some(graph);
            let material = scene.add_material(material).unwrap();
            scene.add_mesh(Mesh::new(geometry, material)).unwrap();
            let mut glass = OpenPbrMaterial::default();
            glass.values.transmission = 1.;
            glass.values.roughness = 0.;
            glass.values.layers.thin_walled = true;
            let glass = scene.add_material(glass).unwrap();
            let mut caster = Mesh::new(geometry, glass);
            caster.transform = glam::Mat4::from_scale_rotation_translation(
                glam::Vec3::new(0.4, 0.4, 1.),
                glam::Quat::IDENTITY,
                glam::Vec3::new(0., 0., 0.6),
            );
            scene.add_mesh(caster).unwrap();
            scene
                .add_light(Light::Sphere {
                    color: [1.; 3],
                    intensity: 8.,
                    radius: 0.,
                    transform: glam::Mat4::from_translation(glam::Vec3::new(1.5, 1., 2.)),
                })
                .unwrap();
            let engine = Engine::new(EngineOptions { backend }).unwrap();
            let render = Render::new(
                &engine,
                RenderSettings {
                    seed: 0,
                    max_samples: 4,
                    size: RenderSize::Fixed {
                        width: 32,
                        height: 32,
                    },
                    caustics: CausticSettings {
                        light_tracing: !photons,
                        photon_mapping: photons,
                        light_photons: 64,
                        photon_map_photons: 64,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .unwrap();
            let mut camera = Camera {
                projection: 1,
                ..Default::default()
            };
            camera.world_matrix[14] = 3.;
            engine.set_camera(Some(camera)).unwrap();
            engine.set_scene_object(&scene).unwrap();
            engine.update().unwrap();
            finish(&engine, &render);
            render.converge(ConvergeOptions::new(4)).unwrap();
            let actual = render.read_pixels(PixelKind::Hdr).unwrap().data;
            assert!(
                engine
                    .diagnostics()
                    .renders
                    .iter()
                    .flat_map(|r| &r.material_graphs)
                    .any(|d| d.code == "unsupported-transport"),
                "{backend:?}/{photons}: {:?}",
                engine.diagnostics().material_graphs
            );
            scene.material_mut(material).unwrap().graph = None;
            engine.set_scene_object(&scene).unwrap();
            engine.update().unwrap();
            finish(&engine, &render);
            render.converge(ConvergeOptions::new(4)).unwrap();
            let reference = render.read_pixels(PixelKind::Hdr).unwrap().data;
            let max_error = actual
                .iter()
                .zip(reference)
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            assert!(
                max_error < 0.003,
                "{backend:?}/photon={photons}: {max_error}"
            );
            eprintln!("GRAPH_TRANSPORT {backend:?}/photon={photons}: {max_error}");
        }
    }
}

#[test]
#[ignore = "requires a real GPU; run separately"]
fn material_graph_surface_normal_and_bsdf_parameters_match_fresh() {
    check_normal_and_bsdf(true);
}
#[test]
#[ignore = "requires a real GPU; run separately"]
fn constant_material_normal_and_bsdf_parameters_match_fresh_control() {
    check_normal_and_bsdf(false);
}
fn check_normal_and_bsdf(use_graph: bool) {
    use crate::api::{
        Backend, Camera, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
        RenderSize,
    };
    let _lock = crate::abi_test_lock();
    for backend in [Backend::Software, Backend::Hardware] {
        let mut scene = Scene::new();
        let geometry = scene.add_geometry(graph_plane(1, true)).unwrap();
        let mut material = OpenPbrMaterial::default();
        let mut graph = MaterialGraph::default();
        for (i, (kind, target, value)) in [
            (port_type::COLOR3, terminal::BASE_COLOR, [0.2, 0.4, 0.6, 0.]),
            (
                port_type::FLOAT,
                terminal::SPECULAR_ROUGHNESS,
                [0.25, 0., 0., 0.],
            ),
            (port_type::VECTOR3, terminal::NORMAL, [0., 0., 1., 0.]),
        ]
        .into_iter()
        .enumerate()
        {
            graph.nodes.push(GraphNode {
                category: category::CONSTANT,
                implementation: 1,
                port_type: kind,
                first_input: i as u32,
                input_count: 1,
            });
            graph.inputs.push(GraphInput {
                port: port::VALUE,
                port_type: kind,
                source_kind: source::PARAMETER,
                source: i as u32,
                output: output::OUT,
            });
            graph.terminals.push(GraphTerminal {
                port: target,
                node: i as u32,
                output: output::OUT,
            });
            graph.parameters.push(value);
            graph.author_ids.push(format!("/Surface/parameter{i}"));
        }
        let normal_texture = if use_graph {
            None
        } else {
            Some(
                scene
                    .add_texture(crate::scene_api::Texture {
                        pixels: crate::scene_api::TexturePixels::Rgba32F(
                            vec![0.5, 0.5, 1., 1.].into(),
                        ),
                        ..crate::scene_api::Texture::rgba8(1, 1, vec![])
                    })
                    .unwrap(),
            )
        };
        if use_graph {
            material.graph = Some(graph);
        } else {
            material.values.color = [0.2, 0.4, 0.6];
            material.values.roughness = 0.25;
            material.set_texture(44, normal_texture).unwrap();
        }
        let material = scene.add_material(material).unwrap();
        scene.add_mesh(Mesh::new(geometry, material)).unwrap();
        scene
            .add_light(crate::scene_api::Light::Sphere {
                color: [1.; 3],
                intensity: 8.,
                radius: 0.,
                transform: glam::Mat4::from_translation(glam::Vec3::new(1.5, 1., 2.)),
            })
            .unwrap();
        let settings = RenderSettings {
            seed: 0,
            bounces: 1,
            max_samples: 8,
            aovs: 32,
            aov_samples: 1,
            size: RenderSize::Fixed {
                width: 32,
                height: 32,
            },
            ..Default::default()
        };
        let mut camera = Camera {
            projection: 1,
            ..Default::default()
        };
        camera.world_matrix[14] = 3.;
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        engine.set_camera(Some(camera)).unwrap();
        let render = Render::new(&engine, settings.clone()).unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        finish(&engine, &render);
        render.converge(ConvergeOptions::new(8)).unwrap();
        assert_eq!(render.backend().unwrap().0, backend);
        let before = render.read_pixels(PixelKind::Hdr).unwrap().data;
        let compiled = engine.diagnostics().compilations_started;
        if use_graph {
            scene
                .material_mut(material)
                .unwrap()
                .graph
                .as_mut()
                .unwrap()
                .parameters[2] = [0.6, 0., 0.8, 0.];
        } else {
            scene.texture_mut(normal_texture.unwrap()).unwrap().pixels =
                crate::scene_api::TexturePixels::Rgba32F(vec![0.8, 0.5, 0.9, 1.].into());
        }
        assert_eq!(
            scene.pending_commit_kind().unwrap(),
            CommitKind::Incremental
        );
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        finish(&engine, &render);
        render.converge(ConvergeOptions::new(8)).unwrap();
        assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Incremental));
        assert_eq!(engine.diagnostics().compilations_started, compiled);
        let normals = render.read_pixels(PixelKind::Normal).unwrap();
        let normal = &normals.data[(16 * 32 + 16) * 4..(16 * 32 + 16) * 4 + 3];
        let valid_normal = normal
            .iter()
            .zip([0.6, 0., 0.8])
            .all(|(actual, expected)| (actual - expected).abs() < 0.001);
        if !valid_normal {
            if let Some(path) = std::env::var_os("MUTRACER_GRAPH_MATRIX_OUTPUT") {
                let path = std::path::PathBuf::from(path);
                std::fs::create_dir_all(&path).unwrap();
                // Preserve this frame before the center-normal assertion, which
                // precedes the retained/fresh comparison capture below.
                for (name, data) in [
                    ("hdr", render.read_pixels(PixelKind::Hdr).unwrap().data),
                    ("normal", normals.data.clone()),
                ] {
                    std::fs::write(
                        path.join(format!("{backend:?}-normal-precheck-{name}.f32")),
                        data.iter()
                            .flat_map(|v| v.to_le_bytes())
                            .collect::<Vec<_>>(),
                    )
                    .unwrap();
                }
            }
        }
        assert!(valid_normal, "{backend:?}: {normal:?}");
        let after = render.read_pixels(PixelKind::Hdr).unwrap().data;
        assert!(
            before
                .iter()
                .zip(&after)
                .any(|(a, b)| (a - b).abs() > 0.001)
        );
        let fresh = Engine::new(EngineOptions { backend }).unwrap();
        fresh.set_camera(Some(camera)).unwrap();
        let reference = Render::new(&fresh, settings).unwrap();
        fresh.set_scene_object(&scene).unwrap();
        fresh.update().unwrap();
        finish(&fresh, &reference);
        reference.converge(ConvergeOptions::new(8)).unwrap();
        for kind in [
            PixelKind::Hdr,
            PixelKind::Normal,
            PixelKind::Albedo,
            PixelKind::Id,
        ] {
            let a = render.read_pixels(kind).unwrap();
            let b = reference.read_pixels(kind).unwrap();
            let different = a
                .data
                .iter()
                .zip(&b.data)
                .filter(|(x, y)| x.to_bits() != y.to_bits())
                .count();
            let max_error = a
                .data
                .iter()
                .zip(&b.data)
                .map(|(x, y)| (x - y).abs())
                .fold(0f32, f32::max);
            if different > 0 {
                if let Some(path) = std::env::var_os("MUTRACER_GRAPH_MATRIX_OUTPUT") {
                    let path = std::path::PathBuf::from(path);
                    std::fs::create_dir_all(&path).unwrap();
                    for (label, values) in [("retained", &a.data), ("fresh", &b.data)] {
                        std::fs::write(
                            path.join(format!("{backend:?}-normal-{kind:?}-{label}.f32")),
                            values
                                .iter()
                                .flat_map(|v| v.to_le_bytes())
                                .collect::<Vec<_>>(),
                        )
                        .unwrap();
                    }
                }
            }
            assert_eq!(
                different, 0,
                "{backend:?}/{kind:?}: {different} components, max error {max_error}"
            );
            assert_eq!(a.id_data, b.id_data);
        }
        eprintln!(
            "GRAPH_SURFACE {backend:?}: normal={normal:?}, Incremental, HDR/guides/ID exact to fresh"
        );
    }
}
