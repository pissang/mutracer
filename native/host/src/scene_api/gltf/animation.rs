//! glTF clip evaluation in mesh-local space, before the retained descriptor sync.
//! Immutable source vertices/keys are shared with background commits and picking.
use super::model::Model;
use crate::scene_api::Geometry;
use anyhow::{Context, Result, ensure};
use glam::{Mat4, Quat, Vec3};
use gltf::animation::{Interpolation, Property, util::ReadOutputs};
use std::sync::Arc;

#[derive(Clone)]
struct Node {
    local: Mat4,
    translation: Vec3,
    rotation: Quat,
    scale: Vec3,
    weights: Vec<f32>,
    parent: Option<usize>,
}
struct Channel {
    node: usize,
    property: Property,
    interpolation: Interpolation,
    times: Vec<f32>,
    values: Vec<f32>,
    width: usize,
}
pub struct Clip {
    pub name: String,
    pub duration: f32,
    channels: Vec<Channel>,
}
struct MeshBinding {
    node: usize,
    instance: Mat4,
}
struct Morph {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    tangents: Vec<[f32; 3]>,
}
struct Skin {
    joints: Vec<usize>,
    inverse_bind: Vec<Mat4>,
    indices: Vec<[u16; 4]>,
    weights: Vec<[f32; 4]>,
}
struct Deformation {
    node: usize,
    geometry: usize,
    base: Geometry,
    morphs: Vec<Morph>,
    skin: Option<Skin>,
}
struct Source {
    nodes: Vec<Node>,
    order: Vec<usize>,
    clips: Vec<Clip>,
    meshes: Vec<MeshBinding>,
    deformations: Vec<Deformation>,
}
#[derive(Clone)]
pub struct Animation {
    source: Arc<Source>,
    // World-space user edits remain an offset from the animated transform.
    offsets: Vec<Mat4>,
    pub clip: usize,
    pub time: f32,
    pub playing: bool,
    pub speed: f32,
    pub looping: bool,
    pub pending: bool,
}
impl Channel {
    fn value(&self, key: usize) -> &[f32] {
        let factor = if self.interpolation == Interpolation::CubicSpline {
            3
        } else {
            1
        };
        let offset = (key * factor + usize::from(factor == 3)) * self.width;
        &self.values[offset..offset + self.width]
    }
    fn sample(&self, time: f32) -> Result<Vec<f32>> {
        let next = self.times.partition_point(|t| *t <= time);
        let mut value = if next == 0 {
            self.value(0).to_vec()
        } else if next == self.times.len() || self.interpolation == Interpolation::Step {
            self.value(next - 1).to_vec()
        } else {
            let prev = next - 1;
            let dt = self.times[next] - self.times[prev];
            let t = (time - self.times[prev]) / dt;
            let a = self.value(prev);
            let b = self.value(next);
            if self.interpolation == Interpolation::CubicSpline {
                let t2 = t * t;
                let t3 = t2 * t;
                (0..self.width)
                    .map(|k| {
                        let outgoing = self.values[(prev * 3 + 2) * self.width + k];
                        let incoming = self.values[next * 3 * self.width + k];
                        (2. * t3 - 3. * t2 + 1.) * a[k]
                            + (t3 - 2. * t2 + t) * dt * outgoing
                            + (-2. * t3 + 3. * t2) * b[k]
                            + (t3 - t2) * dt * incoming
                    })
                    .collect()
            } else if self.property == Property::Rotation {
                quaternion(a)?.slerp(quaternion(b)?, t).to_array().to_vec()
            } else {
                a.iter().zip(b).map(|(a, b)| a + (b - a) * t).collect()
            }
        };
        if self.property == Property::Rotation {
            let rotation = quaternion(&value)?.to_array();
            value.copy_from_slice(&rotation);
        }
        ensure!(
            value.iter().all(|v| v.is_finite()),
            "Animation produced non-finite values"
        );
        Ok(value)
    }
}
fn quaternion(v: &[f32]) -> Result<Quat> {
    let q = Quat::from_xyzw(v[0], v[1], v[2], v[3]);
    ensure!(
        q.is_finite() && q.length_squared().is_finite() && q.length_squared() > 1e-12,
        "Invalid animation quaternion"
    );
    Ok(q.normalize())
}
fn valid_transform(matrix: Mat4) -> bool {
    crate::scene::invertible_affine(&matrix.to_cols_array())
}
impl Animation {
    pub fn load(document: &gltf::Document, buffers: &[gltf::buffer::Data]) -> Result<Option<Self>> {
        if document.animations().len() == 0 {
            return Ok(None);
        }
        let mut nodes: Vec<_> = document
            .nodes()
            .map(|node| {
                let (t, r, s) = node.transform().decomposed();
                let weights = node
                    .weights()
                    .or_else(|| node.mesh().and_then(|m| m.weights()))
                    .map(<[f32]>::to_vec)
                    .unwrap_or_else(|| {
                        vec![
                            0.;
                            node.mesh()
                                .and_then(|m| m.primitives().next())
                                .map(|p| p.morph_targets().len())
                                .unwrap_or(0)
                        ]
                    });
                Node {
                    local: Mat4::from_cols_array_2d(&node.transform().matrix()),
                    translation: Vec3::from(t),
                    rotation: Quat::from_array(r),
                    scale: Vec3::from(s),
                    weights,
                    parent: None,
                }
            })
            .collect();
        for node in document.nodes() {
            for child in node.children() {
                ensure!(
                    nodes[child.index()].parent.replace(node.index()).is_none(),
                    "Node has multiple parents"
                );
            }
        }
        fn visit(
            id: usize,
            nodes: &[Node],
            state: &mut [u8],
            order: &mut Vec<usize>,
            depth: usize,
        ) -> Result<()> {
            ensure!(
                depth < 512 && state[id] != 1,
                "Invalid animation node hierarchy"
            );
            if state[id] == 2 {
                return Ok(());
            }
            state[id] = 1;
            if let Some(parent) = nodes[id].parent {
                visit(parent, nodes, state, order, depth + 1)?;
            }
            state[id] = 2;
            order.push(id);
            Ok(())
        }
        let mut order = Vec::new();
        let mut state = vec![0; nodes.len()];
        for id in 0..nodes.len() {
            visit(id, &nodes, &mut state, &mut order, 0)?;
        }
        let mut clips = Vec::new();
        for animation in document.animations() {
            let mut channels = Vec::new();
            let mut duration = 0f32;
            for channel in animation.channels() {
                let target = channel.target();
                let node = target.node();
                let property = target.property();
                ensure!(
                    !channels
                        .iter()
                        .any(|c: &Channel| c.node == node.index() && c.property == property),
                    "Duplicate animation channel target"
                );
                if property != Property::MorphTargetWeights {
                    ensure!(
                        matches!(node.transform(), gltf::scene::Transform::Decomposed { .. }),
                        "Animated node must use TRS transforms"
                    );
                }
                let reader = channel.reader(|b| Some(&buffers[b.index()]));
                let times: Vec<_> = reader
                    .read_inputs()
                    .context("Animation has no key times")?
                    .collect();
                ensure!(
                    !times.is_empty()
                        && times.iter().all(|t| t.is_finite() && *t >= 0.)
                        && times.windows(2).all(|v| v[0] < v[1]),
                    "Invalid animation key times"
                );
                let values: Vec<f32> = match reader
                    .read_outputs()
                    .context("Animation has no key values")?
                {
                    ReadOutputs::Translations(v) | ReadOutputs::Scales(v) => v.flatten().collect(),
                    ReadOutputs::Rotations(v) => v.into_f32().flatten().collect(),
                    ReadOutputs::MorphTargetWeights(v) => v.into_f32().collect(),
                };
                let width = match property {
                    Property::Translation | Property::Scale => 3,
                    Property::Rotation => 4,
                    Property::MorphTargetWeights => {
                        let mesh = node.mesh().context("Morph animation target has no mesh")?;
                        let count = mesh
                            .primitives()
                            .next()
                            .map(|p| p.morph_targets().len())
                            .unwrap_or(0);
                        ensure!(
                            count > 0
                                && mesh.primitives().all(|p| p.morph_targets().len() == count),
                            "Invalid morph animation target count"
                        );
                        ensure!(
                            nodes[node.index()].weights.len() == count,
                            "Invalid default morph weight count"
                        );
                        count
                    }
                };
                let interpolation = channel.sampler().interpolation();
                let factor = if interpolation == Interpolation::CubicSpline {
                    3
                } else {
                    1
                };
                ensure!(
                    (factor != 3 || times.len() >= 2)
                        && values.len() == times.len() * width * factor
                        && values.iter().all(|v| v.is_finite()),
                    "Invalid animation output values"
                );
                duration = duration.max(*times.last().unwrap());
                let channel = Channel {
                    node: node.index(),
                    property,
                    interpolation,
                    times,
                    values,
                    width,
                };
                if property == Property::Rotation {
                    for key in 0..channel.times.len() {
                        quaternion(channel.value(key))?;
                    }
                }
                channels.push(channel);
            }
            clips.push(Clip {
                name: animation
                    .name()
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("Clip {}", animation.index() + 1)),
                duration,
                channels,
            });
        }
        Ok(Some(Self {
            source: Arc::new(Source {
                nodes,
                order,
                clips,
                meshes: vec![],
                deformations: vec![],
            }),
            offsets: vec![],
            clip: 0,
            time: 0.,
            playing: false,
            speed: 1.,
            looping: true,
            pending: true,
        }))
    }
    pub fn clips(&self) -> &[Clip] {
        &self.source.clips
    }
    pub fn duration(&self) -> f32 {
        self.clips()[self.clip].duration
    }
    pub fn select(&mut self, clip: usize) {
        if clip >= self.clips().len() {
            return;
        }
        self.clip = clip;
        self.time = 0.;
        self.playing = false;
        self.pending = true;
    }
    pub fn seek(&mut self, time: f32) {
        if !time.is_finite() {
            return;
        }
        self.time = time.clamp(0., self.duration());
        self.playing = false;
        self.pending = true;
    }
    pub fn toggle(&mut self) {
        if !self.playing && self.time >= self.duration() {
            self.time = 0.;
            self.pending = true;
        }
        self.playing = !self.playing && self.duration() > 0.;
    }
    pub fn advance(&mut self, dt: f32) {
        if !self.playing {
            return;
        }
        let duration = self.duration();
        let next = self.time + dt.clamp(0., 0.1) * self.speed;
        self.time = if duration <= 0. {
            0.
        } else if self.looping {
            next.rem_euclid(duration)
        } else {
            next.min(duration)
        };
        if duration <= 0. || !self.looping && self.time >= duration {
            self.playing = false;
        }
        self.pending = true;
    }
    pub fn bind_mesh(&mut self, node: usize, instance: Mat4) {
        Arc::get_mut(&mut self.source)
            .unwrap()
            .meshes
            .push(MeshBinding { node, instance });
        self.offsets.push(Mat4::IDENTITY);
    }
    pub fn edit_transform(&mut self, mesh: usize, before: Mat4, after: Mat4) {
        self.offsets[mesh] = after * before.inverse() * self.offsets[mesh];
    }
    pub fn bind_geometry(
        &mut self,
        node: &gltf::Node<'_>,
        primitive: &gltf::Primitive<'_>,
        buffers: &[gltf::buffer::Data],
        geometry: usize,
        base: &Geometry,
    ) -> Result<()> {
        if node.skin().is_none() && primitive.morph_targets().len() == 0 {
            return Ok(());
        }
        let reader = primitive.reader(|b| Some(&buffers[b.index()]));
        let count = base.positions.len() / 3;
        ensure!(
            (base.normals.is_empty() || base.normals.len() == count * 3)
                && (base.tangents.is_empty() || base.tangents.len() == count * 4),
            "Invalid animated vertex attribute count"
        );
        let mut morphs = Vec::new();
        for (positions, normals, tangents) in reader.read_morph_targets() {
            let morph = Morph {
                positions: positions.map(|v| v.collect()).unwrap_or_default(),
                normals: normals.map(|v| v.collect()).unwrap_or_default(),
                tangents: tangents.map(|v| v.collect()).unwrap_or_default(),
            };
            for attribute in [&morph.positions, &morph.normals, &morph.tangents] {
                ensure!(
                    (attribute.is_empty() || attribute.len() == count)
                        && attribute.iter().flatten().all(|v| v.is_finite()),
                    "Invalid morph target attributes"
                );
            }
            morphs.push(morph);
        }
        let skin = if let Some(skin) = node.skin() {
            let joints: Vec<_> = skin.joints().map(|n| n.index()).collect();
            let inverse_bind: Vec<_> = skin
                .reader(|b| Some(&buffers[b.index()]))
                .read_inverse_bind_matrices()
                .map(|v| v.map(|m| Mat4::from_cols_array_2d(&m)).collect())
                .unwrap_or_else(|| vec![Mat4::IDENTITY; joints.len()]);
            ensure!(
                joints.len() == inverse_bind.len() && inverse_bind.iter().all(|m| m.is_finite()),
                "Invalid inverse bind matrices"
            );
            let indices: Vec<_> = reader
                .read_joints(0)
                .context("Skinned mesh has no JOINTS_0")?
                .into_u16()
                .collect();
            let mut weights: Vec<_> = reader
                .read_weights(0)
                .context("Skinned mesh has no WEIGHTS_0")?
                .into_f32()
                .collect();
            ensure!(
                indices.len() == count && weights.len() == count,
                "Invalid skin attribute count"
            );
            ensure!(
                reader.read_joints(1).is_none() && reader.read_weights(1).is_none(),
                "More than four skin influences are unsupported"
            );
            for (ids, weights) in indices.iter().zip(&mut weights) {
                let sum: f32 = weights.iter().sum();
                ensure!(
                    weights.iter().all(|w| w.is_finite() && *w >= 0.)
                        && sum.is_finite()
                        && sum > 0.
                        && ids.iter().all(|id| (*id as usize) < joints.len()),
                    "Invalid skin weights or joints"
                );
                for w in weights {
                    *w /= sum;
                }
            }
            Some(Skin {
                joints,
                inverse_bind,
                indices,
                weights,
            })
        } else {
            None
        };
        Arc::get_mut(&mut self.source)
            .unwrap()
            .deformations
            .push(Deformation {
                node: node.index(),
                geometry,
                base: base.clone(),
                morphs,
                skin,
            });
        Ok(())
    }
    fn apply(&mut self, model: &mut Model) -> Result<bool> {
        if !self.pending {
            return Ok(false);
        }
        let source = &self.source;
        // Start from the rest pose on every evaluation, including clip changes.
        let mut nodes = source.nodes.clone();
        let mut trs = vec![false; nodes.len()];
        for channel in &source.clips[self.clip].channels {
            let value = channel.sample(self.time)?;
            let node = &mut nodes[channel.node];
            match channel.property {
                Property::Translation => node.translation = Vec3::from_slice(&value),
                Property::Rotation => {
                    node.rotation = Quat::from_xyzw(value[0], value[1], value[2], value[3])
                }
                Property::Scale => node.scale = Vec3::from_slice(&value),
                Property::MorphTargetWeights => node.weights = value,
            }
            trs[channel.node] |= channel.property != Property::MorphTargetWeights;
        }
        let mut worlds = vec![Mat4::IDENTITY; nodes.len()];
        for &id in &source.order {
            let node = &nodes[id];
            let local = if trs[id] {
                Mat4::from_scale_rotation_translation(node.scale, node.rotation, node.translation)
            } else {
                node.local
            };
            worlds[id] = node.parent.map(|p| worlds[p]).unwrap_or(Mat4::IDENTITY) * local;
        }
        let transforms: Vec<_> = source
            .meshes
            .iter()
            .zip(&self.offsets)
            .map(|(m, offset)| *offset * worlds[m.node] * m.instance)
            .collect();
        ensure!(
            transforms.len() == model.meshes.len()
                && transforms.iter().all(|m| valid_transform(*m)),
            "Animation produced an invalid or singular mesh transform"
        );
        let mut updates = Vec::new();
        for deformation in &source.deformations {
            let mut geometry = deformation.base.clone();
            for (id, morph) in deformation.morphs.iter().enumerate() {
                let weight = nodes[deformation.node]
                    .weights
                    .get(id)
                    .copied()
                    .unwrap_or(0.);
                if weight == 0. {
                    continue;
                }
                for (attribute, deltas, stride) in [
                    (&mut geometry.positions, &morph.positions, 3),
                    (&mut geometry.normals, &morph.normals, 3),
                    (&mut geometry.tangents, &morph.tangents, 4),
                ] {
                    for (vertex, delta) in deltas.iter().enumerate() {
                        for k in 0..3 {
                            if let Some(v) = Arc::make_mut(attribute).get_mut(vertex * stride + k) {
                                *v += weight * delta[k];
                            }
                        }
                    }
                }
            }
            if let Some(skin) = &deformation.skin {
                ensure!(
                    valid_transform(worlds[deformation.node]),
                    "Animation produced a singular skin transform"
                );
                let inverse = worlds[deformation.node].inverse();
                let joints: Vec<_> = skin
                    .joints
                    .iter()
                    .zip(&skin.inverse_bind)
                    .map(|(id, bind)| inverse * worlds[*id] * *bind)
                    .collect();
                for (vertex, (ids, weights)) in skin.indices.iter().zip(&skin.weights).enumerate() {
                    let mut matrix = Mat4::ZERO;
                    for k in 0..4 {
                        matrix += joints[ids[k] as usize] * weights[k];
                    }
                    let p = matrix.transform_point3(Vec3::from_slice(
                        &geometry.positions[vertex * 3..vertex * 3 + 3],
                    ));
                    Arc::make_mut(&mut geometry.positions)[vertex * 3..vertex * 3 + 3]
                        .copy_from_slice(&p.to_array());
                    for (data, stride) in [(&mut geometry.normals, 3), (&mut geometry.tangents, 4)]
                    {
                        if !data.is_empty() {
                            let n = matrix.transform_vector3(Vec3::from_slice(
                                &data[vertex * stride..vertex * stride + 3],
                            ));
                            Arc::make_mut(data)[vertex * stride..vertex * stride + 3]
                                .copy_from_slice(&n.to_array());
                        }
                    }
                }
            }
            ensure!(
                geometry
                    .positions
                    .iter()
                    .chain(geometry.normals.iter())
                    .chain(geometry.tangents.iter())
                    .all(|v| v.is_finite()),
                "Animation produced non-finite vertices"
            );
            for (data, stride) in [(&mut geometry.normals, 3), (&mut geometry.tangents, 4)] {
                for vertex in Arc::make_mut(data).chunks_exact_mut(stride) {
                    let n = Vec3::from_slice(vertex).normalize_or_zero();
                    vertex[..3].copy_from_slice(&n.to_array());
                }
            }
            let previous = &model.geometries[deformation.geometry];
            if geometry.positions == previous.positions
                && geometry.normals == previous.normals
                && geometry.tangents == previous.tangents
            {
                continue;
            }
            geometry.min = Vec3::splat(f32::INFINITY);
            geometry.max = Vec3::splat(f32::NEG_INFINITY);
            for p in geometry.positions.chunks_exact(3) {
                let p = Vec3::from_slice(p);
                geometry.min = geometry.min.min(p);
                geometry.max = geometry.max.max(p);
            }
            updates.push((deformation.geometry, geometry));
        }
        // Publish only after the whole pose is valid.
        let changed = !updates.is_empty()
            || model
                .meshes
                .iter()
                .zip(&transforms)
                .any(|(m, t)| m.transform != *t);
        if !updates.is_empty() {
            let geometries = Arc::make_mut(&mut model.geometries);
            for (id, geometry) in updates {
                geometries[id] = geometry;
            }
        }
        for (mesh, transform) in model.meshes.iter_mut().zip(transforms) {
            mesh.transform = transform;
        }
        self.pending = false;
        Ok(changed)
    }
}
impl Model {
    pub fn apply_animation(&mut self) -> Result<bool> {
        let Some(mut animation) = self.animation.take() else {
            return Ok(false);
        };
        let result = animation.apply(self);
        if result.is_err() {
            animation.playing = false;
            animation.pending = false;
        }
        self.animation = Some(animation);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn close(a: Vec3, b: Vec3) {
        assert!((a - b).length() < 1e-5);
    }
    #[test]
    fn interpolation_clamps_steps_slerps_and_scales_cubic_tangents_by_key_interval() {
        let mut channel = Channel {
            node: 0,
            property: Property::Translation,
            interpolation: Interpolation::Step,
            times: vec![1., 3.],
            values: vec![0., 0., 0., 4., 0., 0.],
            width: 3,
        };
        assert_eq!(channel.sample(0.).unwrap(), vec![0., 0., 0.]);
        assert_eq!(channel.sample(2.).unwrap(), vec![0., 0., 0.]);
        assert_eq!(channel.sample(3.).unwrap(), vec![4., 0., 0.]);
        channel.interpolation = Interpolation::Linear;
        assert_eq!(channel.sample(2.).unwrap(), vec![2., 0., 0.]);
        assert_eq!(channel.sample(9.).unwrap(), vec![4., 0., 0.]);
        channel.interpolation = Interpolation::CubicSpline;
        channel.values = vec![
            0., 0., 0., 0., 0., 0., 2., 0., 0., 0., 0., 0., 4., 0., 0., 0., 0., 0.,
        ];
        assert_eq!(channel.sample(2.).unwrap(), vec![2.5, 0., 0.]);
        let end = Quat::from_rotation_z(std::f32::consts::FRAC_PI_2);
        channel = Channel {
            node: 0,
            property: Property::Rotation,
            interpolation: Interpolation::Linear,
            times: vec![0., 1.],
            values: [Quat::IDENTITY.to_array(), (-end).to_array()].concat(),
            width: 4,
        };
        let q = quaternion(&channel.sample(0.5).unwrap()).unwrap();
        close(q * Vec3::X, Vec3::new(0.5f32.sqrt(), 0.5f32.sqrt(), 0.));
        channel.interpolation = Interpolation::CubicSpline;
        channel.values = [
            [0.; 4],
            Quat::IDENTITY.to_array(),
            [0.; 4],
            [0.; 4],
            end.to_array(),
            [0.; 4],
        ]
        .concat();
        let q = quaternion(&channel.sample(0.5).unwrap()).unwrap();
        assert!((q.length() - 1.).abs() < 1e-6);
        close(q * Vec3::X, Vec3::new(0.5f32.sqrt(), 0.5f32.sqrt(), 0.));
    }
}
