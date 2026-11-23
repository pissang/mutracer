use crate::error::{Error, Result, escape};
use crate::render_settings::{RenderOptions, SampleSequence};
use glam::{EulerRot, Quat};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

pub const SCHEMA: &str = include_str!("../schema/mutracer-shot-v1.json");
pub const MAX_SHOT_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_FRAMES: u32 = 100_000;
pub const MAX_GEOMETRY_BYTES: u64 = 8 << 30;
pub const MAX_TEXTURE_BYTES: u64 = 3 << 30;

#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum Channel<T> {
    Constant(T),
    Track(Track<T>),
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Track<T> {
    keys: Vec<(f64, T)>,
    #[serde(default)]
    ease: Ease,
}

#[derive(Clone, Default, Deserialize)]
#[serde(untagged)]
enum Ease {
    #[default]
    Default,
    Named(EaseName),
    Curve(Curve),
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum EaseName {
    Linear,
    Step,
    InOutSine,
    InOutQuad,
    InOutCubic,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Curve {
    bezier: [f64; 4],
}

impl Ease {
    fn apply(&self, t: f64) -> f64 {
        match self {
            Ease::Default | Ease::Named(EaseName::Linear) => t,
            Ease::Named(EaseName::Step) => 0.,
            Ease::Named(EaseName::InOutSine) => (1. - (std::f64::consts::PI * t).cos()) / 2.,
            Ease::Named(EaseName::InOutQuad) if t < 0.5 => 2. * t * t,
            Ease::Named(EaseName::InOutQuad) => 1. - 2. * (1. - t).powi(2),
            Ease::Named(EaseName::InOutCubic) if t < 0.5 => 4. * t.powi(3),
            Ease::Named(EaseName::InOutCubic) => 1. - 4. * (1. - t).powi(3),
            Ease::Curve(Curve {
                bezier: [x1, y1, x2, y2],
            }) => {
                fn cubic(t: f64, a: f64, b: f64) -> f64 {
                    let u = 1. - t;
                    3. * u * u * t * a + 3. * u * t * t * b + t * t * t
                }
                let (mut lo, mut hi) = (0., 1.);
                for _ in 0..30 {
                    let mid = (lo + hi) * 0.5;
                    if cubic(mid, *x1, *x2) < t {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                cubic((lo + hi) * 0.5, *y1, *y2)
            }
        }
    }
}

pub trait Interpolate: Copy {
    fn mix(self, other: Self, t: f64) -> Self;
    fn compatible(self, _other: Self) -> bool {
        true
    }
}
impl Interpolate for f32 {
    fn mix(self, other: Self, t: f64) -> Self {
        (f64::from(self) * (1. - t) + f64::from(other) * t) as f32
    }
}
impl<const N: usize> Interpolate for [f32; N] {
    fn mix(self, other: Self, t: f64) -> Self {
        std::array::from_fn(|i| self[i].mix(other[i], t))
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(untagged)]
pub enum MaterialValue {
    Scalar(f32),
    Pair([f32; 2]),
    Triple([f32; 3]),
    Quad([f32; 4]),
}

impl MaterialValue {
    pub fn packed(self) -> ([f32; 4], usize) {
        match self {
            Self::Scalar(a) => ([a, 0., 0., 0.], 1),
            Self::Pair([a, b]) => ([a, b, 0., 0.], 2),
            Self::Triple([a, b, c]) => ([a, b, c, 0.], 3),
            Self::Quad(v) => (v, 4),
        }
    }
}

impl Interpolate for MaterialValue {
    fn mix(self, other: Self, t: f64) -> Self {
        match (self, other) {
            (Self::Scalar(a), Self::Scalar(b)) => Self::Scalar(a.mix(b, t)),
            (Self::Pair(a), Self::Pair(b)) => Self::Pair(a.mix(b, t)),
            (Self::Triple(a), Self::Triple(b)) => Self::Triple(a.mix(b, t)),
            (Self::Quad(a), Self::Quad(b)) => Self::Quad(a.mix(b, t)),
            _ => unreachable!("validated key shape"),
        }
    }
    fn compatible(self, other: Self) -> bool {
        std::mem::discriminant(&self) == std::mem::discriminant(&other)
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(untagged)]
pub enum Rotation {
    Euler([f32; 3]),
    Quaternion([f32; 4]),
}

fn unit_quat(q: [f32; 4]) -> Quat {
    let max = q.iter().fold(0.0_f32, |a, b| a.max(b.abs()));
    Quat::from_array(q.map(|x| x / max)).normalize()
}

impl Rotation {
    pub fn quaternion(self) -> Quat {
        match self {
            Self::Euler(a) => Quat::from_euler(
                EulerRot::XYZ,
                a[0].to_radians(),
                a[1].to_radians(),
                a[2].to_radians(),
            ),
            Self::Quaternion(q) => unit_quat(q),
        }
    }
}
impl Interpolate for Rotation {
    fn mix(self, other: Self, t: f64) -> Self {
        match (self, other) {
            (Self::Euler(a), Self::Euler(b)) => Self::Euler(a.mix(b, t)),
            _ => Self::Quaternion(
                self.quaternion()
                    .slerp(other.quaternion(), t as f32)
                    .to_array(),
            ),
        }
    }
    fn compatible(self, other: Self) -> bool {
        std::mem::discriminant(&self) == std::mem::discriminant(&other)
    }
}

impl<T: Interpolate> Channel<T> {
    pub fn at(&self, t: f64) -> T {
        match self {
            Self::Constant(v) => *v,
            Self::Track(track) => {
                let next = track.keys.partition_point(|k| k.0 <= t);
                if next == 0 {
                    return track.keys[0].1;
                }
                let (start, a) = track.keys[next - 1];
                if next == track.keys.len() || t == start {
                    return a;
                }
                let (end, b) = track.keys[next];
                a.mix(b, track.ease.apply((t - start) / (end - start)))
            }
        }
    }
    pub fn check(
        &self,
        at: &str,
        duration: f64,
        expected: &str,
        value_ok: impl Fn(T) -> bool,
    ) -> Result<()> {
        let value_error = |path| {
            Error::validation(
                path,
                format!("Expected {expected}"),
                "Correct the constant or keyframe value.",
            )
        };
        match self {
            Self::Constant(value) => {
                if !value_ok(*value) {
                    return Err(value_error(at.to_owned()));
                }
            }
            Self::Track(track) => {
                if track.keys.is_empty() || track.keys.len() > 100_000 {
                    return Err(Error::validation(
                        format!("{at}/keys"),
                        "Expected 1 to 100000 keys",
                        "Give a constant or a nonempty keyframe list.",
                    ));
                }
                let mut previous = -1.;
                let shape = track.keys[0].1;
                for (i, &(time, value)) in track.keys.iter().enumerate() {
                    if !(0. ..=duration).contains(&time) || time <= previous {
                        return Err(Error::validation(
                            format!("{at}/keys/{i}/0"),
                            "Expected a strictly increasing time within the shot",
                            "Sort unique key times and keep them in [0, duration].",
                        ));
                    }
                    if !shape.compatible(value) || !value_ok(value) {
                        return Err(value_error(format!("{at}/keys/{i}/1")));
                    }
                    previous = time;
                }
                if let Ease::Curve(curve) = &track.ease {
                    if !curve.bezier.iter().all(|v| (0. ..=1.).contains(v)) {
                        return Err(Error::validation(
                            format!("{at}/ease/bezier"),
                            "Expected four coordinates from 0 to 1",
                            "Use a named ease or constrained cubic control points.",
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

pub fn at<T: Interpolate>(channel: &Option<Channel<T>>, default: T, t: f64) -> T {
    channel.as_ref().map_or(default, |c| c.at(t))
}

#[derive(
    Clone, Copy, Debug, Default, Deserialize, serde::Serialize, clap::ValueEnum, PartialEq, Eq,
)]
#[serde(rename_all = "lowercase")]
pub enum Seed {
    #[default]
    Fixed,
    Frame,
}

#[derive(
    Clone, Copy, Debug, Default, Deserialize, serde::Serialize, clap::ValueEnum, PartialEq, Eq,
)]
#[serde(rename_all = "camelCase")]
pub enum Denoise {
    #[default]
    Oidn,
    #[value(name = "cleanAuxLarge", alias = "clean-aux-large")]
    CleanAuxLarge,
    Temporal,
    None,
}

#[derive(
    Clone, Copy, Debug, Default, Deserialize, serde::Serialize, clap::ValueEnum, PartialEq, Eq,
)]
#[serde(rename_all = "lowercase")]
pub enum Tracer {
    /// Hardware ray queries when the GPU supports them, otherwise software traversal.
    #[default]
    Hardware,
    /// Software BVH traversal on every GPU.
    Software,
}

impl From<Tracer> for mutracer_native::api::Backend {
    fn from(tracer: Tracer) -> Self {
        match tracer {
            Tracer::Hardware => Self::Hardware,
            Tracer::Software => Self::Software,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tonemap {
    #[default]
    Agx,
    Aces,
    Cineon,
    Linear,
    Reinhard,
    None,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Display {
    #[serde(default)]
    #[serde(alias = "toneMapping")]
    pub tonemap: Tonemap,
    pub exposure: Option<Channel<f32>>,
    #[serde(rename = "toneMappingExposure")]
    pub tone_mapping_exposure: Option<Channel<f32>>,
}

impl Display {
    pub fn check(&self, duration: f64, pointer: &str) -> Result<()> {
        if self.exposure.is_some() && self.tone_mapping_exposure.is_some() {
            return Err(Error::validation(
                pointer,
                "Two exposure fields were supplied",
                "Use exposure in stops or toneMappingExposure as a linear multiplier.",
            ));
        }
        for (field, channel) in [
            ("exposure", &self.exposure),
            ("toneMappingExposure", &self.tone_mapping_exposure),
        ] {
            if let Some(channel) = channel {
                channel.check(
                    &format!("{pointer}/{field}"),
                    duration,
                    "a finite exposure",
                    |value| {
                        if field == "exposure" {
                            value.exp2().is_finite() && value.exp2() > 0.
                        } else {
                            value.is_finite() && value >= 0.
                        }
                    },
                )?;
            }
        }
        Ok(())
    }

    pub fn at(&self, t: f64) -> mutracer_native::api::DisplaySettings {
        use mutracer_native::api::{DisplaySettings, ToneMapping};
        DisplaySettings {
            tone_mapping: match self.tonemap {
                Tonemap::Agx => ToneMapping::Agx,
                Tonemap::Aces => ToneMapping::Aces,
                Tonemap::Cineon => ToneMapping::Cineon,
                Tonemap::Reinhard => ToneMapping::Reinhard,
                Tonemap::Linear | Tonemap::None => ToneMapping::Linear,
            },
            tone_mapping_exposure: self
                .tone_mapping_exposure
                .as_ref()
                .map_or_else(|| at(&self.exposure, 0., t).exp2(), |channel| channel.at(t)),
            ..Default::default()
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Output {
    pub duration: f64,
    #[serde(default = "default_size")]
    pub size: [u32; 2],
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default = "default_spp")]
    pub spp: u32,
    #[serde(default)]
    pub seed: Seed,
    #[serde(default = "default_seed")]
    pub seed_value: u32,
    #[serde(default)]
    pub sample_sequence_offset: u32,
    #[serde(default)]
    pub sample_sequence: SampleSequence,
    #[serde(default)]
    pub render: RenderOptions,
    #[serde(default)]
    pub denoise: Denoise,
    #[serde(default)]
    pub temporal: crate::temporal::Config,
    #[serde(default)]
    pub tracer: Tracer,
    #[serde(default)]
    pub display: Display,
}

fn default_size() -> [u32; 2] {
    [1280, 720]
}
fn default_fps() -> u32 {
    24
}
fn default_spp() -> u32 {
    32
}
fn default_seed() -> u32 {
    12345
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sidecar {
    pub file: PathBuf,
    pub dtype: Dtype,
    pub shape: Vec<u32>,
    #[serde(default)]
    pub offset: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Dtype {
    F32,
    U32,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Data<T> {
    Inline(Vec<T>),
    Binary(Sidecar),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Geometry {
    pub positions: Data<[f32; 3]>,
    pub indices: Data<u32>,
    pub normals: Option<Data<[f32; 3]>>,
    pub uv: Option<Data<[f32; 2]>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Asset {
    Gltf(GltfAsset),
    Hdr(HdrAsset),
    Image(ImageAsset),
    MaterialX(MaterialXAsset),
    InstanceFile(InstanceFile),
    InstanceView(InstanceView),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GltfAsset {
    pub gltf: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HdrAsset {
    pub hdr: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageAsset {
    pub image: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialXAsset {
    pub materialx: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstanceFile {
    pub instances: PathBuf,
    pub count: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstanceView {
    pub instances: Sidecar,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Object {
    pub name: String,
    pub asset: Option<String>,
    pub shape: Option<Shape>,
    pub geometry: Option<Geometry>,
    pub size: Option<f32>,
    pub fit: Option<Fit>,
    pub position: Option<Channel<[f32; 3]>>,
    pub rotation: Option<Channel<Rotation>>,
    pub scale: Option<Channel<[f32; 3]>>,
    pub material: Option<crate::material::Material>,
    pub instances: Option<String>,
    pub animation: Option<Animation>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    Plane,
    Box,
    Sphere,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fit {
    pub height: f32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Animation {
    pub clip: String,
    pub time: Channel<f32>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Environment {
    pub map: Option<String>,
    pub intensity: Option<Channel<f32>>,
    pub color: Option<Channel<[f32; 3]>>,
    pub rotation: Option<Channel<f32>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Target {
    Name(String),
    Position(Channel<[f32; 3]>),
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum FocusDistance {
    Name(String),
    Distance(Channel<f32>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Camera {
    pub fov: Option<Channel<f32>>,
    pub f_stop: Option<Channel<f32>>,
    pub focus_distance: Option<FocusDistance>,
    pub sensor_height: Option<Channel<f32>>,
    pub target: Target,
    pub position: Option<Channel<[f32; 3]>>,
    pub orbit: Option<Orbit>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Orbit {
    pub azimuth: Option<Channel<f32>>,
    pub elevation: Option<Channel<f32>>,
    pub distance: Option<Channel<f32>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LightKind {
    Rect,
    Disk,
    Cylinder,
    Sphere,
    Directional,
    Spot,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Light {
    #[serde(rename = "type")]
    pub kind: LightKind,
    pub position: Channel<[f32; 3]>,
    pub target: Target,
    pub color: Option<Channel<[f32; 3]>>,
    pub intensity: Option<Channel<f32>>,
    pub size: Option<Channel<[f32; 2]>>,
    pub radius: Option<Channel<f32>>,
    pub length: Option<Channel<f32>>,
    pub angle: Option<Channel<f32>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shot {
    pub version: u32,
    pub output: Output,
    #[serde(default)]
    pub assets: BTreeMap<String, Asset>,
    #[serde(default)]
    pub environment: Environment,
    pub objects: Vec<Object>,
    #[serde(default)]
    pub lights: Vec<Light>,
    pub camera: Camera,
    #[serde(skip)]
    pub deprecated_fields: Vec<(String, String)>,
}

pub fn parse(bytes: &[u8]) -> Result<Shot> {
    let raw = serde_json::from_slice(bytes).ok();
    if let Some(value) = &raw {
        reject_null(value, "")?;
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let mut shot: Shot =
        serde_path_to_error::deserialize(&mut decoder).map_err(|error| decode_error("", error))?;
    decoder
        .end()
        .map_err(|e| Error::validation("", e.to_string(), "Supply one JSON object."))?;
    shot.check()?;
    if let Some(value) = raw {
        let display = &value["output"]["display"];
        if let Some(tonemap) = display.get("tonemap") {
            let replacement = if tonemap == "none" {
                "linear"
            } else {
                tonemap.as_str().expect("validated tone mapping name")
            };
            shot.deprecated_fields.push((
                "/output/display/tonemap".into(),
                format!("Use toneMapping: {replacement:?}."),
            ));
        }
        if display.get("exposure").is_some() {
            shot.deprecated_fields.push((
                "/output/display/exposure".into(),
                "Use toneMappingExposure. For a constant, set it to 2 raised to the exposure in stops. For a track, evaluate the stops before converting to linear.".into(),
            ));
        }
        if let Some(objects) = value["objects"].as_array() {
            for (index, object) in objects.iter().enumerate() {
                crate::material::deprecated_fields(
                    &object["material"],
                    &format!("/objects/{index}/material"),
                    &mut shot.deprecated_fields,
                );
            }
        }
    }
    Ok(shot)
}

pub fn decode_error<E: std::fmt::Display>(
    prefix: &str,
    error: serde_path_to_error::Error<E>,
) -> Error {
    use serde_path_to_error::Segment;
    let mut pointer = prefix.to_owned();
    for segment in error.path() {
        match segment {
            Segment::Seq { index } => pointer.push_str(&format!("/{index}")),
            Segment::Map { key } => pointer.push_str(&format!("/{}", escape(key))),
            Segment::Enum { variant } => pointer.push_str(&format!("/{}", escape(variant))),
            Segment::Unknown => {}
        }
    }
    let message = error.inner().to_string();
    if let Some(rest) = message.strip_prefix("unknown field `") {
        if let Some((key, _)) = rest.split_once('`') {
            let key = format!("/{}", escape(key));
            if !pointer.ends_with(&key) {
                pointer.push_str(&key);
            }
        }
    }
    Error::validation(
        pointer,
        message,
        "Check the field type and spelling with mutracer schema.",
    )
}

pub fn reject_null(value: &serde_json::Value, pointer: &str) -> Result<()> {
    use serde_json::Value;
    match value {
        Value::Null => {
            return Err(Error::validation(
                pointer,
                "Null is not a shot value",
                "Remove optional fields to use their defaults.",
            ));
        }
        Value::Array(values) => {
            for (i, value) in values.iter().enumerate() {
                reject_null(value, &format!("{pointer}/{i}"))?;
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                reject_null(value, &format!("{pointer}/{}", escape(key)))?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn check_size([w, h]: [u32; 2]) -> Result<()> {
    if !(1..=8192).contains(&w)
        || !(1..=8192).contains(&h)
        || u64::from(w) * u64::from(h) > 16_777_216
    {
        return Err(Error::validation(
            "/output/size",
            "Expected edges of 1 to 8192 and at most 16777216 pixels",
            "Reduce the frame size.",
        ));
    }
    Ok(())
}
pub fn frame_count(duration: f64, fps: u32) -> Result<u32> {
    let frames = (duration * f64::from(fps)).ceil();
    if !duration.is_finite() || duration <= 0. || frames > f64::from(MAX_FRAMES) {
        return Err(Error::validation(
            "/output/duration",
            "Expected a positive duration with at most 100000 frames",
            "Shorten the shot or lower the frame rate.",
        ));
    }
    if !(1..=240).contains(&fps) {
        return Err(Error::validation(
            "/output/fps",
            "Expected a frame rate from 1 to 240",
            "Set the fps to a supported integer.",
        ));
    }
    Ok(frames.max(1.) as u32)
}
pub fn check_samples(spp: u32, offset: u32) -> Result<()> {
    if !(1..=16384).contains(&spp) || offset.checked_add(spp - 1).is_none() {
        return Err(Error::validation(
            "/output/spp",
            "Expected 1 to 16384 samples in the u32 sequence range",
            "Reduce the sample count or sequence offset.",
        ));
    }
    Ok(())
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= 128 && !name.chars().any(|c| c < ' ')
}

impl Shot {
    fn check(&mut self) -> Result<()> {
        let bad = |at, msg| Error::validation(at, msg, "Refer to the v1 shot schema.");
        if self.version != 1 {
            return Err(bad("/version", "Expected shot version 1"));
        }
        let duration = self.output.duration;
        check_size(self.output.size)?;
        check_samples(self.output.spp, self.output.sample_sequence_offset)?;
        let frames = frame_count(duration, self.output.fps)?;
        self.output.sample_sequence.offset(
            self.output.sample_sequence_offset,
            self.output.spp,
            frames - 1,
            "/output/sampleSequenceOffset",
        )?;
        self.output
            .temporal
            .validate("/output/temporal", Some(duration), self.output.fps)?;
        self.output.render.check("/output/render")?;
        let mut names = BTreeSet::new();
        if self.objects.is_empty() || self.objects.len() > 65_536 {
            return Err(bad("/objects", "Expected 1 to 65536 objects"));
        }
        for (i, object) in self.objects.iter().enumerate() {
            if !valid_name(&object.name) || !names.insert(object.name.as_str()) {
                return Err(Error::validation(
                    format!("/objects/{i}/name"),
                    "Expected a unique nonempty name of at most 128 characters",
                    "Use a distinct name without control characters.",
                ));
            }
        }
        for name in self.assets.keys() {
            if !valid_name(name) {
                return Err(Error::validation(
                    format!("/assets/{}", escape(name)),
                    "Invalid asset name",
                    "Use a nonempty name of at most 128 characters.",
                ));
            }
        }
        let target = |value: &Target, path: &str| match value {
            Target::Name(name) if !names.contains(name.as_str()) => Err(Error::validation(
                path,
                format!("Unknown object {name:?}"),
                "Name an object in this shot, or use a point.",
            )),
            Target::Name(_) => Ok(()),
            Target::Position(channel) => channel.check(path, duration, "a finite point", finite),
        };
        macro_rules! channel {
            ($value:expr, $path:expr, $description:expr, $pred:expr) => {
                if let Some(ch) = $value {
                    ch.check($path, duration, $description, $pred)?;
                }
            };
        }
        let positive = |v: f32| v.is_finite() && v > 0.;
        let nonnegative = |v: f32| v.is_finite() && v >= 0.;
        let fov = |v: f32| v > 0. && v < 180.;
        let color = |v: [f32; 3]| v.into_iter().all(nonnegative);
        self.output.display.check(duration, "/output/display")?;
        channel!(&self.camera.fov, "/camera/fov", "degrees in (0, 180)", fov);
        channel!(
            &self.camera.f_stop,
            "/camera/fStop",
            "a nonnegative f-number",
            nonnegative
        );
        channel!(
            &self.camera.sensor_height,
            "/camera/sensorHeight",
            "a positive height in millimetres",
            positive
        );
        match &self.camera.focus_distance {
            Some(FocusDistance::Distance(c)) => c.check(
                "/camera/focusDistance",
                duration,
                "a positive distance in metres",
                positive,
            )?,
            Some(FocusDistance::Name(name)) if !names.contains(name.as_str()) => {
                return Err(Error::validation(
                    "/camera/focusDistance",
                    format!("Unknown focus object {name:?}"),
                    "Use the name of an object in the shot or a positive distance in metres.",
                ));
            }
            _ => {}
        }
        match (&self.camera.position, &self.camera.orbit) {
            (Some(p), None) => p.check("/camera/position", duration, "a finite point", finite)?,
            (None, Some(orbit)) => {
                channel!(
                    &orbit.azimuth,
                    "/camera/orbit/azimuth",
                    "finite degrees",
                    f32::is_finite
                );
                channel!(
                    &orbit.elevation,
                    "/camera/orbit/elevation",
                    "finite degrees",
                    f32::is_finite
                );
                channel!(
                    &orbit.distance,
                    "/camera/orbit/distance",
                    "a positive distance",
                    positive
                );
            }
            _ => return Err(bad("/camera", "Expected exactly one of position or orbit")),
        }
        for (i, obj) in self.objects.iter().enumerate() {
            let path = format!("/objects/{i}");
            let source_count = [
                obj.asset.is_some(),
                obj.shape.is_some(),
                obj.geometry.is_some(),
            ]
            .into_iter()
            .filter(|v| *v)
            .count();
            if source_count != 1 {
                return Err(Error::validation(
                    &path,
                    "Expected exactly one of asset, shape or geometry",
                    "Keep one geometry source.",
                ));
            }
            if obj
                .size
                .is_some_and(|v| obj.shape.is_none() || !positive(v))
            {
                return Err(Error::validation(
                    format!("{path}/size"),
                    "Expected a positive primitive size",
                    "Use size with shape.",
                ));
            }
            if obj
                .fit
                .as_ref()
                .is_some_and(|v| obj.asset.is_none() || !positive(v.height))
            {
                return Err(Error::validation(
                    format!("{path}/fit/height"),
                    "Expected a positive glTF fit height",
                    "Use fit only with a glTF asset.",
                ));
            }
            if let Some(animation) = &obj.animation {
                if obj.asset.is_none() || !valid_name(&animation.clip) {
                    return Err(Error::validation(
                        format!("{path}/animation"),
                        "Expected a glTF asset and clip name",
                        "Specify an imported animation clip.",
                    ));
                }
                animation.time.check(
                    &format!("{path}/animation/time"),
                    duration,
                    "nonnegative clip time",
                    nonnegative,
                )?;
            }
            channel!(
                &obj.position,
                &format!("{path}/position"),
                "a finite point",
                finite
            );
            channel!(
                &obj.scale,
                &format!("{path}/scale"),
                "positive XYZ scale",
                |a: [f32; 3]| a.into_iter().all(positive)
            );
            channel!(
                &obj.rotation,
                &format!("{path}/rotation"),
                "Euler XYZ angles or a nonzero quaternion",
                |r| match r {
                    Rotation::Euler(a) => finite(a),
                    Rotation::Quaternion(a) => finite(a) && a.iter().any(|v| *v != 0.),
                }
            );
            if let Some(m) = &obj.material {
                let path = format!("{path}/material");
                for (name, value) in m.inputs.iter().flatten() {
                    value.check(
                        &format!("{path}/inputs/{}", escape(name)),
                        duration,
                        "numeric values of one shape",
                        |value| finite(value.packed().0),
                    )?;
                }
                if m.inputs.is_some() && m.asset.is_none() {
                    return Err(Error::validation(
                        format!("{path}/inputs"),
                        "Inputs require a MaterialX asset",
                        "Specify the material asset or remove inputs.",
                    ));
                }
            }
        }
        if self.lights.len() > 1024 {
            return Err(bad("/lights", "Expected at most 1024 lights"));
        }
        for (i, light) in self.lights.iter().enumerate() {
            let path = format!("/lights/{i}");
            target(&light.target, &format!("{path}/target"))?;
            light.position.check(
                &format!("{path}/position"),
                duration,
                "a finite point",
                finite,
            )?;
            channel!(
                &light.color,
                &format!("{path}/color"),
                "nonnegative RGB",
                color
            );
            channel!(
                &light.intensity,
                &format!("{path}/intensity"),
                "nonnegative intensity",
                nonnegative
            );
            let required = match light.kind {
                LightKind::Rect => [true, false, false, false],
                LightKind::Disk | LightKind::Sphere => [false, true, false, false],
                LightKind::Cylinder => [false, true, true, false],
                LightKind::Directional => [false, false, false, false],
                LightKind::Spot => [false, false, false, true],
            };
            if required
                != [
                    light.size.is_some(),
                    light.radius.is_some(),
                    light.length.is_some(),
                    light.angle.is_some(),
                ]
            {
                return Err(Error::validation(
                    &path,
                    "Missing or extra dimensions for this light type",
                    "Check the light type's required dimensions with mutracer schema.",
                ));
            }
            channel!(
                &light.size,
                &format!("{path}/size"),
                "positive width and height",
                |a: [f32; 2]| a.into_iter().all(positive)
            );
            channel!(
                &light.radius,
                &format!("{path}/radius"),
                "a positive radius",
                positive
            );
            channel!(
                &light.length,
                &format!("{path}/length"),
                "a positive length",
                positive
            );
            channel!(
                &light.angle,
                &format!("{path}/angle"),
                "degrees in (0, 180)",
                fov
            );
        }
        for (index, object) in self.objects.iter_mut().enumerate() {
            if let Some(material) = &mut object.material {
                material.check(duration, &format!("/objects/{index}/material"))?;
            }
        }
        Ok(())
    }
}

pub fn finite<const N: usize>(a: [f32; N]) -> bool {
    a.into_iter().all(f32::is_finite)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_clamp_ease_and_switch_steps_at_exact_keys() {
        let linear: Channel<f32> = serde_json::from_str(r#"{"keys":[[1,2],[3,6]]}"#).unwrap();
        let step: Channel<f32> =
            serde_json::from_str(r#"{"keys":[[1,2],[3,6]],"ease":"step"}"#).unwrap();
        let curve: Channel<f32> =
            serde_json::from_str(r#"{"keys":[[1,2],[3,6]],"ease":{"bezier":[0,0,1,1]}}"#).unwrap();
        assert_eq!(
            [linear.at(0.), linear.at(2.), linear.at(3.), linear.at(4.)],
            [2., 4., 6., 6.]
        );
        assert_eq!([step.at(2.999), step.at(3.)], [2., 6.]);
        assert!((curve.at(2.) - 4.).abs() < 1e-6);
    }

    #[test]
    fn tracks_reject_duplicate_times_and_mixed_rotations_with_pointers() {
        let dupe: Channel<f32> = serde_json::from_str(r#"{"keys":[[0,2],[0,6]]}"#).unwrap();
        assert_eq!(
            dupe.check("/amount", 1., "amount", f32::is_finite)
                .unwrap_err()
                .pointer
                .as_deref(),
            Some("/amount/keys/1/0")
        );
        let mixed: Channel<Rotation> =
            serde_json::from_str(r#"{"keys":[[0,[0,0,0]],[1,[0,0,0,1]]]}"#).unwrap();
        assert_eq!(
            mixed
                .check("/rotation", 1., "one rotation type", |_| true)
                .unwrap_err()
                .pointer
                .as_deref(),
            Some("/rotation/keys/1/1")
        );
        let a = Rotation::Quaternion([0., 0., 0., 1.]);
        let b = Rotation::Quaternion([0., 0., 0., -1.]);
        assert!(a.mix(b, 0.5).quaternion().abs_diff_eq(Quat::IDENTITY, 1e-6));
    }

    #[test]
    fn display_accepts_zero_linear_exposure_and_rejects_duplicate_units() {
        let black: Display =
            serde_json::from_str(r#"{"toneMapping":"cineon","toneMappingExposure":0}"#).unwrap();
        black.check(1., "/output/display").unwrap();
        assert_eq!(black.at(0.).tone_mapping_exposure, 0.);
        let duplicate: Display =
            serde_json::from_str(r#"{"exposure":0,"toneMappingExposure":1}"#).unwrap();
        assert!(duplicate.check(1., "/output/display").is_err());
    }

    #[test]
    fn image_and_sequence_limits_are_checked() {
        assert!(check_size([8192, 8192]).is_err());
        assert!(check_size([4096, 4096]).is_ok());
        assert!(check_samples(0, 0).is_err());
        assert!(check_samples(2, u32::MAX).is_err());
        assert_eq!(frame_count(1., 24).unwrap(), 24);
        assert_eq!(frame_count(0.1, 24).unwrap(), 3);
    }
}
