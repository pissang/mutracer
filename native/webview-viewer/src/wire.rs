//! Private Engine boundary. Scene bytes remain SDK v8; delta framing is viewer-only.
use anyhow::{Context, Result, bail, ensure};
use mutracer_native::api;
use serde_json::Value;

pub fn camera(value: &Value) -> Result<api::Camera> {
    let values = value.as_array().context("Expected camera words")?;
    ensure!(values.len() == 32, "Camera is 32 words");
    let bytes: Vec<u8> = values
        .iter()
        .map(|v| {
            v.as_u64()
                .filter(|v| *v <= u32::MAX as u64)
                .map(|v| (v as u32).to_le_bytes())
                .context("Invalid camera word")
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    api::Camera::from_bytes(&bytes).context("Invalid camera")
}
pub fn delta(previous: Option<&[u8]>, packet: &[u8]) -> Result<Vec<u8>> {
    ensure!(
        packet.len() % 4 == 0 && packet.len() >= 16,
        "Invalid delta header"
    );
    let word = |i: usize| u32::from_le_bytes(packet[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
    ensure!(word(0) == 1 && word(1) <= 1, "Unsupported delta version");
    let length = word(2).checked_mul(4).context("Descriptor size overflow")?;
    // No viewer-specific asset cap; allocation is limited by the SDK's admission budget.
    let mut result = if word(1) == 1 {
        ensure!(word(3) == 1, "Full descriptor has one span");
        ensure!(
            packet.len() >= 24 && word(4) == 0 && word(5) == word(2) && packet.len() == 24 + length,
            "Invalid full descriptor"
        );
        vec![0; length]
    } else {
        let prior = previous.context("Delta needs a committed descriptor")?;
        ensure!(prior.len() == length, "Delta base length mismatch");
        prior.to_vec()
    };
    let mut at = 4;
    let mut end = 0;
    for _ in 0..word(3) {
        ensure!(at + 2 <= packet.len() / 4, "Truncated span");
        let offset = word(at);
        let count = word(at + 1);
        at += 2;
        ensure!(
            count > 0
                && offset >= end
                && offset <= length / 4
                && count <= length / 4 - offset
                && count <= packet.len() / 4 - at,
            "Invalid delta span"
        );
        result[offset * 4..(offset + count) * 4].copy_from_slice(&packet[at * 4..(at + count) * 4]);
        at += count;
        end = offset + count;
    }
    ensure!(at * 4 == packet.len(), "Trailing delta bytes");
    Ok(result)
}
fn n(v: &Value, k: &str) -> Result<f64> {
    v[k].as_f64()
        .filter(|n| n.is_finite())
        .with_context(|| format!("Invalid setting {k}"))
}
fn u(v: &Value, k: &str) -> Result<u32> {
    let n = n(v, k)?;
    ensure!(
        n >= 0. && n <= u32::MAX as f64 && n.fract() == 0.,
        "Invalid integer {k}"
    );
    Ok(n as u32)
}
fn b(v: &Value, k: &str) -> Result<bool> {
    v[k].as_bool().with_context(|| format!("Invalid bool {k}"))
}
pub fn render(v: &Value, fixed: &Value) -> Result<api::RenderSettings> {
    let mut s = api::RenderSettings::default();
    // Web Render uses sequenceSeed=0; native SDK defaults to 12345.
    s.seed = 0;
    s.max_samples = u(v, "maxSamples")?;
    s.bounces = u(v, "bounces")?;
    s.clamping = n(v, "clamping")?;
    s.direct_light_candidates = u(v, "directLightCandidates")?;
    s.bevel = b(v, "bevel")?;
    s.bevel_samples = u(v, "bevelSamples")?;
    s.dispersion_wavelengths = u(v, "dispersionWavelengths")?;
    s.transmissive_output_alpha_min = n(v, "transmissiveOutputAlphaMin")?;
    s.time_budget_ms = n(v, "timeBudgetMs")?;
    s.batch_samples = b(v, "batchSamples")?;
    s.aov_samples = u(v, "aovSamples")?;
    s.sampling_pattern = match v["samplingPattern"].as_str() {
        Some("sobol") => api::SamplingPattern::Sobol,
        Some("zsobol") => api::SamplingPattern::ZSobol,
        Some("random") => api::SamplingPattern::Random,
        _ => bail!("Unknown sampling pattern"),
    };
    s.alpha_blend_strategy = match v["alphaBlendStrategy"].as_str() {
        Some("stochastic") => api::AlphaBlendStrategy::Stochastic,
        Some("deterministic-source-over") => api::AlphaBlendStrategy::DeterministicSourceOver,
        _ => bail!("Unknown alpha strategy"),
    };
    s.aov_resolution = if v["aovResolution"] == "display" {
        api::AovResolution::Display
    } else {
        api::AovResolution::Render
    };
    for kind in v["aovs"].as_array().context("Expected AOV list")? {
        s.aovs |= pixel(kind.as_str().context("Expected AOV name")?)?.aov_mask();
    }
    s.size = if let Some(fixed) = fixed.as_array() {
        ensure!(fixed.len() == 2, "Fixed size is width,height");
        api::RenderSize::Fixed {
            width: fixed[0].as_u64().context("Invalid width")? as u32,
            height: fixed[1].as_u64().context("Invalid height")? as u32,
        }
    } else {
        api::RenderSize::Scale(n(v, "resolutionScale")?)
    };
    if v["adaptiveResolution"].is_object() {
        let a = &v["adaptiveResolution"];
        s.adaptive_resolution = Some(api::AdaptiveResolution {
            target_frame_ms: n(a, "targetFrameMs")?,
            min_scale: n(a, "minScale")?,
        });
    }
    let c = &v["caustics"];
    if c.is_object() {
        s.caustics.light_tracing = c["lightTracing"].as_bool().unwrap_or(false);
        s.caustics.photon_mapping = c["photonMapping"].as_bool().unwrap_or(false);
        s.caustics.light_photons = c["lightPhotons"].as_u64().unwrap_or(0) as u32;
        s.caustics.photon_map_photons = c["photonMapPhotons"].as_u64().unwrap_or(0) as u32;
        s.caustics.photon_map_radius = c["photonMapRadius"].as_f64().unwrap_or(0.) as f32;
    }
    s.validate()?;
    Ok(s)
}
pub fn pixel(name: &str) -> Result<api::PixelKind> {
    Ok(match name {
        "hdr" => api::PixelKind::Hdr,
        "denoised" => api::PixelKind::Denoised,
        "albedo" => api::PixelKind::Albedo,
        "normal" => api::PixelKind::Normal,
        "depth" => api::PixelKind::Depth,
        "position" => api::PixelKind::Position,
        "roughness" => api::PixelKind::Roughness,
        "diffuseColor" | "diffuseAlbedo" => api::PixelKind::DiffuseAlbedo,
        "specularColor" | "specularAlbedo" => api::PixelKind::SpecularAlbedo,
        "id" => api::PixelKind::Id,
        "motion" => api::PixelKind::Motion,
        "centerNormal" => api::PixelKind::CenterNormal,
        "centerDepth" => api::PixelKind::CenterDepth,
        "centerPosition" => api::PixelKind::CenterPosition,
        _ => bail!("Unknown pixel kind {name}"),
    })
}
pub fn display(v: &Value) -> Result<api::DisplaySettings> {
    let mut s = api::DisplaySettings::default();
    s.tone_mapping = match v["toneMapping"].as_str() {
        Some("agx") => api::ToneMapping::Agx,
        Some("aces") => api::ToneMapping::Aces,
        Some("cineon") => api::ToneMapping::Cineon,
        Some("reinhard") => api::ToneMapping::Reinhard,
        Some("linear") => api::ToneMapping::Linear,
        _ => bail!("Unknown tone mapper"),
    };
    s.tone_mapping_exposure = n(v, "toneMappingExposure")? as f32;
    s.contrast = n(v, "contrast")? as f32;
    s.saturation = n(v, "saturation")? as f32;
    s.temperature = n(v, "temperature")? as f32;
    s.tint = n(v, "tint")? as f32;
    s.vignette = n(v, "vignette")? as f32;
    s.bloom_intensity = n(v, "bloomIntensity")? as f32;
    s.bloom_threshold = n(v, "bloomThreshold")? as f32;
    s.bloom_radius = n(v, "bloomRadius")? as f32;
    s.shadow_catcher_alpha = n(v, "shadowCatcherAlpha")? as f32;
    s.hdr_output_enabled = b(v, "hdrOutputEnabled")?;
    s.channel = match v["channel"].as_str() {
        Some("final") => api::Channel::Final,
        Some("normal") => api::Channel::Normal,
        Some("albedo") => api::Channel::Albedo,
        Some("shadow") => api::Channel::Shadow,
        Some("shadowCatcher") => api::Channel::ShadowCatcher,
        Some("depth") => api::Channel::Depth,
        Some("position") => api::Channel::Position,
        Some("roughness") => api::Channel::Roughness,
        Some("diffuseColor" | "diffuseAlbedo") => api::Channel::DiffuseAlbedo,
        Some("specularColor" | "specularAlbedo") => api::Channel::SpecularAlbedo,
        Some("id") => api::Channel::Id,
        Some("motion") => api::Channel::Motion,
        Some("centerNormal") => api::Channel::CenterNormal,
        Some("centerDepth") => api::Channel::CenterDepth,
        Some("centerPosition") => api::Channel::CenterPosition,
        _ => bail!("Unknown display channel"),
    };
    let color = v["shadowCatcherColor"]
        .as_array()
        .context("Expected catcher color")?;
    ensure!(color.len() == 3, "Expected RGB");
    for (dst, src) in s.shadow_catcher_color.iter_mut().zip(color) {
        *dst = src.as_f64().context("Invalid color")? as f32;
    }
    let range = v["aovDepthRange"]
        .as_array()
        .context("Expected depth range")?;
    ensure!(range.len() == 2, "Expected depth range");
    s.aov.depth_range = [
        range[0].as_f64().context("Invalid depth")? as f32,
        range[1].as_f64().context("Invalid depth")? as f32,
    ];
    s.aov.position_scale = n(v, "aovPositionScale")? as f32;
    s.aov.motion_scale = n(v, "aovMotionScale")? as f32;
    s.aov.id_component = match v["aovIdComponent"].as_str() {
        Some("object") => api::AovIdComponent::Object,
        Some("instance") => api::AovIdComponent::Instance,
        Some("material") => api::AovIdComponent::Material,
        Some("primitive") => api::AovIdComponent::Primitive,
        _ => bail!("Unknown ID component"),
    };
    Ok(s)
}
pub fn denoiser(target: &api::Render, v: &Value) -> Result<()> {
    if v.is_null() {
        target.set_jnlm_display_filter(None)?;
        target.set_denoiser(None)?;
        return Ok(());
    }
    match v["type"].as_str() {
        Some("oidn") => {
            target.set_jnlm_display_filter(None)?;
            let model = match v["model"].as_str().unwrap_or("standard") {
                "small" => "rt_hdr_alb_nrm_small.tza",
                "standard" => "rt_hdr_alb_nrm.tza",
                "cleanAuxLarge" => "rt_hdr_calb_cnrm_large.tza",
                _ => bail!("Unknown OIDN model"),
            };
            let library = weight_path(model);
            target.set_viewer_denoiser(Some(api::DenoiserOptions {
                backend: api::DENOISE_OIDN_WEBGPU,
                library: Some(library),
                schedule: match v["schedule"].as_str() {
                    Some("every-sample") => api::DenoiseSchedule::EverySample,
                    Some("progressive") => api::DenoiseSchedule::Progressive,
                    _ => api::DenoiseSchedule::Converged,
                },
                max_tile_size: v["maxTileSize"].as_u64().unwrap_or(0) as u32,
            }))?;
        }
        Some("jnlm") => {
            target.set_denoiser(None)?;
            let mut o = api::JnlmOptions::default();
            o.strength = n(v, "strength")? as f32;
            o.search_radius = u(v, "searchRadius")?;
            o.patch_radius = u(v, "patchRadius")?;
            o.albedo_bandwidth = n(v, "albedoBandwidth")? as f32;
            o.normal_bandwidth = n(v, "normalBandwidth")? as f32;
            o.iterations = u(v, "iterations")?;
            let active =
                v["schedule"] != "converged" || target.samples() >= target.settings()?.max_samples;
            target.set_jnlm_display_filter(active.then_some(o))?;
        }
        _ => bail!("Unsupported native denoiser"),
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn packet(words: &[u32]) -> Vec<u8> {
        words.iter().flat_map(|v| v.to_le_bytes()).collect()
    }
    #[test]
    fn patches_are_transactional_and_validate_ranges() {
        let full = packet(&[1, 1, 3, 1, 0, 3, 1, 2, 3]);
        let base = delta(None, &full).unwrap();
        assert_eq!(
            delta(Some(&base), &packet(&[1, 0, 3, 1, 1, 1, 9])).unwrap(),
            packet(&[1, 9, 3])
        );
        for words in [
            &[1, 0, 3, 1, 2, 2, 1, 2][..],
            &[1, 0, 3, 1, 0, 1][..],
            &[1, 1, 3, 0][..],
            &[1, 0, 3, 2, 1, 1, 5, 0, 1, 6][..],
        ] {
            assert!(delta(Some(&base), &packet(words)).is_err());
        }
        assert_eq!(base, packet(&[1, 2, 3]));
    }
}

/// Packaged app resources take precedence; source paths serve direct Cargo runs.
pub fn weight_path(name: &str) -> std::path::PathBuf {
    if let Some(root) = std::env::var_os("MUTRACER_OIDN_WEIGHTS") {
        return std::path::PathBuf::from(root).join(name);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let root = if cfg!(target_os = "macos") {
                dir.join("../Resources")
            } else {
                dir.to_path_buf()
            };
            let path = root.join(name);
            if path.is_file() {
                return path;
            }
        }
    }
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../oidn/weights")
        .join(name)
}
