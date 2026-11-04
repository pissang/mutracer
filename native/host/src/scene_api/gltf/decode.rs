//! Native glTF extension decoding before the typed, validated scene reader.
//! Meshopt follows Khronos EXT_meshopt_compression; quantization is expanded
//! according to KHR_mesh_quantization before gltf-rs validates FLOAT attributes.
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Arc<[u8]>,
}
#[path = "meshopt.rs"]
mod meshopt_decode;

/// Decoded document, buffers, RGBA8 images and whether any image was reduced.
type Import = (
    gltf::Document,
    Vec<gltf::buffer::Data>,
    Vec<DecodedImage>,
    bool,
    Vec<Value>,
);
pub(super) fn material_texel_budget() -> u64 {
    crate::texture_budget::texels()
}
/// Longest texture side the atlas stores without scaling.
pub(super) const MAX_TEXTURE_EDGE: u32 = 16384;
fn number(v: &Value, name: &str) -> Result<usize> {
    v[name]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .with_context(|| format!("Invalid {name}"))
}
fn uri(path: Option<&Path>, name: &str) -> Result<Vec<u8>> {
    if let Some(data) = name.strip_prefix("data:") {
        let (header, value) = data.split_once(',').context("Invalid data URI")?;
        ensure!(
            header.ends_with(";base64"),
            "Only base64 data URIs are supported"
        );
        Ok(base64::engine::general_purpose::STANDARD.decode(value)?)
    } else {
        ensure!(
            !name.contains("://"),
            "Only local model resources are supported"
        );
        let path = path.context("External resources require a base path")?;
        let decoded = percent_encoding::percent_decode_str(name).decode_utf8()?;
        let p = path
            .parent()
            .unwrap_or(Path::new("."))
            .join(decoded.as_ref());
        crate::memory_budget::check(usize::try_from(p.metadata()?.len())?, "External resource")?;
        Ok(std::fs::read(p)?)
    }
}
fn span(data: &[u8], offset: usize, len: usize) -> Result<&[u8]> {
    data.get(offset..offset.checked_add(len).context("Resource span overflow")?)
        .context("Resource span exceeds buffer")
}
fn view<'a>(j: &Value, buffers: &'a [gltf::buffer::Data], index: usize) -> Result<&'a [u8]> {
    let v = &j["bufferViews"][index];
    span(
        &buffers
            .get(number(v, "buffer")?)
            .context("Invalid buffer reference")?
            .0,
        v["byteOffset"].as_u64().unwrap_or(0) as usize,
        number(v, "byteLength")?,
    )
}
#[cfg(test)]
fn decode(ext: &Value, source: &[u8]) -> Result<Vec<u8>> {
    meshopt_decode::Decoder::new(ext)?.reference(source)
}
fn component(bytes: &[u8], kind: usize, normalized: bool) -> Result<f32> {
    let v = match kind {
        5120 => {
            let v = bytes[0] as i8 as f32;
            if normalized { (v / 127.).max(-1.) } else { v }
        }
        5121 => {
            let v = bytes[0] as f32;
            if normalized { v / 255. } else { v }
        }
        5122 => {
            let v = i16::from_le_bytes(bytes[..2].try_into()?) as f32;
            if normalized { (v / 32767.).max(-1.) } else { v }
        }
        5123 => {
            let v = u16::from_le_bytes(bytes[..2].try_into()?) as f32;
            if normalized { v / 65535. } else { v }
        }
        5126 => f32::from_le_bytes(bytes[..4].try_into()?),
        _ => bail!("Unsupported quantized component type {kind}"),
    };
    ensure!(v.is_finite(), "Non-finite quantized component");
    Ok(v)
}
pub fn load_bytes(bytes: &[u8], path: Option<&Path>) -> Result<Import> {
    load_bytes_mode(bytes, path, meshopt_decode::Mode::from_env())
}
fn load_bytes_mode(
    bytes: &[u8],
    path: Option<&Path>,
    meshopt_mode: meshopt_decode::Mode,
) -> Result<Import> {
    let started = crate::profiling::enabled().then(std::time::Instant::now);
    let (mut j, blob): (Value, Option<std::borrow::Cow<'_, [u8]>>) = if bytes.starts_with(b"glTF") {
        let glb = gltf::Glb::from_slice(&bytes)?;
        (serde_json::from_slice(&glb.json)?, glb.bin)
    } else {
        (serde_json::from_slice(&bytes)?, None)
    };
    for e in j["extensionsRequired"].as_array().into_iter().flatten() {
        ensure!(
            super::SUPPORTED_EXTENSIONS.contains(&e.as_str().unwrap_or("")),
            "Required glTF extension is unsupported: {e}"
        );
    }
    let parsed = started.map(|_| std::time::Instant::now());
    let mut buffers = Vec::new();
    let mut total = 0usize;
    for (i, b) in j["buffers"]
        .as_array()
        .context("Model has no buffers")?
        .iter()
        .enumerate()
    {
        let len = number(b, "byteLength")?;
        total = total.checked_add(len).context("Buffer budget overflow")?;
        crate::memory_budget::check(total, "Model buffers")?;
        let data = if let Some(name) = b["uri"].as_str() {
            uri(path, name)?
        } else if i == 0 {
            blob.as_ref().context("Missing GLB buffer")?.to_vec()
        } else if b["extensions"]["EXT_meshopt_compression"]["fallback"] == true {
            vec![0; len]
        } else {
            bail!("Missing buffer {i}")
        };
        ensure!(data.len() >= len, "Buffer {i} is shorter than declared");
        // External buffers and GLB padding can exceed byteLength; charge actual
        // owned storage, also making source-buffer retirement subtraction exact.
        total = total
            .checked_sub(len)
            .and_then(|n| n.checked_add(data.len()))
            .context("Buffer budget overflow")?;
        crate::memory_budget::check(total, "Model buffers")?;
        buffers.push(gltf::buffer::Data(data));
    }
    let loaded = started.map(|_| std::time::Instant::now());
    let meshopt = meshopt_decode::apply(&j, &mut buffers, meshopt_mode)?;
    let decompressed = started.map(|_| std::time::Instant::now());
    // Decoded views and images no longer read source-only compression buffers.
    let live: std::collections::BTreeSet<_> = j["bufferViews"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| number(v, "buffer"))
        .collect::<Result<_>>()?;
    for (i, buffer) in buffers.iter_mut().enumerate() {
        if !live.contains(&i) {
            total -= buffer.len();
            buffer.0 = Vec::new();
        }
    }
    let retired = started.map(|_| std::time::Instant::now());
    // Expand geometry float attributes and normalized instance quaternions;
    // joints and index semantics stay integer.
    let mut attributes = std::collections::BTreeSet::new();
    for mesh in j["meshes"].as_array().into_iter().flatten() {
        for primitive in mesh["primitives"].as_array().into_iter().flatten() {
            for (name, id) in primitive["attributes"].as_object().into_iter().flatten() {
                if name == "POSITION"
                    || name == "NORMAL"
                    || name == "TANGENT"
                    || name.starts_with("TEXCOORD_")
                {
                    attributes.insert(id.as_u64().context("Invalid accessor index")? as usize);
                }
            }
        }
    }
    for node in j["nodes"].as_array().into_iter().flatten() {
        if let Some(index) =
            node["extensions"]["EXT_mesh_gpu_instancing"]["attributes"]["ROTATION"].as_u64()
        {
            attributes.insert(index as usize);
        }
    }
    for index in attributes {
        let a = &j["accessors"][index];
        let kind = number(a, "componentType")?;
        if kind == 5126 {
            continue;
        }
        ensure!(
            a.get("sparse").is_none(),
            "Sparse quantized attributes are unsupported"
        );
        let count = number(a, "count")?;
        let components = match a["type"].as_str() {
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4") => 4,
            _ => bail!("Invalid attribute dimensions"),
        };
        let width = match kind {
            5120 | 5121 => 1,
            5122 | 5123 => 2,
            _ => bail!("Invalid quantized component"),
        };
        let view_id = number(a, "bufferView")?;
        let data = view(&j, &buffers, view_id)?;
        let stride = j["bufferViews"][view_id]["byteStride"]
            .as_u64()
            .unwrap_or((width * components) as u64) as usize;
        ensure!(stride >= width * components, "Invalid attribute stride");
        let offset = a["byteOffset"].as_u64().unwrap_or(0) as usize;
        ensure!(count <= 4_000_000, "Too many quantized vertices");
        let normalized = a["normalized"].as_bool().unwrap_or(false);
        let mut floats = Vec::with_capacity(count * components * 4);
        let mut min = vec![f32::INFINITY; components];
        let mut max = vec![f32::NEG_INFINITY; components];
        for i in 0..count {
            for k in 0..components {
                let v = component(
                    span(data, offset + i * stride + k * width, width)?,
                    kind,
                    normalized,
                )?;
                floats.extend(v.to_le_bytes());
                min[k] = min[k].min(v);
                max[k] = max[k].max(v);
            }
        }
        total = total
            .checked_add(floats.len())
            .context("Expanded buffer budget overflow")?;
        crate::memory_budget::check(total, "Expanded model buffers")?;
        let buffer = buffers.len();
        let buffer_view = j["bufferViews"].as_array().unwrap().len();
        j["buffers"]
            .as_array_mut()
            .unwrap()
            .push(json!({"byteLength":floats.len()}));
        j["bufferViews"]
            .as_array_mut()
            .unwrap()
            .push(json!({"buffer":buffer,"byteLength":floats.len()}));
        buffers.push(gltf::buffer::Data(floats));
        let a = &mut j["accessors"][index];
        a["bufferView"] = json!(buffer_view);
        a["byteOffset"] = json!(0);
        a["componentType"] = json!(5126);
        a["normalized"] = json!(false);
        a["min"] = json!(min);
        a["max"] = json!(max);
    }
    let expanded = started.map(|_| std::time::Instant::now());
    for t in j
        .get_mut("textures")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Some(source) = t["extensions"]["EXT_texture_webp"]["source"].as_u64() {
            t["source"] = json!(source);
        }
    }
    // Extensions handled here are no longer required of gltf-rs itself.
    if let Some(required) = j
        .get_mut("extensionsRequired")
        .and_then(Value::as_array_mut)
    {
        required.retain(|e| {
            !super::materials::EXTENSIONS.contains(&e.as_str().unwrap_or(""))
                && !matches!(
                    e.as_str(),
                    Some(
                        "EXT_meshopt_compression"
                            | "KHR_mesh_quantization"
                            | "EXT_texture_webp"
                            | "EXT_mesh_gpu_instancing"
                    )
                )
        });
    }
    let root = serde_json::from_value(j.clone()).context("Parsing decoded glTF")?;
    let document = gltf::Document::from_json(root).context("Validating decoded glTF")?;
    let validated = started.map(|_| std::time::Instant::now());
    // Bound simultaneous full-resolution decoder scratch, independently of the
    // number of images. Completed images already share the reduced texel budget.
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get().min(12));
    let sources: Vec<_> = document.images().map(|image| image.source()).collect();
    let (images, resized) = decode_images(&sources, &j, &buffers, path, MAX_TEXTURE_EDGE, workers)?;
    if let (
        Some(start),
        Some(parsed),
        Some(loaded),
        Some(decompressed),
        Some(retired),
        Some(expanded),
        Some(validated),
    ) = (
        started,
        parsed,
        loaded,
        decompressed,
        retired,
        expanded,
        validated,
    ) {
        native_log!(
            "{}",
            serde_json::json!({"nativeDecodeProfile":{
            "parseMs":parsed.duration_since(start).as_secs_f64()*1000.,
            "buffersMs":loaded.duration_since(parsed).as_secs_f64()*1000.,
            "meshoptMs":decompressed.duration_since(loaded).as_secs_f64()*1000.,
            "retireMs":retired.duration_since(decompressed).as_secs_f64()*1000.,
            "quantizationMs":expanded.duration_since(retired).as_secs_f64()*1000.,
            "documentMs":validated.duration_since(expanded).as_secs_f64()*1000.,
            "imagesMs":validated.elapsed().as_secs_f64()*1000.,
            "meshoptViews":meshopt.views,"directViews":meshopt.direct_views,"meshoptBytes":meshopt.bytes,"meshoptWorkers":meshopt.workers}})
        );
    }
    Ok((
        document,
        buffers,
        images,
        resized,
        j["materials"].as_array().cloned().unwrap_or_default(),
    ))
}

