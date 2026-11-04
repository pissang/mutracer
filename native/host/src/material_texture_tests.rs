use super::*;
use layout::{geometry as g, header as h, material as m, resource as r, texture as t};

fn fixture(wrap: [u32; 2], float: bool) -> Vec<u8> {
    let mut words: Vec<u32> = bytemuck::pod_collect_to_vec(&scene::small_fixture());
    let texture = words.len();
    words.resize(texture + 2 * t::WORDS, 0);
    let uv = words.len();
    words.extend([-0.3f32, -0.2, 2.3, -0.2, 1., 2.2].map(f32::to_bits));
    words[32 + g::UV] = uv as u32;
    let pixels = words.len();
    for i in 0..6u8 {
        let rgba = [i * 40, 255 - i * 40, i * 25, 255];
        if float {
            words.extend(rgba.map(|v| (v as f32 / 255.).to_bits()));
        } else {
            words.push(u32::from_le_bytes(rgba));
        }
    }
    let second_pixels = words.len();
    for rgba in [[230u8, 150, 30, 255], [60, 210, 190, 255]] {
        if float {
            words.extend(rgba.map(|v| (v as f32 / 255.).to_bits()));
        } else {
            words.push(u32::from_le_bytes(rgba));
        }
    }
    words[h::TEXTURE_OFFSET] = texture as u32;
    words[h::TEXTURE_COUNT] = 2;
    words[texture + t::WIDTH] = 3;
    words[texture + t::HEIGHT] = 2;
    words[texture + t::STORAGE] = u32::from(float);
    words[texture + t::PIXELS] = pixels as u32;
    words[texture + t::FLIP_Y] = 1;
    words[texture + t::UV_SCALE..texture + t::UV_SCALE + 2].fill(1f32.to_bits());
    words[texture + t::WRAP_S..texture + t::WRAP_S + 2].copy_from_slice(&wrap);
    let first = words[texture..texture + t::WORDS].to_vec();
    words[texture + t::WORDS..texture + 2 * t::WORDS].copy_from_slice(&first);
    words[texture + t::WORDS + t::WIDTH] = 2;
    words[texture + t::WORDS + t::HEIGHT] = 1;
    words[texture + t::WORDS + t::PIXELS] = second_pixels as u32;
    words[64 + m::MAP] = 0;
    words[64 + m::EMISSIVE_MAP] = 1;
    words[64 + m::EMISSION_COLOR..64 + m::EMISSION_COLOR + 3].fill(1f32.to_bits());
    words[64 + m::EMISSION_LUMINANCE] = 1f32.to_bits();
    words[104 + 14] = 3f32.to_bits();
    // Cover the image and exercise UVs outside the texture boundary.
    words[120..129].copy_from_slice(&[-2f32, -1., 0., 2., -1., 0., 0., 2., 0.].map(f32::to_bits));
    words[h::LENGTH] = words.len() as u32;
    bytemuck::cast_slice(&words).to_vec()
}

fn prepare(bytes: &[u8], limits: [u32; 2]) -> (Scene, Assets, scene::PreparedState) {
    scene::prepare_retained_shared_with_settings(
        Arc::new(bytes.to_vec()),
        false,
        0,
        &settings::RenderSettings::default(),
        limits,
    )
    .unwrap()
}

