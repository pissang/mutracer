//! Descriptor encoder moved from native/viewer/src/scene.rs. Preserve record and payload order.
use crate::layout::{
    geometry as g, header as h, light as light_wire, material as mat, mesh as wire_mesh,
    texture as tex,
};
use glam::Mat4;
use std::sync::Arc;
#[derive(Clone)]
pub struct Texture {
    pub float_pixels: Option<Arc<[f32]>>,
    pub storage: u32,
    pub flip_y: bool,
    pub source: usize,
    pub width: u32,
    pub height: u32,
    pub pixels: Arc<[u8]>,
    pub uv: u32,
    pub scale: [f32; 2],
    pub offset: [f32; 2],
    pub wrap: [u32; 2],
}
// Allocation identity, never sampler identity or a full-image content hash.
fn pixel_key(t: &Texture) -> (usize, usize, u32) {
    if let Some(p) = &t.float_pixels {
        (p.as_ptr() as usize, p.len(), 1)
    } else {
        (t.pixels.as_ptr() as usize, t.pixels.len(), 0)
    }
}
pub(super) fn texture_texels(textures: &[Texture]) -> u64 {
    let mut seen = std::collections::HashSet::new();
    textures
        .iter()
        .filter(|t| seen.insert((pixel_key(t), t.width, t.height, t.flip_y)))
        .map(|t| u64::from(t.width) * u64::from(t.height))
        .sum()
}
/// Common OpenPBR values of [`super::OpenPbrMaterial`]; defaults match the browser
/// `OpenPBRMaterial`.
#[derive(Clone, PartialEq)]
pub struct Material {
    pub name: String,
    /// Linear base color.
    pub color: [f32; 3],
    pub roughness: f32,
    pub metalness: f32,
    pub opacity: f32,
    pub transmission: f32,
    pub ior: f32,
    /// Linear emission color.
    pub emission: [f32; 3],
    /// Emission luminance; 0 emits no light.
    pub emission_strength: f32,
    /// Filled from [`super::OpenPbrMaterial::textures`] when encoding.
    pub maps: [u32; 9],
    /// 0 auto, 1 opaque, 2 mask, 3 blend.
    pub alpha_mode: u32,
    /// Mask threshold.
    pub alpha_cutoff: f32,
    pub double_sided: bool,
    pub normal_scale: f32,
    pub unlit: bool,
    pub layers: MaterialLayers,
}
pub(super) use super::types::{Geometry, MaterialLayers};
#[derive(Clone, PartialEq)]
pub struct Mesh {
    pub materials: Vec<usize>,
    pub instances: Option<super::Instances>,
    pub name: String,
    pub geometry: usize,
    pub material: usize,
    pub transform: Mat4,
}
impl Mesh {}

