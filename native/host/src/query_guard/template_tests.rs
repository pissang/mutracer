use super::*;

pub(crate) fn assert_instrumented(source: &str) {
    let protected = instrument(source).unwrap();
    let module = naga::front::wgsl::parse_str(&protected)
        .unwrap_or_else(|e| panic!("{}", e.emit_to_string(&protected)));
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap();
    let main = module
        .entry_points
        .iter()
        .find(|ep| ep.name == "main")
        .unwrap();
    assert_eq!(main.workgroup_size, [8, 4, 1]);
}

fn check_beauty_templates(
    descriptor: Arc<Vec<u8>>,
    settings: settings::RenderSettings,
    quality: u32,
) {
    let word = |i: usize| u32::from_le_bytes(descriptor[i * 4..][..4].try_into().unwrap());
    let size = [word(layout::header::WIDTH), word(layout::header::HEIGHT)];
    let camera = word(layout::header::CAMERA_OFFSET) as usize * 4;
    let (scene, assets, retained) = scene::prepare_retained_shared_with_settings(
        descriptor.clone(),
        true,
        1,
        &settings,
        [16384, 0],
    )
    .unwrap();
    let source = std::str::from_utf8(&assets[&scene.shader]).unwrap();
    assert_instrumented(source);
    let packet = retained
        .target(
            &settings,
            size,
            quality,
            0,
            true,
            &descriptor[camera..camera + 128],
            &Default::default(),
            false,
        )
        .unwrap();
    if let Some(variant) = packet.shader {
        assert_instrumented(&variant);
    }
}

#[cfg(feature = "gltf")]
#[test]
fn chess_hwrt_beauty_template_supports_workgroup_checks() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/assets/chess.glb");
    let chess = scene_api::Scene::import_gltf(path).unwrap();
    check_beauty_templates(
        chess.scene.descriptor().unwrap(),
        settings::RenderSettings {
            bounces: 3,
            direct_light_candidates: 4,
            ..Default::default()
        },
        3,
    );
}

// Reproduce SanMiguel's mixed opaque/alpha traversal without shipping its meshes or textures.
fn san_miguel_materials() -> Arc<Vec<u8>> {
    use scene_api::{Environment, Geometry, Mesh, OpenPbrMaterial, Scene, Texture, TexturePixels};
    let mut scene = Scene::new();
    let texture = scene
        .add_texture(Texture::rgba8(1, 1, [200, 200, 200, 255]))
        .unwrap();
    let env = scene
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(Arc::from([1.; 4])),
            ..Texture::rgba8(1, 1, [0; 4])
        })
        .unwrap();
    scene
        .set_environment(Environment {
            texture: Some(env),
            ..Default::default()
        })
        .unwrap();
    for alpha in [false, true] {
        let mut geometry = Geometry::new([0., 0., 0., 1., 0., 0., 0., 1., 0.], [0, 1, 2]);
        geometry.uv[0] = Arc::from([0., 0., 1., 0., 0., 1.]);
        let geometry = scene.add_geometry(geometry).unwrap();
        let mut material = OpenPbrMaterial::default();
        material.values.double_sided = true;
        material.values.alpha_mode = if alpha { 2 } else { 1 };
        material.values.layers.coat_weight = 0.5;
        material.values.layers.anisotropy = 0.5;
        material.textures[..3].fill(Some(texture));
        if !alpha {
            material.set_uint(51, 1).unwrap(); // shadow catcher
        }
        let material = scene.add_material(material).unwrap();
        scene.add_mesh(Mesh::new(geometry, material)).unwrap();
    }
    scene.descriptor().unwrap()
}

#[test]
fn san_miguel_hwrt_beauty_template_supports_workgroup_checks() {
    let descriptor = match std::env::var_os("MUTRACER_HWRT_SANMIGUEL_DESCRIPTOR") {
        Some(path) => Arc::new(std::fs::read(path).unwrap()),
        None => san_miguel_materials(),
    };
    check_beauty_templates(descriptor, settings::RenderSettings::default(), 0);
}
