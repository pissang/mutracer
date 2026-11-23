use crate::{
    error::{Error, Result},
    render_settings::{self, SampleSequence},
    run::{Format, Settings},
    shot::Denoise,
    warnings::Warning,
};
use mutracer_native::api;
use serde::{Deserialize, Serialize};
use std::io::Cursor;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub mode: Option<String>,
    pub cuts: Vec<Cut>,
    #[serde(flatten)]
    pub options: api::TemporalOptions,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum Cut {
    Frame(u32),
    Time { time: f64 },
}
impl Config {
    pub fn validate(&self, pointer: &str, duration: Option<f64>, fps: u32) -> Result<()> {
        if self.mode.as_deref().is_some_and(|m| m != "offline") {
            return Err(Error::validation(
                format!("{pointer}/mode"),
                "Only offline temporal reconstruction is available",
                "Set mode to offline.",
            ));
        }
        self.options.validate().map_err(|e| {
            Error::validation(
                pointer,
                e,
                "Check the history radius, post radius, sparkle setting and byte budget.",
            )
        })?;
        for (i, cut) in self.cuts.iter().enumerate() {
            let t = match cut {
                Cut::Frame(frame) => f64::from(*frame) / f64::from(fps),
                Cut::Time { time } => *time,
            };
            if !t.is_finite() || t < 0. || duration.is_some_and(|end| t >= end) {
                return Err(Error::validation(
                    format!("{pointer}/cuts/{i}"),
                    "Cut is outside the shot",
                    "Choose a frame index or time inside the shot.",
                ));
            }
        }
        Ok(())
    }
    pub fn cuts_at(&self, frame: u32, fps: u32) -> bool {
        self.cuts.iter().any(|cut| match cut {
            Cut::Frame(index) => *index == frame,
            Cut::Time { time } => (*time * f64::from(fps)).ceil() as u32 == frame,
        })
    }
    pub fn start(&self, engine: &api::Engine) -> Result<api::TemporalDenoiser> {
        let library = render_settings::denoiser_library(Denoise::Temporal, "/output/denoise")?;
        api::TemporalDenoiser::new(engine, self.options, api::TemporalSpatial::Oidn(library))
            .map_err(gpu)
    }
}
pub fn validate_settings(settings: Settings, pointer: &str) -> Result<()> {
    if settings.denoise == Denoise::Temporal {
        if settings.stride != 1 {
            return Err(Error::validation(
                format!("{pointer}/stride"),
                "Temporal rendering requires stride 1",
                "Use the sequence command at full frame rate.",
            ));
        }
        if settings.sample_sequence != SampleSequence::Frame {
            return Err(Error::validation(
                format!("{pointer}/sampleSequence"),
                "Temporal rendering needs consecutive sample ranges",
                "Set sampleSequence to frame.",
            ));
        }
    }
    Ok(())
}
pub fn fallback(model: Denoise, pointer: &str) -> Option<Warning> {
    (model==Denoise::Temporal && render_settings::denoiser_library(model,pointer).ok().flatten().is_none()).then(||Warning{
        code:"W3".into(),pointer:pointer.into(),message:"Temporal reconstruction is using bundled OIDN weights.".into(),
        hint:"Set MUTRACER_OIDN_WEIGHTS to the directory containing all three cleanAuxLarge weights for the reference spatial filter.".into()
    })
}
pub fn gpu(e: impl std::fmt::Display) -> Error {
    Error::gpu(e.to_string())
}
pub fn encode(frame: &api::OfflineFrame, format: Format) -> Result<Vec<u8>> {
    let image = frame.read_pixels(false).map_err(gpu)?;
    if format == Format::Exr {
        return crate::quality::encode_hdr(image);
    }
    let mut bytes = Vec::with_capacity(image.data.len());
    for p in image.data.chunks_exact(4) {
        for &v in &p[..3] {
            let s = if v <= 0.0031308 {
                12.92 * v
            } else {
                1.055 * v.powf(1. / 2.4) - 0.055
            };
            bytes.push((s.clamp(0., 1.) * 255.).round() as u8);
        }
        bytes.push((p[3].clamp(0., 1.) * 255.).round() as u8);
    }
    let pixels = image::RgbaImage::from_raw(image.width, image.height, bytes)
        .ok_or_else(|| gpu("Incomplete temporal readback"))?;
    let mut out = Cursor::new(Vec::new());
    pixels
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(gpu)?;
    Ok(out.into_inner())
}
