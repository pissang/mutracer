//! Dirty-object encoding contract: the edited-record path produces the bytes of
//! the complete encoder, and its changes let the engine skip only identical records.
use super::*;
use crate::layout::{geometry as g, material as mat};

/// Deterministic edit generator (64-bit LCG).
struct Random(u64);
impl Random {
    fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn below(&mut self, n: usize) -> usize {
        self.next() as usize % n
    }
    fn unit(&mut self) -> f32 {
        self.next() as f32 / u32::MAX as f32
    }
}

struct Fixture {
    scene: Scene,
    geometries: Vec<GeometryId>,
    materials: Vec<MaterialId>,
    textures: Vec<TextureId>,
    meshes: Vec<MeshId>,
    lights: Vec<LightId>,
}
fn grid(offset: f32) -> Geometry {
    let mut geometry = Geometry::new(
        vec![offset, 0., 0., 1., 0., 0., 0., 1., 0., 1., 1., 0.],
        vec![0, 1, 2, 2, 1, 3],
    );
    geometry.uv[0] = vec![0., 0., 1., 0., 0., 1., 1., 1.].into();
    geometry
}
fn ies(bytes: usize) -> Arc<[u8]> {
    let mut text =
        b"IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 3 1 1 2 0 0 0 1 1 20\n0 45 90\n0\n100 50 0\n"
            .to_vec();
    text.resize(bytes, b' ');
    text.into()
}
impl Fixture {
    fn new() -> Self {
        let mut scene = Scene::new();
        let geometries: Vec<_> = (0..4)
            .map(|i| scene.add_geometry(grid(i as f32 * 0.01)).unwrap())
            .collect();
        let textures: Vec<_> = (0..2)
            .map(|i| {
                scene
                    .add_texture(Texture::rgba8(1, 1, vec![100 + i as u8 * 50; 4]))
                    .unwrap()
            })
            .collect();
        let materials: Vec<_> = (0..4)
            .map(|i| {
                let mut m = OpenPbrMaterial::default();
                if i % 2 == 1 {
                    m.textures[0] = Some(textures[0]);
                }
                scene.add_material(m).unwrap()
            })
            .collect();
        let mut meshes = Vec::new();
        for i in 0..6 {
            let mut mesh = Mesh::new(geometries[i % 4], materials[i % 4]);
            mesh.transform = Mat4::from_translation(Vec3::new(i as f32, 0., 0.));
            if i == 4 {
                mesh.instances = Some(Instances {
                    transforms: vec![Mat4::IDENTITY, Mat4::from_translation(Vec3::Z)].into(),
                    colors: Some(vec![1.; 6].into()),
                });
            }
            if i == 5 {
                mesh.materials = vec![materials[0], materials[1]];
            }
            meshes.push(scene.add_mesh(mesh).unwrap());
        }
        let lights = vec![
            scene
                .add_light(Light::Rect {
                    color: [1.; 3],
                    intensity: 1.,
                    width: 1.,
                    height: 1.,
                    spread: 1.,
                    transform: Mat4::IDENTITY,
                    texture: Some(textures[1]),
                })
                .unwrap(),
            scene
                .add_light(Light::Spot {
                    color: [1.; 3],
                    intensity: 1.,
                    inner: 10.,
                    outer: 30.,
                    transform: Mat4::from_translation(Vec3::Y),
                    ies: ies(80),
                })
                .unwrap(),
        ];
        Self {
            scene,
            geometries,
            materials,
            textures,
            meshes,
            lights,
        }
    }
    /// Applies one random edit. Some edits change the layout or the resource
    /// set, so the complete encoder must take over; a few are invalid.
    fn edit(&mut self, r: &mut Random) {
        let s = &mut self.scene;
        match r.below(21) {
            20 => {
                let id = self.meshes[r.below(self.meshes.len())];
                s.set_mesh_visible(id, r.below(2) != 0).unwrap();
            }
            0..=3 => {
                let mesh = self.meshes[r.below(self.meshes.len())];
                s.mesh_mut(mesh).unwrap().transform =
                    Mat4::from_translation(Vec3::new(r.unit(), r.unit(), 0.));
            }
            4 => {
                let mesh = self.meshes[r.below(self.meshes.len())];
                s.mesh_mut(mesh).unwrap().material = self.materials[r.below(4)];
            }
            5 => {
                let mesh = s.mesh_mut(self.meshes[4]).unwrap();
                let i = mesh.instances.as_mut().unwrap();
                Arc::make_mut(&mut i.transforms)[r.below(2)] =
                    Mat4::from_translation(Vec3::new(0., r.unit(), 1.));
                if r.below(2) == 0 {
                    Arc::make_mut(i.colors.as_mut().unwrap())[r.below(6)] = r.unit();
                }
            }
            6..=8 => {
                let m = s.material_mut(self.materials[r.below(4)]).unwrap();
                m.values.roughness = r.unit();
                m.set_float(3, [r.unit(), 0., 0.]).unwrap();
            }
            9 => {
                // A property outside the fixed extension block adds a record.
                let m = s.material_mut(self.materials[r.below(4)]).unwrap();
                m.set_float(14, [r.unit(), 0., 0.]).unwrap();
            }
            10 => {
                let texture = [None, Some(self.textures[r.below(2)])][r.below(2)];
                s.material_mut(self.materials[r.below(4)]).unwrap().textures[0] = texture;
            }
            11 => {
                let geometry = s.geometry_mut(self.geometries[r.below(4)]).unwrap();
                Arc::make_mut(&mut geometry.positions)[1] = r.unit();
            }
            12 => {
                // New attribute presence changes the layout.
                let geometry = s.geometry_mut(self.geometries[r.below(4)]).unwrap();
                geometry.colors = if geometry.colors.is_empty() {
                    vec![1.; 12].into()
                } else {
                    Arc::from([])
                };
            }
            13 => {
                let light = s.light_mut(self.lights[0]).unwrap();
                if let Light::Rect { intensity, .. } = light {
                    *intensity = r.unit() + 0.5;
                }
            }
            14 => {
                *s.light_mut(self.lights[1]).unwrap() = Light::Spot {
                    color: [r.unit(), 1., 1.],
                    intensity: 1.,
                    inner: 10.,
                    outer: 30.,
                    transform: Mat4::from_translation(Vec3::Y),
                    ies: ies([80, 84][r.below(2)]),
                };
            }
            15 => {
                let mut settings = s.environment_settings();
                settings.rotation = r.unit();
                s.set_environment_settings(settings).unwrap();
                if r.below(2) == 0 {
                    s.set_grounded_background(Some(GroundedBackground {
                        height: 1.,
                        radius: 2. + r.unit(),
                        ground_height: 0.,
                        center: [0.; 2],
                    }))
                    .unwrap();
                }
            }
            16 => {
                let mut camera = Camera::default();
                camera.world_matrix[14] = 2. + r.unit();
                s.set_default_camera(Some(camera));
            }
            17 => s.texture_mut(self.textures[r.below(2)]).unwrap().scale = [r.unit() + 1., 1.],
            18 => {
                // Membership: add a mesh, or remove the last added one.
                if self.meshes.len() > 6 && r.below(2) == 0 {
                    s.remove_mesh(self.meshes.pop().unwrap()).unwrap();
                } else {
                    let mesh = Mesh::new(self.geometries[0], self.materials[0]);
                    self.meshes.push(s.add_mesh(mesh).unwrap());
                }
            }
            _ => {
                // Out of range: rejected by validation on both paths.
                s.material_mut(self.materials[r.below(4)])
                    .unwrap()
                    .values
                    .roughness = 2.;
            }
        }
    }
}
fn words(bytes: &[u8]) -> Vec<u32> {
    bytemuck::pod_collect_to_vec(bytes)
}
/// Checks every record the changes omit is identical, and that the engine's
/// narrowed comparisons agree with the complete ones.
fn check_changes(previous: &[u8], next: &[u8], changes: &Changes) {
    let (a, b) = (words(previous), words(next));
    let record = |w: &[u32], offset: usize, stride: usize, i: usize| {
        let o = w[offset] as usize + i * stride;
        w[o..o + stride].to_vec()
    };
    for i in 0..b[h::GEOMETRY_COUNT] as usize {
        if !changes.geometries.contains(&i) {
            assert_eq!(
                record(&a, h::GEOMETRY_OFFSET, g::WORDS, i),
                record(&b, h::GEOMETRY_OFFSET, g::WORDS, i)
            );
        }
    }
    for i in 0..b[h::MATERIAL_COUNT] as usize {
        if !changes.materials.contains(&i) {
            assert_eq!(
                record(&a, h::MATERIAL_OFFSET, mat::WORDS, i),
                record(&b, h::MATERIAL_OFFSET, mat::WORDS, i)
            );
        }
    }
    let mut hinted = commit_plan::unchanged_records_with(previous, next, changes);
    assert_eq!(hinted, commit_plan::unchanged_records(previous, next));
    commit_plan::extend_object_hints(&mut hinted, next, changes);
    assert_eq!(
        hinted.len(),
        (b[h::GEOMETRY_COUNT] + b[h::TEXTURE_COUNT] + b[h::MATERIAL_COUNT] + b[h::MESH_COUNT])
            as usize
    );
    assert_eq!(
        commit_plan::changed_materials_with(previous, next, Some(&changes.materials)),
        commit_plan::changed_materials_with(previous, next, None)
    );
    assert_eq!(
        predict_with(previous, next, Some(changes)),
        predict_with(previous, next, None)
    );
}
use crate::commit_plan;

