use crate::{
    assets::{Assets, Loaded},
    error::{Error, Result},
    shot::{self, Rotation, at},
};
use glam::{Mat4, Vec3};
use mutracer_native::{api, scene_api as sdk};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Copy)]
struct Bounds {
    min: Vec3,
    max: Vec3,
}

impl Bounds {
    fn of(g: &sdk::Geometry) -> Self {
        Self {
            min: g.min,
            max: g.max,
        }
    }
    fn empty() -> Self {
        Self {
            min: Vec3::splat(f32::INFINITY),
            max: Vec3::splat(f32::NEG_INFINITY),
        }
    }
    fn center(self) -> Vec3 {
        self.min * 0.5 + self.max * 0.5
    }
    fn append(&mut self, other: Self) {
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
    }
    fn transformed(self, matrix: Mat4) -> Self {
        let mut bounds = Self::empty();
        for bits in 0..8 {
            let corner = Vec3::from_array(std::array::from_fn(|axis| {
                if bits & (1 << axis) == 0 {
                    self.min[axis]
                } else {
                    self.max[axis]
                }
            }));
            let p = matrix.transform_point3(corner);
            bounds.min = bounds.min.min(p);
            bounds.max = bounds.max.max(p);
        }
        bounds
    }
}

struct Object {
    meshes: Vec<(sdk::MeshId, Mat4)>,
    material: Option<(
        sdk::MaterialId,
        sdk::OpenPbrMaterial,
        Option<crate::materialx::MaterialBindings>,
    )>,
    animation: Option<Animation>,
    bounds: Bounds,
    fit: Mat4,
}

struct Animation {
    model: sdk::viewer_support::Model,
    time: Option<f32>,
}

pub struct Prepared {
    pub scene: sdk::Scene,
    objects: Vec<Object>,
    target_indices: BTreeMap<String, usize>,
    bounds: Vec<Bounds>,
    lights: Vec<(sdk::LightId, LightFrame)>,
    environment: sdk::Environment,
    ambient: Option<sdk::TextureId>,
}

fn validation(pointer: &str, e: api::Error) -> Error {
    Error::validation(
        pointer,
        e.to_string(),
        "Check native scene limits and the input values at this location.",
    )
}

fn look_at(eye: Vec3, target: Vec3, at: &str) -> Result<Mat4> {
    let direction = (target - eye).try_normalize().ok_or_else(|| {
        Error::validation(
            at,
            "Position and target must be distinct finite points",
            "Move the position away from the target.",
        )
    })?;
    let up = if direction.dot(Vec3::Y).abs() > 0.9999 {
        Vec3::X
    } else {
        Vec3::Y
    };
    Ok(Mat4::look_to_rh(eye, direction, up).inverse())
}

