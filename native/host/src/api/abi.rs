//! C ABI of the engine API. Declarations and contracts: native/include/mutracer-engine.h.
//!
//! Objects live in one registry. Each call clones what it needs out of the
//! registry and runs without holding it, so callbacks may call back into the ABI.
#[path = "abi_vulkan.rs"]
mod vulkan;
use super::*;
use crate::status;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A caller-owned callback argument, passed back unchanged.
#[derive(Clone, Copy)]
struct User(*mut c_void);
// SAFETY: the pointer is only handed back to the caller's callbacks, which the
// header documents as running on caller or custom-filter worker threads.
unsafe impl Send for User {}

type EngineCallback = extern "C" fn(*const MtEngineEvent, *mut c_void);
type SampleCallback = extern "C" fn(u32, u32, f64, *mut c_void);
type ConvergeCallback = extern "C" fn(u32, u32, u32, *mut c_void);
type SelectCallback = extern "C" fn(u32, *mut c_void) -> u32;
type LoopCallback = extern "C" fn(u32, u32, *mut c_void);

struct EngineEntry {
    engine: Engine,
    display: u64,
    callback: Option<Subscription>,
    window: Option<(wgpu::Instance, std::thread::ThreadId)>,
}
struct RenderEntry {
    engine: u64,
    render: Arc<Render>,
    /// Replaced at each converge/refine_until; `mt_render_cancel` cancels it.
    cancel: Arc<Mutex<CancelToken>>,
    /// The loop that owns this render, if any.
    owner: Option<u64>,
    callback: Option<Subscription>,
}
struct LoopEntry {
    engine: u64,
    render_loop: Arc<Mutex<RenderLoop>>,
    final_render: u64,
    preview: Option<u64>,
    syncs: HashMap<u64, SharedSync>,
    callbacks: Vec<LoopSubscription>,
}
enum Object {
    Engine(EngineEntry),
    Display { engine: u64 },
    Render(RenderEntry),
    Loop(LoopEntry),
}
impl Object {
    fn engine(&self) -> Option<u64> {
        match self {
            Object::Engine(_) => None,
            Object::Display { engine } => Some(*engine),
            Object::Render(r) => Some(r.engine),
            Object::Loop(l) => Some(l.engine),
        }
    }
}
#[derive(Default)]
struct Registry {
    next: u64,
    objects: HashMap<u64, Object>,
}
static REGISTRY: std::sync::LazyLock<Mutex<Registry>> = std::sync::LazyLock::new(|| {
    Mutex::new(Registry {
        next: 1,
        ..Default::default()
    })
});

fn registry<T>(f: impl FnOnce(&mut Registry) -> Result<T>) -> Result<T> {
    let mut slot = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut slot)
}
fn insert(object: Object) -> Result<u64> {
    registry(|r| {
        let handle = r.next;
        r.next += 1;
        r.objects.insert(handle, object);
        Ok(handle)
    })
}
fn invalid_handle() -> Error {
    error(Status::InvalidHandle, "Unknown or destroyed handle")
}
fn check_window_thread(e: &EngineEntry) -> Result<()> {
    vulkan::check_engine_ref(&e.engine)?;
    if e.window
        .as_ref()
        .is_some_and(|(_, t)| *t != std::thread::current().id())
    {
        return Err(error(
            Status::InvalidState,
            "Window engine must be used on its creating thread",
        ));
    }
    Ok(())
}
fn check_owner_thread(r: &Registry, owner: u64) -> Result<()> {
    vulkan::check_engine(owner)?;
    match r.objects.get(&owner) {
        Some(Object::Engine(e)) => check_window_thread(e),
        _ => Err(invalid_handle()),
    }
}
fn register_engine(engine: Engine, window: Option<wgpu::Instance>) -> Result<u64> {
    let handle = insert(Object::Engine(EngineEntry {
        engine,
        display: 0,
        callback: None,
        window: window.map(|i| (i, std::thread::current().id())),
    }))?;
    let display = insert(Object::Display { engine: handle })?;
    registry(|r| {
        if let Some(Object::Engine(e)) = r.objects.get_mut(&handle) {
            e.display = display;
        }
        Ok(())
    })?;
    Ok(handle)
}
pub(crate) fn engine_of(handle: u64) -> Result<Engine> {
    vulkan::check_engine(handle)?;
    registry(|r| match r.objects.get(&handle) {
        Some(Object::Engine(e)) => {
            check_window_thread(e)?;
            Ok(e.engine.clone())
        }
        _ => Err(invalid_handle()),
    })
}
fn display_of(handle: u64) -> Result<Display> {
    registry(|r| {
        let Some(Object::Display { engine }) = r.objects.get(&handle) else {
            return Err(invalid_handle());
        };
        vulkan::check_engine(*engine)?;
        match r.objects.get(engine) {
            Some(Object::Engine(e)) => {
                check_window_thread(e)?;
                Ok(e.engine.display())
            }
            _ => Err(invalid_handle()),
        }
    })
}
fn render_of(handle: u64) -> Result<Arc<Render>> {
    registry(|r| match r.objects.get(&handle) {
        Some(Object::Render(e)) => {
            check_owner_thread(r, e.engine)?;
            Ok(e.render.clone())
        }
        _ => Err(invalid_handle()),
    })
}
fn loop_of(handle: u64) -> Result<Arc<Mutex<RenderLoop>>> {
    registry(|r| match r.objects.get(&handle) {
        Some(Object::Loop(e)) => {
            check_owner_thread(r, e.engine)?;
            Ok(e.render_loop.clone())
        }
        _ => Err(invalid_handle()),
    })
}
/// Locks a loop; a callback of this loop calling back into it is rejected.
fn lock_loop(render_loop: &Mutex<RenderLoop>) -> Result<std::sync::MutexGuard<'_, RenderLoop>> {
    render_loop.try_lock().map_err(|e| match e {
        std::sync::TryLockError::WouldBlock => error(
            Status::InvalidState,
            "The render loop is running a callback or used from another thread",
        ),
        std::sync::TryLockError::Poisoned(p) => {
            drop(p);
            error(Status::ContextFailed, "The render loop panicked")
        }
    })
}

/// Runs one ABI call: catches panics and writes the status message.
fn call(error_out: *mut c_char, capacity: usize, body: impl FnOnce() -> Result<()>) -> i32 {
    let result = crate::platform_scope(|| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(body))
            .unwrap_or_else(|_| Err(error(Status::Error, "Native engine call panicked")))
    });
    match result {
        Ok(()) => status::write(error_out, capacity, Status::Ok, ""),
        Err(e) => status::write(error_out, capacity, e.status, &e.message),
    }
}
fn invalid(message: &str) -> Error {
    error(Status::InvalidArgument, message)
}
/// A caller record whose `struct_size` must match this library's size.
unsafe fn record<'a, T>(pointer: *const T) -> Result<&'a T> {
    if pointer.is_null() {
        return Err(invalid("Null record"));
    }
    if unsafe { *(pointer as *const u32) } as usize != std::mem::size_of::<T>() {
        return Err(invalid("Unsupported struct_size"));
    }
    Ok(unsafe { &*pointer })
}
/// An output record: checks `struct_size` and writes `value`, keeping it.
unsafe fn write_record<T>(pointer: *mut T, value: T) -> Result<()> {
    unsafe { record(pointer as *const T)? };
    unsafe { pointer.write(value) };
    Ok(())
}
unsafe fn write_optional<T>(pointer: *mut T, value: T) {
    if !pointer.is_null() {
        unsafe { pointer.write(value) };
    }
}
unsafe fn write_required<T>(pointer: *mut T, value: T) -> Result<()> {
    if pointer.is_null() {
        return Err(invalid("Null output"));
    }
    unsafe { pointer.write(value) };
    Ok(())
}
/// Size query or copy into a caller buffer, as mt_context_read_pixels.
unsafe fn copy_out(
    bytes: &[u8],
    pixels: *mut c_void,
    size: usize,
    written: *mut usize,
) -> Result<()> {
    unsafe { write_required(written, bytes.len())? };
    if pixels.is_null() && size == 0 {
        return Ok(());
    }
    if pixels.is_null() {
        return Err(invalid("Null pixel destination"));
    }
    if size < bytes.len() {
        return Err(error(
            Status::BufferTooSmall,
            "Pixel destination is too small",
        ));
    }
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), pixels.cast(), bytes.len()) };
    Ok(())
}
use crate::status::fill;

include!("abi_window.rs");

// ---- Records (layouts mirror mutracer-engine.h) ----

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MtDepthSampleArea {
    struct_size: u32,
    x: f32,
    y: f32,
    size: f32,
}

