//! CPU scene snapshots; geometry BVHs are shared between instances.
use super::*;
use crate::picking::PickBvh;
use glam::{DMat4, DVec3};

/// World-space ray. Direction need not be normalized; distances use scene units.
#[derive(Clone, Copy, Debug)]
pub struct Ray {
    /// Finite world-space origin. Default `[0, 0, 0]`.
    pub origin: [f32; 3],
    /// Finite nonzero direction. Default `[0, 0, -1]`.
    pub direction: [f32; 3],
}
impl Default for Ray {
    fn default() -> Self {
        Self {
            origin: [0.; 3],
            direction: [0., 0., -1.],
        }
    }
}
/// Accepted world-distance interval: inclusive minimum, exclusive maximum.
#[derive(Clone, Copy, Debug)]
pub struct RaycastOptions {
    /// Finite nonnegative minimum, inclusive. Default 0.
    pub min_distance: f32,
    /// Finite maximum greater than the minimum, at most 1e30. Default 1e30.
    pub max_distance: f32,
}
impl Default for RaycastOptions {
    fn default() -> Self {
        Self {
            min_distance: 0.,
            max_distance: 1e30,
        }
    }
}
/// Closest geometric triangle hit in the picker's immutable scene snapshot.
#[derive(Clone, Copy, Debug)]
pub struct RaycastHit {
    /// Mesh handle from the source scene at snapshot creation.
    pub mesh: MeshId,
    /// Geometry handle from the source scene at snapshot creation.
    pub geometry: GeometryId,
    /// Material selected by the triangle's first vertex and the mesh table.
    pub material: MaterialId,
    /// Zero-based local instance index; `None` for an ordinary mesh.
    pub instance: Option<u32>,
    /// Zero-based triangle index in the original geometry index array.
    pub primitive: u32,
    /// World-space distance from the original ray origin.
    pub distance: f32,
    /// World-space hit position.
    pub position: [f32; 3],
    /// Unit world-space geometric normal, following transformed triangle winding.
    pub normal: [f32; 3],
    /// Weights of the triangle's three vertices, in index-array order.
    pub barycentric: [f32; 3],
}
struct PickGeometry {
    data: Geometry,
    bvh: PickBvh,
    bounds: Bounds,
}
struct Object {
    mesh: MeshId,
    geometry: GeometryId,
    material: MaterialId,
    materials: Arc<[MaterialId]>,
    instance: Option<u32>,
    world: DMat4,
    inverse: DMat4,
    bounds: Bounds,
}
#[derive(Clone, Copy)]
struct Bounds {
    min: DVec3,
    max: DVec3,
}
impl Bounds {
    fn empty() -> Self {
        Self {
            min: DVec3::splat(f64::INFINITY),
            max: DVec3::splat(f64::NEG_INFINITY),
        }
    }
    fn point(&mut self, p: DVec3) {
        self.min = self.min.min(p);
        self.max = self.max.max(p);
    }
    fn union(mut self, b: Self) -> Self {
        self.point(b.min);
        self.point(b.max);
        self
    }
    fn near(self, o: DVec3, d: DVec3, max: f64) -> Option<f64> {
        let mut lo = 0f64;
        let mut hi = max;
        for i in 0..3 {
            if d[i] == 0. {
                if o[i] < self.min[i] || o[i] > self.max[i] {
                    return None;
                }
            } else {
                let a = (self.min[i] - o[i]) / d[i];
                let b = (self.max[i] - o[i]) / d[i];
                lo = lo.max(a.min(b));
                hi = hi.min(a.max(b));
                if lo > hi {
                    return None;
                }
            }
        }
        Some(lo)
    }
}
struct Node {
    bounds: Bounds,
    children: Option<(usize, usize)>,
    start: usize,
    count: usize,
}
/// Immutable, thread-safe CPU picking snapshot, independent of Engine/GPU and
/// the source scene's lifetime. Construction and memory costs depend on triangle
/// and instance counts. Rebuild after scene edits.
/// Queries hit both faces of original triangles, ignoring alpha, displacement,
/// bevel and material shading. Handles describe the snapshot; removing source
/// resources can make them invalid in the current scene.
pub struct ScenePicker {
    geometries: BTreeMap<GeometryId, PickGeometry>,
    objects: Vec<Object>,
    nodes: Vec<Node>,
}
impl Scene {
    /// Builds an independent picking snapshot of all meshes and instances.
    /// Empty scenes are allowed. Invalid references return `InvalidHandle`;
    /// malformed triangles, material indices or noninvertible/nonaffine transforms
    /// return `InvalidArgument`. Does not prepare or submit GPU work.
    pub fn picker(&self) -> Result<ScenePicker> {
        ScenePicker::new(self)
    }
}
impl ScenePicker {
    fn new(scene: &Scene) -> Result<Self> {
        let mut out = Self {
            geometries: BTreeMap::new(),
            objects: vec![],
            nodes: vec![],
        };
        for (key, mesh) in scene.meshes.iter() {
            mesh.validate_references(scene)?;
            if !mesh.visible {
                continue;
            }
            let geometry = mesh.geometry;
            if let std::collections::btree_map::Entry::Vacant(entry) =
                out.geometries.entry(geometry)
            {
                let data = scene.geometry(geometry)?.clone();
                let bvh = PickBvh::new(&data.positions, &data.indices).map_err(|e| invalid(&e))?;
                if !data.material_indices.is_empty()
                    && data.material_indices.len() != data.positions.len() / 3
                {
                    return Err(invalid("Invalid per-vertex material indices"));
                }
                let mut bounds = Bounds::empty();
                for p in data.positions.chunks_exact(3) {
                    bounds.point(Vec3::from_slice(p).as_dvec3());
                }
                entry.insert(PickGeometry { data, bvh, bounds });
            }
            let g = &out.geometries[&geometry];
            if !mesh.materials.is_empty() {
                for triangle in g.data.indices.chunks_exact(3) {
                    let index = g
                        .data
                        .material_indices
                        .get(triangle[0] as usize)
                        .copied()
                        .unwrap_or(0);
                    if index as usize >= mesh.materials.len() {
                        return Err(invalid("Triangle material index exceeds mesh table"));
                    }
                }
            }
            let transforms: Vec<_> = match &mesh.instances {
                Some(instances) => instances
                    .transforms
                    .iter()
                    .enumerate()
                    .map(|(i, t)| (Some(i as u32), mesh.transform.as_dmat4() * t.as_dmat4()))
                    .collect(),
                None => vec![(None, mesh.transform.as_dmat4())],
            };
            let materials: Arc<[MaterialId]> = mesh.materials.clone().into();
            for (instance, world) in transforms {
                let cols = world.to_cols_array();
                if !world.is_finite()
                    || cols[3] != 0.
                    || cols[7] != 0.
                    || cols[11] != 0.
                    || cols[15] != 1.
                    || world.determinant() == 0.
                {
                    return Err(invalid(
                        "Picking requires finite, invertible affine transforms",
                    ));
                }
                let inverse = world.inverse();
                if !inverse.is_finite() {
                    return Err(invalid("Picking transform inverse is not finite"));
                }
                let mut bounds = Bounds::empty();
                for mask in 0..8 {
                    let p = DVec3::new(
                        if mask & 1 == 0 {
                            g.bounds.min.x
                        } else {
                            g.bounds.max.x
                        },
                        if mask & 2 == 0 {
                            g.bounds.min.y
                        } else {
                            g.bounds.max.y
                        },
                        if mask & 4 == 0 {
                            g.bounds.min.z
                        } else {
                            g.bounds.max.z
                        },
                    );
                    bounds.point(world.transform_point3(p));
                }
                if !bounds.min.is_finite() || !bounds.max.is_finite() {
                    return Err(invalid("Picking world bounds overflow"));
                }
                out.objects.push(Object {
                    mesh: MeshId(key),
                    geometry,
                    material: mesh.material,
                    materials: materials.clone(),
                    instance,
                    world,
                    inverse,
                    bounds,
                });
            }
        }
        if !out.objects.is_empty() {
            Self::build(&mut out.nodes, &mut out.objects, 0);
        }
        Ok(out)
    }
    fn build(nodes: &mut Vec<Node>, objects: &mut [Object], start: usize) -> usize {
        let bounds = objects
            .iter()
            .fold(Bounds::empty(), |b, o| b.union(o.bounds));
        let id = nodes.len();
        nodes.push(Node {
            bounds,
            children: None,
            start,
            count: objects.len(),
        });
        if objects.len() > 4 {
            let size = bounds.max - bounds.min;
            let axis = if size.x >= size.y && size.x >= size.z {
                0
            } else if size.y >= size.z {
                1
            } else {
                2
            };
            let mid = objects.len() / 2;
            objects.select_nth_unstable_by(mid, |a, b| {
                ((a.bounds.min[axis] + a.bounds.max[axis]) * 0.5)
                    .total_cmp(&((b.bounds.min[axis] + b.bounds.max[axis]) * 0.5))
            });
            let (left, right) = objects.split_at_mut(mid);
            let a = Self::build(nodes, left, start);
            let b = Self::build(nodes, right, start + mid);
            nodes[id].children = Some((a, b));
        }
        id
    }
    /// Returns the closest hit, or `None` on a miss. Invalid rays or distance
    /// intervals return `InvalidArgument`. Equal-distance ties are unspecified.
    /// Direction is normalized internally; instance scaling preserves world distance.
    pub fn raycast(&self, ray: Ray, options: RaycastOptions) -> Result<Option<RaycastHit>> {
        let origin = Vec3::from_array(ray.origin).as_dvec3();
        let direction = Vec3::from_array(ray.direction).as_dvec3();
        if !origin.is_finite()
            || !direction.is_finite()
            || direction.length_squared() == 0.
            || !options.min_distance.is_finite()
            || !options.max_distance.is_finite()
            || options.min_distance < 0.
            || options.max_distance <= options.min_distance
            || options.max_distance > 1e30
        {
            return Err(invalid("Invalid picking ray or distance interval"));
        }
        let direction = direction.normalize();
        let shifted = origin + direction * options.min_distance as f64;
        let mut nearest = (options.max_distance as f64 - options.min_distance as f64) as f32;
        let mut hit = None;
        if self.nodes.is_empty() {
            return Ok(None);
        }
        let mut stack = vec![0usize];
        while let Some(index) = stack.pop() {
            let node = &self.nodes[index];
            if node
                .bounds
                .near(shifted, direction, nearest as f64)
                .is_none()
            {
                continue;
            }
            if let Some((a, b)) = node.children {
                let na = self.nodes[a]
                    .bounds
                    .near(shifted, direction, nearest as f64);
                let nb = self.nodes[b]
                    .bounds
                    .near(shifted, direction, nearest as f64);
                match (na, nb) {
                    (Some(da), Some(db)) => {
                        if da < db {
                            stack.push(b);
                            stack.push(a);
                        } else {
                            stack.push(a);
                            stack.push(b);
                        }
                    }
                    (Some(_), None) => stack.push(a),
                    (None, Some(_)) => stack.push(b),
                    _ => {}
                }
                continue;
            }
            for object in &self.objects[node.start..node.start + node.count] {
                if object
                    .bounds
                    .near(shifted, direction, nearest as f64)
                    .is_none()
                {
                    continue;
                }
                let o = object
                    .inverse
                    .transform_point3(shifted)
                    .as_vec3()
                    .to_array();
                let d = object
                    .inverse
                    .transform_vector3(direction)
                    .as_vec3()
                    .to_array();
                let g = &self.geometries[&object.geometry];
                let Some(h) = g.bvh.intersect_hit(o, d, nearest) else {
                    continue;
                };
                let triangle =
                    &g.data.indices[h.primitive as usize * 3..h.primitive as usize * 3 + 3];
                let p = |i: u32| {
                    let i = i as usize * 3;
                    Vec3::from_slice(&g.data.positions[i..i + 3]).as_dvec3()
                };
                let a = p(triangle[0]);
                // Transform edges, avoiding cancellation at large world translations.
                let b = object.world.transform_vector3(p(triangle[1]) - a);
                let c = object.world.transform_vector3(p(triangle[2]) - a);
                let normal = b.cross(c);
                let scale = normal.abs().max_element();
                if scale == 0. || !scale.is_finite() {
                    continue;
                }
                let normal = (normal / scale).normalize();
                nearest = h.distance;
                let distance = options.min_distance as f64 + h.distance as f64;
                let material = if object.materials.is_empty() {
                    object.material
                } else {
                    object.materials[g
                        .data
                        .material_indices
                        .get(triangle[0] as usize)
                        .copied()
                        .unwrap_or(0) as usize]
                };
                hit = Some(RaycastHit {
                    mesh: object.mesh,
                    geometry: object.geometry,
                    material,
                    instance: object.instance,
                    primitive: h.primitive,
                    distance: distance as f32,
                    position: (origin + direction * distance).as_vec3().to_array(),
                    normal: normal.as_vec3().to_array(),
                    barycentric: [1. - h.u - h.v, h.u, h.v],
                });
            }
        }
        Ok(hit)
    }
}

#[cfg(test)]
#[path = "picking_tests.rs"]
mod tests;