impl Prepared {
    pub fn new(shot: &shot::Shot, assets: &mut Assets) -> Result<Self> {
        let mut prepared = Self {
            scene: sdk::Scene::new(),
            objects: vec![],
            target_indices: BTreeMap::new(),
            bounds: vec![],
            lights: vec![],
            environment: sdk::Environment::default(),
            ambient: None,
        };
        let mut images = BTreeMap::new();
        for (i, obj) in shot.objects.iter().enumerate() {
            let p = format!("/objects/{i}");
            let material = match (&obj.material, &obj.asset) {
                (None, Some(_)) => None,
                (description, _) => {
                    let (mut material, bindings) = if let Some(name) =
                        description.as_ref().and_then(|d| d.asset.as_ref())
                    {
                        let pointer = format!("{p}/material/asset");
                        let Some(Loaded::MaterialX(file)) = assets.loaded.get(name) else {
                            return Err(Error::validation(
                                &pointer,
                                format!("Expected a MaterialX document, got {name:?}"),
                                "Use a name from assets with a materialx field.",
                            ));
                        };
                        let file = file.clone();
                        let (material, bindings) =
                            crate::materialx::load(&file, &pointer, assets, &mut prepared.scene)?;
                        (material, Some(bindings))
                    } else {
                        (sdk::OpenPbrMaterial::default(), None)
                    };
                    if let Some(desc) = description {
                        for (&property, (pointer, name)) in &desc.textures {
                            let id = if let Some(&id) = images.get(name) {
                                id
                            } else {
                                let Some(Loaded::Image(texture)) = assets.loaded.get(name) else {
                                    return Err(Error::validation(
                                        pointer,
                                        format!("Expected an image asset, got {name:?}"),
                                        "Use a name from assets with an image field.",
                                    ));
                                };
                                let id = prepared
                                    .scene
                                    .add_texture(texture.clone())
                                    .map_err(|e| validation(pointer, e))?;
                                images.insert(name.clone(), id);
                                id
                            };
                            material
                                .set_texture(property, Some(id))
                                .map_err(|e| validation(pointer, e))?;
                        }
                        if desc.textures.contains_key(&59) {
                            material.values.layers.displacement_scale = 0.1;
                        }
                    }
                    let id = prepared
                        .scene
                        .add_material(material.clone())
                        .map_err(|e| validation(&p, e))?;
                    Some((id, material, bindings))
                }
            };
            let mut animation = None;
            let ids = if let Some(name) = &obj.asset {
                let Some(Loaded::Gltf { scene, model }) = assets.loaded.get(name) else {
                    return Err(Error::validation(
                        format!("{p}/asset"),
                        format!("Expected a glTF asset, got {name:?}"),
                        "Use a name from assets with a gltf field.",
                    ));
                };
                if let Some(clip) = &obj.animation {
                    if obj.instances.is_some() {
                        return Err(Error::validation(
                            format!("{p}/instances"),
                            "A glTF clip and a separate instance sidecar cannot be combined",
                            "Bake the instances or omit the sidecar.",
                        ));
                    }
                    let mut model = (**model).clone();
                    let pointer = format!("{p}/animation/clip");
                    let state = model
                        .animation
                        .as_mut()
                        .ok_or_else(|| Error::asset(&pointer, "The glTF has no animation clips"))?;
                    let mut matches = state
                        .clips()
                        .iter()
                        .enumerate()
                        .filter(|(_, c)| c.name == clip.clip);
                    let index = matches.next().map(|(i, _)| i).ok_or_else(|| {
                        Error::asset(&pointer, format!("No glTF clip named {:?}", clip.clip))
                    })?;
                    if matches.next().is_some() {
                        return Err(Error::asset(&pointer, "The glTF clip name is ambiguous"));
                    }
                    state.select(index);
                    animation = Some(Animation { model, time: None });
                }
                prepared
                    .scene
                    .append_meshes_from(scene)
                    .map_err(|e| validation(&p, e))?
            } else {
                let geometry = match &obj.geometry {
                    Some(data) => assets.geometry(data, &format!("{p}/geometry"))?,
                    None => primitive(obj.shape.unwrap(), obj.size.unwrap_or(1.)),
                };
                let geometry = prepared
                    .scene
                    .add_geometry(geometry)
                    .map_err(|e| validation(&p, e))?;
                vec![
                    prepared
                        .scene
                        .add_mesh(sdk::Mesh::new(geometry, material.as_ref().unwrap().0))
                        .map_err(|e| validation(&p, e))?,
                ]
            };
            if ids.is_empty() {
                return Err(Error::asset(
                    format!("{p}/asset"),
                    "The glTF contains no mesh in its selected scene",
                ));
            }
            let instances = if let Some(name) = &obj.instances {
                let Some(Loaded::Instances(matrices)) = assets.loaded.get(name) else {
                    return Err(Error::validation(
                        format!("{p}/instances"),
                        format!("Expected an instance asset, got {name:?}"),
                        "Use a name from assets with an instances field.",
                    ));
                };
                Some(matrices)
            } else {
                None
            };
            let mut bounds = Bounds::empty();
            let mut meshes = Vec::with_capacity(ids.len());
            for id in ids {
                let existing = prepared.scene.mesh(id).map_err(|e| validation(&p, e))?;
                let g = Bounds::of(
                    prepared
                        .scene
                        .geometry(existing.geometry)
                        .map_err(|e| validation(&p, e))?,
                );
                let original = existing.transform;
                let original_instances = existing.instances.clone();
                let mesh = prepared.scene.mesh_mut(id).map_err(|e| validation(&p, e))?;
                if let Some((material, _, _)) = &material {
                    mesh.material = *material;
                    // Preserve the geometry's per-vertex table shape.
                    mesh.materials.fill(*material);
                }
                let local = if let Some(instances) = instances {
                    let count = instances.len().saturating_mul(
                        original_instances
                            .as_ref()
                            .map_or(1, |batch| batch.transforms.len()),
                    );
                    if count > 16_777_216 {
                        return Err(Error::budget(
                            "Expanded instance count exceeds 16777216 per mesh",
                        ));
                    }
                    let mut transforms = Vec::with_capacity(count);
                    let mut colors = None;
                    if let Some(original_instances) = original_instances {
                        for matrix in instances.iter() {
                            transforms.extend(
                                original_instances
                                    .transforms
                                    .iter()
                                    .map(|m| *matrix * original * *m),
                            );
                        }
                        if let Some(original) = original_instances.colors {
                            colors = Some(original.repeat(instances.len()).into());
                        }
                    } else {
                        transforms.extend(instances.iter().map(|m| *m * original));
                    }
                    mesh.instances = Some(sdk::Instances {
                        transforms: transforms.into(),
                        colors,
                    });
                    Mat4::IDENTITY
                } else {
                    original
                };
                if let Some(batch) = &mesh.instances {
                    for &matrix in batch.transforms.iter() {
                        bounds.append(g.transformed(local * matrix));
                    }
                } else {
                    bounds.append(g.transformed(local));
                }
                meshes.push((id, local));
            }
            let fit = if let Some(fit) = &obj.fit {
                let height = bounds.max.y - bounds.min.y;
                if !height.is_finite() || height <= 0. {
                    return Err(Error::asset(
                        format!("{p}/fit"),
                        "Cannot fit a glTF with zero height",
                    ));
                }
                let center = bounds.center();
                Mat4::from_scale(Vec3::splat(fit.height / height))
                    * Mat4::from_translation(-Vec3::new(center.x, bounds.min.y, center.z))
            } else {
                Mat4::IDENTITY
            };
            prepared.target_indices.insert(obj.name.clone(), i);
            prepared.bounds.push(bounds);
            prepared.objects.push(Object {
                meshes,
                material,
                animation,
                bounds,
                fit,
            });
        }
        if let Some(name) = &shot.environment.map {
            let Some(Loaded::Hdr(texture)) = assets.loaded.get(name) else {
                return Err(Error::validation(
                    "/environment/map",
                    format!("Expected an HDR asset, got {name:?}"),
                    "Use a name from assets with an hdr field.",
                ));
            };
            let id = prepared
                .scene
                .add_texture(texture.clone())
                .map_err(|e| validation("/environment/map", e))?;
            prepared.environment.texture = Some(id);
            if shot.environment.color.is_none() {
                prepared.environment.background = Some(id);
            }
        } else if shot.environment.color.is_some() {
            let initial = at(&shot.environment.color, [0.; 3], 0.);
            let id = prepared
                .scene
                .add_texture(ambient_texture(initial))
                .map_err(|e| validation("/environment/color", e))?;
            prepared.ambient = Some(id);
            prepared.environment.texture = Some(id);
        }
        prepared
            .scene
            .set_environment(prepared.environment.clone())
            .map_err(|e| validation("/environment", e))?;
        prepared.evaluate(shot, 0., shot.output.size)?;
        // Also validates the native descriptor and total geometry/texture limits.
        prepared
            .scene
            .descriptor()
            .map_err(|e| validation("/objects", e))?;
        Ok(prepared)
    }

