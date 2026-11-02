//! L1 object model matching the browser library: [`Engine`] owns the device and
//! the committed scene/camera, each [`Render`] is an independently configured
//! accumulation and [`Display`] composes, presents and exports images.
//! [`RenderLoop`] implements the browser preview/final policy on top of them;
//! the host calls [`RenderLoop::tick`] each frame while [`RenderLoop::needs_tick`].
//!
//! An engine and its renders/display may be used from any thread, one thread at
//! a time. Full scene preparation and CPU denoising run on library threads.
//! Event/progress callbacks run synchronously on the calling
//! thread inside `update`, `read_depth_samples`, `refine`, `converge` and loop
//! `tick`, and may call back into the API.
//!
//! The L0 context/job API stays available. An engine prepares and holds its scene
//! once, whatever the number of renders; a render holds only its camera, settings
//! uniforms and accumulation, so changing its size or settings, a converge
//! camera or sequence offset never prepares the scene again.
pub(crate) mod abi;
mod custom_denoise;
pub(crate) mod custom_gpu;
#[cfg(test)]
mod custom_gpu_failure_tests;
mod custom_gpu_submission;
#[cfg(test)]
mod custom_gpu_tests;
pub use custom_denoise::{
    CustomDenoiser, DenoiseAov, DenoiseBuffers, DenoiseGpu, DenoiseInput, DenoiseOutput, GpuAov,
};
pub use custom_gpu::{
    DenoiseAcceptance, DenoiseFrameId, DenoiseFrameStatus, DenoiseInputMode, GpuDenoiseInput,
    GpuDenoiseOutput,
};
mod depth;
mod display;
mod engine;
mod post_process;
mod render;
mod render_loop;
mod surface;

pub use crate::device_loss::DeviceLossNotifier;
pub use crate::display::jnlm::Options as JnlmOptions;
pub use crate::status::{Status, StatusError as Error};
pub use depth::{DEPTH_SAMPLE_COUNT, DEPTH_SAMPLE_GRID, DepthSampleArea};
pub use display::{
    AovDisplayOptions, AovIdComponent, Channel, Display, DisplaySettings, Presented, ToneMapping,
};
pub use engine::{
    Backend, Camera, Diagnostics, Engine, EngineEvent, EngineInfo, EngineOptions, ProgressStage,
    RenderDiagnostics, Subscription,
};
pub use post_process::{OutputKind, PostProcessContext, PostProcessSubscription};
pub use render::{
    AdaptiveResolution, AlphaBlendStrategy, CancelToken, CausticSettings, CommitKind,
    ConvergeOptions, ConvergeProgress, ConvergeResult, ConvergeStage, DENOISE_OIDN_WEBGPU,
    DenoiseReport, DenoiseSchedule, DenoiserOptions, Image, OIDN_WEBGPU_AVAILABLE, PixelKind,
    RefineOptions, Render, RenderSettings, RenderSize, RenderStatus, SampleEvent, SamplingPattern,
};
pub use render_loop::{
    LoopRender, LoopSubscription, LoopSync, RenderLoop, RenderLoopOptions, RenderLoopStatus,
    SelectInfo, Selection, SharedSync, SyncActivity, select_default,
};
pub use surface::{SurfaceInfo, SurfaceOptions, SurfaceStatus};

/// Result of a native API call; an error carries a [`Status`] and a message.
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn error(status: Status, message: impl Into<String>) -> Error {
    Error {
        status,
        message: message.into(),
    }
}

fn context_result<T>(result: crate::Result<T>) -> Result<T> {
    result.map_err(|e| {
        error(
            crate::status::classify(e.as_ref(), Status::Error),
            e.to_string(),
        )
    })
}
/// Blocking callers retry the same registry Busy result as the C boundary.
fn context_blocking<T>(operation: impl FnMut() -> crate::Result<T>) -> Result<T> {
    context_result(crate::context::blocking(operation))
}

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod alpha_tests;
#[cfg(test)]
mod depth_tests;
#[cfg(test)]
mod device_loss_tests;
#[cfg(test)]
mod display_effects_tests;
#[cfg(test)]
mod gpu_output_tests;
#[cfg(test)]
mod hdr_tests;
#[cfg(test)]
mod loop_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod backlog_tests;

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod aov_tests;

mod temporal;
pub use temporal::{
    TemporalCamera, TemporalCapabilities, TemporalFrame, TemporalGlassCapabilities,
    TemporalGlassCapability, TemporalGlassKind, TemporalGlassMotion, TemporalGuide,
    TemporalMetadata, TemporalPixelRecord, TemporalProjection, TemporalResetReason,
    TemporalSupport, temporal_validity,
};

#[cfg(test)]
mod aov_display_tests;

#[cfg(test)]
mod caustics_tests;