#[test]
fn independent_texture_packets_keep_pixels_and_validate_shaders() {
    for float in [false, true] {
        let (scene, assets, _) = prepare(&fixture([0, 2], float), [16384, 65536]);
        assert!(!scene.textures.iter().any(|t| t.id == r::ATLAS));
        let texture = scene
            .textures
            .iter()
            .find(|t| t.id == r::MATERIAL_TEXTURE_BASE)
            .unwrap();
        assert_eq!((texture.width, texture.height, texture.depth), (3, 2, 1));
        assert_eq!(
            texture.format,
            if float {
                wgpu::TextureFormat::Rgba16Float
            } else {
                wgpu::TextureFormat::Rgba8Unorm
            }
        );
        let data = &assets[&AssetId::Packet(r::MATERIAL_TEXTURE_BASE)];
        if !float {
            assert_eq!(&data[..4], &[120, 135, 75, 255]);
        }
        let source = std::str::from_utf8(&assets[&scene.shader]).unwrap();
        let module = naga::front::wgsl::parse_str(source).unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
    }
    // A rectangular light reusing a material image must share its independent
    // allocation and remain editable without consuming the budget twice.
    let mut shared = fixture([0, 0], false);
    let mut words: Vec<u32> = bytemuck::pod_collect_to_vec(&shared);
    let at = words.len();
    words.resize(at + layout::light::WORDS, 0);
    words[h::LIGHT_COUNT] = 1;
    words[h::LIGHT_OFFSET] = at as u32;
    words[at + layout::light::COLOR..at + layout::light::COLOR + 3].fill(1f32.to_bits());
    words[at + layout::light::INTENSITY] = 1f32.to_bits();
    words[at + layout::light::SIZE] = 1f32.to_bits();
    words[at + layout::light::HEIGHT_OR_INNER] = 1f32.to_bits();
    words[at + layout::light::SPREAD_OR_OUTER] = 1f32.to_bits();
    words[at + layout::light::TEXTURE] = 1;
    for k in [0, 5, 10, 15] {
        words[at + layout::light::TRANSFORM + k] = 1f32.to_bits();
    }
    words[h::LENGTH] = words.len() as u32;
    shared = bytemuck::cast_slice(&words).to_vec();
    let (scene, _, state) = prepare(&shared, [16384, 65536]);
    assert_eq!(
        scene
            .textures
            .iter()
            .filter(|t| t.id >= r::MATERIAL_TEXTURE_BASE)
            .count(),
        2
    );
    assert!(state.atlas(&shared).is_ok());
    for bindings in [0, 1] {
        let (scene, assets, _) = prepare(&fixture([1, 1], false), [16384, bindings]);
        let atlas = scene.textures.iter().find(|t| t.id == r::ATLAS).unwrap();
        assert_eq!(atlas.depth, 1);
        assert_eq!(
            assets[&AssetId::Packet(r::ATLAS)].len(),
            (atlas.width * atlas.height * 4) as usize
        );
    }
}

#[test]
fn shared_image_samplers_map_to_one_physical_texture() {
    for float in [false, true] {
        for variant in 0..3 {
            let mut words: Vec<u32> = bytemuck::pod_collect_to_vec(&fixture([0, 2], float));
            let off = words[h::TEXTURE_OFFSET] as usize;
            words[off + t::WORDS + t::WIDTH] = if variant == 2 { 2 } else { 3 };
            words[off + t::WORDS + t::HEIGHT] = if variant == 2 { 3 } else { 2 };
            words[off + t::WORDS + t::PIXELS] = words[off + t::PIXELS];
            words[off + t::WORDS + t::WRAP_S] = 1;
            words[off + t::WORDS + t::UV_CHANNEL] = 1;
            if variant == 1 {
                words[off + t::WORDS + t::FLIP_Y] = 0;
            }
            let (scene, assets, _) = prepare(bytemuck::cast_slice(&words), [16384, 65536]);
            let images: Vec<_> = scene
                .textures
                .iter()
                .filter(|t| t.id >= r::MATERIAL_TEXTURE_BASE)
                .collect();
            assert_eq!(images.len(), if variant == 0 { 1 } else { 2 });
            let total: usize = images
                .iter()
                .map(|t| assets[&AssetId::Packet(t.id)].len())
                .sum();
            assert_eq!(total, images.len() * 6 * if float { 8 } else { 4 });
            let metadata: Vec<f32> =
                bytemuck::pod_collect_to_vec(&assets[&AssetId::Packet(r::MAP_INFO)]);
            assert_eq!(metadata[2], 0.);
            assert_eq!(metadata[6], if variant == 0 { 0. } else { 1. });
            let module =
                naga::front::wgsl::parse_str(std::str::from_utf8(&assets[&scene.shader]).unwrap())
                    .unwrap();
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::all(),
            )
            .validate(&module)
            .unwrap();
        }
    }
}