    fn target(&self, target: &shot::Target, t: f64) -> (Vec3, Option<Bounds>) {
        match target {
            shot::Target::Position(value) => (Vec3::from_array(value.at(t)), None),
            shot::Target::Name(name) => {
                let bounds = self.bounds[self.target_indices[name]];
                (bounds.center(), Some(bounds))
            }
        }
    }

    pub fn evaluate(
        &mut self,
        shot: &shot::Shot,
        t: f64,
        size: [u32; 2],
    ) -> Result<(api::Camera, api::DisplaySettings)> {
        for (i, obj) in self.objects.iter_mut().enumerate() {
            let desc = &shot.objects[i];
            let p = format!("/objects/{i}");
            let position = Vec3::from_array(at(&desc.position, [0.; 3], t));
            let scale = Vec3::from_array(at(&desc.scale, [1.; 3], t));
            let rotation = at(&desc.rotation, Rotation::Euler([0.; 3]), t).quaternion();
            let matrix = Mat4::from_scale_rotation_translation(scale, rotation, position) * obj.fit;
            if !matrix.is_finite() || !matrix.inverse().is_finite() {
                return Err(Error::validation(
                    &p,
                    "The evaluated transform is invalid",
                    "Reduce coordinates and keep scales above zero.",
                ));
            }
            if let Some(animation) = &mut obj.animation {
                let time = desc.animation.as_ref().unwrap().time.at(t);
                if animation.time != Some(time) {
                    animation.model.animation.as_mut().unwrap().seek(time);
                    if animation.model.apply_animation().map_err(|error| {
                        Error::asset(format!("{p}/animation/time"), error.to_string())
                    })? {
                        obj.bounds = Bounds::empty();
                        for ((id, base), source) in
                            obj.meshes.iter_mut().zip(&animation.model.meshes)
                        {
                            *base = source.transform;
                            let mesh = self.scene.mesh(*id).map_err(|e| validation(&p, e))?;
                            let id = mesh.geometry;
                            let positions = &animation.model.geometries[source.geometry];
                            let old = self.scene.geometry(id).map_err(|e| validation(&p, e))?;
                            if !Arc::ptr_eq(&old.positions, &positions.positions)
                                || !Arc::ptr_eq(&old.normals, &positions.normals)
                                || !Arc::ptr_eq(&old.tangents, &positions.tangents)
                            {
                                *self.scene.geometry_mut(id).map_err(|e| validation(&p, e))? =
                                    positions.clone();
                            }
                            let bounds = Bounds::of(positions);
                            if let Some(instances) = &source.instances {
                                for &instance in instances.transforms.iter() {
                                    obj.bounds.append(bounds.transformed(*base * instance));
                                }
                            } else {
                                obj.bounds.append(bounds.transformed(*base));
                            }
                        }
                    }
                    animation.time = Some(time);
                }
            }
            self.bounds[i] = obj.bounds.transformed(matrix);
            for &(id, base) in &obj.meshes {
                let transform = matrix * base;
                if self
                    .scene
                    .mesh(id)
                    .map_err(|e| validation(&p, e))?
                    .transform
                    != transform
                {
                    self.scene
                        .mesh_mut(id)
                        .map_err(|e| validation(&p, e))?
                        .transform = transform;
                }
            }
            if let (Some((id, defaults, bindings)), Some(m)) = (&obj.material, &desc.material) {
                let mut next = defaults.clone();
                m.apply(&mut next, t);
                if let Some(inputs) = &m.inputs {
                    if !inputs.is_empty() {
                        let pointer = format!("{p}/material/inputs");
                        let graph = next.graph.as_mut().ok_or_else(|| {
                            Error::validation(
                                &pointer,
                                "MaterialX surface has no connected interface inputs",
                                "Use inputs declared in a connected MaterialX nodegraph.",
                            )
                        })?;
                        bindings
                            .as_ref()
                            .unwrap()
                            .update(graph, inputs, t, &pointer)?;
                    }
                }
                if self.scene.material(*id).map_err(|e| validation(&p, e))? != &next {
                    *self
                        .scene
                        .material_mut(*id)
                        .map_err(|e| validation(&p, e))? = next;
                }
            }
        }
        let env = &shot.environment;
        let [r, g, b] = at(&env.color, [0.; 3], t);
        if self.environment.color != [r, g, b, 1.] {
            self.environment.color = [r, g, b, 1.];
            if let Some(id) = self.ambient {
                *self
                    .scene
                    .texture_mut(id)
                    .map_err(|e| validation("/environment", e))? = ambient_texture([r, g, b]);
            }
            self.scene
                .set_environment(self.environment.clone())
                .map_err(|e| validation("/environment", e))?;
        }
        let rotation = at(&env.rotation, 0., t).to_radians();
        let intensity = at(&env.intensity, 1., t);
        let options = sdk::EnvironmentSettings {
            rotation,
            intensity,
            background_rotation: rotation,
            background_intensity: intensity,
        };
        if self.scene.environment_settings() != options {
            self.scene
                .set_environment_settings(options)
                .map_err(|e| validation("/environment", e))?;
        }
        for (i, light) in shot.lights.iter().enumerate() {
            let p = format!("/lights/{i}");
            let (target, _) = self.target(&light.target, t);
            let transform = look_at(Vec3::from_array(light.position.at(t)), target, &p)?;
            let frame = LightFrame {
                color: at(&light.color, [1.; 3], t),
                intensity: at(&light.intensity, 1., t),
                transform,
                size: at(&light.size, [1.; 2], t),
                radius: at(&light.radius, 1., t),
                length: at(&light.length, 1., t),
                angle: at(&light.angle, 45., t),
            };
            if let Some((id, old)) = self.lights.get_mut(i) {
                if *old != frame {
                    *self.scene.light_mut(*id).map_err(|e| validation(&p, e))? =
                        frame.light(light.kind);
                    *old = frame;
                }
            } else {
                let id = self
                    .scene
                    .add_light(frame.light(light.kind))
                    .map_err(|e| validation(&p, e))?;
                self.lights.push((id, frame));
            }
        }
        let cam = &shot.camera;
        let fov = at(&cam.fov, 45., t);
        let (target, bounds) = self.target(&cam.target, t);
        let eye = if let Some(orbit) = &cam.orbit {
            let az = at(&orbit.azimuth, 0., t).to_radians();
            let el = at(&orbit.elevation, 0., t).to_radians();
            let (sin_az, cos_az) = az.sin_cos();
            let (sin_el, cos_el) = el.sin_cos();
            let distance = at(&orbit.distance, 1.15, t);
            let metres = bounds.map_or(distance, |bounds| {
                let aspect = size[0] as f32 / size[1] as f32;
                let half_fov = (fov.to_radians() * 0.5).tan() * aspect.min(1.);
                let radius = (bounds.max - bounds.min).length() * 0.5;
                distance * radius / half_fov.atan().sin()
            });
            target + Vec3::new(sin_az * cos_el, sin_el, cos_az * cos_el) * metres
        } else {
            Vec3::from_array(cam.position.as_ref().unwrap().at(t))
        };
        let matrix = look_at(eye, target, "/camera")?;
        let lens = api::Camera::default();
        let focus_distance = match &cam.focus_distance {
            None => lens.focus_distance,
            Some(shot::FocusDistance::Distance(distance)) => distance.at(t),
            Some(shot::FocusDistance::Name(name)) => {
                let center = self.bounds[self.target_indices[name]].center();
                let distance = (center - eye).dot(-matrix.z_axis.truncate());
                if !distance.is_finite() || distance <= 0. {
                    return Err(Error::validation(
                        "/camera/focusDistance",
                        format!(
                            "Focus object {name:?} is outside the forward half-space at {t} seconds"
                        ),
                        "Keep the focus object in front of the camera or use a positive distance.",
                    ));
                }
                distance
            }
        };
        Ok((
            api::Camera {
                fov,
                world_matrix: matrix.to_cols_array(),
                f_stop: at(&cam.f_stop, lens.f_stop, t),
                focus_distance,
                sensor_height: at(&cam.sensor_height, lens.sensor_height, t),
                ..lens
            },
            shot.output.display.at(t),
        ))
    }
}