fn source_bytes<'a>(
    source: &gltf::image::Source<'_>,
    json: &Value,
    buffers: &'a [gltf::buffer::Data],
    path: Option<&Path>,
) -> Result<std::borrow::Cow<'a, [u8]>> {
    Ok(match source {
        gltf::image::Source::Uri { uri: name, .. } => std::borrow::Cow::Owned(uri(path, name)?),
        gltf::image::Source::View { view: v, .. } => {
            std::borrow::Cow::Borrowed(view(json, buffers, v.index())?)
        }
    })
}
fn image_sizes(dimensions: &[(u32, u32)], budget: u64, edge: u32) -> Result<Vec<(u32, u32)>> {
    ensure!(
        dimensions.len() as u64 <= budget,
        "Material texture budget is full"
    );
    let sizes = |scale: f64| {
        dimensions
            .iter()
            .map(|&(w, h)| {
                (
                    (w as f64 * scale).floor().max(1.) as u32,
                    (h as f64 * scale).floor().max(1.) as u32,
                )
            })
            .collect::<Vec<_>>()
    };
    let pixels = |sizes: &[(u32, u32)]| {
        sizes
            .iter()
            .map(|&(w, h)| u64::from(w) * u64::from(h))
            .sum::<u64>()
    };
    let mut scale = dimensions
        .iter()
        .fold(1f64, |s, &(w, h)| s.min(edge as f64 / w.max(h) as f64));
    if pixels(&sizes(scale)) > budget {
        let (mut low, mut high) = (0., scale);
        for _ in 0..40 {
            let mid = (low + high) / 2.;
            if pixels(&sizes(mid)) <= budget {
                low = mid;
            } else {
                high = mid;
            }
        }
        scale = low;
    }
    Ok(sizes(scale))
}
fn decode_image(
    source: &gltf::image::Source<'_>,
    json: &Value,
    buffers: &[gltf::buffer::Data],
    path: Option<&Path>,
    size: (u32, u32),
) -> Result<(DecodedImage, bool)> {
    use image::ImageDecoder;
    let data = source_bytes(source, json, buffers, path)?;
    let mut decoder = image::ImageReader::new(std::io::Cursor::new(data.as_ref()))
        .with_guessed_format()?
        .into_decoder()?;
    let (w, h) = decoder.dimensions();
    ensure!(
        u64::from(w) * u64::from(h) <= 67_108_864,
        "Source material image exceeds 64M pixels"
    );
    // Preserve ImageReader::decode's allocation and decoder-scratch limits.
    let mut limits = image::Limits::default();
    limits.reserve(decoder.total_bytes())?;
    decoder.set_limits(limits)?;
    let image = image::DynamicImage::from_decoder(decoder)?;
    let resized = (w, h) != size;
    let rgba = if resized {
        image
            .resize_exact(size.0, size.1, image::imageops::FilterType::Triangle)
            .into_rgba8()
    } else {
        image.into_rgba8()
    };
    Ok((
        DecodedImage {
            width: rgba.width(),
            height: rgba.height(),
            pixels: rgba.into_raw().into(),
        },
        resized,
    ))
}

