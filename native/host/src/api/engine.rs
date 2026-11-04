//! Device, committed scene/camera and the single commit point.
use super::display::DisplayState;
use super::render::{RenderState, SampleEvent};
use super::{Result, Status, error};
use crate::GpuDevice;
use crate::layout::{WORD_BYTES, camera as camera_wire, header};
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, Ordering},
};

/// Intersection backend for every render of an engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Backend {
    /// Software BVH traversal.
    Software,
    /// Hardware ray queries when the device supports them, otherwise software.
    #[default]
    Hardware,
}
impl Backend {
    pub(super) fn code(self) -> u32 {
        match self {
            Self::Software => 0,
            Self::Hardware => 1,
        }
    }
}
/// Engine creation options.
#[derive(Clone, Debug, Default)]
pub struct EngineOptions {
    /// Intersection backend. Default [`Backend::Hardware`].
    pub backend: Backend,
}
/// Device information.
#[derive(Clone, Debug)]
pub struct EngineInfo {
    pub adapter_name: String,
    /// Requested backend; a render can still fall back to software per scene.
    pub backend: Backend,
    /// Whether the device has hardware ray queries enabled.
    pub hardware_ray_query: bool,
}
/// CPU-only engine snapshot. No GPU polling, readback or memory estimation.
#[derive(Clone, Debug)]
pub struct Diagnostics {
    pub info: EngineInfo,
    /// Enabled device capacity for independent material images; zero means disabled.
    pub bindless_texture_capacity: u32,
    /// Configured material texture budget in bytes, shared by import and GPU storage.
    pub material_texture_budget_bytes: u64,
    /// Active committed scene uses bindless images (true) or an atlas (false).
    /// None when no committed scene snapshot is currently available.
    pub material_textures_bindless: Option<bool>,
    pub scene_revision: u64,
    pub has_scene: bool,
    pub preparing: bool,
    pub compiling: bool,
    /// Engine-lifetime cache misses begun and exited (including failed attempts).
    pub compilations_started: u64,
    pub compilations_completed: u64,
    pub pipeline_cache_hits: u64,
    /// Cached path-tracing variants; excludes display/depth/postprocess pipelines.
    pub cached_pipelines: usize,
    pub renders: Vec<RenderDiagnostics>,
    pub last_error: Option<String>,
}
/// Per-render CPU counters. Captured samples may describe a retained old image.
#[derive(Clone, Debug)]
pub struct RenderDiagnostics {
    pub id: u64,
    pub samples: u32,
    pub captured_samples: u32,
    pub denoised_samples: u32,
    pub sampling: bool,
    pub denoising: bool,
}
/// Progress stage reported by [`EngineEvent::Progress`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressStage {
    /// Scene preparation (0 at start, 1 when ready).
    Preparation,
    /// Actual path-tracing pipeline cache-miss compilation.
    Compilation,
}
/// Engine notifications, delivered to [`Engine::on`] subscribers.
#[derive(Clone, Debug, PartialEq)]
pub enum EngineEvent {
    Progress {
        stage: ProgressStage,
        progress: f32,
    },
    Error {
        message: String,
    },
    /// Terminal device loss. `recovering` is always false; create a new engine.
    DeviceLost {
        reason: String,
        recovering: bool,
    },
}

