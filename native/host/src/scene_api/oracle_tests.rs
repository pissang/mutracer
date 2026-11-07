//! Independent descriptor builder oracle for every v5 record kind. This uses the
//! public format, not the production encoder's record writers or allocation code.
use super::*;
use crate::layout::{batch as b, geometry as g, material as mat, texture as t};
fn append(w: &mut Vec<u32>, v: &[u32]) -> u32 {
    let at = w.len() as u32;
    w.extend_from_slice(v);
    at
}
fn floats(w: &mut Vec<u32>, v: &[f32]) -> u32 {
    append(w, &v.iter().map(|v| v.to_bits()).collect::<Vec<_>>())
}
fn default_material(w: &mut Vec<u32>, o: usize) {
    for (k, v) in [
        (0, 0.8f32),
        (1, 0.8),
        (2, 0.8),
        (3, 0.3),
        (6, 1.5),
        (7, 1.),
        (8, 1.),
        (9, 1.),
        (13, 1.),
    ] {
        w[o + k] = v.to_bits();
    }
    for k in 15..19 {
        w[o + k] = u32::MAX;
    }
    let ids = [
        38, 41, 42, 45, 52, 73, 3, 5, 9, 11, 12, 15, 17, 18, 19, 22, 23, 24, 26, 29, 31, 32, 33,
        53, 6, 20, 47, 48, 49, 50, 59, 60, 76, 61, 57, 58,
    ];
    let values: [[f32; 3]; 36] = [
        [0.; 3],
        [0.; 3],
        [0.; 3],
        [1., 1., 0.],
        [0.; 3],
        [0.; 3],
        [0.; 3],
        [1., 0., 0.],
        [0.; 3],
        [1.; 3],
        [0.; 3],
        [0.; 3],
        [0.; 3],
        [0.8; 3],
        [1., 0., 0.],
        [0.; 3],
        [1.; 3],
        [0.5, 0., 0.],
        [1.; 3],
        [1.6, 0., 0.],
        [0.; 3],
        [0.5, 0., 0.],
        [1.4, 0., 0.],
        [0.; 3],
        [1.; 3],
        [1., 0.5, 0.25],
        [0.; 3],
        [0.; 3],
        [0.; 3],
        [0.; 3],
        [0.; 3],
        [0.; 3],
        [0.; 3],
        [0.01, 0., 0.],
        [0.; 3],
        [1., 0., 0.],
    ];
    let mut ext = Vec::new();
    for i in 0..36 {
        ext.push(ids[i]);
        let mut v = values[i].map(f32::to_bits);
        if [0, 1, 4, 5, 34].contains(&i) {
            v = [0; 3];
        }
        if (26..=30).contains(&i) {
            v = [u32::MAX, 0, 0];
        }
        ext.extend(v);
    }
    w[o + mat::EXTENSION_COUNT] = 36;
    w[o + mat::EXTENSION_OFFSET] = append(w, &ext);
}
#[test]
fn every_record_matches_an_independent_v6_builder() {
    let mut s = Scene::new();
    let mut geo = Geometry::new(vec![-1., 0., 0., 1., 0., 0., 0., 1., 0.], vec![0, 1, 2]);
    geo.normals = vec![0., 0., 1.].repeat(3).into();
    geo.uv = [vec![0., 0., 1., 0., 0.5, 1.].into(), vec![0.; 6].into()];
    geo.colors = vec![1.; 9].into();
    geo.tangents = vec![1., 0., 0., 1.].repeat(3).into();
    geo.material_indices = vec![0, 1, 0].into();
    let geometry = s.add_geometry(geo.clone()).unwrap();
    let ma = s.add_material(OpenPbrMaterial::default()).unwrap();
    let mb = s.add_material(OpenPbrMaterial::default()).unwrap();
    let tex = s
        .add_texture(Texture::rgba8(1, 1, vec![20, 40, 60, 255]))
        .unwrap();
    let env = s
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(vec![0.2, 0.3, 0.4, 1.].into()),
            ..Texture::rgba8(1, 1, vec![])
        })
        .unwrap();
    let bg = s
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(vec![0.5, 0.6, 0.7, 1.].into()),
            ..Texture::rgba8(1, 1, vec![])
        })
        .unwrap();
    let transforms = vec![Mat4::IDENTITY, Mat4::from_translation(Vec3::X)];
    let mut mesh = Mesh::new(geometry, ma);
    mesh.materials = vec![ma, mb];
    mesh.instances = Some(Instances {
        transforms: transforms.clone().into(),
        colors: Some(vec![1.; 6].into()),
    });
    let mesh_id = s.add_mesh(mesh).unwrap();
    s.set_environment(Environment {
        texture: Some(env),
        background: Some(bg),
        ..Environment::default()
    })
    .unwrap();
    let ies = b"IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 3 1 1 2 0 0 0 1 1 20\n0 45 90\n0\n100 50 0\n";
    for light in [
        Light::Rect {
            color: [1.; 3],
            intensity: 2.,
            width: 3.,
            height: 4.,
            spread: 1.,
            transform: Mat4::IDENTITY,
            texture: Some(tex),
        },
        Light::Sphere {
            color: [1.; 3],
            intensity: 2.,
            radius: 0.5,
            transform: Mat4::IDENTITY,
        },
        Light::Directional {
            color: [1.; 3],
            intensity: 2.,
            transform: Mat4::IDENTITY,
        },
        Light::Spot {
            color: [1.; 3],
            intensity: 2.,
            inner: 10.,
            outer: 30.,
            transform: Mat4::IDENTITY,
            ies: ies.as_slice().into(),
        },
        Light::Disk {
            color: [1.; 3],
            intensity: 2.,
            radius: 0.75,
            normalize: true,
            transform: Mat4::IDENTITY,
        },
        Light::Cylinder {
            color: [1.; 3],
            intensity: 2.,
            radius: 0.25,
            length: 1.5,
            normalize: false,
            treat_as_line: true,
            transform: Mat4::IDENTITY,
        },
    ] {
        s.add_light(light).unwrap();
    }
    let actual = s.descriptor().unwrap();
    let mut w =
        vec![0; h::WORDS + g::WORDS + m::WORDS + 2 * mat::WORDS + 3 * t::WORDS + 6 * l::WORDS];
    let go = h::WORDS;
    let mo = go + g::WORDS;
    let mao = mo + m::WORDS;
    let to = mao + 2 * mat::WORDS;
    let lo = to + 3 * t::WORDS;
    for (k, v) in [
        (h::VERSION, 6),
        (h::WIDTH, 1),
        (h::HEIGHT, 1),
        (h::GEOMETRY_COUNT, 1),
        (h::MESH_COUNT, 1),
        (h::MATERIAL_COUNT, 2),
        (h::TEXTURE_COUNT, 3),
        (h::LIGHT_COUNT, 6),
        (h::GEOMETRY_OFFSET, go as u32),
        (h::MESH_OFFSET, mo as u32),
        (h::MATERIAL_OFFSET, mao as u32),
        (h::TEXTURE_OFFSET, to as u32),
        (h::LIGHT_OFFSET, lo as u32),
        (h::ENVIRONMENT_TEXTURE, 2),
        (h::BACKGROUND_TEXTURE, 3),
    ] {
        w[k] = v;
    }
    w[h::BACKGROUND_COLOR + 3] = 1f32.to_bits();
    for i in 0..6 {
        let o = lo + i * l::WORDS;
        w[o] = i as u32;
        for k in 1..4 {
            w[o + k] = 1f32.to_bits();
        }
        w[o + 4] = 2f32.to_bits();
        let dims = match i {
            0 => [3f32, 4., 1.],
            1 => [0.5, 0., 0.],
            2 => [0.; 3],
            3 => [0., 10., 30.],
            _ => [0.; 3],
        };
        for k in 0..3 {
            w[o + 5 + k] = dims[k].to_bits();
        }
        if i == 0 {
            w[o + l::TEXTURE] = 1;
        }
        if i == 4 {
            w[o + l::RADIUS] = 0.75f32.to_bits();
            w[o + l::NORMALIZE] = 1;
        } else if i == 5 {
            w[o + l::RADIUS] = 0.25f32.to_bits();
            w[o + l::LENGTH] = 1.5f32.to_bits();
            w[o + l::TREAT_AS_LINE] = 1;
        }
        for (k, v) in Mat4::IDENTITY.to_cols_array().iter().enumerate() {
            w[o + l::TRANSFORM + k] = v.to_bits();
        }
    }
    w[h::CAMERA_OFFSET] = append(
        &mut w,
        &Camera::default()
            .to_bytes()
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>(),
    );
    w[go] = 3;
    w[go + 1] = 3;
    w[go + g::POSITION] = floats(&mut w, &geo.positions);
    w[go + g::INDICES] = append(&mut w, &geo.indices);
    for (field, data) in [
        (g::NORMAL, &geo.normals),
        (g::UV, &geo.uv[0]),
        (g::UV1, &geo.uv[1]),
        (g::COLOR, &geo.colors),
        (g::TANGENT, &geo.tangents),
    ] {
        w[go + field] = floats(&mut w, data);
    }
    w[go + g::MATERIAL_INDEX] = append(&mut w, &[0, 1, 0]);
    for (k, v) in Mat4::IDENTITY.to_cols_array().iter().enumerate() {
        w[mo + m::TRANSFORM + k] = v.to_bits();
    }
    w[mo + m::MATERIAL_COUNT] = 2;
    w[mo + m::MATERIAL_TABLE] = append(&mut w, &[0, 1]);
    default_material(&mut w, mao);
    default_material(&mut w, mao + mat::WORDS);
    for i in 0..3 {
        let o = to + i * t::WORDS;
        w[o] = 1;
        w[o + 1] = 1;
        w[o + t::STORAGE] = u32::from(i != 0);
        w[o + t::UV_SCALE] = 1f32.to_bits();
        w[o + t::UV_SCALE + 1] = 1f32.to_bits();
        w[o + t::PIXELS] = match i {
            0 => append(&mut w, &[u32::from_le_bytes([20, 40, 60, 255])]),
            1 => floats(&mut w, &[0.2, 0.3, 0.4, 1.]),
            _ => floats(&mut w, &[0.5, 0.6, 0.7, 1.]),
        };
    }
    w[h::BATCH_OFFSET] = w.len() as u32;
    let bo = w.len();
    w.resize(bo + b::WORDS, 0);
    w[bo] = 2;
    w[bo + 1] = floats(
        &mut w,
        &transforms
            .iter()
            .flat_map(|m| m.to_cols_array())
            .collect::<Vec<_>>(),
    );
    w[bo + 2] = floats(&mut w, &[1.; 6]);
    w[lo + 3 * l::WORDS + l::IES_OFFSET] = append(
        &mut w,
        &ies.chunks(4)
            .map(|b| {
                let mut word = [0; 4];
                word[..b.len()].copy_from_slice(b);
                u32::from_le_bytes(word)
            })
            .collect::<Vec<_>>(),
    );
    w[lo + 3 * l::WORDS + l::IES_BYTES] = ies.len() as u32;
    w[h::MESH_AOV_IDS] = append(&mut w, &[mesh_id.aov_id()]);
    w[h::MATERIAL_AOV_IDS] = append(&mut w, &[ma.aov_id(), mb.aov_id()]);
    w[h::LENGTH] = w.len() as u32;
    let expected = w.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
    if *actual != expected {
        let actual_words = actual
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>();
        let expected_words = expected
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>();
        let diffs = actual_words
            .iter()
            .zip(&expected_words)
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .take(32)
            .map(|(i, (a, b))| (i, *a, *b))
            .collect::<Vec<_>>();
        panic!(
            "descriptor differs: {diffs:?}; actual words {}, expected words {}",
            actual_words.len(),
            expected_words.len()
        );
    }
}
