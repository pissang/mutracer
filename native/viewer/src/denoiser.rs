//! Viewer denoiser selection and its application to preview/final targets.
use mutracer_native::api;
use std::sync::Arc;

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Choice {
    #[default]
    Oidn,
    Dlss,
    Jnlm,
}
impl Choice {
    pub fn label(self) -> &'static str {
        match self {
            Self::Oidn => "OIDN",
            Self::Jnlm => "JNLM",
            Self::Dlss => "DLSS RR",
        }
    }
    pub fn temporal(self, available: bool, pinhole: bool) -> bool {
        self == Self::Dlss && available && pinhole
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum OidnModel {
    #[default]
    Standard,
    Small,
    Large,
}
impl OidnModel {
    pub fn label(self) -> &'static str {
        match self {
            Self::Standard => "Standard",
            Self::Small => "Small",
            Self::Large => "Large",
        }
    }
}
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct OidnSettings {
    pub model: OidnModel,
    pub max_tile_size: u32,
}
impl OidnSettings {
    pub fn options(self, schedule: api::DenoiseSchedule) -> api::DenoiserOptions {
        let name = match self.model {
            OidnModel::Standard => None,
            OidnModel::Small => Some("rt_hdr_alb_nrm_small.tza"),
            OidnModel::Large => Some("rt_hdr_calb_cnrm_large.tza"),
        };
        api::DenoiserOptions {
            backend: api::DENOISE_OIDN_WEBGPU,
            library: name.map(|name| {
                crate::bundled_asset(
                    name,
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../oidn/weights")
                        .join(name),
                )
            }),
            max_tile_size: self.max_tile_size,
            schedule,
        }
    }
}
pub fn configure(
    render_loop: &mut api::RenderLoop,
    enabled: bool,
    temporal: bool,
    filter: Option<&Arc<dyn api::CustomDenoiser>>,
) -> anyhow::Result<()> {
    configure_with_options(
        render_loop,
        enabled,
        temporal,
        filter,
        OidnSettings::default(),
    )
}
pub fn configure_with_options(
    render_loop: &mut api::RenderLoop,
    enabled: bool,
    temporal: bool,
    filter: Option<&Arc<dyn api::CustomDenoiser>>,
    oidn: OidnSettings,
) -> anyhow::Result<()> {
    configure_full(render_loop, enabled, temporal, filter, oidn, true, None)
}
pub fn configure_display_filter(
    render_loop: &api::RenderLoop,
    options: Option<api::JnlmOptions>,
    live: bool,
) -> anyhow::Result<()> {
    for render in [Some(render_loop.final_render()), render_loop.preview()]
        .into_iter()
        .flatten()
    {
        render.set_jnlm_display_filter(options.filter(|_| {
            live || (Arc::ptr_eq(render, render_loop.final_render())
                && render.status() == api::RenderStatus::Finished)
        }))?;
    }
    Ok(())
}
pub fn configure_full(
    render_loop: &mut api::RenderLoop,
    enabled: bool,
    temporal: bool,
    filter: Option<&Arc<dyn api::CustomDenoiser>>,
    oidn: OidnSettings,
    live: bool,
    jnlm: Option<api::JnlmOptions>,
) -> anyhow::Result<()> {
    render_loop.coalesce_scene_updates = enabled && live;
    configure_display_filter(render_loop, jnlm, live)?;
    for render in [Some(render_loop.final_render()), render_loop.preview()]
        .into_iter()
        .flatten()
    {
        if jnlm.is_some() {
            render.set_denoiser(None)?;
        }
    }
    if jnlm.is_some() {
        return Ok(());
    }
    if temporal {
        let filter = filter.ok_or_else(|| anyhow::anyhow!("DLSS RR is unavailable"))?;
        for render in [Some(render_loop.final_render()), render_loop.preview()]
            .into_iter()
            .flatten()
        {
            render.set_custom_denoiser(
                enabled.then(|| filter.clone()),
                api::DenoiseSchedule::EverySample,
            )?;
        }
    } else {
        if let Some(preview) = render_loop.preview() {
            preview.set_viewer_denoiser(if enabled && live {
                Some(preview_oidn_options()?)
            } else {
                None
            })?;
        }
        render_loop
            .final_render()
            .set_viewer_denoiser(enabled.then(|| {
                oidn.options(if live {
                    api::DenoiseSchedule::Progressive
                } else {
                    api::DenoiseSchedule::Converged
                })
            }))?;
    }
    Ok(())
}

/// Browser viewer policy: one fresh sample per moving preview, with its smaller
/// OIDN network. Final convergence keeps the standard network.
pub fn preview_settings() -> api::RenderSettings {
    api::RenderSettings {
        max_samples: 1,
        ..api::RenderLoop::preview_settings()
    }
}
pub fn preview_oidn_options() -> anyhow::Result<api::DenoiserOptions> {
    let name = "rt_hdr_alb_nrm_small.tza";
    let path = crate::bundled_asset(
        name,
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../oidn/weights")
            .join(name),
    );
    anyhow::ensure!(
        path.is_file(),
        "Missing OIDN preview model; extract the complete application archive"
    );
    Ok(api::DenoiserOptions {
        backend: api::DENOISE_OIDN_WEBGPU,
        library: Some(path),
        max_tile_size: 0,
        schedule: api::DenoiseSchedule::EverySample,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_requires_available_rr_and_pinhole_without_losing_user_choice() {
        assert_eq!(Choice::default(), Choice::Oidn);
        assert!(!Choice::Oidn.temporal(true, true));
        let choice = Choice::Dlss;
        assert!(!choice.temporal(false, true));
        assert!(!choice.temporal(true, false));
        assert!(choice.temporal(true, true));
        assert_eq!(choice, Choice::Dlss);
    }
    #[test]
    fn moving_preview_uses_one_sample_and_the_small_every_sample_model() {
        let settings = preview_settings();
        assert_eq!(settings.max_samples, 1);
        assert_eq!(settings.size, api::RenderSize::Scale(0.5));
        assert_eq!(settings.bounces, 2);
        let filter = preview_oidn_options().unwrap();
        assert_eq!(filter.schedule, api::DenoiseSchedule::EverySample);
        assert_eq!(filter.backend, api::DENOISE_OIDN_WEBGPU);
        assert_eq!(
            filter.library.unwrap().file_name().unwrap(),
            "rt_hdr_alb_nrm_small.tza"
        );
    }
}
