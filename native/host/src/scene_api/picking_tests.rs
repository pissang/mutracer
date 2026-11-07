use super::*;
fn triangle() -> (Scene, GeometryId, MaterialId, MeshId) {
    let mut s = Scene::new();
    let g = s
        .add_geometry(Geometry::new(
            vec![-1., -1., -2., 1., -1., -2., 0., 1., -2.],
            vec![0, 1, 2],
        ))
        .unwrap();
    let m = s.add_material(OpenPbrMaterial::default()).unwrap();
    let mesh = s.add_mesh(Mesh::new(g, m)).unwrap();
    (s, g, m, mesh)
}
#[test]
fn scene_picker_transforms_instances_materials_and_triangle_ids() {
    let (mut s, g, m, mesh) = triangle();
    let m2 = s.add_material(OpenPbrMaterial::default()).unwrap();
    // Original primitive 1 is closer. BVH traversal order must not become its ID.
    let geo = s.geometry_mut(g).unwrap();
    geo.positions = vec![
        -1., -1., -5., 1., -1., -5., 0., 1., -5., -1., -1., -2., 1., -1., -2., 0., 1., -2.,
    ]
    .into();
    geo.indices = vec![0, 1, 2, 3, 4, 5].into();
    geo.material_indices = vec![0, 0, 0, 1, 1, 1].into();
    let object = s.mesh_mut(mesh).unwrap();
    object.materials = vec![m, m2];
    object.transform = Mat4::from_translation(Vec3::new(2., 0., 0.));
    object.instances = Some(Instances {
        transforms: vec![
            Mat4::from_translation(Vec3::new(5., 0., 0.)),
            Mat4::from_scale(Vec3::new(-2., 3., 0.5)),
        ]
        .into(),
        colors: None,
    });
    let picker = s.picker().unwrap();
    let hit = picker
        .raycast(
            Ray {
                origin: [2., 0., 0.],
                direction: [0., 0., -7.],
            },
            Default::default(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            hit.mesh,
            hit.geometry,
            hit.material,
            hit.instance,
            hit.primitive
        ),
        (mesh, g, m2, Some(1), 1)
    );
    assert_eq!(hit.distance, 1.);
    assert_eq!(hit.position, [2., 0., -1.]);
    assert_eq!(hit.normal, [0., 0., -1.]);
    assert_eq!(hit.barycentric, [0.25, 0.25, 0.5]);
    // Back faces and transparent materials remain geometric candidates.
    s.material_mut(m2).unwrap().values.opacity = 0.;
    assert!(
        s.picker()
            .unwrap()
            .raycast(
                Ray {
                    origin: [2., 0., -1.5],
                    direction: [0., 0., 1.]
                },
                Default::default()
            )
            .unwrap()
            .is_some()
    );
}
#[test]
fn scene_picker_snapshots_survive_edits_destruction_and_concurrent_queries() {
    let (mut s, g, m, mesh) = triangle();
    let mut far = Mesh::new(g, m);
    far.transform = Mat4::from_translation(Vec3::new(0., 0., -3.));
    let far = s.add_mesh(far).unwrap();
    let picker = Arc::new(s.picker().unwrap());
    let cast = |options| picker.raycast(Ray::default(), options).unwrap();
    assert_eq!(cast(Default::default()).unwrap().mesh, mesh);
    let at_surface = picker
        .raycast(
            Ray {
                origin: [0., 0., -2.],
                ..Default::default()
            },
            Default::default(),
        )
        .unwrap()
        .unwrap();
    assert_eq!((at_surface.mesh, at_surface.distance), (mesh, 0.));
    let tiny_direction = picker
        .raycast(
            Ray {
                direction: [0., 0., -f32::from_bits(1)],
                ..Default::default()
            },
            Default::default(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(tiny_direction.distance, 2.);
    assert_eq!(
        cast(RaycastOptions {
            min_distance: 3.,
            max_distance: 6.
        })
        .unwrap()
        .mesh,
        far
    );
    assert!(
        cast(RaycastOptions {
            min_distance: 0.,
            max_distance: 2.
        })
        .is_none()
    );
    assert_eq!(
        cast(RaycastOptions {
            min_distance: 2.,
            max_distance: 5.
        })
        .unwrap()
        .mesh,
        mesh
    );
    assert_eq!(
        cast(RaycastOptions {
            min_distance: 2.01,
            max_distance: 6.
        })
        .unwrap()
        .mesh,
        far
    );
    Arc::make_mut(&mut s.geometry_mut(g).unwrap().positions)
        .iter_mut()
        .step_by(3)
        .for_each(|x| *x += 10.);
    assert!(
        s.picker()
            .unwrap()
            .raycast(Ray::default(), Default::default())
            .unwrap()
            .is_none()
    );
    s.remove_mesh(mesh).unwrap();
    drop(s);
    let joins: Vec<_> = (0..4)
        .map(|_| {
            let picker = picker.clone();
            std::thread::spawn(move || {
                for _ in 0..100 {
                    assert_eq!(
                        picker
                            .raycast(Ray::default(), Default::default())
                            .unwrap()
                            .unwrap()
                            .mesh,
                        mesh
                    );
                }
            })
        })
        .collect();
    for j in joins {
        j.join().unwrap();
    }
}
#[test]
fn scene_picker_rejects_invalid_inputs_and_accepts_empty_scenes() {
    assert!(
        Scene::new()
            .picker()
            .unwrap()
            .raycast(Ray::default(), Default::default())
            .unwrap()
            .is_none()
    );
    let (mut s, g, _, mesh) = triangle();
    let p = s.picker().unwrap();
    for ray in [
        Ray {
            direction: [0.; 3],
            ..Default::default()
        },
        Ray {
            origin: [f32::NAN, 0., 0.],
            ..Default::default()
        },
        Ray {
            direction: [0., f32::INFINITY, 1.],
            ..Default::default()
        },
    ] {
        assert_eq!(
            p.raycast(ray, Default::default()).unwrap_err().status,
            Status::InvalidArgument
        );
    }
    for (a, b) in [
        (-1., 3.),
        (1., 1.),
        (0., f32::INFINITY),
        (f32::NAN, 3.),
        (0., 1e31),
    ] {
        assert_eq!(
            p.raycast(
                Ray::default(),
                RaycastOptions {
                    min_distance: a,
                    max_distance: b
                }
            )
            .unwrap_err()
            .status,
            Status::InvalidArgument
        );
    }
    for matrix in [
        Mat4::from_scale(Vec3::ZERO),
        Mat4::perspective_rh(1., 1., 0.1, 100.),
        Mat4::from_cols_array(&[f32::NAN; 16]),
    ] {
        s.mesh_mut(mesh).unwrap().transform = matrix;
        assert_eq!(s.picker().err().unwrap().status, Status::InvalidArgument);
    }
    s.mesh_mut(mesh).unwrap().transform = Mat4::IDENTITY;
    s.geometry_mut(g).unwrap().indices = vec![0, 1, 99].into();
    assert_eq!(s.picker().err().unwrap().status, Status::InvalidArgument);
    s.remove_geometry(g).unwrap();
    assert_eq!(s.picker().err().unwrap().status, Status::InvalidHandle);
}
// Independent double-precision Moller-Trumbore over transformed triangles.
fn brute(o: DVec3, d: DVec3, points: [DVec3; 3]) -> Option<(f64, [f64; 3], DVec3)> {
    let [a, b, c] = points;
    let e = b - a;
    let f = c - a;
    let p = d.cross(f);
    let det = e.dot(p);
    if det.abs() < 1e-12 {
        return None;
    }
    let q = o - a;
    let u = q.dot(p) / det;
    if !(0. ..=1.).contains(&u) {
        return None;
    }
    let r = q.cross(e);
    let v = d.dot(r) / det;
    if v < 0. || u + v > 1. {
        return None;
    }
    let t = f.dot(r) / det;
    (t > 0.).then_some((t, [1. - u - v, u, v], e.cross(f).normalize()))
}
#[test]
fn scene_picker_hierarchy_matches_brute_force_world_triangles() {
    let (mut s, g, m, base) = triangle();
    s.remove_mesh(base).unwrap();
    let geo = s.geometry_mut(g).unwrap();
    geo.positions = vec![-1., -1., 0., 1., -1., 0., 1., 1., 0., -1., 1., 0.].into();
    geo.indices = vec![0, 1, 2, 0, 2, 3].into();
    let positions = geo.positions.clone();
    let indices = geo.indices.clone();
    let mut candidates = vec![];
    for i in 0..32 {
        let mut mesh = Mesh::new(g, m);
        mesh.transform = Mat4::from_translation(Vec3::new(
            (i % 8) as f32 * 1.5 - 5.,
            (i / 8) as f32 * 1.5 - 2.,
            -2. - (i % 3) as f32 - i as f32 * 0.013,
        ));
        let transforms: Arc<[Mat4]> = vec![
            Mat4::from_rotation_y(i as f32 * 0.07)
                * Mat4::from_scale(Vec3::new(if i % 2 == 0 { -0.6 } else { 0.7 }, 0.6, 1.3)),
            Mat4::from_translation(Vec3::new(0.2, 0.1, -1.)),
        ]
        .into();
        mesh.instances = Some(Instances {
            transforms: transforms.clone(),
            colors: None,
        });
        let world = mesh.transform;
        let id = s.add_mesh(mesh).unwrap();
        for (instance, local) in transforms.iter().enumerate() {
            let matrix = world.as_dmat4() * local.as_dmat4();
            for (primitive, triangle) in indices.chunks_exact(3).enumerate() {
                let point = |i: u32| {
                    matrix.transform_point3(
                        Vec3::from_slice(&positions[i as usize * 3..i as usize * 3 + 3]).as_dvec3(),
                    )
                };
                candidates.push((
                    id,
                    instance as u32,
                    primitive as u32,
                    [point(triangle[0]), point(triangle[1]), point(triangle[2])],
                ));
            }
        }
    }
    let picker = s.picker().unwrap();
    let mut state = 93467u32;
    let mut hits = 0;
    let mut random = || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        state as f64 / u32::MAX as f64
    };
    for _ in 0..500 {
        let origin = DVec3::new(0., 0., 3.);
        let direction = DVec3::new(random() * 15. - 7.5, random() * 9. - 4.5, -7.).normalize();
        let ray = Ray {
            origin: origin.as_vec3().to_array(),
            direction: direction.as_vec3().to_array(),
        };
        let direction = Vec3::from_array(ray.direction).as_dvec3().normalize();
        let expected = candidates
            .iter()
            .filter_map(|&(mesh, instance, primitive, points)| {
                brute(origin, direction, points)
                    .map(|(t, b, n)| (t, mesh, instance, primitive, b, n))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0));
        let actual = picker.raycast(ray, Default::default()).unwrap();
        match (actual, expected) {
            (None, None) => {}
            (Some(a), Some((t, mesh, instance, primitive, b, n))) => {
                hits += 1;
                assert_eq!(
                    (a.mesh, a.instance, a.primitive),
                    (mesh, Some(instance), primitive)
                );
                assert!((a.distance as f64 - t).abs() < 2e-5);
                assert!(Vec3::from_array(a.normal).as_dvec3().dot(n) > 0.99999);
                for i in 0..3 {
                    assert!((a.barycentric[i] as f64 - b[i]).abs() < 2e-5);
                }
            }
            _ => panic!("hierarchy disagrees with brute force"),
        }
    }
    assert!(hits > 100);
}

#[test]
fn hidden_meshes_are_excluded_from_new_pick_snapshots() {
    let (mut s, _, _, mesh) = triangle();
    let ray = Ray {
        origin: [0.; 3],
        direction: [0., 0., -1.],
    };
    assert!(
        s.picker()
            .unwrap()
            .raycast(ray, Default::default())
            .unwrap()
            .is_some()
    );
    s.set_mesh_visible(mesh, false).unwrap();
    assert!(
        s.picker()
            .unwrap()
            .raycast(ray, Default::default())
            .unwrap()
            .is_none()
    );
    s.set_mesh_visible(mesh, true).unwrap();
    assert!(
        s.picker()
            .unwrap()
            .raycast(ray, Default::default())
            .unwrap()
            .is_some()
    );
}
