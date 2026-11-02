//! Context operations serialize publication; candidate preparation runs outside the registry lock.
use super::*;
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

struct Context {
    gpu: GpuDevice,
    backend: u32,
    fallback_reason: String,
    scene: Option<GpuScene>,
    target: Option<Target>,
    spare_buffers: HashMap<usize, wgpu::Buffer>,
    spare_hardware: HashMap<hardware::HardwareBufferId, wgpu::Buffer>,
    failed: bool,
    job: Option<RenderJob>,
    commit: Option<Arc<PendingCommit>>,
    /// Descriptor of the committed scene; incremental commits diff against it.
    descriptor: Option<Arc<Vec<u8>>>,
    /// Path of the last successful commit (`mt_commit_kind`).
    last_commit: u32,
    /// Render target on another context's scene; such a context holds no scene.
    link: Option<Link>,
    /// Shared scene contexts allocate no camera, accumulation or frame sequence.
    scene_only: bool,
    /// Identity of the published scene/target; snapshots keep old identities alive.
    publication: Arc<()>,
}
/// S2: a context that renders `target` on the scene of context `scene`.
/// `current` is cleared when that scene is committed again, until `set_target`.
struct Link {
    scene: u64,
    current: bool,
}
struct PendingCommit {
    cancelled: AtomicBool,
    finished: Mutex<bool>,
    completed: std::sync::Condvar,
}
impl PendingCommit {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            finished: Mutex::new(false),
            completed: std::sync::Condvar::new(),
        }
    }
    fn wait(&self) {
        let mut finished = self.finished.lock().unwrap();
        while !*finished {
            finished = self.completed.wait(finished).unwrap();
        }
    }
}
struct Completion(Arc<PendingCommit>);
impl Drop for Completion {
    fn drop(&mut self) {
        *self.0.finished.lock().unwrap() = true;
        self.0.completed.notify_all();
    }
}
#[derive(Clone, Copy, PartialEq)]
#[repr(u32)]
enum JobState {
    Queued = 0,
    Running = 1,
    Complete = 2,
    Cancelled = 3,
    Failed = 4,
    Cancelling = 5,
}
struct Flight {
    end: u32,
    done: Arc<AtomicBool>,
    timer: Option<(
        crate::profiling::GpuTimer,
        mpsc::Receiver<std::result::Result<(), wgpu::BufferAsyncError>>,
    )>,
}
struct RenderJob {
    id: u64,
    base: u32,
    requested: u32,
    submitted: u32,
    completed: u32,
    state: JobState,
    cancelled: bool,
    flight: Option<Flight>,
    gpu_ms: Option<f64>,
}
impl RenderJob {
    fn active(&self) -> bool {
        matches!(
            self.state,
            JobState::Queued | JobState::Running | JobState::Cancelling
        )
    }
}
fn idle(context: &Context) -> Result<()> {
    if !context.failed && context.job.as_ref().is_some_and(|j| j.active()) {
        return Err(fail(
            Status::InvalidState,
            "Context has an active render job; cancel and poll it first",
        ));
    }
    Ok(())
}
struct Registry {
    next: u64,
    contexts: HashMap<u64, Context>,
}
static REGISTRY: std::sync::LazyLock<Mutex<Registry>> = std::sync::LazyLock::new(|| {
    Mutex::new(Registry {
        next: 1,
        contexts: HashMap::new(),
    })
});
/// Tests: install the per-sample primary-hit audit in hardware preparations.
#[cfg(test)]
pub(crate) static AUDIT_PREPARATIONS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// Tests: the next full preparation waits for this gate (or its sender's drop).
#[cfg(test)]
pub(crate) static PREPARATION_GATE: Mutex<Option<mpsc::Receiver<()>>> = Mutex::new(None);
#[cfg(test)]
pub(crate) static AUDIT_HISTORY_SAMPLES: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);
#[cfg(test)]
pub(crate) fn audit_history(handle: u64, samples: u32) -> crate::sample_audit::History {
    let slot = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let scene = slot.contexts[&handle].scene.as_ref().unwrap();
    crate::sample_audit::read_history(
        scene,
        slot.contexts[&handle].target.as_ref().unwrap(),
        samples,
    )
    .unwrap()
}
/// Tests: primary hits, short and invalid pixels of a context's last traced
/// sample (`sample` = its index), when the audit is installed.
#[cfg(test)]
pub(crate) fn audit_sample(handle: u64, sample: u32) -> Option<[usize; 3]> {
    let slot = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let scene = slot.contexts.get(&handle)?.scene.as_ref()?;
    let target = slot.contexts.get(&handle)?.target.as_ref()?;
    target.buffers.get(&layout::resource::QUERY_COUNTS)?;
    let a = crate::sample_audit::read(scene, target, sample).ok()?;
    Some([a.primary_hits, a.short_pixels, a.invalid_pixels])
}
// The context an ABI call resolved, and whether it was already failed then.
thread_local! { static TOUCHED: std::cell::Cell<Option<(u64, bool)>> = const { std::cell::Cell::new(None) }; }

/// `mt_commit_kind` values reported in `ContextInfo::last_commit`.
pub const COMMIT_NONE: u32 = 0;
pub const COMMIT_FULL: u32 = 1;
pub const COMMIT_INCREMENTAL: u32 = 2;
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ContextInfo {
    pub struct_size: u32,
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    pub state: u32,
    pub last_commit: u32,
}
// Rust operations and C wrappers share exactly the same lock, panic and
// failure-classification boundary. Catch while the guard is alive so a panic
// never poisons the registry.
fn with_registry<T>(operation: impl FnOnce(&mut Registry) -> Result<T>) -> Result<T> {
    platform_scope(|| -> Result<T> {
        let mut slot = REGISTRY.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => fail(Status::Busy, "Context registry is active"),
            std::sync::TryLockError::Poisoned(_) => "Context registry is poisoned".into(),
        })?;
        let registry = &mut *slot;
        // Catch while guards remain in scope, avoiding mutex poisoning.
        TOUCHED.set(None);
        match std::panic::catch_unwind(AssertUnwindSafe(|| operation(registry))) {
            Ok(Ok(value)) => Ok(value),
            // An unclassified error that left a healthy context failed came from
            // execution after validation; report the state change it caused.
            Ok(Err(error)) => {
                let newly_failed = TOUCHED.get().is_some_and(|(id, was_failed)| {
                    !was_failed && registry.contexts.get(&id).is_some_and(|c| c.failed)
                });
                if newly_failed && classify(error.as_ref(), Status::Error) == Status::Error {
                    Err(fail(Status::ContextFailed, error.to_string()))
                } else {
                    Err(error)
                }
            }
            Err(_) => {
                match TOUCHED
                    .get()
                    .and_then(|(id, _)| registry.contexts.get_mut(&id))
                {
                    Some(context) => {
                        context.failed = true;
                        Err(fail(
                            Status::ContextFailed,
                            "Native context operation panicked; context marked failed",
                        ))
                    }
                    None => Err("Native context operation panicked".into()),
                }
            }
        }
    })
}
// Keep waiting Rust workflows separate from the nonblocking C registry boundary.
pub(crate) fn blocking<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        runtime::check_loss().map_err(|e| fail(Status::Unavailable, e.to_string()))?;
        match operation() {
            Err(e)
                if classify(e.as_ref(), Status::Error) == Status::Busy
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_micros(200));
            }
            result => return result,
        }
    }
}
fn action(
    error: *mut c_char,
    capacity: usize,
    operation: impl FnOnce(&mut Registry) -> Result<()>,
) -> i32 {
    write_result(error, capacity, with_registry(operation))
}
fn write_result(error: *mut c_char, capacity: usize, result: Result<()>) -> i32 {
    match result {
        Ok(()) => status::write(error, capacity, Status::Ok, ""),
        Err(e) => status::write(
            error,
            capacity,
            classify(e.as_ref(), Status::Error),
            &e.to_string(),
        ),
    }
}
fn context(registry: &mut Registry, handle: u64) -> Result<&mut Context> {
    let context = registry
        .contexts
        .get_mut(&handle)
        .ok_or_else(|| fail(Status::InvalidHandle, "Invalid or destroyed native context"))?;
    if TOUCHED.get().is_none() {
        TOUCHED.set(Some((handle, context.failed)));
    }
    Ok(context)
}

