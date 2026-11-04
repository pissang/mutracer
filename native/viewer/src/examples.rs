//! Shared catalog and cancellable downloads. Cached models are published as one
//! directory only after every required resource is present.
use anyhow::{Context, Result, bail, ensure};
use eframe::egui;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    hash::{Hash, Hasher},
    io::Read,
    path::PathBuf,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

pub fn catalog() -> &'static [Value] {
    static CATALOG: OnceLock<Vec<Value>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../viewer/src/engine/model-presets.json"
        ))
        .expect("Shared model catalog")
    })
}
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn cache_root() -> PathBuf {
    if let Some(path) = std::env::var_os("MUTRACER_VIEWER_CACHE") {
        return path.into();
    }
    #[cfg(target_os = "macos")]
    let path = std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Caches"));
    #[cfg(target_os = "windows")]
    let path = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let path = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cache")));
    path.unwrap_or_else(std::env::temp_dir)
        .join("mutracer/examples-v1")
}
fn key(url: &str) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
pub fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "Download cancelled");
    Ok(())
}
pub fn fetch(
    url: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<Vec<u8>> {
    check_cancel(cancel)?;
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(120)))
        .build();
    let agent: ureq::Agent = config.into();
    let mut address = url.to_owned();
    for _ in 0..2 {
        let mut response = agent
            .get(&address)
            .call()
            .with_context(|| format!("Downloading {address}"))?;
        let total = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        ensure!(total <= 512 * 1024 * 1024, "Resource exceeds 512 MiB");
        let mut bytes = Vec::new();
        let mut reader = response.body_mut().as_reader();
        let mut block = [0u8; 65536];
        loop {
            check_cancel(cancel)?;
            let count = reader.read(&mut block)?;
            if count == 0 {
                break;
            }
            ensure!(
                bytes.len() + count <= 512 * 1024 * 1024,
                "Resource exceeds 512 MiB"
            );
            bytes.extend_from_slice(&block[..count]);
            progress(bytes.len() as u64, total);
        }
        if bytes.starts_with(b"version https://git-lfs.github.com/spec/v1") {
            address = lfs_url(&address).context("Unresolved Git LFS pointer")?;
        } else {
            return Ok(bytes);
        }
    }
    bail!("Git LFS returned a pointer instead of model data")
}
fn lfs_url(address: &str) -> Option<String> {
    address
        .strip_prefix("https://raw.githubusercontent.com/")
        .map(|tail| format!("https://media.githubusercontent.com/media/{tail}"))
}
pub fn model_json(bytes: &[u8]) -> Result<Value> {
    let data = if bytes.starts_with(b"glTF") {
        ensure!(
            bytes.len() >= 20 && bytes[16..20] == *b"JSON",
            "Invalid GLB JSON chunk"
        );
        let count = u32::from_le_bytes(bytes[12..16].try_into()?) as usize;
        bytes
            .get(20..20usize.checked_add(count).context("Invalid GLB length")?)
            .context("Truncated GLB")?
    } else {
        bytes
    };
    Ok(serde_json::from_slice(data)?)
}
pub(crate) fn with_json(bytes: &[u8], json: &Value) -> Result<Vec<u8>> {
    let mut data = serde_json::to_vec(json)?;
    if !bytes.starts_with(b"glTF") {
        return Ok(data);
    }
    while data.len() % 4 != 0 {
        data.push(b' ');
    }
    let old = u32::from_le_bytes(bytes[12..16].try_into()?) as usize;
    let tail = bytes.get(20 + old..).context("Truncated GLB chunks")?;
    let mut result = b"glTF".to_vec();
    result.extend_from_slice(&2u32.to_le_bytes());
    result.extend_from_slice(&((20 + data.len() + tail.len()) as u32).to_le_bytes());
    result.extend_from_slice(&(data.len() as u32).to_le_bytes());
    result.extend_from_slice(b"JSON");
    result.extend(data);
    result.extend(tail);
    Ok(result)
}
pub fn environment_paths(json: &Value) -> Vec<String> {
    json["extras"]["pbrt"]["light_sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["gltf"] == "metadata_only" && v["pbrt"] == "infinite")
        .filter_map(|v| v["source"].as_str().map(|s| format!("../source/{s}")))
        .collect()
}
pub fn download(
    preset: &Value,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<PathBuf> {
    check_cancel(cancel)?;
    let address = text(preset, "url");
    let root = cache_root();
    std::fs::create_dir_all(&root)?;
    let destination = root.join(key(address));
    if destination.join("model.glb").is_file() {
        return Ok(destination.join("model.glb"));
    }
    // Workers may overlap after cancellation; unique staging prevents either
    // worker from writing into a live model or deleting another worker's files.
    let stage = root.join(format!(
        ".{}-{}-{}",
        key(address),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    std::fs::create_dir(&stage)?;
    let result = (|| {
        let mut completed = 0;
        let mut get = |url: &str| -> Result<Vec<u8>> {
            let bytes = fetch(url, cancel, |loaded, total| {
                progress(
                    completed + loaded,
                    if total > 0 { completed + total } else { 0 },
                )
            })?;
            completed += bytes.len() as u64;
            ensure!(
                completed <= 1024 * 1024 * 1024,
                "Model download exceeds 1 GiB"
            );
            Ok(bytes)
        };
        let bytes = get(address)?;
        let mut json = model_json(&bytes)?;
        let base = url::Url::parse(address)?;
        let mut resources = HashMap::new();
        let mut optional = Vec::new();
        for kind in ["buffers", "images"] {
            if let Some(entries) = json.get_mut(kind).and_then(Value::as_array_mut) {
                for entry in entries {
                    let Some(uri) = entry["uri"]
                        .as_str()
                        .filter(|s| !s.starts_with("data:"))
                        .map(str::to_owned)
                    else {
                        continue;
                    };
                    let target = base.join(&uri)?;
                    let name = format!("{}.bin", key(target.as_str()));
                    if !stage.join(&name).exists() {
                        std::fs::write(stage.join(&name), get(target.as_str())?)?;
                    }
                    resources.insert(uri, name.clone());
                    entry["uri"] = name.into();
                }
            }
        }
        for path in environment_paths(&json) {
            let target = base.join(&path)?;
            let extension = target.path().rsplit('.').next().unwrap_or("bin");
            let name = format!("{}.{}", key(target.as_str()), extension);
            match get(target.as_str()) {
                Ok(data) => {
                    std::fs::write(stage.join(&name), data)?;
                    resources.insert(path, name);
                }
                Err(e) => {
                    check_cancel(cancel)?;
                    optional.push(format!("Scene environment: {e:#}"));
                }
            }
        }
        check_cancel(cancel)?;
        std::fs::write(
            stage.join("resources.json"),
            serde_json::to_vec(&resources)?,
        )?;
        std::fs::write(stage.join("warnings.json"), serde_json::to_vec(&optional)?)?;
        std::fs::write(stage.join("model.glb"), with_json(&bytes, &json)?)?;
        match std::fs::rename(&stage, &destination) {
            Ok(()) => {}
            Err(_) if destination.join("model.glb").is_file() => {}
            Err(error) => return Err(error.into()),
        }
        Ok(destination.join("model.glb"))
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

#[derive(Default)]
pub struct Browser {
    pub research: bool,
    pub current: Option<String>,
    pub progress: String,
    thumbnails: HashMap<String, egui::TextureHandle>,
    requested: HashSet<String>,
    pending: Vec<(String, std::sync::mpsc::Receiver<Result<image::RgbaImage>>)>,
}
impl Browser {
    fn thumbnail(&mut self, ui: &mut egui::Ui, preset: &Value, rect: egui::Rect) {
        let id = text(preset, "id");
        for i in (0..self.pending.len()).rev() {
            if let Ok(result) = self.pending[i].1.try_recv() {
                let (id, _) = self.pending.swap_remove(i);
                if let Ok(image) = result {
                    let texture = ui.ctx().load_texture(
                        &id,
                        egui::ColorImage::from_rgba_unmultiplied(
                            [image.width() as usize, image.height() as usize],
                            image.as_raw(),
                        ),
                        egui::TextureOptions::LINEAR,
                    );
                    self.thumbnails.insert(id, texture);
                }
            }
        }
        if let Some(texture) = self.thumbnails.get(id) {
            ui.painter().image(
                texture.id(),
                rect,
                egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1., 1.)),
                egui::Color32::WHITE,
            );
        } else if ui.is_rect_visible(rect) && self.pending.len() < 2 && !self.requested.contains(id)
        {
            self.requested.insert(id.to_owned());
            let address = text(preset, "thumbnail").to_owned();
            let ctx = ui.ctx().clone();
            let (send, receive) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let result = (|| {
                    let cache = cache_root().join("thumbnails");
                    let path = cache.join(format!("{}.image", key(&address)));
                    let data = if let Ok(bytes) = std::fs::read(&path) {
                        bytes
                    } else {
                        let bytes = fetch(&address, &AtomicBool::new(false), |_, _| {})?;
                        // Optional cache: a write failure cannot hide the image.
                        if std::fs::create_dir_all(&cache).is_ok() {
                            let _ = std::fs::write(&path, &bytes);
                        }
                        bytes
                    };
                    let image = image::load_from_memory(&data)?;
                    Ok(image.thumbnail(320, 200).into_rgba8())
                })();
                let _ = send.send(result);
                ctx.request_repaint();
            });
            self.pending.push((id.to_owned(), receive));
        }
        if !self.pending.is_empty() {
            ui.ctx()
                .request_repaint_after(std::time::Duration::from_millis(100));
        }
    }
    pub fn contents(&mut self, ui: &mut egui::Ui) -> Option<String> {
        let mut chosen = None;
        ui.horizontal_wrapped(|ui| {
            ui.selectable_value(&mut self.research, false, "MuTracer collection");
            ui.selectable_value(&mut self.research, true, "glTF Research Scenes");
        });
        if self.research {
            ui.hyperlink_to(
                "glTF Research Scenes ↗",
                "https://github.com/ErfanMo77/gltf-research-scenes",
            );
            ui.weak("Original scene lighting; large scenes need more memory.");
        }
        if !self.progress.is_empty() {
            ui.small(&self.progress);
        }
        egui::ScrollArea::vertical()
            .id_salt("example-list")
            .show(ui, |ui| {
                let width = ((ui.available_width() - 8.) / 2.).max(100.);
                let entries: Vec<_> = catalog()
                    .iter()
                    .filter(|p| (p["category"] == "research") == self.research)
                    .collect();
                for row in entries.chunks(2) {
                    ui.horizontal_top(|ui| {
                        for preset in row {
                            let id = text(preset, "id");
                            ui.vertical(|ui| {
                                ui.set_width(width);
                                let (rect, response) = ui.allocate_exact_size(
                                    egui::vec2(width, width * 0.64),
                                    egui::Sense::click(),
                                );
                                ui.painter().rect_filled(rect, 6, crate::theme::CONTROL);
                                self.thumbnail(ui, preset, rect.shrink(2.));
                                if self.current.as_deref() == Some(id) {
                                    ui.painter().rect_stroke(
                                        rect,
                                        6,
                                        egui::Stroke::new(2., crate::theme::ACCENT),
                                        egui::StrokeKind::Inside,
                                    );
                                }
                                if response.on_hover_text(text(preset, "tag")).clicked() {
                                    chosen = Some(id.to_owned());
                                }
                                if ui
                                    .selectable_label(
                                        self.current.as_deref() == Some(id),
                                        text(preset, "name"),
                                    )
                                    .clicked()
                                {
                                    chosen = Some(id.to_owned());
                                }
                                ui.add(
                                    egui::Label::new(
                                        egui::RichText::new(text(preset, "tag")).small(),
                                    )
                                    .truncate(),
                                );
                                let size = preset["sizeMB"]
                                    .as_f64()
                                    .map(|v| format!(" · {v} MB"))
                                    .unwrap_or_default();
                                ui.small(format!("{}{size}", text(preset, "license")));
                                ui.horizontal(|ui| {
                                    ui.hyperlink_to("Source ↗", text(preset, "sourceUrl"));
                                    ui.hyperlink_to("License ↗", text(preset, "licenseUrl"));
                                });
                                ui.add_space(8.);
                            });
                        }
                    });
                }
            });
        chosen
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_catalog_has_unique_ids_and_research_dependencies() {
        let mut ids = HashSet::new();
        for entry in catalog() {
            assert!(ids.insert(text(entry, "id")));
            assert!(!text(entry, "license").is_empty());
            assert!(text(entry, "sourceUrl").starts_with("https://"));
            if !entry["url"].is_null() {
                assert!(url::Url::parse(text(entry, "url")).is_ok());
            }
        }
        assert_eq!(
            catalog()
                .iter()
                .filter(|p| p["category"] == "research")
                .count(),
            27
        );
        assert_eq!(
            lfs_url("https://raw.githubusercontent.com/a/b/main/x"),
            Some("https://media.githubusercontent.com/media/a/b/main/x".into())
        );
    }
    #[test]
    fn glb_resource_rewrite_preserves_binary_chunk() {
        let original = serde_json::json!({"buffers":[{"byteLength":4}],"images":[{"uri":"a.png"}]});
        let mut json = serde_json::to_vec(&original).unwrap();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let mut bytes = b"glTF\x02\0\0\0".to_vec();
        bytes.extend(((20 + json.len() + 12) as u32).to_le_bytes());
        bytes.extend((json.len() as u32).to_le_bytes());
        bytes.extend(b"JSON");
        bytes.extend(json);
        bytes.extend(4u32.to_le_bytes());
        bytes.extend(b"BIN\0data");
        let mut changed = model_json(&bytes).unwrap();
        changed["images"][0]["uri"] = "cached.bin".into();
        let output = with_json(&bytes, &changed).unwrap();
        assert_eq!(model_json(&output).unwrap(), changed);
        assert_eq!(&output[output.len() - 12..], &bytes[bytes.len() - 12..]);
        assert!(model_json(b"glTFbad").is_err());
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    #[test]
    #[ignore = "downloads every web viewer example; set MUTRACER_VIEWER_CACHE outside the checkout"]
    fn all_shared_examples_download_and_import() {
        let selected = std::env::var("MUTRACER_EXAMPLE_IDS").ok();
        let mut results = Vec::new();
        for preset in catalog() {
            let id = text(preset, "id");
            if selected
                .as_ref()
                .is_some_and(|s| !s.split(',').any(|p| p == id))
            {
                continue;
            }
            let started = std::time::Instant::now();
            let result = (|| -> Result<crate::scene::Model> {
                if preset["url"].is_null() {
                    return crate::scene::Model::spheres();
                }
                let path = download(preset, &AtomicBool::new(false), |_, _| {})?;
                let mut model = crate::scene::Model::load(&path)?;
                model.1.preset = Some(preset.clone());
                Ok(model)
            })();
            let row = match result {
                Ok(model) => {
                    serde_json::json!({"id":id,"passed":true,"meshes":model.meshes.len(),"triangles":model.geometries.iter().map(|g|g.indices.len()/3).sum::<usize>(),"cameras":model.1.cameras.len(),"lights":model.1.lights.len(),"sceneLighting":model.1.available,"warnings":model.warnings,"seconds":started.elapsed().as_secs_f64()})
                }
                Err(e) => {
                    serde_json::json!({"id":id,"passed":false,"error":format!("{e:#}"),"seconds":started.elapsed().as_secs_f64()})
                }
            };
            println!("{row}");
            results.push(row);
            if let Ok(path) = std::env::var("MUTRACER_EXAMPLE_EVIDENCE") {
                std::fs::write(path, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
            }
        }
        assert!(!results.is_empty());
        assert!(
            results.iter().all(|r| r["passed"] == true),
            "Some examples failed; see per-model output"
        );
    }
}

#[cfg(test)]
mod render_tests {
    use super::*;
    #[test]
    #[ignore = "downloads examples and renders on both native GPU backends"]
    fn catalog_views_and_authored_lighting_render_on_both_backends() {
        let selected = std::env::var("MUTRACER_EXAMPLE_IDS").unwrap_or_else(|_| {
            "spheres,toycar,research-cornell-box,research-breakfast-room,research-classroom2".into()
        });
        let out = std::env::var_os("MUTRACER_EXAMPLE_RENDER_EVIDENCE")
            .map(PathBuf::from)
            .expect("External render evidence directory");
        std::fs::create_dir_all(&out).unwrap();
        let mut results = vec![];
        for preset in catalog()
            .iter()
            .filter(|p| selected.split(',').any(|id| id == text(p, "id")))
        {
            let mut model = if preset["url"].is_null() {
                crate::scene::Model::spheres().unwrap()
            } else {
                crate::scene::Model::load(
                    &download(preset, &AtomicBool::new(false), |_, _| {}).unwrap(),
                )
                .unwrap()
            };
            model.1.preset = Some(preset.clone());
            let camera =
                model.camera_for_load(&crate::renderer::Camera::fit(model.center, model.radius));
            let environment = model.environment_for_load(&crate::scene::Environment::default());
            let size = [96, 64];
            let descriptor = model.descriptor(&camera.bytes(size), size, &environment);
            for backend in [0, 1] {
                let started = std::time::Instant::now();
                let mut renderer = crate::renderer::Renderer::with_backend(backend).unwrap();
                renderer.commit(&descriptor).unwrap();
                let image = renderer.finish(8).unwrap();
                assert!(image.iter().all(|v| v.is_finite()));
                assert!(
                    image
                        .chunks_exact(4)
                        .any(|p| p[0] > 0. || p[1] > 0. || p[2] > 0.),
                    "Black image: {} / {backend}",
                    text(preset, "id")
                );
                let path = out.join(format!("{}-{backend}.png", text(preset, "id")));
                crate::renderer::save(&path, &image, size, 0.).unwrap();
                results.push(serde_json::json!({"id":text(preset,"id"),"backend":renderer.backend().unwrap().0,"requestedBackend":backend,"seconds":started.elapsed().as_secs_f64(),"image":path,"eye":camera.eye().to_array(),"target":camera.target.to_array(),"fov":camera.fov,"sceneLighting":environment.model_lighting}));
                std::fs::write(
                    out.join("results.json"),
                    serde_json::to_vec_pretty(&results).unwrap(),
                )
                .unwrap();
            }
        }
    }
}

#[cfg(test)]
mod download_progress_tests {
    use super::*;
    #[test]
    fn unknown_content_length_does_not_report_a_false_total() -> Result<()> {
        use std::io::Write;
        let server = std::net::TcpListener::bind("127.0.0.1:0")?;
        let address = server.local_addr()?;
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0u8; 4096];
            stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello")
                .unwrap();
        });
        let mut updates = Vec::new();
        let bytes = fetch(
            &format!("http://{address}/model"),
            &AtomicBool::new(false),
            |loaded, total| updates.push((loaded, total)),
        )?;
        worker.join().unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(updates.last(), Some(&(5, 0)));
        Ok(())
    }
}