fn decode_images(
    sources: &[gltf::image::Source<'_>],
    json: &Value,
    buffers: &[gltf::buffer::Data],
    path: Option<&Path>,
    edge: u32,
    workers: usize,
) -> Result<(Vec<DecodedImage>, bool)> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    // Source identity is independent of glTF image/texture indices and sampler
    // metadata. Equal embedded spans or URI strings decode and consume budget once.
    let mut identities = std::collections::HashMap::new();
    let mut unique = Vec::new();
    let mut aliases = Vec::with_capacity(sources.len());
    for source in sources {
        let key = match source {
            gltf::image::Source::View { view, .. } => format!(
                "view:{}:{}:{}",
                view.buffer().index(),
                view.offset(),
                view.length()
            ),
            gltf::image::Source::Uri { uri, .. } => format!("uri:{uri}"),
        };
        let index = *identities.entry(key).or_insert_with(|| {
            unique.push(source.clone());
            unique.len() - 1
        });
        aliases.push(index);
    }
    let sources = &unique;
    let dimensions = sources
        .iter()
        .map(|source| {
            let bytes = source_bytes(source, json, buffers, path)?;
            let size = image::ImageReader::new(std::io::Cursor::new(bytes.as_ref()))
                .with_guessed_format()?
                .into_dimensions()?;
            ensure!(
                size.0 > 0 && size.1 > 0 && u64::from(size.0) * u64::from(size.1) <= 67_108_864,
                "Source material image exceeds 64M pixels"
            );
            Ok(size)
        })
        .collect::<Result<Vec<_>>>()?;
    let sizes = image_sizes(&dimensions, material_texel_budget(), edge)?;
    let next = AtomicUsize::new(0);
    let first_error = AtomicUsize::new(sources.len());
    let mut decoded = std::thread::scope(|scope| -> Result<Vec<_>> {
        let jobs: Vec<_> = (0..workers.min(sources.len()))
            .map(|_| {
                let next = &next;
                let first_error = &first_error;
                let sizes = &sizes;
                scope.spawn(move || {
                    let mut images = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        if index >= first_error.load(Ordering::Relaxed) {
                            break;
                        }
                        let Some(source) = sources.get(index) else {
                            break;
                        };
                        let result = decode_image(source, json, buffers, path, sizes[index]);
                        if result.is_err() {
                            first_error.fetch_min(index, Ordering::Relaxed);
                        }
                        images.push((index, result));
                    }
                    images
                })
            })
            .collect();
        let mut images = Vec::with_capacity(sources.len());
        for job in jobs {
            images.extend(
                job.join()
                    .map_err(|_| anyhow::anyhow!("Image decoding worker panicked"))?,
            );
        }
        Ok(images)
    })?;
    // Completion order must not change texture IDs or which invalid image is
    // reported first. Join every worker before returning an error to the caller.
    decoded.sort_unstable_by_key(|(index, _)| *index);
    let mut images = Vec::with_capacity(decoded.len());
    let mut resized = false;
    for (_, result) in decoded {
        let (image, reduced) = result?;
        images.push(image);
        resized |= reduced;
    }
    Ok((
        aliases.into_iter().map(|i| images[i].clone()).collect(),
        resized,
    ))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    #[test]
    fn repeated_image_records_share_decoded_pixels_and_budget() {
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(8, 4, image::Rgba([21, 42, 63, 255]))
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let bytes = encoded.into_inner();
        let uri = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        // Different bufferView indices can describe the same source span.
        let json = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":bytes.len()}],
            "bufferViews":[{"buffer":0,"byteLength":bytes.len()},{"buffer":0,"byteLength":bytes.len()}],
            "images":[{"bufferView":0,"mimeType":"image/png"},{"bufferView":1,"mimeType":"image/png"},
                {"uri":uri},{"uri":uri}]});
        let doc = gltf::Document::from_json(serde_json::from_value(json.clone()).unwrap()).unwrap();
        let sources: Vec<_> = doc.images().map(|i| i.source()).collect();
        for workers in [1, 4] {
            let (images, reduced) = decode_images(
                &sources,
                &json,
                &[gltf::buffer::Data(bytes.clone())],
                None,
                8,
                workers,
            )
            .unwrap();
            assert!(!reduced);
            assert_eq!(images.len(), 4);
            assert!(Arc::ptr_eq(&images[0].pixels, &images[1].pixels));
            assert!(Arc::ptr_eq(&images[2].pixels, &images[3].pixels));
            assert!(!Arc::ptr_eq(&images[0].pixels, &images[2].pixels));
            assert_eq!(images[0].pixels.as_ref(), images[2].pixels.as_ref());
        }
        assert_eq!(
            image_sizes(&[(8, 4), (8, 4)], 64, 8).unwrap(),
            [(8, 4), (8, 4)]
        );
    }
    #[test]
    fn parallel_images_preserve_pixels_order_and_resize_decisions() {
        let mut json =
            json!({"asset":{"version":"2.0"}, "buffers":[], "bufferViews":[], "images":[]});
        let mut bytes = Vec::new();
        let mut expected = Vec::new();
        for index in 0..12 {
            let input = image::RgbaImage::from_fn(3 + index * 2, 2 + index, |x, y| {
                image::Rgba([
                    (x * 7) as u8,
                    (y * 11) as u8,
                    index as u8,
                    (x * 13 + y) as u8,
                ])
            });
            let format = if index % 3 == 0 {
                image::ImageFormat::WebP
            } else {
                image::ImageFormat::Png
            };
            let mut encoded = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(input)
                .write_to(&mut encoded, format)
                .unwrap();
            let data = encoded.into_inner();
            let decoded = image::load_from_memory(&data).unwrap();
            expected.push(
                decoded
                    .resize_exact(
                        (decoded.width() as f64 * 0.2).floor().max(1.) as u32,
                        (decoded.height() as f64 * 0.2).floor().max(1.) as u32,
                        image::imageops::FilterType::Triangle,
                    )
                    .into_rgba8(),
            );
            let mime = if index % 3 == 0 {
                "image/webp"
            } else {
                "image/png"
            };
            if index % 2 == 0 {
                json["images"].as_array_mut().unwrap().push(json!({"uri":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(&data))}));
            } else {
                let view = json["bufferViews"].as_array().unwrap().len();
                json["bufferViews"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"buffer":0,"byteOffset":bytes.len(),"byteLength":data.len()}));
                json["images"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"bufferView":view,"mimeType":mime}));
                bytes.extend(data);
            }
        }
        json["buffers"] = json!([{"byteLength":bytes.len()}]);
        let document =
            gltf::Document::from_json(serde_json::from_value(json.clone()).unwrap()).unwrap();
        let sources: Vec<_> = document.images().map(|image| image.source()).collect();
        let buffers = [gltf::buffer::Data(bytes)];
        for workers in [1, 4, 16] {
            let (images, resized) =
                decode_images(&sources, &json, &buffers, None, 5, workers).unwrap();
            assert!(resized);
            assert_eq!(images.len(), expected.len());
            for (actual, expected) in images.iter().zip(&expected) {
                assert_eq!((actual.width, actual.height), expected.dimensions());
                assert_eq!(actual.pixels.as_ref(), expected.as_raw());
            }
            let (_, resized) =
                decode_images(&sources[..1], &json, &buffers, None, 5, workers).unwrap();
            assert!(!resized);
        }
        assert!(
            decode_images(&[], &json, &[], None, 5, 4)
                .unwrap()
                .0
                .is_empty()
        );
    }

    #[test]
    fn parallel_images_report_the_first_invalid_source_in_document_order() {
        let json = json!({"asset":{"version":"2.0"}, "images":[
            {"uri":"data:image/png;base64,AQIDBA=="},
            {"uri":"data:image/png;base64,invalid!!!"}
        ]});
        let document =
            gltf::Document::from_json(serde_json::from_value(json.clone()).unwrap()).unwrap();
        let sources: Vec<_> = document.images().map(|image| image.source()).collect();
        let expected = decode_image(&sources[0], &json, &[], None, (3, 2))
            .err()
            .unwrap()
            .to_string();
        for workers in [1, 4] {
            let actual = decode_images(&sources, &json, &[], None, 5, workers)
                .err()
                .unwrap()
                .to_string();
            assert_eq!(actual, expected);
        }
    }

    pub(crate) fn model_file(mut root: Value, bytes: &[u8]) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        root["asset"] = json!({"version":"2.0"});
        root["buffers"] = json!([{"byteLength":bytes.len(),"uri":format!("data:application/octet-stream;base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))}]);
        let path = std::env::temp_dir().join(format!(
            "mutracer-import-{}-{}.gltf",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::write(&path, serde_json::to_vec(&root).unwrap()).unwrap();
        path
    }
    #[test]
    fn unused_buffer_retirement_charges_actual_padded_bytes() {
        let root = json!({"asset":{"version":"2.0"}, "buffers":[{"byteLength":1,
            "uri":"data:application/octet-stream;base64,AQIDBA=="}], "bufferViews":[]});
        let (_, buffers, _, _, _) = load_bytes(&serde_json::to_vec(&root).unwrap(), None).unwrap();
        assert!(buffers[0].is_empty());
    }
    #[test]
    fn meshopt_modes_roundtrip_and_reject_malformed_layouts() {
        let vertices = [[1f32, 2., 3.], [-1., 0., 1.], [3., 4., 5.]];
        let encoded = meshopt::encode_vertex_buffer(&vertices).unwrap();
        let ext = json!({"count":3,"byteStride":12,"mode":"ATTRIBUTES"});
        assert_eq!(
            decode(&ext, &encoded).unwrap(),
            vertices
                .into_iter()
                .flatten()
                .flat_map(f32::to_le_bytes)
                .collect::<Vec<_>>()
        );
        assert!(decode(&ext, &encoded[..3]).is_err());
        let indices = [0u32, 1, 2, 0, 2, 1];
        for mode in ["TRIANGLES", "INDICES"] {
            let encoded = if mode == "TRIANGLES" {
                meshopt::encode_index_buffer(&indices, 3).unwrap()
            } else {
                let mut bytes =
                    vec![
                        0;
                        unsafe { meshopt::ffi::meshopt_encodeIndexSequenceBound(indices.len(), 3) }
                    ];
                let len = unsafe {
                    meshopt::ffi::meshopt_encodeIndexSequence(
                        bytes.as_mut_ptr(),
                        bytes.len(),
                        indices.as_ptr(),
                        indices.len(),
                    )
                };
                bytes.truncate(len);
                bytes
            };
            for stride in [2, 4] {
                let result = decode(
                    &json!({"count":6,"byteStride":stride,"mode":mode}),
                    &encoded,
                )
                .unwrap();
                let expected: Vec<u8> = indices
                    .iter()
                    .flat_map(|&i| i.to_le_bytes()[..stride].to_vec())
                    .collect();
                assert_eq!(result, expected);
            }
        }
        for ext in [
            json!({"count":3,"byteStride":3,"mode":"ATTRIBUTES"}),
            json!({"count":4,"byteStride":2,"mode":"TRIANGLES"}),
            json!({"count":3,"byteStride":12,"mode":"ATTRIBUTES","filter":"QUATERNION"}),
            json!({"count":u64::MAX,"byteStride":256,"mode":"ATTRIBUTES"}),
        ] {
            assert!(decode(&ext, &encoded).is_err());
        }
    }
    #[test]
    fn quantized_positions_webp_and_instance_transforms_load_together() {
        let mut bytes = Vec::new();
        for p in [[-32768i16, 0, 0], [32767, 0, 0], [0, 32767, 0]] {
            for c in p {
                bytes.extend(c.to_le_bytes());
            }
            bytes.extend([0, 0]);
        }
        for t in [[0f32, 0., 0.], [2., 0., 0.]] {
            for c in t {
                bytes.extend(c.to_le_bytes());
            }
        }
        let mut webp = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .encode(&[255, 10, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        bytes.extend(&webp);
        let path = model_file(
            json!({
                "extensionsUsed":["KHR_mesh_quantization","EXT_texture_webp","EXT_mesh_gpu_instancing"],
                "extensionsRequired":["KHR_mesh_quantization","EXT_texture_webp","EXT_mesh_gpu_instancing"],
                "bufferViews":[{"buffer":0,"byteLength":24,"byteStride":8},{"buffer":0,"byteOffset":24,"byteLength":24},{"buffer":0,"byteOffset":48,"byteLength":webp.len()}],
                "accessors":[{"bufferView":0,"componentType":5122,"normalized":true,"type":"VEC3","count":3,"min":[-32768,0,0],"max":[32767,32767,0]},{"bufferView":1,"componentType":5126,"type":"VEC3","count":2}],
                "images":[{"bufferView":2,"mimeType":"image/webp"}],"textures":[{"extensions":{"EXT_texture_webp":{"source":0}}}],
                "meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],
                "nodes":[{"mesh":0,"translation":[1,0,0],"extensions":{"EXT_mesh_gpu_instancing":{"attributes":{"TRANSLATION":1}}}}],"scenes":[{"nodes":[0]}],"scene":0
            }),
            &bytes,
        );
        let (_, _, images, _, _) = load_bytes(&std::fs::read(&path).unwrap(), Some(&path)).unwrap();
        assert_eq!(images[0].pixels.as_ref(), [255, 10, 0, 255]);
        let model = crate::scene_api::gltf::Model::load(&path).unwrap();
        assert_eq!(
            model.geometries[0].positions,
            [-1., 0., 0., 1., 0., 0., 0., 1., 0.].into()
        );
        assert_eq!(model.meshes.len(), 2);
        assert_eq!(
            model.meshes[1].transform.transform_point3(glam::Vec3::ZERO),
            glam::Vec3::new(3., 0., 0.)
        );
        std::fs::remove_file(path).unwrap();
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::RgbaImage::from_pixel(width, height, image::Rgba([200, 100, 50, 255]))
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }
    /// Image sizes after decoding `count` image entries that share one PNG.
    fn decoded(width: u32, height: u32, count: usize) -> (Vec<(u32, u32)>, bool) {
        let bytes = png(width, height);
        let path = model_file(
            json!({
                "bufferViews":[{"buffer":0,"byteLength":bytes.len()}],
                "images":vec![json!({"bufferView":0,"mimeType":"image/png"}); count],
            }),
            &bytes,
        );
        let (_, _, images, resized, _) =
            load_bytes(&std::fs::read(&path).unwrap(), Some(&path)).unwrap();
        std::fs::remove_file(path).unwrap();
        (
            images.iter().map(|i| (i.width, i.height)).collect(),
            resized,
        )
    }
    #[test]
    fn images_keep_their_size_within_the_shared_budget() {
        assert_eq!(decoded(1024, 600, 1), (vec![(1024, 600)], false));
        // Many rectangular images still fit the byte budget at full resolution.
        let (sizes, resized) = decoded(400, 200, 100);
        assert!(!resized);
        assert!(
            sizes.iter().all(|&(w, h)| w == 400 && h == 200),
            "{sizes:?}"
        );
    }
    #[test]
    fn image_budget_uses_total_area_and_uniform_scale() {
        assert_eq!(
            image_sizes(
                &[(8192, 4096), (1024, 512)],
                material_texel_budget(),
                MAX_TEXTURE_EDGE
            )
            .unwrap(),
            vec![(8192, 4096), (1024, 512)]
        );
        let sizes = image_sizes(&[(8, 4), (4, 8), (2, 1)], 24, 16384).unwrap();
        assert_eq!(sizes, vec![(5, 2), (2, 5), (1, 1)]);
        assert!(image_sizes(&[(1, 1); 3], 2, 16384).is_err());
    }
    #[test]
    fn skin_initial_pose_is_baked_per_node() {
        let mut bytes = Vec::new();
        for x in [-1f32, 0., 0., 1., 0., 0., 0., 1., 0.] {
            bytes.extend(x.to_le_bytes());
        }
        bytes.extend([0u8; 12]);
        for _ in 0..3 {
            for w in [1f32, 0., 0., 0.] {
                bytes.extend(w.to_le_bytes());
            }
        }
        let path = model_file(
            json!({"bufferViews":[{"buffer":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":12},{"buffer":0,"byteOffset":48,"byteLength":48}],
            "accessors":[{"bufferView":0,"componentType":5126,"type":"VEC3","count":3,"min":[-1,0,0],"max":[1,1,0]},{"bufferView":1,"componentType":5121,"type":"VEC4","count":3},{"bufferView":2,"componentType":5126,"type":"VEC4","count":3}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"JOINTS_0":1,"WEIGHTS_0":2}}]}],
            "skins":[{"joints":[1]}],"nodes":[{"mesh":0,"skin":0},{"translation":[0,2,0]}],"scenes":[{"nodes":[0,1]}],"scene":0}),
            &bytes,
        );
        let model = crate::scene_api::gltf::Model::load(&path).unwrap();
        assert_eq!(
            model.geometries[0].positions,
            [-1., 2., 0., 1., 2., 0., 0., 3., 0.].into()
        );
        std::fs::remove_file(path).unwrap();
    }
}
