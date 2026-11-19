use crate::{
    error::{Error, Result},
    run::{Format, Input, Renderer, Settings},
    shot::{self, Denoise, Seed},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
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
    seed: Option<Seed>,
    seed_value: Option<u32>,
    sample_sequence_offset: Option<u32>,
    format: Option<Format>,
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
        settings: Option<Overrides>,
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

enum Scene {
    Shot { input: Box<Input>, raw: Value },
    Descriptor(Arc<Vec<u8>>),
}

#[derive(Default)]
struct Session {
    hello: bool,
    scene: Option<Scene>,
    renderer: Option<(Settings, Renderer)>,
    registered: BTreeMap<String, PathBuf>,
    directory: Option<tempfile::TempDir>,
}

fn editable(pointer: &str) -> bool {
    let parts: Vec<_> = pointer.split('/').collect();
    match parts.as_slice() {
        ["", "camera", "fov" | "target" | "position"]
        | ["", "camera", "orbit", "azimuth" | "elevation" | "distance"]
        | ["", "output", "display", "exposure"]
        | ["", "environment", "color" | "intensity" | "rotation"] => true,
        ["", "objects", n, "position" | "rotation" | "scale"]
        | [
            "",
            "lights",
            n,
            "position" | "target" | "color" | "intensity" | "size" | "radius" | "length" | "angle",
        ]
        | [
            "",
            "objects",
            n,
            "material",
            "color" | "roughness" | "metalness" | "transmission" | "transmissionColor" | "ior"
            | "opacity" | "emissionColor" | "emissionStrength" | "coat" | "coatColor"
            | "coatRoughness" | "coatIor" | "diffuseRoughness",
        ] => n.parse::<usize>().is_ok(),
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
        match request {
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
                    "capabilities":["shot-json","descriptor-v8","asset-path","asset-bytes","shot-edit","png","oidn","image-decode"],
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
                if matches!(format, AssetFormat::Exr) {
                    return Err(invalid("/format", "EXR import is unavailable"));
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
                let hdr = matches!(format, AssetFormat::Hdr);
                if !matches!(format, AssetFormat::Image | AssetFormat::Hdr) || bytes == 0 {
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
            } => {
                let tick = Instant::now();
                let scene = self
                    .scene
                    .as_mut()
                    .ok_or_else(|| invalid("/type", "Submit a scene before rendering"))?;
                let explicit_settings = settings.is_some();
                let overrides = settings.unwrap_or_default();
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
                    format: overrides.format.unwrap_or(Format::Png),
                    fps,
                    stride: 1,
                    gpu: None,
                };
                settings.validate(defaults.map_or(1., |o| o.duration))?;
                if self.renderer.as_ref().is_none_or(|(old, _)| {
                    old.size != settings.size
                        || old.spp != settings.spp
                        || old.denoise != settings.denoise
                }) {
                    self.renderer = Some((settings, Renderer::new(settings)?));
                }
                let renderer = &mut self.renderer.as_mut().unwrap().1;
                reply(
                    writer,
                    json!({"type":"progress","id":id,"frame":frame,"samples":0,"targetSamples":settings.spp}),
                    None,
                )?;
                let image = match scene {
                    Scene::Shot { input, .. } => renderer.shot_frame(input, settings, frame, t)?,
                    Scene::Descriptor(bytes) => {
                        renderer
                            .engine
                            .set_scene_shared(bytes.clone())
                            .map_err(|e| Error::gpu(e.to_string()))?;
                        renderer
                            .engine
                            .update()
                            .map_err(|e| Error::gpu(e.to_string()))?;
                        renderer.capture(settings, frame)?
                    }
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

fn run(reader: &mut impl BufRead, writer: &mut impl Write) -> Result<()> {
    let mut session = Session::default();
    while let Some(Packet { header, bytes }) = read_packet(reader)? {
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
    run(&mut io::stdin().lock(), &mut io::stdout().lock())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

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
    fn hello_and_recoverable_errors_keep_the_session_in_sync() {
        let mut bytes = Cursor::new(b"{\"id\":1,\"type\":\"hello\",\"protocol\":1}\n{\"id\":2,\"type\":\"render\",\"frame\":0}\n");
        let mut output = Vec::new();
        run(&mut bytes, &mut output).unwrap();
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
