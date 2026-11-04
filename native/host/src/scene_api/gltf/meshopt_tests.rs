use super::*;
use serde_json::json;

fn attributes(stride: usize, filter: &str, count: usize) -> (Value, Vec<u8>) {
    // Include varied bit patterns; the legacy filter is the byte oracle.
    let words: Vec<u32> = (0..count * stride / 4)
        .map(|i| (i as u32).wrapping_mul(0x1234567) ^ 0x3f000000)
        .collect();
    let mut encoded =
        vec![0; unsafe { meshopt::ffi::meshopt_encodeVertexBufferBound(count, stride) }];
    let len = unsafe {
        meshopt::ffi::meshopt_encodeVertexBuffer(
            encoded.as_mut_ptr(),
            encoded.len(),
            words.as_ptr().cast(),
            count,
            stride,
        )
    };
    assert!(len > 0);
    encoded.truncate(len);
    (
        json!({"count":count,"byteStride":stride,"mode":"ATTRIBUTES","filter":filter}),
        encoded,
    )
}
fn fixture(entries: Vec<(Value, Vec<u8>)>) -> (Value, Vec<gltf::buffer::Data>) {
    let mut source = Vec::new();
    let mut target = Vec::new();
    let mut views = Vec::new();
    for (mut ext, encoded) in entries {
        ext["buffer"] = json!(0);
        ext["byteOffset"] = json!(source.len());
        ext["byteLength"] = json!(encoded.len());
        source.extend(encoded);
        target.resize(target.len().next_multiple_of(4), 0);
        let len = number(&ext, "count").unwrap() * number(&ext, "byteStride").unwrap();
        views.push(json!({"buffer":1,"byteOffset":target.len(),"byteLength":len,"extensions":{"EXT_meshopt_compression":ext}}));
        target.resize(target.len() + len, 0);
    }
    // Exercise document order differing from destination order.
    views.reverse();
    (
        json!({"bufferViews":views}),
        vec![gltf::buffer::Data(source), gltf::buffer::Data(target)],
    )
}
fn assert_modes(json: &Value, buffers: &[gltf::buffer::Data], direct_views: usize) {
    let mut expected = buffers.to_vec();
    apply_with_workers(json, &mut expected, Mode::Legacy, 7).unwrap();
    for mode in [Mode::Serial, Mode::Parallel] {
        let mut actual = buffers.to_vec();
        let stats = apply_with_workers(json, &mut actual, mode, 7).unwrap();
        assert_eq!(stats.direct_views, direct_views);
        assert_eq!(
            actual.iter().map(|b| &b.0).collect::<Vec<_>>(),
            expected.iter().map(|b| &b.0).collect::<Vec<_>>()
        );
    }
}
#[test]
fn all_modes_filters_and_disjoint_worker_destinations_match_legacy() {
    let mut entries = Vec::new();
    for (stride, filter) in [
        (4, "NONE"),
        (12, "NONE"),
        (256, "NONE"),
        (4, "OCTAHEDRAL"),
        (8, "OCTAHEDRAL"),
        (8, "QUATERNION"),
        (4, "EXPONENTIAL"),
        (12, "EXPONENTIAL"),
    ] {
        entries.push(attributes(stride, filter, 513));
    }
    let indices = [0u32, 1, 2, 0, 2, 1];
    for mode in ["TRIANGLES", "INDICES"] {
        let encoded = if mode == "TRIANGLES" {
            meshopt::encode_index_buffer(&indices, 3).unwrap()
        } else {
            let mut bytes =
                vec![
                    0;
                    unsafe { meshopt::ffi::meshopt_encodeIndexSequenceBound(indices.len(), 3) }
                ];
            let len = unsafe {
                meshopt::ffi::meshopt_encodeIndexSequence(
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    indices.as_ptr(),
                    indices.len(),
                )
            };
            bytes.truncate(len);
            bytes
        };
        for stride in [2, 4] {
            entries.push((
                json!({"count":indices.len(),"byteStride":stride,"mode":mode}),
                encoded.clone(),
            ));
        }
    }
    let (json, buffers) = fixture(entries);
    assert_modes(&json, &buffers, 12);
    let jobs = plan(&json, &buffers).unwrap();
    let mut expected = buffers.clone();
    legacy(&json, &mut expected).unwrap();
    let mut actual = buffers.clone();
    direct(&jobs, &mut actual, 7).unwrap();
    assert_eq!(actual[1].0, expected[1].0);
}
#[test]
fn large_batch_uses_bounded_parallel_execution() {
    let (json, buffers) = fixture((0..9).map(|_| attributes(12, "NONE", 20000)).collect());
    let mut actual = buffers.clone();
    assert_eq!(
        apply_with_workers(&json, &mut actual, Mode::Parallel, 7)
            .unwrap()
            .workers,
        7
    );
    assert_modes(&json, &buffers, 9);
}
#[test]
fn dependent_overlapping_and_unaligned_layouts_keep_reference_behavior() {
    let (mut json, mut buffers) =
        fixture(vec![attributes(4, "NONE", 32), attributes(4, "NONE", 32)]);
    json["bufferViews"][0]["byteOffset"] = json!(0);
    assert_modes(&json, &buffers, 0);
    json["bufferViews"][0]["byteOffset"] = json!(1);
    json["bufferViews"].as_array_mut().unwrap().truncate(1);
    buffers[1].0.resize(129, 0);
    assert_modes(&json, &buffers, 0);
    // Same-buffer source/target with disjoint ranges must also use scratch.
    let ext = json["bufferViews"][0]["extensions"]["EXT_meshopt_compression"].clone();
    let source_offset = number(&ext, "byteOffset").unwrap();
    let source_len = number(&ext, "byteLength").unwrap();
    let target_offset = buffers[0].len().next_multiple_of(4);
    buffers[0].0.resize(target_offset + 128, 0);
    json["bufferViews"][0]["buffer"] = json!(0);
    json["bufferViews"][0]["byteOffset"] = json!(target_offset);
    assert!(source_offset + source_len <= target_offset);
    assert_modes(&json, &buffers, 0);
}
#[test]
fn invalid_metadata_and_parallel_payload_errors_follow_document_order() {
    let (mut json, mut buffers) =
        fixture(vec![attributes(4, "NONE", 32), attributes(4, "NONE", 32)]);
    let offset = number(
        &json["bufferViews"][0]["extensions"]["EXT_meshopt_compression"],
        "byteOffset",
    )
    .unwrap();
    buffers[0].0[offset] = 0; // First view has a corrupt payload.
    json["bufferViews"][1]["extensions"]["EXT_meshopt_compression"]["count"] = json!(0);
    for bad_metadata in [true, false] {
        if !bad_metadata {
            json["bufferViews"][1]["extensions"]["EXT_meshopt_compression"]["count"] = json!(32);
        }
        let expected = legacy(&json, &mut buffers.clone())
            .err()
            .unwrap()
            .to_string();
        assert!(expected.starts_with("Meshopt decoding failed"));
        for mode in [Mode::Serial, Mode::Parallel] {
            assert_eq!(
                apply_with_workers(&json, &mut buffers.clone(), mode, 7)
                    .err()
                    .unwrap()
                    .to_string(),
                expected
            );
        }
        if !bad_metadata {
            assert_eq!(
                direct(&plan(&json, &buffers).unwrap(), &mut buffers.clone(), 7)
                    .unwrap_err()
                    .to_string(),
                expected
            );
        }
    }
}
#[test]
fn optional_large_asset_decoded_buffer_oracle() {
    let Ok(path) = std::env::var("MUTRACER_MESHOPT_ORACLE") else {
        eprintln!("SKIP large meshopt oracle: MUTRACER_MESHOPT_ORACLE unset");
        return;
    };
    let path = std::path::Path::new(&path);
    let bytes = std::fs::read(path).unwrap();
    let (_, expected, _, _, _) =
        super::super::load_bytes_mode(&bytes, Some(path), Mode::Legacy).unwrap();
    let total: usize = expected.iter().map(|b| b.len()).sum();
    for mode in [Mode::Serial, Mode::Parallel] {
        let (_, actual, _, _, _) = super::super::load_bytes_mode(&bytes, Some(path), mode).unwrap();
        assert_eq!(actual.len(), expected.len());
        for (a, b) in actual.iter().zip(&expected) {
            assert_eq!(a.0, b.0);
        }
        eprintln!("Meshopt {mode:?}: {total} decoded buffer bytes identical");
    }
}