#[derive(Clone)]
pub struct Environment {
    pub enabled: bool,
    pub width: u32,
    pub height: u32,
    pub pixels: Arc<[f32]>,
    pub background: bool,
    pub background_color: [f32; 3],
    pub background_alpha: f32,
}
pub struct SceneData<'a> {
    pub geometries: &'a [Geometry],
    pub materials: &'a [Material],
    pub textures: &'a [Texture],
    pub properties: &'a [std::collections::BTreeMap<u32, [u32; 3]>],
    pub meshes: &'a [Mesh],
    pub lights: Vec<[u32; light_wire::WORDS]>,
    pub ies: Vec<Arc<[u8]>>,
}
impl SceneData<'_> {
    // Count before allocating or narrowing any wire offsets. Reserve once for
    // large geometry payloads rather than repeatedly growing the descriptor.
    pub(super) fn word_count(&self, environment: &Environment) -> anyhow::Result<usize> {
        let mut words = h::WORDS as u64 + 32;
        words += (self.geometries.len() * g::WORDS
            + self.meshes.len() * wire_mesh::WORDS
            + self.materials.len() * mat::WORDS
            + self.lights.len() * light_wire::WORDS
            + (self.textures.len() + usize::from(environment.enabled)) * tex::WORDS)
            as u64;
        for g in self.geometries {
            words += [
                g.positions.len(),
                g.indices.len(),
                g.normals.len(),
                g.uv[0].len(),
                g.uv[1].len(),
                g.colors.len(),
                g.tangents.len(),
                g.material_indices.len(),
            ]
            .into_iter()
            .map(|n| n as u64)
            .sum::<u64>();
        }
        for i in 0..self.materials.len() {
            words += ((MATERIAL_EXTENSIONS
                + self.properties.get(i).map_or(0, |p| {
                    p.keys().filter(|id| !extension_ids().contains(id)).count()
                }))
                * 4) as u64;
        }
        for m in self.meshes {
            words += m.materials.len() as u64;
            if let Some(instances) = &m.instances {
                words += instances.transforms.len() as u64 * 16
                    + instances.colors.as_ref().map_or(0, |c| c.len()) as u64;
            }
        }
        if self.meshes.iter().any(|m| m.instances.is_some()) {
            words += self.meshes.len() as u64 * crate::layout::batch::WORDS as u64;
        }
        let mut pixels = std::collections::HashSet::new();
        for t in self.textures {
            if !pixels.insert(pixel_key(t)) {
                continue;
            }
            words += t
                .float_pixels
                .as_ref()
                .map_or(t.pixels.len().div_ceil(4), |p| p.len()) as u64;
        }
        if environment.enabled {
            words += environment.pixels.len() as u64;
        }
        words += self
            .ies
            .iter()
            .map(|b| b.len().div_ceil(4) as u64)
            .sum::<u64>();
        anyhow::ensure!(
            words <= u32::MAX as u64,
            "Scene descriptor requires {words} words; maximum is {}",
            u32::MAX
        );
        crate::memory_budget::check(words as usize * 4, "Scene descriptor")?;
        Ok(words as usize)
    }
    pub fn encode(&self, camera: &[u8], size: [u32; 2], environment: &Environment) -> Vec<u32> {
        self.words(camera, size, environment)
    }
    fn words(&self, camera: &[u8], size: [u32; 2], environment: &Environment) -> Vec<u32> {
        let lights = &self.lights;
        let mut w = Wire(Vec::with_capacity(
            self.word_count(environment)
                .expect("Scene descriptor budget"),
        ));
        w.0.resize(h::WORDS, 0);
        w.0[h::VERSION] = crate::layout::version::SCENE as u32;
        w.0[h::WIDTH] = size[0];
        w.0[h::HEIGHT] = size[1];
        w.0[h::GEOMETRY_COUNT] = self.geometries.len() as u32;
        w.0[h::MESH_COUNT] = self.meshes.len() as u32;
        w.0[h::MATERIAL_COUNT] = self.materials.len() as u32;
        w.0[h::LIGHT_COUNT] = lights.len() as u32;
        w.0[h::TEXTURE_COUNT] = self.textures.len() as u32 + u32::from(environment.enabled);
        for (header, count, stride) in [
            (h::GEOMETRY_OFFSET, self.geometries.len(), g::WORDS),
            (h::MESH_OFFSET, self.meshes.len(), wire_mesh::WORDS),
            (h::MATERIAL_OFFSET, self.materials.len(), mat::WORDS),
            (
                h::TEXTURE_OFFSET,
                self.textures.len() + usize::from(environment.enabled),
                tex::WORDS,
            ),
            (h::LIGHT_OFFSET, lights.len(), light_wire::WORDS),
        ] {
            w.0[header] = w.0.len() as u32;
            w.0.resize(w.0.len() + count * stride, 0);
        }
        let offset = w.0[h::LIGHT_OFFSET] as usize;
        for (i, record) in lights.iter().enumerate() {
            let o = offset + i * light_wire::WORDS;
            w.0[o..o + light_wire::WORDS].copy_from_slice(record);
        }
        w.0[h::CAMERA_OFFSET] = w.append_bytes(camera);
        for (i, g) in self.geometries.iter().enumerate() {
            let o = w.0[h::GEOMETRY_OFFSET] as usize + i * g::WORDS;
            w.0[o + g::VERTEX_COUNT] = g.positions.len() as u32 / 3;
            w.0[o + g::INDEX_COUNT] = g.indices.len() as u32;
            w.0[o + g::POSITION] = w.append_floats(&g.positions);
            w.0[o + g::INDICES] = w.append(&g.indices);
            for (k, data) in [
                (g::NORMAL, &g.normals),
                (g::UV, &g.uv[0]),
                (g::UV1, &g.uv[1]),
                (g::COLOR, &g.colors),
                (g::TANGENT, &g.tangents),
            ] {
                if !data.is_empty() {
                    w.0[o + k] = w.append_floats(data);
                }
            }
        }
        for (i, geometry) in self.geometries.iter().enumerate() {
            if !geometry.material_indices.is_empty() {
                let o = w.0[h::GEOMETRY_OFFSET] as usize + i * g::WORDS;
                w.0[o + g::MATERIAL_INDEX] = w.append(&geometry.material_indices);
            }
        }
        let mesh_offset = w.0[h::MESH_OFFSET] as usize;
        for (i, m) in self.meshes.iter().enumerate() {
            let o = mesh_offset + i * wire_mesh::WORDS;
            write_mesh(&mut w.0, o, m);
            if !m.materials.is_empty() {
                w.0[o + wire_mesh::MATERIAL_COUNT] = m.materials.len() as u32;
                w.0[o + wire_mesh::MATERIAL_TABLE] =
                    w.append(&m.materials.iter().map(|i| *i as u32).collect::<Vec<_>>());
            }
        }
        for i in 0..self.materials.len() {
            let o = w.0[h::MATERIAL_OFFSET] as usize + i * mat::WORDS;
            let extra = self.properties.get(i).map_or(0, |p| {
                p.keys().filter(|id| !extension_ids().contains(id)).count()
            });
            w.0[o + mat::EXTENSION_COUNT] = (MATERIAL_EXTENSIONS + extra) as u32;
            w.0[o + mat::EXTENSION_OFFSET] = w.append(&vec![0; (MATERIAL_EXTENSIONS + extra) * 4]);
            write_material(&mut w.0, o, &self.materials[i]);
            write_properties(&mut w.0, o, self.properties.get(i));
        }
        let mut pixels = std::collections::HashMap::new();
        for (i, t) in self.textures.iter().enumerate() {
            let o = w.0[h::TEXTURE_OFFSET] as usize + i * tex::WORDS;
            w.0[o + tex::WIDTH] = t.width;
            w.0[o + tex::HEIGHT] = t.height;
            w.0[o + tex::STORAGE] = t.storage;
            w.0[o + tex::FLIP_Y] = u32::from(t.flip_y);
            w.0[o + tex::PIXELS] = *pixels.entry(pixel_key(t)).or_insert_with(|| {
                if let Some(p) = &t.float_pixels {
                    w.append_floats(p)
                } else {
                    w.append_bytes(&t.pixels)
                }
            });
            write_texture_sampling(&mut w.0, o, t);
        }
        if environment.enabled {
            let (width, height, pixels) = (
                environment.width,
                environment.height,
                environment.pixels.clone(),
            );
            let o = w.0[h::TEXTURE_OFFSET] as usize + self.textures.len() * tex::WORDS;
            w.0[o + tex::WIDTH] = width;
            w.0[o + tex::HEIGHT] = height;
            w.0[o + tex::STORAGE] = 1;
            w.0[o + tex::PIXELS] = w.append_floats(&pixels);
            w.0[o + tex::UV_SCALE] = 1f32.to_bits();
            w.0[o + tex::UV_SCALE + 1] = 1f32.to_bits();
            w.0[h::ENVIRONMENT_TEXTURE] =
                self.textures.len() as u32 + u32::from(environment.enabled);
        }
        write_background(
            &mut w.0,
            environment,
            if environment.enabled {
                self.textures.len() as u32 + 1
            } else {
                0
            },
        );
        if self.meshes.iter().any(|m| m.instances.is_some()) {
            w.0[h::BATCH_OFFSET] = w.0.len() as u32;
            let at = w.0.len();
            w.0.resize(at + self.meshes.len() * crate::layout::batch::WORDS, 0);
            for (i, m) in self.meshes.iter().enumerate() {
                let o = at + i * crate::layout::batch::WORDS;
                w.0[o] = u32::MAX;
                if let Some(instances) = &m.instances {
                    w.0[o] = instances.transforms.len() as u32;
                    w.0[o + 1] = w.append_floats(
                        &instances
                            .transforms
                            .iter()
                            .flat_map(|m| m.to_cols_array())
                            .collect::<Vec<_>>(),
                    );
                    if let Some(colors) = &instances.colors {
                        w.0[o + 2] = w.append_floats(colors);
                    }
                }
            }
        }
        for (i, ies) in self.ies.iter().enumerate() {
            if !ies.is_empty() {
                let o = w.0[h::LIGHT_OFFSET] as usize + i * light_wire::WORDS;
                w.0[o + light_wire::IES_OFFSET] = w.append_bytes(ies);
                w.0[o + light_wire::IES_BYTES] = ies.len() as u32;
            }
        }
        w.0[h::LENGTH] = w.0.len() as u32;
        w.0
    }
}
fn write_texture_sampling(words: &mut [u32], offset: usize, texture: &Texture) {
    words[offset + tex::UV_CHANNEL] = texture.uv;
    words[offset + tex::WRAP_S] = texture.wrap[0];
    words[offset + tex::WRAP_T] = texture.wrap[1];
    words[offset + tex::UV_SCALE] = texture.scale[0].to_bits();
    words[offset + tex::UV_SCALE + 1] = texture.scale[1].to_bits();
    words[offset + tex::UV_OFFSET] = texture.offset[0].to_bits();
    words[offset + tex::UV_OFFSET + 1] = texture.offset[1].to_bits();
}

