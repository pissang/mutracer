//! Commit classification contract; each edit starts from an encoded scene.
use super::*;
use CommitKind::{Full, Incremental};

struct Fixture {
    scene: Scene,
    geometry: GeometryId,
    material: MaterialId,
    texture: TextureId,
    hdr: TextureId,
    mesh: MeshId,
    second_mesh: MeshId,
    light: LightId,
}
impl Fixture {
    fn new() -> Self {
        let mut scene = Scene::new();
        let mut geometry =
            Geometry::new(vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.], vec![0, 1, 2]);
        geometry.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1.].into();
        geometry.tangents = vec![1., 0., 0., 1., 1., 0., 0., 1., 1., 0., 0., 1.].into();
        geometry.uv = [vec![0., 0., 1., 0., 0.5, 1.].into(), vec![0.; 6].into()];
        let second_geometry = scene.add_geometry(geometry.clone()).unwrap();
        let geometry = scene.add_geometry(geometry).unwrap();
        let texture = scene
            .add_texture(Texture::rgba8(1, 1, vec![255; 4]))
            .unwrap();
        let hdr = scene
            .add_texture(Texture {
                pixels: TexturePixels::Rgba32F(vec![0.5, 0.5, 0.5, 1.].into()),
                ..Texture::rgba8(1, 1, vec![])
            })
            .unwrap();
        let mut m = OpenPbrMaterial::default();
        m.textures[0] = Some(texture);
        let material = scene.add_material(m).unwrap();
        let second_material = scene.add_material(OpenPbrMaterial::default()).unwrap();
        let mesh = scene
            .add_mesh(Mesh {
                instances: Some(Instances {
                    transforms: vec![Mat4::IDENTITY; 2].into(),
                    colors: Some(vec![1.; 6].into()),
                }),
                ..Mesh::new(geometry, material)
            })
            .unwrap();
        let second_mesh = scene
            .add_mesh(Mesh::new(second_geometry, second_material))
            .unwrap();
        let light = scene
            .add_light(Light::Directional {
                color: [1.; 3],
                intensity: 1.,
                transform: Mat4::IDENTITY,
            })
            .unwrap();
        scene
            .set_environment(Environment {
                texture: Some(hdr),
                background: Some(hdr),
                ..Environment::default()
            })
            .unwrap();
        Self {
            scene,
            geometry,
            material,
            texture,
            hdr,
            mesh,
            second_mesh,
            light,
        }
    }
    fn check(&mut self, name: &str, expected: CommitKind, edit: impl FnOnce(&mut Self)) {
        self.scene.descriptor().unwrap();
        edit(self);
        let actual = self.scene.pending_commit_kind().unwrap();
        println!("CLASSIFICATION {name}: {actual:?}");
        assert_eq!(actual, expected, "{name}");
    }
}

#[test]
fn material_core_fields_are_incremental() {
    for (name, property, value) in [
        ("base color", 2, [0.2, 0.3, 0.4]),
        ("roughness", 7, [0.7, 0., 0.]),
        ("metalness", 4, [0.3, 0., 0.]),
        ("transmission", 10, [0.2, 0., 0.]),
        ("IOR", 8, [1.7, 0., 0.]),
    ] {
        Fixture::new().check(name, Incremental, |f| {
            f.scene
                .material_mut(f.material)
                .unwrap()
                .set_float(property, value)
                .unwrap()
        });
    }
}

#[test]
fn openpbr_parameters_are_incremental_candidates() {
    for (name, property, value) in [
        ("emission color", 34, [0.2, 0.3, 0.4]),
        ("emission strength", 35, [2., 0., 0.]),
        ("coat weight", 25, [0.5, 0., 0.]),
        ("coat roughness", 27, [0.3, 0., 0.]),
        ("opacity", 36, [0.5, 0., 0.]),
        ("OpenPBR specular weight", 5, [0.5, 0., 0.]),
    ] {
        Fixture::new().check(name, Incremental, |f| {
            f.scene
                .material_mut(f.material)
                .unwrap()
                .set_float(property, value)
                .unwrap()
        });
    }
    Fixture::new().check("thin-walled", Incremental, |f| {
        f.scene
            .material_mut(f.material)
            .unwrap()
            .set_uint(37, 1)
            .unwrap()
    });
}

