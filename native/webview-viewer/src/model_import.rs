//! Viewer-private retained glTF resources. The SDK descriptor format stays v8;
//! compact UI descriptors are hydrated before the SDK sees them.
use super::*;
use mutracer_native::{
    layout::{geometry as g, header as h, texture as t},
    scene_api::viewer_support::{Environment, Model, SceneData},
};
use std::collections::{BTreeSet, HashMap};

// GLTFLoader remains the compatibility path for features the local SDK importer
// cannot preserve, including animation controls and browser-only image decoders.
pub fn requires_js(document: &Value) -> bool {
    document["animations"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
        || document["extensionsUsed"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|v| {
                matches!(
                    v.as_str(),
                    Some("KHR_draco_mesh_compression" | "KHR_texture_basisu" | "EXT_texture_avif")
                )
            })
        || document["extensionsRequired"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|v| v == "KHR_lights_punctual")
        || ["buffers", "images"].iter().any(|field| {
            document[field].as_array().into_iter().flatten().any(|v| {
                v["uri"]
                    .as_str()
                    .is_some_and(|uri| uri.starts_with("http:") || uri.starts_with("https:"))
            })
        })
        || document["nodes"].as_array().into_iter().flatten().any(|v| {
            let attributes = &v["extensions"]["EXT_mesh_gpu_instancing"]["attributes"];
            !attributes["_COLOR_0"].is_null() || !attributes["COLOR_0"].is_null()
        })
}

pub type Shared = Arc<Mutex<Pool>>;
#[derive(Default)]
pub struct Pool {
    serial: u64,
    models: HashMap<u64, (Model, bool)>,
}
impl Pool {
    pub fn release(&mut self, id: u64) {
        if let Some((_, released)) = self.models.get_mut(&id) {
            *released = true;
        }
    }
    pub fn collect(&mut self, active: &BTreeSet<u64>) {
        self.models
            .retain(|id, (_, released)| !*released || active.contains(id));
    }
    pub fn clear(&mut self) {
        self.models.clear();
    }
    pub fn insert(
        &mut self,
        model: Model,
        mut document: Value,
        mailbox: &binary::Shared,
    ) -> Result<Value> {
        self.serial += 1;
        let id = self.serial;
        let mut geometries = (*model.geometries).clone();
        let geometry_info = model
            .geometries
            .iter()
            .map(|geo| {
                json!({"min":geo.min.to_array(),"max":geo.max.to_array(),
                "vertices":geo.positions.len()/3,"indices":geo.indices.len(),
                "uv":!geo.uv[0].is_empty(),"uv1":!geo.uv[1].is_empty(),
                "tangent":!geo.tangents.is_empty(),"normal":!geo.normals.is_empty(),"color":!geo.colors.is_empty()})
            })
            .collect::<Vec<_>>();
        for geo in &mut geometries {
            geo.positions = Arc::from([]);
            geo.indices = Arc::from([]);
            geo.normals = Arc::from([]);
            geo.uv = [Arc::from([]), Arc::from([])];
            geo.colors = Arc::from([]);
            geo.tangents = Arc::from([]);
            geo.material_indices = Arc::from([]);
        }
        let texture_info = model
            .textures
            .iter()
            .map(|texture| {
                let width = texture.width.clamp(1, 32);
                let height = texture.height.clamp(1, 32);
                let mut preview = Vec::with_capacity((width * height * 4) as usize);
                for y in 0..height {
                    for x in 0..width {
                        let at = (((y * texture.height / height) * texture.width
                            + x * texture.width / width)
                            * 4) as usize;
                        for c in 0..4 {
                            preview.push(if let Some(f) = &texture.float_pixels {
                                (f[at + c].clamp(0., 1.) * 255.) as u8
                            } else {
                                texture.pixels[at + c]
                            });
                        }
                    }
                }
                json!({"width":texture.width,"height":texture.height,"storage":texture.storage,
                "preview":{"width":width,"height":height,"data":preview}})
            })
            .collect::<Vec<_>>();
        let mut textures = (*model.textures).clone();
        for texture in &mut textures {
            texture.width = 1;
            texture.height = 1;
            texture.storage = 0;
            texture.pixels = Arc::from([255, 255, 255, 255]);
            texture.float_pixels = None;
        }
        let environment = Environment {
            enabled: false,
            width: 0,
            height: 0,
            pixels: Arc::from([]),
            background: false,
            background_color: [0.; 3],
            background_alpha: 1.,
        };
        let words = SceneData {
            geometries: &geometries,
            materials: &model.materials,
            textures: &textures,
            properties: &model.properties,
            meshes: &model.meshes,
            lights: vec![],
            ies: vec![],
        }
        .encode(&api::Camera::default().to_bytes(), [1, 1], &environment);
        let blob = mailbox
            .lock()
            .unwrap()
            .put(words.iter().flat_map(|v| v.to_le_bytes()).collect());
        let mut meshes: Vec<Value> = Vec::new();
        for (index, mesh) in model.meshes.iter().enumerate() {
            let node = model.node_indices[index];
            let instanced =
                !document["nodes"][node]["extensions"]["EXT_mesh_gpu_instancing"].is_null();
            if instanced
                && meshes.last().is_some_and(|last| {
                    last["node"] == node
                        && last["geometry"] == mesh.geometry
                        && last["material"] == mesh.material
                })
            {
                let last = meshes.last_mut().unwrap();
                last["count"] = json!(last["count"].as_u64().unwrap() + 1);
            } else {
                meshes.push(json!({"node":node,"name":model.mesh_names[index],"geometry":mesh.geometry,"material":mesh.material,"first":index,"count":1}));
            }
        }
        // Saved material edits identify the source traversal index and name.
        // Preserve GLTFLoader's empty name for unnamed/default materials.
        let material_names = (0..model.materials.len())
            .map(|index| {
                document["materials"][index]["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        // The UI only needs hierarchy, material factors, lights and cameras.
        // In particular, inline data URIs must not send native payloads back
        // through the manifest as base64 strings.
        if let Some(object) = document.as_object_mut() {
            for key in [
                "buffers",
                "bufferViews",
                "accessors",
                "images",
                "textures",
                "meshes",
            ] {
                object.remove(key);
            }
        }
        let result = json!({"id":id,"document":document,"descriptor":blob,"geometries":geometry_info,"textures":texture_info,"meshes":meshes,"materialNames":material_names,"groundOffset":[model.center.x,model.ground_y,model.center.z],"warnings":model.warnings});
        self.models.insert(id, (model, false));
        Ok(result)
    }
    pub fn hydrate(&self, compact: &[u8], refs: &Value) -> Result<(Vec<u8>, BTreeSet<u64>)> {
        ensure!(
            compact.len() % 4 == 0 && compact.len() >= h::WORDS * 4,
            "Invalid compact scene"
        );
        let mut words = compact
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>();
        ensure!(
            words[h::LENGTH] as usize == words.len(),
            "Invalid compact length"
        );
        for (count, offset, stride) in [
            (h::GEOMETRY_COUNT, h::GEOMETRY_OFFSET, g::WORDS),
            (h::TEXTURE_COUNT, h::TEXTURE_OFFSET, t::WORDS),
        ] {
            let start = words[offset] as usize;
            let length = (words[count] as usize)
                .checked_mul(stride)
                .context("Record table size")?;
            ensure!(
                start <= words.len() && length <= words.len() - start,
                "Invalid compact table"
            );
        }
        let mut body = compact.to_vec();
        let mut additional = 0usize;
        for entry in refs["geometries"].as_array().into_iter().flatten() {
            let model = &self
                .models
                .get(&entry["model"].as_u64().context("Geometry model")?)
                .context("Unknown retained model")?
                .0;
            let geo = model
                .geometries
                .get(entry["id"].as_u64().context("Geometry id")? as usize)
                .context("Unknown retained geometry")?;
            let count = geo.positions.len()
                + geo.indices.len()
                + geo.normals.len()
                + geo.uv[0].len()
                + geo.uv[1].len()
                + geo.colors.len()
                + geo.tangents.len()
                + geo.material_indices.len();
            additional = additional
                .checked_add(count.checked_mul(4).context("Geometry size")?)
                .context("Scene size")?;
        }
        let mut seen = std::collections::HashSet::new();
        for entry in refs["textures"].as_array().into_iter().flatten() {
            let model = &self
                .models
                .get(&entry["model"].as_u64().context("Texture model")?)
                .context("Unknown retained model")?
                .0;
            let texture = model
                .textures
                .get(entry["id"].as_u64().context("Texture id")? as usize)
                .context("Unknown retained texture")?;
            let (pointer, length, storage) = if let Some(p) = &texture.float_pixels {
                (p.as_ptr() as usize, p.len() * 4, 1)
            } else {
                (
                    texture.pixels.as_ptr() as usize,
                    texture.pixels.len().div_ceil(4) * 4,
                    0,
                )
            };
            if seen.insert((pointer, length, storage)) {
                additional = additional.checked_add(length).context("Scene size")?;
            }
        }
        body.try_reserve_exact(additional)
            .context("Cannot allocate retained scene descriptor")?;
        let mut active = BTreeSet::new();
        let mut pixel_offsets = HashMap::new();
        for entry in refs["geometries"].as_array().into_iter().flatten() {
            let model_id = entry["model"].as_u64().context("Geometry model")?;
            let index = entry["id"].as_u64().context("Geometry id")? as usize;
            let model = &self
                .models
                .get(&model_id)
                .context("Unknown retained model")?
                .0;
            let geometry = model
                .geometries
                .get(index)
                .context("Unknown retained geometry")?;
            active.insert(model_id);
            let slot = entry["index"].as_u64().context("Geometry slot")? as usize;
            ensure!(
                slot < words[h::GEOMETRY_COUNT] as usize,
                "Geometry slot out of range"
            );
            let o = words[h::GEOMETRY_OFFSET] as usize + slot * g::WORDS;
            words[o + g::VERTEX_COUNT] = (geometry.positions.len() / 3) as u32;
            words[o + g::INDEX_COUNT] = geometry.indices.len() as u32;
            for (field, values) in [
                (g::POSITION, &geometry.positions),
                (g::NORMAL, &geometry.normals),
                (g::UV, &geometry.uv[0]),
                (g::UV1, &geometry.uv[1]),
                (g::COLOR, &geometry.colors),
                (g::TANGENT, &geometry.tangents),
            ] {
                if !values.is_empty() {
                    words[o + field] = append_floats(&mut body, values)?;
                }
            }
            for (field, values) in [
                (g::INDICES, &geometry.indices),
                (g::MATERIAL_INDEX, &geometry.material_indices),
            ] {
                if !values.is_empty() {
                    words[o + field] = append_indices(&mut body, values)?;
                }
            }
        }
        for entry in refs["textures"].as_array().into_iter().flatten() {
            let model_id = entry["model"].as_u64().context("Texture model")?;
            let index = entry["id"].as_u64().context("Texture id")? as usize;
            let model = &self
                .models
                .get(&model_id)
                .context("Unknown retained model")?
                .0;
            let texture = model
                .textures
                .get(index)
                .context("Unknown retained texture")?;
            active.insert(model_id);
            let slot = entry["index"].as_u64().context("Texture slot")? as usize;
            ensure!(
                slot < words[h::TEXTURE_COUNT] as usize,
                "Texture slot out of range"
            );
            let o = words[h::TEXTURE_OFFSET] as usize + slot * t::WORDS;
            words[o + t::WIDTH] = texture.width;
            words[o + t::HEIGHT] = texture.height;
            words[o + t::STORAGE] = texture.storage;
            let key = if let Some(p) = &texture.float_pixels {
                (p.as_ptr() as usize, p.len(), 1)
            } else {
                (texture.pixels.as_ptr() as usize, texture.pixels.len(), 0)
            };
            let offset = if let Some(&offset) = pixel_offsets.get(&key) {
                offset
            } else {
                let offset = if let Some(p) = &texture.float_pixels {
                    append_floats(&mut body, p)?
                } else {
                    append_bytes(&mut body, &texture.pixels)?
                };
                pixel_offsets.insert(key, offset);
                offset
            };
            words[o + t::PIXELS] = offset;
        }
        words[h::LENGTH] = u32::try_from(body.len() / 4).context("Scene descriptor limit")?;
        for (bytes, word) in body[..compact.len()].chunks_exact_mut(4).zip(words) {
            bytes.copy_from_slice(&word.to_le_bytes());
        }
        Ok((body, active))
    }
}
fn append_bytes(bytes: &mut Vec<u8>, values: &[u8]) -> Result<u32> {
    ensure!(values.len() % 4 == 0, "Unaligned retained payload");
    let offset = u32::try_from(bytes.len() / 4).context("Scene descriptor limit")?;
    bytes.extend_from_slice(values);
    ensure!(
        bytes.len() / 4 <= u32::MAX as usize,
        "Scene descriptor limit"
    );
    Ok(offset)
}
fn append_floats(bytes: &mut Vec<u8>, values: &[f32]) -> Result<u32> {
    // f32/u32 have no padding. All supported native targets are little-endian,
    // which is also required by the SDK's indexed descriptor adapter.
    #[cfg(not(target_endian = "little"))]
    compile_error!("Native viewer requires little-endian descriptors");
    let data = unsafe {
        std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values))
    };
    append_bytes(bytes, data)
}
fn append_indices(bytes: &mut Vec<u8>, values: &[u32]) -> Result<u32> {
    let data = unsafe {
        std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values))
    };
    append_bytes(bytes, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_features_fall_back_without_rejecting_native_instancing() {
        assert!(!requires_js(
            &json!({"nodes":[{"extensions":{"EXT_mesh_gpu_instancing":{"attributes":{"TRANSLATION":0}}}}]})
        ));
        for document in [
            json!({"animations":[{}]}),
            json!({"extensionsUsed":["KHR_draco_mesh_compression"]}),
            json!({"images":[{"uri":"https://example.test/image.png"}]}),
            json!({"nodes":[{"extensions":{"EXT_mesh_gpu_instancing":{"attributes":{"_COLOR_0":0}}}}]}),
        ] {
            assert!(requires_js(&document));
        }
    }
    #[test]
    fn compact_manifest_retains_payloads_and_sampler_edits() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../validation/assets/sample.glb");
        let mut model = Model::load(&path).unwrap();
        model.textures = Arc::new(vec![mutracer_native::scene_api::viewer_support::Texture {
            float_pixels: None,
            storage: 0,
            flip_y: false,
            source: 0,
            width: 2,
            height: 2,
            pixels: Arc::from([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
            wrap: [0; 2],
            udim: false,
        }]);
        model.materials[0].maps[0] = 0;
        let expected_vertices = model.geometries[0].positions.clone();
        let expected_pixels = model.textures[0].pixels.clone();
        let mailbox = binary::Shared::default();
        let mut pool = Pool::default();
        let mut document = initial_files::read_document(&path).unwrap();
        document["images"] = json!([{"uri":"data:image/png;base64,native-image-payload"}]);
        document["buffers"] =
            json!([{"uri":"data:application/octet-stream;base64,native-buffer-payload"}]);
        let manifest = pool.insert(model, document, &mailbox).unwrap();
        assert!(manifest["document"]["images"].is_null());
        assert!(manifest["document"]["buffers"].is_null());
        assert!(manifest["document"]["nodes"].is_array());
        let id = manifest["id"].as_u64().unwrap();
        let mut compact = mailbox
            .lock()
            .unwrap()
            .take(manifest["descriptor"].as_str().unwrap())
            .unwrap();
        let word = |bytes: &[u8], at: usize| {
            u32::from_le_bytes(bytes[at * 4..at * 4 + 4].try_into().unwrap())
        };
        let set = |bytes: &mut [u8], at: usize, value: u32| {
            bytes[at * 4..at * 4 + 4].copy_from_slice(&value.to_le_bytes())
        };
        let offset = word(&compact, h::TEXTURE_OFFSET) as usize;
        set(&mut compact, offset + t::WRAP_S, 2);
        let refs = json!({"geometries":manifest["geometries"].as_array().unwrap().iter().enumerate().map(|(index,_)|json!({"model":id,"id":index,"index":index})).collect::<Vec<_>>(),
            "textures":manifest["textures"].as_array().unwrap().iter().enumerate().map(|(index,_)|json!({"model":id,"id":index,"index":index})).collect::<Vec<_>>()});
        let (hydrated, active) = pool.hydrate(&compact, &refs).unwrap();
        let geometry = word(&hydrated, h::GEOMETRY_OFFSET) as usize;
        assert_eq!(
            word(&hydrated, geometry + g::VERTEX_COUNT) as usize,
            expected_vertices.len() / 3
        );
        let positions = word(&hydrated, geometry + g::POSITION) as usize;
        for (i, value) in expected_vertices.iter().enumerate() {
            assert_eq!(word(&hydrated, positions + i), value.to_bits());
        }
        let pixels = word(&hydrated, offset + t::PIXELS) as usize * 4;
        assert_eq!(
            &hydrated[pixels..pixels + expected_pixels.len()],
            expected_pixels.as_ref()
        );
        assert_eq!(word(&hydrated, offset + t::WRAP_S), 2);
        assert_eq!(word(&hydrated, h::LENGTH) as usize * 4, hydrated.len());
        assert!(compact.len() < hydrated.len());
        let mut corrupt = compact.clone();
        set(&mut corrupt, h::GEOMETRY_OFFSET, u32::MAX);
        assert!(pool.hydrate(&corrupt, &refs).is_err());
        pool.release(id);
        pool.collect(&active);
        assert_eq!(pool.models.len(), 1);
        pool.collect(&BTreeSet::new());
        assert!(pool.models.is_empty());
        assert!(pool.hydrate(&compact, &refs).is_err());
        if let Some(out) = std::env::var_os("MUTRACER_NATIVE_IMPORT_FIXTURE") {
            let out = PathBuf::from(out);
            std::fs::create_dir_all(&out).unwrap();
            std::fs::write(
                out.join("manifest.json"),
                serde_json::to_vec_pretty(&manifest).unwrap(),
            )
            .unwrap();
            std::fs::write(out.join("compact.bin"), compact).unwrap();
        }
    }
}

#[cfg(test)]
#[test]
#[ignore = "exports a local glTF fixture for the headless browser comparison"]
fn export_native_gltf_reference() {
    let out = PathBuf::from(std::env::var_os("MUTRACER_NATIVE_GLTF_REFERENCE").unwrap());
    let path = PathBuf::from(std::env::var_os("MUTRACER_NATIVE_GLTF_MODEL").unwrap());
    std::fs::create_dir_all(&out).unwrap();
    let mailbox = binary::Shared::default();
    let manifest = Pool::default()
        .insert(
            Model::load(&path).unwrap(),
            initial_files::read_document(&path).unwrap(),
            &mailbox,
        )
        .unwrap();
    let compact = mailbox
        .lock()
        .unwrap()
        .take(manifest["descriptor"].as_str().unwrap())
        .unwrap();
    std::fs::write(out.join("compact.bin"), compact).unwrap();
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
}

#[cfg(test)]
#[test]
#[ignore = "requires native-gltf-reference.mjs fixtures and a real GPU"]
fn native_gltf_matches_browser_import() {
    let out = PathBuf::from(std::env::var_os("MUTRACER_NATIVE_GLTF_REFERENCE").unwrap());
    let path = PathBuf::from(std::env::var_os("MUTRACER_NATIVE_GLTF_MODEL").unwrap());
    let mut pool = Pool::default();
    pool.insert(
        Model::load(&path).unwrap(),
        initial_files::read_document(&path).unwrap(),
        &binary::Shared::default(),
    )
    .unwrap();
    let compact = std::fs::read(out.join("native-ui.bin")).unwrap();
    let refs: Value =
        serde_json::from_slice(&std::fs::read(out.join("refs.json")).unwrap()).unwrap();
    let native = pool.hydrate(&compact, &refs).unwrap().0;
    let native_only = std::env::var("MUTRACER_NATIVE_GLTF_NATIVE_ONLY").as_deref() == Ok("1");
    let mut cases = Vec::new();
    if !native_only {
        cases.push(("web", std::fs::read(out.join("web.bin")).unwrap()));
    }
    cases.push(("native", native));
    let engine = api::Engine::new(api::EngineOptions {
        backend: api::Backend::Hardware,
    })
    .unwrap();
    let size: [u32; 2] = std::env::var("MUTRACER_NATIVE_GLTF_SIZE")
        .ok()
        .map(|v| {
            v.split('x')
                .map(|n| n.parse().unwrap())
                .collect::<Vec<_>>()
                .try_into()
                .unwrap()
        })
        .unwrap_or([96, 64]);
    let samples = std::env::var("SPP")
        .ok()
        .map(|v| v.parse().unwrap())
        .unwrap_or(64);
    let bounces = std::env::var("MUTRACER_NATIVE_GLTF_BOUNCES")
        .ok()
        .map(|v| v.parse().unwrap())
        .unwrap_or(3);
    engine.display().set_size(size[0] * 2, size[1] * 2).unwrap();
    let render = api::Render::new(
        &engine,
        api::RenderSettings {
            size: api::RenderSize::Scale(0.5),
            max_samples: samples,
            bounces,
            seed: 0,
            ..Default::default()
        },
    )
    .unwrap();
    if std::env::var("MUTRACER_NATIVE_GLTF_BENCHMARK").as_deref() == Ok("1") {
        let mut settings = render.settings().unwrap();
        settings.direct_light_candidates = 2;
        settings.bevel = false;
        settings.dispersion_wavelengths = 1;
        settings.batch_samples = true;
        render.set_settings(settings).unwrap();
    }
    let mut images = Vec::new();
    for (name, bytes) in cases {
        engine.set_scene_shared(Arc::new(bytes)).unwrap();
        engine.update().unwrap();
        render.converge(api::ConvergeOptions::new(samples)).unwrap();
        let image = render.read_pixels(api::PixelKind::Hdr).unwrap();
        assert!(image.data.iter().all(|n| n.is_finite()));
        assert!(
            image
                .data
                .iter()
                .enumerate()
                .any(|(i, v)| i % 4 != 3 && *v > 0.),
            "{name} import is black"
        );
        std::fs::write(
            out.join(format!("{name}.f32")),
            image
                .data
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        std::fs::write(
            out.join(format!("{name}.png")),
            engine.display().encode_png(&render).unwrap(),
        )
        .unwrap();
        for (kind, label) in [
            (api::PixelKind::Albedo, "albedo"),
            (api::PixelKind::Normal, "normal"),
        ] {
            let pixels = render.read_pixels(kind).unwrap();
            std::fs::write(
                out.join(format!("{name}-{label}.f32")),
                pixels
                    .data
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<_>>(),
            )
            .unwrap();
        }
        images.push(image.data);
    }
    if native_only {
        std::fs::write(
            out.join("native-only.json"),
            serde_json::to_vec_pretty(
                &json!({"passed":true,"samples":samples,"bounces":bounces,"size":size,"parity":false,"settings":format!("{:?}",render.settings())}),
            )
            .unwrap(),
        )
        .unwrap();
        return;
    }
    let mut error = 0f64;
    let mut energy = 0f64;
    let mut mse = 0f64;
    let mut count = 0;
    for (index, (a, b)) in images[0].iter().zip(&images[1]).enumerate() {
        if index % 4 == 3 {
            continue;
        }
        let d = f64::from(a - b);
        error += d.abs();
        energy += f64::from(a.abs());
        mse += d * d;
        count += 1;
    }
    let relative = error / energy.max(1e-20);
    std::fs::write(
        out.join("comparison.json"),
        serde_json::to_vec_pretty(
            &json!({"relativeL1":relative,"rmse":(mse/count as f64).sqrt(),"samples":samples}),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(
        relative < 0.1,
        "Import paths disagree: relative L1 {relative}"
    );
}
