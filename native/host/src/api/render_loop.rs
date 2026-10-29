//! Interactive preview/final policy over the L1 API, ported from the browser
//! `RenderLoop._tick` and `progressiveScheduler.ts`. The host drives it: call
//! [`RenderLoop::tick`] once per frame while [`RenderLoop::needs_tick`] is true,
//! and after editing engine inputs, render settings or the display.
use super::display::DisplaySettings;
use super::engine::Engine;
use super::render::{ConvergeOptions, ConvergeResult, ConvergeStage, RefineOptions, SampleEvent};
use super::{Display, Render, RenderSettings, RenderSize, RenderStatus, Result, Status, error};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

/// Presentation state; preview images never count as final completion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderLoopStatus {
    Idle,
    Preparing,
    Compiling,
    Converging,
    Denoising,
    Finished,
    Error,
    /// The display shows a preview image.
    Previewing,
}
impl From<RenderStatus> for RenderLoopStatus {
    fn from(status: RenderStatus) -> Self {
        match status {
            RenderStatus::Idle => Self::Idle,
            RenderStatus::Preparing => Self::Preparing,
            RenderStatus::Compiling => Self::Compiling,
            RenderStatus::Converging => Self::Converging,
            RenderStatus::Denoising => Self::Denoising,
            RenderStatus::Finished => Self::Finished,
            RenderStatus::Error => Self::Error,
        }
    }
}

/// Activity state embedded in a [`LoopSync`] implementation.
#[derive(Clone, Copy, Debug, Default)]
pub struct SyncActivity {
    active: bool,
    until: Option<Instant>,
}
impl SyncActivity {
    /// Whether the sync is active: set active, or inside an
    /// [`SyncActivity::activate_for`] window.
    pub fn active(&self) -> bool {
        self.active || self.until.is_some_and(|until| Instant::now() < until)
    }
    /// Marks the sync active until set inactive, for example during a drag.
    pub fn set_active(&mut self, active: bool) {
        self.active = active;
    }
    /// Keeps the sync active for `duration` from now, extending a longer window.
    pub fn activate_for(&mut self, duration: Duration) {
        let until = Instant::now() + duration;
        self.until = Some(self.until.map_or(until, |current| current.max(until)));
    }
    /// Clears the active flag and any timed window.
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}
/// External scene, camera or interaction source. `update` writes the latest
/// state to the engine before each tick's commit; activity marks motion.
pub trait LoopSync: Send {
    /// Writes the latest external state to the engine before its commit.
    fn update(&mut self);
    fn activity(&self) -> &SyncActivity;
    fn activity_mut(&mut self) -> &mut SyncActivity;
    /// Whether this source expects further changes. Default false.
    fn active(&self) -> bool {
        self.activity().active()
    }
    /// Marks an ongoing interaction. Default false.
    fn set_active(&mut self, active: bool) {
        self.activity_mut().set_active(active);
    }
    /// Extends activity for the given duration.
    fn activate_for(&mut self, duration: Duration) {
        self.activity_mut().activate_for(duration);
    }
    /// Releases external subscriptions. The default clears activity.
    fn dispose(&mut self) {
        self.activity_mut().clear();
    }
}
/// A sync shared between the loop and the code that marks its activity.
pub type SharedSync = Arc<Mutex<dyn LoopSync>>;