/// Camera record, identical to `mt_camera_v4` (128 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    /// 0 perspective, 1 orthographic.
    pub projection: u32,
    /// Vertical field of view in degrees.
    pub fov: f32,
    pub near_clip: f32,
    pub far_clip: f32,
    pub left: f32,
    pub right: f32,
    pub bottom: f32,
    pub top: f32,
    pub zoom: f32,
    /// 0 disables depth of field.
    pub f_stop: f32,
    pub focus_distance: f32,
    pub sensor_height: f32,
    pub meters_per_unit: f32,
    pub reserved: [u32; 3],
    /// Column-major camera-to-world matrix; the camera looks down -Z.
    pub world_matrix: [f32; 16],
}
const _: () = assert!(std::mem::size_of::<Camera>() == camera_wire::WORDS * WORD_BYTES);
impl Default for Camera {
    /// `mt_camera_v4_default()`: perspective, 45 degrees, no depth of field.
    fn default() -> Self {
        let mut world_matrix = [0.; 16];
        for i in [0, 5, 10, 15] {
            world_matrix[i] = 1.;
        }
        Self {
            projection: 0,
            fov: 45.,
            near_clip: 0.1,
            far_clip: 1000.,
            left: -1.,
            right: 1.,
            bottom: -1.,
            top: 1.,
            zoom: 1.,
            f_stop: 0.,
            focus_distance: 10.,
            sensor_height: 24.,
            meters_per_unit: 1.,
            reserved: [0; 3],
            world_matrix,
        }
    }
}
impl Camera {
    /// Encodes the camera as a 128-byte `mt_camera_v4` record.
    pub fn to_bytes(&self) -> [u8; 128] {
        let mut bytes = [0; 128];
        let mut word = |index: usize, value: u32| {
            bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes())
        };
        word(camera_wire::PROJECTION, self.projection);
        for (index, value) in [
            self.fov,
            self.near_clip,
            self.far_clip,
            self.left,
            self.right,
            self.bottom,
            self.top,
            self.zoom,
            self.f_stop,
            self.focus_distance,
            self.sensor_height,
            self.meters_per_unit,
        ]
        .into_iter()
        .enumerate()
        {
            word(camera_wire::FOV + index, value.to_bits());
        }
        for (index, value) in self.reserved.into_iter().enumerate() {
            word(camera_wire::RESERVED + index, value);
        }
        for (index, value) in self.world_matrix.into_iter().enumerate() {
            word(camera_wire::TRANSFORM + index, value.to_bits());
        }
        bytes
    }
    /// Decodes a 128-byte `mt_camera_v4` record; `None` for any other length.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != 128 {
            return None;
        }
        let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        let float = |i: usize| f32::from_bits(word(i));
        Some(Self {
            projection: word(camera_wire::PROJECTION),
            fov: float(1),
            near_clip: float(2),
            far_clip: float(3),
            left: float(4),
            right: float(5),
            bottom: float(6),
            top: float(7),
            zoom: float(8),
            f_stop: float(9),
            focus_distance: float(10),
            sensor_height: float(11),
            meters_per_unit: float(12),
            reserved: std::array::from_fn(|i| word(camera_wire::RESERVED + i)),
            world_matrix: std::array::from_fn(|i| float(camera_wire::TRANSFORM + i)),
        })
    }
}

pub(super) const QUALITY_BEVEL: u32 = 1;
pub(super) const QUALITY_DISPERSION: u32 = 2;

/// Byte offset of the camera record after checking the header fields the engine overrides.
/// Full validation happens when a render commits the descriptor.
pub(super) fn camera_offset(scene: &[u8]) -> Result<usize> {
    let word = |i: usize| u32::from_le_bytes(scene[i * 4..i * 4 + 4].try_into().unwrap());
    if scene.len() < header::WORDS * WORD_BYTES || scene.len() % WORD_BYTES != 0 {
        return Err(error(
            Status::InvalidArgument,
            "Scene descriptor must be a whole number of words with a complete header",
        ));
    }
    if word(header::VERSION) != crate::layout::version::SCENE as u32 {
        return Err(error(
            Status::InvalidArgument,
            "Scene descriptor version must be MT_VERSION_SCENE",
        ));
    }
    let offset = word(header::CAMERA_OFFSET) as usize;
    if offset < header::WORDS || offset + camera_wire::WORDS > scene.len() / WORD_BYTES {
        return Err(error(
            Status::InvalidArgument,
            "Scene camera record is outside the descriptor",
        ));
    }
    Ok(offset * WORD_BYTES)
}
type EngineListener = Arc<Mutex<dyn FnMut(&EngineEvent) + Send>>;
type SampleListener = Arc<Mutex<dyn FnMut(&SampleEvent) + Send>>;
#[derive(Default)]
struct Listeners {
    next: u64,
    engine: Vec<(u64, EngineListener)>,
    samples: Vec<(u64, u64, SampleListener)>,
}
/// Removes a callback when dropped; [`Subscription::detach`] keeps it for the engine's lifetime.
#[must_use = "dropping a Subscription removes its callback"]
pub struct Subscription {
    inner: std::sync::Weak<Inner>,
    id: u64,
}
impl Subscription {
    /// Keeps the callback registered for the engine's lifetime.
    pub fn detach(self) {
        std::mem::forget(self);
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut listeners = inner.listeners.lock().unwrap();
            listeners.engine.retain(|(id, _)| *id != self.id);
            listeners.samples.retain(|(id, _, _)| *id != self.id);
        }
    }
}

