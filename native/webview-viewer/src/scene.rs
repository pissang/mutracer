use anyhow::{Context, Result, ensure};
use glam::Vec3;
use mutracer_native::scene_api::{self as scene, MaterialId, MeshId, OpenPbrMaterial, Scene};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub struct Model {
    pub scene: Scene,
    pub meshes: BTreeMap<String, MeshId>,
    pub materials: BTreeMap<String, MaterialId>,
    pub originals: BTreeMap<String, OpenPbrMaterial>,
    pub values: BTreeMap<String, Value>,
    pub center: Vec3,
    pub radius: f32,
    pub name: String,
}
impl Model {
    pub fn bytes(bytes: &[u8], name: &str) -> Result<Self> {
        Self::import(Scene::import_gltf_bytes(bytes, None)?, name)
    }
    pub fn path(path: &std::path::Path) -> Result<Self> {
        Self::import(
            Scene::import_gltf(path)?,
            &path.file_name().unwrap_or_default().to_string_lossy(),
        )
    }
    fn import(imported: scene::ImportedScene, name: &str) -> Result<Self> {
        let mut scene = imported.scene;
        let mut meshes = BTreeMap::new();
        let mut materials = BTreeMap::new();
        let mut originals = BTreeMap::new();
        let mut values = BTreeMap::new();
        for ids in imported.names.meshes.values() {
            for id in ids {
                meshes.insert(format!("mesh:{}", id.aov_id()), *id);
            }
        }
        for ids in imported.names.materials.values() {
            for id in ids {
                let key = format!("material:{}", id.aov_id());
                let material = scene.material(*id)?.clone();
                values.insert(
                    key.clone(),
                    Value::Object(scene::viewer_support::material_values(&material.values)),
                );
                originals.insert(key.clone(), material);
                materials.insert(key, *id);
            }
        }
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for id in meshes.values() {
            let mesh = scene.mesh(*id)?;
            let geometry = scene.geometry(mesh.geometry)?;
            let transforms = mesh
                .instances
                .as_ref()
                .map(|i| i.transforms.to_vec())
                .unwrap_or_else(|| vec![glam::Mat4::IDENTITY]);
            for transform in transforms {
                for i in 0..8 {
                    let p = Vec3::new(
                        if i & 1 == 0 {
                            geometry.min.x
                        } else {
                            geometry.max.x
                        },
                        if i & 2 == 0 {
                            geometry.min.y
                        } else {
                            geometry.max.y
                        },
                        if i & 4 == 0 {
                            geometry.min.z
                        } else {
                            geometry.max.z
                        },
                    );
                    let world = (mesh.transform * transform).transform_point3(p);
                    min = min.min(world);
                    max = max.max(world);
                }
            }
        }
        ensure!(
            min.is_finite() && max.is_finite(),
            "The model has no finite mesh bounds"
        );
        // Fixed white environment makes the offline sample useful without HDR downloads.
        let mut environment_texture = scene::Texture::rgba8(2, 1, vec![255u8; 8]);
        environment_texture.pixels =
            scene::TexturePixels::Rgba32F(vec![0.6f32, 0.6, 0.6, 1., 0.6, 0.6, 0.6, 1.].into());
        let texture = scene.add_texture(environment_texture)?;
        scene.set_environment(scene::Environment {
            texture: Some(texture),
            color: [0.06, 0.065, 0.075, 1.],
            ..Default::default()
        })?;
        Ok(Self {
            scene,
            meshes,
            materials,
            originals,
            values,
            center: (min + max) * 0.5,
            radius: (max - min).length().max(0.01) * 0.5,
            name: name.into(),
        })
    }
    pub fn material_snapshot(&self, key: &str) -> Result<Value> {
        let id = *self.materials.get(key).context("Unknown material")?;
        let material = self.scene.material(id)?;
        let users = self
            .meshes
            .values()
            .filter(|mesh| {
                self.scene
                    .mesh(**mesh)
                    .is_ok_and(|mesh| mesh.material == id || mesh.materials.contains(&id))
            })
            .count();
        Ok(
            json!({"id":key,"name":material.values.name,"meshName":"Mesh","users":users,"values":self.values[key],"textures":[],"maps":{},"sampling":{},"graph":null,"displacementRange":{"min":0,"max":self.radius*0.1,"step":self.radius*0.001}}),
        )
    }
    pub fn snapshot(&self) -> Result<Value> {
        let mut triangles = 0;
        let mut tree = vec![];
        for (key, id) in &self.meshes {
            let mesh = self.scene.mesh(*id)?;
            let count = self.scene.geometry(mesh.geometry)?.indices.len() / 3;
            triangles += count;
            let ids = if mesh.materials.is_empty() {
                vec![mesh.material]
            } else {
                mesh.materials.clone()
            };
            let materials:Vec<_>=ids.iter().map(|id|{
                let m=self.scene.material(*id).unwrap();json!({"id":format!("material:{}",id.aov_id()),"name":m.values.name,"color":"#999999"})
            }).collect();
            tree.push(json!({"id":key,"name":format!("Mesh {}",id.aov_id()),"kind":"mesh","visible":mesh.visible,"triangles":count,"materials":materials,"children":[]}));
        }
        let materials: Vec<_> = self
            .materials
            .keys()
            .map(|key| self.material_snapshot(key))
            .collect::<Result<_>>()?;
        Ok(
            json!({"name":self.name,"tree":tree,"materials":materials,"radius":self.radius,"triangles":triangles}),
        )
    }
    pub fn edit(&mut self, key: &str, patch: &Value) -> Result<()> {
        let id = *self.materials.get(key).context("Unknown material")?;
        // Validate the entire edit on a clone before publishing any change.
        let mut next = self.scene.material(id)?.clone();
        apply_values(&mut next, patch)?;
        *self.scene.material_mut(id)? = next;
        self.values
            .get_mut(key)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        Ok(())
    }
    pub fn reset(&mut self, key: &str) -> Result<()> {
        let id = *self.materials.get(key).context("Unknown material")?;
        let original = self.originals.get(key).context("Unknown material")?.clone();
        self.values.insert(
            key.into(),
            Value::Object(scene::viewer_support::material_values(&original.values)),
        );
        *self.scene.material_mut(id)? = original;
        Ok(())
    }
}
fn apply_values(material: &mut OpenPbrMaterial, patch: &Value) -> Result<()> {
    let schema: Vec<Value> =
        serde_json::from_str(include_str!("../../schemas/material-properties.json"))?;
    for (key, value) in patch
        .as_object()
        .context("Material values must be an object")?
    {
        let entry = schema
            .iter()
            .find(|p| p["key"] == *key)
            .with_context(|| format!("Unknown material property: {key}"))?;
        ensure!(
            entry["supported"] == true,
            "Unsupported material property: {key}"
        );
        let id = entry["id"].as_u64().unwrap() as u32;
        match entry["type"].as_str().unwrap() {
            "float" => material.set_float(
                id,
                [value.as_f64().context("Expected number")? as f32, 0., 0.],
            )?,
            "color" | "vec2" => {
                let array = value.as_array().context("Expected numeric vector")?;
                let count = if entry["type"] == "vec2" { 2 } else { 3 };
                ensure!(array.len() == count, "Wrong vector length");
                let mut v = [0.; 3];
                for i in 0..count {
                    v[i] = array[i].as_f64().context("Expected vector component")? as f32;
                }
                material.set_float(id, v)?;
            }
            "bool" => {
                material.set_uint(id, u32::from(value.as_bool().context("Expected bool")?))?
            }
            "enum" => {
                let i = entry["values"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|s| s == value)
                    .context("Unknown enum value")?;
                material.set_uint(id, i as u32)?;
            }
            _ => anyhow::bail!("Native prototype does not edit textures: {key}"),
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scalar_color_enum_and_reset_update_the_native_scene() {
        let mut model =
            Model::bytes(include_bytes!("../../viewer/assets/sample.glb"), "sample").unwrap();
        let key = model.materials.keys().next().unwrap().clone();
        let before = model.values[&key].clone();
        model
            .edit(
                &key,
                &json!({"specularRoughness":0.8,"baseColor":[0.1,0.2,0.3],"alphaMode":"blend"}),
            )
            .unwrap();
        let m = model.scene.material(model.materials[&key]).unwrap();
        assert_eq!(m.values.roughness, 0.8);
        assert_eq!(m.values.color, [0.1, 0.2, 0.3]);
        model.reset(&key).unwrap();
        assert_eq!(model.values[&key], before);
    }
    #[test]
    fn invalid_edits_are_transactional() {
        let mut model =
            Model::bytes(include_bytes!("../../viewer/assets/sample.glb"), "sample").unwrap();
        let key = model.materials.keys().next().unwrap().clone();
        let before = model.values[&key].clone();
        assert!(
            model
                .edit(&key, &json!({"baseColor":[0.1,0.2,0.3],"unknown":0.8}))
                .is_err()
        );
        assert_eq!(model.values[&key], before);
        let m = model.scene.material(model.materials[&key]).unwrap();
        assert_ne!(m.values.color, [0.1, 0.2, 0.3]);
    }
}

#[cfg(test)]
mod gpu_tests {
    use super::*;
    use mutracer_native::{api, scene_api::viewer_support as egui};
    // Same indexed importer/descriptor path as the retained egui viewer, with
    // identical camera, light, seed, spp and display settings on both hosts.
    #[test]
    #[ignore = "requires real GPU; set MUTRACER_WEBVIEW_GPU_EVIDENCE"]
    fn native_scene_matches_egui_descriptor_at_fixed_seed_and_spp() -> Result<()> {
        let out = PathBuf::from(
            std::env::var_os("MUTRACER_WEBVIEW_GPU_EVIDENCE").context("Set evidence directory")?,
        );
        std::fs::create_dir_all(&out)?;
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/assets/chess.glb");
        let mut reports = vec![];
        for backend in [api::Backend::Software, api::Backend::Hardware] {
            let model = Model::path(&path)?;
            let reference = egui::Model::load(&path)?;
            let mut orbit = crate::input::Orbit::default();
            orbit.target = model.center;
            orbit.radius = model.radius * 3.;
            let camera = orbit.camera();
            let size = [320, 192];
            let mut cached = None;
            let descriptor = egui::Descriptor::update(
                &mut cached,
                &egui::SceneData {
                    geometries: &reference.geometries,
                    materials: &reference.materials,
                    textures: &reference.textures,
                    properties: &reference.properties,
                    meshes: &reference.meshes,
                    lights: vec![],
                    ies: vec![],
                },
                &camera.to_bytes(),
                size,
                &egui::Environment {
                    enabled: true,
                    width: 2,
                    height: 1,
                    pixels: vec![0.6, 0.6, 0.6, 1., 0.6, 0.6, 0.6, 1.].into(),
                    background: false,
                    background_color: [0.06, 0.065, 0.075],
                    background_alpha: 1.,
                },
            );
            let settings = api::RenderSettings {
                size: api::RenderSize::Fixed {
                    width: size[0],
                    height: size[1],
                },
                max_samples: 16,
                bounces: 6,
                seed: 12345,
                ..Default::default()
            };
            let render = |scene: bool| -> Result<api::Image> {
                let engine = api::Engine::new(api::EngineOptions { backend })?;
                if scene {
                    engine.set_scene_object(&model.scene)?;
                } else {
                    engine.set_scene(descriptor)?;
                }
                engine.set_camera(Some(camera))?;
                engine.display().set_size(size[0], size[1])?;
                engine.update()?;
                let render = api::Render::new(&engine, settings.clone())?;
                render.converge(api::ConvergeOptions::new(16))?;
                ensure!(render.backend()?.0 == backend, "Backend fell back");
                std::fs::write(
                    out.join(format!(
                        "{backend:?}-{}.png",
                        if scene { "webview" } else { "egui-descriptor" }
                    )),
                    engine.display().encode_png(&render)?,
                )?;
                Ok(render.read_pixels(api::PixelKind::Hdr)?)
            };
            let native = render(true)?;
            let reference = render(false)?;
            let mut max = 0f32;
            let mut total = 0f64;
            let mut different = 0usize;
            for (a, b) in native.data.iter().zip(&reference.data) {
                ensure!(a.is_finite() && b.is_finite(), "Non-finite HDR");
                let d = (a - b).abs();
                max = max.max(d);
                total += d as f64;
                different += usize::from(d > 0.);
            }
            reports.push(json!({"backend":format!("{backend:?}"),"width":size[0],"height":size[1],"seed":12345,"spp":16,"maxAbsoluteDifference":max,"meanAbsoluteDifference":total/native.data.len() as f64,"differentComponents":different}));
            // Keep evidence for any difference; reference behavior is the contract.
            std::fs::write(
                out.join("comparison.json"),
                serde_json::to_vec_pretty(&reports)?,
            )?;
            ensure!(max < 0.00001, "Native/egui HDR mismatch: max {max}");
        }
        Ok(())
    }
    use std::path::PathBuf;
}
