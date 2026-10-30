//! Independent accumulations. The engine prepares its scene once in a shared L0
//! context; each render's L0 context is a target linked to it (S2).
use super::engine::{
    Camera, Engine, EngineEvent, ProgressStage, QUALITY_BEVEL, QUALITY_DISPERSION, State,
    Subscription,
};
use super::{Result, Status, context_blocking, context_result, error};
use crate::context::{self, CommitOutcome, CommitPath};
use crate::display::Display as Capture;
use crate::settings::RenderSettings as L0Settings;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

/// L0 limit on accumulated samples per context.
const MAX_TOTAL_SAMPLES: u32 = 16384;
/// L0 limit on samples dispatched by one job poll.
const MAX_BATCH: u32 = 64;

/// Sampling sequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SamplingPattern {
    #[default]
    Sobol,
    ZSobol,
    Random,
}
/// Primary-ray coverage policy for blend materials; both native backends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u32)]
pub enum AlphaBlendStrategy {
    /// Randomly accept coverage per sample. Default; secondary hits also use it.
    #[default]
    Stochastic = 0,
    /// Blend the primary front/back branches every sample. Secondary coverage
    /// stays stochastic; this can cost extra GPU work.
    DeterministicSourceOver = 1,
}
/// Fixed dimensions or a display-relative scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RenderSize {
    /// Display-relative scale; the size follows [`super::Display::set_size`] at the next refine.
    Scale(f64),
    /// Edges 1–8192, at most 16,777,216 pixels, also subject to GPU limits.
    Fixed { width: u32, height: u32 },
}
impl Default for RenderSize {
    fn default() -> Self {
        Self::Scale(1.)
    }
}
/// Optional caustic estimators. Every estimator is disabled by default.
/// Photon estimators use PT for scenes containing smooth BLEND casters.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct CausticSettings {
    /// Directly visible light paths; default false.
    pub light_tracing: bool,
    /// Photons per batch; 0 selects pixel count / 4. Default 0.
    pub light_photons: u32,
    /// Progressive caustic density estimate; default false.
    /// Without light tracing, directly visible receivers can have fewer
    /// denoising blotches and more raw noise. Receivers seen through reflection
    /// or refraction are unchanged.
    pub photon_mapping: bool,
    /// Photons per batch; 0 selects pixel count / 4, at most 262144. Default 0.
    /// Uses 28 bytes each plus up to 13 MiB of overhead; capped by device limits
    /// and 128 MiB.
    pub photon_map_photons: u32,
    /// First-batch gather radius in scene units, independent of `photon_map_photons`;
    /// shrinks as batches accumulate. 0 selects 3% of the caster sphere radius. Default 0.
    pub photon_map_radius: f32,
}
impl CausticSettings {
    pub(super) fn flags(self) -> u32 {
        (if self.light_tracing { 2 } else { 0 }) | (if self.photon_mapping { 4 } else { 0 })
    }
}
/// Per-render execution and image-quality settings. Defaults match the browser library.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderSettings {
    /// Caustic estimators. Default: all disabled.
    pub caustics: CausticSettings,
    /// Optional AOV bit mask; bit 0 depth, 1 position, 2 roughness, 3 diffuse
    /// reflectance, 4 specular reflectance, 5 ID, 6 motion. Default 0.
    pub aovs: u32,
    /// Independent AOV sample cap, positive integer. Default 16.
    pub aov_samples: u32,
    /// Maximum complete samples, 1–16384. Default 2048. Raising it continues the
    /// accumulation; with [`SamplingPattern::ZSobol`] a change restarts it.
    pub max_samples: u32,
    /// Maximum scattering depth, clamped to 1–20. Default 3.
    /// Complete caustic light-to-camera paths can be longer than this depth.
    pub bounces: u32,
    /// Per-sample radiance clamp; 0 disables it. Default 0.
    pub clamping: f64,
    /// Default [`SamplingPattern::Sobol`].
    pub sampling_pattern: SamplingPattern,
    /// Primary-ray blend policy. Default [`AlphaBlendStrategy::Stochastic`].
    pub alpha_blend_strategy: AlphaBlendStrategy,
    /// Light candidates per vertex, clamped to 1–16. Default 4.
    pub direct_light_candidates: u32,
    /// Rounded material edges. Default true.
    pub bevel: bool,
    /// Bevel probes, clamped to 1–32. Default 8.
    pub bevel_samples: u32,
    /// Dispersion wavelengths per sample, 1 or 3. Default 3.
    pub dispersion_wavelengths: u32,
    /// Minimum transmissive path alpha. Default 1.
    pub transmissive_output_alpha_min: f64,
    /// Interactive frame budget in milliseconds for [`Render::refine`]. Default 21.
    pub time_budget_ms: f64,
    /// Batch samples within `time_budget_ms` when GPU timestamps are available.
    /// Default false. RenderLoop limits stationary batches to 4 ms.
    pub batch_samples: bool,
    /// Compatibility alias for `batch_samples`; either flag enables batching.
    /// Let one refine submit several samples when the measured sample time fits the
    /// budget. Default false (one sample per refine).
    pub allow_multiple_samples_per_frame: bool,
    /// Size of the image. Default `Scale(1.0)`.
    pub size: RenderSize,
    /// Random sequence seed. Default 12345.
    pub seed: u32,
    /// Adapts the scale of a [`RenderSize::Scale`] render to frame timing, between
    /// `min_scale` and that scale. Default `None`.
    pub adaptive_resolution: Option<AdaptiveResolution>,
}
/// Overrides for one [`Render::refine_with_options`] call. Defaults use the render settings.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RefineOptions {
    /// Batch samples for this call, overriding both render flags. Default `None`.
    pub batch_samples: Option<bool>,
    /// Positive finite GPU queue budget, capped by `time_budget_ms`. Default `None`.
    pub target_batch_time_ms: Option<f64>,
    /// Collect and trace without capturing a display image. The next normal
    /// refine or image read resolves it. Default false.
    pub defer_resolve: bool,
}
impl RefineOptions {
    fn validate(self) -> Result<()> {
        if self
            .target_batch_time_ms
            .is_some_and(|ms| !ms.is_finite() || ms <= 0.)
        {
            return Err(error(
                Status::InvalidArgument,
                "target_batch_time_ms must be positive and finite",
            ));
        }
        Ok(())
    }
}
/// Browser `adaptiveResolution`: after each observed batch the scale moves
/// toward `target_frame_ms`; it grows only after four fast batches, by at most 25%.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AdaptiveResolution {
    /// Positive frame time to aim for, in milliseconds.
    pub target_frame_ms: f64,
    /// Positive lower bound, at most the render's scale.
    pub min_scale: f64,
}
impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            caustics: CausticSettings::default(),
            aovs: 0,
            aov_samples: 16,
            max_samples: 2048,
            bounces: 3,
            clamping: 0.,
            sampling_pattern: SamplingPattern::Sobol,
            alpha_blend_strategy: AlphaBlendStrategy::Stochastic,
            direct_light_candidates: 4,
            bevel: true,
            bevel_samples: 8,
            dispersion_wavelengths: 3,
            transmissive_output_alpha_min: 1.,
            time_budget_ms: 21.,
            batch_samples: false,
            allow_multiple_samples_per_frame: false,
            size: RenderSize::Scale(1.),
            seed: 12345,
            adaptive_resolution: None,
        }
    }
}
impl RenderSettings {
    /// Checks ranges and combinations; [`Render::new`] and [`Render::set_settings`]
    /// call it and return its `InvalidArgument` error.
    pub fn validate(&self) -> Result<()> {
        let invalid = |message: &str| Err(error(Status::InvalidArgument, message));
        if !self.caustics.photon_map_radius.is_finite() || self.caustics.photon_map_radius < 0. {
            return invalid("photon_map_radius must be finite and nonnegative");
        }
        if self.aovs & !127 != 0 || self.aov_samples == 0 {
            return invalid("Invalid AOV mask or sample cap");
        }
        if !(1..=MAX_TOTAL_SAMPLES).contains(&self.max_samples) {
            return invalid("max_samples must be 1..16384");
        }
        if self.dispersion_wavelengths != 1 && self.dispersion_wavelengths != 3 {
            return invalid("dispersion_wavelengths must be 1 or 3");
        }
        if !self.clamping.is_finite() || self.clamping < 0. {
            return invalid("clamping must be finite and non-negative");
        }
        if !self.transmissive_output_alpha_min.is_finite() {
            return invalid("transmissive_output_alpha_min must be finite");
        }
        if !self.time_budget_ms.is_finite() || self.time_budget_ms <= 0. {
            return invalid("time_budget_ms must be positive");
        }
        match self.size {
            RenderSize::Scale(scale) if !scale.is_finite() || scale <= 0. => {
                invalid("Resolution scale must be positive")
            }
            RenderSize::Fixed { width, height } if width == 0 || height == 0 => {
                invalid("Fixed width and height must be positive")
            }
            _ => Ok(()),
        }?;
        match (self.adaptive_resolution, self.size) {
            (None, _) => Ok(()),
            (Some(a), RenderSize::Scale(scale))
                if a.target_frame_ms.is_finite()
                    && a.target_frame_ms > 0.
                    && a.min_scale.is_finite()
                    && a.min_scale > 0.
                    && a.min_scale <= scale =>
            {
                Ok(())
            }
            _ => invalid(
                "adaptive_resolution requires a scale-based render with positive target_frame_ms and min_scale <= its scale",
            ),
        }
    }
    /// The L0 sample cap. Only ZSobol depends on it (its Morton sample bits);
    /// Sobol and Random use a fixed cap, so raising `max_samples` continues the
    /// accumulation instead of preparing again, as in the browser library.
    pub(super) fn sample_cap(&self, samples: u32) -> u32 {
        if self.sampling_pattern == SamplingPattern::ZSobol {
            samples
        } else {
            MAX_TOTAL_SAMPLES
        }
    }
    /// The L0 settings record; `cap` and `offset` differ only for converge.
    pub(super) fn l0(&self, cap: u32, offset: u32) -> L0Settings {
        L0Settings {
            caustic_flags: self.caustics.flags(),
            light_photons: self.caustics.light_photons,
            photon_map_photons: self.caustics.photon_map_photons,
            photon_map_radius: self.caustics.photon_map_radius,
            sampling_pattern: match self.sampling_pattern {
                SamplingPattern::Sobol => 0,
                SamplingPattern::ZSobol => 1,
                SamplingPattern::Random => 2,
            },
            seed: self.seed,
            max_samples: cap,
            bounces: self.bounces,
            direct_light_candidates: self.direct_light_candidates,
            bevel_samples: self.bevel_samples,
            sample_sequence_offset: offset,
            clamping: self.clamping,
            transmissive_output_alpha_min: self.transmissive_output_alpha_min,
            ..L0Settings::default()
        }
    }
    pub(super) fn quality(&self) -> u32 {
        (if self.bevel { QUALITY_BEVEL } else { 0 })
            | (if self.dispersion_wavelengths == 3 {
                QUALITY_DISPERSION
            } else {
                0
            })
    }
    pub(super) fn resolve_size(&self, display: [u32; 2]) -> [u32; 2] {
        match self.size {
            RenderSize::Fixed { width, height } => [width, height],
            RenderSize::Scale(scale) => display.map(|v| ((v as f64 * scale).round() as u32).max(1)),
        }
    }
}

/// Execution state of one render; native Idle means no committed scene.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderStatus {
    /// Scene preparation is running.
    Preparing,
    /// No committed scene; no work is scheduled.
    Idle,
    /// A shared path-tracing pipeline is being compiled on a cache miss.
    Compiling,
    Converging,
    Denoising,
    Finished,
    Error,
}
/// One complete batch of samples.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SampleEvent {
    /// Complete samples since the last restart.
    pub samples: u32,
    /// Whether this batch is the first after a restart.
    pub is_first_frame: bool,
    /// Wall time from submission to observed completion of the batch.
    pub frame_time_ms: f64,
}
/// Image read by [`Render::read_pixels`]. All optional AOVs require their bit in
/// `RenderSettings::aovs`; otherwise reads return InvalidState. Geometry and
/// reflectance average independent jittered/lens samples, capped by aov_samples.
/// RGB is normalized by valid surface hits, alpha is coverage over AOV samples.
/// Alpha traversal selects the first non-catcher surface with alpha >= 0.5,
/// skipping at most 32 layers. ID/motion use the unjittered pinhole pixel center.
/// Reflectance excludes coat, fuzz, anisotropy, subsurface/volume scattering,
/// bevel, thin film, dispersion, partial alpha and nonstandard materials.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelKind {
    /// Resolved linear ray color and path coverage, matching TS WebGPU HDR readback.
    /// RGB uses surface-hit normalization, with per-sample color restored for an
    /// opaque visible flat background. Display settings and denoising do not affect it.
    Hdr,
    /// Denoised HDR when a denoised image is available, otherwise HDR.
    Denoised,
    Albedo,
    Normal,
    /// Camera-forward scene-unit distance, 0, 0, coverage in RGBA32F. Misses are zero.
    Depth,
    /// World position and coverage in RGBA32F.
    Position,
    /// Specular roughness, metalness, unsupported-layer flag and coverage.
    Roughness,
    /// Directional diffuse reflectance; alpha is valid coverage.
    DiffuseAlbedo,
    /// Directional specular reflectance; alpha is valid coverage.
    SpecularAlbedo,
    /// Exact object, local instance (0 for an ordinary mesh), material and source triangle IDs in
    /// `Image::id_data`. Background is u32::MAX in all channels. Exact shared-edge
    /// hits may select either adjacent triangle depending on host/GPU rounding.
    Id,
    /// Previous minus current pixel position, x right, y down, z=0; alpha 3 for
    /// visible camera/rigid correspondence, otherwise 0. History is per-render,
    /// from its previous AOV frame. Size/projection changes, missing IDs, topology
    /// or vertex edits and visibility failures invalidate it. Device loss clears it.
    Motion,
}
impl PixelKind {
    pub(crate) fn from_aov_index(index: u32) -> Self {
        match index {
            0 => Self::Depth,
            1 => Self::Position,
            2 => Self::Roughness,
            3 => Self::DiffuseAlbedo,
            4 => Self::SpecularAlbedo,
            5 => Self::Id,
            6 => Self::Motion,
            _ => unreachable!(),
        }
    }
    /// Bit for RenderSettings::aovs; returns zero for beauty and OIDN guides.
    pub fn aov_mask(self) -> u32 {
        match self {
            Self::Depth => 1,
            Self::Position => 2,
            Self::Roughness => 4,
            Self::DiffuseAlbedo => 8,
            Self::SpecularAlbedo => 16,
            Self::Id => 32,
            Self::Motion => 64,
            _ => 0,
        }
    }
}
/// Linear RGBA f32 pixels or exact integer IDs, top row first.
#[derive(Clone, Debug, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    /// RGBA floats; empty for Id.
    pub data: Vec<f32>,
    /// Exact RGBA32UI ID pixels for `PixelKind::Id`; otherwise None.
    pub id_data: Option<Vec<u32>>,
}
/// When a render filters its complete samples.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DenoiseSchedule {
    /// Once, when the render reaches `max_samples`.
    #[default]
    Converged,
    /// At 1 sample, then at twice the last denoised count (at least 4) up to
    /// `max_samples`; after 10 s without a result, at the next sample. Sampling
    /// pauses while a filter runs; the last denoised image stays presented until
    /// the next one.
    Progressive,
    /// After every complete batch; sampling pauses while a filter runs.
    EverySample,
}
/// How a commit reached the published scene.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitKind {
    /// Scene preparation from the descriptor.
    Full,
    /// Retained updates of the previous scene.
    Incremental,
}
/// The last finished denoising run.
#[derive(Clone, Debug, PartialEq)]
pub struct DenoiseReport {
    /// Complete samples of the filtered image.
    pub samples: u32,
    /// Filter backend: for example "OIDN Metal", "oidn-webgpu" or "custom".
    pub backend: String,
    /// Filter wall time, excluding input readback. oidn-webgpu includes GPU
    /// completion and first-use planning/pipeline creation.
    pub milliseconds: f64,
    /// Load or execution failure; denoising then stops until the denoiser is set again.
    pub error: Option<String>,
}
/// Browser `_nextSampleTarget`: the sample count to trace toward before the next filter.
pub(super) fn sample_target(
    schedule: Option<DenoiseSchedule>,
    samples: u32,
    max_samples: u32,
    denoised: u32,
    since_denoise: Option<Duration>,
) -> u32 {
    match schedule {
        None | Some(DenoiseSchedule::Converged) => max_samples,
        Some(DenoiseSchedule::EverySample) => max_samples.min(samples + 1),
        Some(DenoiseSchedule::Progressive) if denoised == 0 => 1,
        Some(DenoiseSchedule::Progressive)
            if since_denoise.is_some_and(|d| d >= Duration::from_secs(10)) =>
        {
            max_samples.min(samples + 1)
        }
        Some(DenoiseSchedule::Progressive) => max_samples.min(denoised.saturating_mul(2).max(4)),
    }
}
/// oidn-webgpu on the rendering device, without CPU image transfers.
/// Requires a supported native target; see [`OIDN_WEBGPU_AVAILABLE`].
pub const DENOISE_OIDN_WEBGPU: u32 = 5;
/// Whether the oidn-webgpu native runtime is included. Always true.
pub const OIDN_WEBGPU_AVAILABLE: bool = true;