#[test]
fn material_texture_references_are_incremental_candidates() {
    for slot in 0..9 {
        let mut f = Fixture::new();
        f.scene.material_mut(f.material).unwrap().textures[slot] = Some(f.texture);
        let expected = if slot == 8 { Full } else { Incremental };
        f.check(&format!("remove texture slot {slot}"), expected, |f| {
            f.scene.material_mut(f.material).unwrap().textures[slot] = None
        });
        let mut f = Fixture::new();
        f.scene.material_mut(f.material).unwrap().textures[slot] = None;
        f.check(&format!("add texture slot {slot}"), expected, |f| {
            f.scene.material_mut(f.material).unwrap().textures[slot] = Some(f.texture)
        });
    }
}

#[test]
fn texture_parameters_and_pixels() {
    let edits: &[(&str, fn(&mut Fixture))] = &[
        ("texture UV channel", |f| {
            f.scene.texture_mut(f.texture).unwrap().uv = 1
        }),
        ("texture scale", |f| {
            f.scene.texture_mut(f.texture).unwrap().scale = [2., 3.]
        }),
        ("texture offset", |f| {
            f.scene.texture_mut(f.texture).unwrap().offset = [0.2, 0.3]
        }),
        ("texture wrap S", |f| {
            f.scene.texture_mut(f.texture).unwrap().wrap[0] = 1
        }),
        ("texture wrap T", |f| {
            f.scene.texture_mut(f.texture).unwrap().wrap[1] = 2
        }),
        ("texture flip Y", |f| {
            f.scene.texture_mut(f.texture).unwrap().flip_y = true
        }),
        ("texture RGBA8 pixels", |f| {
            f.scene.texture_mut(f.texture).unwrap().pixels =
                TexturePixels::Rgba8(vec![150, 200, 250, 255].into())
        }),
        ("texture size", |f| {
            let t = f.scene.texture_mut(f.texture).unwrap();
            t.width = 2;
            t.pixels = TexturePixels::Rgba8(vec![255; 8].into());
        }),
        ("texture height", |f| {
            let t = f.scene.texture_mut(f.texture).unwrap();
            t.height = 2;
            t.pixels = TexturePixels::Rgba8(vec![255; 8].into());
        }),
        ("texture storage", |f| {
            f.scene.texture_mut(f.texture).unwrap().pixels =
                TexturePixels::Rgba32F(vec![1.; 4].into())
        }),
        ("environment/background pixels", |f| {
            f.scene.texture_mut(f.hdr).unwrap().pixels =
                TexturePixels::Rgba32F(vec![0.3, 0.4, 0.5, 1.].into())
        }),
        ("environment/background size", |f| {
            let t = f.scene.texture_mut(f.hdr).unwrap();
            t.width = 2;
            t.pixels = TexturePixels::Rgba32F(vec![0.5; 8].into());
        }),
    ];
    for &(name, edit) in edits {
        Fixture::new().check(name, Incremental, edit);
    }
    // Height maps shape the displaced BLAS: any change prepares again, whatever the scale.
    let displaced: &[(&str, f32, fn(&mut Fixture))] = &[
        ("displacement map pixels", 0.1, |f| {
            f.scene.texture_mut(f.texture).unwrap().pixels =
                TexturePixels::Rgba8(vec![100; 4].into())
        }),
        ("displacement map scale", 0.1, |f| {
            f.scene.texture_mut(f.texture).unwrap().scale = [2., 2.]
        }),
        ("zero-scale displacement map pixels", 0., |f| {
            f.scene.texture_mut(f.texture).unwrap().pixels =
                TexturePixels::Rgba8(vec![100; 4].into())
        }),
    ];
    for &(name, scale, edit) in displaced {
        let mut f = Fixture::new();
        f.scene.material_mut(f.material).unwrap().textures[8] = Some(f.texture);
        f.scene
            .material_mut(f.material)
            .unwrap()
            .values
            .layers
            .displacement_scale = scale;
        f.check(name, Full, edit);
    }
}