#[test]
fn dirty_encoding_matches_complete_encoding_and_narrows_comparisons() {
    let mut f = Fixture::new();
    let mut r = Random(7);
    let mut history: Vec<Arc<Vec<u8>>> = vec![f.scene.descriptor().unwrap()];
    let (mut dirty, mut complete) = (0, 0);
    for step in 0..600 {
        for _ in 0..1 + r.below(3) {
            f.edit(&mut r);
        }
        let previous = history.last().unwrap().clone();
        let expected = {
            let mut w = words(&previous);
            f.scene.encode_into(&mut w, None).map(|_| w)
        };
        let expected_kind = expected.as_ref().ok().and_then(|w| {
            let bytes: Vec<u8> = bytemuck::cast_slice(w).to_vec();
            crate::scene::validate(&bytes)
                .ok()
                .map(|_| predict_with(&previous, &bytes, None))
        });
        assert_eq!(
            f.scene.pending_commit_kind().ok(),
            expected_kind,
            "step {step} prediction"
        );
        match f.scene.descriptor_with_delta() {
            Ok((bytes, delta)) => {
                let expected = expected.unwrap();
                assert_eq!(words(&bytes), expected, "step {step} bytes");
                assert!(expected_kind.is_some(), "step {step} validity");
                match delta.since(&previous) {
                    Some(changes) => {
                        dirty += 1;
                        // Every recent descriptor still in the history is described.
                        for older in &history {
                            if let Some(changes) = delta.since(older) {
                                check_changes(older, &bytes, changes);
                            }
                        }
                        check_changes(&previous, &bytes, changes);
                    }
                    None => complete += 1,
                }
                history.push(bytes);
                if history.len() > 6 {
                    history.remove(0);
                }
            }
            Err(e) => {
                assert!(expected_kind.is_none(), "step {step}: {}", e.message);
                // Undo the invalid value; the next snapshot starts over.
                for &m in &f.materials {
                    let roughness = &mut f.scene.material_mut(m).unwrap().values.roughness;
                    *roughness = roughness.min(1.);
                }
                history = vec![f.scene.descriptor().unwrap()];
            }
        }
    }
    // Both paths are exercised.
    assert!(
        dirty > 200 && complete > 50,
        "dirty {dirty}, complete {complete}"
    );
}