fn ambient_texture([r, g, b]: [f32; 3]) -> sdk::Texture {
    let mut tex = sdk::Texture::rgba8(2, 2, Vec::new());
    tex.pixels = sdk::TexturePixels::Rgba32F([r, g, b, 1.].repeat(4).into());
    tex
}

#[derive(Clone, Copy, PartialEq)]
struct LightFrame {
    color: [f32; 3],
    intensity: f32,
    transform: Mat4,
    size: [f32; 2],
    radius: f32,
    length: f32,
    angle: f32,
}
impl LightFrame {
    fn light(self, kind: shot::LightKind) -> sdk::Light {
        use sdk::Light::*;
        let Self {
            color,
            intensity,
            transform,
            size: [width, height],
            radius,
            length,
            angle,
        } = self;
        match kind {
            shot::LightKind::Rect => Rect {
                color,
                intensity,
                transform,
                width,
                height,
                spread: 1.,
                texture: None,
            },
            shot::LightKind::Disk => Disk {
                color,
                intensity,
                transform,
                radius,
                normalize: false,
            },
            shot::LightKind::Cylinder => Cylinder {
                color,
                intensity,
                transform,
                radius,
                length,
                normalize: false,
                treat_as_line: false,
            },
            shot::LightKind::Sphere => Sphere {
                color,
                intensity,
                transform,
                radius,
            },
            shot::LightKind::Directional => Directional {
                color,
                intensity,
                transform,
            },
            shot::LightKind::Spot => Spot {
                color,
                intensity,
                transform,
                inner: angle * 0.4,
                outer: angle * 0.5,
                ies: Default::default(),
            },
        }
    }
}