/// Built-in denoising backend and schedule.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct DenoiserOptions {
    /// 0 GPU (Metal/CUDA/HIP) then CPU, 1 CPU, 2 Metal, 3 CUDA, 4 HIP,
    /// 5 oidn-webgpu on the rendering device. Default 0.
    pub backend: u32,
    /// OIDN library path; default the bundled library or `MUTRACER_OIDN_LIBRARY`.
    /// Backend 5 uses an HDR/PU color/albedo/normal TZA path; default `rt_hdr_alb_nrm`.
    /// Selecting `rt_hdr_calb_cnrm_large.tza` requires sibling `rt_alb_large.tza`
    /// and `rt_nrm_large.tza` guide prefilters.
    pub library: Option<PathBuf>,
    /// Default [`DenoiseSchedule::Converged`].
    pub schedule: DenoiseSchedule,
    /// oidn-webgpu maximum output tile edge. Default 0 (whole image).
    /// 0 or 16..=16384; positive values round down to multiples of 16. Ignored by OIDN.
    /// Smaller tiles reduce temporary GPU memory at extra work cost.
    pub max_tile_size: u32,
}
/// Cross-thread cancellation for [`Render::converge`] and [`Render::refine_until`].
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);
impl CancelToken {
    /// A token that is not cancelled.
    pub fn new() -> Self {
        Self::default()
    }
    /// Requests cancellation from any thread. Converge returns [`Status::Cancelled`];
    /// refine_until returns its current render status.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    /// Whether [`CancelToken::cancel`] was called.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
/// Stage reported by [`ConvergeProgress`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConvergeStage {
    /// Rendering the requested samples.
    Final,
    /// Waiting for the denoiser after the last sample.
    Denoising,
}
/// Progress passed to [`ConvergeOptions::on_progress`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConvergeProgress {
    pub stage: ConvergeStage,
    /// Complete samples so far.
    pub samples: u32,
    /// The requested [`ConvergeOptions::samples`].
    pub target_samples: u32,
}
/// Deterministic offline rendering options.
pub struct ConvergeOptions {
    /// Final complete samples, 1–16384. Required.
    pub samples: u32,
    /// Camera for this output only. Default the committed engine camera.
    pub camera: Option<Camera>,
    /// Deterministic sequence base. Default 0.
    pub sample_sequence_offset: u32,
    /// Maximum samples per submitted batch, clamped to 1–64. Default 8.
    pub samples_per_batch: u32,
    /// Positive finite GPU batch budget in milliseconds. Default None (fixed batches).
    pub target_batch_time_ms: Option<f64>,
    /// Nonnegative finite delay between intermediate image captures. Default None (capture at the end).
    pub preview_interval_ms: Option<f64>,
    /// Timeout for preparation and rendering. Default 600000.
    pub timeout_ms: u64,
    /// Called after every complete batch and before denoising. Default none.
    pub on_progress: Option<Box<dyn FnMut(ConvergeProgress) + Send>>,
    /// Default none.
    pub cancel: Option<CancelToken>,
}
impl ConvergeOptions {
    /// Options for `samples` final samples, with the defaults listed on each field.
    pub fn new(samples: u32) -> Self {
        Self {
            samples,
            camera: None,
            sample_sequence_offset: 0,
            samples_per_batch: 8,
            target_batch_time_ms: None,
            preview_interval_ms: None,
            timeout_ms: 600_000,
            on_progress: None,
            cancel: None,
        }
    }
}
/// Result of [`Render::converge`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConvergeResult {
    /// Complete samples rendered.
    pub samples: u32,
}

/// What a render's L0 context must hold to be current.
#[derive(Clone, PartialEq)]
pub(super) struct TargetKey {
    scene: u64,
    camera: u64,
    size: [u32; 2],
    quality: u32,
    settings: L0Settings,
    alpha_blend_strategy: AlphaBlendStrategy,
    camera_override: Option<[u8; 128]>,
}
/// Full preparation of the shared scene on a library thread.
struct Pending {
    revision: u64,
    result: mpsc::Receiver<Result<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
// The engine's scene-only context holds no frame/accumulation resources.
// Each render's context owns a Target linked to this scene.
#[derive(Default)]
pub(super) struct SharedScene {
    context: Option<u64>,
    /// Scene revision of the published scene.
    published: Option<u64>,
    /// Full preparations published so far.
    generation: u64,
    pending: Option<Pending>,
    failed: Option<(u64, String)>,
}
impl SharedScene {
    pub(super) fn is_pending(&self) -> bool {
        self.pending.is_some()
    }
    /// Destroys the scene context once its preparation has drained; renders first.
    pub(super) fn release(&mut self) {
        let Some(context) = self.context.take() else {
            return;
        };
        if self.pending.is_some() {
            let _ = context_blocking(|| context::cancel_commit(context));
        }
        let _ = context_blocking(|| context::destroy(context));
        if let Some(mut pending) = self.pending.take() {
            if let Some(thread) = pending.thread.take() {
                let _ = thread.join();
            }
        }
    }
    pub(super) fn context(&self) -> Option<u64> {
        self.context
    }
}
/// Scene commits use fixed settings; render settings only shape targets.
fn scene_settings() -> L0Settings {
    RenderSettings::default().l0(MAX_TOTAL_SAMPLES, 0)
}
struct Flight {
    job: u64,
    count: u32,
    started: Instant,
    /// Cancellation requested; publication may have expired the L0 job.
    cancelled: bool,
    /// Resolution scale the batch was traced at.
    scale: f64,
}
/// Browser adaptive-resolution state of one render.
struct Adaptive {
    /// Current scale; the image uses min(scale, the configured scale).
    scale: f64,
    /// The configured scale it was reset to.
    configured: f64,
    fast_frames: u32,
    /// Time and scale of the last observed batch, not yet evaluated.
    frame: Option<(f64, f64)>,
}
impl Adaptive {
    fn new(settings: &RenderSettings) -> Self {
        let configured = match settings.size {
            RenderSize::Scale(scale) => scale,
            RenderSize::Fixed { .. } => 1.,
        };
        Self {
            scale: configured,
            configured,
            fast_frames: 0,
            frame: None,
        }
    }
}
/// Browser `nextPreviewScale`: the scale whose frame time would meet the target,
/// rounded to 1/16 (1/128 below 0.25), kept unless it differs by at least 15%.
pub(super) fn next_preview_scale(
    measured_scale: f64,
    frame_ms: f64,
    target_ms: f64,
    max_scale: f64,
    current_scale: f64,
    min_scale: f64,
) -> f64 {
    let raw = measured_scale * (target_ms / frame_ms.max(0.1)).sqrt();
    let steps = if raw < 0.25 { 128. } else { 16. };
    let next = ((raw * steps).round() / steps)
        .max(min_scale)
        .min(min_scale.max(max_scale));
    if (next / current_scale).ln().abs() >= 1.15f64.ln() {
        next
    } else {
        current_scale
    }
}
/// Pixels or an error, the OIDN device and the filter time in milliseconds.
enum DenoisedImage {
    Cpu(Vec<f32>, Option<super::DenoiseFrameStatus>),
    /// oidn-webgpu: retained HDR pixels and the display preview.
    Gpu {
        pixels: wgpu::Buffer,
        preview: wgpu::Buffer,
    },
    DisplayGpu {
        pixels: wgpu::Buffer,
        settings: crate::display::Settings,
    },
    /// A sealed custom GPU filter result.
    Resident(super::GpuDenoiseOutput),
}
type DenoiseResult = (std::result::Result<DenoisedImage, String>, String, f64);
impl Drop for DenoisedImage {
    fn drop(&mut self) {
        if let Self::Cpu(_, Some(status)) = self {
            status.reject();
        }
    }
}
#[derive(Default)]
struct Denoise {
    display: bool,
    options: Option<DenoiserOptions>,
    custom: super::custom_denoise::Filter,
    custom_aovs: u32,
    custom_mode: super::DenoiseInputMode,
    cancel: CancelToken,
    /// Kept across `set_denoiser` calls with the same library and backend.
    filter: Arc<Mutex<Option<crate::denoise::Denoiser>>>,
    gpu_filter: Option<crate::oidn_webgpu::Denoiser>,
    worker: Option<(u32, mpsc::Receiver<DenoiseResult>)>,
    frame_status: Option<super::DenoiseFrameStatus>,
    last: Option<Instant>,
    report: Option<DenoiseReport>,
    /// Samples of the denoised image and its pixels, bottom row first like L0.
    denoised: Option<(u32, DenoisedImage)>,
    failed: bool,
}

pub(super) struct RenderState {
    pub(super) settings: RenderSettings,
    jnlm: Option<crate::display::jnlm::Options>,
    pub(super) fallback: Option<u64>,
    /// L0 context linked as a target to the engine's shared scene.
    context: u64,
    aov: Option<crate::aov::Output>,
    temporal: Option<super::temporal::State>,
    aov_camera: [u8; 128],
    published: Option<TargetKey>,
    /// `SharedScene::generation` of the published target.
    generation: u64,
    failed: Option<(TargetKey, String)>,
    /// Changes whenever this render publishes a new target/camera/size packet.
    input_generation: u64,
    job: Option<Flight>,
    /// Complete samples in the published accumulation.
    samples: u32,
    first_frame: bool,
    sample_ms: Option<f64>,
    gpu_sample_ms: Option<f64>,
    refine_options: RefineOptions,
    refill_cancel: Option<CancelToken>,
    pub(super) capture: Option<Capture>,
    pub(super) output: super::post_process::OutputState,
    capture_key: Option<TargetKey>,
    captured: u32,
    needs_capture: bool,
    status: RenderStatus,
    error: bool,
    busy: bool,
    denoise: Denoise,
    denoiser_revision: u64,
    adaptive: Adaptive,
}
impl RenderState {
    pub(super) fn aov_samples_for_display(&self) -> u32 {
        self.aov.as_ref().map_or(0, |a| a.samples)
    }
    pub(super) fn published_size(&self) -> [u32; 2] {
        self.published.as_ref().map_or([0; 2], |k| k.size)
    }
    pub(super) fn visualize_aov(
        &mut self,
        kind: PixelKind,
        options: &super::AovDisplayOptions,
        hdr: bool,
    ) -> Result<wgpu::Texture> {
        if self.settings.aovs & kind.aov_mask() == 0 {
            return Err(error(
                Status::InvalidState,
                "AOV is not enabled on the selected render",
            ));
        }
        if self.aov.as_ref().is_none_or(|a| {
            a.generation != self.input_generation || a.samples == 0 || a.mask & kind.aov_mask() == 0
        }) {
            return Err(error(
                Status::InvalidState,
                "AOV for the captured image is not ready",
            ));
        }
        self.aov
            .as_mut()
            .ok_or_else(|| error(Status::InvalidState, "AOV output is not ready"))?
            .visualize(kind.aov_mask().trailing_zeros(), options, hdr)
            .map_err(|e| error(Status::Error, e.to_string()))
    }
    pub(super) fn diagnostics(&self, id: u64, scene: u64, camera: u64) -> super::RenderDiagnostics {
        super::RenderDiagnostics {
            id,
            samples: if self.current(scene, camera) {
                self.samples
            } else {
                0
            },
            captured_samples: self.captured,
            denoised_samples: denoised_samples(self),
            sampling: self.job.is_some(),
            denoising: self.denoise.worker.is_some(),
        }
    }

