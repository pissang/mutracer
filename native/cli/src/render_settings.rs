use crate::error::{Error, Result};
use crate::shot::Denoise;
use mutracer_native::api;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const LEGACY_BOUNCES: u32 = 6;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderOptions {
    pub bounces: Option<u32>,
    caustics: Option<Caustics>,
    clamping: Option<f64>,
    sampling_pattern: Option<Sampling>,
    #[serde(deserialize_with = "DirectLightCandidates::provided")]
    direct_light_candidates: Option<DirectLightCandidates>,
    dispersion_wavelengths: Option<u32>,
    bevel: Option<bool>,
    bevel_samples: Option<u32>,
    alpha_blend_strategy: Option<AlphaBlend>,
    transmissive_output_alpha_min: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectLightCandidates {
    Auto,
    #[serde(untagged)]
    Count(u32),
}

impl DirectLightCandidates {
    fn provided<'de, D: serde::Deserializer<'de>>(
        de: D,
    ) -> std::result::Result<Option<Self>, D::Error> {
        let value = serde_json::Value::deserialize(de)?;
        if value == "auto" {
            return Ok(Some(Self::Auto));
        }
        value
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .map(|n| Some(Self::Count(n)))
            .ok_or_else(|| {
                serde::de::Error::custom("expected an integer from 1 to 16 or the string \"auto\"")
            })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Caustics {
    light_tracing: Option<bool>,
    photon_mapping: Option<bool>,
    light_photons: Option<u32>,
    photon_map_photons: Option<u32>,
    photon_map_radius: Option<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Sampling {
    Sobol,
    ZSobol,
    Random,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum AlphaBlend {
    Stochastic,
    DeterministicSourceOver,
}

impl RenderOptions {
    pub fn direct_light_candidates(self) -> DirectLightCandidates {
        self.direct_light_candidates.unwrap_or_else(|| {
            DirectLightCandidates::Count(api::RenderSettings::default().direct_light_candidates)
        })
    }

    pub fn has_caustic_transport(self) -> bool {
        self.caustics.is_some_and(|caustics| {
            caustics.light_tracing.unwrap_or(false) || caustics.photon_mapping.unwrap_or(false)
        })
    }

    pub fn apply(self, mut sdk: api::RenderSettings) -> api::RenderSettings {
        sdk.bounces = self.bounces.unwrap_or(LEGACY_BOUNCES);
        if let Some(c) = self.caustics {
            sdk.caustics = api::CausticSettings {
                light_tracing: c.light_tracing.unwrap_or(false),
                photon_mapping: c.photon_mapping.unwrap_or(false),
                light_photons: c.light_photons.unwrap_or(0),
                photon_map_photons: c.photon_map_photons.unwrap_or(0),
                photon_map_radius: c.photon_map_radius.unwrap_or(0.),
            };
        }
        sdk.clamping = self.clamping.unwrap_or(sdk.clamping);
        sdk.sampling_pattern = match self.sampling_pattern {
            Some(Sampling::Sobol) => api::SamplingPattern::Sobol,
            Some(Sampling::ZSobol) => api::SamplingPattern::ZSobol,
            Some(Sampling::Random) => api::SamplingPattern::Random,
            None => sdk.sampling_pattern,
        };
        if let Some(DirectLightCandidates::Count(count)) = self.direct_light_candidates {
            sdk.direct_light_candidates = count;
        }
        sdk.dispersion_wavelengths = self
            .dispersion_wavelengths
            .unwrap_or(sdk.dispersion_wavelengths);
        sdk.bevel = self.bevel.unwrap_or(sdk.bevel);
        sdk.bevel_samples = self.bevel_samples.unwrap_or(sdk.bevel_samples);
        sdk.alpha_blend_strategy = match self.alpha_blend_strategy {
            Some(AlphaBlend::Stochastic) => api::AlphaBlendStrategy::Stochastic,
            Some(AlphaBlend::DeterministicSourceOver) => {
                api::AlphaBlendStrategy::DeterministicSourceOver
            }
            None => sdk.alpha_blend_strategy,
        };
        sdk.transmissive_output_alpha_min = self
            .transmissive_output_alpha_min
            .unwrap_or(sdk.transmissive_output_alpha_min);
        sdk
    }

    pub fn check(self, pointer: &str) -> Result<()> {
        let sdk = self.apply(api::RenderSettings::default());
        let range = |field: &str, valid, values| {
            if valid {
                Ok(())
            } else {
                Err(Error::validation(
                    format!("{pointer}/{field}"),
                    "Render setting is out of range",
                    values,
                ))
            }
        };
        range(
            "bounces",
            (1..=20).contains(&sdk.bounces),
            "Use an integer from 1 to 20.",
        )?;
        range(
            "clamping",
            sdk.clamping.is_finite() && sdk.clamping >= 0.,
            "Use a finite nonnegative value.",
        )?;
        range(
            "directLightCandidates",
            (1..=16).contains(&sdk.direct_light_candidates),
            "Use an integer from 1 to 16 or the string \"auto\".",
        )?;
        range(
            "dispersionWavelengths",
            matches!(sdk.dispersion_wavelengths, 1 | 3),
            "Use 1 or 3.",
        )?;
        range(
            "bevelSamples",
            (1..=32).contains(&sdk.bevel_samples),
            "Use an integer from 1 to 32.",
        )?;
        range(
            "transmissiveOutputAlphaMin",
            (0. ..=1.).contains(&sdk.transmissive_output_alpha_min),
            "Use a value from 0 to 1.",
        )?;
        range(
            "caustics/photonMapPhotons",
            sdk.caustics.photon_map_photons <= 262144,
            "Use an integer from 0 to 262144.",
        )?;
        let radius = sdk.caustics.photon_map_radius;
        range(
            "caustics/photonMapRadius",
            radius.is_finite() && radius >= 0.,
            "Use a finite nonnegative radius.",
        )
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum SampleSequence {
    #[default]
    Fixed,
    Frame,
}

impl SampleSequence {
    pub fn offset(self, base: u32, spp: u32, frame: u32, pointer: &str) -> Result<u32> {
        let offset = match self {
            Self::Fixed => Some(base),
            Self::Frame => frame
                .checked_mul(spp)
                .and_then(|delta| base.checked_add(delta)),
        };
        offset
            .filter(|offset| spp > 0 && offset.checked_add(spp - 1).is_some())
            .ok_or_else(|| {
                Error::validation(
                    pointer,
                    "Sample sequence exceeds the unsigned 32-bit range",
                    "Reduce the base offset, frame index or samples per pixel.",
                )
            })
    }
}

const LARGE_WEIGHTS: [&str; 3] = [
    "rt_hdr_calb_cnrm_large.tza",
    "rt_alb_large.tza",
    "rt_nrm_large.tza",
];

pub fn denoiser_library(model: Denoise, pointer: &str) -> Result<Option<PathBuf>> {
    if model == Denoise::Temporal {
        return Ok(denoiser_library(Denoise::CleanAuxLarge, pointer)
            .ok()
            .flatten());
    }
    if model != Denoise::CleanAuxLarge {
        return Ok(None);
    }
    let directory = std::env::var_os("MUTRACER_OIDN_WEIGHTS").map(PathBuf::from);
    if let Some(directory) = directory {
        if LARGE_WEIGHTS
            .iter()
            .all(|name| directory.join(name).is_file())
        {
            return Ok(Some(directory.join(LARGE_WEIGHTS[0])));
        }
    }
    Err(Error::validation(
        pointer,
        "The cleanAuxLarge OIDN model requires three TZA weights",
        "Download rt_hdr_calb_cnrm_large.tza, rt_alb_large.tza and rt_nrm_large.tza from https://cdn.jsdelivr.net/npm/oidn-weights@2.3.0-1/ and set MUTRACER_OIDN_WEIGHTS to their directory.",
    ))
}

pub fn denoiser_identity(model: Denoise, pointer: &str) -> Result<Option<Vec<String>>> {
    denoiser_library(model, pointer)?
        .map(|path| {
            LARGE_WEIGHTS
                .iter()
                .map(|name| {
                    let path = path.with_file_name(name);
                    std::fs::read(&path)
                        .map(|bytes| crate::assets::digest(&bytes))
                        .map_err(|e| Error::asset(pointer, format!("{}: {e}", path.display())))
                })
                .collect()
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_browser_settings_and_preserves_cli_depth() {
        let defaults = RenderOptions::default().apply(api::RenderSettings::default());
        assert_eq!(defaults.bounces, 6);
        let request: RenderOptions = serde_json::from_value(serde_json::json!({
            "bounces": 3, "caustics": {"lightTracing": true, "photonMapping": true,
            "lightPhotons": 11, "photonMapPhotons": 12, "photonMapRadius": 0.5},
            "clamping": 2.5, "samplingPattern": "zsobol", "directLightCandidates": 8,
            "dispersionWavelengths": 1, "bevel": false, "bevelSamples": 6,
            "alphaBlendStrategy": "deterministic-source-over", "transmissiveOutputAlphaMin": 0.5
        }))
        .unwrap();
        request.check("/settings/render").unwrap();
        let actual = request.apply(api::RenderSettings::default());
        assert_eq!(
            actual.caustics,
            api::CausticSettings {
                light_tracing: true,
                photon_mapping: true,
                light_photons: 11,
                photon_map_photons: 12,
                photon_map_radius: 0.5
            }
        );
        assert_eq!(actual.bounces, 3);
        assert_eq!(actual.clamping, 2.5);
        assert_eq!(actual.sampling_pattern, api::SamplingPattern::ZSobol);
        assert_eq!(actual.direct_light_candidates, 8);
        assert_eq!(actual.dispersion_wavelengths, 1);
        assert!(!actual.bevel);
        assert_eq!(actual.bevel_samples, 6);
        assert_eq!(
            actual.alpha_blend_strategy,
            api::AlphaBlendStrategy::DeterministicSourceOver
        );
        assert_eq!(actual.transmissive_output_alpha_min, 0.5);
        let invalid = RenderOptions {
            bounces: Some(21),
            ..request
        };
        assert_eq!(
            invalid
                .check("/settings/render")
                .unwrap_err()
                .pointer
                .as_deref(),
            Some("/settings/render/bounces")
        );
    }

    #[test]
    fn direct_light_candidates_accepts_only_auto_or_supported_integers() {
        use serde_json::{from_value, json, to_value};
        assert_eq!(
            RenderOptions::default().direct_light_candidates(),
            DirectLightCandidates::Count(4)
        );
        for value in [json!("auto"), json!(1), json!(16)] {
            let request: RenderOptions =
                from_value(json!({"directLightCandidates":value})).unwrap();
            request.check("/settings/render").unwrap();
            assert_eq!(to_value(request.direct_light_candidates()).unwrap(), value);
        }
        for value in [json!(0), json!(17)] {
            let request: RenderOptions =
                from_value(json!({"directLightCandidates":value})).unwrap();
            assert_eq!(
                request
                    .check("/settings/render")
                    .unwrap_err()
                    .pointer
                    .as_deref(),
                Some("/settings/render/directLightCandidates")
            );
        }
        for value in [
            json!("AUTO"),
            json!("8"),
            json!(null),
            json!(false),
            json!({"auto": null}),
            json!(1.5),
            json!(-1),
        ] {
            let error =
                from_value::<RenderOptions>(json!({"directLightCandidates":value})).unwrap_err();
            assert!(error.to_string().contains("1 to 16"), "{error}");
        }
    }

    #[test]
    fn frame_sequence_uses_absolute_frame_index_and_checks_overflow() {
        let mode = SampleSequence::Frame;
        assert_eq!(mode.offset(4, 32, 6, "").unwrap(), 196);
        assert_eq!(mode.offset(u32::MAX - 3, 2, 1, "").unwrap(), u32::MAX - 1);
        assert!(mode.offset(u32::MAX - 3, 2, 2, "").is_err());
    }
}