fn primitive(shape: shot::Shape, size: f32) -> sdk::Geometry {
    let a = size * 0.5;
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    let mut normals = Vec::new();
    let mut uvs = Vec::new();
    match shape {
        shot::Shape::Box | shot::Shape::Plane => {
            let plane = matches!(shape, shot::Shape::Plane);
            let faces: &[Vec3] = if plane {
                &[Vec3::Y]
            } else {
                &[
                    Vec3::X,
                    Vec3::NEG_X,
                    Vec3::Y,
                    Vec3::NEG_Y,
                    Vec3::Z,
                    Vec3::NEG_Z,
                ]
            };
            for &n in faces {
                let up = if n.y.abs() > 0.5 { Vec3::Z } else { Vec3::Y };
                let right = up.cross(n);
                let center = if plane { Vec3::ZERO } else { n * a };
                let start = positions.len() as u32 / 3;
                for [x, y] in [[0., 0.], [1., 0.], [1., 1.], [0., 1.]] {
                    let p = center + right * (x * size - a) + up * (y * size - a);
                    positions.extend(p.to_array());
                    normals.extend(n.to_array());
                    uvs.extend([x, y]);
                }
                indices.extend([start, start + 1, start + 2, start, start + 2, start + 3]);
            }
        }
        shot::Shape::Sphere => {
            let (rows, cols) = (24, 48);
            for i in 0..=rows {
                let v = i as f32 / rows as f32;
                let (s, y) = (v * std::f32::consts::PI).sin_cos();
                for j in 0..=cols {
                    let u = j as f32 / cols as f32;
                    let (z, x) = (u * std::f32::consts::TAU).sin_cos();
                    let n = Vec3::new(x * s, y, z * s);
                    normals.extend(n.to_array());
                    positions.extend((a * n).to_array());
                    uvs.extend([u, v]);
                    if i == rows || j == cols {
                        continue;
                    }
                    let k = i * (cols + 1) + j;
                    let next = k + cols + 1;
                    if i != 0 {
                        indices.extend([k, k + 1, next]);
                    }
                    if i != rows - 1 {
                        indices.extend([k + 1, next + 1, next]);
                    }
                }
            }
        }
    }
    let mut geometry = sdk::Geometry::new(positions, indices);
    geometry.normals = normals.into();
    geometry.uv[0] = uvs.into();
    geometry
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn sample(name: &str) -> crate::run::Input {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("examples")
            .join(name);
        crate::run::Input::load(&path).unwrap()
    }

    #[test]
    fn lens_animates_and_follows_the_projected_object_center() {
        let mut input = crate::run::Input::from_bytes(
            br#"{
            "version": 1, "output": {"duration": 1},
            "camera": {"position": [0,0,5], "target": [0,0,0],
                "fStop": {"keys": [[0,2],[1,4]]}, "focusDistance": "ball", "sensorHeight": 30},
            "objects": [{"name":"ball","shape":"sphere",
                "position":{"keys":[[0,[2,0,1]],[1,[2,0,3]]]}}]
        }"#,
            Path::new("."),
        )
        .unwrap();
        let (start, _) = input.prepared.evaluate(&input.shot, 0., [16, 16]).unwrap();
        let (end, _) = input.prepared.evaluate(&input.shot, 0.5, [16, 16]).unwrap();
        assert_eq!(
            [start.f_stop, start.focus_distance, start.sensor_height],
            [2., 4., 30.]
        );
        assert_eq!(
            [end.f_stop, end.focus_distance, end.sensor_height],
            [3., 3., 30.]
        );
    }

    #[test]
    fn materialx_fixture_animates_a_connected_parameter() {
        let mut input = sample("materialx-growth.json");
        let id = input.prepared.objects[0].material.as_ref().unwrap().0;
        let graph = input
            .prepared
            .scene
            .material(id)
            .unwrap()
            .graph
            .clone()
            .unwrap();
        input
            .prepared
            .evaluate(&input.shot, 1., [1280, 720])
            .unwrap();
        let after = input
            .prepared
            .scene
            .material(id)
            .unwrap()
            .graph
            .as_ref()
            .unwrap();
        assert_eq!(graph.nodes, after.nodes);
        assert_eq!(graph.terminals, after.terminals);
        let changed = graph
            .parameters
            .iter()
            .zip(&after.parameters)
            .filter(|(a, b)| a != b)
            .collect::<Vec<_>>();
        assert_eq!(changed, vec![(&[0., 0., 0., 0.], &[1., 0., 0., 0.])]);
        sdk::Scene::validate_descriptor(&input.prepared.scene.descriptor().unwrap()).unwrap();
    }

    #[test]
    fn native_gltf_clip_updates_transforms_and_can_revisit_time() {
        let mut input = sample("gltf-animation.json");
        let id = input.prepared.objects[0].meshes[0].0;
        let initial = input.prepared.scene.mesh(id).unwrap().transform;
        input
            .prepared
            .evaluate(&input.shot, 1., [1280, 720])
            .unwrap();
        assert_ne!(input.prepared.scene.mesh(id).unwrap().transform, initial);
        input
            .prepared
            .evaluate(&input.shot, 0., [1280, 720])
            .unwrap();
        assert_eq!(input.prepared.scene.mesh(id).unwrap().transform, initial);
    }
}