    pub(super) fn device_lost(&mut self) {
        self.error = true;
        self.status = RenderStatus::Error;
        self.busy = false;
        if let Some(flight) = self.job.as_mut() {
            flight.cancelled = true;
        }
        // Drop the receiver, never join a foreign CPU/GPU filter on the API thread.
        self.denoise.cancel.cancel();
        if let Some(status) = self.denoise.frame_status.take() {
            status.reject();
        }
        self.denoise.worker = None;
        self.denoise.denoised = None;
        self.denoise.gpu_filter = None;
        self.denoise.failed = true;
    }
    /// Image size for a display size: the configured size, scaled down by
    /// adaptive resolution.
    fn image_size(&self, display: [u32; 2]) -> [u32; 2] {
        match (self.settings.adaptive_resolution, self.settings.size) {
            (Some(_), RenderSize::Scale(scale)) => {
                let scale = self.adaptive.scale.min(scale);
                display.map(|v| ((v as f64 * scale).round() as u32).max(1))
            }
            _ => self.settings.resolve_size(display),
        }
    }
    /// Browser `_adaptResolution`, evaluated on the batch observed last.
    fn adapt_resolution(&mut self) {
        let (Some(adaptive), RenderSize::Scale(max_scale)) =
            (self.settings.adaptive_resolution, self.settings.size)
        else {
            return;
        };
        if self.busy || self.samples == 0 {
            return;
        }
        let Some((elapsed, scale)) = self.adaptive.frame.take() else {
            return;
        };
        let next = next_preview_scale(
            scale,
            elapsed,
            adaptive.target_frame_ms,
            max_scale,
            self.adaptive.scale,
            adaptive.min_scale,
        );
        if next > self.adaptive.scale {
            self.adaptive.fast_frames += 1;
            if self.adaptive.fast_frames < 4 {
                return;
            }
            self.adaptive.scale = next.min(self.adaptive.scale * 1.25);
        } else {
            self.adaptive.scale = next;
        }
        self.adaptive.fast_frames = 0;
    }
    /// Destroys the target context once its GPU work has drained.
    pub(super) fn release(mut self) {
        cancel_denoise(&mut self);
        let context = self.context;
        if let Some(flight) = self.job.as_mut() {
            flight.cancelled = true;
            let job = flight.job;
            let _ = context_blocking(|| context::cancel_job(job));
        }
        let _ = drain(&mut self);
        let _ = context_blocking(|| context::destroy(context));
    }
    fn publish(&mut self, key: TargetKey, full: bool) {
        self.input_generation = self
            .input_generation
            .checked_add(1)
            .expect("Custom input generation exhausted");
        self.output.invalidate();
        self.published = Some(key);
        self.failed = None;
        self.error = false;
        self.samples = 0;
        self.first_frame = true;
        self.needs_capture = false;
        self.adaptive.frame = None;
        self.status = RenderStatus::Converging;
        if full {
            self.sample_ms = None;
            self.gpu_sample_ms = None;
        }
        cancel_denoise(self);
    }
    #[cfg(test)]
    pub(super) fn context(&self) -> u64 {
        self.context
    }
    #[cfg(test)]
    pub(super) fn in_flight(&self) -> bool {
        self.job.is_some()
    }
    /// CPU uploads into the display and whether it shows a denoised image.
    #[cfg(test)]
    pub(super) fn display_uploads(&self) -> (u32, bool) {
        self.capture
            .as_ref()
            .map_or((0, false), |c| (c.uploads, c.using_denoised))
    }
    pub(super) fn presented_samples(&self) -> u32 {
        self.captured
    }
    fn current(&self, state_scene: u64, state_camera: u64) -> bool {
        self.published
            .as_ref()
            .is_some_and(|k| k.scene == state_scene && k.camera == state_camera)
    }
}
fn cancel_denoise(render: &mut RenderState) {
    if let Some(temporal) = &mut render.temporal {
        temporal.reject();
    }
    render.output.invalidate();
    render.denoise.cancel.cancel();
    if let Some(status) = render.denoise.frame_status.take() {
        status.reject();
    }
    render.denoise.worker = None;
    render.denoise.denoised = None;
    render.denoise.report = None;
    if let Some(capture) = render.capture.as_mut() {
        capture.original();
    }
}

pub(super) fn invalidate_display_denoisers(state: &mut State) {
    for render in state
        .renders
        .values_mut()
        .filter(|r| r.denoise.display && r.denoise.options.is_some())
    {
        // Keep one inference in flight while color controls move. Its settings
        // stamp rejects obsolete output; dropping it here could queue one job per UI tick.
        render.denoise.denoised = None;
        render.denoise.report = None;
        render.output.invalidate();
        if let Some(capture) = &mut render.capture {
            capture.original();
        }
        render.denoiser_revision += 1;
    }
}

/// Readiness of one render for presentation (browser `_complete` / `_presentable`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(super) struct Readiness {
    pub(super) complete: bool,
    pub(super) presentable: bool,
}
fn aov_samples(render: &RenderState, mask: u32, scene: u64, camera: u64) -> u32 {
    if !render.current(scene, camera) || render.settings.aovs & mask == 0 {
        return 0;
    }
    render
        .aov
        .as_ref()
        .filter(|a| a.generation == render.input_generation && a.mask & mask != 0)
        .map_or(0, |a| a.samples)
}
pub(super) fn display_readiness(state: &State, id: u64) -> Readiness {
    if let Some(kind) = state.display.settings.channel.aov_kind() {
        let complete = !state.device_failed
            && state.renders.get(&id).is_some_and(|r| {
                aov_samples(
                    r,
                    kind.aov_mask(),
                    state.scene_revision,
                    state.camera_revision,
                ) > 0
            });
        Readiness {
            complete,
            presentable: complete,
        }
    } else {
        readiness(state, id)
    }
}
pub(super) fn readiness(state: &State, id: u64) -> Readiness {
    if state.device_failed {
        return Readiness::default();
    }
    let Some(render) = state.renders.get(&id) else {
        return Readiness::default();
    };
    let complete = render.current(state.scene_revision, state.camera_revision)
        && render.capture_key == render.published
        && render.captured > 0;
    let denoise = &render.denoise;
    let presentable = complete
        && (denoise.worker.is_none()
            || denoise.denoised.is_some()
            || (denoise
                .options
                .as_ref()
                .is_some_and(|o| o.schedule == DenoiseSchedule::Converged)
                && render.settings.max_samples > 1));
    Readiness {
        complete,
        presentable,
    }
}

fn desired(state: &State, render: &RenderState) -> Option<TargetKey> {
    state.scene.as_ref()?;
    Some(TargetKey {
        scene: state.scene_revision,
        camera: state.camera_revision,
        size: render.image_size(state.display.size),
        quality: render.settings.quality(),
        alpha_blend_strategy: render.settings.alpha_blend_strategy,
        settings: render
            .settings
            .l0(render.settings.sample_cap(render.settings.max_samples), 0),
        camera_override: None,
    })
}

/// Clear retires targets before their shared scene. Keep render handles/settings.
pub(super) fn clear_scene(state: &mut State) -> Result<()> {
    for render in state.renders.values_mut() {
        cancel_denoise(render);
        if let Some(flight) = render.job.as_mut() {
            flight.cancelled = true;
            let _ = context_blocking(|| context::cancel_job(flight.job));
        }
        drain(render)?;
        context_blocking(|| context::destroy(render.context))?;
        render.context =
            context_blocking(|| context::create_with_gpu(state.gpu.clone(), state.backend.code()))?;
        render.published = None;
        render.failed = None;
        render.capture = None;
        render.capture_key = None;
        render.captured = 0;
        render.samples = 0;
        render.needs_capture = false;
        render.error = false;
        render.status = RenderStatus::Idle;
        render.output.invalidate();
    }
    state.shared.release();
    state.shared = SharedScene::default();
    state.sample_events.clear();
    // Keep window, settings and dimensions, but discard any composed old image.
    state.display.clear_image(&state.gpu)?;
    Ok(())
}

/// Called by `Engine::update` for every render.
pub(super) fn synchronize(state: &mut State, id: u64, inputs_changed: bool) {
    if inputs_changed {
        if let Some(render) = state.renders.get_mut(&id) {
            cancel_denoise(render);
        }
    }
    let Some(key) = state.renders.get(&id).and_then(|r| desired(state, r)) else {
        return;
    };
    if state.renders[&id].busy {
        return;
    }
    if let Err(e) = commit(state, id, key, false) {
        state.report(e.message);
    }
}

enum Step {
    Published,
    Waiting,
    /// Reported through an engine error event; `failed` holds the message.
    Failed,
}
/// Bring the render's L0 context to `key`. Returns whether it is published;
/// `false` with `error` set means the commit failed and was reported.
/// Non-blocking callers retry later; blocking callers wait for preparation.
fn commit(state: &mut State, id: u64, key: TargetKey, blocking: bool) -> Result<bool> {
    loop {
        state
            .gpu
            .loss
            .check()
            .map_err(|e| error(Status::Unavailable, e.to_string()))?;
        let mut events = Vec::new();
        let step = commit_step(state, id, &key, blocking, &mut events);
        for event in events {
            if let EngineEvent::Error { message } = &event {
                state.last_error = Some(message.clone());
            }
            state.engine_events.push(event);
        }
        match step? {
            Step::Published => return Ok(true),
            Step::Failed => return Ok(false),
            Step::Waiting if !blocking => return Ok(false),
            Step::Waiting => {
                if state.shared.pending.is_none() {
                    std::thread::sleep(Duration::from_micros(200));
                }
            }
        }
    }
}
pub(super) enum SceneStep {
    Published,
    Waiting,
    Failed(String),
}
/// Brings the shared scene to the engine's scene revision. Incremental commits
/// apply on this thread; full preparation runs on a library thread while the
/// previous scene stays published. After each publication every render's target
/// is set again.
pub(super) fn scene_step(
    state: &mut State,
    blocking: bool,
    events: &mut Vec<EngineEvent>,
) -> Result<SceneStep> {
    let loss = state.gpu.loss.clone();
    let revision = state.scene_revision;
    let shared = &mut state.shared;
    if let Some(pending) = shared.pending.as_mut() {
        if pending.revision != revision {
            let context = shared.context.unwrap();
            let _ = context_result(context::cancel_commit(context));
        }
        let received = if blocking {
            loop {
                let _ = state.gpu.device.poll(wgpu::PollType::Poll);
                loss.check()
                    .map_err(|e| error(Status::Unavailable, e.to_string()))?;
                match pending.result.recv_timeout(Duration::from_millis(2)) {
                    Ok(value) => break Ok(value),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        break Err(mpsc::TryRecvError::Disconnected);
                    }
                }
            }
        } else {
            pending.result.try_recv()
        };
        let outcome = match received {
            Ok(outcome) => outcome,
            Err(mpsc::TryRecvError::Empty) => return Ok(SceneStep::Waiting),
            Err(mpsc::TryRecvError::Disconnected) => Err(error(
                Status::ContextFailed,
                "Scene preparation thread stopped",
            )),
        };
        events.extend(
            std::mem::take(&mut *state.gpu.compilation.events.lock().unwrap())
                .into_iter()
                .map(|done| EngineEvent::Progress {
                    stage: ProgressStage::Compilation,
                    progress: if done { 1. } else { 0. },
                }),
        );
        let mut pending = shared.pending.take().unwrap();
        if let Some(thread) = pending.thread.take() {
            let _ = thread.join();
        }
        match outcome {
            Ok(()) => {
                shared.published = Some(pending.revision);
                shared.failed = None;
                shared.generation += 1;
                events.push(EngineEvent::Progress {
                    stage: ProgressStage::Preparation,
                    progress: 1.,
                });
                refresh_targets(state, events);
            }
            Err(e) if e.status == Status::Cancelled => {}
            Err(e) => {
                shared.failed = Some((pending.revision, e.message.clone()));
                events.push(EngineEvent::Error { message: e.message });
            }
        }
    }
    let shared = &mut state.shared;
    if shared.published == Some(revision) {
        return Ok(SceneStep::Published);
    }
    if let Some((_, message)) = shared.failed.as_ref().filter(|(r, _)| *r == revision) {
        return Ok(SceneStep::Failed(message.clone()));
    }
    if shared.pending.is_some() {
        return Ok(SceneStep::Waiting);
    }
    let context = match shared.context {
        Some(context) => context,
        None => {
            let context = context_blocking(|| {
                context::create_scene_with_gpu(state.gpu.clone(), state.backend.code())
            })?;
            state.shared.context = Some(context);
            context
        }
    };
    // Scene preparation keeps the descriptor; per-render size, quality and
    // camera are packed separately when creating each Target.
    let bytes = state.scene.clone().expect("committed scene");
    let settings = scene_settings();
    match context_result(context::commit_path(
        context,
        &bytes,
        &settings,
        CommitPath::IncrementalOnly,
    )) {
        Ok(outcome) => match outcome {
            CommitOutcome::Done => {
                state.shared.published = Some(revision);
                state.shared.failed = None;
                refresh_targets(state, events);
                return Ok(SceneStep::Published);
            }
            CommitOutcome::NeedsFull => {}
            // Another engine is preparing; try incrementally after it publishes.
            CommitOutcome::Blocked if !blocking => return Ok(SceneStep::Waiting),
            CommitOutcome::Blocked => {}
        },
        Err(e) if e.status == Status::Busy => return Ok(SceneStep::Waiting),
        Err(e) => {
            state.shared.failed = Some((revision, e.message.clone()));
            events.push(EngineEvent::Error {
                message: e.message.clone(),
            });
            return Ok(SceneStep::Failed(e.message));
        }
    }
    let (send, result) = mpsc::channel();
    let gpu = state.gpu.clone();
    let thread = std::thread::Builder::new()
        .name("MuTracer scene preparation".into())
        .spawn(move || {
            let outcome = loop {
                if let Err(e) = loss.check() {
                    break Err(error(Status::Unavailable, e.to_string()));
                }
                let result = crate::runtime::with_loss(&gpu, || {
                    context::commit_path(context, &bytes, &settings, CommitPath::FullOnly)
                });
                match context_result(result.map(|_| ())) {
                    Err(e) if e.status == Status::Busy => {
                        std::thread::sleep(Duration::from_micros(200))
                    }
                    result => break result,
                }
            };
            let _ = send.send(outcome);
        })
        .map_err(|e| error(Status::Error, format!("Starting scene preparation: {e}")))?;
    state.shared.pending = Some(Pending {
        revision,
        result,
        thread: Some(thread),
    });
    events.push(EngineEvent::Progress {
        stage: ProgressStage::Preparation,
        progress: 0.,
    });
    Ok(SceneStep::Waiting)
}
/// Sets the target of every render that is not converging on the published scene.
fn refresh_targets(state: &mut State, events: &mut Vec<EngineEvent>) {
    let ids: Vec<u64> = state.renders.keys().copied().collect();
    for id in ids {
        if state.renders[&id].busy {
            continue;
        }
        if let Some(key) = desired(state, &state.renders[&id]) {
            if let Err(e) = target_step(state, id, &key, events) {
                state.renders.get_mut(&id).unwrap().error = true;
                events.push(EngineEvent::Error { message: e.message });
            }
        }
    }
}
/// Links the render's L0 context to the published shared scene with `key`.
fn target_step(
    state: &mut State,
    id: u64,
    key: &TargetKey,
    events: &mut Vec<EngineEvent>,
) -> Result<Step> {
    let scene_context = state.shared.context.expect("published shared scene");
    let generation = state.shared.generation;
    let camera = match key.camera_override.or(state.camera) {
        Some(camera) => camera,
        None => {
            let scene = state.scene.as_ref().expect("committed scene");
            let at = super::engine::camera_offset(scene)?;
            scene[at..at + 128].try_into().unwrap()
        }
    };
    let render = state.renders.get_mut(&id).unwrap();
    if render.published.as_ref() == Some(key) {
        return Ok(Step::Published);
    }
    if render
        .failed
        .as_ref()
        .is_some_and(|(failed, _)| failed == key)
    {
        render.error = true;
        return Ok(Step::Failed);
    }
    render.error = false;
    // Retain completed samples until publication succeeds. A rejected target
    // leaves the old accumulation (including a finished cancelled batch) valid.
    let retained_events = cancel_batch(render)?;
    let result = context_result(context::set_target(
        render.context,
        scene_context,
        &key.settings,
        key.size,
        key.quality,
        key.alpha_blend_strategy as u32,
        &camera,
    ));
    if result.is_err() {
        state
            .sample_events
            .extend(retained_events.into_iter().map(|event| (id, event)));
    }
    match result {
        Ok(()) => {
            let full = render.generation != generation
                || render.published.as_ref().is_none_or(|k| k.size != key.size);
            render.generation = generation;
            render.publish(key.clone(), full);
            render.aov_camera = camera;
            Ok(Step::Published)
        }
        Err(e) if e.status == Status::Busy => Ok(Step::Waiting),
        Err(e) => {
            render.failed = Some((key.clone(), e.message.clone()));
            render.error = true;
            events.push(EngineEvent::Error { message: e.message });
            Ok(Step::Failed)
        }
    }
}
fn commit_step(
    state: &mut State,
    id: u64,
    key: &TargetKey,
    blocking: bool,
    events: &mut Vec<EngineEvent>,
) -> Result<Step> {
    let render = state.renders.get_mut(&id).unwrap();
    if render
        .failed
        .as_ref()
        .is_none_or(|(failed, _)| failed != key)
    {
        render.error = false;
    }
    match scene_step(state, blocking, events)? {
        SceneStep::Published => {}
        SceneStep::Waiting => return Ok(Step::Waiting),
        SceneStep::Failed(message) => {
            let render = state.renders.get_mut(&id).unwrap();
            render.failed = Some((key.clone(), message));
            render.error = true;
            return Ok(Step::Failed);
        }
    }
    if state.shared.published != Some(key.scene) {
        return Err(error(
            Status::InvalidState,
            "Engine inputs changed during the commit",
        ));
    }
    target_step(state, id, key, events)
}