const MATERIAL_EXTENSIONS: usize = 36;
fn write_mesh(w: &mut [u32], o: usize, m: &Mesh) {
    w[o + wire_mesh::GEOMETRY] = m.geometry as u32;
    w[o + wire_mesh::MATERIAL] = m.material as u32;
    for (k, v) in m.transform.to_cols_array().iter().enumerate() {
        w[o + wire_mesh::TRANSFORM + k] = v.to_bits();
    }
}
/// Material record and its extension values; the extension block is already allocated.
fn write_material(w: &mut [u32], o: usize, m: &Material) {
    for (field, value) in [
        (mat::BASE_COLOR, m.color[0]),
        (mat::BASE_COLOR + 1, m.color[1]),
        (mat::BASE_COLOR + 2, m.color[2]),
        (mat::ROUGHNESS, m.roughness),
        (mat::METALNESS, m.metalness),
        (mat::TRANSMISSION, m.transmission),
        (mat::IOR, m.ior),
        (mat::EMISSION_COLOR, m.emission[0]),
        (mat::EMISSION_COLOR + 1, m.emission[1]),
        (mat::EMISSION_COLOR + 2, m.emission[2]),
        (mat::EMISSION_LUMINANCE, m.emission_strength),
        (mat::COAT_WEIGHT, m.layers.coat_weight),
        (mat::COAT_ROUGHNESS, m.layers.coat_roughness),
        (mat::OPACITY, m.opacity),
    ] {
        w[o + field] = value.to_bits();
    }
    w[o + mat::THIN_WALLED] = u32::from(m.layers.thin_walled);
    for (k, v) in m.maps[..4].iter().enumerate() {
        w[o + mat::MAP + k] = *v;
    }
    // Frozen IDs from native/schemas/material-properties.json. The first six
    // records preserve the former descriptor for the default-image regression gate.
    fn scalar(id: u32, v: f32) -> [u32; 4] {
        [id, v.to_bits(), 0, 0]
    }
    fn color(id: u32, v: [f32; 3]) -> [u32; 4] {
        [id, v[0].to_bits(), v[1].to_bits(), v[2].to_bits()]
    }
    let l = &m.layers;
    let ext: [[u32; 4]; MATERIAL_EXTENSIONS] = [
        [38, u32::from(m.double_sided), 0, 0],
        [41, m.alpha_mode, 0, 0],
        scalar(42, m.alpha_cutoff),
        [45, m.normal_scale.to_bits(), m.normal_scale.to_bits(), 0],
        [52, u32::from(m.unlit), 0, 0],
        [73, 1, 0, 0],
        scalar(3, l.diffuse_roughness),
        scalar(5, l.specular_weight),
        scalar(9, l.anisotropy),
        color(11, l.transmission_color),
        scalar(12, l.transmission_depth),
        scalar(15, l.dispersion),
        scalar(17, l.subsurface_weight),
        color(18, l.subsurface_color),
        scalar(19, l.subsurface_radius),
        scalar(22, l.fuzz_weight),
        color(23, l.fuzz_color),
        scalar(24, l.fuzz_roughness),
        color(26, l.coat_color),
        scalar(29, l.coat_ior),
        scalar(31, l.film_weight),
        scalar(32, l.film_thickness),
        scalar(33, l.film_ior),
        scalar(53, l.bevel),
        color(6, l.specular_color),
        color(20, l.subsurface_radius_scale),
        [47, m.maps[4], 0, 0],
        [48, m.maps[5], 0, 0],
        [49, m.maps[6], 0, 0],
        [50, m.maps[7], 0, 0],
        [59, m.maps[8], 0, 0],
        scalar(60, l.displacement_scale),
        scalar(76, l.displacement_bias),
        scalar(
            61,
            if l.displacement_step > 0. {
                l.displacement_step
            } else if l.displacement_scale.abs() > 1e-6 {
                l.displacement_scale.abs() / 32.
            } else {
                0.01
            },
        ),
        [57, l.displacement_projection, 0, 0],
        scalar(58, l.displacement_projection_scale),
    ];
    let at = w[o + mat::EXTENSION_OFFSET] as usize;
    for (index, record) in ext.iter().enumerate() {
        w[at + index * 4..at + (index + 1) * 4].copy_from_slice(record);
    }
}
#[cfg(any(test, feature = "viewer-support"))]
pub fn material_values(material: &Material) -> serde_json::Map<String, serde_json::Value> {
    // Decode the actual descriptor rather than repeating the preset-to-field mapping.
    let mut w = vec![0; mat::WORDS + MATERIAL_EXTENSIONS * 4];
    w[mat::EXTENSION_OFFSET] = mat::WORDS as u32;
    write_material(&mut w, 0, material);
    let schema: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../schemas/material-properties.json")).unwrap();
    let mut values = serde_json::Map::new();
    for (key, offset, count) in [
        ("baseColor", mat::BASE_COLOR, 3),
        ("specularRoughness", mat::ROUGHNESS, 1),
        ("baseMetalness", mat::METALNESS, 1),
        ("transmissionWeight", mat::TRANSMISSION, 1),
        ("specularIor", mat::IOR, 1),
        ("emissionColor", mat::EMISSION_COLOR, 3),
        ("emissionLuminance", mat::EMISSION_LUMINANCE, 1),
        ("coatWeight", mat::COAT_WEIGHT, 1),
        ("coatRoughness", mat::COAT_ROUGHNESS, 1),
        ("opacity", mat::OPACITY, 1),
    ] {
        values.insert(
            key.into(),
            if count == 1 {
                serde_json::json!(f32::from_bits(w[offset]))
            } else {
                serde_json::json!(
                    (0..count)
                        .map(|i| f32::from_bits(w[offset + i]))
                        .collect::<Vec<_>>()
                )
            },
        );
    }
    values.insert(
        "thinWalled".into(),
        serde_json::json!(w[mat::THIN_WALLED] != 0),
    );
    for ext in w[mat::WORDS..].chunks_exact(4) {
        let field = &schema[ext[0] as usize - 1];
        let value = match field["type"].as_str().unwrap() {
            "color" => serde_json::json!([
                f32::from_bits(ext[1]),
                f32::from_bits(ext[2]),
                f32::from_bits(ext[3])
            ]),
            "float" => serde_json::json!(f32::from_bits(ext[1])),
            _ => serde_json::json!(ext[1]),
        };
        values.insert(field["key"].as_str().unwrap().into(), value);
    }
    values
}
/// Background words; the environment map is texture `environment` (index + 1).
fn write_background(w: &mut [u32], environment: &Environment, texture: u32) {
    let color = environment.background_color;
    for (k, c) in color.iter().enumerate() {
        w[h::BACKGROUND_COLOR + k] = c.to_bits();
    }
    w[h::BACKGROUND_COLOR + 3] = if environment.background {
        1f32
    } else {
        environment.background_alpha
    }
    .to_bits();
    w[h::BACKGROUND_TEXTURE] = if environment.background { texture } else { 0 };
}
struct Wire(Vec<u32>);
impl Wire {
    fn append(&mut self, v: &[u32]) -> u32 {
        let o = self.0.len() as u32;
        self.0.extend(v);
        o
    }
    fn append_floats(&mut self, v: &[f32]) -> u32 {
        let o = self.0.len() as u32;
        self.0.extend(v.iter().map(|v| v.to_bits()));
        o
    }
    fn append_bytes(&mut self, v: &[u8]) -> u32 {
        let o = self.0.len() as u32;
        for b in v.chunks(4) {
            let mut word = [0; 4];
            word[..b.len()].copy_from_slice(b);
            self.0.push(u32::from_le_bytes(word));
        }
        o
    }
}
impl SceneData<'_> {
    /// Updates records and stable-size payloads in place. Returns false before
    /// writing anything when an allocation or optional attribute changes shape.
    #[cfg(any(test, feature = "viewer-support"))]
    pub fn patch(
        &self,
        w: &mut Vec<u32>,
        camera: &[u8],
        size: [u32; 2],
        env: &Environment,
    ) -> bool {
        self.patch_selected(w, camera, size, env, None)
    }
    pub fn patch_selected(
        &self,
        w: &mut Vec<u32>,
        camera: &[u8],
        size: [u32; 2],
        env: &Environment,
        previous: Option<(&[Geometry], &[Texture])>,
    ) -> bool {
        if w.len() < h::WORDS
            || camera.len() != 128
            || w[h::GEOMETRY_COUNT] as usize != self.geometries.len()
            || w[h::MESH_COUNT] as usize != self.meshes.len()
            || w[h::MATERIAL_COUNT] as usize != self.materials.len()
            || w[h::TEXTURE_COUNT] as usize != self.textures.len() + usize::from(env.enabled)
            || w[h::LIGHT_COUNT] as usize != self.lights.len()
        {
            return false;
        }
        for (i, g) in self.geometries.iter().enumerate() {
            let o = w[h::GEOMETRY_OFFSET] as usize + i * g::WORDS;
            if w[o + g::VERTEX_COUNT] as usize * 3 != g.positions.len()
                || w[o + g::INDEX_COUNT] as usize != g.indices.len()
            {
                return false;
            }
            for (field, len) in [
                (g::NORMAL, g.normals.len()),
                (g::UV, g.uv[0].len()),
                (g::UV1, g.uv[1].len()),
                (g::COLOR, g.colors.len()),
                (g::TANGENT, g.tangents.len()),
                (g::MATERIAL_INDEX, g.material_indices.len()),
            ] {
                if (w[o + field] == 0) != (len == 0) {
                    return false;
                }
            }
        }
        let mut offsets = std::collections::HashMap::new();
        let mut allocations = std::collections::HashMap::new();
        for (i, t) in self.textures.iter().enumerate() {
            let o = w[h::TEXTURE_OFFSET] as usize + i * tex::WORDS;
            // A sampler copy may detach or join after a pixel edit. Re-encode
            // before any write when the old and new alias partitions differ.
            let offset = w[o + tex::PIXELS];
            let key = pixel_key(t);
            if offsets.insert(offset, key).is_some_and(|old| old != key)
                || allocations
                    .insert(key, offset)
                    .is_some_and(|old| old != offset)
            {
                return false;
            }
            if w[o + tex::WIDTH] != t.width
                || w[o + tex::HEIGHT] != t.height
                || w[o + tex::STORAGE] != t.storage
            {
                return false;
            }
        }
        if env.enabled {
            let o = w[h::TEXTURE_OFFSET] as usize + self.textures.len() * tex::WORDS;
            if w[o + tex::WIDTH] != env.width || w[o + tex::HEIGHT] != env.height {
                return false;
            }
        }
        for (i, _) in self.materials.iter().enumerate() {
            let o = w[h::MATERIAL_OFFSET] as usize + i * mat::WORDS;
            let extra = self.properties.get(i).map_or(0, |p| {
                p.keys().filter(|id| !extension_ids().contains(id)).count()
            });
            if w[o + mat::EXTENSION_COUNT] as usize != MATERIAL_EXTENSIONS + extra {
                return false;
            }
        }
        let batches = w[h::BATCH_OFFSET] as usize;
        if (batches == 0) != self.meshes.iter().all(|m| m.instances.is_none()) {
            return false;
        }
        for (i, m) in self.meshes.iter().enumerate() {
            let o = w[h::MESH_OFFSET] as usize + i * wire_mesh::WORDS;
            if w[o + wire_mesh::MATERIAL_COUNT] as usize != m.materials.len() {
                return false;
            }
            if batches != 0 {
                let o = batches + i * crate::layout::batch::WORDS;
                if w[o]
                    != m.instances
                        .as_ref()
                        .map_or(u32::MAX, |x| x.transforms.len() as u32)
                    || (w[o + 2] != 0) != m.instances.as_ref().is_some_and(|x| x.colors.is_some())
                {
                    return false;
                }
            }
        }
        for (i, ies) in self.ies.iter().enumerate() {
            let o = w[h::LIGHT_OFFSET] as usize + i * light_wire::WORDS;
            if w[o + light_wire::IES_BYTES] as usize != ies.len() {
                return false;
            }
        }
        fn floats(w: &mut [u32], at: usize, v: &[f32]) {
            for (k, v) in v.iter().enumerate() {
                w[at + k] = v.to_bits();
            }
        }
        for (i, g) in self.geometries.iter().enumerate() {
            if previous.and_then(|(g, _)| g.get(i)).is_some_and(|a| {
                Arc::ptr_eq(&a.positions, &g.positions)
                    && Arc::ptr_eq(&a.indices, &g.indices)
                    && Arc::ptr_eq(&a.normals, &g.normals)
                    && Arc::ptr_eq(&a.uv[0], &g.uv[0])
                    && Arc::ptr_eq(&a.uv[1], &g.uv[1])
                    && Arc::ptr_eq(&a.colors, &g.colors)
                    && Arc::ptr_eq(&a.tangents, &g.tangents)
                    && Arc::ptr_eq(&a.material_indices, &g.material_indices)
            }) {
                continue;
            }
            let o = w[h::GEOMETRY_OFFSET] as usize + i * g::WORDS;
            for (field, data) in [
                (g::POSITION, &g.positions),
                (g::NORMAL, &g.normals),
                (g::UV, &g.uv[0]),
                (g::UV1, &g.uv[1]),
                (g::COLOR, &g.colors),
                (g::TANGENT, &g.tangents),
            ] {
                let at = w[o + field] as usize;
                floats(w, at, data);
            }
            for (field, data) in [
                (g::INDICES, &g.indices),
                (g::MATERIAL_INDEX, &g.material_indices),
            ] {
                let at = w[o + field] as usize;
                w[at..at + data.len()].copy_from_slice(data);
            }
        }
        for (i, m) in self.meshes.iter().enumerate() {
            let o = w[h::MESH_OFFSET] as usize + i * wire_mesh::WORDS;
            write_mesh(w, o, m);
            let at = w[o + wire_mesh::MATERIAL_TABLE] as usize;
            for (k, id) in m.materials.iter().enumerate() {
                w[at + k] = *id as u32;
            }
            if let Some(inst) = &m.instances {
                let o = batches + i * crate::layout::batch::WORDS;
                let at = w[o + 1] as usize;
                for (k, m) in inst.transforms.iter().enumerate() {
                    floats(w, at + k * 16, &m.to_cols_array());
                }
                if let Some(colors) = &inst.colors {
                    let at = w[o + 2] as usize;
                    floats(w, at, colors);
                }
            }
        }
        for (i, m) in self.materials.iter().enumerate() {
            let o = w[h::MATERIAL_OFFSET] as usize + i * mat::WORDS;
            write_material(w, o, m);
            write_properties(w, o, self.properties.get(i));
        }
        for (i, t) in self.textures.iter().enumerate() {
            let o = w[h::TEXTURE_OFFSET] as usize + i * tex::WORDS;
            write_texture_sampling(w, o, t);
            w[o + tex::FLIP_Y] = u32::from(t.flip_y);
            let at = w[o + tex::PIXELS] as usize;
            if let Some(p) = &t.float_pixels {
                if !previous
                    .and_then(|(_, t)| t.get(i))
                    .and_then(|t| t.float_pixels.as_ref())
                    .is_some_and(|a| Arc::ptr_eq(a, p))
                {
                    floats(w, at, p);
                }
                continue;
            }
            if previous
                .and_then(|(_, t)| t.get(i))
                .is_some_and(|a| Arc::ptr_eq(&a.pixels, &t.pixels))
            {
                continue;
            }
            let bytes = t.pixels.len() / 4 * 4;
            bytemuck::cast_slice_mut(&mut w[at..at + bytes / 4])
                .copy_from_slice(&t.pixels[..bytes]);
        }
        for (i, record) in self.lights.iter().enumerate() {
            let o = w[h::LIGHT_OFFSET] as usize + i * light_wire::WORDS;
            let at = w[o + light_wire::IES_OFFSET];
            let len = w[o + light_wire::IES_BYTES];
            w[o..o + light_wire::WORDS].copy_from_slice(record);
            w[o + light_wire::IES_OFFSET] = at;
            w[o + light_wire::IES_BYTES] = len;
            if let Some(ies) = self.ies.get(i) {
                for (k, b) in ies.chunks(4).enumerate() {
                    let mut word = [0; 4];
                    word[..b.len()].copy_from_slice(b);
                    w[at as usize + k] = u32::from_le_bytes(word);
                }
            }
        }
        if env.enabled {
            let o = w[h::TEXTURE_OFFSET] as usize + self.textures.len() * tex::WORDS;
            let at = w[o + tex::PIXELS] as usize;
            floats(w, at, &env.pixels);
        }
        let at = w[h::CAMERA_OFFSET] as usize;
        bytemuck::cast_slice_mut(&mut w[at..at + camera.len() / 4]).copy_from_slice(camera);
        w[h::WIDTH] = size[0];
        w[h::HEIGHT] = size[1];
        write_background(
            w,
            env,
            if env.enabled {
                self.textures.len() as u32 + 1
            } else {
                0
            },
        );
        true
    }
}

