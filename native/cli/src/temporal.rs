use crate::{
    error::{Error, Result},
    render_settings::{self, SampleSequence},
    run::{Format, Settings},
    shot::Denoise,
    warnings::Warning,
};
use mutracer_native::api;
use serde::{Deserialize, Serialize};
use std::{io::Cursor, sync::mpsc, thread, time::Duration};

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
    pub fn check_budget(&self, settings: Settings, pointer: &str) -> Result<()> {
        if settings.denoise == Denoise::Temporal && self.options.memory_budget.is_some() {
            self.options.estimate(settings.size, 0).map_err(|e| {
                Error::validation(
                    format!("{pointer}/memoryBudget"),
                    e.to_string(),
                    "Increase the byte budget or reduce the output size.",
                )
            })?;
        }
        Ok(())
    }
    pub fn cuts_at(&self, frame: u32, previous_time: f64, current_time: f64) -> bool {
        self.cuts.iter().any(|cut| match cut {
            Cut::Frame(index) => *index == frame,
            Cut::Time { time } => previous_time < *time && *time <= current_time,
        })
    }
    pub fn configure_capture(&self, render: &api::Render, denoise: Denoise) -> Result<()> {
        let mut settings = render.settings().map_err(gpu)?;
        let enabled = denoise == Denoise::Temporal && self.options.reflection_motion;
        if settings.capture_reflections != enabled {
            settings.capture_reflections = enabled;
            render.set_settings(settings).map_err(gpu)?;
        }
        Ok(())
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
    if model != Denoise::Temporal
        || render_settings::denoiser_library(model, pointer)
            .ok()?
            .is_some()
    {
        return None;
    }
    Some(Warning {
        code: "W3".into(),
        pointer: pointer.into(),
        message: "Temporal reconstruction is using bundled OIDN weights.".into(),
        hint: "Set MUTRACER_OIDN_WEIGHTS to the directory containing all three cleanAuxLarge weights for the reference spatial filter.".into(),
    })
}
pub fn gpu(e: impl std::fmt::Display) -> Error {
    Error::gpu(e.to_string())
}
// Metal can block inside command-buffer creation before a device poll or
// deadline check is possible. This guard runs only in the render worker, and
// only during a temporal GPU operation. Sampling and disk I/O are outside it.
fn watched<T>(timeout: Duration, stage: &str, operation: impl FnOnce() -> T) -> T {
    thread::scope(|scope| {
        let (done, completed) = mpsc::channel::<()>();
        scope.spawn(move || {
            if completed.recv_timeout(timeout) == Err(mpsc::RecvTimeoutError::Timeout) {
                eprintln!(
                    "GPU timeout during {stage} after {} seconds",
                    timeout.as_secs_f64()
                );
                std::process::exit(5);
            }
        });
        let result = operation();
        drop(done);
        result
    })
}

// Match the convergence budget for a single operation, including cold pipelines.
const TEMPORAL_TIMEOUT: Duration = Duration::from_secs(600);

pub fn push(filter: &mut api::TemporalDenoiser, index: u32, render: &api::Render) -> Result<()> {
    watched(TEMPORAL_TIMEOUT, "temporal input", || {
        filter.push(index, render)
    })
    .map_err(gpu)
}

pub fn flush(filter: &mut api::TemporalDenoiser) -> Result<Option<api::OfflineFrame>> {
    watched(TEMPORAL_TIMEOUT, "temporal flush", || filter.flush()).map_err(gpu)
}

pub fn encode(frame: &api::OfflineFrame, format: Format) -> Result<Vec<u8>> {
    let image = watched(TEMPORAL_TIMEOUT, "temporal readback", || {
        frame.read_pixels(false)
    })
    .map_err(gpu)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_guide_accumulation_in_temporal_settings() {
        assert!(!serde_json::from_str::<Config>("{}").unwrap().options.accumulate_guides);
        let settings: Config = serde_json::from_str(r#"{"accumulateGuides":true}"#).unwrap();
        assert!(settings.options.accumulate_guides);
        assert!(serde_json::from_str::<Config>(r#"{"accumulateGuides":null}"#).is_err());
    }

    #[test]
    fn parses_reflection_motion_in_temporal_settings() {
        let defaults: Config = serde_json::from_str("{}").unwrap();
        let enabled: Config = serde_json::from_str(r#"{"reflectionMotion":true}"#).unwrap();
        assert!(!defaults.options.reflection_motion);
        assert!(enabled.options.reflection_motion);
        assert!(serde_json::from_str::<Config>(r#"{"reflectionMotion":null}"#).is_err());
    }

    #[test]
    fn stalled_temporal_operation_exits_with_retryable_gpu_status() {
        const CHILD: &str = "MT_TEST_STALLED_TEMPORAL_OPERATION";
        if std::env::var_os(CHILD).is_some() {
            watched(Duration::from_millis(20), "test temporal operation", || {
                // Finite fallback bounds the parent test if the guard regresses.
                thread::sleep(Duration::from_secs(2));
            });
            return;
        }
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "temporal::tests::stalled_temporal_operation_exits_with_retryable_gpu_status",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(5));
        assert!(
            String::from_utf8_lossy(&result.stderr)
                .contains("GPU timeout during test temporal operation")
        );
        assert_eq!(
            watched(Duration::from_secs(1), "healthy operation", || 42),
            42
        );
    }
}