enum Poll {
    Idle,
    Running,
    /// Total retained samples, elapsed batch time and resolution scale.
    Completed(u32, f64, f64),
}
/// Observes the in-flight batch without waiting for the GPU.
fn poll_job(render: &mut RenderState) -> Result<Poll> {
    let Some(flight) = render.job.as_ref() else {
        return Ok(Poll::Idle);
    };
    let job = flight.job;
    let budget = flight.count.min(MAX_BATCH);
    match context_result(context::poll_job(job, budget)) {
        Ok(()) => {}
        Err(e) if e.status == Status::Busy => return Ok(Poll::Running),
        // A publication replaced the job.
        Err(e) if e.status == Status::InvalidHandle && flight.cancelled => {
            render.job = None;
            return Ok(Poll::Idle);
        }
        Err(e) => {
            render.job = None;
            return Err(e);
        }
    }
    let info = match context_result(context::job_info(job)) {
        Ok(info) => info,
        Err(e) if e.status == Status::Busy => return Ok(Poll::Running),
        Err(e) => {
            render.job = None;
            return Err(e);
        }
    };
    match info.state {
        2 | 3 => {
            let flight = render.job.take().unwrap();
            let samples = info.base_samples + info.completed_samples;
            if samples <= render.samples {
                return Ok(Poll::Idle);
            }
            Ok(Poll::Completed(
                samples,
                flight.started.elapsed().as_secs_f64() * 1e3,
                flight.scale,
            ))
        }
        4 => {
            render.job = None;
            Err(error(Status::ContextFailed, "Native render job failed"))
        }
        _ => Ok(Poll::Running),
    }
}
/// Cancels further dispatch and retains any samples L0 already submitted.
fn cancel_batch(render: &mut RenderState) -> Result<Vec<SampleEvent>> {
    if let Some(flight) = render.job.as_mut() {
        flight.cancelled = true;
        let job = flight.job;
        match context_blocking(|| context::cancel_job(job)) {
            Err(e) if e.status != Status::InvalidHandle => return Err(e),
            _ => {}
        }
    }
    drain(render)
}
/// Waits for the in-flight batch, if any.
fn drain(render: &mut RenderState) -> Result<Vec<SampleEvent>> {
    let mut events = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(120);
    while render.job.is_some() {
        if let Some(event) = observe(render)? {
            events.push(event);
        }
        if render.job.is_some() {
            if Instant::now() > deadline {
                return Err(error(Status::Timeout, "Render batch did not complete"));
            }
            std::thread::sleep(Duration::from_micros(100));
        }
    }
    Ok(events)
}
fn update_aovs(render: &mut RenderState) -> Result<()> {
    let mask = render.settings.aovs | render.denoise.custom_aovs;
    if mask == 0 {
        render.aov = None;
        return Ok(());
    }
    if render.samples == 0 {
        return Ok(());
    }
    render_aovs(
        render,
        mask,
        render.samples.min(render.settings.aov_samples),
    )
}
fn render_aovs(render: &mut RenderState, mask: u32, samples: u32) -> Result<()> {
    let query =
        context::aov_query(render.context).map_err(|e| error(Status::Error, e.to_string()))?;
    if render
        .aov
        .as_ref()
        .is_none_or(|a| a.generation != render.input_generation || a.mask != mask)
    {
        let words = query
            .metadata(&render.aov_camera)
            .map_err(|e| error(Status::Error, e.to_string()))?;
        render.aov = Some(
            crate::aov::Output::new(&query, render.input_generation, &words, render.aov.as_ref())
                .map_err(|e| error(Status::Error, e.to_string()))?,
        );
    }
    render
        .aov
        .as_mut()
        .unwrap()
        .render(&query, samples, mask)
        .map_err(|e| error(Status::Error, e.to_string()))
}
/// Polls the batch and accounts completed samples.
fn observe(render: &mut RenderState) -> Result<Option<SampleEvent>> {
    match poll_job(render)? {
        Poll::Completed(samples, elapsed, scale) => {
            let count = samples - render.samples;
            render.adaptive.frame = Some((elapsed, scale));
            render.samples = samples;
            render.sample_ms = Some(elapsed / count.max(1) as f64);
            render.gpu_sample_ms =
                context::job_gpu_time(render.context).map(|ms| ms / count.max(1) as f64);
            render.needs_capture = true;
            update_aovs(render)?;
            let event = SampleEvent {
                samples: render.samples,
                is_first_frame: render.first_frame,
                frame_time_ms: elapsed,
            };
            render.first_frame = false;
            Ok(Some(event))
        }
        _ => Ok(None),
    }
}
fn capture(render: &mut RenderState) -> Result<bool> {
    if !render.needs_capture || render.refine_options.defer_resolve {
        return Ok(true);
    }
    match context::capture_display_filtered(render.context, &mut render.capture, render.jnlm) {
        Ok(true) => {
            render.needs_capture = false;
            render.capture_key = render.published.clone();
            render.captured = render.samples;
            render.output.invalidate();
            // Progressive schedules keep presenting the last denoised image, which
            // the display holds on the GPU since its upload.
            let preserve = render
                .denoise
                .options
                .as_ref()
                .is_some_and(|o| o.schedule != DenoiseSchedule::Converged);
            if let (true, Some(_), Some(capture)) =
                (preserve, &render.denoise.denoised, render.capture.as_mut())
            {
                capture.show_denoised();
            }
            Ok(true)
        }
        Ok(false) => Ok(false),
        Err(message) => Err(error(Status::Error, message)),
    }
}
fn submit(render: &mut RenderState, count: u32) -> Result<()> {
    let context = render.context;
    let job = match context_result(context::submit(context, count)) {
        Ok(job) => job,
        Err(e) if e.status == Status::Busy => return Ok(()),
        Err(e) => return Err(e),
    };
    let scale = render.adaptive.scale.min(render.adaptive.configured);
    render.job = Some(Flight {
        job,
        count,
        started: Instant::now(),
        cancelled: false,
        scale,
    });
    // Dispatch now; a busy registry dispatches at the next poll instead.
    match context_result(context::poll_job(job, count.min(MAX_BATCH))) {
        Err(e) if e.status != Status::Busy => {
            render.job = None;
            Err(e)
        }
        _ => Ok(()),
    }
}
fn batch_count(enabled: bool, sample_ms: Option<f64>, budget: f64, remaining: u32) -> u32 {
    let count = match (enabled, sample_ms) {
        (true, Some(ms)) if ms.is_finite() && ms > 0. => {
            ((budget / ms).floor() as u32).clamp(1, MAX_BATCH)
        }
        _ => 1,
    };
    count.min(remaining).max(1)
}
fn batch_size(render: &RenderState, remaining: u32) -> u32 {
    batch_count(
        render.refine_options.batch_samples.unwrap_or(
            render.settings.batch_samples || render.settings.allow_multiple_samples_per_frame,
        ),
        render.gpu_sample_ms,
        render.settings.time_budget_ms.min(
            render
                .refine_options
                .target_batch_time_ms
                .unwrap_or(f64::INFINITY),
        ),
        remaining,
    )
}
/// Advances one render by at most one batch toward `limit` without blocking.
fn advance(state: &mut State, id: u64, limit: u32) -> Result<()> {
    if collect(state, id)? {
        submit_toward(state.renders.get_mut(&id).unwrap(), limit)?;
    }
    Ok(())
}
/// Accounts a finished batch and captures it. Returns whether no batch is in
/// flight and the accumulation is captured.
fn collect(state: &mut State, id: u64) -> Result<bool> {
    let render = state.renders.get_mut(&id).unwrap();
    if let Some(event) = observe(render)? {
        state.sample_events.push((id, event));
    }
    let render = state.renders.get_mut(&id).unwrap();
    Ok(render.job.is_none() && capture(render)?)
}
fn submit_toward(render: &mut RenderState, limit: u32) -> Result<()> {
    if render.samples < limit {
        let count = batch_size(render, limit - render.samples);
        submit(render, count)?;
    }
    Ok(())
}
fn context_size(context: u64) -> Result<[u32; 2]> {
    let info = context_blocking(|| context::info(context))?;
    Ok([info.width, info.height])
}
/// L0 images are bottom row first; L1 images are top row first.
pub(super) fn flip_rows(data: &[f32], width: u32, height: u32) -> Vec<f32> {
    let row = width as usize * 4;
    (0..height as usize)
        .rev()
        .flat_map(|y| data[y * row..(y + 1) * row].iter().copied())
        .collect()
}
fn denoised_samples(render: &RenderState) -> u32 {
    render.denoise.denoised.as_ref().map_or(0, |d| d.0)
}
fn next_target(render: &RenderState) -> u32 {
    sample_target(
        render.denoise.options.as_ref().map(|o| o.schedule),
        render.samples,
        render.settings.max_samples,
        denoised_samples(render),
        render.denoise.last.map(|t| t.elapsed()),
    )
}
/// Starts or collects OIDN filtering according to the denoise schedule; `force`
/// filters the current samples whatever the schedule (browser `_maybeDenoise(true)`).
fn denoise(state: &mut State, id: u64, force: bool) -> Result<()> {
    let render = state.renders.get_mut(&id).unwrap();
    let Some(options) = render.denoise.options.clone() else {
        return Ok(());
    };
    if options.backend == crate::oidn_webgpu::BACKEND {
        state
            .gpu
            .device
            .poll(wgpu::PollType::Poll)
            .map_err(|e| error(Status::Unavailable, e.to_string()))?;
    }
    if let Some((samples, worker)) = &render.denoise.worker {
        let samples = *samples;
        let (outcome, backend, milliseconds) = match worker.try_recv() {
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Ok(result) => result,
            Err(mpsc::TryRecvError::Disconnected) => (
                Err("Denoising thread stopped".to_owned()),
                String::new(),
                0.,
            ),
        };
        render.denoise.worker = None;
        if matches!(&outcome, Ok(DenoisedImage::DisplayGpu { settings, .. })
            if *settings != state.display.settings.composition())
        {
            return Ok(());
        }
        render.denoise.report = Some(DenoiseReport {
            samples,
            backend,
            milliseconds,
            error: outcome.as_ref().err().cloned(),
        });
        match outcome {
            Ok(pixels) => {
                if let Some(capture) = render.capture.as_mut() {
                    match &pixels {
                        DenoisedImage::Cpu(pixels, _) => capture.upload(pixels),
                        DenoisedImage::Gpu { preview, .. } => capture.upload_gpu(preview),
                        DenoisedImage::Resident(output) => capture.upload_gpu(&output.buffer),
                        DenoisedImage::DisplayGpu { pixels, settings } => {
                            capture.upload_display_oidn(pixels, *settings)
                        }
                    }
                    .map_err(|e| error(Status::Error, e.to_string()))?;
                }
                if let DenoisedImage::Resident(output) = &pixels {
                    output.status.accept();
                }
                if let DenoisedImage::Cpu(_, Some(status)) = &pixels {
                    status.accept();
                }
                if let Some(temporal) = &mut render.temporal {
                    temporal
                        .accept()
                        .map_err(|e| error(Status::Error, e.to_string()))?;
                }
                render.output.invalidate();
                render.denoise.denoised = Some((samples, pixels));
                render.denoise.last = Some(Instant::now());
            }
            Err(message) => {
                if let Some(temporal) = &mut render.temporal {
                    temporal.reject();
                }
                render.denoise.failed = true;
                state.report(message);
            }
        }
        return Ok(());
    }
    let due = force
        || match options.schedule {
            DenoiseSchedule::Converged => render.samples >= render.settings.max_samples,
            DenoiseSchedule::Progressive => render.samples >= next_target(render),
            DenoiseSchedule::EverySample => true,
        };
    if !due
        || render.denoise.failed
        || render.samples == 0
        || render.job.is_some()
        || render.needs_capture
        || denoised_samples(render) == render.samples
    {
        return Ok(());
    }
    if options.backend == crate::oidn_webgpu::BACKEND && render.denoise.custom.0.is_none() {
        let started = Instant::now();
        let outcome = (|| -> std::result::Result<_, String> {
            let (sources, size, flat) =
                context::denoise_buffers(render.context).map_err(|e| e.to_string())?;
            if render
                .denoise
                .gpu_filter
                .as_ref()
                .is_none_or(|f| f.size() != size)
            {
                render.denoise.gpu_filter = Some(
                    crate::oidn_webgpu::Denoiser::new(
                        &state.gpu,
                        size,
                        options.library.as_deref(),
                        options.max_tile_size,
                    )
                    .map_err(|e| format!("{e:#}"))?,
                );
            }
            if render.denoise.display {
                let settings = state.display.settings.composition();
                let capture = render.capture.as_mut().ok_or("Missing display snapshot")?;
                let inputs = capture
                    .oidn_display_inputs(&settings)
                    .map_err(|e| e.to_string())?;
                let pixels = render
                    .denoise
                    .gpu_filter
                    .as_mut()
                    .unwrap()
                    .submit_display(
                        &state.gpu,
                        &inputs[0],
                        &inputs[1],
                        capture.oidn_normal(),
                        render.samples,
                    )
                    .map_err(|e| e.to_string())?;
                return Ok(DenoisedImage::DisplayGpu { pixels, settings });
            }
            let (pixels, preview) = render
                .denoise
                .gpu_filter
                .as_mut()
                .unwrap()
                .submit(
                    &state.gpu,
                    [&sources[0], &sources[1], &sources[2]],
                    render.samples,
                    flat,
                )
                .map_err(|e| format!("{e:#}"))?;
            Ok(DenoisedImage::Gpu { pixels, preview })
        })();
        let (send, receive) = mpsc::channel();
        state.gpu.queue.on_submitted_work_done(move || {
            let _ = send.send((
                outcome,
                "oidn-webgpu".into(),
                started.elapsed().as_secs_f64() * 1e3,
            ));
        });
        render.denoise.worker = Some((render.samples, receive));
        return Ok(());
    }
    let filter = render.denoise.filter.clone();
    let custom = render.denoise.custom.0.clone();
    let input_mode = render.denoise.custom_mode;
    let gpu = state.gpu.clone();
    let cancel = CancelToken::new();
    render.denoise.cancel = cancel.clone();
    let size = context_size(render.context)?;
    // Freeze before releasing the engine lock: a cancelled callback may overlap
    // a new render or scene publication. Only explicit custom filtering pays for
    // these copies. OIDN retains its CPU path.
    if render.denoise.custom_aovs != 0 {
        update_aovs(render)?;
    }
    let resident = if let Some(custom) = &custom {
        let buffers = render
            .capture
            .as_mut()
            .ok_or_else(|| error(Status::InvalidState, "Missing custom denoiser capture"))?
            .denoise_buffers()
            .map_err(|e| error(Status::Error, e.to_string()))?;
        let mut input = super::GpuDenoiseInput::new(
            &gpu,
            render.context,
            render.input_generation,
            size,
            render.samples,
            buffers,
            custom.clone(),
            cancel.clone(),
        );
        if render.denoise.custom_aovs != 0 {
            input.aovs = render
                .aov
                .as_ref()
                .ok_or_else(|| error(Status::InvalidState, "Missing custom AOV input"))?
                .snapshot(render.denoise.custom_aovs)
                .map_err(|e| error(Status::Error, e.to_string()))?;
            input.retain_buffers();
        }
        if input_mode == super::DenoiseInputMode::TemporalGpu {
            let key = render
                .published
                .as_ref()
                .ok_or_else(|| error(Status::InvalidState, "No temporal target"))?;
            let temporal = render
                .temporal
                .get_or_insert_with(|| super::temporal::State::new(&gpu, size));
            input.temporal = Some(
                temporal
                    .produce(super::temporal::Request {
                        context: render.context,
                        size,
                        camera: &render.aov_camera,
                        settings: &key.settings,
                        quality: key.quality,
                        alpha: key.alpha_blend_strategy as u32,
                        scene_revision: key.scene,
                        camera_revision: key.camera,
                    })
                    .map_err(|e| error(Status::Error, e.to_string()))?,
            );
            input.retain_buffers();
        }
        Some(input)
    } else {
        None
    };
    render.denoise.frame_status = resident.as_ref().map(|input| input.status());
    let cpu = if custom.is_none() {
        Some(denoise_inputs(render.context)?)
    } else {
        None
    };
    let (send, receive) = mpsc::channel();
    std::thread::Builder::new()
        .name("MuTracer denoising".into())
        .spawn(move || {
            let retirement = resident.as_ref().map(|input| input.status());
            let result = if let Some(custom) = custom {
                let started = Instant::now();
                let status = resident.as_ref().unwrap().status();
                let expected = resident.as_ref().unwrap().id;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let resident_mode = input_mode != super::DenoiseInputMode::Cpu;
                    let aovs = if resident_mode {
                        Vec::new()
                    } else {
                        resident
                            .as_ref()
                            .unwrap()
                            .aovs
                            .iter()
                            .map(|aov| crate::aov::read_denoise_aov(&gpu, aov))
                            .collect::<crate::Result<Vec<_>>>()
                            .map_err(|e| e.to_string())?
                    };
                    let aov_buffers = if !resident_mode && custom.gpu_inputs() {
                        resident.as_ref().unwrap().aovs.clone()
                    } else {
                        Vec::new()
                    };
                    let (color, normal, albedo, resident) = if resident_mode {
                        let mut input = resident.unwrap();
                        let pipeline = gpu
                            .custom_snapshot_pipeline
                            .get_or_init(|| super::custom_gpu::snapshot_pipeline(&gpu.device));
                        input.buffers = super::custom_gpu::snapshot_buffers(
                            &gpu,
                            pipeline,
                            [
                                &input.buffers.color,
                                &input.buffers.normal,
                                &input.buffers.albedo,
                            ],
                            size,
                            input.samples,
                        )
                        .map_err(|e| e.to_string())?;
                        input.retain_buffers();
                        (Vec::new(), Vec::new(), Vec::new(), Some(input))
                    } else {
                        let snapshot = resident.as_ref().unwrap();
                        let read = |buffer| -> std::result::Result<Vec<f32>, String> {
                            let bytes = crate::read_average(
                                &gpu.device,
                                &gpu.queue,
                                buffer,
                                size[0],
                                size[1],
                                snapshot.samples,
                            )
                            .map_err(|e| e.to_string())?;
                            Ok(bytemuck::pod_collect_to_vec::<u8, f32>(&bytes))
                        };
                        (
                            read(&snapshot.buffers.color)?,
                            read(&snapshot.buffers.normal)?,
                            read(&snapshot.buffers.albedo)?,
                            None,
                        )
                    };
                    let buffers = if !resident_mode && custom.gpu_inputs() {
                        use wgpu::util::DeviceExt;
                        let upload = |values: &[f32]| {
                            gpu.device
                                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                    label: Some("MuTracer custom denoiser input"),
                                    contents: bytemuck::cast_slice(values),
                                    usage: wgpu::BufferUsages::STORAGE
                                        | wgpu::BufferUsages::COPY_SRC,
                                })
                        };
                        Some(super::DenoiseBuffers {
                            color: upload(&color),
                            normal: upload(&normal),
                            albedo: upload(&albedo),
                        })
                    } else {
                        None
                    };
                    let submission = resident
                        .as_ref()
                        .map(|input| input.gpu.duplicate())
                        .unwrap_or_else(|| super::DenoiseGpu(gpu.queue.clone(), None));
                    let input = super::DenoiseInput {
                        aovs,
                        aov_buffers,
                        size,
                        color,
                        normal,
                        albedo,
                        buffers,
                        device: gpu.device.clone(),
                        gpu: submission,
                        resident,
                    };
                    let pixels = match custom.denoise(input, cancel.clone())? {
                        super::DenoiseOutput::Cpu(pixels) => pixels,
                        super::DenoiseOutput::Resident(output) => {
                            if !resident_mode || output.id != expected || output.size != size {
                                return Err(
                                    "Custom GPU result belongs to another invocation".into()
                                );
                            }
                            return Ok(DenoisedImage::Resident(output));
                        }
                        super::DenoiseOutput::Gpu(buffer) => {
                            if buffer.size() < size[0] as u64 * size[1] as u64 * 16
                                || !buffer.usage().contains(wgpu::BufferUsages::COPY_SRC)
                            {
                                return Err("Invalid custom denoiser GPU output buffer".into());
                            }
                            let bytes = crate::read_average(
                                &gpu.device,
                                &gpu.queue,
                                &buffer,
                                size[0],
                                size[1],
                                1,
                            )
                            .map_err(|e| e.to_string())?;
                            bytemuck::pod_collect_to_vec::<u8, f32>(&bytes)
                        }
                    };
                    super::custom_denoise::validate(pixels, size).map(|pixels| {
                        DenoisedImage::Cpu(pixels, resident_mode.then(|| status.clone()))
                    })
                }))
                .unwrap_or_else(|_| Err("Custom denoiser panicked".into()));
                // A returned callback cannot enqueue more work for this frame,
                // even if it saved a submission handle or its owned input.
                status.close();
                if result.is_err() {
                    status.reject();
                }
                (
                    result,
                    "custom".into(),
                    started.elapsed().as_secs_f64() * 1000.,
                )
            } else {
                let (_, color, normal, albedo) = cpu.unwrap();
                run_oidn(&filter, &options, size, &color, &normal, &albedo)
            };
            if !cancel.is_cancelled() {
                let _ = send.send(result);
            }
            if let Some(status) = retirement {
                status.maintain_retirement(&gpu);
            }
        })
        .map_err(|e| error(Status::Error, format!("Starting denoising: {e}")))?;
    render.denoise.worker = Some((render.samples, receive));
    Ok(())
}
type DenoiseInputs = ([u32; 2], Vec<f32>, Vec<f32>, Vec<f32>);
fn denoise_inputs(context: u64) -> Result<DenoiseInputs> {
    Ok((
        context_size(context)?,
        context_blocking(|| context::read_pixels(context, 0))?,
        context_blocking(|| context::read_pixels(context, 1))?,
        context_blocking(|| context::read_pixels(context, 2))?,
    ))
}
fn run_oidn(
    filter: &Mutex<Option<crate::denoise::Denoiser>>,
    options: &DenoiserOptions,
    size: [u32; 2],
    color: &[f32],
    normal: &[f32],
    albedo: &[f32],
) -> DenoiseResult {
    let mut filter = filter.lock().unwrap_or_else(|e| e.into_inner());
    if filter.is_none() {
        let created = match &options.library {
            Some(path) => crate::denoise::Denoiser::from_library(path, options.backend),
            None => crate::denoise::Denoiser::with_backend(options.backend),
        };
        match created {
            Ok(created) => *filter = Some(created),
            Err(e) => return (Err(format!("{e:#}")), String::new(), 0.),
        }
    }
    let filter = filter.as_mut().unwrap();
    let started = Instant::now();
    let result = filter
        .run(size, color, normal, albedo)
        .map_err(|e| format!("{e:#}"));
    (
        result.map(|pixels| DenoisedImage::Cpu(pixels, None)),
        filter.backend.to_owned(),
        started.elapsed().as_secs_f64() * 1e3,
    )
}