#[test]
fn dependent_decode_chain_falls_back_before_any_writes() {
    let (mut inner, mut payload) = attributes(4, "NONE", 32);
    let encoded_len = payload.len();
    payload.resize(payload.len().next_multiple_of(4), 0);
    let words: Vec<[u32; 1]> = payload
        .chunks_exact(4)
        .map(|b| [u32::from_le_bytes(b.try_into().unwrap())])
        .collect();
    let encoded = meshopt::encode_vertex_buffer(&words).unwrap();
    inner["buffer"] = json!(1);
    inner["byteOffset"] = json!(0);
    inner["byteLength"] = json!(encoded_len);
    let json = json!({"bufferViews":[
        {"buffer":1,"byteLength":payload.len(),"extensions":{"EXT_meshopt_compression":{"buffer":0,"byteLength":encoded.len(),"count":words.len(),"byteStride":4,"mode":"ATTRIBUTES"}}},
        {"buffer":2,"byteLength":128,"extensions":{"EXT_meshopt_compression":inner}}
    ]});
    let buffers = vec![
        gltf::buffer::Data(encoded),
        gltf::buffer::Data(vec![0; payload.len()]),
        gltf::buffer::Data(vec![0; 128]),
    ];
    assert_modes(&json, &buffers, 0);
}