#[test]
fn deltas_span_several_snapshots_and_restart_after_structure_changes() {
    let mut f = Fixture::new();
    let first = f.scene.descriptor().unwrap();
    f.scene.mesh_mut(f.meshes[1]).unwrap().transform = Mat4::from_translation(Vec3::X);
    let second = f.scene.descriptor().unwrap();
    f.scene
        .material_mut(f.materials[2])
        .unwrap()
        .values
        .roughness = 0.9;
    // Edited, then restored: still listed, with identical bytes.
    let original = f.scene.mesh(f.meshes[3]).unwrap().transform;
    f.scene.mesh_mut(f.meshes[3]).unwrap().transform = Mat4::IDENTITY;
    f.scene.mesh_mut(f.meshes[3]).unwrap().transform = original;
    let (third, delta) = f.scene.descriptor_with_delta().unwrap();
    let since_first = delta.since(&first).unwrap();
    assert_eq!(since_first.meshes, BTreeSet::from([1, 3]));
    assert_eq!(since_first.materials, BTreeSet::from([2]));
    assert_eq!(delta.since(&second).unwrap().meshes, BTreeSet::from([3]));
    assert_eq!(delta.since(&third), Some(&Changes::default()));
    check_changes(&first, &third, since_first);
    // A foreign descriptor with the same bytes is not described.
    assert!(delta.since(&Arc::new(first.to_vec())).is_none());
    // Adding and removing a mesh in one batch keeps the bytes but restarts the history.
    let added = f
        .scene
        .add_mesh(Mesh::new(f.geometries[0], f.materials[0]))
        .unwrap();
    f.scene.remove_mesh(added).unwrap();
    let (fourth, delta) = f.scene.descriptor_with_delta().unwrap();
    assert_eq!(*fourth, *third);
    assert!(delta.since(&third).is_none());
    // Older descriptors fall out of the history.
    for i in 0..DELTA_HISTORY {
        f.scene.mesh_mut(f.meshes[0]).unwrap().transform =
            Mat4::from_translation(Vec3::new(i as f32, 1., 0.));
        let (_, delta) = f.scene.descriptor_with_delta().unwrap();
        assert_eq!(delta.since(&fourth).is_some(), i + 1 < DELTA_HISTORY);
    }
}