/// One independently configured image and its accumulation, owned by an engine.
/// Dropping a render releases it.
pub struct Render {
    engine: Engine,
    id: u64,
    // Callback views borrow the registered render and must not retire it on drop.
    owned: bool,
}
impl Render {
    /// Creates a render of the engine's scene with validated `settings`. It shares
    /// the engine's prepared scene and keeps its own accumulation.
    pub fn new(engine: &Engine, settings: RenderSettings) -> Result<Self> {
        settings.validate()?;
        let adaptive = Adaptive::new(&settings);
        let mut state = engine.live()?;
        let context = context_blocking(|| {
            context::create_with_gpu(engine.inner.gpu.clone(), engine.inner.backend.code())
        })?;
        let id = state.next_render;
        state.next_render += 1;
        let initial_status = if state.scene.is_some() {
            RenderStatus::Preparing
        } else {
            RenderStatus::Idle
        };
        state.renders.insert(
            id,
            RenderState {
                settings,
                jnlm: None,
                fallback: None,
                context,
                aov: None,
                temporal: None,
                aov_camera: [0; 128],
                published: None,
                generation: 0,
                input_generation: 0,
                failed: None,
                job: None,
                samples: 0,
                first_frame: true,
                sample_ms: None,
                gpu_sample_ms: None,
                refine_options: RefineOptions::default(),
                refill_cancel: None,
                capture: None,
                output: Default::default(),
                capture_key: None,
                captured: 0,
                needs_capture: false,
                status: initial_status,
                error: false,
                busy: false,
                denoise: Denoise::default(),
                denoiser_revision: 0,
                adaptive,
            },
        );
        Ok(Self {
            engine: engine.clone(),
            id,
            owned: true,
        })
    }
    pub(super) fn view(engine: &Engine, id: u64) -> Self {
        Self {
            engine: engine.clone(),
            id,
            owned: false,
        }
    }
    pub(super) fn id(&self) -> u64 {
        self.id
    }
    pub(super) fn engine(&self) -> &Engine {
        &self.engine
    }
    /// Browser `_complete`: a captured image of the current inputs.
    #[cfg(test)]
    pub(super) fn complete(&self) -> bool {
        readiness(&self.engine.lock(), self.id).complete
    }
    pub(super) fn display_complete(&self) -> bool {
        display_readiness(&self.engine.lock(), self.id).complete
    }
    pub(super) fn display_samples(&self) -> u32 {
        self.get(|state, r| {
            if let Some(kind) = state.display.settings.channel.aov_kind() {
                aov_samples(
                    r,
                    kind.aov_mask(),
                    state.scene_revision,
                    state.camera_revision,
                )
            } else if r.current(state.scene_revision, state.camera_revision) {
                r.samples
            } else {
                0
            }
        })
        .unwrap_or(0)
    }
    pub(super) fn display_finished(&self) -> bool {
        self.get(|state, r| {
            if let Some(kind) = state.display.settings.channel.aov_kind() {
                aov_samples(
                    r,
                    kind.aov_mask(),
                    state.scene_revision,
                    state.camera_revision,
                ) >= if kind.aov_mask() & 31 == 0 {
                    1
                } else {
                    r.settings.aov_samples
                }
            } else {
                r.current(state.scene_revision, state.camera_revision)
                    && r.status == RenderStatus::Finished
            }
        })
        .unwrap_or(false)
    }
    pub(super) fn refine_display(
        &self,
        stationary: bool,
        options: RefineOptions,
    ) -> Result<RenderStatus> {
        let channel = self.engine.lock().display.settings.channel;
        let Some(kind) = channel.aov_kind() else {
            return self.refine_with_options(options);
        };
        self.engine.poll_device();
        self.with(|state, id| {
            let Some(key) = desired(state, &state.renders[&id]) else {
                return Ok(RenderStatus::Idle);
            };
            if !commit(state, id, key, false)? {
                return Ok(if state.renders[&id].error {
                    RenderStatus::Error
                } else if state.gpu.compilation.active.load(Ordering::Acquire) > 0 {
                    RenderStatus::Compiling
                } else {
                    RenderStatus::Preparing
                });
            }
            // Finish previously dispatched beauty work; auxiliary display never
            // dispatches more beauty samples or starts another denoising job.
            if !collect(state, id)? {
                return Ok(RenderStatus::Converging);
            }
            let r = state.renders.get_mut(&id).unwrap();
            let mask = kind.aov_mask();
            if r.settings.aovs & mask == 0 {
                return Err(error(Status::InvalidState, "Displayed AOV is not enabled"));
            }
            let target = if mask & 31 == 0 {
                1
            } else {
                r.settings.aov_samples
            };
            let count = r
                .aov
                .as_ref()
                .filter(|a| a.generation == r.input_generation && a.mask == mask)
                .map_or(0, |a| a.samples);
            if count < target {
                render_aovs(r, mask, (count + 1).min(target))?;
                if stationary && kind == PixelKind::Motion {
                    let query = context::aov_query(r.context)
                        .map_err(|e| error(Status::Error, e.to_string()))?;
                    r.aov
                        .as_mut()
                        .unwrap()
                        .settle_motion(&query)
                        .map_err(|e| error(Status::Error, e.to_string()))?;
                }
                r.output.invalidate();
            } else if stationary && kind == PixelKind::Motion {
                let query = context::aov_query(r.context)
                    .map_err(|e| error(Status::Error, e.to_string()))?;
                r.aov
                    .as_mut()
                    .unwrap()
                    .settle_motion(&query)
                    .map_err(|e| error(Status::Error, e.to_string()))?;
                r.output.invalidate();
            }
            Ok(if count + 1 >= target {
                RenderStatus::Finished
            } else {
                RenderStatus::Converging
            })
        })
    }
    pub(super) fn fallback_id(&self) -> Option<u64> {
        self.get(|_, r| r.fallback).flatten()
    }
    fn with<T>(&self, f: impl FnOnce(&mut State, u64) -> Result<T>) -> Result<T> {
        let result = (|| {
            let mut state = self.engine.live()?;
            if !state.renders.contains_key(&self.id) {
                return Err(error(Status::InvalidHandle, "Render is disposed"));
            }
            let result =
                crate::runtime::with_loss(&self.engine.inner.gpu, || f(&mut state, self.id));
            self.engine
                .inner
                .gpu
                .loss
                .check()
                .map_err(|e| error(Status::Unavailable, e.to_string()))?;
            result
        })();
        self.engine.flush();
        result
    }
    fn get<T>(&self, f: impl FnOnce(&State, &RenderState) -> T) -> Option<T> {
        let state = self.engine.lock();
        state.renders.get(&self.id).map(|r| f(&state, r))
    }
    /// The latest settings from [`Render::new`] or [`Render::set_settings`].
    pub fn settings(&self) -> Result<RenderSettings> {
        self.with(|state, id| Ok(state.renders[&id].settings.clone()))
    }
    /// Validated, then applied at the next refine or engine update.
    pub fn set_settings(&self, settings: RenderSettings) -> Result<()> {
        settings.validate()?;
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            // As in the browser, only a new configured scale resets the adaptive one;
            // a new controller drops the batch not yet evaluated.
            if Adaptive::new(&settings).configured != render.adaptive.configured {
                render.adaptive = Adaptive::new(&settings);
            } else if settings.adaptive_resolution != render.settings.adaptive_resolution {
                render.adaptive.frame = None;
                render.adaptive.fast_frames = 0;
            }
            if settings.aov_samples < render.settings.aov_samples {
                render.aov = None;
            }
            render.settings = settings;
            let mask = render.settings.aovs | render.denoise.custom_aovs;
            if mask == 0 {
                render.aov = None;
            }
            Ok(())
        })
    }
    /// Single-level fallback presented until this render has a complete image.
    /// It must belong to the same engine and have no fallback of its own. Default none.
    pub fn set_fallback(&self, fallback: Option<&Render>) -> Result<()> {
        if let Some(fallback) = fallback {
            if !Arc::ptr_eq(&fallback.engine.inner, &self.engine.inner) || fallback.id == self.id {
                return Err(error(
                    Status::InvalidArgument,
                    "Fallback must be another render on the same engine",
                ));
            }
        }
        self.with(|state, id| {
            if let Some(fallback) = fallback {
                let target = state
                    .renders
                    .get(&fallback.id)
                    .ok_or_else(|| error(Status::InvalidHandle, "Fallback render is disposed"))?;
                if target.fallback.is_some() {
                    return Err(error(
                        Status::InvalidArgument,
                        "A fallback render cannot have its own fallback",
                    ));
                }
                if state.renders.values().any(|r| r.fallback == Some(id)) {
                    return Err(error(
                        Status::InvalidArgument,
                        "Fallback renders cannot have their own fallback",
                    ));
                }
            }
            state.renders.get_mut(&id).unwrap().fallback = fallback.map(|f| f.id);
            Ok(())
        })
    }
    /// Filters the composed SDR display with JNLM, including PNG export.
    /// `None` disables it (default); settings do not change raw HDR, HDR window output or samples.
    /// Invalid options return `InvalidArgument`. Disable an OIDN/custom denoiser
    /// first when JNLM should be the only filter.
    pub fn set_jnlm_display_filter(&self, options: Option<super::JnlmOptions>) -> Result<()> {
        if options.is_some_and(|o| !o.valid()) {
            return Err(error(Status::InvalidArgument, "Invalid JNLM options"));
        }
        self.with(|state, id| {
            let r = state.renders.get_mut(&id).unwrap();
            if r.jnlm != options {
                r.jnlm = options;
                r.denoiser_revision += 1;
                r.needs_capture |= r.samples > 0;
                r.output.invalidate();
                if let Some(c) = &mut r.capture {
                    c.set_jnlm(options);
                }
            }
            Ok(())
        })
    }
    /// Replaces the denoiser; `None` disables denoising. Default none. A loaded
    /// OIDN device is kept while the library and backend stay the same;
    /// oidn-webgpu reuses its resources while weights, tiling and size stay the same.
    pub fn set_denoiser(&self, options: Option<DenoiserOptions>) -> Result<()> {
        self.set_denoiser_domain(options, false)
    }
    // Viewer-only plumbing; the installed SDK keeps its HDR denoiser contract.
    #[cfg(feature = "viewer-support")]
    #[doc(hidden)]
    pub fn set_viewer_denoiser(&self, options: Option<DenoiserOptions>) -> Result<()> {
        self.set_denoiser_domain(options, true)
    }
    fn set_denoiser_domain(&self, options: Option<DenoiserOptions>, display: bool) -> Result<()> {
        if let Some(options) = &options {
            if display && options.backend != DENOISE_OIDN_WEBGPU {
                return Err(error(
                    Status::InvalidArgument,
                    "Viewer display denoising requires oidn-webgpu",
                ));
            }
            if options.backend > crate::oidn_webgpu::BACKEND {
                return Err(error(Status::InvalidArgument, "Unknown denoising backend"));
            }
            if options.backend == DENOISE_OIDN_WEBGPU
                && options.max_tile_size != 0
                && !(16..=16384).contains(&options.max_tile_size)
            {
                return Err(error(
                    Status::InvalidArgument,
                    "OIDN tile edge must be 0 or 16..=16384",
                ));
            }
        }
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            if render.denoise.custom.0.is_none()
                && render.denoise.options == options
                && render.denoise.display == display
            {
                return Ok(());
            }
            cancel_denoise(render);
            let device = |o: &DenoiserOptions| (o.library.clone(), o.backend);
            let filter = match (&render.denoise.options, &options) {
                (Some(old), Some(new)) if device(old) != device(new) => Default::default(),
                _ => render.denoise.filter.clone(),
            };
            let gpu_filter = match (&render.denoise.options, &options) {
                (Some(old), Some(new))
                    if device(old) == device(new) && old.max_tile_size == new.max_tile_size =>
                {
                    render.denoise.gpu_filter.take()
                }
                _ => None,
            };
            render.denoiser_revision += 1;
            render.denoise = Denoise {
                display,
                options,
                filter,
                gpu_filter,
                ..Default::default()
            };
            Ok(())
        })
    }
    /// Installs a user filter with the given schedule, replacing the built-in filter. None
    /// disables it. Callbacks own their data, run off-thread and may overlap after
    /// cancellation. Cpu mode reads inputs on the worker. ResidentGpu mode keeps
    /// input and result images on the device; explicit pixel reads still read back.
    /// Replacement and destruction never wait for the callback or GPU retirement.
    pub fn set_custom_denoiser(
        &self,
        filter: Option<Arc<dyn super::CustomDenoiser>>,
        schedule: DenoiseSchedule,
    ) -> Result<()> {
        let filter = super::custom_denoise::Filter(filter);
        let (requested_aovs, input_mode) =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                (
                    filter.0.as_ref().map_or(0, |f| f.aovs()),
                    filter
                        .0
                        .as_ref()
                        .map_or(super::DenoiseInputMode::Cpu, |f| f.input_mode()),
                )
            }))
            .map_err(|_| {
                error(
                    Status::InvalidArgument,
                    "Custom denoiser input declaration panicked",
                )
            })?;
        if requested_aovs & !127 != 0 {
            return Err(error(Status::InvalidArgument, "Unknown custom AOV mask"));
        }
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            cancel_denoise(render);
            render.denoiser_revision += 1;
            if render.denoise.custom_aovs != requested_aovs {
                render.aov = None;
            }
            render.denoise = Denoise {
                options: filter.0.as_ref().map(|_| DenoiserOptions {
                    schedule,
                    ..Default::default()
                }),
                custom: filter,
                custom_aovs: requested_aovs,
                custom_mode: input_mode,
                ..Default::default()
            };
            Ok(())
        })
    }
    /// Collects a finished batch without waiting for it, submits the next one and
    /// starts due denoising. Preparation, shader compilation, target changes and
    /// denoising input readback may block; the frame budget is not a hard deadline.
    /// Render failures return `Ok(RenderStatus::Error)` and an engine error event;
    /// terminal device loss returns `Err(Status::Unavailable)`.
    pub fn refine(&self) -> Result<RenderStatus> {
        self.refine_with_options(RefineOptions::default())
    }
    /// Advances this render using per-call batching and capture overrides.
    /// Invalid budgets return `InvalidArgument` before scheduling work.
    pub fn refine_with_options(&self, options: RefineOptions) -> Result<RenderStatus> {
        options.validate()?;
        self.engine.poll_device();
        self.with(|state, id| {
            state.renders.get_mut(&id).unwrap().output.invalidate();
            if state.renders[&id].busy {
                return Err(error(
                    Status::InvalidState,
                    "Cannot refine a render while converge is running",
                ));
            }
            state.renders.get_mut(&id).unwrap().refine_options = options;
            let result = refine(state, id);
            state.renders.get_mut(&id).unwrap().refine_options = RefineOptions::default();
            match result {
                Ok(status) => Ok(status),
                Err(e) => {
                    let render = state.renders.get_mut(&id).unwrap();
                    render.error = true;
                    render.status = RenderStatus::Error;
                    state.report(e.message);
                    Ok(RenderStatus::Error)
                }
            }
        })
    }
    /// Runs one ordinary [`Render::refine`] even when the deadline has passed or
    /// `cancel` is already cancelled, then collects/refills sampling until a
    /// monotonic deadline. `None` disables application cancellation. Cancellation
    /// returns the current status, retaining submitted samples.
    ///
    /// This call blocks while polling GPU completion with 1 ms sleep intervals.
    /// Present this render first to permit refills, then present again after this
    /// call. Refills require the engine's Final display channel, batching, at least
    /// one complete sample, valid GPU timing within `time_budget_ms`, queued
    /// sampling and no filtering, input changes or convergence. No syncs, input
    /// commits or presentation run here. Preparation/compilation/first-sample work
    /// advances only in the initial refine and can exceed the deadline.
    /// Deadlines and cancellation do not interrupt an in-progress refine or callback.
    /// A newer call cancels the previous refill. Errors follow [`Render::refine`].
    pub fn refine_until(
        &self,
        deadline: Instant,
        cancel: Option<&CancelToken>,
    ) -> Result<RenderStatus> {
        let lease = CancelToken::new();
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            if let Some(previous) = render.refill_cancel.replace(lease.clone()) {
                previous.cancel();
            }
            Ok(())
        })?;
        let result = (|| {
            self.refine()?;
            let revision = self.get(|state, r| {
                (
                    state.scene_revision,
                    state.camera_revision,
                    r.input_generation,
                )
            });
            let can_continue = || {
                !lease.is_cancelled()
                    && !cancel.is_some_and(CancelToken::is_cancelled)
                    && Instant::now() < deadline
                    && !self.engine.inputs_pending()
                    && self.status() == RenderStatus::Converging
                    && self
                        .get(|state, r| {
                            revision
                                == Some((
                                    state.scene_revision,
                                    state.camera_revision,
                                    r.input_generation,
                                ))
                                && state.display.settings.channel == super::Channel::Final
                                && state.display.presented_render == Some(self.id)
                                && !r.busy
                                && r.job.is_some()
                                && r.denoise.worker.is_none()
                                && r.samples > 0
                                && r.samples < next_target(r)
                                && r.status == RenderStatus::Converging
                                && (r.settings.batch_samples
                                    || r.settings.allow_multiple_samples_per_frame)
                                && r.gpu_sample_ms
                                    .is_some_and(|ms| ms <= r.settings.time_budget_ms)
                        })
                        .unwrap_or(false)
            };
            while can_continue() {
                let ready = Arc::new(AtomicBool::new(false));
                let completed = ready.clone();
                self.engine
                    .inner
                    .gpu
                    .queue
                    .on_submitted_work_done(move || completed.store(true, Ordering::Release));
                while !ready.load(Ordering::Acquire) && can_continue() {
                    self.engine.poll_device();
                    if !ready.load(Ordering::Acquire) {
                        std::thread::sleep(
                            deadline
                                .saturating_duration_since(Instant::now())
                                .min(Duration::from_millis(1)),
                        );
                    }
                }
                if !can_continue() {
                    break;
                }
                self.refine_with_options(RefineOptions {
                    target_batch_time_ms: Some(4.),
                    defer_resolve: true,
                    ..Default::default()
                })?;
            }
            Ok(self.status())
        })();
        lease.cancel();
        let _ = self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            if render
                .refill_cancel
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(&current.0, &lease.0))
            {
                render.refill_cancel = None;
            }
            Ok(())
        });
        result
    }
    // Match the browser capacity wait: only sampling in flight can wake a refill.
    // Display, filtering and offline jobs do not grant background sampling.
    pub(super) fn refill_ready(&self) -> bool {
        self.get(|_, r| {
            !r.busy && r.job.is_some() && r.denoise.worker.is_none() && r.samples < next_target(r)
        })
        .unwrap_or(false)
    }
    /// Last measured GPU time per beauty sample, or `None` before a valid
    /// timestamp or after inputs restart. CPU polling time is excluded.
    pub fn gpu_sample_time_ms(&self) -> Option<f64> {
        self.get(|state, r| {
            r.current(state.scene_revision, state.camera_revision)
                .then_some(r.gpu_sample_ms)
                .flatten()
        })
        .flatten()
    }
    /// Renders exactly `options.samples` samples, blocking until they complete.
    /// The engine lock is released between batches, so the progress callback may
    /// use the API; refine on this render is rejected meanwhile.
    pub fn converge(&self, mut options: ConvergeOptions) -> Result<ConvergeResult> {
        self.engine.poll_device();
        if !(1..=MAX_TOTAL_SAMPLES).contains(&options.samples) {
            return Err(error(Status::InvalidArgument, "samples must be 1..16384"));
        }
        let started = Instant::now();
        let timeout = Duration::from_millis(options.timeout_ms.max(1));
        if options
            .target_batch_time_ms
            .is_some_and(|ms| !ms.is_finite() || ms <= 0.)
            || options
                .preview_interval_ms
                .is_some_and(|ms| !ms.is_finite() || ms < 0.)
        {
            return Err(error(
                Status::InvalidArgument,
                "Invalid convergence timing budget",
            ));
        }
        let batch = options.samples_per_batch.clamp(1, MAX_BATCH);
        let key = self.with(|state, id| {
            if state.renders[&id].busy {
                return Err(error(Status::InvalidState, "Converge is already running"));
            }
            let mut key = desired(state, &state.renders[&id]).ok_or_else(|| {
                error(
                    Status::InvalidState,
                    "Commit a scene with engine.update() before converge",
                )
            })?;
            let render = state.renders.get_mut(&id).unwrap();
            render.busy = true;
            cancel_denoise(render);
            key.settings = render.settings.l0(
                render.settings.sample_cap(options.samples),
                options.sample_sequence_offset,
            );
            key.camera_override = options.camera.map(|c| c.to_bytes());
            Ok(key)
        })?;
        let result = self.run_converge(&mut options, key, started, timeout, batch);
        let _ = self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            render.busy = false;
            match &result {
                Ok(_) => render.status = RenderStatus::Finished,
                Err(_) if render.published.is_none() => render.status = RenderStatus::Idle,
                Err(_) => {
                    render.status = RenderStatus::Error;
                    // Stop further dispatch and collect retained samples now.
                    if let Some(flight) = render.job.as_mut() {
                        flight.cancelled = true;
                        let job = flight.job;
                        let _ = context_blocking(|| context::cancel_job(job));
                        for event in drain(render)? {
                            state.sample_events.push((id, event));
                        }
                    }
                    // L0 keeps a cancelled batch that had already finished; the
                    // partial accumulation stays valid for the same key.
                    if render.published.is_some() {
                        render.samples =
                            context_blocking(|| context::info(render.context))?.samples;
                        render.needs_capture = render.samples > 0;
                        capture(render)?;
                    }
                }
            }
            Ok(())
        });
        result
    }
    fn run_converge(
        &self,
        options: &mut ConvergeOptions,
        key: TargetKey,
        started: Instant,
        timeout: Duration,
        batch: u32,
    ) -> Result<ConvergeResult> {
        let target = options.samples;
        let cancel = options.cancel.clone();
        let check = |state: &State| -> Result<()> {
            if cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
                return Err(error(Status::Cancelled, "Convergence cancelled"));
            }
            if started.elapsed() > timeout {
                return Err(error(Status::Timeout, "Timed out rendering convergence"));
            }
            if state.scene_revision != key.scene || state.camera_revision != key.camera {
                return Err(error(
                    Status::InvalidState,
                    "Engine inputs changed during converge",
                ));
            }
            Ok(())
        };
        // Commit (blocking through full preparation), then restart the accumulation.
        self.with(|state, id| {
            check(state)?;
            let render = state.renders.get_mut(&id).unwrap();
            if let Some(flight) = render.job.as_mut() {
                flight.cancelled = true;
            }
            let retained_events = drain(render)?;
            let was_published = render.published.as_ref() == Some(&key);
            let committed = commit(state, id, key.clone(), true);
            if !matches!(&committed, Ok(true)) {
                state
                    .sample_events
                    .extend(retained_events.into_iter().map(|event| (id, event)));
            }
            if !committed? {
                let render = &state.renders[&id];
                let message = render.failed.as_ref().map(|f| f.1.clone());
                return Err(error(
                    Status::Error,
                    message.unwrap_or_else(|| "Scene commit failed".into()),
                ));
            }
            let render = state.renders.get_mut(&id).unwrap();
            if was_published {
                let context = render.context;
                context_blocking(|| context::reset(context))?;
                render.publish(key.clone(), false);
            }
            Ok(())
        })?;
        let mut reported = 0;
        let mut captured_at = Instant::now();
        loop {
            let (samples, done) = self.with(|state, id| {
                check(state)?;
                let render = state.renders.get_mut(&id).unwrap();
                if let Some(event) = observe(render)? {
                    state.sample_events.push((id, event));
                }
                let render = state.renders.get_mut(&id).unwrap();
                if options
                    .preview_interval_ms
                    .is_some_and(|ms| captured_at.elapsed().as_secs_f64() * 1e3 >= ms)
                    && render.samples > 0
                    && render.job.is_none()
                {
                    capture(render)?;
                    captured_at = Instant::now();
                }
                if render.job.is_none() && render.samples < target {
                    let count = if let Some(budget) = options.target_batch_time_ms {
                        batch_count(true, render.gpu_sample_ms, budget, target - render.samples)
                            .min(batch)
                    } else {
                        batch.min(target - render.samples)
                    };
                    submit(render, count)?;
                }
                Ok((render.samples, render.samples >= target))
            })?;
            if samples != reported {
                reported = samples;
                if let Some(progress) = options.on_progress.as_mut() {
                    progress(ConvergeProgress {
                        stage: ConvergeStage::Final,
                        samples,
                        target_samples: target,
                    });
                }
            }
            if done {
                break;
            }
            std::thread::sleep(Duration::from_micros(100));
        }
        loop {
            let captured = self.with(|state, id| {
                check(state)?;
                capture(state.renders.get_mut(&id).unwrap())
            })?;
            if captured {
                break;
            }
            std::thread::sleep(Duration::from_micros(200));
        }
        let filtering = self.with(|state, id| Ok(state.renders[&id].denoise.options.is_some()))?;
        if filtering {
            if let Some(progress) = options.on_progress.as_mut() {
                progress(ConvergeProgress {
                    stage: ConvergeStage::Denoising,
                    samples: target,
                    target_samples: target,
                });
            }
            loop {
                self.engine.poll_device();
                let done = self.with(|state, id| {
                    check(state)?;
                    denoise(state, id, true)?;
                    let render = &state.renders[&id];
                    if let Some(message) =
                        render.denoise.report.as_ref().and_then(|r| r.error.clone())
                    {
                        return Err(error(Status::Error, message));
                    }
                    Ok(render.denoise.options.is_none()
                        || denoised_samples(render) == render.samples)
                });
                match done {
                    Ok(true) => break,
                    Ok(false) => std::thread::sleep(Duration::from_millis(2)),
                    Err(e) => {
                        let _ = self.with(|state, id| {
                            let r = state.renders.get_mut(&id).unwrap();
                            r.denoise.cancel.cancel();
                            if let Some(status) = r.denoise.frame_status.take() {
                                status.reject();
                            }
                            r.denoise.worker = None;
                            Ok(())
                        });
                        return Err(e);
                    }
                }
            }
        }
        Ok(ConvergeResult { samples: target })
    }
    /// Borrows an output texture without CPU readback or waiting for another sample.
    /// `None` before a complete image; Display also needs a previous compose.
    /// A composed auxiliary image does not require a beauty sample.
    /// HDR resolves lazily and is independent of denoising. Textures support
    /// TEXTURE_BINDING and COPY_SRC; HDR is unfilterable unless the host enabled
    /// float32 filtering. Do not retain, write or destroy the handle. It is valid
    /// only until the next refine/converge, present/resize, restart, disposal or device loss.
    pub fn get_output_texture(&self, kind: super::OutputKind) -> Result<Option<wgpu::Texture>> {
        self.with(|state, id| {
            if kind == super::OutputKind::Display && state.display.processing {
                return Err(error(
                    Status::InvalidState,
                    "Display composition is already running",
                ));
            }
            if kind == super::OutputKind::Display
                && state.display.settings.channel.aov_kind().is_some()
            {
                if !display_readiness(state, id).complete {
                    return Ok(None);
                }
                return Ok(state.renders[&id]
                    .output
                    .latest
                    .as_ref()
                    .and_then(|(_, image)| image.clone()));
            }
            if !readiness(state, id).complete {
                return Ok(None);
            }
            let render = state.renders.get_mut(&id).unwrap();
            let capture = render.capture.as_mut().unwrap();
            match kind {
                super::OutputKind::Hdr => Ok(Some(capture.hdr_texture())),
                super::OutputKind::Display => match &render.output.latest {
                    None => Ok(None),
                    Some((settings, image)) => {
                        Ok(Some(image.clone().unwrap_or_else(|| {
                            capture.compose_straight(&settings.composition())
                        })))
                    }
                },
            }
        })
    }
    /// Waits for the in-flight batch, then reads this render's RGBA image
    /// (u32 for Id, f32 otherwise), top row first. During preparation it reads the previous image.
    /// HDR uses the TS WebGPU readback semantics of [`PixelKind::Hdr`]; L0 keeps
    /// raw per-sample averages. HDR temporarily reads 48 GPU bytes per pixel.
    pub fn read_pixels(&self, kind: PixelKind) -> Result<Image> {
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            for event in drain(render)? {
                state.sample_events.push((id, event));
            }
            if let Some(code) = match kind {
                PixelKind::Depth => Some(4),
                PixelKind::Position => Some(5),
                PixelKind::Roughness => Some(6),
                PixelKind::DiffuseAlbedo => Some(7),
                PixelKind::SpecularAlbedo => Some(8),
                PixelKind::Id => Some(9),
                PixelKind::Motion => Some(10),
                _ => None,
            } {
                let render = state.renders.get_mut(&id).unwrap();
                if render.settings.aovs & (1 << (code - 4)) == 0 {
                    return Err(error(Status::InvalidState, "Requested AOV is not enabled"));
                }
                update_aovs(render)?;
                return render
                    .aov
                    .as_ref()
                    .ok_or_else(|| error(Status::InvalidState, "AOV output is not ready"))?
                    .read(code)
                    .map_err(|e| error(Status::Error, e.to_string()));
            }
            let render = &state.renders[&id];
            if kind == PixelKind::Denoised {
                if let Some((_, pixels)) = &render.denoise.denoised {
                    {
                        let [width, height] = context_size(render.context)?;
                        let pixels = match pixels {
                            DenoisedImage::Cpu(pixels, _) => pixels.clone(),
                            DenoisedImage::DisplayGpu { pixels: buffer, .. }
                            | DenoisedImage::Gpu { pixels: buffer, .. }
                            | DenoisedImage::Resident(super::GpuDenoiseOutput { buffer, .. }) => {
                                bytemuck::pod_collect_to_vec(
                                    &crate::read_average(
                                        &state.gpu.device,
                                        &state.gpu.queue,
                                        buffer,
                                        width,
                                        height,
                                        1,
                                    )
                                    .map_err(|e| error(Status::Error, e.to_string()))?,
                                )
                            }
                        };
                        return Ok(Image {
                            width,
                            height,
                            data: if render.denoise.display {
                                pixels
                            } else {
                                flip_rows(&pixels, width, height)
                            },
                            id_data: None,
                        });
                    }
                }
            }
            let code = match kind {
                PixelKind::Hdr | PixelKind::Denoised => 0,
                PixelKind::Normal => 1,
                PixelKind::Albedo => 2,
                _ => unreachable!(),
            };
            let [width, height] = context_size(render.context)?;
            let data = if code == 0 {
                context_blocking(|| context::read_hdr(render.context))?
            } else {
                context_blocking(|| context::read_pixels(render.context, code))?
            };
            Ok(Image {
                width,
                height,
                data: flip_rows(&data, width, height),
                id_data: None,
            })
        })
    }
    /// Accounts a finished batch and captures it without submitting another, so a
    /// host can present the last frame before committing new input. Returns
    /// whether no batch is in flight. Does not wait for the GPU.
    pub fn collect(&self) -> Result<bool> {
        self.with(|state, id| collect(state, id))
    }
    /// Filters the complete samples now without tracing, whatever the denoise
    /// schedule, like the browser's filter at the end of `converge`; a host calls
    /// it while it stops refining (for example when paused). Collects a finished
    /// batch first. CPU filters run on a library thread; oidn-webgpu runs on the
    /// rendering queue. Call again to collect the result and present it. Returns whether the
    /// denoised image is of the current samples. Needs a denoiser
    /// ([`Render::set_denoiser`] or [`Render::set_custom_denoiser`]). CPU filter
    /// input readback and first-use GPU filter preparation may block; the call
    /// does not wait for filtering to complete.
    pub fn denoise_current(&self) -> Result<bool> {
        self.with(|state, id| {
            if state.renders[&id].denoise.options.is_none() || !collect(state, id)? {
                return Ok(false);
            }
            denoise(state, id, true)?;
            let render = &state.renders[&id];
            Ok(render.samples > 0 && denoised_samples(render) == render.samples)
        })
    }
    /// Discards this render's auxiliary samples without changing beauty or
    /// denoising. The next auxiliary RenderLoop tick samples them again.
    pub fn restart_aovs(&self) -> Result<()> {
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            render.aov = None;
            render.output.invalidate();
            Ok(())
        })
    }
    /// Discards only this render's accumulation and denoised image.
    pub fn restart(&self) -> Result<()> {
        self.with(|state, id| {
            let render = state.renders.get_mut(&id).unwrap();
            if let Some(flight) = render.job.as_mut() {
                flight.cancelled = true;
                let job = flight.job;
                let _ = context_result(context::cancel_job(job));
            }
            drain(render)?;
            if render.published.is_some() {
                let context = render.context;
                context_blocking(|| context::reset(context))?;
                let key = render.published.clone().unwrap();
                render.publish(key, false);
                render.capture_key = None;
            }
            Ok(())
        })
    }
    /// Discards temporal filter history at a camera cut; leaves beauty samples intact.
    pub fn reset_temporal_history(&self) -> Result<()> {
        self.with(|state, id| {
            if let Some(temporal) = &mut state.renders.get_mut(&id).unwrap().temporal {
                temporal.reset();
            }
            Ok(())
        })
    }
    /// Complete samples of the enabled auxiliary outputs for the current scene
    /// and camera. Default 0; independent of beauty samples and denoising.
    pub fn aov_samples_rendered(&self) -> u32 {
        self.get(|state, r| {
            aov_samples(
                r,
                r.settings.aovs,
                state.scene_revision,
                state.camera_revision,
            )
        })
        .unwrap_or(0)
    }
    /// Complete beauty samples of the current inputs; 0 while preparing or stale.
    pub fn samples(&self) -> u32 {
        self.get(|state, r| {
            if r.current(state.scene_revision, state.camera_revision) {
                r.samples
            } else {
                0
            }
        })
        .unwrap_or(0)
    }
    /// `Compiling` while the engine compiles a path-tracing pipeline, `Idle`
    /// without a scene, `Preparing` until the current scene and camera are
    /// published, then the render's own status.
    pub fn status(&self) -> RenderStatus {
        if self
            .engine
            .inner
            .gpu
            .compilation
            .active
            .load(Ordering::Acquire)
            > 0
        {
            return RenderStatus::Compiling;
        }
        self.get(|state, r| {
            if r.error {
                RenderStatus::Error
            } else if state.scene.is_none() {
                RenderStatus::Idle
            } else if !r.current(state.scene_revision, state.camera_revision) {
                RenderStatus::Preparing
            } else {
                r.status
            }
        })
        .unwrap_or(RenderStatus::Error)
    }
    /// CPU snapshot; completed samples update when work is collected, not on query.
    pub fn diagnostics(&self) -> Option<super::RenderDiagnostics> {
        self.get(|state, r| r.diagnostics(self.id, state.scene_revision, state.camera_revision))
    }
    /// Actual width of the published image, else the requested width.
    pub fn width(&self) -> u32 {
        self.size()[0]
    }
    /// Actual height of the published image, else the requested height.
    pub fn height(&self) -> u32 {
        self.size()[1]
    }
    fn size(&self) -> [u32; 2] {
        self.get(|state, r| {
            r.published
                .as_ref()
                .map(|k| k.size)
                .unwrap_or_else(|| r.settings.resolve_size(state.display.size))
        })
        .unwrap_or([0, 0])
    }
    /// Whether the current scene and camera reached `max_samples`.
    pub fn converged(&self) -> bool {
        self.get(|state, r| {
            !state.device_failed
                && r.current(state.scene_revision, state.camera_revision)
                && r.samples >= r.settings.max_samples
        })
        .unwrap_or(false)
    }
    /// The last finished denoising run of this render's current inputs.
    pub fn denoise_report(&self) -> Option<DenoiseReport> {
        self.get(|_, r| r.denoise.report.clone()).flatten()
    }
    /// Built-in denoiser configuration; None for custom filtering or disabled denoising.
    pub fn denoiser(&self) -> Option<DenoiserOptions> {
        self.get(|_, r| {
            if r.denoise.custom.0.is_none() {
                r.denoise.options.clone()
            } else {
                None
            }
        })
        .flatten()
    }
    /// Active schedule for built-in or custom filtering. Default None.
    pub fn denoise_schedule(&self) -> Option<DenoiseSchedule> {
        self.get(|_, r| r.denoise.options.as_ref().map(|o| o.schedule))
            .flatten()
    }
    pub(super) fn denoiser_revision(&self) -> u64 {
        self.get(|_, r| r.denoiser_revision).unwrap_or(0)
    }
    /// The intersection backend actually used by the published scene and, for
    /// a software fallback of a hardware engine, the reason.
    pub fn backend(&self) -> Result<(super::Backend, String)> {
        self.with(|state, _| {
            let context = state
                .shared
                .context()
                .ok_or_else(|| error(Status::InvalidState, "No committed scene"))?;
            let (active, reason) = context_blocking(|| context::backend(context))?;
            let backend = if active == 1 {
                super::Backend::Hardware
            } else {
                super::Backend::Software
            };
            Ok((backend, reason))
        })
    }
    /// How the last successful commit reached the published scene, if any. The
    /// scene is shared by the engine's renders; render settings never commit it.
    pub fn last_commit(&self) -> Result<Option<CommitKind>> {
        self.with(|state, _| {
            let Some(context) = state.shared.context() else {
                return Ok(None);
            };
            let info = context_blocking(|| context::info(context))?;
            Ok(match info.last_commit {
                context::COMMIT_FULL => Some(CommitKind::Full),
                context::COMMIT_INCREMENTAL => Some(CommitKind::Incremental),
                _ => None,
            })
        })
    }
    /// Whether a denoiser is running on this render's samples.
    pub fn denoising(&self) -> bool {
        self.get(|_, r| r.denoise.worker.is_some()).unwrap_or(false)
    }
    /// Subscribes to completed beauty batches. Auxiliary samples are excluded.
    pub fn on_sample(&self, listener: impl FnMut(&SampleEvent) + Send + 'static) -> Subscription {
        self.engine.on_sample(self.id, listener)
    }
}
impl Drop for Render {
    fn drop(&mut self) {
        if !self.owned {
            return;
        }
        let removed = {
            let mut state = self.engine.lock();
            for render in state.renders.values_mut() {
                if render.fallback == Some(self.id) {
                    render.fallback = None;
                }
            }
            state.renders.remove(&self.id)
        };
        if let Some(render) = removed {
            render.release();
        }
    }
}

