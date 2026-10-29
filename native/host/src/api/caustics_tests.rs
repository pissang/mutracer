use super::*;
use crate::scene_api::{Geometry, Light, Mesh, OpenPbrMaterial, Scene};
use glam::{Mat4, Quat, Vec3};
#[test]
#[ignore = "requires a real GPU"]
fn caustics_shared_wgsl_modes_render_and_restart() {
    let mut scene = Scene::new();
    let mut geometry = Geometry::new(
        vec![-1., 0., -1., -1., 0., 1., 1., 0., -1., 1., 0., 1.],
        vec![0, 1, 2, 2, 1, 3],
    );
    geometry.normals = vec![0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0.].into();
    geometry.uv[0] = vec![0., 0., 1., 0., 0., 1., 1., 1.].into();
    let geometry = scene.add_geometry(geometry.clone()).unwrap();
    let mut floor = OpenPbrMaterial::default();
    floor.values.color = [0.6; 3];
    let floor = scene.add_material(floor).unwrap();
    let mut glass = OpenPbrMaterial::default();
    glass.values.transmission = 1.;
    glass.values.roughness = 0.;
    let glass = scene.add_material(glass).unwrap();
    let mut floor_mesh = Mesh::new(geometry, floor);
    floor_mesh.transform = Mat4::from_scale(Vec3::new(6., 1., 6.));
    scene.add_mesh(floor_mesh).unwrap();
    let caster_geometry = if std::env::var_os("MUTRACER_SHARED_GEOMETRY").is_some() {
        geometry
    } else {
        scene
            .add_geometry(scene.geometry(geometry).unwrap().clone())
            .unwrap()
    };
    let mut caster = Mesh::new(caster_geometry, glass);
    caster.transform = Mat4::from_scale_rotation_translation(
        Vec3::new(2.5, 1., 2.5),
        Quat::IDENTITY,
        Vec3::new(0., 1., 0.),
    );
    scene.add_mesh(caster).unwrap();
    scene
        .add_light(Light::Rect {
            color: [1.; 3],
            intensity: 8.,
            width: 3.,
            height: 3.,
            spread: 1.,
            texture: None,
            transform: Mat4::from_rotation_translation(
                Quat::from_rotation_x(-std::f32::consts::FRAC_PI_2),
                Vec3::new(0., 3., 0.),
            ),
        })
        .unwrap();
    let mut camera = Camera::default();
    camera.fov = 50.;
    camera.world_matrix = Mat4::look_at_rh(Vec3::new(0., 0.75, 3.), Vec3::ZERO, Vec3::Y)
        .inverse()
        .to_cols_array();
    scene.set_default_camera(Some(camera));
    if let Ok(out) = std::env::var("MUTRACER_CAUSTICS_EVIDENCE") {
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            format!("{out}/scene-input.bin"),
            scene.descriptor().unwrap().as_ref(),
        )
        .unwrap();
    }
    let engine = Engine::new(EngineOptions {
        backend: if std::env::var_os("MUTRACER_CAUSTIC_HWRT").is_some() {
            Backend::Hardware
        } else {
            Backend::Software
        },
    })
    .unwrap();
    engine.set_scene_object(&scene).unwrap();
    engine.update().unwrap();
    engine.set_camera(Some(camera)).unwrap();
    let base = RenderSettings {
        bounces: 8,
        bevel: false,
        max_samples: 1024,
        size: RenderSize::Fixed {
            width: 64,
            height: 48,
        },
        ..Default::default()
    };
    let render = Render::new(&engine, base.clone()).unwrap();
    let mut results = Vec::new();
    let mut original = None;
    let modes = std::env::var("MUTRACER_CAUSTIC_FLAGS")
        .ok()
        .map(|v| {
            v.split(',')
                .map(|s| s.parse::<u32>().unwrap())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec![0, 2, 4, 6, 0]);
    for flags in modes {
        let caustics = CausticSettings {
            light_tracing: flags & 2 != 0,
            photon_mapping: flags & 4 != 0,
            light_photons: 16384,
            photon_map_photons: 16384,
            photon_map_radius: 0.1,
            ..Default::default()
        };
        render
            .set_settings(RenderSettings {
                caustics,
                ..base.clone()
            })
            .unwrap();
        let mut options = ConvergeOptions::new(1024);
        options.sample_sequence_offset = 17;
        render.converge(options).unwrap();
        let image = render.read_pixels(PixelKind::Hdr).unwrap();
        let mean = image
            .data
            .chunks_exact(4)
            .map(|p| f64::from(p[0] + p[1] + p[2]) / 3.)
            .sum::<f64>()
            / (64. * 48.);
        if flags == 0 {
            if let Some(ref first) = original {
                if std::env::var_os("MUTRACER_CAUSTIC_HWRT").is_none() {
                    assert_eq!(&image.data, first);
                }
            } else {
                original = Some(image.data.clone());
            }
        }
        assert!(image.data.iter().all(|v| v.is_finite()));
        assert!(mean > 0.60 && mean < 0.65, "flags {flags}: {mean}");
        if let Ok(out) = std::env::var("MUTRACER_CAUSTICS_EVIDENCE") {
            std::fs::create_dir_all(&out).unwrap();
            std::fs::write(
                format!("{out}/plane-{flags}.f32"),
                bytemuck::cast_slice(&image.data),
            )
            .unwrap();
        }
        results.push(serde_json::json!({"flags":flags,"mean":mean}));
        println!("caustics {flags}: {mean}");
    }
    if let Ok(out) = std::env::var("MUTRACER_CAUSTICS_EVIDENCE") {
        std::fs::write(
            format!("{out}/results.json"),
            serde_json::to_vec_pretty(&results).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn caustic_target_packet_preserves_plain_independent_frame_guides() {
    let mut scene = Scene::new();
    let geometry = scene
        .add_geometry(Geometry::new(
            vec![-1., 0., -1., -1., 0., 1., 1., 0., -1.],
            vec![0, 1, 2],
        ))
        .unwrap();
    let mut glass = OpenPbrMaterial::default();
    glass.values.transmission = 1.;
    glass.values.roughness = 0.;
    let material = scene.add_material(glass).unwrap();
    scene.add_mesh(Mesh::new(geometry, material)).unwrap();
    scene.set_default_camera(Some(Camera::default()));
    let input = scene.descriptor().unwrap();
    let settings = crate::settings::RenderSettings {
        caustic_flags: 6,
        ..Default::default()
    };
    let (_, _, retained) =
        crate::scene::prepare_retained_with_settings(input.as_ref(), false, 0, &settings).unwrap();
    let field = crate::layout::header::CAMERA_OFFSET * 4;
    let offset = u32::from_le_bytes(input[field..field + 4].try_into().unwrap()) as usize * 4;
    let camera = &input[offset..offset + 128];
    let loss = crate::device_loss::DeviceLossNotifier::default();
    let beauty = retained
        .target(&settings, [9, 7], 0, 0, false, camera, &loss, false)
        .unwrap();
    let packet = beauty.caustics.unwrap();
    assert_eq!(packet.metadata.flags, 6);
    assert_eq!(packet.metadata.workgroup_size, 8);
    assert_eq!(packet.uniform.len(), 112);
    let guides = retained
        .target(&settings, [9, 7], 0, 0, false, camera, &loss, true)
        .unwrap();
    let plain = retained
        .target(
            &crate::settings::RenderSettings::default(),
            [9, 7],
            0,
            0,
            false,
            camera,
            &loss,
            true,
        )
        .unwrap();
    assert!(guides.caustics.is_none());
    assert_eq!(guides.shader, plain.shader);
    assert_eq!(guides.trace, plain.trace);
}
