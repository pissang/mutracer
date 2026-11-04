//! Decoded glTF scene data shared by SDK import and the viewer.
use crate::scene_api::encoder::{Geometry, Material, MaterialLayers, Mesh, Texture};
use anyhow::{Context, Result, bail, ensure};
use glam::{Mat4, Vec3};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::Arc,
};

pub(super) fn texture_property(id: u32) -> bool {
    crate::material_properties::MATERIAL_PROPERTIES
        .get(id as usize)
        .is_some_and(|p| p.0 == 5)
}
const TEXTURE_BUDGET_WARNING: &str =
    "Material textures were reduced to share the configured material texture budget.";
#[derive(Clone)]
pub struct Model {
    pub name: String,
    pub materials: Vec<Material>,
    pub properties: Vec<BTreeMap<u32, [u32; 3]>>,
    pub textures: Arc<Vec<Texture>>,
    pub geometries: Arc<Vec<Geometry>>,
    pub animation: Option<super::animation::Animation>,
    pub meshes: Vec<Mesh>,
    pub center: Vec3,
    pub radius: f32,
    pub ground_y: f32,
    pub warnings: Vec<String>,
    pub node_names: Vec<String>,
    pub node_indices: Vec<usize>,
    pub mesh_names: Vec<String>,
}
// Collected on the import worker; no public Model state or global switch changes.
struct ImportProfile {
    bulk: bool,
    defer_bounds: bool,
    enabled: bool,
    attributes_ms: f64,
    local_bounds_ms: f64,
    index_validation_ms: f64,
    deformation_ms: f64,
    bulk_attributes: usize,
    bulk_bytes: usize,
}
impl ImportProfile {
    fn start(&self) -> Option<std::time::Instant> {
        self.enabled.then(std::time::Instant::now)
    }
}
fn bulk_floats(
    accessor: gltf::Accessor<'_>,
    buffers: &[gltf::buffer::Data],
    components: usize,
) -> Option<Arc<[f32]>> {
    // glTF components are little-endian. Other hosts/layouts keep gltf-rs reads.
    if !cfg!(target_endian = "little")
        || accessor.data_type() != gltf::accessor::DataType::F32
        || accessor.normalized()
        || accessor.sparse().is_some()
        || accessor.count() == 0
    {
        return None;
    }
    let dimensions = match components {
        2 => gltf::accessor::Dimensions::Vec2,
        3 => gltf::accessor::Dimensions::Vec3,
        4 => gltf::accessor::Dimensions::Vec4,
        _ => return None,
    };
    if accessor.dimensions() != dimensions {
        return None;
    }
    let view = accessor.view()?;
    let element = components.checked_mul(4)?;
    if view.stride().unwrap_or(element) != element {
        return None;
    }
    let buffer = &buffers.get(view.buffer().index())?.0;
    let view_bytes = buffer.get(view.offset()..view.offset().checked_add(view.length())?)?;
    let length = accessor.count().checked_mul(element)?;
    let bytes = view_bytes.get(accessor.offset()..accessor.offset().checked_add(length)?)?;
    // One allocation/copy directly into the shared storage, without a Vec stage.
    Some(Arc::from(bytemuck::try_cast_slice::<u8, f32>(bytes).ok()?))
}
fn float_attribute(
    accessor: Option<gltf::Accessor<'_>>,
    buffers: &[gltf::buffer::Data],
    components: usize,
    profile: &mut ImportProfile,
    fallback: impl FnOnce() -> Option<Arc<[f32]>>,
) -> Option<Arc<[f32]>> {
    if profile.bulk {
        if let Some(data) = accessor.and_then(|accessor| bulk_floats(accessor, buffers, components))
        {
            profile.bulk_attributes += 1;
            profile.bulk_bytes += data.len() * 4;
            return Some(data);
        }
    }
    fallback()
}
fn local_bounds(positions: &[f32]) -> (Vec3, Vec3) {
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    for p in positions.chunks_exact(3) {
        let p = Vec3::from_slice(p);
        min = min.min(p);
        max = max.max(p);
    }
    (min, max)
}
fn update_local_bounds(geometries: &mut [Geometry], workers: usize) {
    if workers <= 1 || geometries.len() <= 1 {
        for geometry in geometries {
            (geometry.min, geometry.max) = local_bounds(&geometry.positions);
        }
        return;
    }
    use std::sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    };
    let next = AtomicUsize::new(0);
    let results: Vec<_> = (0..geometries.len()).map(|_| OnceLock::new()).collect();
    // Geometry input is immutable until every scoped worker has joined. Each
    // vertex reduction retains its original order; only geometries run in parallel.
    std::thread::scope(|scope| {
        let geometries = &*geometries;
        for _ in 0..workers.min(geometries.len()) {
            let next = &next;
            let results = &results;
            scope.spawn(move || {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(geometry) = geometries.get(i) else {
                        break;
                    };
                    let _ = results[i].set(local_bounds(&geometry.positions));
                }
            });
        }
    });
    for (geometry, result) in geometries.iter_mut().zip(results) {
        (geometry.min, geometry.max) = result.into_inner().expect("Missing import bounds result");
    }
}
impl Model {
    // The viewer also uses this reader before inspecting its supported light extension.
    #[doc(hidden)]
    pub fn read(path: &Path) -> Result<Vec<u8>> {
        crate::memory_budget::check(usize::try_from(path.metadata()?.len())?, "Model file")?;
        let bytes = std::fs::read(path)?;
        crate::memory_budget::check(bytes.len(), "Model file")?;
        Ok(bytes)
    }
    pub fn load(path: &Path) -> Result<Self> {
        Self::load_bytes(&Self::read(path)?, Some(path))
    }
    pub fn load_bytes(bytes: &[u8], path: Option<&Path>) -> Result<Self> {
        Self::load_bytes_with_options(
            bytes,
            path,
            std::env::var("MUTRACER_NATIVE_GLTF_ATTRIBUTES").as_deref() != Ok("reader"),
            std::env::var("MUTRACER_NATIVE_GLTF_BOUNDS").as_deref() != Ok("serial"),
        )
    }
    fn load_bytes_with_options(
        bytes: &[u8],
        path: Option<&Path>,
        bulk: bool,
        parallel_bounds: bool,
    ) -> Result<Self> {
        let started = crate::profiling::enabled().then(std::time::Instant::now);
        crate::memory_budget::check(bytes.len(), "Model file")?;
        let (document, buffers, images, resized, raw_materials) =
            super::decode::load_bytes(bytes, path)
                .context("Loading GLTF/GLB and its buffers/images")?;
        let decoded = started.map(|_| std::time::Instant::now());
        let path = path.unwrap_or(Path::new("memory.glb"));
        let mut model = Self {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            materials: vec![],
            properties: vec![],
            textures: Arc::new(vec![]),
            geometries: Arc::new(vec![]),
            animation: super::animation::Animation::load(&document, &buffers)?,
            meshes: vec![],
            center: Vec3::ZERO,
            radius: 1.,
            ground_y: 0.,
            warnings: vec![],
            node_names: vec![],
            node_indices: vec![],
            mesh_names: vec![],
        };
        if resized {
            model.warnings.push(TEXTURE_BUDGET_WARNING.into());
        }
        for extension in document
            .extensions_used()
            .filter(|e| !super::SUPPORTED_EXTENSIONS.contains(e))
        {
            model.warnings.push(format!(
                "Unsupported optional extension is ignored: {extension}"
            ));
        }
        let rgba: Vec<Arc<[u8]>> = images.iter().map(|image| image.pixels.clone()).collect();
        for material in document.materials() {
            let raw = &raw_materials[material.index().unwrap()];
            let pbr = material.pbr_metallic_roughness();
            let base = pbr.base_color_factor();
            let mut maps = [u32::MAX; 9];
            if let Some(info) = pbr.base_color_texture() {
                maps[0] = model.add_map(
                    info.texture(),
                    info.tex_coord(),
                    info.texture_transform()
                        .map(|t| (t.offset(), t.scale(), t.rotation(), t.tex_coord())),
                    &images,
                    &rgba,
                )?;
            }
            if material.normal_texture().is_some() {
                maps[1] = model.add_json_map(&raw["normalTexture"], &document, &images, &rgba)?;
            }
            if let Some(info) = pbr.metallic_roughness_texture() {
                maps[2] = model.add_map(
                    info.texture(),
                    info.tex_coord(),
                    info.texture_transform()
                        .map(|t| (t.offset(), t.scale(), t.rotation(), t.tex_coord())),
                    &images,
                    &rgba,
                )?;
            }
            if let Some(info) = material.emissive_texture() {
                maps[3] = model.add_map(
                    info.texture(),
                    info.tex_coord(),
                    info.texture_transform()
                        .map(|t| (t.offset(), t.scale(), t.rotation(), t.tex_coord())),
                    &images,
                    &rgba,
                )?;
            }
            if material.occlusion_texture().is_some() {
                model
                    .warnings
                    .push("Occlusion textures are ignored by this path-traced example.".into());
            }
            let mut converted = Material {
                name: material.name().map(str::to_owned).unwrap_or_else(|| {
                    format!(
                        "Material {}",
                        material
                            .index()
                            .map(|i| i.to_string())
                            .unwrap_or("default".into())
                    )
                }),
                color: [base[0], base[1], base[2]],
                opacity: if material.alpha_mode() == gltf::material::AlphaMode::Opaque {
                    1.
                } else {
                    base[3]
                },
                roughness: pbr.roughness_factor(),
                metalness: pbr.metallic_factor(),
                transmission: material
                    .transmission()
                    .map(|t| t.transmission_factor())
                    .unwrap_or(0.),
                ior: material.ior().unwrap_or(1.5),
                emission: material.emissive_factor(),
                emission_strength: material.emissive_strength().unwrap_or(1.),
                maps,
                alpha_mode: match material.alpha_mode() {
                    gltf::material::AlphaMode::Opaque => 1,
                    gltf::material::AlphaMode::Mask => 2,
                    gltf::material::AlphaMode::Blend => 3,
                },
                alpha_cutoff: material.alpha_cutoff().unwrap_or(0.5),
                double_sided: material.double_sided(),
                normal_scale: material.normal_texture().map(|t| t.scale()).unwrap_or(1.),
                unlit: material.unlit(),
                layers: MaterialLayers::default(),
            };
            let properties = super::materials::apply(
                &mut model,
                &mut converted,
                raw,
                &document,
                &images,
                &rgba,
            )?;
            model.materials.push(converted);
            model.properties.push(properties);
        }
        model.properties.push(BTreeMap::new());
        model.materials.push(Material {
            name: "Default".into(),
            color: [1.; 3],
            roughness: 1.,
            metalness: 1.,
            opacity: 1.,
            transmission: 0.,
            ior: 1.5,
            emission: [0.; 3],
            emission_strength: 1.,
            maps: [u32::MAX; 9],
            alpha_mode: 1,
            alpha_cutoff: 0.5,
            double_sided: false,
            normal_scale: 1.,
            unlit: false,
            layers: MaterialLayers::default(),
        });
        let scene = document
            .default_scene()
            .or_else(|| document.scenes().next())
            .context("glTF has no scene")?;
        let mut worlds = vec![Mat4::IDENTITY; document.nodes().len()];
        fn world(
            node: gltf::Node<'_>,
            parent: Mat4,
            worlds: &mut [Mat4],
            depth: usize,
        ) -> Result<()> {
            ensure!(
                depth < 512,
                "Node hierarchy exceeds 512 levels or contains a cycle"
            );
            let matrix = parent * Mat4::from_cols_array_2d(&node.transform().matrix());
            worlds[node.index()] = matrix;
            for child in node.children() {
                world(child, matrix, worlds, depth + 1)?;
            }
            Ok(())
        }
        let children: std::collections::HashSet<_> = document
            .nodes()
            .flat_map(|n| n.children().map(|c| c.index()))
            .collect();
        for node in document.nodes().filter(|n| !children.contains(&n.index())) {
            world(node, Mat4::IDENTITY, &mut worlds, 0)?;
        }
        let mut profile = ImportProfile {
            bulk,
            defer_bounds: parallel_bounds,
            enabled: started.is_some(),
            attributes_ms: 0.,
            local_bounds_ms: 0.,
            index_validation_ms: 0.,
            deformation_ms: 0.,
            bulk_attributes: 0,
            bulk_bytes: 0,
        };
        let mut cache = HashMap::new();
        for node in scene.nodes() {
            model.visit(
                node,
                Mat4::IDENTITY,
                &buffers,
                &mut cache,
                &document,
                &worlds,
                &mut profile,
                0,
            )?;
        }
        ensure!(
            !model.meshes.is_empty(),
            "The selected scene has no triangle meshes"
        );
        let vertices: usize = model.geometries.iter().map(|g| g.positions.len() / 3).sum();
        let bounds_workers = if parallel_bounds && vertices >= 131_072 {
            std::thread::available_parallelism()
                .map_or(1, |n| n.get().min(12).min(model.geometries.len()).max(1))
        } else {
            1
        };
        if parallel_bounds {
            let start = profile.start();
            update_local_bounds(
                Arc::make_mut(&mut model.geometries).as_mut_slice(),
                bounds_workers,
            );
            if let Some(start) = start {
                profile.local_bounds_ms += start.elapsed().as_secs_f64() * 1000.;
            }
        }
        let world_bounds_started = profile.start();
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for mesh in &model.meshes {
            for p in model.geometries[mesh.geometry].positions.chunks_exact(3) {
                let p = mesh.transform.transform_point3(Vec3::from_slice(p));
                min = min.min(p);
                max = max.max(p);
            }
        }
        let world_bounds_ms =
            world_bounds_started.map_or(0., |start| start.elapsed().as_secs_f64() * 1000.);
        model.center = (min + max) * 0.5;
        model.radius = (max - min).length() * 0.5;
        model.ground_y = min.y;
        ensure!(
            model.center.is_finite() && model.radius.is_finite() && model.radius > 1e-8,
            "Invalid or degenerate model bounds"
        );
        for mesh in &model.meshes {
            for id in model.texture_ids(mesh.material) {
                if id != u32::MAX {
                    ensure!(
                        !model.geometries[mesh.geometry].uv
                            [model.textures[id as usize].uv as usize]
                            .is_empty(),
                        "Material references a missing texture coordinate set"
                    );
                }
            }
        }
        model.warnings.sort();
        model.warnings.dedup();
        if let (Some(started), Some(decoded)) = (started, decoded) {
            native_log!(
                "{}",
                serde_json::json!({"nativeImportProfile": {
                "decodeMs": decoded.duration_since(started).as_secs_f64()*1000.,
                "modelMs": decoded.elapsed().as_secs_f64()*1000.,
                "attributesMs": profile.attributes_ms, "localBoundsMs": profile.local_bounds_ms, "boundsWorkers": bounds_workers,
                "worldBoundsMs": world_bounds_ms, "indexValidationMs": profile.index_validation_ms,
                "deformationMs": profile.deformation_ms, "bulkAttributes": profile.bulk_attributes, "bulkBytes": profile.bulk_bytes,
                "totalMs": started.elapsed().as_secs_f64()*1000.}})
            );
        }
        if model.apply_animation()? {
            model.refresh_bounds();
        }
        Ok(model)
    }
    /// Replaces slots atomically. Existing slots provide UV sampling, then base color.
    pub fn replace_textures(
        &mut self,
        material: usize,
        images: Vec<(usize, Option<image::RgbaImage>)>,
    ) -> Result<()> {
        ensure!(material < self.materials.len(), "Unknown material");
        ensure!(
            images.iter().all(|(slot, _)| *slot < 9),
            "Unknown texture slot"
        );
        let mut candidate = self.clone();
        let references: Vec<_> = images
            .iter()
            .map(|(slot, _)| {
                let maps = self.materials[material].maps;
                let id = if maps[*slot] != u32::MAX {
                    maps[*slot]
                } else {
                    maps[0]
                };
                self.textures.get(id as usize).cloned()
            })
            .collect();
        for (slot, _) in &images {
            candidate.materials[material].maps[*slot] = u32::MAX;
        }
        candidate.compact_textures();
        let used = super::super::encoder::texture_texels(&candidate.textures);
        let count = images.iter().filter(|(_, image)| image.is_some()).count();
        // Material and environment images have separate allowances.
        let available = super::decode::material_texel_budget().saturating_sub(used);
        ensure!(
            count == 0 || available >= count as u64,
            "Material texture budget is full"
        );
        let per_image = if count == 0 {
            available
        } else {
            available / count as u64
        };
        let edge = if count == 0 {
            16384
        } else {
            ((available / count as u64) as f64)
                .sqrt()
                .floor()
                .min(16384.) as u32
        };
        for ((slot, image), reference) in images.into_iter().zip(references) {
            let Some(mut image) = image else { continue };
            ensure!(image.width() > 0 && image.height() > 0, "Empty texture");
            if slot == 8 {
                let size = image
                    .width()
                    .max(image.height())
                    .min(edge)
                    .next_power_of_two();
                let size = if size > edge { size / 2 } else { size };
                image = image::imageops::resize(
                    &image,
                    size,
                    size,
                    image::imageops::FilterType::Triangle,
                );
            } else if image.width().max(image.height()) > 16384
                || image.width() as u64 * image.height() as u64 > per_image
            {
                let factor = (16384. / image.width().max(image.height()) as f64).min(
                    (per_image as f64 / (image.width() as f64 * image.height() as f64)).sqrt(),
                );
                image = image::imageops::resize(
                    &image,
                    (image.width() as f64 * factor).floor().max(1.) as u32,
                    (image.height() as f64 * factor).floor().max(1.) as u32,
                    image::imageops::FilterType::Triangle,
                );
            }
            ensure!(candidate.textures.len() < 65535, "Texture limit reached");
            let uv = reference.as_ref().map_or(0, |t| t.uv);
            let uv = if candidate
                .meshes
                .iter()
                .filter(|m| m.material == material)
                .any(|m| candidate.geometries[m.geometry].uv[uv as usize].is_empty())
            {
                0
            } else {
                uv
            };
            let id = candidate.textures.len() as u32;
            Arc::make_mut(&mut candidate.textures).push(Texture {
                float_pixels: None,
                storage: 0,
                flip_y: false,
                source: usize::MAX,
                width: image.width(),
                height: image.height(),
                pixels: image.into_raw().into(),
                uv,
                scale: reference.as_ref().map_or([1.; 2], |t| t.scale),
                offset: reference.as_ref().map_or([0.; 2], |t| t.offset),
                wrap: reference.as_ref().map_or([0; 2], |t| t.wrap),
            });
            candidate.materials[material].maps[slot] = id;
            if slot == 8
                && candidate.materials[material].layers.displacement_projection == 0
                && candidate
                    .meshes
                    .iter()
                    .filter(|m| m.material == material)
                    .any(|m| candidate.geometries[m.geometry].uv[0].is_empty())
            {
                candidate.materials[material].layers.displacement_projection = 1;
            }
        }
        self.materials = candidate.materials;
        self.properties = candidate.properties;
        self.textures = candidate.textures;
        Ok(())
    }
    fn compact_textures(&mut self) {
        let mut ids = vec![u32::MAX; self.textures.len()];
        let mut textures = Vec::new();
        for (i, material) in self.materials.iter_mut().enumerate() {
            let extensions = self.properties[i]
                .iter_mut()
                .filter(|(id, _)| texture_property(**id))
                .map(|(_, value)| &mut value[0]);
            for id in material.maps.iter_mut().chain(extensions) {
                if *id == u32::MAX {
                    continue;
                }
                let old = *id as usize;
                if ids[old] == u32::MAX {
                    ids[old] = textures.len() as u32;
                    textures.push(self.textures[old].clone());
                }
                *id = ids[old];
            }
        }
        self.textures = Arc::new(textures);
    }
    fn texture_ids(&self, material: usize) -> impl Iterator<Item = u32> + '_ {
        self.materials[material].maps.into_iter().chain(
            self.properties[material]
                .iter()
                .filter(|(id, _)| texture_property(**id))
                .map(|(_, v)| v[0]),
        )
    }
    pub fn set_texture_sampling(
        &mut self,
        material: usize,
        slot: usize,
        wrap: [u32; 2],
        scale: [f32; 2],
    ) -> Result<bool> {
        ensure!(
            wrap.iter().all(|v| *v <= 2) && scale.iter().all(|v| v.is_finite()),
            "Invalid texture sampling"
        );
        ensure!(
            material < self.materials.len() && slot < 9,
            "Unknown material texture slot"
        );
        let id = self.materials[material].maps[slot];
        ensure!(id != u32::MAX, "Texture slot is empty");
        let texture = &self.textures[id as usize];
        if texture.wrap == wrap && texture.scale == scale {
            return Ok(false);
        }
        let shared = self
            .materials
            .iter()
            .enumerate()
            .flat_map(|(i, _)| self.texture_ids(i))
            .filter(|map| *map == id)
            .count()
            > 1;
        let target = if shared {
            // Sampling belongs to this material slot; share immutable pixels with the new record.
            ensure!(
                self.textures.len() < 65535,
                "Texture limit reached; cannot separate this shared map"
            );
            let texture = texture.clone();
            let target = self.textures.len();
            Arc::make_mut(&mut self.textures).push(texture);
            self.materials[material].maps[slot] = target as u32;
            target
        } else {
            id as usize
        };
        let texture = &mut Arc::make_mut(&mut self.textures)[target];
        texture.wrap = wrap;
        texture.scale = scale;
        Ok(true)
    }
    pub(super) fn add_map(
        &mut self,
        texture: gltf::Texture<'_>,
        uv: u32,
        transform: Option<([f32; 2], [f32; 2], f32, Option<u32>)>,
        images: &[super::decode::DecodedImage],
        rgba: &[Arc<[u8]>],
    ) -> Result<u32> {
        self.add_map_with_budget(
            texture,
            uv,
            transform,
            images,
            rgba,
            super::decode::material_texel_budget(),
        )
    }
    fn add_map_with_budget(
        &mut self,
        texture: gltf::Texture<'_>,
        uv: u32,
        transform: Option<([f32; 2], [f32; 2], f32, Option<u32>)>,
        images: &[super::decode::DecodedImage],
        rgba: &[Arc<[u8]>],
        budget: u64,
    ) -> Result<u32> {
        let (offset, scale, rotation, override_uv) =
            transform.unwrap_or(([0.; 2], [1.; 2], 0., None));
        let uv = override_uv.unwrap_or(uv);
        ensure!(uv <= 1, "Only TEXCOORD_0/1 are supported");
        if rotation != 0. {
            self.warnings
                .push("Texture rotation is ignored; offset and scale are applied.".into());
        }
        let sampler = texture.sampler();
        let mode = |wrap| match wrap {
            gltf::texture::WrappingMode::Repeat => 0,
            gltf::texture::WrappingMode::ClampToEdge => 1,
            gltf::texture::WrappingMode::MirroredRepeat => 2,
        };
        let wrap = [mode(sampler.wrap_s()), mode(sampler.wrap_t())];
        let image_index = texture.source().index();
        let source = rgba
            .iter()
            .position(|p| Arc::ptr_eq(p, &rgba[image_index]))
            .unwrap();
        let image = &images[source];
        ensure!(
            image.width as u64 * image.height as u64 <= 67_108_864,
            "Source material texture exceeds 64M pixels"
        );
        if let Some(id) = self.textures.iter().position(|t| {
            t.source == source
                && t.uv == uv
                && t.scale == scale
                && t.offset == offset
                && t.wrap == wrap
        }) {
            return Ok(id as u32);
        }
        ensure!(
            self.textures.len() < 65535,
            "Material texture count exceeds 65535"
        );
        let id = self.textures.len() as u32;
        let shared = self.textures.iter().find(|t| t.source == source);
        let used = super::super::encoder::texture_texels(&self.textures);
        let available = budget.saturating_sub(used);
        let texels = image.width as u64 * image.height as u64;
        ensure!(
            shared.is_some() || available > 0,
            "Material texture budget is full"
        );
        let (width, height, pixels) = if let Some(t) = shared {
            (t.width, t.height, t.pixels.clone())
        } else if texels > available {
            let factor = (available as f64 / texels as f64).sqrt();
            let width = (image.width as f64 * factor).floor().max(1.) as u32;
            let height = (image.height as f64 * factor).floor().max(1.) as u32;
            let input = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(
                image.width,
                image.height,
                rgba[source].as_ref(),
            )
            .context("Invalid decoded texture size")?;
            if !self.warnings.iter().any(|w| w == TEXTURE_BUDGET_WARNING) {
                self.warnings.push(TEXTURE_BUDGET_WARNING.into());
            }
            (
                width,
                height,
                image::imageops::resize(
                    &input,
                    width,
                    height,
                    image::imageops::FilterType::Triangle,
                )
                .into_raw()
                .into(),
            )
        } else {
            (image.width, image.height, rgba[source].clone())
        };
        Arc::make_mut(&mut self.textures).push(Texture {
            float_pixels: None,
            storage: 0,
            flip_y: false,
            source,
            width,
            height,
            pixels,
            uv,
            scale,
            offset,
            wrap,
        });
        Ok(id)
    }
    fn visit(
        &mut self,
        node: gltf::Node<'_>,
        parent: Mat4,
        buffers: &[gltf::buffer::Data],
        cache: &mut HashMap<(usize, usize, usize), usize>,
        document: &gltf::Document,
        worlds: &[Mat4],
        profile: &mut ImportProfile,
        depth: usize,
    ) -> Result<()> {
        ensure!(
            depth < 512,
            "Node hierarchy exceeds 512 levels or contains a cycle"
        );
        let transform = parent * Mat4::from_cols_array_2d(&node.transform().matrix());
        ensure!(
            crate::scene::invertible_affine(&transform.to_cols_array()),
            "Node transform must be finite and invertible"
        );
        if let Some(mesh) = node.mesh() {
            for primitive in mesh.primitives() {
                let unique = node.skin().is_some() || primitive.morph_targets().len() > 0;
                let key = (
                    mesh.index(),
                    primitive.index(),
                    if unique { node.index() } else { usize::MAX },
                );
                let index = if let Some(&index) = cache.get(&key) {
                    index
                } else {
                    let attributes_started = profile.start();
                    let reader = primitive.reader(|b| Some(&buffers[b.index()]));
                    let positions = float_attribute(
                        primitive.get(&gltf::Semantic::Positions),
                        buffers,
                        3,
                        profile,
                        || {
                            reader
                                .read_positions()
                                .map(|v| v.flatten().collect::<Vec<_>>().into())
                        },
                    )
                    .context("Mesh is missing POSITION")?;
                    let input: Vec<u32> = reader
                        .read_indices()
                        .map(|i| i.into_u32().collect())
                        .unwrap_or_else(|| (0..positions.len() as u32 / 3).collect());
                    let mut indices = vec![];
                    match primitive.mode() {
                        gltf::mesh::Mode::Triangles => indices = input,
                        gltf::mesh::Mode::TriangleStrip => {
                            for i in 2..input.len() {
                                indices.extend(if i % 2 == 0 {
                                    [input[i - 2], input[i - 1], input[i]]
                                } else {
                                    [input[i - 1], input[i - 2], input[i]]
                                });
                            }
                        }
                        gltf::mesh::Mode::TriangleFan => {
                            for i in 2..input.len() {
                                indices.extend([input[0], input[i - 1], input[i]]);
                            }
                        }
                        _ => bail!(
                            "Only triangle, triangle-strip and triangle-fan primitives are supported"
                        ),
                    }
                    let colors = float_attribute(
                        primitive.get(&gltf::Semantic::Colors(0)),
                        buffers,
                        3,
                        profile,
                        || {
                            reader.read_colors(0).map(|c| {
                                let rgba: Vec<_> = c.into_rgba_f32().collect();
                                if rgba.iter().any(|c| c[3] != 1.) {
                                    self.warnings.push(
                                        "Vertex color alpha is ignored; RGB is preserved.".into(),
                                    );
                                }
                                rgba.into_iter()
                                    .flat_map(|c| [c[0], c[1], c[2]])
                                    .collect::<Vec<_>>()
                                    .into()
                            })
                        },
                    )
                    .unwrap_or_default();
                    let mut geometry = Geometry {
                        material_indices: Arc::from([]),
                        min: Vec3::ZERO,
                        max: Vec3::ZERO,
                        positions,
                        indices: indices.into(),
                        normals: float_attribute(
                            primitive.get(&gltf::Semantic::Normals),
                            buffers,
                            3,
                            profile,
                            || {
                                reader
                                    .read_normals()
                                    .map(|v| v.flatten().collect::<Vec<_>>().into())
                            },
                        )
                        .unwrap_or_default(),
                        uv: [0, 1].map(|i| {
                            float_attribute(
                                primitive.get(&gltf::Semantic::TexCoords(i)),
                                buffers,
                                2,
                                profile,
                                || {
                                    reader
                                        .read_tex_coords(i)
                                        .map(|v| v.into_f32().flatten().collect::<Vec<_>>().into())
                                },
                            )
                            .unwrap_or_default()
                        }),
                        colors,
                        tangents: float_attribute(
                            primitive.get(&gltf::Semantic::Tangents),
                            buffers,
                            4,
                            profile,
                            || {
                                reader
                                    .read_tangents()
                                    .map(|v| v.flatten().collect::<Vec<_>>().into())
                            },
                        )
                        .unwrap_or_default(),
                    };
                    if let Some(start) = attributes_started {
                        profile.attributes_ms += start.elapsed().as_secs_f64() * 1000.;
                    }
                    let validation_started = profile.start();
                    ensure!(
                        geometry.indices.len() % 3 == 0
                            && geometry
                                .indices
                                .iter()
                                .all(|&i| (i as usize) < geometry.positions.len() / 3),
                        "Invalid triangle indices"
                    );
                    if let Some(start) = validation_started {
                        profile.index_validation_ms += start.elapsed().as_secs_f64() * 1000.;
                    }
                    let deformation_started = profile.start();
                    if let Some(animation) = &mut self.animation {
                        animation.bind_geometry(
                            &node,
                            &primitive,
                            buffers,
                            self.geometries.len(),
                            &geometry,
                        )?;
                    }
                    let weights = node.weights().or_else(|| mesh.weights()).unwrap_or(&[]);
                    for (i, (positions, normals, tangents)) in
                        reader.read_morph_targets().enumerate()
                    {
                        let weight = weights.get(i).copied().unwrap_or(0.);
                        for (target, delta, stride) in [
                            (&mut geometry.positions, positions, 3),
                            (&mut geometry.normals, normals, 3),
                            (&mut geometry.tangents, tangents, 4),
                        ] {
                            if let Some(delta) = delta {
                                for (vertex, d) in delta.enumerate() {
                                    for k in 0..3 {
                                        if let Some(v) =
                                            Arc::make_mut(target).get_mut(vertex * stride + k)
                                        {
                                            *v += weight * d[k];
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let Some(skin) = node.skin() {
                        let inverse: Vec<_> = skin
                            .reader(|b| Some(&buffers[b.index()]))
                            .read_inverse_bind_matrices()
                            .map(|v| v.map(|m| Mat4::from_cols_array_2d(&m)).collect())
                            .unwrap_or_else(|| vec![Mat4::IDENTITY; skin.joints().len()]);
                        ensure!(
                            inverse.len() == skin.joints().len(),
                            "Invalid inverse bind matrix count"
                        );
                        let joints: Vec<_> = skin
                            .joints()
                            .zip(inverse)
                            .map(|(n, bind)| transform.inverse() * worlds[n.index()] * bind)
                            .collect();
                        let ids: Vec<_> = reader
                            .read_joints(0)
                            .context("Skinned mesh has no JOINTS_0")?
                            .into_u16()
                            .collect();
                        let weights: Vec<_> = reader
                            .read_weights(0)
                            .context("Skinned mesh has no WEIGHTS_0")?
                            .into_f32()
                            .collect();
                        ensure!(
                            ids.len() == geometry.positions.len() / 3 && ids.len() == weights.len(),
                            "Invalid skin attribute count"
                        );
                        ensure!(
                            reader.read_joints(1).is_none(),
                            "More than four skin influences are unsupported"
                        );
                        for (vertex, (ids, weights)) in ids.iter().zip(&weights).enumerate() {
                            let sum: f32 = weights.iter().sum();
                            ensure!(sum.is_finite() && sum > 0., "Invalid skin weights");
                            let mut matrix = Mat4::ZERO;
                            for k in 0..4 {
                                matrix +=
                                    *joints.get(ids[k] as usize).context("Invalid skin joint")?
                                        * (weights[k] / sum);
                            }
                            let p = matrix.transform_point3(Vec3::from_slice(
                                &geometry.positions[vertex * 3..vertex * 3 + 3],
                            ));
                            Arc::make_mut(&mut geometry.positions)[vertex * 3..vertex * 3 + 3]
                                .copy_from_slice(&p.to_array());
                            for (data, stride) in
                                [(&mut geometry.normals, 3), (&mut geometry.tangents, 4)]
                            {
                                if !data.is_empty() {
                                    let n = matrix
                                        .transform_vector3(Vec3::from_slice(
                                            &data[vertex * stride..vertex * stride + 3],
                                        ))
                                        .normalize_or_zero();
                                    Arc::make_mut(data)[vertex * stride..vertex * stride + 3]
                                        .copy_from_slice(&n.to_array());
                                }
                            }
                        }
                    }
                    if let Some(start) = deformation_started {
                        profile.deformation_ms += start.elapsed().as_secs_f64() * 1000.;
                    }
                    if !profile.defer_bounds {
                        let start = profile.start();
                        (geometry.min, geometry.max) = local_bounds(&geometry.positions);
                        if let Some(start) = start {
                            profile.local_bounds_ms += start.elapsed().as_secs_f64() * 1000.;
                        }
                    }
                    let index = self.geometries.len();
                    Arc::make_mut(&mut self.geometries).push(geometry);
                    cache.insert(key, index);
                    index
                };
                let mut instances = vec![Mat4::IDENTITY];
                if let Some(ext) = node.extension_value("EXT_mesh_gpu_instancing") {
                    let attrs = &ext["attributes"];
                    let read3 = |name: &str| -> Result<Option<Vec<[f32; 3]>>> {
                        let Some(id) = attrs[name].as_u64() else {
                            return Ok(None);
                        };
                        let a = document
                            .accessors()
                            .nth(id as usize)
                            .context("Invalid instance accessor")?;
                        Ok(Some(
                            gltf::accessor::Iter::<[f32; 3]>::new(a, |b| Some(&buffers[b.index()]))
                                .context("Invalid instance attribute")?
                                .collect(),
                        ))
                    };
                    let translation = read3("TRANSLATION")?;
                    let scale = read3("SCALE")?;
                    let rotation = if let Some(id) = attrs["ROTATION"].as_u64() {
                        let a = document
                            .accessors()
                            .nth(id as usize)
                            .context("Invalid rotation accessor")?;
                        ensure!(
                            a.data_type() == gltf::accessor::DataType::F32,
                            "Quantized instance rotation is unsupported"
                        );
                        Some(
                            gltf::accessor::Iter::<[f32; 4]>::new(a, |b| Some(&buffers[b.index()]))
                                .context("Invalid instance rotation")?
                                .collect::<Vec<_>>(),
                        )
                    } else {
                        None
                    };
                    let count = translation
                        .as_ref()
                        .map(Vec::len)
                        .or_else(|| scale.as_ref().map(Vec::len))
                        .or_else(|| rotation.as_ref().map(Vec::len))
                        .context("Instance transforms missing")?;
                    ensure!(
                        count <= crate::scene::instance_limit()
                            && translation.as_ref().is_none_or(|v| v.len() == count)
                            && scale.as_ref().is_none_or(|v| v.len() == count)
                            && rotation.as_ref().is_none_or(|v| v.len() == count),
                        "Invalid instance counts"
                    );
                    instances = (0..count)
                        .map(|i| {
                            Mat4::from_scale_rotation_translation(
                                scale
                                    .as_ref()
                                    .map(|v| Vec3::from(v[i]))
                                    .unwrap_or(Vec3::ONE),
                                rotation
                                    .as_ref()
                                    .map(|v| glam::Quat::from_array(v[i]).normalize())
                                    .unwrap_or(glam::Quat::IDENTITY),
                                translation
                                    .as_ref()
                                    .map(|v| Vec3::from(v[i]))
                                    .unwrap_or(Vec3::ZERO),
                            )
                        })
                        .collect();
                }
                for (instance, local) in instances.into_iter().enumerate() {
                    let matrix = transform * local;
                    ensure!(
                        crate::scene::invertible_affine(&matrix.to_cols_array()),
                        "Invalid instance transform"
                    );
                    self.node_indices.push(node.index());
                    self.node_names.push(node.name().unwrap_or("").into());
                    self.mesh_names.push(mesh.name().unwrap_or("").into());
                    self.meshes.push(Mesh {
                        materials: vec![],
                        instances: None,
                        name: format!(
                            "{} / {}{}",
                            node.name()
                                .or_else(|| mesh.name())
                                .map(str::to_owned)
                                .unwrap_or_else(|| format!("Mesh {}", node.index() + 1)),
                            primitive.index() + 1,
                            if instance == 0 {
                                String::new()
                            } else {
                                format!(" · {}", instance + 1)
                            }
                        ),
                        geometry: index,
                        material: primitive
                            .material()
                            .index()
                            .unwrap_or(self.materials.len() - 1),
                        transform: matrix,
                    });
                    if let Some(animation) = &mut self.animation {
                        animation.bind_mesh(node.index(), local);
                    }
                }
            }
        }
        for child in node.children() {
            self.visit(
                child,
                transform,
                buffers,
                cache,
                document,
                worlds,
                profile,
                depth + 1,
            )?;
        }
        Ok(())
    }
}

impl Model {
    pub fn refresh_bounds(&mut self) {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for id in 0..self.meshes.len() {
            let (lo, hi) = self.mesh_bounds(id);
            min = min.min(lo);
            max = max.max(hi);
        }
        self.center = (min + max) * 0.5;
        self.radius = (max - min).length() * 0.5;
        self.ground_y = min.y;
    }
    pub fn mesh_bounds(&self, id: usize) -> (Vec3, Vec3) {
        let mesh = &self.meshes[id];
        let geometry = &self.geometries[mesh.geometry];
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for x in [geometry.min.x, geometry.max.x] {
            for y in [geometry.min.y, geometry.max.y] {
                for z in [geometry.min.z, geometry.max.z] {
                    let p = mesh.transform.transform_point3(Vec3::new(x, y, z));
                    min = min.min(p);
                    max = max.max(p);
                }
            }
        }
        (min, max)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_maps_keep_independent_gltf_sampler_modes() {
        let document = gltf::Gltf::from_slice(br#"{"asset":{"version":"2.0"},"images":[{"uri":"unused.png"}],"samplers":[{"wrapS":33071,"wrapT":33648},{}],"textures":[{"source":0,"sampler":0},{"source":0,"sampler":1}]}"#).unwrap();
        let image = super::super::decode::DecodedImage {
            pixels: vec![255; 4].into(),
            width: 1,
            height: 1,
        };
        let mut model =
            Model::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../viewer/assets/sample.glb"))
                .unwrap();
        let pixels = vec![image.pixels.clone()];
        for texture in document.textures() {
            model
                .add_map(texture, 0, None, std::slice::from_ref(&image), &pixels)
                .unwrap();
        }
        assert_eq!(model.textures.len(), 2);
        assert_eq!(model.textures[0].wrap, [1, 2]);
        assert_eq!(model.textures[1].wrap, [0, 0]);
    }
    #[test]
    fn sampler_copies_of_one_image_share_the_texture_budget() {
        let samplers: Vec<_> = (0..9)
            .map(|i| {
                let modes = [10497, 33071, 33648];
                serde_json::json!({"wrapS": modes[i % 3], "wrapT": modes[i / 3]})
            })
            .collect();
        let textures: Vec<_> = (0..9)
            .map(|i| serde_json::json!({"source": 0, "sampler": i}))
            .collect();
        let json = serde_json::json!({"asset":{"version":"2.0"},"images":[{"uri":"unused.png"}],
            "samplers":samplers,"textures":textures});
        let document = gltf::Gltf::from_slice(&serde_json::to_vec(&json).unwrap()).unwrap();
        let (width, height) = (1500, 1500);
        let image = super::super::decode::DecodedImage {
            pixels: vec![255; width * height * 4].into(),
            width: width as u32,
            height: height as u32,
        };
        let mut model =
            Model::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../viewer/assets/sample.glb"))
                .unwrap();
        let pixels = vec![image.pixels.clone()];
        for texture in document.textures() {
            model
                .add_map_with_budget(
                    texture,
                    0,
                    None,
                    std::slice::from_ref(&image),
                    &pixels,
                    2_250_000,
                )
                .unwrap();
        }
        assert_eq!(model.textures.len(), 9);
        assert_eq!(
            super::super::super::encoder::texture_texels(&model.textures),
            2_250_000
        );
        for t in model.textures.iter() {
            assert_eq!((t.width, t.height), (1500, 1500));
            assert!(Arc::ptr_eq(&t.pixels, &pixels[0]));
        }
        assert!(!model.warnings.iter().any(|w| w == TEXTURE_BUDGET_WARNING));
    }
}

#[cfg(test)]
#[path = "attribute_tests.rs"]
mod attribute_tests;
