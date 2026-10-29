//! glTF-to-descriptor adapter; all renderer preparation stays in the AOT library.
use anyhow::{Result, ensure};
use glam::{Mat4, Vec3};
use mutracer_native_probe::layout::light as light_wire;
#[cfg(test)]
use mutracer_native_probe::layout::{header as h, texture as tex};
use std::{path::Path, sync::Arc};

pub use mutracer_native_probe::scene_api::Geometry;
#[cfg(test)]
pub use mutracer_native_probe::scene_api::MaterialLayers;
pub use mutracer_native_probe::scene_api::viewer_support::Descriptor;
#[cfg(test)]
pub use mutracer_native_probe::scene_api::viewer_support::material_values;
pub use mutracer_native_probe::scene_api::viewer_support::{Material, Mesh, Texture};
#[derive(Clone)]
pub struct Model(
    pub mutracer_native_probe::scene_api::viewer_support::Model,
    pub crate::model_scene::Scene,
);
impl std::ops::Deref for Model {
    type Target = mutracer_native_probe::scene_api::viewer_support::Model;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for Model {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Model {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path)?;
        let mut json = crate::examples::model_json(&bytes)?;
        // The viewer handles punctual lights, including their required extension.
        if let Some(required) = json
            .get_mut("extensionsRequired")
            .and_then(serde_json::Value::as_array_mut)
        {
            required.retain(|e| e != "KHR_lights_punctual");
        }
        let bytes = crate::examples::with_json(&bytes, &json)?;
        let mut model = mutracer_native_probe::scene_api::viewer_support::Model::load_bytes(
            &bytes,
            Some(path),
        )?;
        model
            .warnings
            .retain(|w| !w.ends_with("KHR_lights_punctual"));
        let scene = crate::model_scene::Scene::load(&json, path, &mut model)?;
        Ok(Self(model, scene))
    }