pub(super) struct State {
    pub(super) disposed: bool,
    pub(super) device_failed: bool,
    source_scene: Option<Arc<Vec<u8>>>,
    /// Set by `set_scene_shared`: a new Arc is a changed scene, without comparing bytes.
    source_shared: bool,
    source_camera: Option<Camera>,
    /// Committed by `update`; renders read only these.
    pub(super) scene: Option<Arc<Vec<u8>>>,
    pub(super) camera: Option<[u8; 128]>,
    pub(super) scene_revision: u64,
    pub(super) camera_revision: u64,
    pub(super) renders: BTreeMap<u64, RenderState>,
    pub(super) next_render: u64,
    /// The scene prepared once for every render.
    pub(super) shared: super::render::SharedScene,
    pub(super) gpu: GpuDevice,
    pub(super) backend: Backend,
    pub(super) display: DisplayState,
    pub(super) last_error: Option<String>,
    pub(super) engine_events: Vec<EngineEvent>,
    pub(super) sample_events: Vec<(u64, SampleEvent)>,
}
impl State {
    fn observe_device_loss(&mut self) {
        if self.disposed || self.device_failed {
            return;
        }
        let Some(reason) = self.gpu.loss.reason() else {
            return;
        };
        let reason = reason.to_owned();
        self.device_failed = true;
        self.display.surface = None;
        self.last_error = self.gpu.loss.message();
        for render in self.renders.values_mut() {
            render.device_lost();
        }
        // Work queued before the loss must not report fresh progress/completion.
        self.sample_events.clear();
        self.engine_events.clear();
        self.engine_events.push(EngineEvent::DeviceLost {
            reason,
            recovering: false,
        });
        self.engine_events.push(EngineEvent::Error {
            message: self.last_error.clone().unwrap(),
        });
    }
    pub(super) fn report(&mut self, message: String) {
        self.last_error = Some(message.clone());
        self.engine_events.push(EngineEvent::Error { message });
    }
}
pub(super) struct Inner {
    state: Mutex<State>,
    listeners: Mutex<Listeners>,
    /// Set while `flush` runs callbacks; nested flushes leave events to it.
    dispatching: AtomicBool,
    pub(super) gpu: GpuDevice,
    pub(super) adapter: Option<wgpu::Adapter>,
    pub(super) backend: Backend,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(|e| e.into_inner());
        for (_, render) in std::mem::take(&mut state.renders) {
            render.release();
        }
        state.shared.release();
    }
}