#[test]
fn retained_scene_edits_are_incremental() {
    let edits: &[(&str, fn(&mut Fixture))] = &[
        ("camera", |f| {
            f.scene.set_default_camera(Some(Camera {
                fov: 55.,
                ..Camera::default()
            }))
        }),
        ("mesh matrix", |f| {
            f.scene.mesh_mut(f.mesh).unwrap().transform = Mat4::from_translation(Vec3::X)
        }),
        ("instance matrix", |f| {
            Arc::make_mut(
                &mut f
                    .scene
                    .mesh_mut(f.mesh)
                    .unwrap()
                    .instances
                    .as_mut()
                    .unwrap()
                    .transforms,
            )[0] = Mat4::from_translation(Vec3::X)
        }),
        ("instance colors", |f| {
            Arc::make_mut(
                f.scene
                    .mesh_mut(f.mesh)
                    .unwrap()
                    .instances
                    .as_mut()
                    .unwrap()
                    .colors
                    .as_mut()
                    .unwrap(),
            )[0] = 0.2
        }),
        ("vertex positions", |f| {
            Arc::make_mut(&mut f.scene.geometry_mut(f.geometry).unwrap().positions)[0] -= 0.1
        }),
        ("vertex normals", |f| {
            Arc::make_mut(&mut f.scene.geometry_mut(f.geometry).unwrap().normals)[0] = 0.1
        }),
        ("vertex tangents", |f| {
            Arc::make_mut(&mut f.scene.geometry_mut(f.geometry).unwrap().tangents)[0] = 0.9
        }),
        ("change light", |f| {
            *f.scene.light_mut(f.light).unwrap() = Light::Directional {
                color: [0.5; 3],
                intensity: 2.,
                transform: Mat4::IDENTITY,
            }
        }),
        ("add light", |f| {
            f.scene
                .add_light(Light::Sphere {
                    color: [1.; 3],
                    intensity: 1.,
                    radius: 0.1,
                    transform: Mat4::IDENTITY,
                })
                .unwrap();
        }),
        ("remove light", |f| f.scene.remove_light(f.light).unwrap()),
        ("background color", |f| {
            f.scene
                .set_environment(Environment {
                    texture: Some(f.hdr),
                    background: Some(f.hdr),
                    color: [0.1, 0.2, 0.3, 1.],
                })
                .unwrap()
        }),
    ];
    for &(name, edit) in edits {
        Fixture::new().check(name, Incremental, edit);
    }
}

#[test]
fn structural_scene_edits_require_full_preparation() {
    let edits: &[(&str, fn(&mut Fixture))] = &[
        ("triangle indices", |f| {
            f.scene.geometry_mut(f.geometry).unwrap().indices = vec![2, 1, 0].into()
        }),
        ("index count", |f| {
            f.scene.geometry_mut(f.geometry).unwrap().indices = vec![0, 1, 2, 2, 1, 0].into()
        }),
        ("vertex count", |f| {
            let g = f.scene.geometry_mut(f.geometry).unwrap();
            g.positions = vec![0.; 12].into();
            g.normals = vec![0.; 12].into();
            g.tangents = vec![0.; 16].into();
            g.uv = [vec![0.; 8].into(), vec![0.; 8].into()];
        }),
        ("reorder mesh references", |f| {
            let a = f.scene.mesh(f.mesh).unwrap().clone();
            let b = f.scene.mesh(f.second_mesh).unwrap().clone();
            *f.scene.mesh_mut(f.mesh).unwrap() = b;
            *f.scene.mesh_mut(f.second_mesh).unwrap() = a;
        }),
        ("instance count", |f| {
            let i = f
                .scene
                .mesh_mut(f.mesh)
                .unwrap()
                .instances
                .as_mut()
                .unwrap();
            i.transforms = vec![Mat4::IDENTITY; 3].into();
            i.colors = Some(vec![1.; 9].into());
        }),
        ("remove instance colors", |f| {
            f.scene
                .mesh_mut(f.mesh)
                .unwrap()
                .instances
                .as_mut()
                .unwrap()
                .colors = None
        }),
        ("texture count", |f| {
            f.scene
                .add_texture(Texture::rgba8(1, 1, vec![255; 4]))
                .unwrap();
        }),
        ("hide background", |f| {
            f.scene
                .set_environment(Environment {
                    texture: Some(f.hdr),
                    background: None,
                    ..Environment::default()
                })
                .unwrap()
        }),
        ("remove environment map", |f| {
            f.scene
                .set_environment(Environment {
                    texture: None,
                    background: Some(f.hdr),
                    ..Environment::default()
                })
                .unwrap()
        }),
        ("geometry UV", |f| {
            Arc::make_mut(&mut f.scene.geometry_mut(f.geometry).unwrap().uv[0])[0] = 0.2
        }),
    ];
    for &(name, edit) in edits {
        Fixture::new().check(name, Full, edit);
    }
}