    pub fn spheres() -> Result<Self> {
        let mut model = Self::load(&crate::default_model())?;
        let bytes = include_bytes!("../assets/spheres.bin");
        let mut offset = 16;
        let mut arrays = Vec::new();
        for index in 0..4 {
            let count =
                u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap()) as usize;
            arrays.push(&bytes[offset..offset + count]);
            offset += count;
        }
        let floats = |index: usize| {
            arrays[index]
                .chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                .collect::<Vec<_>>()
        };
        let positions = floats(0);
        let min = positions
            .chunks_exact(3)
            .map(Vec3::from_slice)
            .fold(Vec3::splat(f32::INFINITY), Vec3::min);
        let max = positions
            .chunks_exact(3)
            .map(Vec3::from_slice)
            .fold(Vec3::splat(f32::NEG_INFINITY), Vec3::max);
        model.0.geometries = Arc::new(vec![Geometry {
            positions: positions.into(),
            normals: floats(1).into(),
            uv: [floats(2).into(), Arc::from([])],
            indices: arrays[3]
                .chunks_exact(4)
                .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                .collect(),
            material_indices: Arc::from([]),
            colors: Arc::from([]),
            tangents: Arc::from([]),
            min,
            max,
        }]);
        let entries: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../assets/spheres.json"))?;
        let template = model.0.materials.last().unwrap().clone();
        model.0.textures = Arc::new(vec![]);
        model.0.materials.clear();
        model.0.properties.clear();
        model.0.meshes.clear();
        model.0.animation = None;
        let mut bounds_min = Vec3::splat(f32::INFINITY);
        let mut bounds_max = Vec3::splat(f32::NEG_INFINITY);
        for (index, entry) in entries.iter().enumerate() {
            let mut material = template.clone();
            material.name = entry["name"].as_str().unwrap().into();
            crate::material_presets::apply_values(
                &mut material,
                entry["values"].as_object().unwrap(),
            );
            let mut values = [0.; 16];
            for (i, v) in entry["transform"].as_array().unwrap().iter().enumerate() {
                values[i] = v.as_f64().unwrap() as f32;
            }
            let transform = Mat4::from_cols_array(&values);
            bounds_min = bounds_min.min(transform.transform_point3(min));
            bounds_max = bounds_max.max(transform.transform_point3(max));
            model.0.meshes.push(Mesh {
                name: material.name.clone(),
                material: index,
                geometry: 0,
                transform,
                materials: vec![],
                instances: None,
            });
            model.0.materials.push(material);
            model
                .0
                .properties
                .push(std::collections::BTreeMap::from([(73, [1, 0, 0])]));
        }
        model.0.name = "Material spheres".into();
        model.0.center = (bounds_min + bounds_max) * 0.5;
        model.0.radius = (bounds_max - bounds_min).length() * 0.5;
        model.0.ground_y = bounds_min.y;
        model.0.node_indices = (1..=model.meshes.len()).collect();
        let mut nodes = vec![crate::scene_tree::Node {
            name: model.name.clone(),
            children: (1..=model.meshes.len()).collect(),
            ..Default::default()
        }];
        nodes.extend(
            model
                .meshes
                .iter()
                .enumerate()
                .map(|(i, mesh)| crate::scene_tree::Node {
                    name: mesh.name.clone(),
                    parent: Some(0),
                    meshes: vec![i],
                    ..Default::default()
                }),
        );
        model.1.nodes = Arc::new(nodes);
        model.0.mesh_names = model
            .0
            .meshes
            .iter()
            .map(|mesh| mesh.name.clone())
            .collect();
        model.0.node_names = model.1.nodes.iter().map(|node| node.name.clone()).collect();
        model.rebuild_picking()?;
        Ok(model)
    }
    pub fn guessed_units(&self) -> f32 {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for i in 0..self.meshes.len() {
            let (lo, hi) = self.mesh_bounds(i);
            min = min.min(lo);
            max = max.max(hi);
        }
        let size = (max - min).max_element();
        if !(size > 0.) || size <= 200. {
            1.
        } else if size <= 20_000. {
            0.01
        } else {
            0.001
        }
    }
    pub fn camera_for_load(&self, previous: &crate::renderer::Camera) -> crate::renderer::Camera {
        let mut camera = crate::renderer::Camera::fit(self.center, self.radius);
        camera.fov = previous.fov;
        camera.orthographic = previous.orthographic;
        camera.f_stop = previous.f_stop;
        camera.meters_per_unit = previous.meters_per_unit;
        camera.frame(self.center, self.radius);
        if let Some(preset) = &self.1.preset {
            if let (Some(eye), Some(target)) = (
                crate::model_scene::vector(&preset["camera"]["position"]),
                crate::model_scene::vector(&preset["camera"]["target"]),
            ) {
                let offset = Vec3::new(self.center.x, self.ground_y, self.center.z);
                camera.set_view(eye + offset, target + offset);
                camera.fov = preset["camera"]["fov"].as_f64().unwrap_or(35.) as f32;
                camera.orthographic = false;
            } else if preset["category"] == "research" {
                if let Some(view) = self.1.cameras.first() {
                    view.apply(&mut camera, self.center);
                }
            }
        }
        camera
    }
    pub fn environment_for_load(&self, previous: &Environment) -> Environment {
        let mut environment = previous.clone();
        if self.1.available && self.1.authored {
            environment.studio.enabled = false;
            environment.model_lighting = true;
            environment.image = Some(self.1.environment.clone().unwrap_or_else(|| {
                Arc::new(image::Rgb32FImage::from_pixel(1, 1, image::Rgb([0.; 3])))
            }));
            environment.name = "Scene lighting".into();
            environment.intensity = 1.;
            environment.rotation = 0.;
            environment.ground_shadow = false;
            environment.color = [1.; 3];
        } else if environment.model_lighting {
            environment = Environment::default();
        }
        environment
    }
    fn scene_object(
        &self,
        environment: &Environment,
        light: &KeyLight,
    ) -> mutracer_native_probe::scene_api::Scene {
        use mutracer_native_probe::scene_api::viewer_support as encoder;
        let mut lights = environment
            .studio
            .records(self.center, self.radius, self.ground_y);
        lights.extend(self.1.lights.iter().copied());
        if light.enabled {
            lights.push(light.record());
        }
        let (width, height, pixels) = environment.pixels_shared();
        let env = encoder::Environment {
            enabled: true,
            width,
            height,
            pixels: pixels.into(),
            background: environment.background,
            background_color: if environment.background {
                [0.; 3]
            } else {
                environment.background_color
            },
            background_alpha: if environment.background {
                1.
            } else {
                environment.background_alpha
            },
        };
        let visible: Vec<_> = self
            .meshes
            .iter()
            .enumerate()
            .filter(|(i, _)| !self.1.hidden.contains(i))
            .map(|(_, mesh)| mesh.clone())
            .collect();
        let mut scene = encoder::SceneData {
            properties: &self.properties,
            geometries: &self.geometries,
            materials: &self.materials,
            textures: &self.textures,
            meshes: &visible,
            lights,
            ies: vec![],
        }
        .to_scene(&env)
        .expect("Validated imported scene");
        if environment.ground_shadow {
            use mutracer_native_probe::scene_api::{Geometry, Mesh, OpenPbrMaterial};
            let h = self.radius * 6.;
            let geometry = scene
                .add_geometry(Geometry::new(
                    vec![-h, 0., -h, h, 0., -h, h, 0., h, -h, 0., h],
                    vec![0, 2, 1, 0, 3, 2],
                ))
                .expect("Ground geometry");
            let mut material = OpenPbrMaterial::default();
            material.values.color = [0.2158605; 3];
            material.values.roughness = 1.;
            material.set_uint(51, 1).expect("Shadow catcher property");
            let material = scene.add_material(material).expect("Ground material");
            let mut mesh = Mesh::new(geometry, material);
            mesh.transform =
                Mat4::from_translation(Vec3::new(self.center.x, self.ground_y, self.center.z));
            scene.add_mesh(mesh).expect("Ground mesh");
        }
        let mut ids: Vec<_> = self
            .meshes
            .iter()
            .enumerate()
            .filter(|(i, _)| !self.1.hidden.contains(i))
            .map(|(i, _)| i as u32)
            .collect();
        if environment.ground_shadow {
            ids.push(self.meshes.len() as u32);
        }
        scene
            .set_indexed_aov_ids(&ids)
            .expect("Stable viewer object identities");
        if environment.grounded && environment.background && !environment.studio.enabled {
            let height = environment
                .grounded_height
                .unwrap_or((self.radius * 4.).max(1.6));
            scene
                .set_grounded_background(Some(
                    mutracer_native_probe::scene_api::GroundedBackground {
                        height,
                        radius: environment.grounded_radius.unwrap_or(height * 20.),
                        ground_height: self.ground_y,
                        center: [self.center.x, self.center.z],
                    },
                ))
                .expect("Ground projection");
        }
        scene
    }
    pub fn descriptor(&self, camera: &[u8], size: [u32; 2], environment: &Environment) -> Vec<u8> {
        self.descriptor_with_light(camera, size, environment, &KeyLight::default())
    }
    pub fn descriptor_with_light(
        &self,
        camera: &[u8],
        size: [u32; 2],
        environment: &Environment,
        light: &KeyLight,
    ) -> Vec<u8> {
        self.update_descriptor(&mut None, camera, size, environment, light)
            .to_vec()
    }
    pub fn update_descriptor<'a>(
        &self,
        cached: &'a mut Option<Descriptor>,
        camera: &[u8],
        size: [u32; 2],
        environment: &Environment,
        light: &KeyLight,
    ) -> &'a [u8] {
        self.scene_object(environment, light)
            .update_descriptor(cached, camera, size)
            .expect("Encoding imported scene")
    }
}