#[test]
fn raw_texture_admission_charges_shared_spans_once() {
    let mut words: Vec<u32> = bytemuck::pod_collect_to_vec(&fixture([0, 0], false));
    let off = words.len();
    let texels = 2048 * 2048;
    let count = (crate::texture_budget::texels() / texels + 2) as usize;
    words.resize(off + count * t::WORDS, 0);
    let pixels = words.len();
    words.resize(pixels + texels as usize, 0);
    words[h::TEXTURE_OFFSET] = off as u32;
    words[h::TEXTURE_COUNT] = count as u32;
    for i in 0..count {
        let o = off + i * t::WORDS;
        words[o + t::WIDTH] = 2048;
        words[o + t::HEIGHT] = 2048;
        words[o + t::PIXELS] = pixels as u32;
        words[o + t::UV_SCALE..o + t::UV_SCALE + 2].fill(1f32.to_bits());
    }
    words[h::LENGTH] = words.len() as u32;
    scene::validate(bytemuck::cast_slice(&words)).unwrap();
}

fn large_fixture() -> Vec<u8> {
    let mut words: Vec<u32> = bytemuck::pod_collect_to_vec(&scene::small_fixture());
    let material = words[64..88].to_vec();
    let mesh = words[44..64].to_vec();
    words[h::MATERIAL_OFFSET] = words.len() as u32;
    words[h::MATERIAL_COUNT] = 5;
    for index in 0..5 {
        let at = words.len();
        words.extend_from_slice(&material);
        words[at + m::MAP] = index;
        words[at + m::EMISSIVE_MAP] = index;
        words[at + m::EMISSION_COLOR..at + m::EMISSION_COLOR + 3].fill(1f32.to_bits());
        words[at + m::EMISSION_LUMINANCE] = 1f32.to_bits();
    }
    words[h::MESH_OFFSET] = words.len() as u32;
    words[h::MESH_COUNT] = 5;
    for index in 0..5 {
        let at = words.len();
        words.extend_from_slice(&mesh);
        words[at + layout::mesh::MATERIAL] = index;
    }
    let textures = words.len();
    words[h::TEXTURE_OFFSET] = textures as u32;
    words[h::TEXTURE_COUNT] = 5;
    words.resize(textures + 5 * t::WORDS, 0);
    words[32 + g::UV] = words.len() as u32;
    words.extend([0f32, 0., 1., 0., 0.5, 1.].map(f32::to_bits));
    for index in 0..5 {
        let at = textures + index * t::WORDS;
        words[at + t::WIDTH] = 2048;
        words[at + t::HEIGHT] = 2048;
        words[at + t::PIXELS] = words.len() as u32;
        words[at + t::UV_SCALE..at + t::UV_SCALE + 2].fill(1f32.to_bits());
        let color = u32::from_le_bytes([40 + index as u8 * 40, 100, 180, 255]);
        words.extend(std::iter::repeat_n(color, 2048 * 2048));
    }
    words[104 + 14] = 3f32.to_bits();
    words[h::LENGTH] = words.len() as u32;
    bytemuck::cast_slice(&words).to_vec()
}