#[test]
fn target_settings_are_outside_scene_prediction() {
    // Scene snapshots have no render settings. The descriptor commit planner
    // must still reject target size/quality edits for retained L0 preparation.
    let f = Fixture::new();
    let before = f.scene.descriptor().unwrap();
    for (name, resolution, quality, field, value) in [
        ("render resolution", true, false, h::WIDTH, 2u32),
        ("render quality", false, true, h::QUALITY_FLAGS, 1u32),
    ] {
        let mut after = before.as_ref().clone();
        after[field * 4..field * 4 + 4].copy_from_slice(&value.to_le_bytes());
        let sync = crate::scene::SceneSync {
            resolution,
            quality,
            meshes: 0,
            lights: false,
            background: false,
            camera: false,
            visibility: vec![],
            transforms: vec![],
            colors: vec![],
            geometries: vec![],
            materials: vec![],
        };
        assert!(crate::commit_plan::plan(&before, &after, &sync, false).is_none());
        assert_eq!(f.scene.pending_commit_kind().unwrap(), Incremental);
        println!("CLASSIFICATION {name}: Full (target descriptor; outside Scene prediction)");
    }
}

#[test]
fn environment_controls_are_validated_and_incremental() {
    for field in 0..4 {
        Fixture::new().check("environment controls", Incremental, |f| {
            let mut settings = EnvironmentSettings::default();
            match field {
                0 => settings.intensity = 0.,
                1 => settings.rotation = 1.,
                2 => settings.background_intensity = 2.,
                _ => settings.background_rotation = -2.,
            }
            f.scene.set_environment_settings(settings).unwrap();
        });
    }
    let mut f = Fixture::new();
    let old = f.scene.descriptor().unwrap();
    for settings in [
        EnvironmentSettings {
            intensity: -1.,
            ..Default::default()
        },
        EnvironmentSettings {
            rotation: f32::NAN,
            ..Default::default()
        },
        EnvironmentSettings {
            background_intensity: -1.,
            ..Default::default()
        },
        EnvironmentSettings {
            background_rotation: f32::INFINITY,
            ..Default::default()
        },
    ] {
        assert!(f.scene.set_environment_settings(settings).is_err());
        assert!(Arc::ptr_eq(&old, &f.scene.descriptor().unwrap()));
    }
}

#[test]
fn mesh_membership_is_incremental() {
    Fixture::new().check("add mesh", Incremental, |f| {
        f.scene.add_mesh(Mesh::new(f.geometry, f.material)).unwrap();
    });
    Fixture::new().check("remove mesh", Incremental, |f| {
        f.scene.remove_mesh(f.second_mesh).unwrap()
    });
    Fixture::new().check("remove/add same mesh slot", Incremental, |f| {
        let mesh = f.scene.mesh_mut(f.mesh).unwrap().clone();
        f.scene.remove_mesh(f.mesh).unwrap();
        f.mesh = f.scene.add_mesh(mesh).unwrap();
    });
}

#[test]
fn mesh_visibility_is_incremental_unless_structure_changes() {
    Fixture::new().check("hide", Incremental, |f| {
        f.scene.set_mesh_visible(f.mesh, false).unwrap()
    });
    Fixture::new().check("hide and transform/material", Incremental, |f| {
        f.scene.set_mesh_visible(f.mesh, false).unwrap();
        f.scene.mesh_mut(f.second_mesh).unwrap().transform = Mat4::from_translation(Vec3::X);
        f.scene.material_mut(f.material).unwrap().values.color = [0.1, 0.3, 0.5];
    });
    Fixture::new().check("hide and membership", Incremental, |f| {
        f.scene.set_mesh_visible(f.mesh, false).unwrap();
        f.scene.add_mesh(Mesh::new(f.geometry, f.material)).unwrap();
    });
}

#[test]
fn any_number_of_stable_batch_matrices_is_incremental() {
    for count in [128, 2048] {
        for changed in [1, 64, count / 2, count / 2 + 1, count] {
            let mut f = Fixture::new();
            f.scene.mesh_mut(f.mesh).unwrap().instances = Some(Instances {
                transforms: vec![Mat4::IDENTITY; count].into(),
                colors: None,
            });
            f.check("stable large matrix batch", Incremental, |f| {
                let instances = f
                    .scene
                    .mesh_mut(f.mesh)
                    .unwrap()
                    .instances
                    .as_mut()
                    .unwrap();
                for matrix in &mut Arc::make_mut(&mut instances.transforms)[..changed] {
                    *matrix = Mat4::from_translation(Vec3::new(0.1, 0., 0.));
                }
            });
        }
    }
}