#[derive(Clone, PartialEq)]
pub struct KeyLight {
    pub enabled: bool,
    pub color: [f32; 3],
    pub intensity: f32,
    pub azimuth: f32,
    pub elevation: f32,
}
impl Default for KeyLight {
    fn default() -> Self {
        Self {
            enabled: false,
            color: [1., 0.95, 0.85],
            intensity: 2.,
            azimuth: 45.,
            elevation: 60.,
        }
    }
}
impl KeyLight {
    fn record(&self) -> [u32; light_wire::WORDS] {
        let mut words = [0; light_wire::WORDS];
        words[light_wire::TYPE] = 2;
        for (k, value) in self.color.iter().enumerate() {
            words[light_wire::COLOR + k] = value.to_bits();
        }
        words[light_wire::INTENSITY] = self.intensity.to_bits();
        let transform = Mat4::from_rotation_y(self.azimuth.to_radians())
            * Mat4::from_rotation_x(-self.elevation.to_radians());
        for (k, value) in transform.to_cols_array().iter().enumerate() {
            words[light_wire::TRANSFORM + k] = value.to_bits();
        }
        words
    }
}

#[derive(Clone)]
pub struct Environment {
    pub model_lighting: bool,
    pub intensity: f32,
    pub color: [f32; 3],
    pub rotation: f32,
    pub studio: crate::studio::Studio,
    pub background: bool,
    pub grounded: bool,
    pub grounded_height: Option<f32>,
    pub grounded_radius: Option<f32>,
    pub ground_shadow: bool,
    pub background_color: [f32; 3],
    pub background_alpha: f32,
    pub image: Option<Arc<image::Rgb32FImage>>,
    pub name: String,
    pixel_cache: Arc<std::sync::Mutex<Option<(Box<Environment>, Arc<[f32]>)>>>,
}
impl PartialEq for Environment {
    fn eq(&self, other: &Self) -> bool {
        self.model_lighting == other.model_lighting
            && self.intensity == other.intensity
            && self.color == other.color
            && self.rotation == other.rotation
            && self.studio == other.studio
            && self.grounded == other.grounded
            && self.grounded_height == other.grounded_height
            && self.grounded_radius == other.grounded_radius
            && self.ground_shadow == other.ground_shadow
            && self.background == other.background
            && self.background_color == other.background_color
            && self.background_alpha == other.background_alpha
            && self.name == other.name
            && match (&self.image, &other.image) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            }
    }
}
impl Default for Environment {
    fn default() -> Self {
        Self {
            model_lighting: false,
            intensity: 1.,
            color: [1.; 3],
            rotation: 0.,
            studio: crate::studio::Studio::default(),
            background: true,
            grounded: false,
            grounded_height: None,
            grounded_radius: None,
            ground_shadow: true,
            background_color: [0.025, 0.025, 0.03],
            background_alpha: 1.,
            image: None,
            name: "Procedural sky".into(),
            pixel_cache: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}
impl Environment {
    fn pixels_shared(&self) -> (u32, u32, Arc<[f32]>) {
        let mut cache = self.pixel_cache.lock().unwrap();
        if let Some((previous, pixels)) = &*cache {
            if previous.same_pixels(self) {
                let (w, h) = if self.studio.enabled {
                    (64, 32)
                } else {
                    self.image
                        .as_ref()
                        .map(|i| i.dimensions())
                        .unwrap_or((64, 32))
                };
                return (w, h, pixels.clone());
            }
        }
        let (w, h, pixels) = self.pixels();
        let pixels: Arc<[f32]> = pixels.into();
        let mut previous = self.clone();
        previous.pixel_cache = Arc::new(std::sync::Mutex::new(None));
        *cache = Some((Box::new(previous), pixels.clone()));
        (w, h, pixels)
    }
    pub fn load(&mut self, path: &Path) -> Result<()> {
        let mut img = image::ImageReader::open(path)?
            .with_guessed_format()?
            .decode()?
            .into_rgb32f();
        let pixels = img.width() as u64 * img.height() as u64;
        if pixels > 4_194_304 {
            let scale = (4_194_304. / pixels as f64).sqrt();
            img = image::imageops::resize(
                &img,
                (img.width() as f64 * scale).floor().max(1.) as u32,
                (img.height() as f64 * scale).floor().max(1.) as u32,
                image::imageops::FilterType::Triangle,
            );
        }
        ensure!(
            img.pixels()
                .all(|p| p.0.iter().all(|v| v.is_finite() && *v >= 0.)),
            "Environment must be finite and nonnegative"
        );
        self.image = Some(Arc::new(img));
        self.name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into();
        Ok(())
    }
    /// Whether `pixels` would return the same map.
    fn same_pixels(&self, other: &Self) -> bool {
        if self.studio.enabled != other.studio.enabled {
            return false;
        }
        if self.studio.enabled {
            return self.studio.same_ambient(&other.studio);
        }
        self.intensity.to_bits() == other.intensity.to_bits()
            && self.color.map(f32::to_bits) == other.color.map(f32::to_bits)
            && self.rotation.to_bits() == other.rotation.to_bits()
            && match (&self.image, &other.image) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (a, b) => a.is_none() && b.is_none(),
            }
    }
    fn pixels(&self) -> (u32, u32, Vec<f32>) {
        if self.studio.enabled {
            return self.studio.pixels();
        }
        let (width, height) = self
            .image
            .as_ref()
            .map(|i| i.dimensions())
            .unwrap_or((64, 32));
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for y in 0..height {
            for x in 0..width {
                let sx = ((x as f32 + self.rotation / 360. * width as f32).rem_euclid(width as f32))
                    as u32;
                let rgb = if let Some(image) = &self.image {
                    image.get_pixel(sx, y).0
                } else {
                    let bright = if (7..20).contains(&sx) && (6..14).contains(&y) {
                        5.
                    } else {
                        0.
                    };
                    let sky = 0.12 + 0.6 * (1. - y as f32 / height as f32);
                    [sky + bright, sky + bright, sky + bright]
                };
                for (k, c) in rgb.iter().enumerate() {
                    pixels.push(c * self.color[k] * self.intensity);
                }
                pixels.push(1.);
            }
        }
        (width, height, pixels)
    }
}

#[cfg(test)]
mod descriptor_tests {
    use super::*;
    use crate::renderer::Camera;