fn ready(context: &mut Context) -> Result<&mut GpuScene> {
    context.gpu.loss.check()?;
    if context.failed {
        return Err(fail(
            Status::InvalidState,
            "Scene failed; commit a new scene before rendering or reading",
        ));
    }
    context
        .scene
        .as_mut()
        .ok_or_else(|| fail(Status::InvalidState, "No committed scene"))
}
/// The context for `handle` and, when it is a linked render target, the scene
/// it renders. The target must be current.
fn with_scene(
    registry: &mut Registry,
    handle: u64,
) -> Result<(&mut Context, Option<&mut GpuScene>)> {
    let Some(owner) = context(registry, handle)?.link.as_ref().map(|l| l.scene) else {
        let current = registry.contexts.get_mut(&handle).unwrap();
        ready(current)?;
        return Ok((current, None));
    };
    let [Some(context), Some(scene)] = registry.contexts.get_disjoint_mut([&handle, &owner]) else {
        return Err(fail(
            Status::InvalidState,
            "The render target's scene was destroyed",
        ));
    };
    if context.failed {
        return Err(fail(
            Status::InvalidState,
            "Render target failed; set it again before rendering or reading",
        ));
    }
    if !context.link.as_ref().unwrap().current {
        return Err(fail(
            Status::InvalidState,
            "The scene was committed again; set the render target first",
        ));
    }
    Ok((context, Some(ready(scene)?)))
}
fn render_parts<'a>(
    context: &'a mut Context,
    linked: Option<&'a mut GpuScene>,
) -> Result<(&'a mut GpuScene, &'a mut Target)> {
    let scene = match linked {
        Some(scene) => scene,
        None => context.scene.as_mut().ok_or("No committed scene")?,
    };
    let target = context
        .target
        .as_mut()
        .ok_or_else(|| fail(Status::InvalidState, "No render target"))?;
    Ok((scene, target))
}
impl Context {
    fn reset_target(&mut self) -> Result<()> {
        if let (Some(scene), Some(target)) = (&self.scene, &mut self.target) {
            scene.reset_target(target)?;
        }
        Ok(())
    }
    fn finish_update(&mut self) -> Result<()> {
        self.reset_target()?;
        self.job = None;
        self.failed = false;
        Ok(())
    }
}
/// Before the scene of `owner` changes: drain the jobs of the targets linked to
/// it and mark them stale until they are set again.
fn retire_targets(registry: &mut Registry, owner: u64) -> Result<()> {
    registry.contexts.get_mut(&owner).unwrap().publication = Arc::new(());
    for context in registry
        .contexts
        .values_mut()
        .filter(|c| c.link.as_ref().is_some_and(|l| l.scene == owner))
    {
        if let Some(job) = context.job.as_mut().filter(|j| j.active()) {
            job.cancelled = true;
            while job_active(context) {
                advance_job(context, None, 0)?;
                std::thread::yield_now();
            }
        }
        context.link.as_mut().unwrap().current = false;
        if let Some(history) = context
            .target
            .as_mut()
            .and_then(|t| t.frame_inputs.as_mut())
        {
            // Until stable scene correspondence is produced, a scene publication
            // must not reuse temporal history from the retired publication.
            history.invalidate(denoiser_inputs::ResetReason::TargetRebuilt);
        }
    }
    Ok(())
}
/// Links context `handle` to the scene of context `owner` as a render target
/// with its own size, settings, quality flags and camera, restarting its
/// accumulation. Buffers of the previous target are reused when sizes match.
/// The owner must hold a retained scene; a pending commit of it reports Busy.
pub(crate) fn set_target(
    handle: u64,
    owner: u64,
    settings: &settings::RenderSettings,
    size: [u32; 2],
    quality: u32,
    alpha_blend_strategy: u32,
    camera: &[u8; 128],
) -> Result<()> {
    let snapshot = with_registry(|registry| {
        let (current, source) = target_contexts(registry, handle, owner)?;
        let publication = source.publication.clone();
        let loss = source.gpu.loss.clone();
        loss.check()?;
        let scene = ready(source)?;
        Ok((
            scene.retained.as_ref().ok_or("No retained scene")?.clone(),
            scene.hwrt_shader,
            loss,
            publication,
            current.publication.clone(),
        ))
    })?;
    let (retained, hardware, loss, scene_publication, target_publication) = snapshot;
    // Both the target packet and its packed sample sequence wait for the shared
    // AOT thread. Keep the registry free for other contexts' render/poll/cancel.
    let packet = std::panic::catch_unwind(AssertUnwindSafe(|| {
        retained
            .target(
                settings,
                size,
                quality,
                alpha_blend_strategy,
                hardware,
                camera,
                &loss,
                false,
            )
            .map_err(rejected)
    }));
    with_registry(|registry| {
        let (current, source) = target_contexts(registry, handle, owner)?;
        loss.check()?;
        if !Arc::ptr_eq(&source.publication, &scene_publication)
            || !Arc::ptr_eq(&current.publication, &target_publication)
        {
            return Err(fail(
                Status::Busy,
                "Scene or render target changed during target preparation",
            ));
        }
        let scene = ready(source)?;
        let packet = packet
            .unwrap_or_else(|_| {
                current.failed = true;
                Err(fail(
                    Status::ContextFailed,
                    "Native target preparation panicked; context marked failed",
                ))
            })
            .map_err(|error| {
                if classify(error.as_ref(), Status::Error) == Status::ContextFailed {
                    current.failed = true;
                }
                error
            })?;
        current.publication = Arc::new(());
        let previous = current.target.take();
        current.job = None;
        current.failed = true;
        let target = scene.target(packet, size, previous)?;
        current.target = Some(target);
        current.link = Some(Link {
            scene: owner,
            current: true,
        });
        current.failed = false;
        Ok(())
    })
}
// Checked both before AOT preparation and before publication. Handles may have
// been destroyed, jobs started, or scene commits begun while the registry was free.
fn target_contexts(
    registry: &mut Registry,
    handle: u64,
    owner: u64,
) -> Result<(&mut Context, &mut Context)> {
    if handle == owner {
        return Err(fail(
            Status::InvalidArgument,
            "A context cannot target itself",
        ));
    }
    let current = context(registry, handle)?;
    if current.scene.is_some() || current.commit.is_some() {
        return Err(fail(
            Status::InvalidState,
            "Context holds its own scene and cannot become a render target",
        ));
    }
    idle(current)?;
    let [Some(current), Some(source)] = registry.contexts.get_disjoint_mut([&handle, &owner])
    else {
        return Err(fail(Status::InvalidHandle, "Invalid scene context"));
    };
    if source.commit.is_some() {
        return Err(fail(Status::Busy, "The scene is being committed"));
    }
    Ok((current, source))
}
// Direct AS preparation deliberately omits the software BVH. Re-run the shared
// TS preparation only when hardware capture/upload fails, replacing its retained
// state too so later edits operate on the same representation as the fallback.
fn prepare_software_fallback(
    bytes: &[u8],
    mut scene: Scene,
    assets: &mut Assets,
    retained: &mut scene::PreparedState,
) -> Result<Scene> {
    if scene
        .native_layout
        .as_ref()
        .is_some_and(|layout| layout.indexed)
        || !assets.contains_key(&AssetId::Packet(30))
    {
        let settings = retained.settings;
        let (software, software_assets, software_retained) =
            scene::prepare_retained_with_settings(bytes, false, 0, &settings)?;
        *assets = software_assets;
        *retained = software_retained;
        Ok(software)
    } else {
        scene.hwrt = None;
        Ok(scene)
    }
}

// C pointer ownership and structure sizes are specified in mutracer-context.h.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_create(
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    unsafe { mt_context_create_with_backend(1, output, error, capacity) }
}
/// Backend 0=software, 1=HWRT with reported software fallback.
/// Rust embedding bridge: presentation and tracing share the caller's device.
/// Request the adapter limits and optional ray-query feature when creating it.
pub fn create_on_device(
    adapter: &wgpu::Adapter,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    backend: u32,
) -> std::result::Result<u64, String> {
    create_on_device_with_gate(adapter, device, queue, backend, None)
}
/// Shared-device embedding with an optional presentation submission gate.
pub fn create_on_device_with_gate(
    adapter: &wgpu::Adapter,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    backend: u32,
    gate: Option<Arc<submission::SubmissionGate>>,
) -> std::result::Result<u64, String> {
    if backend > 1 {
        return Err("Unknown native intersection backend".into());
    }
    let gpu = GpuDevice::on_device(adapter, device, queue, gate);
    blocking(|| create_with_gpu(gpu.clone(), backend)).map_err(|e| e.to_string())
}
// Scene-only engines have no implicit output; every render allocates its Target.
pub(crate) fn create_scene_with_gpu(gpu: GpuDevice, backend: u32) -> Result<u64> {
    with_registry(|registry| create_in(registry, backend, true, || Ok(gpu)))
}
/// Context on an existing device; L1 engines share one device across renders.
pub(crate) fn create_with_gpu(gpu: GpuDevice, backend: u32) -> Result<u64> {
    with_registry(|registry| create_in(registry, backend, false, || Ok(gpu)))
}
fn create_in(
    registry: &mut Registry,
    backend: u32,
    scene_only: bool,
    gpu: impl FnOnce() -> Result<GpuDevice>,
) -> Result<u64> {
    if backend > 1 {
        return Err(fail(
            Status::InvalidArgument,
            "Unknown native intersection backend",
        ));
    }
    let handle = registry.next;
    let next = handle
        .checked_add(1)
        .ok_or("Native context handles exhausted")?;
    let gpu = gpu()?;
    registry.next = next;
    registry.contexts.insert(
        handle,
        Context {
            gpu,
            backend,
            fallback_reason: String::new(),
            scene: None,
            target: None,
            spare_buffers: HashMap::new(),
            spare_hardware: HashMap::new(),
            failed: false,
            job: None,
            commit: None,
            descriptor: None,
            last_commit: COMMIT_NONE,
            link: None,
            scene_only,
            publication: Arc::new(()),
        },
    );
    Ok(handle)
}
/// Clone only the resources needed by a depth query. Compilation, AOT camera
/// packing, submission and readback must all run outside REGISTRY.
pub(crate) fn depth_query(handle: u64) -> Result<Option<crate::depth::Query>> {
    let result = with_registry(|registry| {
        let current = context(registry, handle)?;
        if current.commit.is_some() {
            return Ok(None);
        }
        Ok(Some(crate::depth::Query::snapshot(ready(current)?)))
    });
    match result {
        Err(e) if classify(e.as_ref(), Status::Error) == Status::Busy => Ok(None),
        result => result,
    }
}
/// Borrow the current target's accumulated images. GPU commands retain these
/// buffers if a later publication replaces the target at the same dimensions.
pub(crate) fn denoise_buffers(handle: u64) -> crate::Result<([wgpu::Buffer; 3], [u32; 2], bool)> {
    blocking(|| {
        with_registry(|registry| {
            let (state, linked) = with_scene(registry, handle)?;
            let (scene, target) = render_parts(state, linked)?;
            let [color, albedo, normal] = [0, 2, 1].map(|kind| target.output(kind).cloned());
            let buffers = [color?, albedo?, normal?];
            let size = [target.width, target.height];
            scene.gpu.loss.check()?;
            Ok((
                buffers,
                size,
                crate::display::Metadata::from_trace(&scene.display_trace).opaque_background(),
            ))
        })
    })
}

