use super::*;
fn finish(engine: &crate::api::Engine, render: &crate::api::Render) {
    let start = std::time::Instant::now();
    loop {
        let status = render.refine().unwrap();
        assert_ne!(
            status,
            crate::api::RenderStatus::Error,
            "{:?}",
            engine.diagnostics()
        );
        if !matches!(
            status,
            crate::api::RenderStatus::Preparing | crate::api::RenderStatus::Compiling
        ) {
            break;
        }
        assert!(
            start.elapsed().as_secs() < 60,
            "graph preparation timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}
fn center(render: &crate::api::Render) -> f32 {
    let image = render.read_pixels(crate::api::PixelKind::Hdr).unwrap();
    image.data[((image.height / 2) * image.width + image.width / 2) as usize * 4]
}
#[test]
#[ignore = "requires a real GPU; run separately"]
fn material_graph_gpu_incremental_retention_and_superseded_installations() {
    use crate::api::{
        Backend, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
        RenderSize,
    };
    let _lock = crate::abi_test_lock();
    crate::logging::stderr();
    for backend in [Backend::Software, Backend::Hardware] {
        let (mut scene, material) = scene();
        {
            let m = scene.material_mut(material).unwrap();
            m.values.unlit = true;
            m.values.emission_strength = 1.;
            m.values.emission = [0.1; 3];
            m.graph = Some(emission_graph(0.2, false));
        }
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let settings = RenderSettings {
            max_samples: 64,
            aovs: 32,
            aov_samples: 1,
            size: RenderSize::Fixed {
                width: 32,
                height: 24,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        finish(&engine, &render);
        render.converge(ConvergeOptions::new(4)).unwrap();
        assert!(
            (center(&render) - 0.2).abs() < 1e-6,
            "initial graph {:?}: {}",
            backend,
            center(&render)
        );
        let compiled = engine.diagnostics().compilations_started;
        scene
            .material_mut(material)
            .unwrap()
            .graph
            .as_mut()
            .unwrap()
            .parameters[0] = [0.6, 0.6, 0.6, 0.];
        assert_eq!(
            scene.pending_commit_kind().unwrap(),
            CommitKind::Incremental
        );
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        finish(&engine, &render);
        render.converge(ConvergeOptions::new(4)).unwrap();
        assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Incremental));
        assert_eq!(engine.diagnostics().compilations_started, compiled);
        assert!((center(&render) - 0.6).abs() < 1e-6);
        let fresh = Engine::new(EngineOptions { backend }).unwrap();
        let reference = Render::new(&fresh, settings.clone()).unwrap();
        fresh.set_scene_object(&scene).unwrap();
        fresh.update().unwrap();
        finish(&fresh, &reference);
        reference.converge(ConvergeOptions::new(4)).unwrap();
        for kind in [PixelKind::Hdr, PixelKind::Id] {
            let a = render.read_pixels(kind).unwrap();
            let b = reference.read_pixels(kind).unwrap();
            assert_eq!(
                a.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                b.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                "{backend:?}/{kind:?}"
            );
            assert_eq!(a.id_data, b.id_data);
        }
        // The independent browser fixture describes the same logical event trace.
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/display-schedule.json"
        ))
        .unwrap();
        scene.material_mut(material).unwrap().graph = Some(emission_graph(0.2, false));
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        finish(&engine, &render);
        render.converge(ConvergeOptions::new(4)).unwrap();
        let (resume, resumed) = std::sync::mpsc::sync_channel(1);
        *crate::context::PREPARATION_GATE.lock().unwrap() = Some(resumed);
        let mut resume = Some(resume);
        let mut sampled = Vec::new();
        let mut old_captured = 0;
        for event in fixture["materialGraphPreparation"]["events"]
            .as_array()
            .unwrap()
        {
            match event.as_str().unwrap() {
                "sample" => sampled.push(center(&render)),
                "request-structure" => {
                    old_captured = engine.diagnostics().renders[0].captured_samples;
                    scene.material_mut(material).unwrap().graph = Some(emission_graph(0.4, true));
                    assert_eq!(scene.pending_commit_kind().unwrap(), CommitKind::Full);
                    engine.set_scene_object(&scene).unwrap();
                    engine.update().unwrap();
                    let start = std::time::Instant::now();
                    while engine.diagnostics().renders[0].captured_samples <= old_captured {
                        render.refine().unwrap();
                        assert!(start.elapsed().as_secs() < 10, "old graph stopped sampling");
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    eprintln!(
                        "GRAPH_PENDING {:?} captured {} -> {}",
                        backend,
                        old_captured,
                        engine.diagnostics().renders[0].captured_samples
                    );
                }
                "request-newer" => {
                    scene.material_mut(material).unwrap().graph = Some(emission_graph(0.8, true));
                    engine.set_scene_object(&scene).unwrap();
                    engine.update().unwrap();
                }
                "complete-obsolete" => {}
                "complete-current" => {
                    resume.take().unwrap().send(()).unwrap();
                    finish(&engine, &render);
                    render.converge(ConvergeOptions::new(4)).unwrap();
                    assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Full));
                }
                "request-invalid" => {
                    let mut graph = emission_graph(0.9, true);
                    graph.nodes[0].category = 999;
                    scene.material_mut(material).unwrap().graph = Some(graph);
                    engine.set_scene_object(&scene).unwrap();
                    engine.update().unwrap();
                    finish(&engine, &render);
                    render.converge(ConvergeOptions::new(4)).unwrap();
                    assert!(
                        engine
                            .diagnostics()
                            .material_graphs
                            .iter()
                            .any(|d| d.code == "unsupported-node" && d.node == "/Material/value")
                    );
                }
                _ => unreachable!(),
            }
        }
        let expected: Vec<f32> = fixture["materialGraphPreparation"]["sampledValues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap() as f32)
            .collect();
        assert_eq!(sampled.len(), expected.len());
        for (a, b) in sampled.iter().zip(&expected) {
            assert!((a - b).abs() < 1e-6, "{backend:?}: {sampled:?}");
        }
        eprintln!(
            "GRAPH_SCHEDULE {:?} old samples {} -> {}, values {:?}",
            backend,
            old_captured,
            engine.diagnostics().renders[0].captured_samples,
            sampled
        );
    }
}
#[test]
#[ignore = "requires a real GPU; run separately"]
fn material_graph_gpu_node_matrix_matches_cpu_and_constant_material() {
    use crate::api::{
        Backend, Camera, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
        RenderSize,
    };
    use crate::scene_api::{Texture, TexturePixels};
    let _lock = crate::abi_test_lock();
    crate::logging::stderr();
    let rows: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/material-graph-matrix.json"
    ))
    .unwrap();
    let destination =
        std::env::var_os("MUTRACER_GRAPH_MATRIX_OUTPUT").map(std::path::PathBuf::from);
    if let Some(path) = &destination {
        std::fs::create_dir_all(path).unwrap();
    }
    for backend in [Backend::Software, Backend::Hardware] {
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let settings = RenderSettings {
            seed: 0,
            bounces: 1,
            max_samples: 4,
            aovs: 32,
            aov_samples: 1,
            size: RenderSize::Fixed {
                width: 32,
                height: 32,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings).unwrap();
        let mut camera = Camera {
            projection: 1,
            ..Default::default()
        };
        camera.world_matrix[14] = 3.;
        engine.set_camera(Some(camera)).unwrap();
        let mut results = Vec::new();
        for row in rows.as_array().unwrap() {
            let name = row["name"].as_str().unwrap();
            let mut scene = Scene::new();
            let mut geometry = Geometry::new(
                vec![-1., -1., 0., 1., -1., 0., -1., 1., 0., 1., 1., 0.],
                vec![0, 1, 2, 2, 1, 3],
            );
            geometry.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1.].into();
            geometry.uv[0] = vec![0.37, 0.61, 0.37, 0.61, 0.37, 0.61, 0.37, 0.61].into();
            let geometry = scene.add_geometry(geometry).unwrap();
            let mut textures = Vec::new();
            for t in row["textures"].as_array().unwrap() {
                let mut texture = Texture::rgba8(
                    t["width"].as_u64().unwrap() as u32,
                    t["height"].as_u64().unwrap() as u32,
                    vec![],
                );
                texture.pixels = TexturePixels::Rgba32F(
                    t["data"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_f64().unwrap() as f32)
                        .collect::<Vec<_>>()
                        .into(),
                );
                texture.scale = std::array::from_fn(|i| t["scale"][i].as_f64().unwrap() as f32);
                texture.offset = std::array::from_fn(|i| t["offset"][i].as_f64().unwrap() as f32);
                texture.wrap = std::array::from_fn(|i| t["wrap"][i].as_u64().unwrap() as u32);
                texture.udim = t["udim"].as_bool().unwrap();
                texture.flip_y = t["flipY"].as_bool().unwrap();
                textures.push(Some(scene.add_texture(texture).unwrap()));
            }
            let ir = &row["ir"];
            let integers = |key: &str| {
                ir[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u32)
                    .collect::<Vec<_>>()
            };
            let graph = MaterialGraph {
                version: 1,
                nodes: integers("nodes")
                    .chunks_exact(5)
                    .map(|v| GraphNode {
                        category: v[0],
                        implementation: v[1],
                        port_type: v[2],
                        first_input: v[3],
                        input_count: v[4],
                    })
                    .collect(),
                inputs: integers("inputs")
                    .chunks_exact(5)
                    .map(|v| GraphInput {
                        port: v[0],
                        port_type: v[1],
                        source_kind: v[2],
                        source: v[3],
                        output: v[4],
                    })
                    .collect(),
                terminals: integers("terminal")
                    .chunks_exact(3)
                    .map(|v| GraphTerminal {
                        port: v[0],
                        node: v[1],
                        output: v[2],
                    })
                    .collect(),
                parameters: ir["parameters"]
                    .as_array()
                    .unwrap()
                    .chunks_exact(4)
                    .map(|v| std::array::from_fn(|i| v[i].as_f64().unwrap() as f32))
                    .collect(),
                textures,
                author_ids: row["authorIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().into())
                    .collect(),
            };
            let mut material = OpenPbrMaterial::default();
            material.values.unlit = true;
            material.values.emission_strength = 1.;
            material.graph = Some(graph);
            let material = scene.add_material(material).unwrap();
            let mesh = scene.add_mesh(Mesh::new(geometry, material)).unwrap();
            scene.aov_handles.insert(mesh.0, 1);
            scene.aov_handles.insert(material.0, 2);
            let started = std::time::Instant::now();
            engine.set_scene_object(&scene).unwrap();
            engine.update().unwrap();
            finish(&engine, &render);
            render.converge(ConvergeOptions::new(4)).unwrap();
            let first_ms = started.elapsed().as_secs_f64() * 1000.;
            assert!(
                engine.diagnostics().material_graphs.is_empty(),
                "{name}: {:?}",
                engine.diagnostics().material_graphs
            );
            let actual = render.read_pixels(PixelKind::Hdr).unwrap();
            let ids = render.read_pixels(PixelKind::Id).unwrap();
            if let Some(path) = &destination {
                let prefix = format!("{backend:?}-{name}");
                std::fs::write(
                    path.join(format!("{prefix}.f32")),
                    actual
                        .data
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                )
                .unwrap();
                std::fs::write(
                    path.join(format!("{prefix}-id.json")),
                    serde_json::to_vec(&ids.id_data).unwrap(),
                )
                .unwrap();
            }
            let expected: [f32; 3] =
                std::array::from_fn(|i| row["expected"][i].as_f64().unwrap() as f32);
            {
                let m = scene.material_mut(material).unwrap();
                m.graph = None;
                m.values.emission = expected;
            }
            engine.set_scene_object(&scene).unwrap();
            engine.update().unwrap();
            finish(&engine, &render);
            render.converge(ConvergeOptions::new(4)).unwrap();
            let reference = render.read_pixels(PixelKind::Hdr).unwrap();
            let max_error = actual
                .data
                .iter()
                .zip(&reference.data)
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            assert!(
                actual.data.iter().all(|v| v.is_finite()) && actual.data.iter().any(|v| *v > 1.),
                "{backend:?}/{name}: invalid/black output"
            );
            eprintln!("GRAPH_MATRIX {backend:?}/{name}: error={max_error} first_ms={first_ms}");
            results.push(serde_json::json!({"name":name,"maxError":max_error,"firstMs":first_ms,"expected":expected,"passed":max_error<0.003}));
        }
        if let Some(path) = &destination {
            std::fs::write(
                path.join(format!("{backend:?}-matrix.json")),
                serde_json::to_vec_pretty(&results).unwrap(),
            )
            .unwrap();
        }
        assert!(
            results.iter().all(|r| r["passed"].as_bool().unwrap()),
            "{backend:?} matrix differences: {}",
            serde_json::to_string(
                &results
                    .iter()
                    .filter(|r| !r["passed"].as_bool().unwrap())
                    .collect::<Vec<_>>()
            )
            .unwrap()
        );
    }
}
#[test]
#[ignore = "requires a real GPU; run separately"]
fn material_graph_gpu_pipeline_failure_keeps_installed_graph_or_first_constants() {
    use crate::api::{
        Backend, ConvergeOptions, Engine, EngineOptions, Render, RenderSettings, RenderSize,
    };
    let _lock = crate::abi_test_lock();
    crate::logging::stderr();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/display-schedule.json"
    ))
    .unwrap();
    for backend in [Backend::Software, Backend::Hardware] {
        let (mut scene, material) = scene();
        {
            let m = scene.material_mut(material).unwrap();
            m.values.unlit = true;
            m.values.emission_strength = 1.;
            m.values.emission = [0.1; 3];
            m.graph = Some(emission_graph(0.2, false));
        }
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let settings = RenderSettings {
            max_samples: 64,
            size: RenderSize::Fixed {
                width: 32,
                height: 32,
            },
            ..Default::default()
        };
        let render = Render::new(&engine, settings.clone()).unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        finish(&engine, &render);
        render.converge(ConvergeOptions::new(4)).unwrap();
        let mut sampled = Vec::new();
        for event in fixture["materialGraphCompilationFailure"]["events"]
            .as_array()
            .unwrap()
        {
            match event.as_str().unwrap() {
                "sample" => {
                    render.refine().unwrap();
                    sampled.push(center(&render));
                }
                "request" => {
                    scene.material_mut(material).unwrap().graph = Some(emission_graph(0.9, true));
                    crate::FAIL_GRAPH_PIPELINES.store(
                        if backend == Backend::Hardware { 2 } else { 1 },
                        std::sync::atomic::Ordering::SeqCst,
                    );
                    engine.set_scene_object(&scene).unwrap();
                    engine.update().unwrap();
                }
                "fail" => {
                    finish(&engine, &render);
                    crate::FAIL_GRAPH_PIPELINES.store(0, std::sync::atomic::Ordering::SeqCst);
                    assert!(
                        engine
                            .diagnostics()
                            .material_graphs
                            .iter()
                            .any(|d| d.code == "shader-compilation")
                    );
                }
                _ => unreachable!(),
            }
        }
        for (a, b) in sampled.iter().zip(
            fixture["materialGraphCompilationFailure"]["sampledValues"]
                .as_array()
                .unwrap(),
        ) {
            assert!(
                (a - b.as_f64().unwrap() as f32).abs() < 1e-6,
                "{backend:?}: {sampled:?}"
            );
        }
        let fresh = Engine::new(EngineOptions { backend }).unwrap();
        let first = Render::new(&fresh, settings).unwrap();
        crate::FAIL_GRAPH_PIPELINES.store(
            if backend == Backend::Hardware { 2 } else { 1 },
            std::sync::atomic::Ordering::SeqCst,
        );
        fresh.set_scene_object(&scene).unwrap();
        fresh.update().unwrap();
        finish(&fresh, &first);
        crate::FAIL_GRAPH_PIPELINES.store(0, std::sync::atomic::Ordering::SeqCst);
        first.converge(ConvergeOptions::new(4)).unwrap();
        assert!(
            (center(&first) - 0.1).abs() < 1e-6,
            "{backend:?}: {}",
            center(&first)
        );
        assert!(
            fresh
                .diagnostics()
                .material_graphs
                .iter()
                .any(|d| d.code == "shader-compilation")
        );
    }
}
include!("material_graph_surfaces.rs");