    struct Scene {
        model: Model,
        camera: Camera,
        environment: Environment,
        light: KeyLight,
        size: [u32; 2],
        descriptor: Option<Descriptor>,
    }
    impl Scene {
        fn new() -> Self {
            let model =
                Model::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"))
                    .unwrap();
            Self {
                camera: Camera::fit(model.0.center, model.0.radius),
                model,
                environment: Environment::default(),
                light: KeyLight {
                    enabled: true,
                    ..KeyLight::default()
                },
                size: [160, 104],
                descriptor: None,
            }
        }
        // Byte equality also checks every payload offset after a layout change.
        fn check(&mut self) -> usize {
            let camera = self.camera.bytes(self.size);
            let expected = self.model.descriptor_with_light(
                &camera,
                self.size,
                &self.environment,
                &self.light,
            );
            let actual = self.model.update_descriptor(
                &mut self.descriptor,
                &camera,
                self.size,
                &self.environment,
                &self.light,
            );
            assert_eq!(actual, expected);
            actual.as_ptr() as usize
        }
    }

    #[test]
    fn texture_sampling_edits_separate_shared_slots_and_pack_wrap_and_repeat() {
        let mut s = Scene::new();
        s.model.0.textures = Arc::new(vec![Texture {
            float_pixels: None,
            storage: 0,
            flip_y: false,
            source: 0,
            width: 1,
            height: 1,
            pixels: vec![200, 80, 30, 255].into(),
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
            wrap: [0; 2],
        }]);
        s.model.0.materials[0].maps = [u32::MAX; 9];
        s.model.0.materials[0].maps[0] = 0;
        s.model.0.materials[0].maps[2] = 0;
        let snapshot = s.model.clone();
        assert!(
            s.model
                .set_texture_sampling(0, 0, [1, 2], [-2., 0.])
                .unwrap()
        );
        let id = s.model.0.materials[0].maps[0] as usize;
        assert_ne!(id, 0);
        assert_eq!(s.model.0.materials[0].maps[2], 0);
        assert_eq!(snapshot.textures[0].wrap, [0; 2]);
        assert_eq!(s.model.0.textures[0].scale, [1.; 2]);
        assert!(Arc::ptr_eq(
            &s.model.0.textures[0].pixels,
            &s.model.0.textures[id].pixels
        ));
        assert!(
            !s.model
                .set_texture_sampling(0, 0, [1, 2], [-2., 0.])
                .unwrap()
        );
        assert!(
            s.model
                .set_texture_sampling(0, 0, [2, 1], [25., -3.])
                .unwrap()
        );
        assert_eq!(s.model.0.textures.len(), 2);
        let camera = s.camera.bytes(s.size);
        let bytes = s
            .model
            .descriptor_with_light(&camera, s.size, &s.environment, &s.light);
        let words: Vec<u32> = bytes
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let record = words[h::TEXTURE_OFFSET] as usize + id * tex::WORDS;
        assert_eq!(words[record + tex::WRAP_S], 2);
        assert_eq!(words[record + tex::WRAP_T], 1);
        assert_eq!(f32::from_bits(words[record + tex::UV_SCALE]), 25.);
        assert_eq!(f32::from_bits(words[record + tex::UV_SCALE + 1]), -3.);
        let allocation = s.check();
        assert!(
            s.model
                .set_texture_sampling(0, 0, [0, 0], [0., -1.])
                .unwrap()
        );
        assert_eq!(s.check(), allocation);
        assert!(s.model.set_texture_sampling(0, 0, [3, 0], [1.; 2]).is_err());
        assert!(
            s.model
                .set_texture_sampling(0, 0, [0; 2], [f32::NAN, 1.])
                .is_err()
        );
    }