/// Capture the last completed accumulation without a CPU image readback.
/// A busy publication returns false so the UI can retain its stable old frame.
pub fn capture_display(
    handle: u64,
    display: &mut Option<crate::display::Display>,
) -> std::result::Result<bool, String> {
    capture_display_filtered(handle, display, None)
}
pub(crate) fn capture_display_filtered(
    handle: u64,
    display: &mut Option<crate::display::Display>,
    jnlm: Option<crate::display::jnlm::Options>,
) -> std::result::Result<bool, String> {
    let result = with_registry(|registry| {
        let (state, linked) = with_scene(registry, handle)?;
        let (scene, target) = render_parts(state, linked)?;
        let [color, normal, albedo, shadow] = [0, 1, 2, 3].map(|kind| target.output(kind).cloned());
        let outputs = [color?, normal?, albedo?, shadow?];
        let (samples, size) = (target.samples, [target.width, target.height]);
        if samples == 0 {
            return Ok(false);
        }
        if display
            .as_ref()
            .is_none_or(|d| d.size != size || d.owner != handle)
        {
            // Resource IDs from independent wgpu Instances can compare equal.
            // Native context handles are process-unique and own a fixed device.
            let mut next = crate::display::Display::new(scene.gpu.clone(), size);
            next.owner = handle;
            *display = Some(next);
        }
        let [color, normal, albedo, shadow] = &outputs;
        let metadata = crate::display::Metadata::from_trace(&scene.display_trace);
        display.as_mut().unwrap().set_jnlm(jnlm);
        display
            .as_mut()
            .unwrap()
            .capture(color, normal, albedo, shadow, metadata, samples);
        Ok(true)
    });
    match result {
        Err(e) if classify(e.as_ref(), Status::Error) == Status::Busy => Ok(false),
        result => result.map_err(|e| e.to_string()),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_create_with_backend(
    backend: u32,
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        if output.is_null() {
            return Err(fail(Status::InvalidArgument, "Null context output"));
        }
        unsafe {
            *output = 0;
        }
        unsafe {
            *output = create_in(registry, backend, false, || {
                GpuDevice::with_backend(backend)
                    .map_err(|e| fail(Status::Unavailable, format!("GPU device unavailable: {e}")))
            })?;
        }
        Ok(())
    })
}
pub(crate) fn destroy(handle: u64) -> Result<()> {
    let pending = with_registry(|registry| {
        let current = context(registry, handle)?;
        idle(current)?;
        let pending = current.commit.clone();
        if let Some(commit) = &pending {
            commit.cancelled.store(true, Ordering::Release);
        }
        registry
            .contexts
            .remove(&handle)
            .ok_or("Invalid or destroyed native context")?;
        Ok(pending)
    })?;
    {
        if let Some(commit) = pending {
            commit.wait();
        }
        runtime::init(); // All root releases precede this owned barrier message.
    }
    Ok(())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_destroy(
    handle: u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    write_result(error, capacity, destroy(handle))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_commit(
    handle: u64,
    input: *const u8,
    length: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    unsafe {
        mt_context_commit_with_settings(
            handle,
            input,
            length,
            &settings::RenderSettings::default(),
            error,
            capacity,
        )
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_commit_with_settings(
    handle: u64,
    input: *const u8,
    length: usize,
    settings: *const settings::RenderSettings,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    let result = platform_scope(|| {
        if settings.is_null() || input.is_null() || length > scene::MAX_BYTES {
            return Err(fail(
                Status::InvalidArgument,
                "Null or oversized scene/settings input",
            ));
        }
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        commit_inner(handle, bytes, unsafe { *settings }, None, CommitPath::Any).map(|_| ())
    });
    write_result(error, capacity, result)
}
/// Which commit paths one call may take. The C ABI always uses `Any`.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum CommitPath {
    Any,
    /// Apply an incremental commit on the calling thread or report why not.
    IncrementalOnly,
    /// Skip the incremental attempt; used after `IncrementalOnly` reported `NeedsFull`.
    FullOnly,
}
/// Result of a successful (status 0) commit call.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum CommitOutcome {
    Done,
    /// Only full preparation applies. A partially applied incremental edit has
    /// already cleared the retained descriptor; the scene must be fully prepared.
    NeedsFull,
    /// Another context is preparing, so the incremental path was not attempted.
    Blocked,
}
/// L1 entry point: a shared descriptor, which the context keeps without copying,
/// and borrowed settings, with an explicit commit path.
pub(crate) fn commit_path(
    handle: u64,
    bytes: &Arc<Vec<u8>>,
    settings: &settings::RenderSettings,
    path: CommitPath,
) -> Result<CommitOutcome> {
    platform_scope(|| commit_inner(handle, bytes, *settings, Some(bytes), path))
}

fn commit_inner(
    handle: u64,
    bytes: &[u8],
    settings: settings::RenderSettings,
    shared: Option<&Arc<Vec<u8>>>,
    path: CommitPath,
) -> Result<CommitOutcome> {
    if bytes.len() > scene::MAX_BYTES {
        return Err(fail(
            Status::InvalidArgument,
            "Null or oversized scene/settings input",
        ));
    }
    let mut snapshot = None;
    let cancel = Arc::new(PendingCommit::new());
    let _completion = Completion(cancel.clone());
    // Incremental attempt: like full preparation, the sync runs outside the registry
    // lock while the context is marked preparing, so render, poll, cancel and
    // destroy stay available. Only the retained GPU updates hold the lock.
    let mut candidate = None;
    let mut blocked = false;
    let mut scene_only = false;
    with_registry(|registry| {
        let preparing = registry.contexts.values().any(|c| c.commit.is_some());
        let context = context(registry, handle)?;
        if context.link.is_some() {
            return Err(fail(
                Status::InvalidState,
                "A render target context renders another context's scene",
            ));
        }
        if context.commit.is_some() {
            return Err(fail(
                Status::InvalidState,
                "Scene commit is already preparing",
            ));
        }
        blocked = preparing;
        scene_only = context.scene_only;
        if !preparing && path != CommitPath::FullOnly {
            candidate = incremental_candidate(context, bytes, &settings);
            if candidate.is_some() {
                context.commit = Some(cancel.clone());
            }
        }
        Ok(())
    })?;
    if let Some((retained, previous)) = candidate {
        // The TS core trusts validated descriptors only. Validation and sync
        // failures fall through to full preparation, which reports them.
        let started = std::time::Instant::now();
        // Records identical to the validated previous descriptor skip element scans.
        let unchanged = commit_plan::unchanged_records(&previous, bytes);
        let hinted = started.elapsed();
        let valid = scene::validate_changed(bytes, &unchanged).is_ok();
        let validated = started.elapsed();
        // One copy of the caller's descriptor serves the sync and, once applied, the context.
        let next = shared.cloned().unwrap_or_else(|| Arc::new(bytes.to_vec()));
        let copied = started.elapsed();
        let sync = valid
            .then(|| {
                retained
                    .sync(previous.clone(), next.clone(), unchanged)
                    .ok()
            })
            .flatten();
        let synced = started.elapsed();
        let steps = sync.and_then(|sync| commit_plan::plan(&previous, bytes, &sync, scene_only));
        let planned = started.elapsed();
        let mut finished = false;
        with_registry(|registry| {
            let context = context(registry, handle).or_else(|error| {
                cancelled(&cancel)?;
                Err(error)
            })?;
            context.commit = None;
            if let Err(error) = cancelled(&cancel) {
                retained.reset_sync()?;
                return Err(error);
            }
            match &steps {
                Some(steps) => {
                    retire_targets(registry, handle)?;
                    let context = registry.contexts.get_mut(&handle).unwrap();
                    finished = apply_incremental(context, &retained, &next, steps)?
                }
                None => retained.reset_sync()?,
            }
            if crate::profiling::enabled() {
                let ms = |d: std::time::Duration| d.as_secs_f64() * 1e3;
                native_log!(
                    "{}",
                    serde_json::json!({"nativeCommitProfile": {"bytes": bytes.len(),
                    "hintMs": ms(hinted), "validateMs": ms(validated - hinted), "copyMs": ms(copied - validated), "syncMs": ms(synced - copied),
                    "planMs": ms(planned - synced), "applyMs": ms(started.elapsed() - planned),
                    "steps": steps.as_ref().map(Vec::len), "incremental": finished}})
                );
            }
            Ok(())
        })?;
        if finished {
            return Ok(CommitOutcome::Done);
        }
    }
    if path == CommitPath::IncrementalOnly {
        return Ok(if blocked {
            CommitOutcome::Blocked
        } else {
            CommitOutcome::NeedsFull
        });
    }
    with_registry(|registry| {
        let context = context(registry, handle)?;
        if context.commit.is_some() {
            return Err(fail(
                Status::InvalidState,
                "Scene commit is already preparing",
            ));
        }
        snapshot = Some(CommitSnapshot {
            gpu: context.gpu.clone(),
            backend: context.backend,
            spare_buffers: std::mem::take(&mut context.spare_buffers),
            spare_hardware: std::mem::take(&mut context.spare_hardware),
            scene_only: context.scene_only,
        });
        context.commit = Some(cancel.clone());
        Ok(())
    })?;
    let snapshot = snapshot.unwrap();
    let resized;
    let bytes = if snapshot.scene_only {
        // Shared scenes have no frame resources; avoid image-sized zero buffers in AOT packing.
        let mut copy = bytes.to_vec();
        copy[layout::header::WIDTH * 4..layout::header::WIDTH * 4 + 4]
            .copy_from_slice(&1u32.to_le_bytes());
        copy[layout::header::HEIGHT * 4..layout::header::HEIGHT * 4 + 4]
            .copy_from_slice(&1u32.to_le_bytes());
        resized = copy;
        &resized[..]
    } else {
        bytes
    };
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<_> {
        let result = (|| -> Result<_> {
            let profile = std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1");
            #[cfg(test)]
            if let Some(gate) = PREPARATION_GATE.lock().unwrap().take() {
                let _ = gate.recv_timeout(Duration::from_secs(60));
            }
            snapshot.gpu.loss.check()?;
            let started = Instant::now();
            let (mut scene, mut assets, mut retained) = scene::prepare_retained_with_settings(
                bytes,
                snapshot.backend == 1
                    && snapshot.gpu.hardware_ray_query
                    && hardware::direct_input_enabled(),
                snapshot.backend,
                &settings,
            )
            .map_err(rejected)?;
            cancelled(&cancel)?;
            snapshot.gpu.loss.check()?;
            let prepared = Instant::now();
            let uniform = assets
                .get(&AssetId::Packet(7))
                .ok_or("Missing normalized render settings")?;
            let seed = u32::from_le_bytes(
                uniform[layout::ray_uniform::SEQUENCE_SEED..layout::ray_uniform::SEQUENCE_SEED + 4]
                    .try_into()?,
            );
            let bounces = i32::from_le_bytes(
                uniform[layout::ray_uniform::BOUNCES..layout::ray_uniform::BOUNCES + 4]
                    .try_into()?,
            ) as f32;

            let mut options = RenderOptions {
                seed,
                bounces,
                ..Default::default()
            };
            let mut fallback_reason = String::new();
            if snapshot.backend != 0 {
                let capture = if snapshot.gpu.hardware_ray_query {
                    hardware::capture_from_resources(
                        &mut assets,
                        scene
                            .native_layout
                            .as_ref()
                            .ok_or("Missing native HWRT metadata")?,
                    )
                } else {
                    Err("Hardware ray queries unavailable on this device".into())
                };
                match capture {
                    Ok(capture) => {
                        scene.hwrt = Some(capture);
                        options.flags |= 4;
                        #[cfg(test)]
                        if AUDIT_PREPARATIONS.load(std::sync::atomic::Ordering::Relaxed) {
                            crate::sample_audit::install_history(
                                &mut scene,
                                &mut assets,
                                AUDIT_HISTORY_SAMPLES.load(std::sync::atomic::Ordering::Relaxed),
                            )?;
                        }
                    }
                    Err(error) => {
                        fallback_reason = error.to_string();
                        scene =
                            prepare_software_fallback(bytes, scene, &mut assets, &mut retained)?;
                    }
                }
            }
            cancelled(&cancel)?;
            let hardware_prepared = Instant::now();
            let mut software_scene = scene.clone();
            software_scene.hwrt = None;
            let candidate = GpuScene::new_reusing(
                scene,
                &options,
                &assets,
                snapshot.gpu.clone(),
                Some(&snapshot.spare_buffers),
                Some(&snapshot.spare_hardware),
                !snapshot.scene_only,
            );
            let (mut candidate, mut target) = match candidate {
                Ok(candidate) => candidate,
                Err(error) if snapshot.backend == 1 && options.flags & 4 != 0 => {
                    fallback_reason = format!("HWRT upload unavailable: {error}");
                    let software_scene = prepare_software_fallback(
                        bytes,
                        software_scene,
                        &mut assets,
                        &mut retained,
                    )?;
                    GpuScene::new_reusing(
                        software_scene,
                        &RenderOptions {
                            flags: 0,
                            ..options
                        },
                        &assets,
                        snapshot.gpu.clone(),
                        Some(&snapshot.spare_buffers),
                        Some(&snapshot.spare_hardware),
                        !snapshot.scene_only,
                    )?
                }
                Err(error) => return Err(error),
            };
            if profile {
                // Host setup includes uploads, AS creation, bindings and validation.
                // Pipeline time is a subset; retries remain included in setup time.
                native_log!(
                    "{}",
                    serde_json::json!({
                        "nativeCommitProfile": {
                            "cpuPrepareMs": prepared.duration_since(started).as_secs_f64() * 1000.0,
                            "hardwareCaptureMs": hardware_prepared.duration_since(prepared).as_secs_f64() * 1000.0,
                            "gpuSetupMs": hardware_prepared.elapsed().as_secs_f64() * 1000.0,
                            "pipelineMs": candidate.compile_seconds * 1000.0,
                            "totalMs": started.elapsed().as_secs_f64() * 1000.0,
                            "uploadRetried": fallback_reason.starts_with("HWRT upload unavailable:"),
                        }
                    })
                );
            }
            cancelled(&cancel)?;
            if settings.caustic_flags != 0 && target.is_some() {
                let word =
                    |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
                let size = [word(layout::header::WIDTH), word(layout::header::HEIGHT)];
                let camera_offset = word(layout::header::CAMERA_OFFSET) as usize * 4;
                let packet = retained
                    .target(
                        &settings,
                        size,
                        word(layout::header::QUALITY_FLAGS) & 3,
                        0,
                        candidate.hwrt_shader,
                        &bytes[camera_offset..camera_offset + 128],
                        &snapshot.gpu.loss,
                        false,
                    )
                    .map_err(rejected)?;
                target = Some(candidate.target(packet, size, target.take())?);
            }
            candidate.retained = Some(retained);
            Ok((candidate, target, fallback_reason))
        })();
        // write_buffer queues staging allocations until the next submission.
        // Flush even rejected/cancelled candidates; a client need not render.
        if snapshot.gpu.loss.reason().is_none() {
            snapshot.gpu.queue.submit([]);
            snapshot.gpu.device.poll(wgpu::PollType::Poll)?;
        }
        result
    }));
    let panicked = outcome.is_err();
    let result = outcome.unwrap_or_else(|_| {
        Err(fail(
            Status::ContextFailed,
            "Native commit preparation panicked; context marked failed",
        ))
    });
    // Publication waits for any currently executing ABI operation, but never
    // holds the registry while waiting for CPU preparation. Cancellation wins
    // until this point; after publication the new scene is committed atomically.
    let mut slot = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let registry = &mut *slot;
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<()> {
        // Destroy cancels a pending commit before removing its context.
        let context = context(registry, handle).or_else(|error| {
            cancelled(&cancel)?;
            Err(error)
        })?;
        context.commit = None;
        if panicked {
            context.failed = true;
        }
        snapshot.gpu.loss.check()?;
        let (candidate, target, fallback_reason) = result?;
        cancelled(&cancel)?;
        retire_targets(registry, handle)?;
        let context = registry.contexts.get_mut(&handle).unwrap();
        // A pending render batch owns the old scene until its fence completes.
        if let Some(job) = context.job.as_mut() {
            if job.active() {
                job.cancelled = true;
                while job_active(context) {
                    advance_job(context, None, 0)?;
                    std::thread::yield_now();
                }
            }
        }
        if let Some(previous) = context.scene.replace(candidate) {
            context.spare_buffers = previous.buffers;
            context.spare_hardware = previous.hardware.map_or_else(HashMap::new, |h| h.inputs);
        }
        if let Some(previous) = std::mem::replace(&mut context.target, target) {
            context.spare_buffers.extend(previous.buffers);
        }
        context.fallback_reason = fallback_reason;
        context.descriptor = Some(shared.cloned().unwrap_or_else(|| Arc::new(bytes.to_vec())));
        context.last_commit = COMMIT_FULL;
        context.job = None;
        context.failed = false;
        Ok(())
    }))
    .unwrap_or_else(|_| {
        if let Some(context) = registry.contexts.get_mut(&handle) {
            context.failed = true;
            context.commit = None;
        }
        Err(fail(
            Status::ContextFailed,
            "Native commit publication panicked; context marked failed",
        ))
    });

    drop(slot);
    result.map(|_| CommitOutcome::Done)
}
/// State an incremental commit needs, or None when only full preparation applies.
fn incremental_candidate(
    context: &Context,
    bytes: &[u8],
    settings: &settings::RenderSettings,
) -> Option<(scene::PreparedState, Arc<Vec<u8>>)> {
    if context.failed || bytes.len() % 4 != 0 {
        return None;
    }
    let retained = context.scene.as_ref()?.retained.clone()?;
    if retained.settings != *settings {
        return None;
    }
    Some((retained, context.descriptor.clone()?))
}
/// Applies planned retained updates. Ok(false) leaves the scene for full preparation.
fn apply_incremental(
    context: &mut Context,
    retained: &scene::PreparedState,
    descriptor: &Arc<Vec<u8>>,
    steps: &[commit_plan::Step],
) -> Result<bool> {
    // As with full publication, an unfinished job is cancelled and drained first.
    if let Some(job) = context.job.as_mut() {
        if job.active() {
            job.cancelled = true;
            while job_active(context) {
                advance_job(context, None, 0)?;
                std::thread::yield_now();
            }
        }
    }
    for step in steps {
        let (input, length) = match step {
            commit_plan::Step::Geometry(b)
            | commit_plan::Step::Transform(b)
            | commit_plan::Step::Material(b)
            | commit_plan::Step::Light(b)
            | commit_plan::Step::Environment(b)
            | commit_plan::Step::Camera(b)
            | commit_plan::Step::LightList(b)
            | commit_plan::Step::InstanceColors(b)
            | commit_plan::Step::Atlas(b) => (b.as_ptr(), b.len()),
        };
        let applied = unsafe {
            match step {
                commit_plan::Step::Geometry(_) => update_geometry_in(context, input, length),
                commit_plan::Step::Transform(_) => update_transform_in(context, input, length),
                commit_plan::Step::Material(_) => update_material_in(context, input, length),
                commit_plan::Step::Light(_) => update_light_in(context, input, length),
                commit_plan::Step::Environment(_) => update_environment_in(context, input, length),
                commit_plan::Step::Camera(_) => update_camera_in(context, input, length),
                commit_plan::Step::LightList(bytes) => update_light_list_in(context, bytes),
                commit_plan::Step::InstanceColors(bytes) => {
                    update_instance_colors_in(context, bytes)
                }
                commit_plan::Step::Atlas(bytes) => update_atlas_in(context, bytes),
            }
        };
        match applied {
            Ok(()) => {}
            // Full preparation follows. Earlier steps already changed the scene, so
            // the descriptor no longer describes it if that preparation is rejected.
            Err(error)
                if classify(error.as_ref(), Status::Error) != Status::ContextFailed
                    && !context.failed =>
            {
                retained.reset_sync()?;
                context.descriptor = None;
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
    }
    // A commit always restarts accumulation, including an identical descriptor;
    // every retained update step already did.
    if steps.is_empty() {
        context.failed = true;
        context.reset_target()?;
        context.failed = false;
    }
    retained.accept_sync()?;
    context.descriptor = Some(descriptor.clone());
    context.last_commit = COMMIT_INCREMENTAL;
    context.job = None;
    Ok(true)
}
struct CommitSnapshot {
    scene_only: bool,
    gpu: GpuDevice,
    backend: u32,
    spare_buffers: HashMap<usize, wgpu::Buffer>,
    spare_hardware: HashMap<hardware::HardwareBufferId, wgpu::Buffer>,
}
fn cancelled(cancel: &PendingCommit) -> Result<()> {
    if cancel.cancelled.load(Ordering::Acquire) {
        Err(fail(Status::Cancelled, "Scene commit cancelled"))
    } else {
        Ok(())
    }
}
fn job_active(context: &Context) -> bool {
    context.job.as_ref().is_some_and(|j| j.active())
}
/// Request cancellation. The synchronous committing caller drains preparation
/// and releases the private candidate before returning; the old scene survives.
pub(crate) fn cancel_commit(handle: u64) -> Result<()> {
    with_registry(|registry| {
        if let Some(cancel) = &context(registry, handle)?.commit {
            cancel.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_cancel_commit(
    handle: u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    write_result(error, capacity, cancel_commit(handle))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_render(
    handle: u64,
    additional: u32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        ready(context)?;
        if additional == 0 || additional > 16384 - context.target.as_ref().map_or(0, |t| t.samples)
        {
            return Err(fail(
                Status::InvalidArgument,
                "Total samples must be 1..16384",
            ));
        }
        context.job = None;
        context.failed = true;
        context.scene.as_ref().unwrap().add_samples(
            context.target.as_mut().ok_or("No render target")?,
            additional,
        )?;
        context.failed = false;
        Ok(())
    })
}
pub(crate) fn reset(handle: u64) -> Result<()> {
    with_registry(|registry| {
        let (context, linked) = with_scene(registry, handle)?;
        idle(context)?;
        context.failed = true;
        let (scene, target) = render_parts(context, linked)?;
        scene.reset_target(target)?;
        context.job = None;
        context.failed = false;
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_reset(handle: u64, error: *mut c_char, capacity: usize) -> i32 {
    write_result(error, capacity, reset(handle))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_wait(
    handle: u64,
    timeout_ms: u32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    action(error, capacity, |registry| {
        let context = context(registry, handle)?;
        idle(context)?;
        if context.link.is_none() {
            ready(context)?;
        }
        // UINT32_MAX (MT_WAIT_INDEFINITELY) waits without a deadline.
        let timeout = (timeout_ms != u32::MAX).then(|| Duration::from_millis(timeout_ms.into()));
        match context.gpu.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout,
        }) {
            Ok(_) => Ok(()),
            Err(wgpu::PollError::Timeout) => Err(fail(
                Status::Timeout,
                "Submitted GPU work did not complete before the timeout",
            )),
            Err(error) => Err(error.into()),
        }
    })
}
/// Validated camera update on an idle context; used by incremental commit.
unsafe fn update_camera_in(context: &mut Context, input: *const u8, length: usize) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length != 128 {
        return Err(fail(
            Status::InvalidArgument,
            "Camera descriptor must contain exactly 128 bytes",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed =
        scene::prepare_camera(bytes, scene.scene.width, scene.scene.height).map_err(rejected)?;
    context.failed = true;
    if let Some(target) = &context.target {
        let buffer = &target.buffers[&layout::resource::CAMERA];
        if packed.len() != 144 || buffer.size() != 144 {
            return Err("Camera uniform size mismatch".into());
        }
        context.gpu.queue.write_buffer(buffer, 0, &packed);
    }
    context.finish_update()
}
/// Validated material update on an idle context; used by incremental commit.
unsafe fn update_material_in(context: &mut Context, input: *const u8, length: usize) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length != 48 {
        return Err(fail(
            Status::InvalidArgument,
            "Material descriptor must contain exactly 48 bytes",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained material preparation")?
        .material(bytes)
        .map_err(rejected)?;
    context.failed = true;
    context.scene.as_mut().unwrap().update_material(&packed)?;
    context.finish_update()
}
/// Validated environment update on an idle context; used by incremental commit.
unsafe fn update_environment_in(
    context: &mut Context,
    input: *const u8,
    length: usize,
) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length < 48 || length > scene::MAX_BYTES {
        return Err(fail(
            Status::InvalidArgument,
            "Invalid environment descriptor length",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained environment preparation")?
        .environment(bytes)
        .map_err(rejected)?;
    context
        .scene
        .as_ref()
        .unwrap()
        .validate_lighting(&packed, context.target.as_ref())?;
    context.failed = true;
    context
        .scene
        .as_mut()
        .unwrap()
        .update_lighting(&packed, context.target.as_ref())?;
    context
        .scene
        .as_ref()
        .unwrap()
        .retained
        .as_ref()
        .unwrap()
        .accept_lighting()?;
    context.finish_update()
}
/// Validated geometry update on an idle context; used by incremental commit.
unsafe fn update_geometry_in(context: &mut Context, input: *const u8, length: usize) -> Result<()> {
    ready(context)?;
    let scene = context.scene.as_mut().unwrap();
    if input.is_null() || length < 16 || length > scene::MAX_BYTES {
        return Err(fail(
            Status::InvalidArgument,
            "Invalid geometry update length",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained geometry preparation")?
        .geometry(bytes)
        .map_err(rejected)?;
    scene.validate_lighting(&packed, context.target.as_ref())?;
    let hardware = scene.prepare_geometry_hardware(&packed)?;
    context.failed = true;
    let scene = context.scene.as_mut().unwrap();
    if let Some((resources, capture, group, attributes)) = hardware {
        if let Some(buffer) = attributes {
            scene.buffers.insert(3, buffer);
        }
        scene.hardware = Some(resources);
        scene.scene.hwrt = Some(capture);
        scene.groups[0] = group;
    }
    scene.update_lighting(&packed, context.target.as_ref())?;
    scene.retained.as_ref().unwrap().accept_geometry()?;
    context.finish_update()
}
/// Validated transform update on an idle context; used by incremental commit.
unsafe fn update_transform_in(
    context: &mut Context,
    input: *const u8,
    length: usize,
) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length != 80 {
        return Err(fail(
            Status::InvalidArgument,
            "Transform descriptor must contain exactly 80 bytes",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained transform preparation")?
        .transform(bytes)
        .map_err(rejected)?;
    apply_instance_writes(context, &packed)
}
/// Material table and atlas repack after texture edits (incremental commit only).
fn update_atlas_in(context: &mut Context, bytes: &[u8]) -> Result<()> {
    let scene = ready(context)?;
    let retained = scene
        .retained
        .clone()
        .ok_or("No retained material preparation")?;
    let packed = retained.atlas(bytes).map_err(rejected)?;
    context
        .scene
        .as_ref()
        .unwrap()
        .validate_lighting(&packed, context.target.as_ref())?;
    context.failed = true;
    context
        .scene
        .as_mut()
        .unwrap()
        .update_lighting(&packed, context.target.as_ref())?;
    retained.accept_lighting()?;
    context.finish_update()
}
/// Instance color update for one batch (incremental commit only).
fn update_instance_colors_in(context: &mut Context, bytes: &[u8]) -> Result<()> {
    let scene = ready(context)?;
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained transform preparation")?
        .instance_colors(bytes)
        .map_err(rejected)?;
    apply_instance_writes(context, &packed)
}
/// Applies prepared TLAS, instance and lighting writes, then accepts the transform stage.
fn apply_instance_writes(context: &mut Context, packed: &scene::LightingUpdates) -> Result<()> {
    ready(context)?;
    let scene = context.scene.as_mut().unwrap();
    scene.validate_lighting(packed, context.target.as_ref())?;
    let hardware = scene
        .hardware
        .as_ref()
        .map(|hw| hw.transform_plan(scene.scene.hwrt.as_ref().unwrap(), packed))
        .transpose()?;
    context.failed = true;
    let scene = context.scene.as_mut().unwrap();
    if let Some(plan) = hardware {
        scene.hardware.as_mut().unwrap().update_transforms(
            &scene.gpu.device,
            &scene.gpu.queue,
            plan,
            scene.scene.hwrt.as_mut().unwrap(),
        )?;
    }
    scene.update_lighting(packed, context.target.as_ref())?;
    scene.retained.as_ref().unwrap().accept_transform()?;
    context.finish_update()
}
/// Validated light update on an idle context; used by incremental commit.
unsafe fn update_light_in(context: &mut Context, input: *const u8, length: usize) -> Result<()> {
    let scene = ready(context)?;
    if input.is_null() || length != 128 {
        return Err(fail(
            Status::InvalidArgument,
            "Light descriptor must contain exactly 128 bytes",
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(input, length) };
    let packed = scene
        .retained
        .as_ref()
        .ok_or("No retained light preparation")?
        .light(bytes)
        .map_err(rejected)?;
    context
        .scene
        .as_ref()
        .unwrap()
        .validate_lighting(&packed, context.target.as_ref())?;
    context.failed = true;
    context
        .scene
        .as_mut()
        .unwrap()
        .update_lighting(&packed, context.target.as_ref())?;
    context
        .scene
        .as_ref()
        .unwrap()
        .retained
        .as_ref()
        .unwrap()
        .accept_lighting()?;
    context.finish_update()
}
/// Replaces the analytic light list from a validated full descriptor.
fn update_light_list_in(context: &mut Context, bytes: &[u8]) -> Result<()> {
    let scene = ready(context)?;
    let retained = scene
        .retained
        .clone()
        .ok_or("No retained light preparation")?;
    let packed = retained.light_list(bytes)?;
    context
        .scene
        .as_ref()
        .unwrap()
        .validate_lighting(&packed, context.target.as_ref())?;
    context.failed = true;
    context
        .scene
        .as_mut()
        .unwrap()
        .update_lighting(&packed, context.target.as_ref())?;
    retained.accept_lighting()?;
    retained.set_light_count(u32::from_le_bytes(
        bytes[layout::header::LIGHT_COUNT * 4..][..4].try_into()?,
    ) as usize);
    context.finish_update()
}
pub(crate) fn info(handle: u64) -> Result<ContextInfo> {
    with_registry(|registry| {
        let context = context(registry, handle)?;
        let (width, height, samples) = context
            .target
            .as_ref()
            .map(|t| (t.width, t.height, t.samples))
            .unwrap_or((0, 0, 0));
        Ok(ContextInfo {
            struct_size: std::mem::size_of::<ContextInfo>() as u32,
            width,
            height,
            samples,
            state: if context.failed {
                2
            } else if context.job.as_ref().is_some_and(|j| j.active()) {
                3
            } else if context.scene.is_some() || context.link.as_ref().is_some_and(|l| l.current) {
                1
            } else {
                0
            },
            last_commit: context.last_commit,
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_info(
    handle: u64,
    info: *mut ContextInfo,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    let result = self::info(handle).and_then(|value| {
        if info.is_null()
            || unsafe { info.cast::<u32>().read() } as usize != std::mem::size_of::<ContextInfo>()
        {
            return Err(fail(Status::InvalidArgument, "Context info size mismatch"));
        }
        unsafe {
            info.write(value);
        }
        Ok(())
    });
    write_result(error, capacity, result)
}
/// Internal L1 HDR conversion; never changes the public L0 readback contract.
pub(crate) fn read_hdr(handle: u64) -> Result<Vec<f32>> {
    with_registry(|registry| {
        let (context, linked) = with_scene(registry, handle)?;
        idle(context)?;
        if context.target.as_ref().is_none_or(|t| t.samples == 0) {
            return Err(fail(Status::InvalidState, "No completed samples"));
        }
        context.failed = true;
        let (scene, target) = render_parts(context, linked)?;
        let output = scene.read_hdr(target)?;
        context.failed = false;
        Ok(output)
    })
}

// Initialize the destination before scene validation, then query its capacity
// before GPU readback; both callbacks run inside the same registry boundary.
fn read_pixels_with(
    handle: u64,
    kind: u32,
    initialize: impl FnOnce() -> Result<()>,
    read: impl FnOnce(usize) -> Result<bool>,
) -> Result<Option<Vec<u8>>> {
    with_registry(|registry| {
        initialize()?;
        let (context, linked) = with_scene(registry, handle)?;
        idle(context)?;
        let target = context.target.as_ref().ok_or("No render target")?;
        let (samples, width, height) = (target.samples, target.width, target.height);
        if kind > 2 {
            return Err(fail(Status::InvalidArgument, "Unknown image kind"));
        }
        if samples == 0 {
            return Err(fail(Status::InvalidState, "No completed samples"));
        }
        let required = width as usize * height as usize * 16;
        if !read(required)? {
            return Ok(None);
        }
        context.failed = true;
        let (scene, target) = render_parts(context, linked)?;
        let values = scene.read_target(target, kind)?;
        context.failed = false;
        Ok(Some(values))
    })
}
pub(crate) fn read_pixels(handle: u64, kind: u32) -> Result<Vec<f32>> {
    Ok(bytemuck::pod_collect_to_vec(
        &read_pixels_with(handle, kind, || Ok(()), |_| Ok(true))?.unwrap(),
    ))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_read_pixels(
    handle: u64,
    kind: u32,
    pixels: *mut u8,
    size: usize,
    written: *mut usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    let result = read_pixels_with(
        handle,
        kind,
        || {
            if written.is_null() {
                return Err(fail(Status::InvalidArgument, "Null pixel length output"));
            }
            unsafe {
                *written = 0;
            }
            Ok(())
        },
        |required| {
            unsafe {
                *written = required;
            }
            if pixels.is_null() && size == 0 {
                return Ok(false);
            }
            if pixels.is_null() {
                return Err(fail(Status::InvalidArgument, "Null pixel destination"));
            }
            if size < required {
                return Err(fail(
                    Status::BufferTooSmall,
                    "Pixel destination is too small",
                ));
            }
            Ok(true)
        },
    );
    let result = result.map(|values| {
        if let Some(values) = values {
            unsafe {
                std::ptr::copy_nonoverlapping(values.as_ptr(), pixels, values.len());
            }
        }
    });
    write_result(error, capacity, result)
}

#[repr(C)]
pub struct JobInfo {
    pub struct_size: u32,
    pub state: u32,
    pub requested_samples: u32,
    pub submitted_samples: u32,
    pub completed_samples: u32,
    pub base_samples: u32,
}
fn job_context(registry: &mut Registry, id: u64) -> Result<&mut Context> {
    let handle = job_handle(registry, id)?;
    Ok(registry.contexts.get_mut(&handle).unwrap())
}
fn job_handle(registry: &mut Registry, id: u64) -> Result<u64> {
    let (handle, context) = registry
        .contexts
        .iter_mut()
        .find(|(_, c)| c.job.as_ref().is_some_and(|j| j.id == id))
        .ok_or_else(|| fail(Status::InvalidHandle, "Invalid or expired render job"))?;
    if TOUCHED.get().is_none() {
        TOUCHED.set(Some((*handle, context.failed)));
    }
    Ok(*handle)
}

pub(crate) fn submit(handle: u64, additional: u32) -> Result<u64> {
    with_registry(|registry| {
        let id = registry.next;
        let next = id.checked_add(1).ok_or("Native handles exhausted")?;
        let (context, linked) = with_scene(registry, handle)?;
        idle(context)?;
        let (_, target) = render_parts(context, linked)?;
        let base = target.samples;
        if additional == 0 || additional > 16384 - base {
            return Err(fail(
                Status::InvalidArgument,
                "Total samples must be 1..16384",
            ));
        }
        context.job = Some(RenderJob {
            id,
            base,
            requested: additional,
            submitted: 0,
            completed: 0,
            state: JobState::Queued,
            cancelled: false,
            flight: None,
            gpu_ms: Some(0.),
        });
        registry.next = next;
        Ok(id)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_submit(
    handle: u64,
    additional: u32,
    output: *mut u64,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    let result = if output.is_null() {
        with_registry(|_| Err(fail(Status::InvalidArgument, "Null render job output")))
    } else {
        submit(handle, additional).map(|id| unsafe { *output = id })
    };
    write_result(error, capacity, result)
}
/// GPU trace time of the most recently completed job; no readback waits.
pub(crate) fn job_gpu_time(handle: u64) -> Option<f64> {
    let slot = REGISTRY.try_lock().ok()?;
    slot.contexts.get(&handle)?.job.as_ref()?.gpu_ms
}
/// `owner` is the scene a linked context renders; it is needed only to dispatch.
fn advance_job(context: &mut Context, owner: Option<&GpuScene>, budget: u32) -> Result<()> {
    if let Err(error) = context.gpu.loss.check() {
        if let Some(history) = context
            .target
            .as_mut()
            .and_then(|t| t.frame_inputs.as_mut())
        {
            history.device_lost();
        }
        context.failed = true;
        if let Some(job) = context.job.as_mut() {
            job.state = JobState::Failed;
            job.flight = None;
        }
        return Err(error);
    }
    let Context {
        scene: own,
        job,
        target,
        gpu,
        ..
    } = context;
    let job = job.as_mut().ok_or("Missing render job")?;
    if !job.active() {
        return Ok(());
    }
    gpu.device.poll(wgpu::PollType::Poll)?;
    gpu.loss.check()?;
    if job
        .flight
        .as_ref()
        .is_some_and(|f| f.done.load(Ordering::Acquire))
    {
        if job
            .flight
            .as_ref()
            .and_then(|f| f.timer.as_ref())
            .is_some_and(|(_, rx)| matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)))
        {
            return Ok(());
        }
        let flight = job.flight.take().unwrap();
        let measured = flight
            .timer
            .and_then(|(timer, _)| timer.mapped_milliseconds(&gpu.queue));
        job.gpu_ms = job.gpu_ms.zip(measured).map(|(sum, ms)| sum + ms);
        target.as_mut().ok_or("No render target")?.samples = flight.end;
        job.completed = flight.end - job.base;
    }
    if job.flight.is_some() {
        return Ok(());
    }
    if job.completed == job.requested {
        job.state = JobState::Complete;
        return Ok(());
    }
    if job.cancelled {
        job.state = JobState::Cancelled;
        return Ok(());
    }
    if budget == 0 {
        return Ok(());
    }
    let count = budget.min(job.requested - job.submitted);
    let start = job.base + job.submitted;
    let timer = crate::profiling::GpuTimer::realtime(
        &gpu.device,
        count
            * target
                .as_ref()
                .and_then(|t| t.caustics.as_ref())
                .map_or(1, |c| c.pass_count()),
        false,
    );
    let scene = owner
        .or(own.as_ref())
        .ok_or("Missing render target scene")?;
    scene.dispatch_target(
        target.as_ref().ok_or("No render target")?,
        start,
        count,
        timer.as_ref(),
    )?;
    let done = Arc::new(AtomicBool::new(false));
    let signal = done.clone();
    gpu.queue
        .on_submitted_work_done(move || signal.store(true, Ordering::Release));
    job.submitted += count;
    job.flight = Some(Flight {
        end: job.base + job.submitted,
        done,
        timer: timer.map(|timer| {
            let rx = timer.map();
            (timer, rx)
        }),
    });
    job.state = JobState::Running;
    Ok(())
}
pub(crate) fn poll_job(id: u64, budget: u32) -> Result<()> {
    with_registry(|registry| {
        if budget > 64 {
            return Err(fail(
                Status::InvalidArgument,
                "Poll dispatch budget must be 0..64 samples",
            ));
        }
        let handle = job_handle(registry, id)?;
        let active = registry.contexts[&handle]
            .job
            .as_ref()
            .is_some_and(|j| j.active());
        let (context, owner) = if active && registry.contexts[&handle].link.is_some() {
            with_scene(registry, handle)?
        } else {
            (registry.contexts.get_mut(&handle).unwrap(), None)
        };
        if context.failed {
            return Err(fail(
                Status::InvalidState,
                "Render scene failed; commit a new scene",
            ));
        }
        context.failed = true;
        let result = advance_job(context, owner.as_deref(), budget);
        if result.is_err() {
            context.job.as_mut().unwrap().state = JobState::Failed;
        } else {
            context.failed = false;
        }
        result
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_job_poll(
    id: u64,
    budget: u32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    write_result(error, capacity, poll_job(id, budget))
}
pub(crate) fn job_info(id: u64) -> Result<JobInfo> {
    with_registry(|registry| {
        let context = job_context(registry, id)?;
        let job = context.job.as_ref().unwrap();
        Ok(JobInfo {
            struct_size: std::mem::size_of::<JobInfo>() as u32,
            state: if context.failed {
                JobState::Failed as u32
            } else {
                job.state as u32
            },
            requested_samples: job.requested,
            submitted_samples: job.submitted,
            completed_samples: job.completed,
            base_samples: job.base,
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_job_info(
    id: u64,
    info: *mut JobInfo,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    let result = self::job_info(id).and_then(|value| {
        if info.is_null() || unsafe { (*info).struct_size } != std::mem::size_of::<JobInfo>() as u32
        {
            return Err(fail(Status::InvalidArgument, "Job info size mismatch"));
        }
        unsafe {
            info.write(value);
        }
        Ok(())
    });
    write_result(error, capacity, result)
}
pub(crate) fn cancel_job(id: u64) -> Result<()> {
    with_registry(|registry| {
        let context = job_context(registry, id)?;
        let job = context.job.as_mut().unwrap();
        if !job.active() {
            return Ok(());
        }
        job.cancelled = true;
        job.state = if job.flight.is_some() {
            JobState::Cancelling
        } else {
            JobState::Cancelled
        };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_job_cancel(id: u64, error: *mut c_char, capacity: usize) -> i32 {
    write_result(error, capacity, cancel_job(id))
}

#[cfg(test)]
mod target_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn preparation_does_not_block_render_and_cancellation_preserves_old_scene() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        unsafe {
            assert_eq!(
                mt_context_create_with_backend(0, &mut handle, error.as_mut_ptr(), error.len()),
                0,
                "GPU validation requires a working device"
            );
            let input = scene::tests::input();
            assert_eq!(
                mt_context_commit(
                    handle,
                    input.as_ptr(),
                    input.len(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            let mut active = 99;
            let mut reason = [0i8; 128];
            assert_eq!(
                mt_context_backend(
                    handle,
                    &mut active,
                    reason.as_mut_ptr(),
                    reason.len(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert_eq!(active, 0);
            // Software Vulkan drivers can compile the first dispatch lazily.
            // Warm that path before testing progress while preparation is blocked.
            assert_eq!(
                mt_context_render(handle, 1, error.as_mut_ptr(), error.len()),
                0
            );
            assert_eq!(mt_context_reset(handle, error.as_mut_ptr(), error.len()), 0);
        }
        let (started, entered) = mpsc::sync_channel(1);
        let (resume, resumed) = mpsc::sync_channel(1);
        runtime::enqueue(move || {
            started.send(()).unwrap();
            resumed.recv_timeout(Duration::from_secs(15)).unwrap();
        });
        entered.recv().unwrap();
        let committing = std::thread::spawn(move || {
            let input = scene::tests::input();
            let mut error = [0i8; 512];
            loop {
                let code = unsafe {
                    mt_context_commit(
                        handle,
                        input.as_ptr(),
                        input.len(),
                        error.as_mut_ptr(),
                        error.len(),
                    )
                };
                if code == 0
                    || !unsafe { CStr::from_ptr(error.as_ptr()) }
                        .to_string_lossy()
                        .contains("registry is active")
                {
                    return code;
                }
                std::thread::yield_now();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let preparing = REGISTRY.lock().unwrap().contexts[&handle].commit.is_some();
            if preparing {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        unsafe {
            let mut job = 0;
            assert_eq!(
                mt_context_submit(handle, 1, &mut job, error.as_mut_ptr(), error.len()),
                0
            );
            assert_eq!(mt_job_poll(job, 1, error.as_mut_ptr(), error.len()), 0);
            assert_eq!(
                mt_context_cancel_commit(handle, error.as_mut_ptr(), error.len()),
                0
            );
            loop {
                assert_eq!(mt_job_poll(job, 0, error.as_mut_ptr(), error.len()), 0);
                if !job_active(&REGISTRY.lock().unwrap().contexts[&handle]) {
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        resume.send(()).unwrap();
        assert_eq!(committing.join().unwrap(), Status::Cancelled as i32);
        let mut before = vec![0u8; 8 * 8 * 16];
        let mut after = before.clone();
        let mut written = 0;
        unsafe {
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    0,
                    before.as_mut_ptr(),
                    before.len(),
                    &mut written,
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert_eq!(mt_context_reset(handle, error.as_mut_ptr(), error.len()), 0);
            assert_eq!(
                mt_context_render(handle, 1, error.as_mut_ptr(), error.len()),
                0
            );
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    0,
                    after.as_mut_ptr(),
                    after.len(),
                    &mut written,
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert_eq!(before, after);
            assert_eq!(
                mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
        // No creating-thread binding survives teardown, and eight is not a cap.
        std::thread::spawn(|| {
            let mut handles = Vec::new();
            let mut error = [0i8; 512];
            for _ in 0..9 {
                let mut handle = 0;
                unsafe {
                    assert_eq!(
                        mt_context_create_with_backend(
                            0,
                            &mut handle,
                            error.as_mut_ptr(),
                            error.len()
                        ),
                        0
                    );
                }
                handles.push(handle);
            }
            for handle in handles {
                unsafe {
                    assert_eq!(
                        mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                        0
                    );
                }
            }
        })
        .join()
        .unwrap();
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn destroy_cancels_and_drains_an_unpublished_candidate() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        assert_eq!(
            unsafe {
                mt_context_create_with_backend(0, &mut handle, error.as_mut_ptr(), error.len())
            },
            0,
            "GPU validation requires a working device"
        );
        let (entered, started) = mpsc::sync_channel(1);
        let (resume, resumed) = mpsc::sync_channel(1);
        runtime::enqueue(move || {
            entered.send(()).unwrap();
            resumed.recv_timeout(Duration::from_secs(15)).unwrap();
        });
        started.recv().unwrap();
        let committing = std::thread::spawn(move || {
            let bytes = scene::tests::input();
            let mut error = [0i8; 512];
            loop {
                let code = unsafe {
                    mt_context_commit(
                        handle,
                        bytes.as_ptr(),
                        bytes.len(),
                        error.as_mut_ptr(),
                        error.len(),
                    )
                };
                if !unsafe { CStr::from_ptr(error.as_ptr()) }
                    .to_string_lossy()
                    .contains("registry is active")
                {
                    return code;
                }
                std::thread::yield_now();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let pending = loop {
            let pending = REGISTRY.lock().unwrap().contexts[&handle].commit.clone();
            if let Some(pending) = pending {
                break pending;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        };
        let destroying = std::thread::spawn(move || {
            let mut error = [0i8; 512];
            unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) }
        });
        while !pending.cancelled.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(!destroying.is_finished());
        resume.send(()).unwrap();
        assert_eq!(committing.join().unwrap(), Status::Cancelled as i32);
        assert_eq!(destroying.join().unwrap(), 0);
        assert!(*pending.finished.lock().unwrap());
        assert!(!REGISTRY.lock().unwrap().contexts.contains_key(&handle));
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn shared_device_preview_survives_reset_and_context_destruction() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .expect("GPU validation requires an adapter");
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .unwrap();
        let handle = create_on_device(&adapter, &device, &queue, 0).unwrap();
        let mut input = scene::tests::input();
        input[118 * 4..119 * 4].copy_from_slice(&3f32.to_le_bytes());
        let mut error = [0i8; 4096];
        unsafe {
            assert_eq!(
                mt_context_commit(
                    handle,
                    input.as_ptr(),
                    input.len(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert_eq!(
                mt_context_render(handle, 3, error.as_mut_ptr(), error.len()),
                0
            );
        }
        let mut display = None;
        assert!(capture_display(handle, &mut display).unwrap());
        let display = display.unwrap();
        let before = display.read_linear().unwrap();
        assert_eq!(before.len(), 8 * 8 * 4);
        unsafe {
            assert_eq!(mt_context_reset(handle, error.as_mut_ptr(), error.len()), 0);
        }
        assert_eq!(display.read_linear().unwrap(), before);
        unsafe {
            assert_eq!(
                mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
        display.compose(0.);
        assert_eq!(display.read_linear().unwrap(), before);
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn changed_blas_and_tlas_are_ready_after_interleaved_retained_edits() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let gpu = GpuDevice::with_backend(1).expect("GPU validation requires a working device");
        assert!(gpu.hardware_ray_query, "GPU validation requires HWRT");
        let make = |input: &[u8]| {
            let (mut scene, mut assets, retained) = scene::prepare_retained(input, true).unwrap();
            scene.hwrt = Some(
                hardware::capture_from_resources(
                    &mut assets,
                    scene.native_layout.as_ref().unwrap(),
                )
                .unwrap(),
            );
            sample_audit::install(&mut scene, &mut assets).unwrap();
            let (mut result, target) = GpuScene::new(
                scene,
                &RenderOptions {
                    flags: 4,
                    ..Default::default()
                },
                &assets,
                gpu.clone(),
            )
            .unwrap();
            assert!(result.hardware.is_some());
            result.retained = Some(retained);
            (result, target)
        };
        'attempts: for attempt in 0..=3 {
            for optional_refit in [false, true] {
                #[cfg(not(target_os = "macos"))]
                if optional_refit {
                    continue;
                }
                let mut input = scene::tests::input();
                input[118 * 4..119 * 4].copy_from_slice(&3f32.to_le_bytes());
                let (mut state, mut state_target) = make(&input);
                state.hardware.as_mut().unwrap().metal_refit_opt_in = optional_refit;
                let mut transform = [0u32; 20];
                transform[0] = 1;
                for index in [0, 5, 10, 15] {
                    transform[4 + index] = 1f32.to_bits();
                }
                transform[16] = 0.125f32.to_bits();
                let bytes: Vec<_> = transform.iter().flat_map(|v| v.to_le_bytes()).collect();
                let writes = state.retained.as_ref().unwrap().transform(&bytes).unwrap();
                let plan = state
                    .hardware
                    .as_ref()
                    .unwrap()
                    .transform_plan(state.scene.hwrt.as_ref().unwrap(), &writes)
                    .unwrap();
                state
                    .hardware
                    .as_mut()
                    .unwrap()
                    .update_transforms(
                        &state.gpu.device,
                        &state.gpu.queue,
                        plan,
                        state.scene.hwrt.as_mut().unwrap(),
                    )
                    .unwrap();
                state.update_lighting(&writes, Some(&state_target)).unwrap();
                state.reset_target(&mut state_target).unwrap();
                state.retained.as_ref().unwrap().accept_transform().unwrap();
                input[60 * 4..61 * 4].copy_from_slice(&0.125f32.to_le_bytes());
                let original = f32::from_le_bytes(input[120 * 4..121 * 4].try_into().unwrap());
                for (step, shift) in [0.05f32, 0.1, 0.0].into_iter().enumerate() {
                    input[120 * 4..121 * 4].copy_from_slice(&(original + shift).to_le_bytes());
                    let mut bytes: Vec<_> = [1u32, 0, 3, 0]
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect();
                    bytes.extend_from_slice(&input[120 * 4..129 * 4]);
                    let writes = state.retained.as_ref().unwrap().geometry(&bytes).unwrap();
                    assert_eq!(writes.changed_blases.as_deref(), Some(&[0][..]));
                    let (resources, capture, group, attributes) =
                        state.prepare_geometry_hardware(&writes).unwrap().unwrap();
                    assert!(attributes.is_none());
                    assert_eq!(resources.used_metal_refit, optional_refit && step > 0);
                    state.hardware = Some(resources);
                    state.scene.hwrt = Some(capture);
                    state.groups[0] = group;
                    state.update_lighting(&writes, Some(&state_target)).unwrap();
                    state.reset_target(&mut state_target).unwrap();
                    state.retained.as_ref().unwrap().accept_geometry().unwrap();
                    let (expected, mut expected_target) = make(&input);
                    for (current, target) in
                        [(&state, &state_target), (&expected, &expected_target)]
                    {
                        current.gpu.queue.write_buffer(
                            &target.buffers[&layout::resource::QUERY_COUNTS],
                            0,
                            &vec![
                                0;
                                current.scene.width as usize * current.scene.height as usize * 16
                            ],
                        );
                    }
                    for sample in 0..8 {
                        state.add_samples(&mut state_target, 1).unwrap();
                        expected.add_samples(&mut expected_target, 1).unwrap();
                        let a = sample_audit::read(&state, &state_target, sample).unwrap();
                        let b = sample_audit::read(&expected, &expected_target, sample).unwrap();
                        let evidence = sample_audit::evidence(&a, Some(&b));
                        let invalid = a.invalid_pixels > 0 || b.invalid_pixels > 0;
                        let mut changed = Vec::new();
                        for kind in 0..3 {
                            let actual = state.read_target(&state_target, kind).unwrap();
                            let reference = expected.read_target(&expected_target, kind).unwrap();
                            if actual != reference
                                || !actual
                                    .chunks_exact(4)
                                    .chain(reference.chunks_exact(4))
                                    .all(|v| f32::from_le_bytes(v.try_into().unwrap()).is_finite())
                            {
                                changed.push(kind);
                            }
                        }
                        if invalid || evidence.is_some() || !changed.is_empty() {
                            let test = format!("interleaved-retained-edits-refit{optional_refit}");
                            let retry = sample_audit::retry_event(
                                &test,
                                attempt,
                                step,
                                sample,
                                evidence.as_ref(),
                                &input,
                                [(&state, &state_target), (&expected, &expected_target)],
                            )
                            .unwrap();
                            assert!(
                                retry,
                                "{test} step {step} sample {sample}: audit {a:?}/{b:?}, changed {changed:?}; no permitted rerun remains"
                            );
                            continue 'attempts;
                        }
                    }
                }
            }
            break;
        }
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn rejected_hardware_candidate_can_render_the_rebuilt_software_scene() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let gpu = GpuDevice::with_backend(1).expect("GPU validation requires a working device");
        assert!(gpu.hardware_ray_query, "GPU validation requires HWRT");
        let mut input = scene::tests::input();
        input[118 * 4..119 * 4].copy_from_slice(&3f32.to_le_bytes());
        let (mut direct, mut assets, mut retained) = scene::prepare_retained(&input, true).unwrap();
        let mut capture =
            hardware::capture_from_resources(&mut assets, direct.native_layout.as_ref().unwrap())
                .unwrap();
        capture.eligible = false;
        direct.hwrt = Some(capture);
        let fallback_source = direct.clone();
        let rejected = GpuScene::new(
            direct,
            &RenderOptions {
                flags: 4,
                ..Default::default()
            },
            &assets,
            gpu.clone(),
        );
        assert!(rejected.is_err());
        let software =
            prepare_software_fallback(&input, fallback_source, &mut assets, &mut retained).unwrap();
        let (state, mut state_target) =
            GpuScene::new(software, &RenderOptions::default(), &assets, gpu.clone()).unwrap();
        let (reference, reference_assets, _reference_retained) =
            scene::prepare_retained(&input, false).unwrap();
        let (expected, mut expected_target) =
            GpuScene::new(reference, &RenderOptions::default(), &reference_assets, gpu).unwrap();
        state.add_samples(&mut state_target, 1).unwrap();
        expected.add_samples(&mut expected_target, 1).unwrap();
        for kind in 0..3 {
            assert_eq!(
                state.read_target(&state_target, kind).unwrap(),
                expected.read_target(&expected_target, kind).unwrap()
            );
        }
        assert!(
            state
                .read_target(&state_target, 2)
                .unwrap()
                .chunks_exact(4)
                .any(|b| f32::from_le_bytes(b.try_into().unwrap()) > 0.)
        );
    }
    #[test]
    fn direct_as_fallback_rebuilds_software_and_retained_edits() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let input = scene::tests::input();
        let (direct, mut assets, mut retained) = scene::prepare_retained(&input, true).unwrap();
        assert!(direct.native_layout.as_ref().unwrap().indexed);
        let software =
            prepare_software_fallback(&input, direct, &mut assets, &mut retained).unwrap();
        let (expected, expected_assets, expected_retained) =
            scene::prepare_retained(&input, false).unwrap();
        assert!(!software.native_layout.as_ref().unwrap().indexed);
        assert!(software.hwrt.is_none());
        assert_eq!(software.shader, expected.shader);
        assert_eq!(assets, expected_assets);
        let patch: Vec<u8> = [
            1u32,
            0,
            0,
            0,
            0.2f32.to_bits(),
            0.4f32.to_bits(),
            0.8f32.to_bits(),
            0.3f32.to_bits(),
            0,
            0,
            1.5f32.to_bits(),
            0,
        ]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect();
        assert_eq!(
            retained.material(&patch).unwrap(),
            expected_retained.material(&patch).unwrap()
        );
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn panic_marks_the_touched_context_failed_and_commit_recovers_it() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        assert_eq!(
            unsafe {
                mt_context_create_with_backend(0, &mut handle, error.as_mut_ptr(), error.len())
            },
            0,
            "GPU validation requires a working device"
        );
        let typed = with_registry::<()>(|registry| {
            context(registry, handle)?.failed = true;
            Err("typed execution failure".into())
        })
        .unwrap_err();
        assert_eq!(
            classify(typed.as_ref(), Status::Error),
            Status::ContextFailed
        );
        with_registry(|registry| {
            context(registry, handle)?.failed = false;
            Ok(())
        })
        .unwrap();
        let typed = with_registry::<()>(|registry| {
            context(registry, handle)?;
            panic!("typed context panic");
        })
        .unwrap_err();
        assert_eq!(
            classify(typed.as_ref(), Status::Error),
            Status::ContextFailed
        );
        with_registry(|registry| {
            context(registry, handle)?.failed = false;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            action(error.as_mut_ptr(), error.len(), |registry| {
                let _ = context(registry, handle)?;
                panic!("context-specific boundary probe");
            }),
            Status::ContextFailed as i32
        );
        assert!(REGISTRY.lock().unwrap().contexts[&handle].failed);
        let input = scene::tests::input();
        unsafe {
            assert_eq!(
                mt_context_commit(
                    handle,
                    input.as_ptr(),
                    input.len(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
            assert!(!REGISTRY.lock().unwrap().contexts[&handle].failed);
            assert_eq!(
                mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn snapshot_reports_the_path_of_the_last_successful_commit() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        assert_eq!(
            unsafe {
                mt_context_create_with_backend(0, &mut handle, error.as_mut_ptr(), error.len())
            },
            0,
            "GPU validation requires a working device"
        );
        let info = |size: usize| {
            let mut info = ContextInfo {
                struct_size: size as u32,
                width: 0,
                height: 0,
                samples: 0,
                state: 0,
                last_commit: 99,
            };
            let mut error = [0i8; 128];
            let status =
                unsafe { mt_context_info(handle, &mut info, error.as_mut_ptr(), error.len()) };
            (status, info.last_commit)
        };
        let size = std::mem::size_of::<ContextInfo>();
        assert_eq!(info(size), (0, COMMIT_NONE));
        // Old and oversized snapshots are rejected without writing the record.
        assert_eq!(info(size - 4), (Status::InvalidArgument as i32, 99));
        assert_eq!(info(size + 4).0, Status::InvalidArgument as i32);
        let input = scene::tests::input();
        let commit = |bytes: &[u8]| {
            let mut error = [0i8; 512];
            unsafe {
                mt_context_commit(
                    handle,
                    bytes.as_ptr(),
                    bytes.len(),
                    error.as_mut_ptr(),
                    error.len(),
                )
            }
        };
        assert_eq!(commit(&input), 0);
        assert_eq!(info(size), (0, COMMIT_FULL));
        assert_eq!(commit(&input), 0);
        assert_eq!(info(size), (0, COMMIT_INCREMENTAL));
        // A rejected commit keeps the scene and the reported path.
        assert_ne!(commit(&input[..input.len() - 4]), 0);
        assert_eq!(info(size), (0, COMMIT_INCREMENTAL));
        unsafe {
            assert_eq!(
                mt_context_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
    }
    #[test]
    fn caught_context_panic_does_not_poison_the_registry() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut error = [0i8; 128];
        assert_eq!(
            action(error.as_mut_ptr(), error.len(), |_| panic!(
                "context boundary probe"
            )),
            1
        );
        assert!(
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_str()
                .unwrap()
                .contains("panicked")
        );
        let typed = with_registry::<usize>(|_| panic!("typed boundary probe")).unwrap_err();
        assert_eq!(classify(typed.as_ref(), Status::Error), Status::Error);
        assert_eq!(with_registry(|_| Ok(42)).unwrap(), 42);
        assert_eq!(action(error.as_mut_ptr(), error.len(), |_| Ok(())), 0);
        assert_eq!(error[0], 0);
        assert_eq!(action(error.as_mut_ptr(), 3, |_| Err("中文".into())), 1);
        assert_eq!(error[0], 0); // A truncated message never contains half a UTF-8 character.
        assert_eq!(action(error.as_mut_ptr(), 4, |_| Err("中文".into())), 1);
        assert_eq!(
            unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap(),
            "中"
        );
        assert_eq!(
            action(error.as_mut_ptr(), error.len(), |_| Err("".into())),
            1
        );
    }
    #[test]
    fn blocking_rust_calls_retry_busy_without_changing_the_c_boundary() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let held = REGISTRY.lock().unwrap();
        let (entered, waiting) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            blocking(|| {
                let result = with_registry(|_| Ok(42));
                if result
                    .as_ref()
                    .is_err_and(|e| classify(e.as_ref(), Status::Error) == Status::Busy)
                {
                    let _ = entered.try_send(());
                }
                result
            })
            .map_err(|e| e.to_string())
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!worker.is_finished());
        drop(held);
        assert_eq!(worker.join().unwrap().unwrap(), 42);
    }
    #[test]
    fn c_validation_precedence_survives_typed_entry_points() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut error = [0i8; 256];
        let (e, n) = (error.as_mut_ptr(), error.len());
        let mut written = 17;
        let mut rejected = || unsafe {
            [
                mt_context_info(u64::MAX, std::ptr::null_mut(), e, n),
                mt_job_info(u64::MAX, std::ptr::null_mut(), e, n),
                mt_context_submit(u64::MAX, 0, std::ptr::null_mut(), e, n),
                mt_context_backend(
                    u64::MAX,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    0,
                    e,
                    n,
                ),
                mt_context_read_pixels(
                    u64::MAX,
                    3,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    e,
                    n,
                ),
                mt_context_read_pixels(u64::MAX, 3, std::ptr::null_mut(), 0, &mut written, e, n),
                mt_job_poll(u64::MAX, 65, e, n),
                mt_job_cancel(u64::MAX, e, n),
                mt_context_cancel_commit(u64::MAX, e, n),
                mt_context_reset(u64::MAX, e, n),
            ]
        };
        use Status::{InvalidArgument as A, InvalidHandle as H};
        assert_eq!(rejected(), [H, H, A, A, A, H, A, H, H, H].map(|s| s as i32));
        let held = REGISTRY.lock().unwrap();
        assert_eq!(rejected(), [Status::Busy as i32; 10]);
        drop(held);
        assert_eq!(written, 0);
        // Busy must not initialize the caller's output length.
        written = 17;
        let held = REGISTRY.lock().unwrap();
        assert_eq!(
            unsafe {
                mt_context_read_pixels(u64::MAX, 0, std::ptr::null_mut(), 0, &mut written, e, n)
            },
            Status::Busy as i32
        );
        assert_eq!(written, 17);
        drop(held);
    }
    #[test]
    fn create_preflight_rejects_before_building_a_gpu() {
        let mut registry = Registry {
            next: u64::MAX,
            contexts: HashMap::new(),
        };
        for (backend, status, message) in [
            (
                2,
                Status::InvalidArgument,
                "Unknown native intersection backend",
            ),
            (0, Status::Error, "Native context handles exhausted"),
        ] {
            let error = create_in(&mut registry, backend, false, || {
                panic!("preflight must run first")
            })
            .unwrap_err();
            assert_eq!(classify(error.as_ref(), Status::Error), status);
            assert_eq!(error.to_string(), message);
            assert_eq!(registry.next, u64::MAX);
            assert!(registry.contexts.is_empty());
        }
        registry.next = 1;
        let error = create_in(&mut registry, 0, false, || {
            Err(fail(Status::Unavailable, "GPU unavailable"))
        })
        .unwrap_err();
        assert_eq!(classify(error.as_ref(), Status::Error), Status::Unavailable);
        assert_eq!(registry.next, 1);
        assert!(registry.contexts.is_empty());
    }
    #[test]
    fn rejected_calls_report_specific_status_codes() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut error = [0i8; 256];
        let (e, n) = (error.as_mut_ptr(), error.len());
        let full: Result<()> = Err("Full scene commit required: probe".into());
        assert_eq!(action(e, n, |_| full), Status::FullCommitRequired as i32);
        let mut handle = 7;
        unsafe {
            assert_eq!(
                mt_context_create_with_backend(2, &mut handle, e, n),
                Status::InvalidArgument as i32
            );
            assert_eq!(handle, 0);
            assert_eq!(
                mt_context_render(u64::MAX, 1, e, n),
                Status::InvalidHandle as i32
            );
            assert_eq!(
                mt_job_poll(u64::MAX, 65, e, n),
                Status::InvalidArgument as i32
            );
            assert_eq!(mt_job_poll(u64::MAX, 1, e, n), Status::InvalidHandle as i32);
            let mut written = 1;
            assert_eq!(
                mt_context_read_pixels(u64::MAX, 0, std::ptr::null_mut(), 0, &mut written, e, n),
                Status::InvalidHandle as i32
            );
            assert_eq!(written, 0);
            assert_eq!(
                settings::mt_render_settings_default(std::ptr::null_mut()),
                Status::InvalidArgument as i32
            );
        }
        // A held registry is reported as retryable busy work.
        let held = REGISTRY.lock().unwrap();
        assert_eq!(action(e, n, |_| Ok(())), Status::Busy as i32);
        let typed = with_registry(|_| Ok(42)).unwrap_err();
        assert_eq!(classify(typed.as_ref(), Status::Error), Status::Busy);
        drop(held);
    }
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn scene_state_errors_and_short_reads_report_status_codes() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let mut handle = 0;
        let mut error = [0i8; 512];
        let (e, n) = (error.as_mut_ptr(), error.len());
        unsafe {
            assert_eq!(
                mt_context_create_with_backend(0, &mut handle, e, n),
                0,
                "GPU validation requires a working device"
            );
            assert_eq!(
                mt_context_render(handle, 1, e, n),
                Status::InvalidState as i32
            );
            let input = scene::tests::input();
            let mut bad = input.clone();
            bad[0] = 99;
            assert_eq!(
                mt_context_commit(handle, bad.as_ptr(), bad.len(), e, n),
                Status::InvalidArgument as i32
            );
            assert_eq!(
                mt_context_commit(handle, input.as_ptr(), input.len(), e, n),
                0
            );
            let mut written = 0;
            assert_eq!(
                mt_context_read_pixels(handle, 0, std::ptr::null_mut(), 0, &mut written, e, n),
                Status::InvalidState as i32
            );
            assert_eq!(mt_context_render(handle, 1, e, n), 0);
            assert_eq!(
                mt_context_read_pixels(handle, 0, std::ptr::null_mut(), 0, &mut written, e, n),
                0
            );
            assert_eq!(written, read_pixels(handle, 0).unwrap().len() * 4);
            let mut pixels = vec![0u8; written];
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    0,
                    pixels.as_mut_ptr(),
                    pixels.len(),
                    &mut written,
                    e,
                    n
                ),
                0
            );
            let expected: Vec<_> = read_pixels(handle, 0)
                .unwrap()
                .into_iter()
                .flat_map(f32::to_le_bytes)
                .collect();
            assert_eq!(pixels, expected);
            assert_eq!(
                mt_context_info(handle, std::ptr::null_mut(), e, n),
                Status::InvalidArgument as i32
            );
            let mut job = 0;
            assert_eq!(mt_context_submit(handle, 1, &mut job, e, n), 0);
            assert_eq!(
                mt_job_info(job, std::ptr::null_mut(), e, n),
                Status::InvalidArgument as i32
            );
            assert_eq!(mt_job_cancel(job, e, n), 0);
            let mut short = [0u8; 16];
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    0,
                    short.as_mut_ptr(),
                    short.len(),
                    &mut written,
                    e,
                    n
                ),
                Status::BufferTooSmall as i32
            );
            assert!(written > short.len());
            assert_eq!(
                mt_context_read_pixels(
                    handle,
                    3,
                    short.as_mut_ptr(),
                    short.len(),
                    &mut written,
                    e,
                    n
                ),
                Status::InvalidArgument as i32
            );
            assert_eq!(mt_context_destroy(handle, e, n), 0);
        }
    }
}

pub(crate) fn backend(handle: u64) -> Result<(u32, String)> {
    with_registry(|registry| {
        let context = context(registry, handle)?;
        let hardware = ready(context)?.scene.hwrt.is_some();
        Ok((
            u32::from(hardware),
            if hardware {
                "software BVH geometries: 0".into()
            } else {
                context.fallback_reason.clone()
            },
        ))
    })
}

/// Actual backend: 0=software, 1=authoritative HWRT.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_context_backend(
    handle: u64,
    active: *mut u32,
    reason: *mut c_char,
    reason_capacity: usize,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    let result = if active.is_null() || reason.is_null() || reason_capacity == 0 {
        with_registry(|_| Err(fail(Status::InvalidArgument, "Invalid backend info output")))
    } else {
        backend(handle).map(|(backend, status)| {
            unsafe {
                *active = backend;
            }
            status::fill(
                unsafe { std::slice::from_raw_parts_mut(reason, reason_capacity) },
                &status,
            );
        })
    };
    write_result(error, capacity, result)
}

/// Snapshot only; AOT packaging and GPU work happen after releasing REGISTRY.
pub(crate) fn aov_query(handle: u64) -> Result<crate::aov::Query> {
    blocking(|| {
        with_registry(|registry| {
            let (state, linked) = with_scene(registry, handle)?;
            idle(state)?;
            let (scene, target) = render_parts(state, linked)?;
            crate::aov::Query::snapshot(scene, target)
        })
    })
}

pub(crate) fn temporal_query(
    handle: u64,
) -> Result<(denoiser_inputs::ProducerScene, scene::PreparedState)> {
    blocking(|| {
        with_registry(|registry| {
            let (state, linked) = with_scene(registry, handle)?;
            idle(state)?;
            let scene = match linked {
                Some(scene) => scene,
                None => ready(state)?,
            };
            Ok((
                denoiser_inputs::ProducerScene::snapshot(scene),
                scene
                    .retained
                    .clone()
                    .ok_or("Temporal inputs require a retained scene")?,
            ))
        })
    })
}