#[test]
#[ignore = "requires real GPU with texture binding arrays"]
fn independent_textures_match_atlas_and_retained_edits_on_gpu() {
    let gpu = GpuDevice::new(false).unwrap();
    assert!(
        gpu.texture_limits()[1] > 0,
        "adapter has no bindless support"
    );
    // Cross the former 64 MiB atlas and 16M input-texel limits on the real
    // upload path, not just a metadata planner. Every source stays at 2048².
    {
        let (scene, assets, _) = prepare(&large_fixture(), gpu.texture_limits());
        let material_textures: Vec<_> = scene
            .textures
            .iter()
            .filter(|t| t.id >= r::MATERIAL_TEXTURE_BASE)
            .collect();
        assert_eq!(material_textures.len(), 5);
        assert!(
            material_textures
                .iter()
                .all(|t| (t.width, t.height) == (2048, 2048))
        );
        let bytes: usize = material_textures
            .iter()
            .map(|t| assets[&AssetId::Packet(t.id)].len())
            .sum();
        assert_eq!(bytes, 80 * 1024 * 1024);
        let (resident, mut target) =
            GpuScene::new(scene, &RenderOptions::default(), &assets, gpu.clone()).unwrap();
        resident.add_samples(&mut target, 4).unwrap();
        assert!(
            resident
                .read_hdr(&target)
                .unwrap()
                .chunks(4)
                .any(|p| p[..3].iter().any(|v| *v > 0.1))
        );
        eprintln!("large texture upload: 5 original 2048x2048 images, {bytes} bytes");
    }
    for float in [false, true] {
        for wrap_s in 0..3 {
            for wrap_t in 0..3 {
                let bytes = fixture([wrap_s, wrap_t], float);
                let (atlas, atlas_assets, _) = prepare(&bytes, [16384, 0]);
                let (independent, assets, retained) = prepare(&bytes, gpu.texture_limits());
                let options = RenderOptions::default();
                let (reference, mut reference_target) =
                    GpuScene::new(atlas, &options, &atlas_assets, gpu.clone()).unwrap();
                reference.add_samples(&mut reference_target, 4).unwrap();
                let (mut tested, mut target) =
                    GpuScene::new(independent, &options, &assets, gpu.clone()).unwrap();
                tested.add_samples(&mut target, 4).unwrap();
                let expected: Vec<f32> = bytemuck::pod_collect_to_vec(
                    &reference.read_target(&reference_target, 0).unwrap(),
                );
                let actual: Vec<f32> =
                    bytemuck::pod_collect_to_vec(&tested.read_target(&target, 0).unwrap());
                assert!(actual.iter().any(|v| *v > 0.01));
                let max = expected
                    .iter()
                    .zip(&actual)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0f32, f32::max);
                assert!(
                    max < 2e-5,
                    "float={float} wrap={wrap_s}/{wrap_t}, max={max}"
                );
                eprintln!(
                    "texture comparison: float={float}, wrap={wrap_s}/{wrap_t}, maxAbs={max}"
                );
                // Exercise the exact incremental packet and upload path, then compare
                // it with a fresh independent scene after the same pixel/sampler edit.
                let mut edited = fixture([wrap_t, wrap_s], float);
                let words: Vec<u32> = bytemuck::pod_collect_to_vec(&edited);
                let texture = words[h::TEXTURE_OFFSET] as usize;
                let pixels = words[texture + t::PIXELS] as usize * 4;
                edited[pixels..pixels + 4].copy_from_slice(&if float {
                    0.25f32.to_le_bytes()
                } else {
                    [190, 12, 40, 255]
                });
                let updates = retained.atlas(&edited).unwrap();
                tested.update_lighting(&updates, Some(&target)).unwrap();
                retained.accept_lighting().unwrap();
                let (fresh, fresh_assets, _) = prepare(&edited, gpu.texture_limits());
                let (fresh, mut fresh_target) =
                    GpuScene::new(fresh, &options, &fresh_assets, gpu.clone()).unwrap();
                fresh.add_samples(&mut fresh_target, 4).unwrap();
                // New target clears accumulation while retaining the edited resources.
                let packet = retained
                    .target(
                        &settings::RenderSettings::default(),
                        [8, 8],
                        0,
                        0,
                        false,
                        &edited[88 * 4..120 * 4],
                        &gpu.loss,
                        false,
                    )
                    .unwrap();
                target = tested.target(packet, [8, 8], Some(target)).unwrap();
                tested.add_samples(&mut target, 4).unwrap();
                assert_eq!(
                    tested.read_target(&target, 0).unwrap(),
                    fresh.read_target(&fresh_target, 0).unwrap()
                );
            }
        }
    }
}