    #[test]
    fn editable_records_reuse_storage_and_match_fresh_descriptors() {
        let mut s = Scene::new();
        let allocation = s.check();
        for step in 0..4 {
            s.camera.orbit([0.2, -0.1]);
            s.model.0.meshes[0].transform.w_axis.x += 0.1;
            let m = &mut s.model.0.materials[0];
            m.color = [0.1, 0.2, 0.3];
            m.roughness = 0.2 + step as f32 * 0.1;
            m.metalness = 0.6;
            m.opacity = 0.8;
            m.transmission = 0.3;
            m.ior = 1.7;
            m.emission = [0.3, 0.4, 0.5];
            m.emission_strength = 2.;
            m.maps = [u32::MAX; 9];
            m.alpha_mode = step % 3;
            m.alpha_cutoff = 0.4;
            m.double_sided = step % 2 == 0;
            m.normal_scale = 0.5;
            m.unlit = step % 2 != 0;
            m.layers = MaterialLayers {
                diffuse_roughness: 0.2,
                specular_weight: 0.8,
                anisotropy: 0.3,
                transmission_color: [0.3, 0.8, 0.5],
                transmission_depth: 0.2,
                dispersion: 0.1,
                thin_walled: step % 2 == 0,
                coat_weight: 0.4,
                coat_roughness: 0.1,
                coat_ior: 1.7,
                coat_color: [0.9, 0.8, 0.7],
                subsurface_weight: 0.2,
                subsurface_color: [0.9, 0.5, 0.3],
                subsurface_radius: 0.1,
                fuzz_weight: 0.3,
                fuzz_color: [0.8, 0.7, 0.6],
                fuzz_roughness: 0.6,
                film_weight: 0.5,
                film_thickness: 0.4,
                film_ior: 1.6,
                bevel: 0.01,
                specular_color: [0.3, 0.7, 0.9],
                subsurface_radius_scale: [1., 0.6, 0.2],
                displacement_scale: 0.02,
                displacement_bias: -0.01,
                displacement_step: 0.,
                displacement_projection: 1,
                displacement_projection_scale: 2.,
            };
            s.light.color = [0.3, 0.5, 0.8];
            s.light.intensity += 0.2;
            s.light.azimuth += 12.;
            s.light.elevation -= 3.;
            s.environment.background = step % 2 == 0;
            s.environment.background_color = [step as f32 * 0.1, 0.1, 0.3];
            s.environment.background_alpha = if step % 2 == 0 { 1. } else { 0. };
            assert_eq!(s.check(), allocation);
            // Snapshot moved to and back from a worker still owns the same buffer.
            let cached = s.descriptor.take();
            s.descriptor = std::thread::spawn(move || cached).join().unwrap();
            assert_eq!(s.check(), allocation);
        }
        s.model.0.meshes.reverse();
        s.model.0.materials.reverse();
        assert_eq!(s.check(), allocation);
    }