#[repr(C)]
pub struct MtEngineOptions {
    struct_size: u32,
    backend: u32,
}
#[repr(C)]
pub struct MtEngineSnapshot {
    struct_size: u32,
    backend: u32,
    hardware_ray_query: u32,
    adapter_name: [c_char; 256],
}
#[repr(C)]
pub struct MtDiagnostics {
    struct_size: u32,
    has_scene: u32,
    preparing: u32,
    compiling: u32,
    scene_revision: u64,
    compilations_started: u64,
    compilations_completed: u64,
    pipeline_cache_hits: u64,
    cached_pipelines: u32,
    renders: u32,
    sampling: u32,
    denoising: u32,
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_diagnostics(
    handle: u64,
    output: *mut MtDiagnostics,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let d = engine_of(handle)?.diagnostics();
        unsafe {
            write_record(
                output,
                MtDiagnostics {
                    struct_size: std::mem::size_of::<MtDiagnostics>() as u32,
                    has_scene: d.has_scene as u32,
                    preparing: d.preparing as u32,
                    compiling: d.compiling as u32,
                    scene_revision: d.scene_revision,
                    compilations_started: d.compilations_started,
                    compilations_completed: d.compilations_completed,
                    pipeline_cache_hits: d.pipeline_cache_hits,
                    cached_pipelines: d.cached_pipelines as u32,
                    renders: d.renders.len() as u32,
                    sampling: d.renders.iter().filter(|r| r.sampling).count() as u32,
                    denoising: d.renders.iter().filter(|r| r.denoising).count() as u32,
                },
            )
        }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_clear_scene(
    handle: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || engine_of(handle)?.clear_scene())
}
#[repr(C)]
pub struct MtEngineEvent {
    struct_size: u32,
    kind: u32,
    progress: f32,
    recovering: u32,
    message: *const c_char,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MtDisplaySettings {
    struct_size: u32,
    tone_mapping: u32,
    channel: u32,
    tone_mapping_exposure: f32,
    contrast: f32,
    saturation: f32,
    temperature: f32,
    tint: f32,
    vignette: f32,
    bloom_intensity: f32,
    bloom_threshold: f32,
    bloom_radius: f32,
    shadow_catcher_color: [f32; 3],
    shadow_catcher_alpha: f32,
    hdr_output_enabled: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MtAovDisplayOptions {
    struct_size: u32,
    depth_range: [f32; 2],
    position_scale: f32,
    motion_scale: f32,
    id_component: u32,
}
fn aov_display_record(options: AovDisplayOptions) -> MtAovDisplayOptions {
    MtAovDisplayOptions {
        struct_size: 24,
        depth_range: options.depth_range,
        position_scale: options.position_scale,
        motion_scale: options.motion_scale,
        id_component: options.id_component as u32,
    }
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct MtPresented {
    struct_size: u32,
    fallback: u32,
    width: u32,
    height: u32,
    samples: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MtRenderOptions {
    struct_size: u32,
    max_samples: u32,
    bounces: u32,
    sampling_pattern: u32,
    direct_light_candidates: u32,
    bevel: u32,
    bevel_samples: u32,
    dispersion_wavelengths: u32,
    allow_multiple_samples_per_frame: u32,
    width: u32,
    height: u32,
    seed: u32,
    aovs: u32,
    aov_samples: u32,
    resolution_scale: f64,
    clamping: f64,
    transmissive_output_alpha_min: f64,
    time_budget_ms: f64,
    adaptive_target_frame_ms: f64,
    adaptive_min_scale: f64,
    alpha_blend_strategy: u32,
    reserved_tail: u32,
    caustic_flags: u32,
    light_photons: u32,
    photon_map_photons: u32,
    photon_map_radius: f32,
}
#[repr(C)]
pub struct MtRenderDenoiser {
    struct_size: u32,
    backend: u32,
    schedule: u32,
    reserved: u32,
    library: *const c_char,
}
#[repr(C)]
pub struct MtConvergeOptions {
    struct_size: u32,
    samples: u32,
    sample_sequence_offset: u32,
    samples_per_batch: u32,
    use_camera: u32,
    reserved: u32,
    timeout_ms: u64,
    camera: Camera,
    progress: Option<ConvergeCallback>,
    user: *mut c_void,
}
#[repr(C)]
pub struct MtRenderSnapshot {
    struct_size: u32,
    status: u32,
    samples: u32,
    width: u32,
    height: u32,
    converged: u32,
    denoising: u32,
    last_commit: u32,
    backend: u32,
    denoised_samples: u32,
    denoise_ms: f32,
    denoise_device: [c_char; 64],
    message: [c_char; 256],
}
#[repr(C)]
pub struct MtRenderLoopOptions {
    struct_size: u32,
    preview: u32,
    coalesce_scene_updates: u32,
    reserved: u32,
    idle_ms: f64,
    preview_options: *const MtRenderOptions,
    final_options: *const MtRenderOptions,
    select: Option<SelectCallback>,
    select_user: *mut c_void,
}
#[repr(C)]
pub struct MtRenderLoopSnapshot {
    struct_size: u32,
    status: u32,
    samples: u32,
    changing: u32,
    presentations: u64,
    last_presented: MtPresented,
    reserved: u32,
}
#[repr(C)]
pub struct MtLoopSync {
    struct_size: u32,
    reserved: u32,
    update: Option<extern "C" fn(*mut c_void)>,
    active: Option<extern "C" fn(*mut c_void) -> u32>,
    user: *mut c_void,
}

// ---- Conversions ----

fn backend_from(code: u32) -> Result<Backend> {
    match code {
        0 => Ok(Backend::Software),
        1 => Ok(Backend::Hardware),
        _ => Err(invalid("Unknown backend")),
    }
}
fn render_options(settings: &RenderSettings) -> MtRenderOptions {
    let (width, height, scale) = match settings.size {
        RenderSize::Fixed { width, height } => (width, height, 1.),
        RenderSize::Scale(scale) => (0, 0, scale),
    };
    MtRenderOptions {
        struct_size: std::mem::size_of::<MtRenderOptions>() as u32,
        max_samples: settings.max_samples,
        bounces: settings.bounces,
        sampling_pattern: match settings.sampling_pattern {
            SamplingPattern::Sobol => 0,
            SamplingPattern::ZSobol => 1,
            SamplingPattern::Random => 2,
        },
        direct_light_candidates: settings.direct_light_candidates,
        bevel: settings.bevel as u32,
        bevel_samples: settings.bevel_samples,
        dispersion_wavelengths: settings.dispersion_wavelengths,
        allow_multiple_samples_per_frame: (settings.batch_samples
            || settings.allow_multiple_samples_per_frame)
            as u32,
        width,
        height,
        seed: settings.seed,
        aovs: settings.aovs,
        aov_samples: settings.aov_samples,
        resolution_scale: scale,
        clamping: settings.clamping,
        transmissive_output_alpha_min: settings.transmissive_output_alpha_min,
        time_budget_ms: settings.time_budget_ms,
        adaptive_target_frame_ms: settings
            .adaptive_resolution
            .map_or(0., |a| a.target_frame_ms),
        adaptive_min_scale: settings.adaptive_resolution.map_or(0., |a| a.min_scale),
        alpha_blend_strategy: settings.alpha_blend_strategy as u32,
        caustic_flags: settings.caustics.flags(),
        light_photons: settings.caustics.light_photons,
        photon_map_photons: settings.caustics.photon_map_photons,
        photon_map_radius: settings.caustics.photon_map_radius,
        reserved_tail: 0,
    }
}
fn render_settings(options: &MtRenderOptions) -> Result<RenderSettings> {
    if options.caustic_flags & !6 != 0
        || options.reserved_tail != 0
        || options.bevel > 1
        || options.allow_multiple_samples_per_frame > 1
    {
        return Err(invalid("Reserved fields must be 0 and flags 0 or 1"));
    }
    let size = match (options.width, options.height) {
        (0, 0) => RenderSize::Scale(options.resolution_scale),
        (0, _) | (_, 0) => return Err(invalid("Set both width and height, or neither")),
        (width, height) => RenderSize::Fixed { width, height },
    };
    let settings = RenderSettings {
        caustics: CausticSettings {
            light_tracing: options.caustic_flags & 2 != 0,
            photon_mapping: options.caustic_flags & 4 != 0,
            light_photons: options.light_photons,
            photon_map_photons: options.photon_map_photons,
            photon_map_radius: options.photon_map_radius,
        },
        aovs: options.aovs,
        aov_samples: if options.aov_samples == 0 {
            16
        } else {
            options.aov_samples
        },
        max_samples: options.max_samples,
        bounces: options.bounces,
        clamping: options.clamping,
        sampling_pattern: match options.sampling_pattern {
            0 => SamplingPattern::Sobol,
            1 => SamplingPattern::ZSobol,
            2 => SamplingPattern::Random,
            _ => return Err(invalid("Unknown sampling pattern")),
        },
        alpha_blend_strategy: match options.alpha_blend_strategy {
            0 => AlphaBlendStrategy::Stochastic,
            1 => AlphaBlendStrategy::DeterministicSourceOver,
            _ => return Err(invalid("Unknown alpha blend strategy")),
        },
        direct_light_candidates: options.direct_light_candidates,
        bevel: options.bevel != 0,
        bevel_samples: options.bevel_samples,
        dispersion_wavelengths: options.dispersion_wavelengths,
        transmissive_output_alpha_min: options.transmissive_output_alpha_min,
        time_budget_ms: options.time_budget_ms,
        batch_samples: false,
        allow_multiple_samples_per_frame: options.allow_multiple_samples_per_frame != 0,
        size,
        seed: options.seed,
        adaptive_resolution: (options.adaptive_target_frame_ms != 0.
            || options.adaptive_min_scale != 0.)
            .then_some(AdaptiveResolution {
                target_frame_ms: options.adaptive_target_frame_ms,
                min_scale: options.adaptive_min_scale,
            }),
    };
    settings.validate()?;
    Ok(settings)
}
fn display_record(settings: &DisplaySettings) -> MtDisplaySettings {
    MtDisplaySettings {
        struct_size: std::mem::size_of::<MtDisplaySettings>() as u32,
        tone_mapping: settings.tone_mapping as u32,
        channel: settings.channel as u32,
        tone_mapping_exposure: settings.tone_mapping_exposure,
        contrast: settings.contrast,
        saturation: settings.saturation,
        temperature: settings.temperature,
        tint: settings.tint,
        vignette: settings.vignette,
        bloom_intensity: settings.bloom_intensity,
        bloom_threshold: settings.bloom_threshold,
        bloom_radius: settings.bloom_radius,
        shadow_catcher_color: settings.shadow_catcher_color,
        shadow_catcher_alpha: settings.shadow_catcher_alpha,
        hdr_output_enabled: u32::from(settings.hdr_output_enabled),
    }
}
fn display_settings(record: &MtDisplaySettings) -> Result<DisplaySettings> {
    Ok(DisplaySettings {
        tone_mapping: match record.tone_mapping {
            0 => ToneMapping::Agx,
            1 => ToneMapping::Aces,
            2 => ToneMapping::Cineon,
            3 => ToneMapping::Reinhard,
            4 => ToneMapping::Linear,
            _ => return Err(invalid("Unknown tone mapping")),
        },
        channel: match record.channel {
            0 => Channel::Final,
            1 => Channel::Normal,
            2 => Channel::Albedo,
            3 => Channel::Shadow,
            4 => Channel::ShadowCatcher,
            5 => Channel::Depth,
            6 => Channel::Position,
            7 => Channel::Roughness,
            8 => Channel::DiffuseAlbedo,
            9 => Channel::SpecularAlbedo,
            10 => Channel::Id,
            11 => Channel::Motion,
            _ => return Err(invalid("Unknown display channel")),
        },
        aov: AovDisplayOptions::default(),
        tone_mapping_exposure: record.tone_mapping_exposure,
        contrast: record.contrast,
        saturation: record.saturation,
        temperature: record.temperature,
        tint: record.tint,
        vignette: record.vignette,
        bloom_intensity: record.bloom_intensity,
        bloom_threshold: record.bloom_threshold,
        bloom_radius: record.bloom_radius,
        shadow_catcher_color: record.shadow_catcher_color,
        shadow_catcher_alpha: record.shadow_catcher_alpha,
        hdr_output_enabled: match record.hdr_output_enabled {
            0 => false,
            1 => true,
            _ => return Err(invalid("Invalid HDR output flag")),
        },
    })
}
fn presented_record(presented: Option<Presented>) -> MtPresented {
    let p = presented.unwrap_or(Presented {
        fallback: false,
        width: 0,
        height: 0,
        samples: 0,
    });
    MtPresented {
        struct_size: std::mem::size_of::<MtPresented>() as u32,
        fallback: p.fallback as u32,
        width: p.width,
        height: p.height,
        samples: p.samples,
    }
}
fn render_status(status: RenderStatus) -> u32 {
    match status {
        RenderStatus::Preparing => 0,
        RenderStatus::Compiling => 1,
        RenderStatus::Converging => 2,
        RenderStatus::Denoising => 3,
        RenderStatus::Finished => 4,
        RenderStatus::Error => 5,
        RenderStatus::Idle => 6,
    }
}
fn loop_status(status: RenderLoopStatus) -> u32 {
    match status {
        RenderLoopStatus::Preparing => 0,
        RenderLoopStatus::Compiling => 1,
        RenderLoopStatus::Converging => 2,
        RenderLoopStatus::Denoising => 3,
        RenderLoopStatus::Finished => 4,
        RenderLoopStatus::Error => 5,
        RenderLoopStatus::Previewing => 6,
        RenderLoopStatus::Idle => 7,
    }
}
unsafe fn converge_options(
    options: *const MtConvergeOptions,
    cancel: CancelToken,
) -> Result<ConvergeOptions> {
    let options = unsafe { record(options)? };
    if options.reserved != 0 || options.use_camera > 1 {
        return Err(invalid("Reserved fields must be 0 and flags 0 or 1"));
    }
    let on_progress = options.progress.map(|callback| {
        let user = User(options.user);
        Box::new(move |p: ConvergeProgress| {
            let user = user;
            let stage = match p.stage {
                ConvergeStage::Final => 0,
                ConvergeStage::Denoising => 1,
            };
            callback(stage, p.samples, p.target_samples, user.0)
        }) as Box<dyn FnMut(ConvergeProgress) + Send>
    });
    Ok(ConvergeOptions {
        samples: options.samples,
        camera: (options.use_camera != 0).then_some(options.camera),
        sample_sequence_offset: options.sample_sequence_offset,
        samples_per_batch: options.samples_per_batch,
        target_batch_time_ms: None,
        preview_interval_ms: None,
        timeout_ms: options.timeout_ms,
        on_progress,
        cancel: Some(cancel),
    })
}
/// A fresh cancel token for the render handle's next blocking sampling call.
fn arm_cancel(handle: u64) -> Result<CancelToken> {
    registry(|r| match r.objects.get(&handle) {
        Some(Object::Render(e)) => {
            let token = CancelToken::new();
            *e.cancel.lock().unwrap_or_else(|e| e.into_inner()) = token.clone();
            Ok(token)
        }
        _ => Err(invalid_handle()),
    })
}
fn register_render(engine: u64, render: Arc<Render>, owner: Option<u64>) -> Result<u64> {
    insert(Object::Render(RenderEntry {
        engine,
        render,
        cancel: Arc::new(Mutex::new(CancelToken::new())),
        owner,
        callback: None,
    }))
}

// ---- Engine ----

#[repr(C)]
pub struct MtGpuAdapterInfo {
    struct_size: u32,
    index: u32,
    backend: u32,
    vendor: u32,
    device: u32,
    device_type: u32,
    hardware_ray_query: u32,
    reserved: u32,
    name: [c_char; 256],
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_gpu_adapters(
    output: *mut MtGpuAdapterInfo,
    capacity: usize,
    required: *mut usize,
    error_out: *mut c_char,
    error_capacity: usize,
) -> i32 {
    call(error_out, error_capacity, || {
        if required.is_null() || (output.is_null() && capacity != 0) {
            return Err(invalid("Invalid adapter output pointers"));
        }
        let adapters = Engine::adapters();
        unsafe { required.write(adapters.len()) };
        if output.is_null() && capacity == 0 {
            return Ok(());
        }
        if capacity < adapters.len() {
            return Err(error(Status::BufferTooSmall, "Adapter array is too small"));
        }
        for (index, adapter) in adapters.iter().enumerate() {
            let info = adapter.get_info();
            let mut name = [0; 256];
            fill(&mut name, &info.name);
            let record = MtGpuAdapterInfo {
                struct_size: std::mem::size_of::<MtGpuAdapterInfo>() as u32,
                index: index as u32,
                backend: match info.backend {
                    wgpu::Backend::Metal => 1,
                    wgpu::Backend::Vulkan => 2,
                    wgpu::Backend::Dx12 => 3,
                    _ => 0,
                },
                vendor: info.vendor,
                device: info.device,
                device_type: match info.device_type {
                    wgpu::DeviceType::DiscreteGpu => 1,
                    wgpu::DeviceType::IntegratedGpu => 2,
                    wgpu::DeviceType::Cpu => 3,
                    wgpu::DeviceType::VirtualGpu => 4,
                    _ => 0,
                },
                hardware_ray_query: u32::from(
                    adapter
                        .features()
                        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
                ),
                reserved: 0,
                name,
            };
            unsafe { output.add(index).write(record) };
        }
        Ok(())
    })
}
fn selected_adapter(instance: &wgpu::Instance, index: u32) -> Result<wgpu::Adapter> {
    crate::GpuDevice::adapters(instance)
        .into_iter()
        .nth(index as usize)
        .ok_or_else(|| error(Status::Unavailable, "Selected adapter index is unavailable"))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_create_on_adapter(
    options: *const MtEngineOptions,
    adapter_index: u32,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let options = unsafe { record(options)? };
        if output.is_null() {
            return Err(invalid("Null output"));
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = selected_adapter(&instance, adapter_index)?;
        let engine = Engine::on_adapter(
            &adapter,
            EngineOptions {
                backend: backend_from(options.backend)?,
            },
        )?;
        let handle = register_engine(engine, None)?;
        unsafe { output.write(handle) };
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_options_default(output: *mut MtEngineOptions) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe {
        output.write(MtEngineOptions {
            struct_size: std::mem::size_of::<MtEngineOptions>() as u32,
            backend: 1,
        })
    };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_create(
    options: *const MtEngineOptions,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let options = unsafe { record(options)? };
        if output.is_null() {
            return Err(invalid("Null output"));
        }
        let engine = Engine::new(EngineOptions {
            backend: backend_from(options.backend)?,
        })?;
        let handle = register_engine(engine, None)?;
        unsafe { output.write(handle) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_destroy(
    handle: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        engine_of(handle)?;
        vulkan::engine_destroyed(handle);
        // Loops first, then renders, then the engine; dropped outside the registry.
        let mut removed = registry(|r| {
            if !matches!(r.objects.get(&handle), Some(Object::Engine(_))) {
                return Err(invalid_handle());
            }
            let owned: Vec<u64> = r
                .objects
                .iter()
                .filter(|(_, o)| o.engine() == Some(handle))
                .map(|(h, _)| *h)
                .collect();
            let mut removed: Vec<Object> =
                owned.iter().filter_map(|h| r.objects.remove(h)).collect();
            removed.push(r.objects.remove(&handle).unwrap());
            Ok(removed)
        })?;
        removed.sort_by_key(|o| match o {
            Object::Loop(_) => 0,
            Object::Render(r) if r.owner.is_some() => 1,
            Object::Render(_) => 2,
            Object::Display { .. } => 3,
            Object::Engine(_) => 4,
        });
        let mut engine = None;
        for object in removed {
            if let Object::Engine(e) = object {
                engine = Some(e.engine);
            }
        }
        if let Some(engine) = engine {
            engine.dispose();
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_set_scene(
    handle: u64,
    descriptor: *const u8,
    length: usize,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if descriptor.is_null() {
            return Err(invalid("Null descriptor"));
        }
        let bytes = unsafe { std::slice::from_raw_parts(descriptor, length) };
        engine_of(handle)?.set_scene(bytes)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_set_camera(
    handle: u64,
    camera: *const Camera,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let camera = (!camera.is_null()).then(|| unsafe { *camera });
        engine_of(handle)?.set_camera(camera)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_update(
    handle: u64,
    changed: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let result = engine_of(handle)?.update()?;
        unsafe { write_optional(changed, result as u32) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_read_depth_samples(
    handle: u64,
    area: *const MtDepthSampleArea,
    samples: *mut f32,
    count: usize,
    written: *mut usize,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        unsafe {
            write_required(written, 0)?;
        }
        let area = unsafe { record(area)? };
        let area = DepthSampleArea {
            x: area.x,
            y: area.y,
            size: area.size,
        };
        area.pack(1.)?;
        if samples.is_null() && count != 0 {
            return Err(invalid("Null depth destination"));
        }
        let Some(depths) = engine_of(handle)?.read_depth_samples(area)? else {
            return Ok(());
        };
        unsafe {
            write_required(written, DEPTH_SAMPLE_COUNT)?;
        }
        if samples.is_null() {
            return Ok(());
        }
        if count < DEPTH_SAMPLE_COUNT {
            return Err(error(
                Status::BufferTooSmall,
                "Depth destination needs 49 floats",
            ));
        }
        unsafe {
            std::ptr::copy_nonoverlapping(depths.as_ptr(), samples, DEPTH_SAMPLE_COUNT);
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_info(
    handle: u64,
    output: *mut MtEngineSnapshot,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let info = engine_of(handle)?.info();
        let mut snapshot = MtEngineSnapshot {
            struct_size: std::mem::size_of::<MtEngineSnapshot>() as u32,
            backend: info.backend.code(),
            hardware_ray_query: info.hardware_ray_query as u32,
            adapter_name: [0; 256],
        };
        fill(&mut snapshot.adapter_name, &info.adapter_name);
        unsafe { write_record(output, snapshot) }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_set_callback(
    handle: u64,
    callback: Option<EngineCallback>,
    user: *mut c_void,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let engine = engine_of(handle)?;
        let subscription = callback.map(|callback| {
            let user = User(user);
            engine.on(move |event| {
                let user = user;
                let (kind, progress, recovering, message) = match event {
                    EngineEvent::Progress { stage, progress } => (
                        if *stage == ProgressStage::Compilation {
                            3
                        } else {
                            0
                        },
                        *progress,
                        false,
                        None,
                    ),
                    EngineEvent::Error { message } => (1, 0., false, Some(message.clone())),
                    EngineEvent::DeviceLost { reason, recovering } => {
                        (2, 0., *recovering, Some(reason.clone()))
                    }
                };
                let message = message.map(|m| CString::new(m.replace('\0', " ")).unwrap());
                let record = MtEngineEvent {
                    struct_size: std::mem::size_of::<MtEngineEvent>() as u32,
                    kind,
                    progress,
                    recovering: recovering as u32,
                    message: message.as_ref().map_or(std::ptr::null(), |m| m.as_ptr()),
                };
                callback(&record, user.0);
            })
        });
        // The previous subscription is dropped outside the registry.
        let previous = registry(|r| match r.objects.get_mut(&handle) {
            Some(Object::Engine(e)) => Ok(std::mem::replace(&mut e.callback, subscription)),
            _ => Err(invalid_handle()),
        })?;
        drop(previous);
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_display(
    handle: u64,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let display = registry(|r| match r.objects.get(&handle) {
            Some(Object::Engine(e)) => {
                check_window_thread(e)?;
                Ok(e.display)
            }
            _ => Err(invalid_handle()),
        })?;
        unsafe { write_required(output, display) }
    })
}

// ---- Display ----

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_settings_default(output: *mut MtDisplaySettings) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe { output.write(display_record(&DisplaySettings::default())) };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_aov_options_default(output: *mut MtAovDisplayOptions) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe { output.write(aov_display_record(AovDisplayOptions::default())) };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_set_aov_options(
    handle: u64,
    options: *const MtAovDisplayOptions,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let options = unsafe { record(options)? };
        let display = display_of(handle)?;
        let mut settings = display.settings();
        settings.aov = AovDisplayOptions {
            depth_range: options.depth_range,
            position_scale: options.position_scale,
            motion_scale: options.motion_scale,
            id_component: match options.id_component {
                0 => AovIdComponent::Object,
                1 => AovIdComponent::Instance,
                2 => AovIdComponent::Material,
                3 => AovIdComponent::Primitive,
                _ => return Err(invalid("Unknown AOV ID component")),
            },
        };
        display.set_settings(settings)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_get_aov_options(
    handle: u64,
    output: *mut MtAovDisplayOptions,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || unsafe {
        write_record(
            output,
            aov_display_record(display_of(handle)?.settings().aov),
        )
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_set_size(
    handle: u64,
    width: u32,
    height: u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        display_of(handle)?.set_size(width, height)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_set_settings(
    handle: u64,
    settings: *const MtDisplaySettings,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let mut settings = display_settings(unsafe { record(settings)? })?;
        let display = display_of(handle)?;
        settings.aov = display.settings().aov;
        display.set_settings(settings)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_get_settings(
    handle: u64,
    output: *mut MtDisplaySettings,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let settings = display_of(handle)?.settings();
        unsafe { write_record(output, display_record(&settings)) }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_present(
    handle: u64,
    render: u64,
    shown: *mut u32,
    presented: *mut MtPresented,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if !presented.is_null() {
            unsafe { record(presented as *const MtPresented)? };
        }
        let display = display_of(handle)?;
        let result = display.present(&*render_of(render)?)?;
        unsafe {
            write_optional(shown, result.is_some() as u32);
            write_optional(presented, presented_record(result));
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_read_pixels(
    handle: u64,
    render: u64,
    format: u32,
    pixels: *mut c_void,
    size: usize,
    written: *mut usize,
    width: *mut u32,
    height: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if format > 1 {
            return Err(invalid("Unknown display format"));
        }
        if written.is_null() {
            return Err(invalid("Null written"));
        }
        let (w, h, rgba) = display_of(handle)?.read_rgba8(&*render_of(render)?)?;
        let bytes = if format == 1 {
            let mut bytes = Vec::new();
            let mut encoder = png::Encoder::new(&mut bytes, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .and_then(|mut writer| writer.write_image_data(&rgba))
                .map_err(|e| error(Status::Error, format!("PNG encoding failed: {e}")))?;
            bytes
        } else {
            rgba
        };
        unsafe {
            write_optional(width, w);
            write_optional(height, h);
            copy_out(&bytes, pixels, size, written)
        }
    })
}

// ---- Render ----

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_options_default(output: *mut MtRenderOptions) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe { output.write(render_options(&RenderSettings::default())) };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_create(
    engine: u64,
    options: *const MtRenderOptions,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let settings = render_settings(unsafe { record(options)? })?;
        if output.is_null() {
            return Err(invalid("Null output"));
        }
        let render = Arc::new(Render::new(&engine_of(engine)?, settings)?);
        let handle = register_render(engine, render, None)?;
        unsafe { output.write(handle) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_destroy(
    handle: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        render_of(handle)?;
        let removed = registry(|r| match r.objects.get(&handle) {
            Some(Object::Render(e)) if e.owner.is_some() => Err(error(
                Status::InvalidState,
                "The render is owned by its render loop",
            )),
            Some(Object::Render(_)) => Ok(r.objects.remove(&handle)),
            _ => Err(invalid_handle()),
        })?;
        drop(removed);
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_set_options(
    handle: u64,
    options: *const MtRenderOptions,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let settings = render_settings(unsafe { record(options)? })?;
        render_of(handle)?.set_settings(settings)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_get_options(
    handle: u64,
    output: *mut MtRenderOptions,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let settings = render_of(handle)?.settings()?;
        unsafe { write_record(output, render_options(&settings)) }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_set_fallback(
    handle: u64,
    fallback: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render = render_of(handle)?;
        let fallback = (fallback != 0).then(|| render_of(fallback)).transpose()?;
        render.set_fallback(fallback.as_deref())
    })
}
#[repr(C)]
pub struct MtDenoiseInput {
    struct_size: u32,
    width: u32,
    height: u32,
    aovs: u32,
    count: usize,
    color: *const f32,
    normal: *const f32,
    albedo: *const f32,
    cancel: *const c_void,
    aov_data: [*const c_void; 7],
}
type DenoiseCallback =
    unsafe extern "C" fn(*const MtDenoiseInput, *mut f32, *mut c_char, usize, *mut c_void) -> i32;
type DenoiseRelease = unsafe extern "C" fn(*mut c_void);
#[repr(C)]
pub struct MtCustomDenoiser {
    struct_size: u32,
    schedule: u32,
    callback: Option<DenoiseCallback>,
    release: Option<DenoiseRelease>,
    user: *mut c_void,
    aovs: u32,
    reserved: u32,
}
struct CFilter {
    aovs: u32,
    callback: DenoiseCallback,
    release: Option<DenoiseRelease>,
    user: User,
}
// Pointer is opaque; the host guarantees concurrent worker access and lifetime.
unsafe impl Sync for CFilter {}
impl Drop for CFilter {
    fn drop(&mut self) {
        if let Some(release) = self.release {
            unsafe { release(self.user.0) };
        }
    }
}
impl CustomDenoiser for CFilter {
    fn aovs(&self) -> u32 {
        self.aovs
    }
    fn denoise(
        &self,
        input: DenoiseInput,
        cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        let mut aov_data = [std::ptr::null(); 7];
        let mut supplied = 0;
        for aov in &input.aovs {
            let mask = aov.kind.aov_mask();
            let index = mask.trailing_zeros() as usize;
            if index < 7 {
                supplied |= mask;
                aov_data[index] = aov
                    .id_data
                    .as_ref()
                    .map_or(aov.data.as_ptr().cast(), |ids| ids.as_ptr().cast());
            }
        }
        let record = MtDenoiseInput {
            struct_size: std::mem::size_of::<MtDenoiseInput>() as u32,
            width: input.size[0],
            height: input.size[1],
            aovs: supplied,
            aov_data,
            count: input.color.len(),
            color: input.color.as_ptr(),
            normal: input.normal.as_ptr(),
            albedo: input.albedo.as_ptr(),
            cancel: &cancel as *const CancelToken as *const c_void,
        };
        let mut output = vec![f32::NAN; input.color.len()];
        let mut message = [0 as c_char; 1024];
        let result = unsafe {
            (self.callback)(
                &record,
                output.as_mut_ptr(),
                message.as_mut_ptr(),
                message.len(),
                self.user.0,
            )
        };
        if result != 0 {
            let bytes: Vec<u8> = message
                .iter()
                .take_while(|&&c| c != 0)
                .map(|&c| c as u8)
                .collect();
            return Err(format!(
                "Custom denoiser ({result}): {}",
                String::from_utf8_lossy(&bytes)
            ));
        }
        Ok(DenoiseOutput::Cpu(output))
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_denoise_cancelled(token: *const c_void) -> u32 {
    if token.is_null() {
        return 1;
    }
    unsafe { (*(token as *const CancelToken)).is_cancelled() as u32 }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_set_custom_denoiser(
    handle: u64,
    options: *const MtCustomDenoiser,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render = render_of(handle)?;
        if options.is_null() {
            return render.set_custom_denoiser(None, DenoiseSchedule::Converged);
        }
        let options = unsafe { record(options)? };
        let schedule = match options.schedule {
            0 => DenoiseSchedule::Converged,
            1 => DenoiseSchedule::Progressive,
            2 => DenoiseSchedule::EverySample,
            _ => return Err(invalid("Unknown denoise schedule")),
        };
        let callback = options
            .callback
            .ok_or_else(|| invalid("Null denoiser callback"))?;
        if options.aovs & !127 != 0 || options.reserved != 0 {
            return Err(invalid("Invalid custom AOV mask or reserved field"));
        }
        let filter = Arc::new(CFilter {
            aovs: options.aovs,
            callback,
            release: options.release,
            user: User(options.user),
        });
        render.set_custom_denoiser(Some(filter), schedule)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_denoiser_default(output: *mut MtRenderDenoiser) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe {
        output.write(MtRenderDenoiser {
            struct_size: std::mem::size_of::<MtRenderDenoiser>() as u32,
            backend: 0,
            schedule: 0,
            reserved: 0,
            library: std::ptr::null(),
        })
    };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_set_denoiser(
    handle: u64,
    denoiser: *const MtRenderDenoiser,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let options = if denoiser.is_null() {
            None
        } else {
            let d = unsafe { record(denoiser)? };
            if d.reserved != 0 {
                return Err(invalid("Reserved fields must be 0"));
            }
            let library = if d.library.is_null() {
                None
            } else {
                let text = unsafe { CStr::from_ptr(d.library) }
                    .to_str()
                    .map_err(|_| invalid("Library path must be UTF-8"))?;
                Some(std::path::PathBuf::from(text))
            };
            Some(DenoiserOptions {
                backend: d.backend,
                library,
                max_tile_size: 0,
                schedule: match d.schedule {
                    0 => DenoiseSchedule::Converged,
                    1 => DenoiseSchedule::Progressive,
                    2 => DenoiseSchedule::EverySample,
                    _ => return Err(invalid("Unknown denoise schedule")),
                },
            })
        };
        render_of(handle)?.set_denoiser(options)
    })
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MtJnlmOptions {
    struct_size: u32,
    strength: f32,
    search_radius: u32,
    patch_radius: u32,
    albedo_bandwidth: f32,
    normal_bandwidth: f32,
    iterations: u32,
    reserved: u32,
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_jnlm_options_default(output: *mut MtJnlmOptions) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe {
        output.write(MtJnlmOptions {
            struct_size: 32,
            strength: 1.,
            search_radius: 5,
            patch_radius: 1,
            albedo_bandwidth: 0.4,
            normal_bandwidth: 0.05,
            iterations: 2,
            reserved: 0,
        })
    };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_set_jnlm_display_filter(
    handle: u64,
    options: *const MtJnlmOptions,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let options = if options.is_null() {
            None
        } else {
            let o = unsafe { record(options)? };
            if o.reserved != 0 {
                return Err(invalid("Reserved must be zero"));
            }
            Some(JnlmOptions {
                strength: o.strength,
                search_radius: o.search_radius,
                patch_radius: o.patch_radius,
                albedo_bandwidth: o.albedo_bandwidth,
                normal_bandwidth: o.normal_bandwidth,
                iterations: o.iterations,
            })
        };
        render_of(handle)?.set_jnlm_display_filter(options)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_refine(
    handle: u64,
    status_out: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let status = render_of(handle)?.refine()?;
        unsafe { write_optional(status_out, render_status(status)) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_refine_until(
    handle: u64,
    budget_ms: f64,
    status_out: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if !budget_ms.is_finite() || budget_ms < 0. {
            return Err(invalid("Invalid refill budget"));
        }
        let duration = Duration::try_from_secs_f64(budget_ms / 1000.)
            .map_err(|_| invalid("Invalid refill budget"))?;
        let deadline = Instant::now()
            .checked_add(duration)
            .ok_or_else(|| invalid("Invalid refill budget"))?;
        let render = render_of(handle)?;
        let cancel = arm_cancel(handle)?;
        let status = render.refine_until(deadline, Some(&cancel))?;
        unsafe { write_optional(status_out, render_status(status)) };
        Ok(())
    })
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MtRefineOptions {
    struct_size: u32,
    batch_samples: u32,
    defer_resolve: u32,
    reserved: u32,
    target_batch_time_ms: f64,
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_refine_options_default(output: *mut MtRefineOptions) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe {
        output.write(MtRefineOptions {
            struct_size: 24,
            batch_samples: u32::MAX,
            defer_resolve: 0,
            reserved: 0,
            target_batch_time_ms: 0.,
        })
    };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_refine_with_options(
    handle: u64,
    options: *const MtRefineOptions,
    status_out: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let options = unsafe { record(options)? };
        if options.reserved != 0 || options.defer_resolve > 1 {
            return Err(invalid("Invalid refine flags"));
        }
        let batch_samples = match options.batch_samples {
            u32::MAX => None,
            0 => Some(false),
            1 => Some(true),
            _ => return Err(invalid("Invalid batch_samples")),
        };
        let status = render_of(handle)?.refine_with_options(RefineOptions {
            batch_samples,
            target_batch_time_ms: (options.target_batch_time_ms != 0.)
                .then_some(options.target_batch_time_ms),
            defer_resolve: options.defer_resolve != 0,
        })?;
        unsafe { write_optional(status_out, render_status(status)) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_gpu_sample_time(
    handle: u64,
    milliseconds: *mut f64,
    available: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let time = render_of(handle)?.gpu_sample_time_ms();
        unsafe {
            write_optional(milliseconds, time.unwrap_or(0.));
            write_optional(available, time.is_some() as u32);
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_denoise_current(
    handle: u64,
    done: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render = render_of(handle)?;
        if render.denoise_schedule().is_none() {
            return Err(error(Status::InvalidState, "No denoiser is set"));
        }
        let result = render.denoise_current()?;
        unsafe { write_optional(done, result as u32) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_collect(
    handle: u64,
    idle: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let result = render_of(handle)?.collect()?;
        unsafe { write_optional(idle, result as u32) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_restart(
    handle: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || render_of(handle)?.restart())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_converge_options_default(
    samples: u32,
    output: *mut MtConvergeOptions,
) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    let defaults = ConvergeOptions::new(samples);
    let camera = Camera::default();
    unsafe {
        output.write(MtConvergeOptions {
            struct_size: std::mem::size_of::<MtConvergeOptions>() as u32,
            samples,
            sample_sequence_offset: defaults.sample_sequence_offset,
            samples_per_batch: defaults.samples_per_batch,
            use_camera: 0,
            reserved: 0,
            timeout_ms: defaults.timeout_ms,
            camera,
            progress: None,
            user: std::ptr::null_mut(),
        })
    };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_converge(
    handle: u64,
    options: *const MtConvergeOptions,
    samples: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render = render_of(handle)?;
        let options = unsafe { converge_options(options, arm_cancel(handle)?)? };
        let result = render.converge(options)?;
        unsafe { write_optional(samples, result.samples) };
        Ok(())
    })
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MtConvergeTiming {
    struct_size: u32,
    reserved: u32,
    target_batch_time_ms: f64,
    preview_interval_ms: f64,
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_converge_timing_default(output: *mut MtConvergeTiming) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe {
        output.write(MtConvergeTiming {
            struct_size: 24,
            reserved: 0,
            target_batch_time_ms: 0.,
            preview_interval_ms: -1.,
        })
    };
    0
}
unsafe fn converge_timed(
    handle: u64,
    options: *const MtConvergeOptions,
    timing: *const MtConvergeTiming,
    is_loop: bool,
) -> Result<u32> {
    let t = unsafe { record(timing)? };
    if t.reserved != 0
        || !t.target_batch_time_ms.is_finite()
        || t.target_batch_time_ms < 0.
        || !t.preview_interval_ms.is_finite()
        || t.preview_interval_ms < 0. && t.preview_interval_ms != -1.
    {
        return Err(invalid("Invalid convergence timing"));
    }
    let render_handle = if is_loop {
        registry(|r| match r.objects.get(&handle) {
            Some(Object::Loop(l)) => Ok(l.final_render),
            _ => Err(invalid_handle()),
        })?
    } else {
        handle
    };
    let mut options = unsafe { converge_options(options, arm_cancel(render_handle)?)? };
    options.target_batch_time_ms = (t.target_batch_time_ms != 0.).then_some(t.target_batch_time_ms);
    options.preview_interval_ms = (t.preview_interval_ms >= 0.).then_some(t.preview_interval_ms);
    if is_loop {
        let render_loop = loop_of(handle)?;
        let result = lock_loop(&render_loop)?.converge(options)?;
        Ok(result.samples)
    } else {
        Ok(render_of(handle)?.converge(options)?.samples)
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_converge_with_timing(
    handle: u64,
    options: *const MtConvergeOptions,
    timing: *const MtConvergeTiming,
    samples: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let count = unsafe { converge_timed(handle, options, timing, false)? };
        unsafe { write_optional(samples, count) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_converge_with_timing(
    handle: u64,
    options: *const MtConvergeOptions,
    timing: *const MtConvergeTiming,
    samples: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let count = unsafe { converge_timed(handle, options, timing, true)? };
        unsafe { write_optional(samples, count) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_cancel(
    handle: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        registry(|r| match r.objects.get(&handle) {
            Some(Object::Render(e)) => {
                e.cancel.lock().unwrap_or_else(|e| e.into_inner()).cancel();
                Ok(())
            }
            _ => Err(invalid_handle()),
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_info(
    handle: u64,
    output: *mut MtRenderSnapshot,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        unsafe { record(output as *const MtRenderSnapshot)? };
        let render = render_of(handle)?;
        let report = render.denoise_report();
        let (backend, reason) = render
            .backend()
            .unwrap_or((Backend::Software, String::new()));
        let mut snapshot = MtRenderSnapshot {
            struct_size: std::mem::size_of::<MtRenderSnapshot>() as u32,
            status: render_status(render.status()),
            samples: render.samples(),
            width: render.width(),
            height: render.height(),
            converged: render.converged() as u32,
            denoising: render.denoising() as u32,
            last_commit: match render.last_commit()? {
                None => 0,
                Some(CommitKind::Full) => 1,
                Some(CommitKind::Incremental) => 2,
            },
            backend: backend.code(),
            denoised_samples: report.as_ref().map_or(0, |r| r.samples),
            denoise_ms: report.as_ref().map_or(0., |r| r.milliseconds as f32),
            denoise_device: [0; 64],
            message: [0; 256],
        };
        if let Some(report) = &report {
            fill(&mut snapshot.denoise_device, &report.backend);
        }
        let message = report.and_then(|r| r.error).unwrap_or(reason);
        fill(&mut snapshot.message, &message);
        unsafe { output.write(snapshot) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_read_pixels(
    handle: u64,
    kind: u32,
    pixels: *mut c_void,
    size: usize,
    written: *mut usize,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let kind = match kind {
            0 => PixelKind::Hdr,
            1 => PixelKind::Normal,
            2 => PixelKind::Albedo,
            3 => PixelKind::Denoised,
            4 => PixelKind::Depth,
            5 => PixelKind::Position,
            6 => PixelKind::Roughness,
            7 => PixelKind::DiffuseAlbedo,
            8 => PixelKind::SpecularAlbedo,
            9 => PixelKind::Id,
            10 => PixelKind::Motion,
            _ => return Err(invalid("Unknown image kind")),
        };
        if written.is_null() {
            return Err(invalid("Null written"));
        }
        let image = render_of(handle)?.read_pixels(kind)?;
        let bytes: Vec<u8> = match image.id_data {
            Some(ids) => bytemuck::cast_slice(&ids).to_vec(),
            None => bytemuck::cast_slice(&image.data).to_vec(),
        };
        unsafe { copy_out(&bytes, pixels, size, written) }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_set_callback(
    handle: u64,
    callback: Option<SampleCallback>,
    user: *mut c_void,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render = render_of(handle)?;
        let subscription = callback.map(|callback| {
            let user = User(user);
            render.on_sample(move |event| {
                let user = user;
                callback(
                    event.samples,
                    event.is_first_frame as u32,
                    event.frame_time_ms,
                    user.0,
                )
            })
        });
        let previous = registry(|r| match r.objects.get_mut(&handle) {
            Some(Object::Render(e)) => Ok(std::mem::replace(&mut e.callback, subscription)),
            _ => Err(invalid_handle()),
        })?;
        drop(previous);
        Ok(())
    })
}

// ---- Render loop ----

/// A C sync: `update` writes state, `active` (optional) reports interaction.
struct CSync {
    update: extern "C" fn(*mut c_void),
    active: Option<extern "C" fn(*mut c_void) -> u32>,
    user: User,
    activity: SyncActivity,
}
impl LoopSync for CSync {
    fn update(&mut self) {
        (self.update)(self.user.0)
    }
    fn activity(&self) -> &SyncActivity {
        &self.activity
    }
    fn activity_mut(&mut self) -> &mut SyncActivity {
        &mut self.activity
    }
    fn active(&self) -> bool {
        self.active.is_some_and(|active| active(self.user.0) != 0)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_options_default(output: *mut MtRenderLoopOptions) -> i32 {
    if output.is_null() {
        return Status::InvalidArgument as i32;
    }
    unsafe {
        output.write(MtRenderLoopOptions {
            struct_size: std::mem::size_of::<MtRenderLoopOptions>() as u32,
            preview: 1,
            coalesce_scene_updates: 0,
            reserved: 0,
            idle_ms: 150.,
            preview_options: std::ptr::null(),
            final_options: std::ptr::null(),
            select: None,
            select_user: std::ptr::null_mut(),
        })
    };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_create(
    engine: u64,
    options: *const MtRenderLoopOptions,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let options = unsafe { record(options)? };
        if options.reserved != 0 || options.preview > 1 || options.coalesce_scene_updates > 1 {
            return Err(invalid("Reserved fields must be 0 and flags 0 or 1"));
        }
        if output.is_null() {
            return Err(invalid("Null output"));
        }
        let settings = |pointer: *const MtRenderOptions| -> Result<LoopRender> {
            Ok(if pointer.is_null() {
                LoopRender::Default
            } else {
                LoopRender::Settings(render_settings(unsafe { record(pointer)? })?)
            })
        };
        let select = options.select.map(|select| {
            let user = User(options.select_user);
            Box::new(move |info: SelectInfo| {
                let user = user;
                if select(info.changing as u32, user.0) == 0 {
                    Selection::Preview
                } else {
                    Selection::Final
                }
            }) as Box<dyn FnMut(SelectInfo) -> Selection + Send>
        });
        let render_loop = RenderLoop::new(
            &engine_of(engine)?,
            RenderLoopOptions {
                display: None,
                preview: if options.preview != 0 {
                    Some(settings(options.preview_options)?)
                } else {
                    None
                },
                final_render: settings(options.final_options)?,
                syncs: Vec::new(),
                idle_ms: options.idle_ms,
                coalesce_scene_updates: options.coalesce_scene_updates != 0,
                select,
            },
        )?;
        let final_render = render_loop.final_render().clone();
        let preview = render_loop.preview().cloned();
        let handle = insert(Object::Loop(LoopEntry {
            engine,
            render_loop: Arc::new(Mutex::new(render_loop)),
            final_render: 0,
            preview: None,
            syncs: HashMap::new(),
            callbacks: Vec::new(),
        }))?;
        let final_handle = register_render(engine, final_render, Some(handle))?;
        let preview_handle = preview
            .map(|p| register_render(engine, p, Some(handle)))
            .transpose()?;
        registry(|r| {
            if let Some(Object::Loop(l)) = r.objects.get_mut(&handle) {
                l.final_render = final_handle;
                l.preview = preview_handle;
            }
            Ok(())
        })?;
        unsafe { output.write(handle) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_destroy(
    handle: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        loop_of(handle)?;
        let removed = registry(|r| {
            let Some(Object::Loop(l)) = r.objects.get(&handle) else {
                return Err(invalid_handle());
            };
            let mut handles = vec![handle, l.final_render];
            handles.extend(l.preview);
            Ok(handles
                .into_iter()
                .filter_map(|h| r.objects.remove(&h))
                .collect::<Vec<_>>())
        })?;
        drop(removed);
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_render(
    handle: u64,
    which: u32,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        loop_of(handle)?;
        let render = registry(|r| match r.objects.get(&handle) {
            Some(Object::Loop(l)) => match which {
                0 => l
                    .preview
                    .ok_or_else(|| error(Status::InvalidState, "The loop has no preview render")),
                1 => Ok(l.final_render),
                _ => Err(invalid("Unknown loop render")),
            },
            _ => Err(invalid_handle()),
        })?;
        unsafe { write_required(output, render) }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_tick(
    handle: u64,
    status_out: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render_loop = loop_of(handle)?;
        let status = lock_loop(&render_loop)?.tick()?;
        unsafe { write_optional(status_out, loop_status(status)) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_needs_tick(
    handle: u64,
    needs: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render_loop = loop_of(handle)?;
        let result = lock_loop(&render_loop)?.needs_tick();
        unsafe { write_required(needs, result as u32) }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_refill(
    handle: u64,
    active: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render_loop = loop_of(handle)?;
        let result = lock_loop(&render_loop)?.refill()?;
        unsafe { write_optional(active, result as u32) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_needs_refill(
    handle: u64,
    active: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render_loop = loop_of(handle)?;
        let result = lock_loop(&render_loop)?.needs_refill();
        unsafe { write_optional(active, result as u32) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_cancel_refill(
    handle: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render_loop = loop_of(handle)?;
        lock_loop(&render_loop)?.cancel_refill();
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_converge(
    handle: u64,
    options: *const MtConvergeOptions,
    samples: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render_loop = loop_of(handle)?;
        let final_render = registry(|r| match r.objects.get(&handle) {
            Some(Object::Loop(l)) => Ok(l.final_render),
            _ => Err(invalid_handle()),
        })?;
        let options = unsafe { converge_options(options, arm_cancel(final_render)?)? };
        let result = lock_loop(&render_loop)?.converge(options)?;
        unsafe { write_optional(samples, result.samples) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_info(
    handle: u64,
    output: *mut MtRenderLoopSnapshot,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        unsafe { record(output as *const MtRenderLoopSnapshot)? };
        let render_loop = loop_of(handle)?;
        let render_loop = lock_loop(&render_loop)?;
        let snapshot = MtRenderLoopSnapshot {
            struct_size: std::mem::size_of::<MtRenderLoopSnapshot>() as u32,
            status: loop_status(render_loop.status()),
            samples: render_loop.samples(),
            changing: render_loop.changing() as u32,
            presentations: render_loop.presentations(),
            last_presented: presented_record(render_loop.last_presented()),
            reserved: 0,
        };
        unsafe { output.write(snapshot) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_set_callback(
    handle: u64,
    callback: Option<LoopCallback>,
    user: *mut c_void,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render_loop = loop_of(handle)?;
        let subscriptions = match callback {
            None => Vec::new(),
            Some(callback) => {
                let render_loop = lock_loop(&render_loop)?;
                let user = User(user);
                vec![
                    render_loop.on_status(move |status, _| {
                        let user = user;
                        callback(0, loop_status(status), user.0)
                    }),
                    render_loop.on_sample(move |event| {
                        let user = user;
                        callback(1, event.samples, user.0)
                    }),
                ]
            }
        };
        let previous = registry(|r| match r.objects.get_mut(&handle) {
            Some(Object::Loop(l)) => Ok(std::mem::replace(&mut l.callbacks, subscriptions)),
            _ => Err(invalid_handle()),
        })?;
        drop(previous);
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_add_sync(
    handle: u64,
    sync: *const MtLoopSync,
    id: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let sync = unsafe { record(sync)? };
        let Some(update) = sync.update else {
            return Err(invalid("Null sync update"));
        };
        if sync.reserved != 0 || id.is_null() {
            return Err(invalid("Reserved fields must be 0 and id is required"));
        }
        let shared: SharedSync = Arc::new(Mutex::new(CSync {
            update,
            active: sync.active,
            user: User(sync.user),
            activity: SyncActivity::default(),
        }));
        let render_loop = loop_of(handle)?;
        lock_loop(&render_loop)?.add_sync(shared.clone());
        let sync_id = registry(|r| {
            let sync_id = r.next;
            r.next += 1;
            match r.objects.get_mut(&handle) {
                Some(Object::Loop(l)) => {
                    l.syncs.insert(sync_id, shared);
                    Ok(sync_id)
                }
                _ => Err(invalid_handle()),
            }
        })?;
        unsafe { id.write(sync_id) };
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_loop_remove_sync(
    handle: u64,
    id: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let render_loop = loop_of(handle)?;
        let mut guard = lock_loop(&render_loop)?;
        let sync = registry(|r| match r.objects.get_mut(&handle) {
            Some(Object::Loop(l)) => l
                .syncs
                .remove(&id)
                .ok_or_else(|| error(Status::InvalidHandle, "Unknown sync id")),
            _ => Err(invalid_handle()),
        })?;
        guard.remove_sync(&sync);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The value of `NAME = value` in mutracer-engine.h or mutracer-status.h.
    fn value(name: &str) -> u32 {
        let headers = [
            include_str!("../../../include/mutracer-engine.h"),
            include_str!("../../../include/mutracer-status.h"),
        ];
        let pattern = format!("{name} = ");
        let text = headers
            .iter()
            .find_map(|h| h.split_once(&pattern).map(|(_, rest)| rest))
            .unwrap_or_else(|| panic!("{name} missing from the headers"));
        text.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap()
    }
    #[test]
    fn render_backend_selection_keeps_the_standalone_oidn_contract() {
        let _test = crate::ABI_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(engine) = super::super::tests::software_engine(Backend::Software) else {
            return;
        };
        let engine_handle = register_engine(engine.clone(), None).unwrap();
        let render = Arc::new(Render::new(&engine, RenderSettings::default()).unwrap());
        let render_handle = register_render(engine_handle, render.clone(), None).unwrap();
        let mut desc = std::mem::MaybeUninit::<MtRenderDenoiser>::uninit();
        assert_eq!(unsafe { mt_render_denoiser_default(desc.as_mut_ptr()) }, 0);
        let mut desc = unsafe { desc.assume_init() };
        desc.backend = DENOISE_OIDN_WEBGPU;
        desc.schedule = 1;
        let mut message = [0; 512];
        let code = unsafe {
            mt_render_set_denoiser(render_handle, &desc, message.as_mut_ptr(), message.len())
        };
        assert_eq!(
            code,
            if OIDN_WEBGPU_AVAILABLE {
                0
            } else {
                Status::Unavailable as i32
            }
        );
        if OIDN_WEBGPU_AVAILABLE {
            assert_eq!(render.denoiser().unwrap().backend, DENOISE_OIDN_WEBGPU);
            let previous = render.denoiser();
            for max_tile_size in [1, 15, 16385, u32::MAX] {
                assert_eq!(
                    render
                        .set_denoiser(Some(DenoiserOptions {
                            backend: DENOISE_OIDN_WEBGPU,
                            max_tile_size,
                            ..Default::default()
                        }))
                        .unwrap_err()
                        .status,
                    Status::InvalidArgument
                );
                assert_eq!(render.denoiser(), previous);
            }
        }
        // The render-only value must never select a different mt_denoiser_* backend.
        assert!(crate::denoise::Denoiser::with_backend(DENOISE_OIDN_WEBGPU).is_err());
        assert_eq!(
            unsafe { mt_engine_destroy(engine_handle, message.as_mut_ptr(), message.len()) },
            0
        );
    }

    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn device_loss_owned_device_delivers_c_event_once_and_keeps_failure_sticky() {
        let _test = crate::ABI_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        struct Events {
            engine: u64,
            loss: u32,
            errors: u32,
            recovered: bool,
            reentry: i32,
        }
        extern "C" fn callback(event: *const MtEngineEvent, user: *mut c_void) {
            let event = unsafe { &*event };
            let state = unsafe { &mut *(user as *mut Events) };
            if event.kind == 2 {
                state.loss += 1;
                state.recovered |= event.recovering != 0;
                assert!(!event.message.is_null());
                let mut message = [0; 256];
                state.reentry = unsafe {
                    mt_engine_update(
                        state.engine,
                        std::ptr::null_mut(),
                        message.as_mut_ptr(),
                        message.len(),
                    )
                };
            } else if event.kind == 1 {
                state.errors += 1;
            }
        }
        let options = MtEngineOptions {
            struct_size: std::mem::size_of::<MtEngineOptions>() as u32,
            backend: 0,
        };
        let mut handle = 0;
        let mut error = [0; 512];
        unsafe {
            assert_eq!(
                mt_engine_create(&options, &mut handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
        let engine = engine_of(handle).unwrap();
        let mut events = Events {
            engine: handle,
            loss: 0,
            errors: 0,
            recovered: false,
            reentry: 0,
        };
        unsafe {
            assert_eq!(
                mt_engine_set_callback(
                    handle,
                    Some(callback),
                    (&mut events as *mut Events).cast(),
                    error.as_mut_ptr(),
                    error.len()
                ),
                0
            );
        }
        engine.inner.gpu.device.destroy();
        for _ in 0..2 {
            unsafe {
                assert_eq!(
                    mt_engine_update(
                        handle,
                        std::ptr::null_mut(),
                        error.as_mut_ptr(),
                        error.len()
                    ),
                    Status::Unavailable as i32
                );
            }
        }
        assert_eq!(
            (events.loss, events.errors, events.recovered, events.reentry),
            (1, 1, false, Status::Unavailable as i32)
        );
        assert!(engine.last_error().unwrap().contains("GPU device lost"));
        unsafe {
            assert_eq!(
                mt_engine_destroy(handle, error.as_mut_ptr(), error.len()),
                0
            );
        }
        engine
            .device_loss_notifier()
            .notify("ignored after disposal");
        engine.flush();
        assert_eq!(events.loss, 1);
    }
    #[test]
    fn header_enums_match_the_conversions() {
        for (name, status) in [
            ("MT_RENDER_PREPARING", RenderStatus::Preparing),
            ("MT_RENDER_COMPILING", RenderStatus::Compiling),
            ("MT_RENDER_CONVERGING", RenderStatus::Converging),
            ("MT_RENDER_DENOISING", RenderStatus::Denoising),
            ("MT_RENDER_FINISHED", RenderStatus::Finished),
            ("MT_RENDER_ERROR", RenderStatus::Error),
        ] {
            assert_eq!(value(name), render_status(status), "{name}");
        }
        for (name, status) in [
            ("MT_LOOP_PREPARING", RenderLoopStatus::Preparing),
            ("MT_LOOP_CONVERGING", RenderLoopStatus::Converging),
            ("MT_LOOP_FINISHED", RenderLoopStatus::Finished),
            ("MT_LOOP_ERROR", RenderLoopStatus::Error),
            ("MT_LOOP_PREVIEWING", RenderLoopStatus::Previewing),
        ] {
            assert_eq!(value(name), loop_status(status), "{name}");
        }
        for (name, tone) in [
            ("MT_TONE_MAPPING_AGX", ToneMapping::Agx),
            ("MT_TONE_MAPPING_ACES", ToneMapping::Aces),
            ("MT_TONE_MAPPING_CINEON", ToneMapping::Cineon),
            ("MT_TONE_MAPPING_REINHARD", ToneMapping::Reinhard),
            ("MT_TONE_MAPPING_LINEAR", ToneMapping::Linear),
        ] {
            let mut record = display_record(&DisplaySettings::default());
            record.tone_mapping = value(name);
            assert_eq!(
                display_settings(&record).unwrap().tone_mapping,
                tone,
                "{name}"
            );
        }
        for (name, channel) in [
            ("MT_CHANNEL_FINAL", Channel::Final),
            ("MT_CHANNEL_NORMAL", Channel::Normal),
            ("MT_CHANNEL_ALBEDO", Channel::Albedo),
            ("MT_CHANNEL_SHADOW", Channel::Shadow),
            ("MT_CHANNEL_SHADOW_CATCHER", Channel::ShadowCatcher),
        ] {
            let mut record = display_record(&DisplaySettings::default());
            record.channel = value(name);
            assert_eq!(
                display_settings(&record).unwrap().channel,
                channel,
                "{name}"
            );
        }
        assert_eq!(value("MT_IMAGE_DENOISED"), 3);
        assert_eq!(value("MT_DISPLAY_PNG"), 1);
        assert_eq!(value("MT_DENOISE_EVERY_SAMPLE"), 2);
        assert_eq!(value("MT_DENOISE_OIDN_WEBGPU"), 5);
        assert_eq!(value("MT_LOOP_SELECT_FINAL"), 1);
    }
    #[test]
    fn aov_display_options_extend_channels_without_changing_the_existing_record() {
        let mut words = [0xdeadbeefu32; 8];
        assert_eq!(
            unsafe { mt_display_aov_options_default(words.as_mut_ptr().cast()) },
            0
        );
        let options = unsafe { record::<MtAovDisplayOptions>(words.as_ptr().cast()) }.unwrap();
        assert_eq!(options.depth_range, [0., 10.]);
        assert_eq!(options.position_scale, 1.);
        assert_eq!(options.motion_scale, 16.);
        assert_eq!(options.id_component, 0);
        assert_eq!(words[6..], [0xdeadbeef; 2]);
        assert_eq!(std::mem::size_of::<MtDisplaySettings>(), 68);
        assert_eq!(std::mem::size_of::<MtAovDisplayOptions>(), 24);
        for (channel, kind) in [
            (5, PixelKind::Depth),
            (6, PixelKind::Position),
            (7, PixelKind::Roughness),
            (8, PixelKind::DiffuseAlbedo),
            (9, PixelKind::SpecularAlbedo),
            (10, PixelKind::Id),
            (11, PixelKind::Motion),
        ] {
            let mut r = display_record(&DisplaySettings::default());
            r.channel = channel;
            assert_eq!(display_settings(&r).unwrap().channel.aov_kind(), Some(kind));
        }
    }
    #[test]
    fn display_settings_use_the_current_record_and_preserve_effects() {
        let mut output = [0xdeadbeefu32; 20];
        assert_eq!(
            unsafe { mt_display_settings_default(output.as_mut_ptr().cast()) },
            0
        );
        let current = unsafe { record::<MtDisplaySettings>(output.as_ptr().cast()) }.unwrap();
        assert_eq!(
            display_settings(current).unwrap(),
            DisplaySettings::default()
        );
        assert_eq!(output[17..], [0xdeadbeef; 3]);
        assert_eq!(
            unsafe { mt_display_settings_default(std::ptr::null_mut()) },
            Status::InvalidArgument as i32
        );
        let settings = DisplaySettings {
            vignette: 0.5,
            bloom_intensity: 2.,
            bloom_radius: 0.8,
            shadow_catcher_color: [0.1, 0.2, 0.3],
            hdr_output_enabled: true,
            ..Default::default()
        };
        unsafe { write_record(output.as_mut_ptr().cast(), display_record(&settings)) }.unwrap();
        let current = unsafe { record::<MtDisplaySettings>(output.as_ptr().cast()) }.unwrap();
        assert_eq!(display_settings(current).unwrap(), settings);
        assert_eq!(output[17..], [0xdeadbeef; 3]);
        let mut invalid = display_record(&settings);
        invalid.hdr_output_enabled = 2;
        assert!(display_settings(&invalid).is_err());
        for size in [0, 32, 48, 64, 66, 72] {
            output[0] = size;
            let before = output;
            assert!(unsafe { record::<MtDisplaySettings>(output.as_ptr().cast()) }.is_err());
            assert!(
                unsafe { write_record(output.as_mut_ptr().cast(), display_record(&settings)) }
                    .is_err()
            );
            assert_eq!(output, before);
        }
    }
    /// Sizes and field offsets of mutracer-engine.h (64-bit pointers).
    #[test]
    fn records_match_the_header_layouts() {
        use std::mem::{offset_of, size_of};
        let pointer = size_of::<*const u8>();
        assert_eq!(size_of::<MtEngineOptions>(), 8);
        assert_eq!(size_of::<MtGpuAdapterInfo>(), 288);
        assert_eq!(offset_of!(MtGpuAdapterInfo, name), 32);
        assert_eq!(size_of::<MtDepthSampleArea>(), 16);
        assert_eq!(offset_of!(MtDepthSampleArea, x), 4);
        assert_eq!(offset_of!(MtDepthSampleArea, size), 12);
        assert_eq!(size_of::<MtEngineSnapshot>(), 268);
        assert_eq!(offset_of!(MtEngineSnapshot, adapter_name), 12);
        assert_eq!(size_of::<MtEngineEvent>(), 16 + pointer);
        assert_eq!(offset_of!(MtEngineEvent, message), 16);
        assert_eq!(size_of::<MtDisplaySettings>(), 68);
        assert_eq!(offset_of!(MtDisplaySettings, vignette), 32);
        assert_eq!(offset_of!(MtDisplaySettings, shadow_catcher_alpha), 60);
        assert_eq!(offset_of!(MtDisplaySettings, hdr_output_enabled), 64);
        assert_eq!(offset_of!(MtDisplaySettings, tone_mapping_exposure), 12);
        assert_eq!(offset_of!(MtDisplaySettings, tint), 28);
        assert_eq!(size_of::<MtPresented>(), 20);
        assert_eq!(size_of::<MtRenderOptions>(), 128);
        assert_eq!(offset_of!(MtRenderOptions, adaptive_target_frame_ms), 88);
        assert_eq!(offset_of!(MtRenderOptions, adaptive_min_scale), 96);
        assert_eq!(offset_of!(MtRenderOptions, alpha_blend_strategy), 104);
        assert_eq!(offset_of!(MtRenderOptions, reserved_tail), 108);
        assert_eq!(offset_of!(MtRenderOptions, seed), 44);
        assert_eq!(offset_of!(MtRenderOptions, aovs), 48);
        assert_eq!(offset_of!(MtRenderOptions, resolution_scale), 56);
        assert_eq!(offset_of!(MtRenderOptions, time_budget_ms), 80);
        assert_eq!(size_of::<MtRenderDenoiser>(), 16 + pointer);
        assert_eq!(offset_of!(MtRenderDenoiser, library), 16);
        assert_eq!(size_of::<MtConvergeOptions>(), 160 + 2 * pointer);
        assert_eq!(offset_of!(MtConvergeOptions, timeout_ms), 24);
        assert_eq!(offset_of!(MtConvergeOptions, camera), 32);
        assert_eq!(offset_of!(MtConvergeOptions, progress), 160);
        assert_eq!(offset_of!(MtConvergeOptions, user), 160 + pointer);
        assert_eq!(size_of::<MtRenderSnapshot>(), 364);
        assert_eq!(offset_of!(MtRenderSnapshot, denoise_ms), 40);
        assert_eq!(offset_of!(MtRenderSnapshot, denoise_device), 44);
        assert_eq!(offset_of!(MtRenderSnapshot, message), 108);
        assert_eq!(size_of::<MtRenderLoopOptions>(), 24 + 4 * pointer);
        assert_eq!(offset_of!(MtRenderLoopOptions, idle_ms), 16);
        assert_eq!(offset_of!(MtRenderLoopOptions, preview_options), 24);
        assert_eq!(
            offset_of!(MtRenderLoopOptions, select_user),
            24 + 3 * pointer
        );
        assert_eq!(size_of::<MtRenderLoopSnapshot>(), 48);
        assert_eq!(offset_of!(MtRenderLoopSnapshot, presentations), 16);
        assert_eq!(offset_of!(MtRenderLoopSnapshot, last_presented), 24);
        assert_eq!(offset_of!(MtRenderLoopSnapshot, reserved), 44);
        assert_eq!(size_of::<MtLoopSync>(), 8 + 3 * pointer);
        assert_eq!(offset_of!(MtLoopSync, user), 8 + 2 * pointer);
        // The header asserts the same sizes in C.
        let header = include_str!("../../../include/mutracer-engine.h");
        for name in [
            "mt_engine_options, 8",
            "mt_depth_sample_area, 16",
            "mt_engine_snapshot, 268",
            "mt_display_settings, 68",
            "mt_presented, 20",
            "mt_render_options, 128",
            "mt_render_snapshot, 364",
            "mt_render_loop_snapshot, 48",
        ] {
            assert!(
                header.contains(&format!("MT_ENGINE_LAYOUT({name})")),
                "{name}"
            );
        }
    }
    #[test]
    fn render_options_default_initializes_the_current_record() {
        let mut output = [0xdeadbeefu64; 18];
        assert_eq!(
            unsafe { mt_render_options_default(output.as_mut_ptr().cast()) },
            0
        );
        let current = unsafe { record::<MtRenderOptions>(output.as_ptr().cast()) }.unwrap();
        assert_eq!(render_settings(current).unwrap(), RenderSettings::default());
        assert_eq!(output[16..], [0xdeadbeef; 2]);
        assert_eq!(
            unsafe { mt_render_options_default(std::ptr::null_mut()) },
            Status::InvalidArgument as i32
        );
        for size in [0, 104, 112, 127, 129] {
            output[0] = (output[0] & !0xffffffff) | size as u64;
            assert!(unsafe { record::<MtRenderOptions>(output.as_ptr().cast()) }.is_err());
        }
    }
    #[test]
    fn render_options_round_trip_and_reject_invalid_records() {
        let mut options = render_options(&RenderSettings::default());
        assert_eq!(
            render_settings(&options).unwrap(),
            RenderSettings::default()
        );
        options.width = 64;
        options.height = 48;
        assert_eq!(
            render_settings(&options).unwrap().size,
            RenderSize::Fixed {
                width: 64,
                height: 48
            }
        );
        for edit in [
            |o: &mut MtRenderOptions| o.width = 0,
            |o: &mut MtRenderOptions| o.aovs = 128,
            |o: &mut MtRenderOptions| o.bevel = 2,
            |o: &mut MtRenderOptions| o.sampling_pattern = 3,
            |o: &mut MtRenderOptions| o.max_samples = 0,
            |o: &mut MtRenderOptions| o.alpha_blend_strategy = 2,
            |o: &mut MtRenderOptions| o.reserved_tail = 1,
            |o: &mut MtRenderOptions| o.caustic_flags = 16,
            |o: &mut MtRenderOptions| o.caustic_flags = 8,
            |o: &mut MtRenderOptions| o.photon_map_radius = -1.,
            |o: &mut MtRenderOptions| o.photon_map_radius = f32::NAN,
        ] {
            let mut invalid = options;
            edit(&mut invalid);
            assert_eq!(
                render_settings(&invalid).unwrap_err().status,
                Status::InvalidArgument
            );
        }
    }
}

#[cfg(test)]
mod adapter_tests {
    use super::*;
    #[test]
    #[ignore = "requires a real GPU; run separately"]
    fn c_enumeration_selection_and_invalid_index() {
        let mut count = 0;
        let mut message = [0; 1024];
        assert_eq!(
            unsafe {
                mt_gpu_adapters(
                    std::ptr::null_mut(),
                    0,
                    &mut count,
                    message.as_mut_ptr(),
                    message.len(),
                )
            },
            0
        );
        assert!(count > 0);
        let mut adapters: Vec<MtGpuAdapterInfo> =
            (0..count).map(|_| unsafe { std::mem::zeroed() }).collect();
        assert_eq!(
            unsafe {
                mt_gpu_adapters(
                    adapters.as_mut_ptr(),
                    count - 1,
                    &mut count,
                    message.as_mut_ptr(),
                    message.len(),
                )
            },
            Status::BufferTooSmall as i32
        );
        assert!(adapters.iter().all(|a| a.struct_size == 0));
        let capacity = adapters.len();
        assert_eq!(
            unsafe {
                mt_gpu_adapters(
                    adapters.as_mut_ptr(),
                    capacity,
                    &mut count,
                    message.as_mut_ptr(),
                    message.len(),
                )
            },
            0
        );
        let options = MtEngineOptions {
            struct_size: 8,
            backend: 0,
        };
        let mut handle = 0;
        assert_eq!(
            unsafe {
                mt_engine_create_on_adapter(
                    &options,
                    u32::MAX,
                    &mut handle,
                    message.as_mut_ptr(),
                    message.len(),
                )
            },
            Status::Unavailable as i32
        );
        assert_eq!(handle, 0);
        let index = adapters
            .iter()
            .position(|a| a.device_type == 1 || a.device_type == 2)
            .expect("hardware adapter");
        assert_eq!(
            unsafe {
                mt_engine_create_on_adapter(
                    &options,
                    index as u32,
                    &mut handle,
                    message.as_mut_ptr(),
                    message.len(),
                )
            },
            0
        );
        let info = engine_of(handle).unwrap().info();
        let name = unsafe { CStr::from_ptr(adapters[index].name.as_ptr()) }
            .to_str()
            .unwrap();
        assert_eq!(info.adapter_name, name);
        println!("C selected adapter {index}: {name}");
        assert_eq!(
            unsafe { mt_engine_destroy(handle, message.as_mut_ptr(), message.len()) },
            0
        );
    }
}