/// Which render the loop refines this tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Selection {
    Preview,
    Final,
}
/// Input of [`RenderLoopOptions::select`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectInfo {
    pub changing: bool,
}
/// The default policy: preview while changing, otherwise final.
pub fn select_default(info: SelectInfo) -> Selection {
    if info.changing {
        Selection::Preview
    } else {
        Selection::Final
    }
}
/// A render the loop creates from settings, or one supplied by the caller.
pub enum LoopRender {
    /// The loop's defaults: [`RenderLoop::preview_settings`] for the preview,
    /// `RenderSettings::default()` for the final render.
    Default,
    Settings(RenderSettings),
    /// A caller-owned render on the same engine; the loop never changes its fallback.
    Render(Arc<Render>),
}
/// Loop creation options.
pub struct RenderLoopOptions {
    /// Default the engine display.
    pub display: Option<Display>,
    /// Preview render, or `None` to disable. Default `Some(LoopRender::Default)`,
    /// the browser preview defaults ([`RenderLoop::preview_settings`]).
    pub preview: Option<LoopRender>,
    /// Default a new render whose fallback is the preview.
    pub final_render: LoopRender,
    /// Integrations, updated in order. Default none.
    pub syncs: Vec<SharedSync>,
    /// Idle delay for consecutive edits without explicit sync activity. Default 150 ms.
    pub idle_ms: f64,
    /// Hold preview inference before committing the latest camera/scene. Default false.
    pub coalesce_scene_updates: bool,
    /// Selection policy. Default [`select_default`].
    pub select: Option<Box<dyn FnMut(SelectInfo) -> Selection + Send>>,
}
impl Default for RenderLoopOptions {
    fn default() -> Self {
        Self {
            display: None,
            preview: Some(LoopRender::Default),
            final_render: LoopRender::Default,
            syncs: Vec::new(),
            idle_ms: 150.,
            coalesce_scene_updates: false,
            select: None,
        }
    }
}

/// Consecutive-edit policy: isolated changes start final immediately.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub(super) struct ProgressiveState {
    pub(super) previous_changed: bool,
    pub(super) last_continuous_change: Option<Instant>,
    pub(super) changing: bool,
}
impl ProgressiveState {
    /// Browser `updateProgressiveState`.
    pub(super) fn update(self, changed: bool, active: bool, now: Instant, idle_ms: f64) -> Self {
        let last_continuous_change = if active {
            None
        } else if changed && self.previous_changed {
            Some(now)
        } else {
            self.last_continuous_change
        };
        let idle = Duration::try_from_secs_f64(idle_ms.max(0.) / 1e3).unwrap_or(Duration::MAX);
        Self {
            previous_changed: changed && !active,
            last_continuous_change,
            changing: active
                || last_continuous_change.is_some_and(|last| now.duration_since(last) < idle),
        }
    }
}
/// Browser `loopImageState`: the final image's inputs, to leave a finished loop
/// idle while still noticing settings and display edits.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ImageState {
    samples: u32,
    size: [u32; 2],
    settings: RenderSettings,
    denoiser_revision: u64,
    denoising: bool,
    display_size: [u32; 2],
    display: DisplaySettings,
    pass_revision: u64,
}
fn image_state(render: &Render, display: &Display) -> Result<ImageState> {
    Ok(ImageState {
        samples: render.display_samples(),
        size: [render.width(), render.height()],
        settings: render.settings()?,
        denoiser_revision: render.denoiser_revision(),
        denoising: render.denoising() && display.settings().channel.aov_kind().is_none(),
        display_size: display.size(),
        display: display.settings(),
        pass_revision: render.engine().lock().display.pass_revision,
    })
}
/// Pending-preview decision at the start of a tick (browser `_tick` prologue).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(super) struct PreviewFrame {
    /// A presentation waits for a preview frame.
    pub(super) pending: bool,
    /// The preview is tracing its first sample.
    pub(super) tracing: bool,
    /// Skip the commit and keep finishing the preview frame.
    pub(super) holding: bool,
}
pub(super) fn preview_frame(
    owner_is_preview: bool,
    owner_complete: Option<bool>,
    preview: Option<(RenderStatus, u32, bool)>,
    coalesce: bool,
) -> PreviewFrame {
    let pending = owner_complete.is_some_and(|complete| owner_is_preview || !complete);
    let tracing = pending
        && preview
            .is_some_and(|(status, samples, _)| status == RenderStatus::Converging && samples == 0);
    let holding =
        tracing || (coalesce && pending && preview.is_some_and(|(_, _, denoising)| denoising));
    PreviewFrame {
        pending,
        tracing,
        holding,
    }
}
/// Whether presentation of `current` waits for a complete preview frame.
#[allow(clippy::too_many_arguments)]
pub(super) fn waits_for_preview(
    has_preview: bool,
    current_is_preview: bool,
    status: RenderStatus,
    current_samples: u32,
    coalesce: bool,
    preview_denoising: bool,
    current_complete: bool,
    current_fallback_is_preview: bool,
) -> bool {
    has_preview
        && ((current_is_preview && status == RenderStatus::Converging && current_samples == 0)
            || (coalesce && preview_denoising))
        && (current_is_preview || (!current_complete && current_fallback_is_preview))
}
/// The loop status after refining: errors win, then preview presentation.
pub(super) fn loop_status(status: RenderStatus, previewing: bool) -> RenderLoopStatus {
    if status == RenderStatus::Error {
        RenderLoopStatus::Error
    } else if previewing {
        RenderLoopStatus::Previewing
    } else {
        status.into()
    }
}

