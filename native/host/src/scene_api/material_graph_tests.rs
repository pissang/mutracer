// CPU scene/ABI contracts; GPU cases use their own module.
use super::schema::{category, output, port, port_type, source, terminal};
use super::*;
use crate::api::CommitKind;
use crate::scene_api::{Geometry, Mesh};
fn graph() -> MaterialGraph {
    MaterialGraph {
        nodes: vec![GraphNode {
            category: category::CONSTANT,
            implementation: 1,
            port_type: port_type::FLOAT,
            first_input: 0,
            input_count: 1,
        }],
        inputs: vec![GraphInput {
            port: port::VALUE,
            port_type: port_type::FLOAT,
            source_kind: source::PARAMETER,
            source: 0,
            output: output::OUT,
        }],
        terminals: vec![GraphTerminal {
            port: terminal::SPECULAR_ROUGHNESS,
            node: 0,
            output: output::OUT,
        }],
        parameters: vec![[0.25, 0., 0., 0.]],
        author_ids: vec!["/Material/value".into()],
        ..Default::default()
    }
}
fn scene() -> (Scene, super::super::MaterialId) {
    let mut scene = Scene::new();
    let geometry = scene
        .add_geometry(Geometry::new(
            vec![-1., -1., -3., 1., -1., -3., 0., 1., -3.],
            vec![0, 1, 2],
        ))
        .unwrap();
    let material = scene
        .add_material(OpenPbrMaterial {
            graph: Some(graph()),
            ..Default::default()
        })
        .unwrap();
    scene.add_mesh(Mesh::new(geometry, material)).unwrap();
    (scene, material)
}
fn words(bytes: &[u8]) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}
#[test]
fn graph_uniform_fold_uses_aot_and_rejects_invalid_reachable_ir() {
    assert_eq!(graph().fold_constants().unwrap(), vec![Some(vec![0.25])]);
    let mut invalid = graph();
    invalid.nodes[0].category = u32::MAX;
    assert_eq!(
        invalid.fold_constants().unwrap_err().status,
        crate::status::Status::InvalidArgument
    );
    let mut varying = coverage_graph();
    varying.terminals.retain(|t| t.port == terminal::OPACITY);
    assert_eq!(varying.fold_constants().unwrap(), vec![None]);
}
#[test]
fn graph_parameters_are_incremental_but_terminals_are_structural() {
    let (mut scene, material) = scene();
    let before = scene.descriptor().unwrap();
    crate::scene::validate(&before).unwrap();
    let a = words(&before);
    let ma = a[h::MATERIAL_OFFSET] as usize;
    let ga = a[ma + m::GRAPH] as usize;
    assert_eq!(a[ga + g::VERSION], schema::IR_VERSION);
    scene
        .material_mut(material)
        .unwrap()
        .graph
        .as_mut()
        .unwrap()
        .parameters[0][0] = 0.75;
    assert_eq!(
        scene.pending_commit_kind().unwrap(),
        CommitKind::Incremental
    );
    let after = scene.descriptor().unwrap();
    let b = words(&after);
    let gb = b[b[h::MATERIAL_OFFSET] as usize + m::GRAPH] as usize;
    assert_eq!(before.len(), after.len());
    assert_eq!(ga, gb);
    assert_eq!(f32::from_bits(b[b[gb + g::PARAMETERS] as usize]), 0.75);
    assert!(crate::scene::material_graph::same_topology(
        &before, ga, &after, gb
    ));
    assert!(!crate::scene::material_graph::same_data(
        &before, ga, &after, gb
    ));
    let packet = crate::commit_plan::changed_materials_with(&before, &after, None).unwrap();
    let p = words(&packet);
    assert_eq!(p[1], 1);
    let graph = p[p[5] as usize + m::GRAPH] as usize;
    assert!(graph > 0);
    assert_eq!(p[graph + g::NODE_COUNT], 1);
    assert_eq!(f32::from_bits(p[p[graph + g::PARAMETERS] as usize]), 0.75);
    scene
        .material_mut(material)
        .unwrap()
        .graph
        .as_mut()
        .unwrap()
        .terminals[0]
        .port = terminal::COAT_ROUGHNESS;
    assert_eq!(scene.pending_commit_kind().unwrap(), CommitKind::Full);
    scene.material_mut(material).unwrap().graph = None;
    assert_eq!(scene.pending_commit_kind().unwrap(), CommitKind::Full);
    let cleared = scene.descriptor().unwrap();
    let c = words(&cleared);
    assert_eq!(c[c[h::MATERIAL_OFFSET] as usize + m::GRAPH], 0);
}
#[test]
fn graph_texture_reference_edits_preserve_topology_and_handle_ownership() {
    let (mut scene, material) = scene();
    let a = scene
        .add_texture(super::super::Texture::rgba8(1, 1, vec![255, 0, 0, 255]))
        .unwrap();
    let b = scene
        .add_texture(super::super::Texture::rgba8(1, 1, vec![0, 255, 0, 255]))
        .unwrap();
    scene
        .material_mut(material)
        .unwrap()
        .graph
        .as_mut()
        .unwrap()
        .textures = vec![Some(a)];
    let before = scene.descriptor().unwrap();
    scene
        .material_mut(material)
        .unwrap()
        .graph
        .as_mut()
        .unwrap()
        .textures[0] = Some(b);
    assert_eq!(
        scene.pending_commit_kind().unwrap(),
        CommitKind::Incremental
    );
    let after = scene.descriptor().unwrap();
    let wa = words(&before);
    let wb = words(&after);
    let ga = wa[wa[h::MATERIAL_OFFSET] as usize + m::GRAPH] as usize;
    let gb = wb[wb[h::MATERIAL_OFFSET] as usize + m::GRAPH] as usize;
    assert!(crate::scene::material_graph::same_topology(
        &before, ga, &after, gb
    ));
    assert!(!crate::scene::material_graph::same_data(
        &before, ga, &after, gb
    ));
    scene.remove_texture(b).unwrap();
    assert!(scene.descriptor().is_err());
}
#[test]
fn graph_labels_are_utf8_owned_and_relocated_without_affecting_topology() {
    let (mut scene, material) = scene();
    let before = scene.descriptor().unwrap();
    let a = words(&before);
    let ga = a[a[h::MATERIAL_OFFSET] as usize + m::GRAPH] as usize;
    scene
        .material_mut(material)
        .unwrap()
        .graph
        .as_mut()
        .unwrap()
        .author_ids = vec!["/材质/颜色".into()];
    assert_eq!(
        scene.pending_commit_kind().unwrap(),
        CommitKind::Incremental
    );
    let after = scene.descriptor().unwrap();
    crate::scene::validate(&after).unwrap();
    let b = words(&after);
    let gb = b[b[h::MATERIAL_OFFSET] as usize + m::GRAPH] as usize;
    assert!(crate::scene::material_graph::same_topology(
        &before, ga, &after, gb
    ));
    let packet = crate::commit_plan::changed_materials_with(&before, &after, None).unwrap();
    let p = words(&packet);
    let pg = p[p[5] as usize + m::GRAPH] as usize;
    let ids = p[pg + g::AUTHOR_IDS] as usize;
    let (at, len) = (p[ids] as usize * 4, p[ids + 1] as usize);
    assert_eq!(
        std::str::from_utf8(&packet[at..at + len]).unwrap(),
        "/材质/颜色"
    );
}
fn coverage_graph() -> MaterialGraph {
    MaterialGraph {
        nodes: vec![
            GraphNode {
                category: category::TEXCOORD,
                implementation: 1,
                port_type: port_type::VECTOR2,
                first_input: 0,
                input_count: 1,
            },
            GraphNode {
                category: category::EXTRACT,
                implementation: 1,
                port_type: port_type::FLOAT,
                first_input: 1,
                input_count: 2,
            },
            GraphNode {
                category: category::NORMALMAP,
                implementation: 1,
                port_type: port_type::VECTOR3,
                first_input: 3,
                input_count: 5,
            },
        ],
        inputs: vec![
            GraphInput {
                port: port::INDEX,
                port_type: port_type::INTEGER,
                source_kind: source::PARAMETER,
                source: 0,
                output: output::OUT,
            },
            GraphInput {
                port: port::IN,
                port_type: port_type::VECTOR2,
                source_kind: source::NODE,
                source: 0,
                output: output::OUT,
            },
            GraphInput {
                port: port::INDEX,
                port_type: port_type::INTEGER,
                source_kind: source::PARAMETER,
                source: 1,
                output: output::OUT,
            },
            GraphInput {
                port: port::BITANGENT,
                port_type: port_type::VECTOR3,
                source_kind: source::GEOMETRY,
                source: schema::geometry::BITANGENT,
                output: output::OUT,
            },
            GraphInput {
                port: port::IN,
                port_type: port_type::VECTOR3,
                source_kind: source::PARAMETER,
                source: 2,
                output: output::OUT,
            },
            GraphInput {
                port: port::NORMAL,
                port_type: port_type::VECTOR3,
                source_kind: source::GEOMETRY,
                source: schema::geometry::NORMAL,
                output: output::OUT,
            },
            GraphInput {
                port: port::SCALE,
                port_type: port_type::FLOAT,
                source_kind: source::PARAMETER,
                source: 3,
                output: output::OUT,
            },
            GraphInput {
                port: port::TANGENT,
                port_type: port_type::VECTOR3,
                source_kind: source::GEOMETRY,
                source: schema::geometry::TANGENT,
                output: output::OUT,
            },
        ],
        terminals: vec![
            GraphTerminal {
                port: terminal::NORMAL,
                node: 2,
                output: output::OUT,
            },
            GraphTerminal {
                port: terminal::OPACITY,
                node: 1,
                output: output::OUT,
            },
        ],
        parameters: vec![[0.; 4], [0.; 4], [0.5, 0.5, 1., 0.], [1., 0., 0., 0.]],
        author_ids: vec![
            "/Material/uv".into(),
            "/Material/alpha".into(),
            "/Material/normal".into(),
        ],
        ..Default::default()
    }
}
#[test]
fn software_and_hwrt_material_graph_sources_validate_through_aot() {
    let (mut scene, material) = scene();
    for graph in [graph(), coverage_graph()] {
        scene.material_mut(material).unwrap().graph = Some(graph);
        let descriptor = scene.descriptor().unwrap();
        for hardware in [false, true] {
            let (scene, assets, _) = crate::scene::prepare_retained(&descriptor, hardware).unwrap();
            let source = std::str::from_utf8(&assets[&scene.shader]).unwrap();
            let module = naga::front::wgsl::parse_str(source)
                .unwrap_or_else(|e| panic!("{}", e.emit_to_string(source)));
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::all(),
            )
            .validate(&module)
            .unwrap();
            let layout = scene.native_layout.as_ref().unwrap();
            assert!(layout.material_graphs.is_empty());
        }
    }
}
fn emission_graph(value: f32, structure: bool) -> MaterialGraph {
    let mut graph = MaterialGraph {
        nodes: vec![GraphNode {
            category: category::CONSTANT,
            implementation: 1,
            port_type: port_type::COLOR3,
            first_input: 0,
            input_count: 1,
        }],
        inputs: vec![GraphInput {
            port: port::VALUE,
            port_type: port_type::COLOR3,
            source_kind: source::PARAMETER,
            source: 0,
            output: output::OUT,
        }],
        terminals: vec![GraphTerminal {
            port: terminal::EMISSION_COLOR,
            node: 0,
            output: output::OUT,
        }],
        parameters: vec![[value, value, value, 0.]],
        author_ids: vec!["/Material/value".into()],
        ..Default::default()
    };
    if structure {
        graph.nodes.push(GraphNode {
            category: category::MULTIPLY,
            implementation: 1,
            port_type: port_type::COLOR3,
            first_input: 1,
            input_count: 2,
        });
        graph.inputs.extend([
            GraphInput {
                port: port::IN1,
                port_type: port_type::COLOR3,
                source_kind: source::NODE,
                source: 0,
                output: output::OUT,
            },
            GraphInput {
                port: port::IN2,
                port_type: port_type::FLOAT,
                source_kind: source::PARAMETER,
                source: 1,
                output: output::OUT,
            },
        ]);
        graph.parameters.push([1., 0., 0., 0.]);
        graph.terminals[0].node = 1;
        graph.author_ids.push("/Material/multiply".into());
    }
    graph
}
#[test]
fn graph_parameter_packet_reuses_the_installed_layout() {
    let (mut scene, material) = scene();
    {
        let m = scene.material_mut(material).unwrap();
        m.values.unlit = true;
        m.values.emission_strength = 1.;
        m.graph = Some(emission_graph(0.2, false));
    }
    let before = scene.descriptor().unwrap();
    let (_, _, retained) = crate::scene::prepare_retained(&before, false).unwrap();
    scene
        .material_mut(material)
        .unwrap()
        .graph
        .as_mut()
        .unwrap()
        .parameters[0] = [0.6, 0.6, 0.6, 0.];
    let after = scene.descriptor().unwrap();
    let packet = crate::commit_plan::changed_materials_with(&before, &after, None).unwrap();
    assert!(retained.materials_compatible(packet.clone()).unwrap());
    retained.materials(&packet).unwrap();
}
#[path = "material_graph_gpu_tests.rs"]
mod gpu;
#[test]
fn raw_graph_validation_rejects_out_of_bounds_spans_and_legacy_graph_records() {
    let (scene, _) = scene();
    let bytes = scene.descriptor().unwrap();
    let a = words(&bytes);
    let ma = a[h::MATERIAL_OFFSET] as usize;
    let ga = a[ma + m::GRAPH] as usize;
    for (at, value) in [
        (ma + m::GRAPH, u32::MAX),
        (ga + g::NODES, u32::MAX),
        (ga + g::PARAMETERS, u32::MAX),
        (ga + g::RESERVED, 1),
        (h::VERSION, 7),
    ] {
        let mut corrupt = bytes.as_ref().clone();
        corrupt[at * 4..at * 4 + 4].copy_from_slice(&value.to_le_bytes());
        assert!(crate::scene::validate(&corrupt).is_err(), "{at}");
    }
}
