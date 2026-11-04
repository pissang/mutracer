use super::*;
use base64::Engine;
use serde_json::{Value, json};

fn view(root: &mut Value, bytes: &mut Vec<u8>, data: &[u8], stride: Option<usize>) -> usize {
    while bytes.len() % 4 != 0 {
        bytes.push(0);
    }
    let offset = bytes.len();
    bytes.extend_from_slice(data);
    let views = root["bufferViews"].as_array_mut().unwrap();
    let id = views.len();
    let mut value = json!({"buffer":0,"byteOffset":offset,"byteLength":data.len()});
    if let Some(stride) = stride {
        value["byteStride"] = json!(stride);
    }
    views.push(value);
    id
}
fn accessor(root: &mut Value, view: usize, kind: &str, component: u32) -> usize {
    let accessors = root["accessors"].as_array_mut().unwrap();
    let id = accessors.len();
    accessors.push(json!({"bufferView":view,"componentType":component,"count":3,"type":kind}));
    id
}
fn f32_view(root: &mut Value, bytes: &mut Vec<u8>, values: &[f32], kind: &str) -> usize {
    let data: Vec<_> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    let v = view(root, bytes, &data, None);
    accessor(root, v, kind, 5126)
}
fn fixture(kind: usize) -> Vec<u8> {
    let mut root = json!({"asset":{"version":"2.0"},"bufferViews":[],"accessors":[],"buffers":[]});
    let mut bytes = Vec::new();
    let positions = [-0., 0., 0., 2., 0., 0., 0., 1., 0.];
    let normals = [0., 0., 1., 0., 0., 1., 0., 0., 1.];
    let uv = [-0., 0.1, 1., 0.25, 0.5, 1.];
    let (p, n, t) = if kind == 1 {
        let mut interleaved = Vec::new();
        for i in 0..3 {
            for v in positions[i * 3..i * 3 + 3]
                .iter()
                .chain(&normals[i * 3..i * 3 + 3])
                .chain(&uv[i * 2..i * 2 + 2])
            {
                interleaved.extend_from_slice(&f32::to_le_bytes(*v));
            }
        }
        let v = view(&mut root, &mut bytes, &interleaved, Some(32));
        let p = accessor(&mut root, v, "VEC3", 5126);
        let n = accessor(&mut root, v, "VEC3", 5126);
        let t = accessor(&mut root, v, "VEC2", 5126);
        root["accessors"][n]["byteOffset"] = json!(12);
        root["accessors"][t]["byteOffset"] = json!(24);
        (p, n, t)
    } else {
        let p = f32_view(&mut root, &mut bytes, &positions, "VEC3");
        let n = f32_view(&mut root, &mut bytes, &normals, "VEC3");
        let t = if kind == 3 {
            let data: Vec<_> = [0u16, 1, 65535, 32767, 32768, 65535]
                .into_iter()
                .flat_map(u16::to_le_bytes)
                .collect();
            let v = view(&mut root, &mut bytes, &data, None);
            let t = accessor(&mut root, v, "VEC2", 5123);
            root["accessors"][t]["normalized"] = json!(true);
            t
        } else {
            f32_view(&mut root, &mut bytes, &uv, "VEC2")
        };
        (p, n, t)
    };
    root["accessors"][p]["min"] = json!([0, 0, 0]);
    root["accessors"][p]["max"] = json!([2, 1, 0]);
    if kind == 2 {
        let indices = view(&mut root, &mut bytes, &[1], None);
        let data: Vec<_> = [1f32, 0.5, 0.25]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect();
        let values = view(&mut root, &mut bytes, &data, None);
        root["accessors"][p]["sparse"] = json!({"count":1,"indices":{"bufferView":indices,"componentType":5121},"values":{"bufferView":values}});
    }
    let uv1 = f32_view(&mut root, &mut bytes, &[0.5, 0., 0.25, 1., 1., 0.5], "VEC2");
    let colors = if kind == 1 {
        f32_view(
            &mut root,
            &mut bytes,
            &[1., 0., 0., 1., 0., 1., 0., 0.5, 0., 0., 1., 1.],
            "VEC4",
        )
    } else {
        f32_view(
            &mut root,
            &mut bytes,
            &[0., 0., 0., 1., 0.5, 0.2, 2., 0.1, 0.1],
            "VEC3",
        )
    };
    let tangent = f32_view(
        &mut root,
        &mut bytes,
        &[-1., 0., 0., -1., 1., 0., 0., 1., 0., 1., 0., -0.],
        "VEC4",
    );
    let data: Vec<_> = [0u16, 1, 2]
        .into_iter()
        .flat_map(u16::to_le_bytes)
        .collect();
    let v = view(&mut root, &mut bytes, &data, None);
    let indices = accessor(&mut root, v, "SCALAR", 5123);
    let mut primitive = json!({"indices":indices,"attributes":{"POSITION":p,"NORMAL":n,"TEXCOORD_0":t,"TEXCOORD_1":uv1,"COLOR_0":colors,"TANGENT":tangent}});
    if kind == 4 {
        let target = f32_view(
            &mut root,
            &mut bytes,
            &[1., 0., 0., 1., 0., 0., 1., 0., 0.],
            "VEC3",
        );
        root["accessors"][target]["min"] = json!([1, 0, 0]);
        root["accessors"][target]["max"] = json!([1, 0, 0]);
        primitive["targets"] = json!([{"POSITION":target}]);
    }
    if kind == 5 {
        let data: Vec<_> = [0u16; 12].into_iter().flat_map(u16::to_le_bytes).collect();
        let v = view(&mut root, &mut bytes, &data, None);
        let joints = accessor(&mut root, v, "VEC4", 5123);
        let weights = f32_view(
            &mut root,
            &mut bytes,
            &[1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0.],
            "VEC4",
        );
        primitive["attributes"]["JOINTS_0"] = json!(joints);
        primitive["attributes"]["WEIGHTS_0"] = json!(weights);
    }
    root["meshes"] = json!([{"primitives":[primitive]}]);
    if kind == 4 {
        root["meshes"][0]["weights"] = json!([0.25]);
    }
    root["nodes"] = json!([{"name":"first","mesh":0},{"name":"second","mesh":0,"rotation":[0,0.38268343,0,0.92387953],"scale":[-1,2,0.5]}]);
    root["scene"] = json!(0);
    root["scenes"] = json!([{"nodes":[0,1]}]);
    if kind == 5 {
        root["nodes"][0]["skin"] = json!(0);
        root["nodes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"translation":[0.5,0.25,0.75]}));
        root["scenes"][0]["nodes"] = json!([0, 1, 2]);
        root["skins"] = json!([{"joints":[2]}]);
    }
    root["buffers"] = json!([{"byteLength":bytes.len(),"uri":format!("data:application/octet-stream;base64,{}",base64::engine::general_purpose::STANDARD.encode(&bytes))}]);
    serde_json::to_vec(&root).unwrap()
}
fn bits(values: &[f32]) -> &[u8] {
    bytemuck::cast_slice(values)
}
fn compare(a: &Model, b: &Model) {
    assert_eq!(a.geometries.len(), b.geometries.len());
    assert!(a.meshes == b.meshes);
    assert!(a.materials == b.materials);
    assert_eq!(a.properties, b.properties);
    assert_eq!(a.warnings, b.warnings);
    assert_eq!(a.node_indices, b.node_indices);
    assert_eq!(a.node_names, b.node_names);
    assert_eq!(a.mesh_names, b.mesh_names);
    assert_eq!(bits(&a.center.to_array()), bits(&b.center.to_array()));
    assert_eq!(a.radius.to_bits(), b.radius.to_bits());
    assert_eq!(a.ground_y.to_bits(), b.ground_y.to_bits());
    for (a, b) in a.geometries.iter().zip(b.geometries.iter()) {
        assert_eq!(a.indices, b.indices);
        assert_eq!(a.material_indices, b.material_indices);
        for (a, b) in [
            (&a.positions, &b.positions),
            (&a.normals, &b.normals),
            (&a.uv[0], &b.uv[0]),
            (&a.uv[1], &b.uv[1]),
            (&a.colors, &b.colors),
            (&a.tangents, &b.tangents),
        ] {
            assert_eq!(bits(a), bits(b));
        }
        assert_eq!(bits(&a.min.to_array()), bits(&b.min.to_array()));
        assert_eq!(bits(&a.max.to_array()), bits(&b.max.to_array()));
    }
}
#[test]
fn bulk_import_matches_reader_bits_bounds_instances_and_deformation() {
    for kind in 0..6 {
        let data = fixture(kind);
        let reader = Model::load_bytes_with_options(&data, None, false, false).unwrap();
        let bulk = Model::load_bytes_with_options(&data, None, true, true).unwrap();
        compare(&reader, &bulk);
    }
}
#[test]
fn bulk_accessor_preserves_bits_and_rejects_unsupported_or_invalid_spans() {
    let root = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":12}],"bufferViews":[{"buffer":0,"byteLength":12}],"accessors":[{"bufferView":0,"componentType":5126,"count":1,"type":"VEC3"}]});
    let values = [f32::from_bits(0x7fc12345), -0., f32::from_bits(1)];
    let data: Vec<_> = values.into_iter().flat_map(f32::to_le_bytes).collect();
    let buffers = [gltf::buffer::Data(data.clone())];
    let document =
        gltf::Document::from_json_without_validation(serde_json::from_value(root.clone()).unwrap());
    let a = document.accessors().next().unwrap();
    let actual = bulk_floats(a.clone(), &buffers, 3).unwrap();
    let reference = gltf::accessor::Iter::<[f32; 3]>::new(a, |_| Some(&data))
        .unwrap()
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(bits(&actual), bits(&reference));
    assert!(
        bulk_floats(
            document.accessors().next().unwrap(),
            &[gltf::buffer::Data(data[..11].into())],
            3
        )
        .is_none()
    );
    for variant in 0..7 {
        let mut root = root.clone();
        let mut buffer = data.clone();
        match variant {
            0 => {
                root["accessors"][0]["normalized"] = json!(true);
            }
            1 => {
                root["bufferViews"][0]["byteStride"] = json!(16);
            }
            2 => {
                root["accessors"][0]["componentType"] = json!(5123);
            }
            3 => {
                root["accessors"][0]["count"] = json!(u64::MAX);
            }
            4 => {
                root["accessors"][0]["sparse"] = json!({"count":1,"indices":{"bufferView":0,"componentType":5121},"values":{"bufferView":0}});
            }
            5 => {
                buffer.insert(0, 0);
                root["bufferViews"][0]["byteOffset"] = json!(1);
            }
            _ => {
                root["accessors"][0]["type"] = json!("VEC4");
            }
        }
        let document =
            gltf::Document::from_json_without_validation(serde_json::from_value(root).unwrap());
        assert!(
            bulk_floats(
                document.accessors().next().unwrap(),
                &[gltf::buffer::Data(buffer)],
                3
            )
            .is_none(),
            "variant {variant}"
        );
    }
}
#[test]
fn large_local_import_matches_reader_when_requested() {
    let Ok(path) = std::env::var("MUTRACER_GLTF_IMPORT_ORACLE") else {
        println!("SKIP large import oracle: set MUTRACER_GLTF_IMPORT_ORACLE");
        return;
    };
    let path = Path::new(&path);
    let data = Model::read(path).unwrap();
    let reader = Model::load_bytes_with_options(&data, Some(path), false, false).unwrap();
    let bulk = Model::load_bytes_with_options(&data, Some(path), true, true).unwrap();
    compare(&reader, &bulk);
    println!(
        "GLTF_IMPORT_EXACT geometries={} meshes={}",
        bulk.geometries.len(),
        bulk.meshes.len()
    );
}

#[test]
fn parallel_local_bounds_match_serial_bits_with_shared_geometry() {
    let model = Model::load_bytes_with_options(&fixture(0), None, true, false).unwrap();
    let mut serial = vec![model.geometries[0].clone(); 40];
    for (i, geometry) in serial.iter_mut().enumerate() {
        let values = Arc::make_mut(&mut geometry.positions);
        values[0] = if i % 2 == 0 { -0. } else { 0. };
        values[1] = if i % 3 == 0 {
            -f32::from_bits(1)
        } else {
            f32::from_bits(1)
        };
        values[5] = i as f32;
    }
    let mut parallel = serial.clone();
    update_local_bounds(&mut serial, 1);
    for workers in [2, 7, 12] {
        update_local_bounds(&mut parallel, workers);
        for (a, b) in serial.iter().zip(&parallel) {
            assert_eq!(bits(&a.min.to_array()), bits(&b.min.to_array()));
            assert_eq!(bits(&a.max.to_array()), bits(&b.max.to_array()));
        }
    }
}