type StatusListener = Arc<Mutex<dyn FnMut(RenderLoopStatus, RenderLoopStatus) + Send>>;
type SampleListener = Arc<Mutex<dyn FnMut(&SampleEvent) + Send>>;
#[derive(Default)]
struct Listeners {
    next: u64,
    status: Vec<(u64, StatusListener)>,
    samples: Vec<(u64, SampleListener)>,
}
struct Shared {
    status: RenderLoopStatus,
    listeners: Listeners,
}
/// Removes a loop callback when dropped; [`LoopSubscription::detach`] keeps it.
#[must_use = "dropping a LoopSubscription removes its callback"]
pub struct LoopSubscription {
    shared: Weak<Mutex<Shared>>,
    id: u64,
}
impl LoopSubscription {
    /// Keeps the callback registered for the loop's lifetime.
    pub fn detach(self) {
        std::mem::forget(self);
    }
}
impl Drop for LoopSubscription {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
            shared.listeners.status.retain(|(id, _)| *id != self.id);
            shared.listeners.samples.retain(|(id, _)| *id != self.id);
        }
    }
}
/// Updates the status and calls status listeners outside the lock. A listener
/// removed by an earlier callback of the same dispatch is skipped.
fn set_status(shared: &Mutex<Shared>, status: RenderLoopStatus) -> RenderLoopStatus {
    let (previous, listeners) = {
        let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
        if shared.status == status {
            return status;
        }
        let previous = std::mem::replace(&mut shared.status, status);
        (previous, shared.listeners.status.clone())
    };
    for (id, listener) in listeners {
        if registered(shared, |l| l.status.iter().any(|(i, _)| *i == id)) {
            (listener.lock().unwrap_or_else(|e| e.into_inner()))(status, previous);
        }
    }
    status
}
fn registered(shared: &Mutex<Shared>, test: impl FnOnce(&Listeners) -> bool) -> bool {
    test(&shared.lock().unwrap_or_else(|e| e.into_inner()).listeners)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MotionPhase {
    Moving,
    Priming,
    Settling,
    Settled,
}
#[derive(Clone, Copy)]
struct Motion {
    render: u64,
    phase: MotionPhase,
}
/// Built-in interactive policy implemented entirely through the L1 API.
/// Callbacks run on the ticking thread and must not call this loop.
pub struct RenderLoop {
    engine: Engine,
    display: Display,
    preview: Option<Arc<Render>>,
    final_render: Arc<Render>,
    syncs: Vec<SharedSync>,
    /// Heuristic idle delay in milliseconds.
    pub idle_ms: f64,
    /// Defer engine commits while preview inference is pending.
    pub coalesce_scene_updates: bool,
    select: Box<dyn FnMut(SelectInfo) -> Selection + Send>,
    policy: ProgressiveState,
    shared: Arc<Mutex<Shared>>,
    /// Render whose next presentation waits for a complete preview frame.
    preview_frame_owner: Option<u64>,
    presented: Option<u64>,
    finished_image: Option<ImageState>,
    last_presented: Option<super::Presented>,
    presentations: u64,
    refill_until: Option<Instant>,
    motion: Option<Motion>,
    _final_samples: super::Subscription,
}
impl RenderLoop {
    /// The browser preview defaults: half resolution adapting down to 1/8 for
    /// 80 ms frames, 80 ms budget, 2 bounces, no bevel, 1 wavelength, 2 light
    /// candidates.
    pub fn preview_settings() -> RenderSettings {
        RenderSettings {
            size: RenderSize::Scale(0.5),
            adaptive_resolution: Some(super::AdaptiveResolution {
                target_frame_ms: 80.,
                min_scale: 0.125,
            }),
            time_budget_ms: 80.,
            bounces: 2,
            bevel: false,
            dispersion_wavelengths: 1,
            direct_light_candidates: 2,
            ..Default::default()
        }
    }
    /// Creates a loop presenting to the engine's display. Renders passed in the
    /// options must belong to `engine`.
    pub fn new(engine: &Engine, options: RenderLoopOptions) -> Result<Self> {
        let same = |render: &Render| Arc::ptr_eq(&render.engine().inner, &engine.inner);
        for choice in options.preview.iter().chain([&options.final_render]) {
            if let LoopRender::Render(render) = choice {
                if !same(render) {
                    return Err(error(
                        Status::InvalidArgument,
                        "RenderLoop renders must belong to the same engine",
                    ));
                }
            }
        }
        let display = match options.display {
            Some(display) if !Arc::ptr_eq(&display.engine.inner, &engine.inner) => {
                return Err(error(
                    Status::InvalidArgument,
                    "RenderLoop display must belong to the same engine",
                ));
            }
            Some(display) => display,
            None => engine.display(),
        };
        let preview = match options.preview {
            None => None,
            Some(LoopRender::Render(render)) => Some(render),
            Some(LoopRender::Default) => {
                Some(Arc::new(Render::new(engine, Self::preview_settings())?))
            }
            Some(LoopRender::Settings(settings)) => Some(Arc::new(Render::new(engine, settings)?)),
        };
        let created = |settings: RenderSettings| -> Result<Arc<Render>> {
            let render = Render::new(engine, settings)?;
            render.set_fallback(preview.as_deref())?;
            Ok(Arc::new(render))
        };
        let final_render = match options.final_render {
            LoopRender::Render(render) => render,
            LoopRender::Default => created(RenderSettings::default())?,
            LoopRender::Settings(settings) => created(settings)?,
        };
        let shared = Arc::new(Mutex::new(Shared {
            status: RenderLoopStatus::Preparing,
            listeners: Listeners::default(),
        }));
        let forward = Arc::downgrade(&shared);
        let final_samples = final_render.on_sample(move |event| {
            let Some(shared) = forward.upgrade() else {
                return;
            };
            let listeners = shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .listeners
                .samples
                .clone();
            for (id, listener) in listeners {
                if registered(&shared, |l| l.samples.iter().any(|(i, _)| *i == id)) {
                    (listener.lock().unwrap_or_else(|e| e.into_inner()))(event);
                }
            }
        });
        let mut syncs: Vec<SharedSync> = Vec::new();
        for sync in options.syncs {
            if !syncs.iter().any(|s| same_sync(s, &sync)) {
                syncs.push(sync);
            }
        }
        Ok(Self {
            engine: engine.clone(),
            display,
            preview,
            final_render,
            syncs,
            idle_ms: options.idle_ms,
            coalesce_scene_updates: options.coalesce_scene_updates,
            select: options.select.unwrap_or_else(|| Box::new(select_default)),
            policy: ProgressiveState::default(),
            shared,
            preview_frame_owner: None,
            presented: None,
            finished_image: None,
            last_presented: None,
            presentations: 0,
            refill_until: None,
            motion: None,
            _final_samples: final_samples,
        })
    }
    #[cfg(test)]
    pub(super) fn presented(&self) -> Option<u64> {
        self.presented
    }
    /// The image the display shows since this loop's last successful presentation.
    pub fn last_presented(&self) -> Option<super::Presented> {
        self.last_presented
    }
    /// Source of this loop's last successful presentation, including fallback
    /// selection. Default `None`. Direct calls to [`Display::present`] do not
    /// update it; later input changes may restart this render's accumulation.
    pub fn presented_render(&self) -> Option<&Arc<Render>> {
        self.presented.map(|id| match &self.preview {
            Some(preview) if preview.id() == id => preview,
            _ => &self.final_render,
        })
    }
    /// Successful presentations by this loop, to tell when the display changed.
    pub fn presentations(&self) -> u64 {
        self.presentations
    }
    /// The preview render, if the loop has one.
    pub fn preview(&self) -> Option<&Arc<Render>> {
        self.preview.as_ref()
    }
    /// The final render.
    pub fn final_render(&self) -> &Arc<Render> {
        &self.final_render
    }
    /// The engine display this loop presents to.
    pub fn display(&self) -> &Display {
        &self.display
    }
    /// Replaces the selection policy.
    pub fn set_select(&mut self, select: impl FnMut(SelectInfo) -> Selection + Send + 'static) {
        self.select = Box::new(select);
    }
    /// Whether an explicit integration or consecutive edits indicate motion. Default false.
    pub fn changing(&self) -> bool {
        self.policy.changing
    }
    /// Complete final beauty samples; previews and auxiliary samples are excluded. Default 0.
    pub fn samples(&self) -> u32 {
        if self.status() == RenderLoopStatus::Previewing {
            0
        } else {
            self.final_render.samples()
        }
    }
    /// Current presented/execution state. Default `Preparing`.
    pub fn status(&self) -> RenderLoopStatus {
        if self.engine.check_device().is_err() {
            return RenderLoopStatus::Error;
        }
        self.shared.lock().unwrap_or_else(|e| e.into_inner()).status
    }
    /// Called with (status, previous) on every transition.
    pub fn on_status(
        &self,
        listener: impl FnMut(RenderLoopStatus, RenderLoopStatus) + Send + 'static,
    ) -> LoopSubscription {
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        shared.listeners.next += 1;
        let id = shared.listeners.next;
        shared
            .listeners
            .status
            .push((id, Arc::new(Mutex::new(listener))));
        LoopSubscription {
            shared: Arc::downgrade(&self.shared),
            id,
        }
    }
    /// Called for complete final beauty samples; preview and auxiliary samples are excluded.
    pub fn on_sample(
        &self,
        listener: impl FnMut(&SampleEvent) + Send + 'static,
    ) -> LoopSubscription {
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        shared.listeners.next += 1;
        let id = shared.listeners.next;
        shared
            .listeners
            .samples
            .push((id, Arc::new(Mutex::new(listener))));
        LoopSubscription {
            shared: Arc::downgrade(&self.shared),
            id,
        }
    }
    /// Adds an integration. Duplicate registrations are ignored.
    pub fn add_sync(&mut self, sync: SharedSync) {
        if !self.syncs.iter().any(|s| same_sync(s, &sync)) {
            self.syncs.push(sync);
        }
    }
    /// Removes an integration without disposing it.
    pub fn remove_sync(&mut self, sync: &SharedSync) {
        self.syncs.retain(|s| !same_sync(s, sync));
    }
    fn set_status(&self, status: RenderLoopStatus) -> RenderLoopStatus {
        set_status(&self.shared, status)
    }
    fn present(&mut self, render: &Render) -> Result<Option<u64>> {
        let presented = self.display.present(render)?;
        if presented.is_some() {
            self.last_presented = presented;
            self.presentations += 1;
        }
        let shown = presented.map(|presented| {
            if presented.fallback {
                render.fallback_id().unwrap_or(render.id())
            } else {
                render.id()
            }
        });
        if shown.is_some() {
            self.presented = shown;
        }
        Ok(shown)
    }
    fn render(&self, id: u64) -> &Render {
        match &self.preview {
            Some(preview) if preview.id() == id => preview,
            _ => &self.final_render,
        }
    }
    fn syncs_active(&self) -> bool {
        self.syncs
            .iter()
            .any(|sync| sync.lock().unwrap_or_else(|e| e.into_inner()).active())
    }
    /// Whether the host should schedule another tick. False only when the final
    /// image is finished for unchanged inputs and nothing is changing, or after an
    /// error. Call `tick` again after editing engine inputs, renders or the display
    /// even when this is false, and while a sync has new input. Device loss schedules
    /// one final tick to deliver its engine events before becoming idle.
    pub fn needs_tick(&self) -> bool {
        self.engine.poll_device();
        if self.engine.check_device().is_err() {
            let state = self.engine.lock();
            return !state.disposed && !state.engine_events.is_empty();
        }
        let status = self.status();
        if status == RenderLoopStatus::Idle {
            return self.engine.inputs_pending() || self.syncs_active() || self.window_pending();
        }
        if status == RenderLoopStatus::Error {
            return self.engine.inputs_pending() || self.syncs_active();
        }
        let idle = status == RenderLoopStatus::Finished
            && self.final_render.display_finished()
            && !self.policy.changing
            && self.preview_frame_owner.is_none()
            && self.motion.is_none_or(|m| m.phase == MotionPhase::Settled)
            && !self.engine.inputs_pending()
            && !self.syncs_active()
            && !self.display.passes_pending()
            && image_state(&self.final_render, &self.display).ok() == self.finished_image;
        !idle
    }
    fn window_pending(&self) -> bool {
        self.engine
            .lock()
            .display
            .surface
            .as_ref()
            .is_some_and(|s| s.pending())
    }
    /// One frame: updates syncs, commits engine inputs, refines the selected
    /// render and presents it. An attached window can block for frame acquisition
    /// or surface reconfiguration.
    pub fn tick(&mut self) -> Result<RenderLoopStatus> {
        self.cancel_refill();
        self.engine.poll_device();
        let result = self.tick_inner();
        if result.is_err() {
            self.set_status(RenderLoopStatus::Error);
        }
        self.engine.flush();
        result
    }
    fn tick_inner(&mut self) -> Result<RenderLoopStatus> {
        self.engine.check_device()?;
        for sync in &self.syncs {
            sync.lock().unwrap_or_else(|e| e.into_inner()).update();
        }
        if self.engine.empty_source() {
            self.engine.update()?;
            if self.window_pending() {
                self.display.present(&self.final_render)?;
            }
            self.preview_frame_owner = None;
            self.presented = None;
            self.finished_image = None;
            return Ok(self.set_status(RenderLoopStatus::Idle));
        }
        let preview_state = self.preview.as_ref().map(|p| {
            (
                p.status(),
                p.display_samples(),
                p.denoising() && self.display.settings().channel.aov_kind().is_none(),
            )
        });
        let owner = self.preview_frame_owner;
        let frame = preview_frame(
            owner.is_some_and(|o| self.preview.as_ref().is_some_and(|p| p.id() == o)),
            owner.map(|o| self.render(o).display_complete()),
            preview_state,
            self.coalesce_scene_updates,
        );
        // Inference belongs to a presentation, not merely to a background render.
        // A fallback result must never replace an already available final image.
        if frame.pending && !frame.holding {
            if let Some(preview) = self.preview.clone() {
                self.present(&preview)?;
            }
        }
        if !frame.holding {
            self.preview_frame_owner = None;
        }
        let changed = if frame.holding {
            false
        } else {
            self.engine.update()?
        };
        let active = self.syncs_active();
        self.policy = self
            .policy
            .update(changed, active, Instant::now(), self.idle_ms);
        let selected = (self.select)(SelectInfo {
            changing: self.policy.changing,
        });
        if frame.holding {
            if let Some(preview) = self.preview.clone() {
                // Finish this image against its committed camera while syncs collect
                // the latest input; restarting it on every edit starves presentation.
                if frame.tracing {
                    let status = preview.refine_display(
                        false,
                        RefineOptions {
                            batch_samples: Some(false),
                            target_batch_time_ms: Some(4.),
                            ..Default::default()
                        },
                    )?;
                    if status == RenderStatus::Error {
                        self.preview_frame_owner = None;
                        return Ok(self.set_status(RenderLoopStatus::Error));
                    }
                } else {
                    // Native filter completion is collected by the ticking
                    // thread. Merely polling the device leaves `denoising`
                    // true forever, holding both presentation and new inputs.
                    // Collect without tracing another stale-camera sample.
                    preview.denoise_current()?;
                }
                if (!self.coalesce_scene_updates
                    || !(preview.denoising()
                        && self.display.settings().channel.aov_kind().is_none()))
                    && self.present(&preview)?.is_some()
                {
                    self.preview_frame_owner = None;
                }
                return Ok(self.set_status(RenderLoopStatus::Previewing));
            }
        }
        let current = match (&self.preview, selected) {
            (Some(preview), Selection::Preview) => preview.clone(),
            _ => self.final_render.clone(),
        };
        let current_is_final = current.id() == self.final_render.id();
        let idle = !changed && !self.policy.changing;
        if self.display.settings().channel != super::Channel::Motion {
            self.motion = None;
        } else {
            self.motion = Some(match self.motion {
                None => Motion {
                    render: current.id(),
                    phase: MotionPhase::Moving,
                },
                Some(m) if m.render != current.id() => Motion {
                    render: current.id(),
                    phase: MotionPhase::Priming,
                },
                Some(mut m) => {
                    if (!idle && m.phase != MotionPhase::Priming)
                        || (!current.display_complete() && m.phase == MotionPhase::Settled)
                    {
                        m.phase = MotionPhase::Moving;
                    }
                    m
                }
            });
        }
        let state = image_state(&self.final_render, &self.display)?;
        let status = self.status();
        if !changed
            && !self.policy.changing
            && current_is_final
            && status == RenderLoopStatus::Finished
            && self.final_render.display_finished()
            && !self.display.passes_pending()
            && Some(&state) == self.finished_image.as_ref()
            && self.motion.is_none_or(|m| m.phase == MotionPhase::Settled)
        {
            return Ok(status);
        }
        // Show display-setting changes of a finished image before refining.
        if status == RenderLoopStatus::Finished
            && Some(&state) != self.finished_image.as_ref()
            && self.final_render.display_samples() > 0
        {
            let final_render = self.final_render.clone();
            self.present(&final_render)?;
        }
        if self.motion.is_some_and(|m| m.phase == MotionPhase::Moving)
            && idle
            && current.display_complete()
        {
            self.motion.as_mut().unwrap().phase = MotionPhase::Settling;
        }
        let options = RefineOptions {
            batch_samples: Some(
                current_is_final && !self.policy.changing && {
                    let settings = current.settings()?;
                    settings.batch_samples || settings.allow_multiple_samples_per_frame
                },
            ),
            target_batch_time_ms: Some(4.),
            ..Default::default()
        };
        let stationary_motion = self
            .motion
            .is_some_and(|m| matches!(m.phase, MotionPhase::Settling | MotionPhase::Settled));
        let mut refined = current.refine_display(stationary_motion, options)?;
        if self.motion.is_some_and(|m| m.phase == MotionPhase::Priming)
            && refined == RenderStatus::Finished
        {
            self.motion.as_mut().unwrap().phase = MotionPhase::Settling;
            refined = current.refine_display(true, options)?;
        }
        if self
            .motion
            .is_some_and(|m| m.phase == MotionPhase::Settling)
            && refined == RenderStatus::Finished
        {
            self.motion.as_mut().unwrap().phase = MotionPhase::Settled;
        }
        let preview_id = self.preview.as_ref().map(|p| p.id());
        let current_is_preview = Some(current.id()) == preview_id;
        // Keep the display on the last completed image while the next preview
        // frame traces; presenting now would show the fallback over it.
        let waiting = waits_for_preview(
            self.preview.is_some(),
            current_is_preview,
            refined,
            current.display_samples(),
            self.coalesce_scene_updates,
            self.preview.as_ref().is_some_and(|p| {
                p.denoising() && self.display.settings().channel.aov_kind().is_none()
            }),
            current.display_complete(),
            current.fallback_id().is_some() && current.fallback_id() == preview_id,
        );
        if waiting {
            self.preview_frame_owner = Some(current.id());
        } else {
            self.present(&current)?;
        }
        // Execution may already trace final samples while the display still shows
        // the preview; only a successful presentation transfers the image.
        let previewing = waiting
            || (current_is_preview
                && current.denoising()
                && self.display.settings().channel.aov_kind().is_none())
            || (preview_id.is_some() && self.presented == preview_id);
        let next = loop_status(refined, previewing);
        self.finished_image = (next == RenderLoopStatus::Finished)
            .then(|| image_state(&self.final_render, &self.display))
            .transpose()?;
        if self.display.settings().channel.aov_kind().is_none()
            && !changed
            && !self.policy.changing
            && current_is_final
            && !previewing
            && self.can_refill()
        {
            self.refill_until = Some(Instant::now() + Duration::from_millis(16));
        }
        Ok(self.set_status(next))
    }
    fn can_refill(&self) -> bool {
        let render = &self.final_render;
        render.settings().is_ok_and(|s| {
            (s.batch_samples || s.allow_multiple_samples_per_frame)
                && render
                    .gpu_sample_time_ms()
                    .is_some_and(|ms| ms <= s.time_budget_ms)
        }) && render.refill_ready()
            && !render.denoising()
            && render.samples() > 0
            && render.status() == RenderStatus::Converging
    }
    /// Cancels between-frame work without discarding samples. Hosts call this
    /// on pause, hiding/minimizing, export or when suspending their frame loop.
    pub fn cancel_refill(&mut self) {
        self.refill_until = None;
    }
    /// Whether a stationary beauty batch can be collected/refilled before
    /// the next frame. A tick grants at most 16 ms; input, activity, filtering,
    /// auxiliary output and custom preview selection revoke that grant.
    pub fn needs_refill(&self) -> bool {
        self.refill_until
            .is_some_and(|until| Instant::now() < until)
            && self.display.settings().channel.aov_kind().is_none()
            && !self.engine.inputs_pending()
            && !self.syncs_active()
            && self.can_refill()
    }
    /// Collects GPU completion and submits a final batch within the current
    /// tick's lease. Call on GPU completion on the same thread as `tick`. Does not
    /// update syncs, commit inputs or present. Returns whether the lease remains
    /// active. An expired/cancelled lease submits nothing.
    pub fn refill(&mut self) -> Result<bool> {
        if !self.needs_refill() || (self.select)(SelectInfo { changing: false }) != Selection::Final
        {
            self.cancel_refill();
            return Ok(false);
        }
        let status = self.final_render.refine_with_options(RefineOptions {
            target_batch_time_ms: Some(4.),
            defer_resolve: true,
            ..Default::default()
        })?;
        if status == RenderStatus::Error {
            self.cancel_refill();
            self.set_status(RenderLoopStatus::Error);
        }
        if !self.can_refill() {
            self.cancel_refill();
        }
        Ok(self.needs_refill())
    }
    /// Updates syncs, commits engine inputs, converges the final render (blocking)
    /// and presents it.
    pub fn converge(&mut self, mut options: ConvergeOptions) -> Result<ConvergeResult> {
        self.cancel_refill();
        self.preview_frame_owner = None;
        let result = (|| {
            for sync in &self.syncs {
                sync.lock().unwrap_or_else(|e| e.into_inner()).update();
            }
            self.engine.update()?;
            self.set_status(RenderLoopStatus::Preparing);
            let shared = self.shared.clone();
            let final_render = Arc::downgrade(&self.final_render);
            let mut user = options.on_progress.take();
            options.on_progress = Some(Box::new(move |progress| {
                let status = if progress.stage == ConvergeStage::Denoising {
                    RenderLoopStatus::Denoising
                } else {
                    final_render
                        .upgrade()
                        .map_or(RenderLoopStatus::Converging, |r| r.status().into())
                };
                set_status(&shared, status);
                if let Some(user) = user.as_mut() {
                    user(progress);
                }
            }));
            let result = self.final_render.converge(options)?;
            let final_render = self.final_render.clone();
            self.present(&final_render)?;
            self.set_status(RenderLoopStatus::Finished);
            Ok(result)
        })();
        if result.is_err() {
            self.set_status(RenderLoopStatus::Error);
        }
        result
    }
}
fn same_sync(a: &SharedSync, b: &SharedSync) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}
