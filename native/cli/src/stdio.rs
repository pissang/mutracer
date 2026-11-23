use crate::{
    error::{Error, Result},
    lifetime,
    render_settings::{self, RenderOptions, SampleSequence},
    run::{Format, Input, Renderer, Settings},
    shot::{self, Denoise, Seed, Tracer},
    warnings::{self, Warning},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    thread,
    time::Instant,
};

const MAX_HEADER: usize = 1024 * 1024;
const MAX_PAYLOAD: usize = 512 * 1024 * 1024;

fn invalid(pointer: &str, message: impl Into<String>) -> Error {
    Error::validation(pointer, message, "See the version 1 stdio protocol.")
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SceneFormat {
    ShotJson,
    DescriptorV8,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AssetFormat {
    Gltf,
    Image,
    Hdr,
    Exr,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Overrides {
    size: Option<[u32; 2]>,
    spp: Option<u32>,
    denoise: Option<Denoise>,
    temporal: Option<crate::temporal::Config>,
    seed: Option<Seed>,
    seed_value: Option<u32>,
    sample_sequence_offset: Option<u32>,
    sample_sequence: Option<SampleSequence>,
    render: Option<RenderOptions>,
    display: Option<shot::Display>,
    format: Option<Format>,
    tracer: Option<Tracer>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit {
    path: String,
    value: Value,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Flush {
        id: u32,
    },
    Cut {
        id: u32,
    },
    Hello {
        id: u32,
        protocol: u32,
    },
    Scene {
        id: u32,
        format: SceneFormat,
        bytes: u32,
        #[serde(rename = "baseDir")]
        base_dir: Option<PathBuf>,
    },
    Asset {
        id: u32,
        name: String,
        format: AssetFormat,
        path: Option<PathBuf>,
        bytes: Option<u32>,
    },
    Decode {
        id: u32,
        format: AssetFormat,
        bytes: u32,
    },
    Edit {
        id: u32,
        changes: Vec<Edit>,
    },
    Render {
        id: u32,
        frame: u32,
        t: Option<f64>,
        settings: Option<Value>,
    },
    Check {
        id: u32,
        frame: u32,
        t: Option<f64>,
        settings: Option<Value>,
    },
}

struct Packet {
    header: Value,
    bytes: Vec<u8>,
}

fn read_packet(reader: &mut impl BufRead) -> Result<Option<Packet>> {
    let mut line = Vec::new();
    let count = (&mut *reader)
        .take(MAX_HEADER as u64 + 1)
        .read_until(b'\n', &mut line)
        .map_err(|e| invalid("", e.to_string()))?;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_HEADER || line.last() != Some(&b'\n') {
        return Err(invalid(
            "",
            "Header is too large or missing its LF terminator",
        ));
    }
    let header: Value =
        serde_json::from_slice(&line).map_err(|e| invalid("", format!("Invalid header: {e}")))?;
    if !header.is_object() {
        return Err(invalid("", "Expected a header object"));
    }
    let mut bytes = Vec::new();
    if let Some(length) = header.get("bytes") {
        let length = length
            .as_u64()
            .filter(|n| *n <= MAX_PAYLOAD as u64)
            .ok_or_else(|| {
                invalid(
                    "/bytes",
                    "Payload exceeds the advertised limit or length is not an integer",
                )
            })? as usize;
        let mut prefix = [0; 4];
        reader
            .read_exact(&mut prefix)
            .map_err(|e| invalid("/bytes", format!("Missing payload prefix: {e}")))?;
        if u32::from_le_bytes(prefix) as usize != length {
            return Err(invalid("/bytes", "Header length and binary prefix differ"));
        }
        bytes
            .try_reserve_exact(length)
            .map_err(|e| Error::budget(e.to_string()))?;
        reader
            .take(length as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| invalid("/bytes", e.to_string()))?;
        if bytes.len() != length {
            return Err(invalid("/bytes", "Truncated payload"));
        }
    }
    Ok(Some(Packet { header, bytes }))
}

fn reply(writer: &mut impl Write, header: Value, bytes: Option<&[u8]>) -> Result<()> {
    let send = (|| {
        writeln!(writer, "{header}")?;
        if let Some(bytes) = bytes {
            writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
            writer.write_all(bytes)?;
        }
        writer.flush()
    })();
    send.map_err(|e: io::Error| invalid("", format!("Cannot write protocol reply: {e}")))
}

fn reply_warning(
    writer: &mut impl Write,
    id: u32,
    frame: u32,
    target_samples: u32,
    warning: &Warning,
) -> Result<()> {
    reply(
        writer,
        json!({"type":"progress","id":id,"frame":frame,"samples":0,
            "targetSamples":target_samples,"warning":warning}),
        None,
    )
}

enum Scene {
    Shot { input: Box<Input>, raw: Value },
    Descriptor(Arc<Vec<u8>>),
}

#[derive(Default)]
struct Session {
    hello: bool,
    temporal: Option<Stream>,
    fallback_reported: bool,
    scene: Option<Scene>,
    renderer: Option<(Settings, Renderer)>,
    registered: BTreeMap<String, PathBuf>,
    directory: Option<tempfile::TempDir>,
}

struct Stream {
    filter: mutracer_native::api::TemporalDenoiser,
    config: crate::temporal::Config,
    settings: Settings,
    last: u32,
    flushing: bool,
}
fn temporal_reply(
    writer: &mut impl Write,
    id: u32,
    frame: Option<mutracer_native::api::OfflineFrame>,
    format: Format,
    done: bool,
    latency: u32,
) -> Result<()> {
    if let Some(frame) = frame {
        let bytes = crate::temporal::encode(&frame, format)?;
        if bytes.len() > MAX_PAYLOAD {
            return Err(Error::budget(
                "Temporal frame exceeds the stdio payload limit",
            ));
        }
        reply(
            writer,
            json!({"type":"frames","id":id,"done":done,"latency":latency,"frames":[{"frame":frame.index,"offset":0,"bytes":bytes.len(),"format":format}],"bytes":bytes.len()}),
            Some(&bytes),
        )
    } else {
        reply(
            writer,
            json!({"type":"frames","id":id,"frames":[],"latency":latency,"done":done}),
            None,
        )
    }
}

fn editable(pointer: &str) -> bool {
    let parts: Vec<_> = pointer.split('/').collect();
    match parts.as_slice() {
        [
            "",
            "camera",
            "fov" | "target" | "position" | "fStop" | "focusDistance" | "sensorHeight",
        ]
        | ["", "camera", "orbit", "azimuth" | "elevation" | "distance"]
        | ["", "output", "display", "exposure" | "toneMappingExposure"]
        | ["", "environment", "color" | "intensity" | "rotation"] => true,
        ["", "objects", n, "position" | "rotation" | "scale"]
        | ["", "objects", n, "animation", "time"]
        | ["", "objects", n, "material", "inputs", _]
        | [
            "",
            "lights",
            n,
            "position" | "target" | "color" | "intensity" | "size" | "radius" | "length" | "angle",
        ] => n.parse::<usize>().is_ok(),
        ["", "objects", n, "material", key] => {
            n.parse::<usize>().is_ok() && crate::material::editable(key)
        }
        _ => false,
    }
}

fn edits(raw: &Value, changes: Vec<Edit>) -> Result<(Value, shot::Shot)> {
    let mut candidate = raw.clone();
    for change in changes {
        if !editable(&change.path) {
            return Err(invalid(
                &change.path,
                "Path must identify an animatable channel",
            ));
        }
        let channel = candidate
            .pointer_mut(&change.path)
            .ok_or_else(|| invalid(&change.path, "Path must identify an existing channel"))?;
        *channel = change.value;
    }
    let shot = shot::parse(&serde_json::to_vec(&candidate).expect("serializable shot"))?;
    Ok((candidate, shot))
}

impl Session {
    fn handle(
        &mut self,
        request: Request,
        payload: Vec<u8>,
        writer: &mut impl Write,
    ) -> Result<()> {
        if !self.hello && !matches!(request, Request::Hello { .. }) {
            return Err(invalid("/type", "Send hello first"));
        }
        let check_only = matches!(request, Request::Check { .. });
        match request {
            Request::Cut { id } => {
                let stream = self
                    .temporal
                    .as_mut()
                    .ok_or_else(|| invalid("/type", "Start a temporal render before cutting"))?;
                if stream.flushing {
                    return Err(invalid("/type", "Finish flushing the current stream"));
                }
                stream.filter.cut();
                reply(writer, json!({"type":"ok","id":id}), None)
            }
            Request::Flush { id } => {
                let Some(stream) = self.temporal.as_mut() else {
                    return temporal_reply(writer, id, None, Format::Png, true, 0);
                };
                stream.flushing = true;
                let latency = stream.filter.latency();
                let frame = stream.filter.flush().map_err(crate::temporal::gpu)?;
                let done = frame.is_none();
                let format = stream.settings.format;
                if done {
                    self.temporal = None;
                }
                temporal_reply(writer, id, frame, format, done, latency)
            }
            Request::Hello { id, protocol } => {
                if protocol != 1 || self.hello {
                    return Err(invalid(
                        "/protocol",
                        "Expected one hello request using protocol 1",
                    ));
                }
                self.hello = true;
                reply(
                    writer,
                    json!({"type":"ok","id":id,"protocol":1,"shotVersion":1,"descriptorVersions":[8],
                    "capabilities":["shot-json","descriptor-v8","asset-path","asset-bytes","shot-edit","png","oidn","image-decode","exr","render-settings","display-settings","frame-sample-sequence","check-settings","oidn-clean-aux-large","structured-warnings","temporal-offline"],
                    "maxHeaderBytes":MAX_HEADER,"maxPayloadBytes":MAX_PAYLOAD,"build":env!("MUTRACER_CLI_BUILD_ID")}),
                    None,
                )
            }
            Request::Scene {
                id,
                format,
                bytes,
                base_dir,
            } => {
                if bytes == 0 || bytes as usize != payload.len() {
                    return Err(invalid("/bytes", "Expected a scene payload"));
                }
                let scene = match format {
                    SceneFormat::ShotJson => {
                        let mut raw: Value = serde_json::from_slice(&payload)
                            .map_err(|e| invalid("", e.to_string()))?;
                        // Parse the original bytes too, so duplicate and unknown
                        // fields are detected before replacing registered paths.
                        shot::parse(&payload)?;
                        if let Some(assets) = raw.get_mut("assets").and_then(Value::as_object_mut) {
                            for (name, item) in assets {
                                for field in ["gltf", "hdr", "image"] {
                                    if let Some(value) = item.get_mut(field) {
                                        if let Some(asset) =
                                            value.as_str().and_then(|v| v.strip_prefix("asset:"))
                                        {
                                            let path =
                                                self.registered.get(asset).ok_or_else(|| {
                                                    Error::asset(
                                                        format!(
                                                            "/assets/{}/{field}",
                                                            crate::error::escape(name)
                                                        ),
                                                        format!("Unregistered asset {asset:?}"),
                                                    )
                                                })?;
                                            *value = json!(path);
                                        }
                                    }
                                }
                            }
                        }
                        let edited = serde_json::to_vec(&raw).expect("serializable shot");
                        let input = Input::from_bytes(
                            &edited,
                            base_dir.as_deref().unwrap_or(Path::new(".")),
                        )?;
                        Scene::Shot {
                            input: Box::new(input),
                            raw,
                        }
                    }
                    SceneFormat::DescriptorV8 => {
                        if base_dir.is_some() || payload.get(..4) != Some(&8u32.to_le_bytes()) {
                            return Err(invalid(
                                "/format",
                                "Expected a v8 descriptor without baseDir",
                            ));
                        }
                        mutracer_native::scene_api::Scene::validate_descriptor(&payload)
                            .map_err(|e| invalid("/format", e.to_string()))?;
                        Scene::Descriptor(Arc::new(payload))
                    }
                };
                let scene_hash = match &scene {
                    Scene::Shot { input, .. } => {
                        crate::assets::digest(&serde_json::to_vec(&input.scene_identity()).unwrap())
                    }
                    Scene::Descriptor(bytes) => crate::assets::digest(bytes),
                };
                if !matches!(
                    (&self.scene, &scene),
                    (Some(Scene::Descriptor(_)), Scene::Descriptor(_))
                ) {
                    if self.temporal.is_some() {
                        return Err(invalid(
                            "/type",
                            "Flush the temporal stream before replacing this scene",
                        ));
                    }
                    // Avoid carrying a shot camera override into a descriptor.
                    self.renderer = None;
                }
                self.scene = Some(scene);
                reply(
                    writer,
                    json!({"type":"ok","id":id,"sceneHash":scene_hash}),
                    None,
                )
            }
            Request::Asset {
                id,
                name,
                format,
                path,
                bytes,
            } => {
                if name.is_empty() || name.len() > 128 || name.chars().any(|c| c.is_control()) {
                    return Err(invalid(
                        "/name",
                        "Expected a nonempty asset name of at most 128 bytes",
                    ));
                }
                let registered = match (path, bytes) {
                    (Some(path), None) => {
                        let path = path
                            .canonicalize()
                            .map_err(|e| Error::asset("/path", e.to_string()))?;
                        if !path.is_file() {
                            return Err(Error::asset("/path", "Expected a regular file"));
                        }
                        path
                    }
                    (None, Some(n)) if n > 0 && n as usize == payload.len() => {
                        if self.directory.is_none() {
                            self.directory = Some(
                                tempfile::tempdir()
                                    .map_err(|e| Error::asset("/bytes", e.to_string()))?,
                            );
                        }
                        let suffix = match format {
                            AssetFormat::Gltf if payload.starts_with(b"glTF") => ".glb",
                            AssetFormat::Gltf => ".gltf",
                            AssetFormat::Hdr => ".hdr",
                            AssetFormat::Exr => ".exr",
                            _ => ".image",
                        };
                        let mut file = tempfile::Builder::new()
                            .suffix(suffix)
                            .tempfile_in(self.directory.as_ref().unwrap().path())
                            .map_err(|e| Error::asset("/bytes", e.to_string()))?;
                        file.write_all(&payload)
                            .map_err(|e| Error::asset("/bytes", e.to_string()))?;
                        file.keep()
                            .map_err(|e| Error::asset("/bytes", e.to_string()))?
                            .1
                    }
                    _ => {
                        return Err(invalid(
                            "/path",
                            "Specify exactly one local path or a nonempty payload",
                        ));
                    }
                };
                self.registered.insert(name, registered);
                reply(writer, json!({"type":"ok","id":id}), None)
            }
            Request::Decode { id, format, bytes } => {
                let hdr = matches!(format, AssetFormat::Hdr | AssetFormat::Exr);
                if !matches!(
                    format,
                    AssetFormat::Image | AssetFormat::Hdr | AssetFormat::Exr
                ) || bytes == 0
                {
                    return Err(invalid("/format", "Decode requires image or HDR bytes"));
                }
                let image = crate::assets::decode_image_bytes(&payload, hdr)?;
                let w = image.width();
                let h = image.height();
                let pixels: Vec<u8> = if hdr {
                    image
                        .into_rgba32f()
                        .into_raw()
                        .into_iter()
                        .flat_map(f32::to_le_bytes)
                        .collect()
                } else {
                    image.into_rgba8().into_raw()
                };
                if pixels.len() > MAX_PAYLOAD {
                    return Err(Error::budget("Decoded image exceeds stream payload limit"));
                }
                reply(
                    writer,
                    json!({"type":"ok","id":id,"width":w,"height":h,"bytes":pixels.len()}),
                    Some(&pixels),
                )
            }
            Request::Edit { id, changes } => {
                let Some(Scene::Shot { input, raw }) = self.scene.as_mut() else {
                    return Err(invalid("/type", "Edits require a shot JSON scene"));
                };
                let (candidate, shot) = edits(raw, changes)?;
                *raw = candidate;
                input.shot = shot;
                reply(writer, json!({"type":"ok","id":id}), None)
            }
            Request::Render {
                id,
                frame,
                t,
                settings,
            }
            | Request::Check {
                id,
                frame,
                t,
                settings,
            } => {
                let tick = Instant::now();
                let scene = self
                    .scene
                    .as_mut()
                    .ok_or_else(|| invalid("/type", "Submit a scene before rendering"))?;
                let explicit_settings = settings.is_some();
                let overrides: Overrides = match settings {
                    Some(settings) => {
                        shot::reject_null(&settings, "/settings")?;
                        serde_path_to_error::deserialize(settings)
                            .map_err(|e| shot::decode_error("/settings", e))?
                    }
                    None => Overrides::default(),
                };
                let defaults = if let Scene::Shot { input, .. } = scene {
                    Some(&input.shot.output)
                } else {
                    None
                };
                if defaults.is_none() && (!explicit_settings || t.is_none()) {
                    return Err(invalid(
                        "/settings",
                        "Descriptor input requires explicit time and settings",
                    ));
                }
                let fps = defaults.map_or(24, |out| out.fps);
                let t = t.unwrap_or(f64::from(frame) / f64::from(fps));
                if !t.is_finite() || t < 0. || defaults.is_some_and(|out| t > out.duration) {
                    return Err(invalid("/t", "Time is outside the shot"));
                }
                let settings = Settings {
                    size: overrides
                        .size
                        .unwrap_or_else(|| defaults.map_or([1280, 720], |o| o.size)),
                    spp: overrides
                        .spp
                        .unwrap_or_else(|| defaults.map_or(32, |o| o.spp)),
                    denoise: overrides
                        .denoise
                        .unwrap_or_else(|| defaults.map_or(Denoise::Oidn, |o| o.denoise)),
                    seed: overrides
                        .seed
                        .unwrap_or_else(|| defaults.map_or(Seed::Fixed, |o| o.seed)),
                    seed_value: overrides
                        .seed_value
                        .unwrap_or_else(|| defaults.map_or(12345, |o| o.seed_value)),
                    sample_sequence_offset: overrides
                        .sample_sequence_offset
                        .unwrap_or_else(|| defaults.map_or(0, |o| o.sample_sequence_offset)),
                    sample_sequence: overrides.sample_sequence.unwrap_or_else(|| {
                        defaults.map_or(SampleSequence::Fixed, |o| o.sample_sequence)
                    }),
                    render: overrides.render.unwrap_or_else(|| {
                        defaults.map_or_else(RenderOptions::default, |o| o.render)
                    }),
                    format: overrides.format.unwrap_or(Format::Png),
                    aovs: false,
                    tracer: overrides
                        .tracer
                        .unwrap_or_else(|| defaults.map_or(Tracer::Hardware, |o| o.tracer)),
                    fps,
                    stride: 1,
                    gpu: None,
                };
                settings.validate(defaults.map_or(1., |o| o.duration), "/settings")?;
                settings.offset(frame, "/settings")?;
                let config = overrides
                    .temporal
                    .or_else(|| defaults.map(|o| o.temporal.clone()))
                    .unwrap_or_default();
                config.validate("/settings/temporal", defaults.map(|o| o.duration), fps)?;
                if !check_only
                    && self.temporal.as_ref().is_some_and(|s| {
                        s.flushing
                            || s.settings != settings
                            || s.config != config
                            || s.last.checked_add(1) != Some(frame)
                    })
                {
                    return Err(invalid(
                        "/frame",
                        "Submit consecutive frames with the same settings or finish flushing first",
                    ));
                }
                let display = overrides
                    .display
                    .map(|display| {
                        display.check(
                            defaults.map_or(f64::MAX, |o| o.duration),
                            "/settings/display",
                        )?;
                        Ok(display.at(t))
                    })
                    .transpose()?;
                let graph_targets = match scene {
                    Scene::Shot { input, .. } => input.prepared.material_graph_targets(&input.shot),
                    Scene::Descriptor(bytes) => warnings::descriptor_material_graph_targets(bytes),
                };
                let mut seen_warnings = HashSet::new();
                let mut request_warnings = Vec::new();
                if warnings::caustics_enabled(settings.render) {
                    for warning in warnings::predicted_caustic_graph_warnings(&graph_targets) {
                        if seen_warnings.insert(warning.clone()) {
                            reply_warning(writer, id, frame, settings.spp, &warning)?;
                            request_warnings.push(warning);
                        }
                    }
                }
                if let Some(warning) =
                    crate::temporal::fallback(settings.denoise, "/settings/denoise")
                {
                    if !self.fallback_reported {
                        reply_warning(writer, id, frame, settings.spp, &warning)?;
                        self.fallback_reported = true;
                    }
                    request_warnings.push(warning);
                }
                if check_only {
                    let weights =
                        render_settings::denoiser_identity(settings.denoise, "/settings/denoise")?;
                    return reply(
                        writer,
                        json!({"type":"ok","id":id,"denoiserWeights":weights,"warnings":request_warnings}),
                        None,
                    );
                }
                if self.renderer.as_ref().is_none_or(|(old, _)| {
                    old.size != settings.size
                        || old.spp != settings.spp
                        || old.denoise != settings.denoise
                        || old.tracer != settings.tracer
                        || old.render != settings.render
                }) {
                    self.renderer = Some((settings, Renderer::new(settings)?));
                }
                let renderer = &mut self.renderer.as_mut().unwrap().1;
                reply(
                    writer,
                    json!({"type":"progress","id":id,"frame":frame,"samples":0,"targetSamples":settings.spp}),
                    None,
                )?;
                match scene {
                    Scene::Shot { input, .. } => {
                        renderer.prepare_shot(input, settings, t, display)?
                    }
                    Scene::Descriptor(bytes) => {
                        renderer
                            .engine
                            .set_scene_shared(bytes.clone())
                            .map_err(|e| Error::gpu(e.to_string()))?;
                        renderer
                            .engine
                            .display()
                            .set_settings(display.unwrap_or_default())
                            .map_err(|e| Error::gpu(e.to_string()))?;
                        renderer
                            .engine
                            .update()
                            .map_err(|e| Error::gpu(e.to_string()))?;
                    }
                };
                let image = if settings.denoise == Denoise::Temporal {
                    renderer.converge(settings, frame)?;
                    if self.temporal.is_none() {
                        self.temporal = Some(Stream {
                            filter: config.start(&renderer.engine)?,
                            config: config.clone(),
                            settings,
                            last: frame,
                            flushing: false,
                        });
                    }
                    let stream = self.temporal.as_mut().unwrap();
                    if config.cuts_at(frame, fps) {
                        stream.filter.cut();
                    }
                    stream
                        .filter
                        .push(frame, &renderer.render)
                        .map_err(crate::temporal::gpu)?;
                    stream.last = frame;
                    None
                } else {
                    Some(renderer.capture(settings, frame)?)
                };
                let render_warnings = renderer.graph_warnings(&graph_targets);
                for warning in render_warnings {
                    if seen_warnings.insert(warning.clone()) {
                        reply_warning(writer, id, frame, settings.spp, &warning)?;
                        request_warnings.push(warning);
                    }
                }
                let Some(image) = image else {
                    let stream = self.temporal.as_mut().unwrap();
                    return temporal_reply(
                        writer,
                        id,
                        stream.filter.drain(),
                        settings.format,
                        false,
                        stream.filter.latency(),
                    );
                };
                reply(
                    writer,
                    json!({"type":"frame","id":id,"frame":frame,"format":settings.format,
                    "width":settings.size[0],"height":settings.size[1],"bytes":image.len(),
                    "elapsedMs":tick.elapsed().as_secs_f64()*1000.}),
                    Some(&image),
                )
            }
        }
    }
}

fn run(mut next: impl FnMut() -> Result<Option<Packet>>, writer: &mut impl Write) -> Result<()> {
    let mut session = Session::default();
    while let Some(Packet { header, bytes }) = next()? {
        let id = header
            .get("id")
            .and_then(Value::as_u64)
            .and_then(|x| u32::try_from(x).ok())
            .ok_or_else(|| invalid("/id", "Expected a u32 request id"))?;
        let result = serde_json::from_value(header)
            .map_err(|e| invalid("", e.to_string()))
            .and_then(|request| session.handle(request, bytes, writer));
        if let Err(error) = result {
            let mut header = serde_json::to_value(&error).expect("serializable error");
            header["type"] = json!("error");
            header["id"] = json!(id);
            reply(writer, header, None)?;
            if error.code == 5 {
                return Err(error);
            }
        }
    }
    Ok(())
}

pub fn serve() -> Result<()> {
    // Clients keep stdin open until the final render reply. Read ahead so
    // EOF stops a render even while the main thread is in the GPU.
    let (send, receive) = mpsc::sync_channel(0);
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut last_was_render = false;
        loop {
            match read_packet(&mut stdin) {
                Ok(None) if last_was_render => lifetime::parent_closed(),
                Ok(None) => break,
                Ok(Some(packet)) => {
                    last_was_render = packet.header["type"] == "render";
                    if send.send(Ok(Some(packet))).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = send.send(Err(error));
                    break;
                }
            }
        }
    });
    run(|| receive.recv().unwrap_or(Ok(None)), &mut io::stdout())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn empty_temporal_flush_has_no_payload_prefix() {
        let mut session = Session::default();
        let mut out = Vec::new();
        session
            .handle(Request::Hello { id: 1, protocol: 1 }, vec![], &mut out)
            .unwrap();
        let hello: Value = serde_json::from_slice(&out).unwrap();
        assert!(
            hello["capabilities"]
                .as_array()
                .unwrap()
                .contains(&json!("temporal-offline"))
        );
        out.clear();
        session
            .handle(Request::Flush { id: 2 }, vec![], &mut out)
            .unwrap();
        let batch: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(batch["frames"], json!([]));
        assert_eq!(batch["done"], true);
        assert!(batch.get("bytes").is_none());
        assert!(
            session
                .handle(Request::Cut { id: 3 }, vec![], &mut out)
                .is_err()
        );
    }

    #[test]
    fn follows_binary_payloads_with_another_header() {
        let mut bytes = b"{\"bytes\":5}\n\x05\0\0\0x\n\0\ny".to_vec();
        bytes.extend(b"{\"id\":8}\n");
        let mut reader = Cursor::new(bytes);
        assert_eq!(
            read_packet(&mut reader).unwrap().unwrap().bytes,
            b"x\n\0\ny"
        );
        assert_eq!(read_packet(&mut reader).unwrap().unwrap().header["id"], 8);
        assert!(read_packet(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_mismatched_or_truncated_lengths() {
        for bytes in [
            b"{\"bytes\":2}\n\x03\0\0\0ab",
            b"{\"bytes\":3}\n\x03\0\0\0ab",
        ] {
            assert_eq!(
                read_packet(&mut Cursor::new(bytes))
                    .err()
                    .unwrap()
                    .pointer
                    .as_deref(),
                Some("/bytes")
            );
        }
    }

    #[test]
    fn materialx_validation_error_includes_xml_location_and_keeps_session_open() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("bad.mtlx"),
            r#"<materialx>
  <mystery name="shader" type="surfaceshader"/>
  <surfacematerial name="surface" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="shader"/>
  </surfacematerial>
</materialx>"#,
        )
        .unwrap();
        let mut shot = json!({
            "version": 1, "output": {"duration": 1},
            "objects": [{"name": "subject", "shape": "sphere"}],
            "camera": {"position": [0, 0, 3], "target": "subject"},
        });
        let scene = |id, shot: &Value| {
            let bytes = serde_json::to_vec(shot).unwrap();
            Packet {
                header: json!({
                    "type":"scene","id":id,"format":"shot-json","bytes":bytes.len(),"baseDir":dir.path(),
                }),
                bytes,
            }
        };
        let good = scene(2, &shot);
        shot["assets"] = json!({"surface": {"materialx": "bad.mtlx"}});
        shot["objects"][0]["material"] = json!({"asset": "surface"});
        let mut requests = [
            Packet {
                header: json!({"type":"hello","id":1,"protocol":1}),
                bytes: vec![],
            },
            good,
            scene(3, &shot),
            Packet {
                header: json!({"type":"check","id":4,"frame":0}),
                bytes: vec![],
            },
        ]
        .into_iter();
        let mut output = Vec::new();
        run(|| Ok(requests.next()), &mut output).unwrap();
        let mut output = Cursor::new(output);
        assert_eq!(
            read_packet(&mut output).unwrap().unwrap().header["type"],
            "ok"
        );
        assert_eq!(
            read_packet(&mut output).unwrap().unwrap().header["type"],
            "ok"
        );
        let error = read_packet(&mut output).unwrap().unwrap().header;
        assert_eq!(error["id"], 3);
        assert_eq!(error["type"], "error");
        assert_eq!(error["code"], 2);
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("bad.mtlx:2:3: shader (<mystery>)")
        );
        assert!(error["hint"].as_str().unwrap().contains("open_pbr_surface"));
        assert_eq!(
            read_packet(&mut output).unwrap().unwrap().header["type"],
            "ok"
        );
    }

    #[test]
    fn hello_and_recoverable_errors_keep_the_session_in_sync() {
        let mut bytes = Cursor::new(b"{\"id\":1,\"type\":\"hello\",\"protocol\":1}\n{\"id\":2,\"type\":\"render\",\"frame\":0}\n");
        let mut output = Vec::new();
        run(|| read_packet(&mut bytes), &mut output).unwrap();
        let mut output = Cursor::new(output);
        let hello = read_packet(&mut output).unwrap().unwrap().header;
        assert_eq!(hello["protocol"], 1);
        assert_eq!(hello["id"], 1);
        let error = read_packet(&mut output).unwrap().unwrap().header;
        assert_eq!(error["type"], "error");
        assert_eq!(error["id"], 2);
        assert_eq!(error["code"], 2);
    }
}
