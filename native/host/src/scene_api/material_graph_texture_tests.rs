use super::*;
#[test]
#[ignore = "requires a real GPU; run separately"]
fn graph_texture_reference_and_pixels_are_incremental_and_match_fresh() {
    use crate::api::{
        Backend, Camera, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
        RenderSize,
    };
    use crate::scene_api::{Texture, TexturePixels};
    let _lock = crate::abi_test_lock();
    crate::logging::stderr();
    for backend in [Backend::Software, Backend::Hardware] {
        let mut scene = Scene::new();
        let geometry = scene.add_geometry(graph_plane(1, true)).unwrap();
        let mut image = Texture::rgba8(2, 2, vec![]);
        image.pixels = TexturePixels::Rgba32F([0.2, 0.4, 0.6, 1.].repeat(4).into());
        let a = scene.add_texture(image.clone()).unwrap();
        image.pixels = TexturePixels::Rgba32F([0.8, 0.1, 0.3, 1.].repeat(4).into());
        let b = scene.add_texture(image).unwrap();
        let graph = MaterialGraph {
            nodes: vec![GraphNode {
                category: category::IMAGE,
                implementation: 1,
                port_type: port_type::COLOR3,
                first_input: 0,
                input_count: 6,
            }],
            inputs: vec![
                GraphInput {
                    port: port::DEFAULT,
                    port_type: port_type::COLOR3,
                    source_kind: source::PARAMETER,
                    source: 0,
                    output: 0,
                },
                GraphInput {
                    port: port::FILE,
                    port_type: port_type::FILENAME,
                    source_kind: source::PARAMETER,
                    source: 1,
                    output: 0,
                },
                GraphInput {
                    port: port::FILTERTYPE,
                    port_type: port_type::STRING,
                    source_kind: source::PARAMETER,
                    source: 2,
                    output: 0,
                },
                GraphInput {
                    port: port::TEXCOORD,
                    port_type: port_type::VECTOR2,
                    source_kind: source::GEOMETRY,
                    source: schema::geometry::TEXCOORD,
                    output: 0,
                },
                GraphInput {
                    port: port::UADDRESSMODE,
                    port_type: port_type::STRING,
                    source_kind: source::PARAMETER,
                    source: 3,
                    output: 0,
                },
                GraphInput {
                    port: port::VADDRESSMODE,
                    port_type: port_type::STRING,
                    source_kind: source::PARAMETER,
                    source: 4,
                    output: 0,
                },
            ],
            parameters: vec![[0.; 4]; 5],
            terminals: vec![GraphTerminal {
                port: terminal::EMISSION_COLOR,
                node: 0,
                output: 0,
            }],
            textures: vec![Some(a), Some(b)],
            author_ids: vec!["/Material/Image".into()],
            ..Default::default()
        };
        let mut material = OpenPbrMaterial::default();
        material.values.unlit = true;
        material.values.emission_strength = 1.;
        material.graph = Some(graph);
        let material = scene.add_material(material).unwrap();
        scene.add_mesh(Mesh::new(geometry, material)).unwrap();
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
        let render = Render::new(&engine, settings.clone()).unwrap();
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
        let compiled = engine.diagnostics().compilations_started;
        for (edit, expected) in [
            ("reference", 0.8),
            ("slot", 0.2),
            ("restore", 0.8),
            ("pixels", 0.6),
        ] {
            match edit {
                "reference" => scene
                    .material_mut(material)
                    .unwrap()
                    .graph
                    .as_mut()
                    .unwrap()
                    .textures
                    .swap(0, 1),
                "slot" => {
                    scene
                        .material_mut(material)
                        .unwrap()
                        .graph
                        .as_mut()
                        .unwrap()
                        .parameters[1][0] = 1.
                }
                "restore" => {
                    scene
                        .material_mut(material)
                        .unwrap()
                        .graph
                        .as_mut()
                        .unwrap()
                        .parameters[1][0] = 0.
                }
                "pixels" => {
                    scene.texture_mut(b).unwrap().pixels =
                        TexturePixels::Rgba32F([0.6, 0.7, 0.9, 1.].repeat(4).into())
                }
                _ => unreachable!(),
            }
            assert_eq!(
                scene.pending_commit_kind().unwrap(),
                CommitKind::Incremental
            );
            engine.set_scene_object(&scene).unwrap();
            engine.update().unwrap();
            finish(&engine, &render);
            render.converge(ConvergeOptions::new(4)).unwrap();
            assert_eq!(render.last_commit().unwrap(), Some(CommitKind::Incremental));
            assert_eq!(render.backend().unwrap().0, backend);
            assert_eq!(engine.diagnostics().compilations_started, compiled);
            assert!(
                (center(&render) - expected).abs() < 0.0003,
                "{backend:?}/{edit}: {}",
                center(&render)
            );
            let fresh = Engine::new(EngineOptions { backend }).unwrap();
            let reference = Render::new(&fresh, settings.clone()).unwrap();
            fresh.set_camera(Some(camera)).unwrap();
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
                    "{backend:?}/{edit}/{kind:?}"
                );
                assert_eq!(a.id_data, b.id_data);
            }
            eprintln!(
                "GRAPH_TEXTURE {backend:?}/{edit}: predicted=Incremental actual=Incremental no compilation, HDR/ID exact"
            );
        }
    }
}