/// Shared device, committed scene/camera and display. Cloning shares the engine.
#[derive(Clone)]
pub struct Engine {
    pub(super) inner: Arc<Inner>,
}
impl Engine {
    /// Creates a device of its own.
    pub fn new(options: EngineOptions) -> Result<Self> {
        let gpu = GpuDevice::with_backend(options.backend.code())
            .map_err(|e| error(Status::Unavailable, format!("GPU device unavailable: {e}")))?;
        Ok(Self::with_gpu(gpu, options, None))
    }
    /// Available adapters in a deterministic order (backend, vendor, device, name).
    /// Enumeration creates no devices and can return an empty list. Retain an
    /// adapter and use [`Engine::on_adapter`] to select that exact device.
    pub fn adapters() -> Vec<wgpu::Adapter> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        crate::GpuDevice::adapters(&instance)
    }
    /// Creates its own device on the selected adapter; failure returns Unavailable
    /// and never selects a different adapter. `options.backend` controls traversal,
    /// not the native graphics API. Use [`Engine::on_device`] to share a device.
    pub fn on_adapter(adapter: &wgpu::Adapter, options: EngineOptions) -> Result<Self> {
        let gpu = GpuDevice::for_adapter(adapter, options.backend.code()).map_err(|e| {
            error(
                Status::Unavailable,
                format!("Selected GPU unavailable: {e}"),
            )
        })?;
        Ok(Self::with_gpu(gpu, options, Some(adapter.clone())))
    }
    /// Shares the caller's device and queue, for example an egui-wgpu render state.
    /// Request the adapter limits and the optional ray-query feature when creating
    /// the device. The optional gate coordinates submissions with surface configuration.
    /// Forward device loss through [`Engine::device_loss_notifier`]; this constructor
    /// does not replace the host's wgpu device-loss callback.
    pub fn on_device(
        adapter: &wgpu::Adapter,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        options: EngineOptions,
        gate: Option<Arc<crate::submission::SubmissionGate>>,
    ) -> Self {
        let gpu = GpuDevice::on_device(adapter, device, queue, gate);
        Self::with_gpu(gpu, options, Some(adapter.clone()))
    }
    pub(super) fn with_gpu(
        mut gpu: GpuDevice,
        options: EngineOptions,
        adapter: Option<wgpu::Adapter>,
    ) -> Self {
        gpu.compilation
            .events_enabled
            .store(true, Ordering::Relaxed);
        // Surface configuration and native image borrows both require exclusive
        // access to queue submission, including for library-owned devices.
        gpu.queue.ensure_gate();
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    disposed: false,
                    device_failed: false,
                    source_scene: None,
                    source_shared: false,
                    source_camera: None,
                    scene: None,
                    camera: None,
                    scene_revision: 0,
                    camera_revision: 0,
                    renders: BTreeMap::new(),
                    next_render: 1,
                    shared: Default::default(),
                    gpu: gpu.clone(),
                    backend: options.backend,
                    display: DisplayState::default(),
                    last_error: None,
                    engine_events: Vec::new(),
                    sample_events: Vec::new(),
                }),
                listeners: Mutex::new(Listeners::default()),
                dispatching: AtomicBool::new(false),
                gpu,
                adapter,
                backend: options.backend,
            }),
        }
    }
    pub(super) fn lock(&self) -> MutexGuard<'_, State> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.observe_device_loss();
        state
    }
    pub(super) fn live(&self) -> Result<MutexGuard<'_, State>> {
        let state = self.lock();
        if state.disposed {
            return Err(error(Status::InvalidHandle, "Engine is disposed"));
        }
        self.inner
            .gpu
            .loss
            .check()
            .map_err(|e| error(Status::Unavailable, e.to_string()))?;
        Ok(state)
    }
    /// Notification handle for the host's wgpu device-loss callback. Clones own
    /// no engine/device and may outlive this engine. For [`Engine::on_device`],
    /// forward the host callback to every engine sharing the device; MuTracer
    /// leaves that callback unchanged. Engines created by [`Engine::new`] wire it automatically.
    pub fn device_loss_notifier(&self) -> super::DeviceLossNotifier {
        self.inner.gpu.loss.clone()
    }
    pub(super) fn check_device(&self) -> Result<()> {
        let state = self.lock();
        if state.disposed {
            return Err(error(Status::InvalidHandle, "Engine is disposed"));
        }
        self.inner
            .gpu
            .loss
            .check()
            .map_err(|e| error(Status::Unavailable, e.to_string()))
    }
    pub(super) fn poll_device(&self) {
        let disposed = self.lock().disposed;
        if !disposed && self.inner.gpu.loss.reason().is_none() {
            let _ = self.inner.gpu.device.poll(wgpu::PollType::Poll);
        }
    }
    /// Delivers queued events on the calling thread without holding the engine lock.
    /// A callback may call back into the API: events it causes are queued and
    /// delivered by the outer call after the current ones, in order.
    pub(super) fn flush(&self) {
        if self.inner.dispatching.swap(true, Ordering::Acquire) {
            return;
        }
        // Cleared on return and if a callback panics.
        struct Dispatching<'a>(&'a AtomicBool);
        impl Drop for Dispatching<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _dispatching = Dispatching(&self.inner.dispatching);
        loop {
            let compilation =
                std::mem::take(&mut *self.inner.gpu.compilation.events.lock().unwrap());
            let (engine, samples) = {
                let mut state = self.lock();
                if !state.device_failed && !state.disposed {
                    state
                        .engine_events
                        .extend(compilation.into_iter().map(|done| EngineEvent::Progress {
                            stage: ProgressStage::Compilation,
                            progress: if done { 1. } else { 0. },
                        }));
                }
                (
                    std::mem::take(&mut state.engine_events),
                    std::mem::take(&mut state.sample_events),
                )
            };
            if engine.is_empty() && samples.is_empty() {
                break;
            }
            let (engine_listeners, sample_listeners) = {
                let listeners = self.inner.listeners.lock().unwrap();
                (listeners.engine.clone(), listeners.samples.clone())
            };
            // A listener removed by an earlier callback is no longer called.
            let registered = |id: u64| {
                let listeners = self.inner.listeners.lock().unwrap();
                listeners.engine.iter().any(|(i, _)| *i == id)
                    || listeners.samples.iter().any(|(i, _, _)| *i == id)
            };
            for event in &engine {
                for (id, listener) in &engine_listeners {
                    if registered(*id) {
                        (listener.lock().unwrap())(event);
                    }
                }
            }
            for (render, event) in &samples {
                for (id, owner, listener) in &sample_listeners {
                    if owner == render && registered(*id) {
                        (listener.lock().unwrap())(event);
                    }
                }
            }
        }
    }
    /// Records a scene descriptor (`mt_scene_header_v4` and its tables), copied.
    /// It takes effect at the next [`Engine::update`]. Width, height, the bevel and
    /// dispersion quality bits and (when [`Engine::set_camera`] was called) the camera
    /// record are replaced per render; the scene's other fields are used as given.
    pub fn set_scene(&self, descriptor: &[u8]) -> Result<()> {
        camera_offset(descriptor)?;
        let mut state = self.live()?;
        state.source_scene = Some(Arc::new(descriptor.to_vec()));
        state.source_shared = false;
        Ok(())
    }
    /// Like [`Engine::set_scene`], without copying: renders share the descriptor,
    /// which must not change afterwards. `update` treats a new Arc as a changed
    /// scene without comparing bytes; passing the committed Arc again changes nothing.
    pub fn set_scene_shared(&self, descriptor: Arc<Vec<u8>>) -> Result<()> {
        camera_offset(&descriptor)?;
        let mut state = self.live()?;
        state.source_scene = Some(descriptor);
        state.source_shared = true;
        Ok(())
    }
    /// Records a checked scene snapshot, shared by all renders. Takes effect at update.
    pub fn set_scene_object(&self, scene: &crate::scene_api::Scene) -> Result<()> {
        self.set_scene_shared(scene.descriptor()?)
    }
    /// Records an empty scene, committed by the next update. Cancels old work,
    /// drops all render images and scene resources; renders can be reused.
    /// Update may wait for scene preparation and submitted GPU work to retire.
    pub fn clear_scene(&self) -> Result<()> {
        self.live()?.source_scene = None;
        Ok(())
    }
    /// Records the camera for every render; `None` uses the scene's camera record.
    /// Takes effect at the next [`Engine::update`]. Default `None`.
    pub fn set_camera(&self, camera: Option<Camera>) -> Result<()> {
        self.live()?.source_camera = camera;
        Ok(())
    }
    /// The sole commit point. Returns whether the scene or camera changed.
    /// The scene is prepared once for all renders. Incremental edits are applied
    /// on this thread; full preparation runs on a library thread and renders report
    /// [`super::RenderStatus::Preparing`] until it is published.
    pub fn update(&self) -> Result<bool> {
        self.poll_device();
        let changed = crate::runtime::with_loss(&self.inner.gpu, || {
            let mut state = self.live()?;
            state.last_error = None;
            let mut changed = false;
            let same = match (&state.source_scene, &state.scene) {
                (Some(source), Some(scene)) => {
                    Arc::ptr_eq(source, scene) || !state.source_shared && **source == **scene
                }
                (None, None) => true,
                _ => false,
            };
            if !same {
                state.scene = state.source_scene.clone();
                state.scene_revision += 1;
                changed = true;
                if state.scene.is_none() {
                    super::render::clear_scene(&mut state)?;
                }
            }
            state.source_scene = state.scene.clone();
            let camera = state.source_camera.map(|c| c.to_bytes());
            if camera != state.camera {
                state.camera = camera;
                state.camera_revision += 1;
                changed = true;
            }
            let ids: Vec<u64> = state.renders.keys().copied().collect();
            for id in ids {
                super::render::synchronize(&mut state, id, changed);
            }
            state.observe_device_loss();
            self.inner
                .gpu
                .loss
                .check()
                .map_err(|e| error(Status::Unavailable, e.to_string()))?;
            Ok(changed)
        });
        self.flush();
        changed
    }
    /// Returns cached CPU observations in O(number of renders), without waiting
    /// for GPU completion. Sample counters refresh on collect/refine/converge;
    /// compilation counters refresh at the actual cache-miss boundary.
    pub fn diagnostics(&self) -> Diagnostics {
        let state = self.lock();
        let c = &self.inner.gpu.compilation;
        Diagnostics {
            info: self.info(),
            bindless_texture_capacity: self.inner.gpu.texture_limits()[1],
            material_texture_budget_bytes: crate::texture_budget::bytes() as u64,
            material_textures_bindless: state.shared.context().and_then(|context| {
                crate::context::material_textures_bindless(context)
                    .ok()
                    .flatten()
            }),
            scene_revision: state.scene_revision,
            has_scene: state.scene.is_some(),
            preparing: state.shared.is_pending(),
            compiling: c.active.load(Ordering::Acquire) > 0,
            compilations_started: c.started.load(Ordering::Relaxed),
            compilations_completed: c.completed.load(Ordering::Relaxed),
            pipeline_cache_hits: c.hits.load(Ordering::Relaxed),
            cached_pipelines: c.cached.load(Ordering::Acquire),
            renders: state
                .renders
                .iter()
                .map(|(&id, r)| r.diagnostics(id, state.scene_revision, state.camera_revision))
                .collect(),
            last_error: state.last_error.clone(),
        }
    }
    /// Adapter name, requested backend and hardware ray-query support.
    pub fn info(&self) -> EngineInfo {
        EngineInfo {
            adapter_name: self.inner.gpu.info.name.clone(),
            backend: self.inner.backend,
            hardware_ray_query: self.inner.gpu.hardware_ray_query,
        }
    }
    /// The engine's display; every call returns a handle to the same display.
    pub fn display(&self) -> super::Display {
        super::Display {
            engine: self.clone(),
        }
    }
    /// Subscribes to progress, error and device-loss events.
    pub fn on(&self, listener: impl FnMut(&EngineEvent) + Send + 'static) -> Subscription {
        let mut listeners = self.inner.listeners.lock().unwrap();
        listeners.next += 1;
        let id = listeners.next;
        listeners.engine.push((id, Arc::new(Mutex::new(listener))));
        Subscription {
            inner: Arc::downgrade(&self.inner),
            id,
        }
    }
    pub(super) fn on_sample(
        &self,
        render: u64,
        listener: impl FnMut(&SampleEvent) + Send + 'static,
    ) -> Subscription {
        let mut listeners = self.inner.listeners.lock().unwrap();
        listeners.next += 1;
        let id = listeners.next;
        listeners
            .samples
            .push((id, render, Arc::new(Mutex::new(listener))));
        Subscription {
            inner: Arc::downgrade(&self.inner),
            id,
        }
    }
    pub(super) fn empty_source(&self) -> bool {
        self.lock().source_scene.is_none()
    }
    /// Whether `set_scene`/`set_camera` recorded inputs that `update` has not committed.
    pub(super) fn inputs_pending(&self) -> bool {
        let state = self.lock();
        let scene = match (&state.source_scene, &state.scene) {
            (Some(source), Some(scene)) => !Arc::ptr_eq(source, scene),
            (None, None) => false,
            _ => true,
        };
        scene || state.source_camera.map(|c| c.to_bytes()) != state.camera
    }
    /// Message of the last error since the previous successful `update`.
    /// Device-loss errors persist until disposal.
    pub fn last_error(&self) -> Option<String> {
        self.lock().last_error.clone()
    }
    /// Releases every render's resources. Later calls on the engine, its renders
    /// and display return [`Status::InvalidHandle`]. Dropping the last handle also releases.
    pub fn dispose(&self) {
        let (renders, mut shared) = {
            let mut state = self.lock();
            state.disposed = true;
            state.engine_events.clear();
            state.sample_events.clear();
            state.display = DisplayState::default();
            (
                std::mem::take(&mut state.renders),
                std::mem::take(&mut state.shared),
            )
        };
        for (_, render) in renders {
            render.release();
        }
        shared.release();
        let mut listeners = self.inner.listeners.lock().unwrap();
        listeners.engine.clear();
        listeners.samples.clear();
    }
}