fn extension_ids() -> [u32; MATERIAL_EXTENSIONS] {
    [
        38, 41, 42, 45, 52, 73, 3, 5, 9, 11, 12, 15, 17, 18, 19, 22, 23, 24, 26, 29, 31, 32, 33,
        53, 6, 20, 47, 48, 49, 50, 59, 60, 76, 61, 57, 58,
    ]
}
fn write_properties(
    w: &mut [u32],
    o: usize,
    properties: Option<&std::collections::BTreeMap<u32, [u32; 3]>>,
) {
    let Some(properties) = properties else { return };
    let at = w[o + mat::EXTENSION_OFFSET] as usize;
    let mut extra = MATERIAL_EXTENSIONS;
    for (&id, value) in properties {
        let k = extension_ids()
            .iter()
            .position(|v| *v == id)
            .unwrap_or_else(|| {
                let k = extra;
                extra += 1;
                k
            });
        w[at + k * 4] = id;
        w[at + k * 4 + 1..at + k * 4 + 4].copy_from_slice(value);
    }
}

#[cfg(test)]
mod texture_reuse_tests {
    use super::*;
    fn texture() -> Texture {
        Texture {
            float_pixels: None,
            storage: 0,
            flip_y: false,
            source: 0,
            width: 2,
            height: 1,
            pixels: vec![13, 27, 41, 255, 60, 70, 80, 255].into(),
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
            wrap: [0; 2],
        }
    }
    fn data(textures: &[Texture]) -> SceneData<'_> {
        SceneData {
            geometries: &[],
            materials: &[],
            properties: &[],
            meshes: &[],
            textures,
            lights: vec![],
            ies: vec![],
        }
    }
    fn environment() -> Environment {
        Environment {
            enabled: false,
            width: 0,
            height: 0,
            pixels: Arc::from([]),
            background: false,
            background_color: [0.; 3],
            background_alpha: 1.,
        }
    }
    #[test]
    fn shared_payloads_encode_once_and_detach_before_patch_writes() {
        for float in [false, true] {
            let mut t = texture();
            if float {
                t.storage = 1;
                t.float_pixels = Some(vec![0.5; 8].into());
            }
            let mut textures = [t.clone(), t.clone()];
            textures[1].uv = 1;
            textures[1].wrap = [1, 2];
            let env = environment();
            let camera = [0; 128];
            let mut words = data(&textures).encode(&camera, [8, 8], &env);
            let off = words[h::TEXTURE_OFFSET] as usize;
            let a = words[off + tex::PIXELS];
            assert_eq!(words[off + tex::WORDS + tex::PIXELS], a);
            assert_eq!(words.len(), data(&textures).word_count(&env).unwrap());
            assert_eq!(texture_texels(&textures), 2);
            textures[1].offset = [0.25, 0.5];
            assert!(data(&textures).patch(&mut words, &camera, [8, 8], &env));
            let before = words.clone();
            if float {
                textures[1].float_pixels = Some(vec![0.75; 8].into());
            } else {
                textures[1].pixels = vec![100; 8].into();
            }
            assert!(!data(&textures).patch(&mut words, &camera, [8, 8], &env));
            assert_eq!(words, before);
            let mut detached = data(&textures).encode(&camera, [8, 8], &env);
            assert_ne!(detached[off + tex::WORDS + tex::PIXELS], a);
            textures[1] = textures[0].clone();
            let before = detached.clone();
            assert!(!data(&textures).patch(&mut detached, &camera, [8, 8], &env));
            assert_eq!(detached, before);
        }
    }
}
