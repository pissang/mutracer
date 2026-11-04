//! Adapter for importers and applications that already have indexed scene arrays.
use super::*;
/// Reusable descriptor buffer. Dimensions and quality belong to its consumer,
/// not to the Scene. Bytes remain valid until the next update.
#[cfg(feature = "viewer-support")]
pub struct Descriptor {
    words: Vec<u32>,
    geometries: Vec<Geometry>,
    textures: Vec<encoder::Texture>,
}
#[cfg(feature = "viewer-support")]
impl Descriptor {
    pub fn bytes(&self) -> &[u8] {
        #[cfg(target_endian = "little")]
        unsafe {
            std::slice::from_raw_parts(self.words.as_ptr().cast(), self.words.len() * 4)
        }
        #[cfg(not(target_endian = "little"))]
        compile_error!("Native descriptors require little-endian");
    }
    pub fn update<'a>(
        cached: &'a mut Option<Self>,
        data: &encoder::SceneData<'_>,
        camera: &[u8],
        size: [u32; 2],
        environment: &encoder::Environment,
    ) -> &'a [u8] {
        let patched = cached.as_mut().is_some_and(|d| {
            data.patch_selected(
                &mut d.words,
                camera,
                size,
                environment,
                Some((&d.geometries, &d.textures)),
            )
        });
        if !patched {
            *cached = Some(Self {
                words: data.encode(camera, size, environment),
                geometries: vec![],
                textures: vec![],
            });
        }
        let d = cached.as_mut().unwrap();
        d.geometries = data.geometries.to_vec();
        d.textures = data.textures.to_vec();
        d.bytes()
    }
}
impl Scene {
    /// Builds a scene from decoded indexed records, resolving all references to
    /// checked handles. Large vertex/image arrays remain shared.
    #[doc(hidden)]
    pub(crate) fn from_indexed(
        data: &encoder::SceneData<'_>,
        environment: &encoder::Environment,
    ) -> Result<Self> {
        let mut scene = Scene::new();
        let mut textures = Vec::new();
        for t in data.textures {
            let pixels = if let Some(p) = &t.float_pixels {
                TexturePixels::Rgba32F(p.clone())
            } else {
                TexturePixels::Rgba8(t.pixels.clone())
            };
            textures.push(scene.add_texture(Texture {
                pixels,
                width: t.width,
                height: t.height,
                uv: t.uv,
                scale: t.scale,
                offset: t.offset,
                wrap: t.wrap,
                flip_y: t.flip_y,
            })?);
        }
        let mut materials = Vec::new();
        for (i, m) in data.materials.iter().enumerate() {
            let mut maps = [None; 9];
            for (slot, id) in m.maps.iter().enumerate() {
                if *id != u32::MAX {
                    maps[slot] = Some(*textures.get(*id as usize).ok_or_else(invalid_handle)?);
                }
            }
            let mut material = OpenPbrMaterial {
                values: m.clone(),
                textures: maps,
                properties: BTreeMap::new(),
                texture_properties: BTreeMap::new(),
            };
            for (&id, &value) in data.properties.get(i).into_iter().flatten() {
                if crate::material_properties::MATERIAL_PROPERTIES
                    .get(id as usize)
                    .is_some_and(|p| p.0 == 5)
                {
                    material.set_texture(
                        id,
                        if value[0] == u32::MAX {
                            None
                        } else {
                            Some(*textures.get(value[0] as usize).ok_or_else(invalid_handle)?)
                        },
                    )?;
                } else {
                    material.properties.insert(id, value);
                }
            }
            materials.push(scene.add_material(material)?);
        }
        let mut geometries = Vec::new();
        for g in data.geometries {
            geometries.push(scene.add_geometry(g.clone())?);
        }
        for m in data.meshes {
            let mut mesh = Mesh::new(
                *geometries.get(m.geometry).ok_or_else(invalid_handle)?,
                *materials.get(m.material).ok_or_else(invalid_handle)?,
            );
            mesh.transform = m.transform;
            mesh.materials = m
                .materials
                .iter()
                .map(|i| materials.get(*i).copied().ok_or_else(invalid_handle))
                .collect::<Result<_>>()?;
            mesh.instances = m.instances.clone();
            scene.add_mesh(mesh)?;
        }
        if environment.enabled {
            let texture = scene.add_texture(Texture {
                pixels: TexturePixels::Rgba32F(environment.pixels.clone()),
                ..Texture::rgba8(environment.width, environment.height, vec![])
            })?;
            scene.set_environment(Environment {
                texture: Some(texture),
                background: environment.background.then_some(texture),
                color: [
                    environment.background_color[0],
                    environment.background_color[1],
                    environment.background_color[2],
                    environment.background_alpha,
                ],
            })?;
        }
        for (i, w) in data.lights.iter().enumerate() {
            let color = [
                f32::from_bits(w[l::COLOR]),
                f32::from_bits(w[l::COLOR + 1]),
                f32::from_bits(w[l::COLOR + 2]),
            ];
            let intensity = f32::from_bits(w[l::INTENSITY]);
            let transform = Mat4::from_cols_array(&std::array::from_fn(|i| {
                f32::from_bits(w[l::TRANSFORM + i])
            }));
            let light = match w[l::TYPE] {
                0 => Light::Rect {
                    color,
                    intensity,
                    width: f32::from_bits(w[l::SIZE]),
                    height: f32::from_bits(w[l::HEIGHT_OR_INNER]),
                    spread: f32::from_bits(w[l::SPREAD_OR_OUTER]),
                    transform,
                    texture: if w[l::TEXTURE] == 0 {
                        None
                    } else {
                        Some(
                            *textures
                                .get(w[l::TEXTURE] as usize - 1)
                                .ok_or_else(invalid_handle)?,
                        )
                    },
                },
                1 => Light::Sphere {
                    color,
                    intensity,
                    radius: f32::from_bits(w[l::SIZE]),
                    transform,
                },
                2 => Light::Directional {
                    color,
                    intensity,
                    transform,
                },
                3 => Light::Spot {
                    color,
                    intensity,
                    inner: f32::from_bits(w[l::HEIGHT_OR_INNER]),
                    outer: f32::from_bits(w[l::SPREAD_OR_OUTER]),
                    transform,
                    ies: data.ies.get(i).cloned().unwrap_or_else(|| Arc::from([])),
                },
                _ => return Err(invalid("Invalid light type")),
            };
            scene.add_light(light)?;
        }
        Ok(scene)
    }
    /// Assigns stable source identities for the optional indexed viewer adapter.
    #[doc(hidden)]
    #[cfg(feature = "viewer-support")]
    pub fn set_indexed_aov_ids(&mut self, ids: &[u32]) -> Result<()> {
        if ids.len() != self.meshes.iter().count() {
            return Err(invalid("Indexed mesh identity count mismatch"));
        }
        self.aov_handles
            .extend(self.meshes.iter().zip(ids).map(|((key, _), &id)| (key, id)));
        self.aov_handles.extend(
            self.materials
                .iter()
                .enumerate()
                .map(|(i, (key, _))| (key, i as u32)),
        );
        Ok(())
    }
    /// Encodes with consumer dimensions; quality flags default zero. Reuses the
    /// caller's cache for stable layouts, including edited vertex/image arrays.
    #[doc(hidden)]
    #[cfg(feature = "viewer-support")]
    pub fn update_descriptor<'a>(
        &self,
        cached: &'a mut Option<Descriptor>,
        camera: &[u8],
        size: [u32; 2],
    ) -> Result<&'a [u8]> {
        let r = self.resolve()?;
        let env = encoder::Environment {
            enabled: false,
            width: 0,
            height: 0,
            pixels: Arc::from([]),
            background: false,
            background_color: [
                r.environment.color[0],
                r.environment.color[1],
                r.environment.color[2],
            ],
            background_alpha: r.environment.color[3],
        };
        let data = encoder::SceneData {
            properties: &r.properties,
            geometries: &r.geometries,
            materials: &r.materials,
            textures: &r.textures,
            meshes: &r.meshes,
            lights: r.lights,
            ies: r.ies,
        };
        let words = data
            .word_count(&env)
            .map_err(|e| api::error(Status::InvalidArgument, e.to_string()))?;
        let total = words
            .checked_add(data.meshes.len() + data.materials.len() + 22)
            .filter(|n| *n <= u32::MAX as usize)
            .ok_or_else(|| {
                api::error(
                    Status::InvalidArgument,
                    "Scene descriptor word offsets overflow",
                )
            })?;
        crate::memory_budget::check(total * 4, "Scene descriptor")
            .map_err(|e| api::error(Status::InvalidArgument, e.to_string()))?;
        Descriptor::update(cached, &data, camera, size, &env);
        let d = cached.as_mut().unwrap();
        d.words[h::ENVIRONMENT_TEXTURE] = r.environment_index;
        d.words[h::BACKGROUND_TEXTURE] = r.background_index;
        self.environment_settings.encode(&mut d.words);
        super::GroundedBackground::encode(self.grounded_background, &mut d.words);
        self.write_aov_ids(&mut d.words);
        Ok(d.bytes())
    }
}

#[cfg(feature = "viewer-support")]
impl encoder::SceneData<'_> {
    pub fn to_scene(&self, environment: &encoder::Environment) -> Result<Scene> {
        let mut scene = Scene::from_indexed(self, environment)?;
        // The indexed viewer adapter reconstructs handles for every publication.
        // Its source indices, rather than those transient handles, carry identity.
        let identities: Vec<_> = scene
            .meshes
            .iter()
            .enumerate()
            .map(|(i, (key, _))| (key, i as u32))
            .chain(
                scene
                    .materials
                    .iter()
                    .enumerate()
                    .map(|(i, (key, _))| (key, i as u32)),
            )
            .collect();
        scene.aov_handles.extend(identities);
        Ok(scene)
    }
}