    #[test]
    fn environment_edits_replace_only_pixels_until_dimensions_change() {
        let mut s = Scene::new();
        let allocation = s.check();
        for step in 0..4 {
            s.environment.rotation = step as f32 * 47.;
            s.environment.intensity = step as f32 * 0.4;
            s.environment.color = [0.2, 0.6, 0.9];
            assert_eq!(s.check(), allocation);
        }
        s.environment.intensity = -0.;
        s.check();
        s.environment.intensity = 0.;
        assert_eq!(s.check(), allocation);
        s.environment.image = Some(Arc::new(image::Rgb32FImage::from_pixel(
            64,
            32,
            image::Rgb([2., 1., 0.5]),
        )));
        assert_eq!(s.check(), allocation);
        s.environment.intensity = 1.;
        s.check();
        Arc::make_mut(s.environment.image.as_mut().unwrap()).put_pixel(
            0,
            0,
            image::Rgb([4., 3., 2.]),
        );
        assert_eq!(s.check(), allocation);
        s.environment.image = Some(Arc::new(image::Rgb32FImage::new(8, 4)));
        assert_ne!(s.check(), allocation);
        s.environment.image = None;
        s.check();
    }

    #[test]
    fn structural_changes_and_rejected_values_do_not_leave_stale_payloads() {
        let mut s = Scene::new();
        s.check();
        s.model.0.materials[0].roughness = f32::NAN;
        s.check();
        s.model.0.materials[0].roughness = 0.4;
        s.check();
        // Shared source arrays use copy-on-write; the stable-size descriptor patches in place.
        let allocation = s.check();
        Arc::make_mut(&mut Arc::make_mut(&mut s.model.0.geometries)[0].positions)[0] += 0.5;
        assert_eq!(s.check(), allocation);
        let allocation = s.check();
        let textures = Arc::make_mut(&mut s.model.0.textures);
        textures.push(Texture {
            float_pixels: None,
            storage: 0,
            flip_y: false,
            source: 0,
            width: 1,
            height: 1,
            pixels: vec![128, 64, 32, 255].into(),
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
            wrap: [0; 2],
        });
        assert_ne!(s.check(), allocation);
        let allocation = s.check();
        Arc::make_mut(
            &mut Arc::make_mut(&mut s.model.0.textures)
                .last_mut()
                .unwrap()
                .pixels,
        )[0] = 255;
        assert_eq!(s.check(), allocation);
        let allocation = s.check();
        s.model.0.meshes.push(s.model.0.meshes[0].clone());
        s.model.0.materials.push(s.model.0.materials[0].clone());
        assert_ne!(s.check(), allocation);
        s.model.0.meshes.pop();
        s.model.0.materials.pop();
        s.check();
        let allocation = s.check();
        s.light.enabled = false;
        assert_ne!(s.check(), allocation);
        s.light.enabled = true;
        s.check();
        let allocation = s.check();
        s.size = [320, 208];
        assert_eq!(s.check(), allocation);
        // A new model with matching counts must not inherit old geometry/textures.
        let allocation = s.check();
        let other = Scene::new();
        s.model = other.model;
        assert_ne!(s.check(), allocation);
    }
}

#[test]
fn scene_api_matches_saved_legacy_viewer_encoding() {
    if let Ok(path) = std::env::var("MT_SCENE_BASELINE") {
        let model =
            Model::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb")).unwrap();
        let camera = crate::renderer::Camera::fit(model.0.center, model.0.radius);
        assert_eq!(
            model.descriptor(
                &camera.bytes([160, 104]),
                [160, 104],
                &Environment::default()
            ),
            std::fs::read(Path::new(&path).join("viewer-scene.bin")).unwrap()
        );
    }
}

#[cfg(test)]
mod example_tests {
    #[test]
    fn procedural_example_uses_the_browser_geometry_and_layers() {
        let model = super::Model::spheres().unwrap();
        assert_eq!(model.meshes.len(), 7);
        assert_eq!(model.1.nodes[0].name, "Material spheres");
        assert_eq!(model.1.nodes[0].children, (1..=7).collect::<Vec<_>>());
        for (mesh, &node) in model.node_indices.iter().enumerate() {
            assert_eq!(model.1.nodes[node].parent, Some(0));
            assert_eq!(model.1.nodes[node].meshes, [mesh]);
            assert_eq!(model.node_names[node], model.mesh_names[mesh]);
        }
        assert_eq!(model.geometries[0].positions.len(), 97 * 49 * 3);
        assert_eq!(model.geometries[0].indices.len() / 3, 9024);
        assert!(model.textures.is_empty());
        assert!((model.materials[2].transmission - 1.).abs() < 1e-6);
        assert!(!model.materials[2].layers.thin_walled);
        assert!((model.materials[6].layers.subsurface_weight - 1.).abs() < 1e-6);
        assert!(model.radius.is_finite() && model.radius > 0.);
    }
}