fn refine(state: &mut State, id: u64) -> Result<RenderStatus> {
    let Some(key) = desired(state, &state.renders[&id]) else {
        state.renders.get_mut(&id).unwrap().status = RenderStatus::Idle;
        return Ok(RenderStatus::Idle);
    };
    let ready = commit(state, id, key, false)?;
    // The fallback is refined while this render has no complete sample, including
    // while this render prepares.
    let render = &state.renders[&id];
    let can_complete = ready
        && render
            .sample_ms
            .is_some_and(|ms| ms <= render.settings.time_budget_ms);
    if let Some(fallback) = render.fallback {
        if (!ready || render.samples == 0)
            && !can_complete
            && !readiness(state, fallback).complete
            && !state.renders[&fallback].busy
        {
            // A fallback failure is reported but never stops the primary render.
            if let Err(e) = refine_one(state, fallback) {
                state.renders.get_mut(&fallback).unwrap().error = true;
                state.report(e.message);
            }
        }
    }
    if !ready {
        // A failed commit preserves the previous accumulation. Keep its completed
        // batch, capture and sample events in sync even while the new inputs fail.
        if state.renders[&id].error {
            let render = state.renders.get_mut(&id).unwrap();
            for event in cancel_batch(render)? {
                state.sample_events.push((id, event));
            }
            capture(render)?;
        }
        let render = &state.renders[&id];
        return Ok(if render.error {
            RenderStatus::Error
        } else if state.gpu.compilation.active.load(Ordering::Acquire) > 0 {
            RenderStatus::Compiling
        } else {
            RenderStatus::Preparing
        });
    }
    // Collect the finished batch and start a due filter before tracing further;
    // samples may also have completed in read_pixels since the last refine.
    denoise(state, id, false)?;
    if state.renders[&id].denoise.worker.is_none() && collect(state, id)? {
        denoise(state, id, false)?;
        let render = state.renders.get_mut(&id).unwrap();
        if render.denoise.worker.is_none() {
            let limit = next_target(render);
            submit_toward(render, limit)?;
        }
    }
    let render = state.renders.get_mut(&id).unwrap();
    if render.denoise.worker.is_none() {
        render.adapt_resolution();
    }
    let converged = render.samples >= render.settings.max_samples;
    render.status = match (render.denoise.worker.is_some(), converged) {
        (true, true) => RenderStatus::Denoising,
        (false, true) => RenderStatus::Finished,
        _ => RenderStatus::Converging,
    };
    Ok(render.status)
}
/// One sample of a fallback render.
fn refine_one(state: &mut State, id: u64) -> Result<()> {
    let Some(key) = desired(state, &state.renders[&id]) else {
        return Ok(());
    };
    if commit(state, id, key, false)? {
        advance(state, id, 1)?;
        state.renders.get_mut(&id).unwrap().adapt_resolution();
    }
    Ok(())
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    use crate::api::test_support::l0_blocking;
    use crate::api::{Backend, PixelKind, tests::*};

    /// Queue without dispatch, or finish exactly `dispatched` L0 samples without
    /// observing them in L1. No timing race decides which samples survive cancel.
    fn batch(render: &Render, dispatched: u32) {
        render
            .with(|state, id| {
                let r = state.renders.get_mut(&id).unwrap();
                let mut job = 0;
                l0_blocking(|e, n| unsafe {
                    context::mt_context_submit(r.context, 4, &mut job, e, n)
                })?;
                r.job = Some(Flight {
                    job,
                    count: 4,
                    started: Instant::now(),
                    cancelled: false,
                    scale: 1.,
                });
                if dispatched > 0 {
                    l0_blocking(|e, n| unsafe { context::mt_job_poll(job, dispatched, e, n) })?;
                    state
                        .gpu
                        .device
                        .poll(wgpu::PollType::wait_indefinitely())
                        .unwrap();
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn rejected_targets_retain_only_completed_cancelled_samples() {
        let _test = crate::ABI_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(engine) = software_engine(Backend::Software) else {
            return;
        };
        engine.display().set_size(16, 12).unwrap();
        engine.set_scene(&lit_scene()).unwrap();
        engine.update().unwrap();
        for dispatched in [0, 1, 4] {
            let settings = RenderSettings {
                max_samples: 1,
                ..Default::default()
            };
            let render = Render::new(&engine, settings.clone()).unwrap();
            render.converge(ConvergeOptions::new(1)).unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let observed = events.clone();
            let _subscription =
                render.on_sample(move |event| observed.lock().unwrap().push(event.clone()));
            batch(&render, dispatched);
            render
                .set_settings(RenderSettings {
                    size: RenderSize::Fixed {
                        width: 9000,
                        height: 4,
                    },
                    ..settings.clone()
                })
                .unwrap();
            assert_eq!(render.refine().unwrap(), RenderStatus::Error);
            let retained = 1 + dispatched;
            assert_eq!(render.samples(), retained);
            assert_eq!(
                context_blocking(|| context::info(engine.lock().renders[&render.id()].context))
                    .unwrap()
                    .samples,
                retained
            );
            let image = render.read_pixels(PixelKind::Hdr).unwrap();
            assert_eq!([image.width, image.height], [16, 12]);
            let presented = engine.display().present(&render).unwrap().unwrap();
            assert_eq!(presented.samples, retained);
            assert!(!presented.fallback);
            assert_eq!(render.refine().unwrap(), RenderStatus::Error);
            let observed = events.lock().unwrap();
            assert_eq!(observed.len(), usize::from(dispatched > 0));
            if dispatched > 0 {
                assert_eq!(observed[0].samples, retained);
                assert!(!observed[0].is_first_frame);
            }
            drop(observed);
            // A successful new target resets the old cancelled batch exactly once.
            batch(&render, 4);
            let previous_events = events.lock().unwrap().len();
            render
                .set_settings(RenderSettings {
                    seed: 7,
                    ..settings
                })
                .unwrap();
            engine.update().unwrap();
            assert_eq!(render.samples(), 0);
            assert_eq!(events.lock().unwrap().len(), previous_events);
            assert_eq!(
                context_blocking(|| context::info(engine.lock().renders[&render.id()].context))
                    .unwrap()
                    .samples,
                0
            );
            render.converge(ConvergeOptions::new(1)).unwrap();
            assert_eq!(render.samples(), 1);
            assert_eq!(events.lock().unwrap().last().unwrap().samples, 1);
            assert!(events.lock().unwrap().last().unwrap().is_first_frame);
        }
    }
    #[test]
    fn rejected_scenes_keep_previous_batch_capture_and_events() {
        let _test = crate::ABI_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(engine) = software_engine(Backend::Software) else {
            return;
        };
        engine.display().set_size(16, 12).unwrap();
        let scene = lit_scene();
        for dispatched in [0, 1, 4] {
            engine.set_scene(&scene).unwrap();
            engine.update().unwrap();
            let render = Render::new(&engine, RenderSettings::default()).unwrap();
            render.converge(ConvergeOptions::new(1)).unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let observed = events.clone();
            let _subscription =
                render.on_sample(move |event| observed.lock().unwrap().push(event.clone()));
            batch(&render, dispatched);
            let mut broken = scene.clone();
            broken[44 * 4..45 * 4].copy_from_slice(&9u32.to_le_bytes());
            engine.set_scene(&broken).unwrap();
            engine.update().unwrap();
            assert_eq!(finish(&render), RenderStatus::Error);
            // Public samples are zero for stale inputs, but the readable previous
            // image and its capture still describe the retained accumulation.
            assert_eq!(render.samples(), 0);
            let state = engine.lock();
            let r = &state.renders[&render.id()];
            assert_eq!(r.samples, 1 + dispatched);
            assert_eq!(r.captured, r.samples);
            assert_eq!(
                context_blocking(|| context::info(r.context))
                    .unwrap()
                    .samples,
                r.samples
            );
            drop(state);
            assert_eq!(
                render.read_pixels(PixelKind::Hdr).unwrap().data.len(),
                16 * 12 * 4
            );
            assert_eq!(render.refine().unwrap(), RenderStatus::Error);
            assert_eq!(events.lock().unwrap().len(), usize::from(dispatched > 0));
        }
    }

    #[test]
    fn converge_target_failure_captures_retained_samples_once() {
        let _test = crate::ABI_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(engine) = software_engine(Backend::Software) else {
            return;
        };
        engine.display().set_size(16, 12).unwrap();
        engine.set_scene(&lit_scene()).unwrap();
        engine.update().unwrap();
        let render = Render::new(&engine, RenderSettings::default()).unwrap();
        render.converge(ConvergeOptions::new(1)).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = events.clone();
        let _subscription =
            render.on_sample(move |event| observed.lock().unwrap().push(event.samples));
        batch(&render, 4);
        render
            .set_settings(RenderSettings {
                size: RenderSize::Fixed {
                    width: 9000,
                    height: 4,
                },
                ..Default::default()
            })
            .unwrap();
        assert!(render.converge(ConvergeOptions::new(8)).is_err());
        assert_eq!(render.samples(), 5);
        assert_eq!(
            engine.display().present(&render).unwrap().unwrap().samples,
            5
        );
        assert_eq!(*events.lock().unwrap(), vec![5]);
        assert_eq!(render.refine().unwrap(), RenderStatus::Error);
        assert_eq!(*events.lock().unwrap(), vec![5]);
    }
}

#[cfg(test)]
mod oidn_webgpu_tests {
    use super::*;
    use crate::api::{Backend, PixelKind, tests::*};
    #[test]
    #[ignore = "requires real GPU inference with oidn-webgpu-native"]
    fn gpu_schedules_reuse_program_resize_and_discard_lost_device_results() {
        let _test = crate::ABI_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let engine = Engine::new(super::super::EngineOptions {
            backend: Backend::Software,
        })
        .unwrap();
        engine.set_scene(&lit_scene()).unwrap();
        engine.update().unwrap();
        for (schedule, expected) in [
            (DenoiseSchedule::Progressive, vec![1, 4, 8]),
            (DenoiseSchedule::EverySample, vec![1, 2, 3]),
        ] {
            let settings = RenderSettings {
                max_samples: *expected.last().unwrap(),
                size: RenderSize::Fixed {
                    width: 17,
                    height: 13,
                },
                ..Default::default()
            };
            let render = Render::new(&engine, settings.clone()).unwrap();
            render
                .set_denoiser(Some(DenoiserOptions {
                    backend: 5,
                    schedule,
                    max_tile_size: 16,
                    ..Default::default()
                }))
                .unwrap();
            let mut seen = Vec::new();
            let mut identity = None;
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                render.refine().unwrap();
                if let Some(report) = render.denoise_report() {
                    assert!(report.error.is_none(), "{report:?}");
                    if seen.last() != Some(&report.samples) {
                        seen.push(report.samples);
                        let state = engine.lock();
                        let r = &state.renders[&render.id()];
                        let Some((_, DenoisedImage::Gpu { pixels, .. })) = &r.denoise.denoised
                        else {
                            panic!("CPU result");
                        };
                        let program = r.denoise.gpu_filter.as_ref().unwrap().program_identity();
                        if let Some(previous) = &identity {
                            assert_eq!(previous, &program, "same-size program was rebuilt");
                        } else {
                            identity = Some(program);
                        }
                        assert!(pixels.usage().contains(wgpu::BufferUsages::COPY_SRC));
                        assert_eq!(r.display_uploads(), (0, true));
                    }
                }
                if render.status() == RenderStatus::Finished {
                    break;
                }
                assert!(Instant::now() < deadline, "GPU schedule timed out");
                std::thread::yield_now();
            }
            assert_eq!(seen, expected);
            let raw = render.read_pixels(PixelKind::Hdr).unwrap();
            let filtered = render.read_pixels(PixelKind::Denoised).unwrap();
            assert!(filtered.data.iter().all(|v| v.is_finite()));
            assert_ne!(raw.data, filtered.data);
            assert!(
                raw.data
                    .chunks_exact(4)
                    .zip(filtered.data.chunks_exact(4))
                    .all(|(a, b)| a[3] == b[3])
            );
            // New scene/camera publications can replace target buffers at the same
            // dimensions. Normalization must rebind them without recording again.
            render.restart().unwrap();
            render.converge(ConvergeOptions::new(1)).unwrap();
            let state = engine.lock();
            let Some((_, DenoisedImage::Gpu { .. })) =
                &state.renders[&render.id()].denoise.denoised
            else {
                panic!();
            };
            assert_eq!(
                identity.as_ref().unwrap(),
                &state.renders[&render.id()]
                    .denoise
                    .gpu_filter
                    .as_ref()
                    .unwrap()
                    .program_identity()
            );
            drop(state);
            render
                .set_settings(RenderSettings {
                    size: RenderSize::Fixed {
                        width: 33,
                        height: 19,
                    },
                    ..settings
                })
                .unwrap();
            render.converge(ConvergeOptions::new(1)).unwrap();
            let state = engine.lock();
            let r = &state.renders[&render.id()];
            assert_eq!(r.denoise.gpu_filter.as_ref().unwrap().size(), [33, 19]);
            let Some((_, DenoisedImage::Gpu { .. })) = &r.denoise.denoised else {
                panic!();
            };
            assert_ne!(
                identity.as_ref().unwrap(),
                &r.denoise.gpu_filter.as_ref().unwrap().program_identity()
            );
            drop(state);
            // Lose the device with a denoise completion still uncollected.
            if schedule == DenoiseSchedule::EverySample {
                render.restart().unwrap();
                render
                    .with(|state, id| {
                        advance(state, id, 1)?;
                        let r = state.renders.get_mut(&id).unwrap();
                        drain(r)?;
                        capture(r)?;
                        cancel_denoise(state.renders.get_mut(&id).unwrap());
                        denoise(state, id, true)?;
                        assert!(state.renders[&id].denoise.worker.is_some());
                        Ok(())
                    })
                    .unwrap();
                engine.device_loss_notifier().notify("denoiser test loss");
                assert_eq!(
                    render.denoise_current().unwrap_err().status,
                    Status::Unavailable
                );
                let state = engine.lock();
                let r = &state.renders[&render.id()];
                assert!(
                    r.denoise.denoised.is_none()
                        && r.denoise.gpu_filter.is_none()
                        && r.denoise.worker.is_none()
                );
            }
        }
    }
}

#[cfg(test)]
mod batching_tests {
    use super::*;
    #[test]
    fn batch_budget_requires_gpu_measurement_and_caps_queue_and_remaining_samples() {
        assert_eq!(batch_count(true, None, 4., 100), 1);
        assert_eq!(batch_count(false, Some(0.1), 4., 100), 1);
        assert_eq!(batch_count(true, Some(0.1), 4., 100), 40);
        assert_eq!(batch_count(true, Some(0.01), 4., 100), 64);
        assert_eq!(batch_count(true, Some(0.1), 4., 7), 7);
        assert_eq!(batch_count(true, Some(9.), 4., 100), 1);
        for ms in [0., f64::NAN, f64::INFINITY] {
            assert_eq!(batch_count(true, Some(ms), 4., 100), 1);
        }
        for ms in [0., -1., f64::NAN, f64::INFINITY] {
            assert!(
                RefineOptions {
                    target_batch_time_ms: Some(ms),
                    ..Default::default()
                }
                .validate()
                .is_err()
            );
        }
        assert!(RefineOptions::default().validate().is_ok());
    }
}

#[cfg(test)]
#[path = "display_oidn_tests.rs"]
mod display_oidn_tests;

#[cfg(test)]
include!("display_schedule_tests.rs");
