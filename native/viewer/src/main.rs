//! Small native example: glTF input → native MuTracer library → egui image.
mod animation;
mod controls;
mod denoiser;
#[cfg(all(target_os = "windows", feature = "dlss-rr"))]
mod dlss;
mod dock;
mod edit_bench;
mod environment_browser;
mod examples;
mod focus;
mod focus_smoke;
mod geometry_smoke;
mod history;
#[cfg(all(feature = "hot-reload", debug_assertions))]
mod hot_reload;
mod input;
mod live_denoise_smoke;
mod material_presets;
mod metrics;
mod model_scene;
mod package_smoke;
mod parity_smoke;
mod picking;
mod renderer;
mod resolution;
mod scene;
mod scene_tree;
mod shell;
mod sky;
mod studio;
mod studio_smoke;
mod textures;
mod theme;
mod ui;
#[cfg(test)]
mod ui_smoke;
mod workflow;
use anyhow::{Context, Result, ensure};
use eframe::egui;
use mutracer_native_probe::api;
use renderer::{Camera, RenderSettings, Renderer};
use scene::{Descriptor, Environment, KeyLight, Model};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Change {
    None,
    Reset,
    Camera,
    Material,
    Environment,
    Light,
    Transform,
    Scene,
}
/// One engine and its render loop. A backend switch prepares a second target
/// while the current one keeps its image on screen.
struct Target {
    engine: api::Engine,
    render_loop: api::RenderLoop,
    activity: api::SharedSync,
    backend: u32,
    /// Whether a scene was handed to the engine.
    pushed: bool,
    /// Scene preparations started (full commits), counted from engine events.
    preparations: Arc<AtomicU32>,
    errors: Arc<Mutex<Vec<String>>>,
    _events: api::Subscription,
    sample_times: Arc<Mutex<std::collections::VecDeque<f64>>>,
    _sample_events: Vec<api::Subscription>,
}
#[derive(Default)]
struct InputActivity(api::SyncActivity);
impl api::LoopSync for InputActivity {
    fn update(&mut self) {}
    fn activity(&self) -> &api::SyncActivity {
        &self.0
    }
    fn activity_mut(&mut self) -> &mut api::SyncActivity {
        &mut self.0
    }
}
impl Target {
    fn new(
        gpu: Option<&eframe::egui_wgpu::RenderState>,
        gate: Option<&Arc<mutracer_native_probe::submission::SubmissionGate>>,
        backend: u32,
        settings: api::RenderSettings,
    ) -> Result<Self> {
        let options = api::EngineOptions {
            backend: if backend == 1 {
                api::Backend::Hardware
            } else {
                api::Backend::Software
            },
        };
        let engine = match gpu {
            Some(gpu) => api::Engine::on_device(
                &gpu.adapter,
                &gpu.device,
                &gpu.queue,
                options,
                gate.cloned(),
            ),
            None => api::Engine::new(options)?,
        };
        let activity: api::SharedSync = Arc::new(Mutex::new(InputActivity::default()));
        let render_loop = api::RenderLoop::new(
            &engine,
            api::RenderLoopOptions {
                preview: Some(api::LoopRender::Settings(denoiser::preview_settings())),
                final_render: api::LoopRender::Settings(settings),
                syncs: vec![activity.clone()],
                ..Default::default()
            },
        )?;
        let preparations = Arc::new(AtomicU32::new(0));
        let errors = Arc::new(Mutex::new(Vec::new()));
        let (counted, reported) = (preparations.clone(), errors.clone());
        let events = engine.on(move |event| match event {
            api::EngineEvent::Progress { progress, .. } if *progress == 0. => {
                counted.fetch_add(1, Ordering::Relaxed);
            }
            api::EngineEvent::Error { message } => reported.lock().unwrap().push(message.clone()),
            _ => {}
        });
        let sample_times = Arc::new(Mutex::new(std::collections::VecDeque::new()));
        let sample_events = [render_loop.preview().unwrap(), render_loop.final_render()]
            .into_iter()
            .map(|render| {
                let times = sample_times.clone();
                render.on_sample(move |event| {
                    let mut times = times.lock().unwrap();
                    times.push_back(event.frame_time_ms);
                    if times.len() > 80 {
                        times.pop_front();
                    }
                })
            })
            .collect();
        Ok(Self {
            sample_times,
            _sample_events: sample_events,
            engine,
            render_loop,
            activity,
            backend,
            pushed: false,
            preparations,
            errors,
            _events: events,
        })
    }
    fn final_render(&self) -> &api::Render {
        self.render_loop.final_render()
    }
    /// The channel whose pending frame must finish before accepting another edit.
    fn collecting_render(&self) -> &api::Render {
        if self.render_loop.status() == api::RenderLoopStatus::Previewing {
            self.render_loop.preview().unwrap()
        } else {
            self.final_render()
        }
    }
    /// A pushed scene is still being prepared; its edits wait.
    fn preparing(&self) -> bool {
        self.pushed && self.final_render().status() == api::RenderStatus::Preparing
    }
}
/// The viewer's render settings as an L1 render. Viewer descriptors keep the
/// bevel and dispersion quality bits clear, so the render does too.
fn render_settings(settings: &RenderSettings, size: [u32; 2], held: bool) -> api::RenderSettings {
    api::RenderSettings {
        caustics: api::CausticSettings {
            light_tracing: settings.caustic_flags & 2 != 0,
            photon_mapping: settings.caustic_flags & 4 != 0,
            light_photons: settings.light_photons,
            photon_map_photons: settings.photon_map_photons,
            photon_map_radius: settings.photon_map_radius,
        },
        max_samples: settings.max_samples.clamp(1, 16384),
        bounces: settings.bounces,
        clamping: settings.clamping,
        sampling_pattern: match settings.sampling_pattern {
            1 => api::SamplingPattern::ZSobol,
            2 => api::SamplingPattern::Random,
            _ => api::SamplingPattern::Sobol,
        },
        direct_light_candidates: settings.direct_light_candidates,
        bevel: false,
        bevel_samples: settings.bevel_samples,
        dispersion_wavelengths: 1,
        transmissive_output_alpha_min: settings.transmissive_output_alpha_min,
        // Held input traces one sample per frame, as before.
        batch_samples: !held,
        size: api::RenderSize::Fixed {
            width: size[0],
            height: size[1],
        },
        seed: settings.seed,
        ..Default::default()
    }
}
fn display_settings(settings: &mutracer_native_probe::display::Settings) -> api::DisplaySettings {
    api::DisplaySettings {
        tone_mapping: match settings.tone_mapping {
            1 => api::ToneMapping::Aces,
            2 => api::ToneMapping::Cineon,
            3 => api::ToneMapping::Reinhard,
            4 => api::ToneMapping::Linear,
            _ => api::ToneMapping::Agx,
        },
        tone_mapping_exposure: settings.exposure,
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
        hdr_output_enabled: false,
        aov: Default::default(),
        channel: match settings.output {
            1 => api::Channel::Normal,
            2 => api::Channel::Albedo,
            3 => api::Channel::Shadow,
            4 => api::Channel::ShadowCatcher,
            5 => api::Channel::Depth,
            6 => api::Channel::Position,
            7 => api::Channel::Roughness,
            8 => api::Channel::DiffuseAlbedo,
            9 => api::Channel::SpecularAlbedo,
            10 => api::Channel::Id,
            11 => api::Channel::Motion,
            _ => api::Channel::Final,
        },
    }
}
/// L1 images are top row first; the L0 helpers and saved files use bottom first.
fn bottom_first(image: api::Image) -> Vec<f32> {
    let row = image.width as usize * 4;
    (0..image.height as usize)
        .rev()
        .flat_map(|y| image.data[y * row..(y + 1) * row].iter().copied())
        .collect()
}
type SceneBuild = (
    std::sync::mpsc::Receiver<Result<(Descriptor, Arc<Vec<u8>>)>>,
    Option<(Model, Camera)>,
    [u32; 2],
);
/// The viewer owns the shared device's callback. Keep only the active engines'
/// notification handles, and replay terminal loss to a later backend candidate.
#[derive(Default)]
struct DeviceLossForwarder {
    reason: Option<String>,
    engines: Vec<api::DeviceLossNotifier>,
}
impl DeviceLossForwarder {
    fn notify(&mut self, reason: String) {
        let reason = self.reason.get_or_insert(reason);
        for engine in &self.engines {
            engine.notify(reason.clone());
        }
    }
    fn watch(&mut self, engines: impl IntoIterator<Item = api::DeviceLossNotifier>) {
        self.engines = engines.into_iter().collect();
        if let Some(reason) = &self.reason {
            for engine in &self.engines {
                engine.notify(reason.clone());
            }
        }
    }
}
struct Viewer {
    submission_gate: Option<std::sync::Arc<mutracer_native_probe::submission::SubmissionGate>>,
    startup_smoke: Option<(PathBuf, std::time::Instant, u32)>,
    metrics: Option<metrics::Metrics>,
    gpu: Option<eframe::egui_wgpu::RenderState>,
    gpu_loss: Arc<Mutex<DeviceLossForwarder>>,
    target: Target,
    replacement: Option<Target>,
    gpu_texture: Option<(egui::TextureId, wgpu::Texture)>,
    /// Descriptor assembly for scene and layout changes, off the UI thread.
    scene_build: Option<SceneBuild>,
    /// A loaded model whose scene was pushed; swapped in once it is published.
    pending_model: Option<(Model, Camera)>,
    backend: u32,
    backend_status: String,
    model: Model,
    /// The last presented image shows the last pushed inputs, including the
    /// current animation pose.
    pose_presented: bool,
    animation_clock: std::time::Instant,
    descriptor: Option<Descriptor>,
    camera: Camera,
    drag: input::ViewportDrag,
    environment: Environment,
    light: KeyLight,
    sky: sky::Sky,
    size: [u32; 2],
    resolution: resolution::Resolution,
    settings: RenderSettings,
    picking_focus: bool,
    focus: focus::AutoFocus,
    samples: u32,
    display_settings: mutracer_native_probe::display::Settings,
    applied_display: Option<api::DisplaySettings>,
    aov_display: api::AovDisplayOptions,
    debug_open: bool,
    preview_enabled: bool,
    preview_scale: f32,
    applied_denoise: Option<(
        bool,
        bool,
        denoiser::OidnSettings,
        denoiser::Choice,
        api::JnlmOptions,
        bool,
    )>,
    oidn_settings: denoiser::OidnSettings,
    jnlm_settings: api::JnlmOptions,
    live_denoise: bool,
    auto_rotate: bool,
    auto_units: bool,
    rotation_clock: std::time::Instant,
    hide_ui: bool,
    history: history::History,
    initial_materials: history::Materials,
    tools: workflow::Tools,
    last_loop_frame: std::time::Instant,
    selected: usize,
    selected_mesh: Option<usize>,
    texture_browser: textures::Browser,
    tab: usize,
    scene_open: bool,
    inspector_open: bool,
    object_query: String,
    scene_tree: scene_tree::Tree,
    loading: Option<std::sync::mpsc::Receiver<Result<Model>>>,
    loading_name: String,
    load_cancel: Arc<AtomicBool>,
    load_progress: Option<std::sync::mpsc::Receiver<String>>,
    examples: examples::Browser,
    environments: environment_browser::Browser,
    camera_index: Option<usize>,
    pending_environment: Option<Environment>,
    running: bool,
    change: Change,
    candidate: Option<(Model, Camera)>,
    /// Headless only: HDR of the presented frame, bottom row first.
    pixels: Vec<f32>,
    pixel_size: [u32; 2],
    frame_samples: u32,
    frame_preview: bool,
    /// The active loop's presentation count already shown.
    seen_presentations: u64,
    /// Presented frames, counting display-only recompositions too.
    frames: u64,
    generation: u64,
    denoise: bool,
    custom_denoiser: Option<Arc<dyn api::CustomDenoiser>>,
    denoiser_choice: denoiser::Choice,
    dlss_unavailable: Option<String>,
    denoise_status: String,
    /// Whether the last published commit prepared the scene again.
    last_commit_full: bool,
    texture: Option<egui::TextureHandle>,
    checker: Option<egui::TextureHandle>,
    error: String,
}
impl Viewer {
    fn new(path: &Path) -> Result<Self> {
        Self::new_on_device(path, None)
    }
    fn new_on_device(path: &Path, gpu: Option<eframe::egui_wgpu::RenderState>) -> Result<Self> {
        let mut model = if gpu.is_some() && path == default_model() {
            Model::spheres()?
        } else {
            Model::load(path)?
        };
        let mut camera = Camera::fit(model.0.center, model.0.radius);
        if gpu.is_some() && path == default_model() {
            let preset = examples::catalog()
                .iter()
                .find(|p| p["id"] == "spheres")
                .unwrap()
                .clone();
            let offset = glam::Vec3::new(model.center.x, model.ground_y, model.center.z);
            camera.set_view(
                model_scene::vector(&preset["camera"]["position"]).unwrap() + offset,
                model_scene::vector(&preset["camera"]["target"]).unwrap() + offset,
            );
            model.1.preset = Some(preset);
        }
        let mut examples = examples::Browser::default();
        examples.current = model
            .1
            .preset
            .as_ref()
            .map(|p| examples::text(p, "id").to_owned());
        let metrics = metrics::Metrics::from_env();
        let size = if metrics.is_some() {
            [1280, 720]
        } else {
            [480, 320]
        };
        let settings = RenderSettings::default();
        let submission_gate = gpu
            .is_some()
            .then(|| Arc::new(mutracer_native_probe::submission::SubmissionGate::default()));
        let target = Target::new(
            gpu.as_ref(),
            submission_gate.as_ref(),
            1,
            render_settings(&settings, size, false),
        )?;
        let gpu_loss = Arc::new(Mutex::new(DeviceLossForwarder::default()));
        gpu_loss
            .lock()
            .unwrap()
            .watch([target.engine.device_loss_notifier()]);
        if let Some(gpu) = &gpu {
            let loss = gpu_loss.clone();
            gpu.device.set_device_lost_callback(move |reason, message| {
                loss.lock()
                    .unwrap()
                    .notify(format!("{reason:?}: {message}"));
            });
        }
        let selected = model.0.meshes[0].material;
        if let Some(gate) = &submission_gate {
            gate.pause();
        }
        let relative_resolution = gpu.is_some() && metrics.is_none();
        Ok(Self {
            submission_gate,
            startup_smoke: None,
            metrics,
            backend: 1,
            backend_status: "Preparing scene…".into(),
            target,
            replacement: None,
            gpu: gpu.clone(),
            gpu_loss,
            gpu_texture: None,
            scene_build: None,
            pending_model: None,
            initial_materials: history::Materials::capture(&model),
            history: Default::default(),
            tools: Default::default(),
            auto_rotate: false,
            auto_units: true,
            rotation_clock: std::time::Instant::now(),
            hide_ui: false,
            last_loop_frame: std::time::Instant::now(),
            model,
            descriptor: None,
            animation_clock: std::time::Instant::now(),
            pose_presented: false,
            camera,
            drag: input::ViewportDrag::default(),
            environment: Environment::default(),
            light: KeyLight::default(),
            sky: sky::Sky::new(gpu.as_ref()),
            size,
            resolution: resolution::Resolution::new(if relative_resolution {
                Some(0.5)
            } else {
                None
            }),
            settings,
            picking_focus: false,
            focus: focus::AutoFocus::default(),
            samples: 0,
            display_settings: mutracer_native_probe::display::Settings {
                shadow_catcher_alpha: 0.8,
                ..Default::default()
            },
            applied_display: None,

            aov_display: Default::default(),
            debug_open: std::fs::read_to_string(examples::cache_root().join("debug.json"))
                .is_ok_and(|v| v == "true"),
            preview_enabled: true,
            preview_scale: 0.5,
            applied_denoise: None,
            oidn_settings: Default::default(),
            jnlm_settings: Default::default(),
            live_denoise: true,
            selected,
            selected_mesh: None,
            texture_browser: textures::Browser::default(),
            tab: 0,
            scene_open: true,
            inspector_open: true,
            object_query: String::new(),
            scene_tree: Default::default(),
            loading: None,
            loading_name: String::new(),
            load_cancel: Arc::new(AtomicBool::new(false)),
            load_progress: None,
            examples,
            environments: Default::default(),
            camera_index: None,
            pending_environment: None,
            running: true,
            change: Change::Scene,
            last_commit_full: true,
            candidate: None,
            pixels: vec![],
            pixel_size: size,
            frame_samples: 0,
            frame_preview: false,
            seen_presentations: 0,
            frames: 0,
            generation: 1,
            denoise: true,
            custom_denoiser: None,
            denoiser_choice: denoiser::Choice::default(),
            dlss_unavailable: Some("This build does not include DLSS RR".into()),
            denoise_status: String::new(),
            texture: None,
            checker: None,
            error: String::new(),
        })
    }
    fn describe_backend((active, reason): (api::Backend, String)) -> String {
        match active {
            api::Backend::Hardware => format!("HWRT · {reason}"),
            _ if !reason.is_empty() => format!("Software BVH · {reason}"),
            _ => "Software BVH".into(),
        }
    }
    fn dirty(&mut self, change: Change) {
        if matches!(change, Change::Camera | Change::Transform | Change::Scene) {
            self.focus.request();
        }
        self.change = self.change.max(change);
        self.generation += 1;
    }
    /// The target that receives edits: a pending backend replacement, else the active one.
    fn editing(&self) -> &Target {
        self.replacement.as_ref().unwrap_or(&self.target)
    }
    fn final_render(&self) -> &api::Render {
        self.target.final_render()
    }
    /// A scene is being assembled or prepared, or a backend switch is pending.
    fn preparing(&self) -> bool {
        self.scene_build.is_some()
            || self.replacement.is_some()
            || !self.target.pushed
            || self.target.preparing()
    }
    /// Inputs are committed, the final image is finished and on screen.
    fn settled(&self) -> bool {
        !self.preparing()
            && self.change == Change::None
            && self.pending_model.is_none()
            && (if self.output_mask() != 0 {
                self.target.render_loop.status() == api::RenderLoopStatus::Finished
            } else {
                self.final_render().status() == api::RenderStatus::Finished
                    && !self.final_render().denoising()
            })
            && !self.frame_preview
            && self.frame_samples == self.samples
    }
    /// HDR (0), normal (1) or albedo (2) of the active final render, bottom row first.
    fn image(&self, kind: u32) -> Result<Vec<f32>> {
        let kind = match kind {
            0 => api::PixelKind::Hdr,
            1 => api::PixelKind::Normal,
            _ => api::PixelKind::Albedo,
        };
        Ok(bottom_first(self.final_render().read_pixels(kind)?))
    }
    /// The backend the published scene uses: 0 software, 1 HWRT.
    fn render_backend(&self) -> Result<u32> {
        Ok(u32::from(
            self.final_render().backend()?.0 == api::Backend::Hardware,
        ))
    }
    fn hdr(&self) -> Result<Vec<f32>> {
        self.image(0)
    }
    /// The denoised image when one exists, bottom row first.
    fn denoised(&self) -> Result<Option<Vec<f32>>> {
        if self
            .final_render()
            .denoise_report()
            .is_none_or(|r| r.error.is_some())
        {
            return Ok(None);
        }
        Ok(Some(bottom_first(
            self.final_render().read_pixels(api::PixelKind::Denoised)?,
        )))
    }
    /// The finished image composed with `settings`, straight alpha, top row first.
    fn read_rgba(&self, settings: &mutracer_native_probe::display::Settings) -> Result<Vec<u8>> {
        let display = self.target.engine.display();
        let previous = display.settings();
        let mut settings = display_settings(settings);
        settings.aov = self.aov_display;
        display.set_settings(settings)?;
        let result = display.read_rgba8(self.final_render());
        display.set_settings(previous)?;
        Ok(result?.2)
    }
    fn load(&mut self, path: PathBuf, ctx: &egui::Context) {
        self.start_load(Some(path), None, ctx);
    }
    fn load_preset(&mut self, id: &str, ctx: &egui::Context) {
        if let Some(preset) = examples::catalog()
            .iter()
            .find(|p| examples::text(p, "id") == id)
            .cloned()
        {
            self.start_load(None, Some(preset), ctx);
        }
    }
    fn start_load(
        &mut self,
        path: Option<PathBuf>,
        preset: Option<serde_json::Value>,
        ctx: &egui::Context,
    ) {
        self.texture_browser.new_model();
        self.environments.cancel();
        self.load_cancel.store(true, Ordering::Relaxed);
        let cancel = Arc::new(AtomicBool::new(false));
        self.load_cancel = cancel.clone();
        self.loading_name = preset
            .as_ref()
            .map(|p| examples::text(p, "name").to_owned())
            .unwrap_or_else(|| {
                path.as_ref()
                    .unwrap()
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        self.examples.progress = format!("Loading {}…", self.loading_name);
        self.error.clear();
        let (send, receive) = std::sync::mpsc::channel();
        let (progress, updates) = std::sync::mpsc::channel();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Model> {
                    let path = match path {
                        Some(path) => path,
                        None if preset.as_ref().unwrap()["url"].is_null() => default_model(),
                        None => examples::download(preset.as_ref().unwrap(), &cancel, |message| {
                            let _ = progress.send(message);
                            ctx.request_repaint();
                        })?,
                    };
                    examples::check_cancel(&cancel)?;
                    let _ = progress.send("Preparing model…".into());
                    ctx.request_repaint();
                    let mut model = if preset.as_ref().is_some_and(|p| p["url"].is_null()) {
                        Model::spheres()?
                    } else {
                        Model::load(&path)?
                    };
                    examples::check_cancel(&cancel)?;
                    if let Some(preset) = preset {
                        model.0.name = examples::text(&preset, "name").into();
                        model.1.preset = Some(preset);
                    }
                    Ok(model)
                }))
                .unwrap_or_else(|_| Err(anyhow::anyhow!("Invalid model data")));
            let _ = send.send(result);
            ctx.request_repaint();
        });
        self.loading = Some(receive);
        self.load_progress = Some(updates);
    }
    fn receive_model(&mut self, _ctx: &egui::Context) {
        if let Some(updates) = &self.load_progress {
            for message in updates.try_iter() {
                self.examples.progress = message;
            }
        }
        let Some(result) = self.loading.as_ref().and_then(|r| r.try_recv().ok()) else {
            return;
        };
        self.loading = None;
        self.examples.progress.clear();
        self.load_progress = None;
        match result {
            Ok(model) => {
                if self.auto_units && self.camera.meters_per_unit != self.model.guessed_units() {
                    self.auto_units = false;
                }
                let mut camera = model.camera_for_load(&self.camera);
                if self.auto_units {
                    camera.meters_per_unit = model.guessed_units();
                }
                if let Some(retired) = self.candidate.replace((model, camera)) {
                    std::thread::spawn(move || drop(retired));
                }
                self.running = true;
                self.dirty(Change::Scene);
            }
            Err(error) => self.error = format!("Could not open {}: {error:#}", self.loading_name),
        }
    }
    /// Hands the model's descriptor and the render settings to the editing target.
    /// The engine shares one copy of the patched descriptor with the render.
    fn push(&mut self, held: bool) -> Result<()> {
        let bytes = Arc::new(
            self.model
                .update_descriptor(
                    &mut self.descriptor,
                    &self.camera.bytes(self.size),
                    self.size,
                    &self.environment,
                    &self.light,
                )
                .to_vec(),
        );
        self.push_bytes(bytes, self.size, held)
    }
    fn push_bytes(&mut self, bytes: Arc<Vec<u8>>, size: [u32; 2], held: bool) -> Result<()> {
        let mut settings = render_settings(&self.settings, size, held);
        settings.aovs = self.output_mask();
        let aovs = self.output_mask();
        let preview_scale = self.preview_resolution_scale(size);
        let target = self.replacement.as_mut().unwrap_or(&mut self.target);
        target.final_render().set_settings(settings)?;
        target
            .render_loop
            .preview()
            .unwrap()
            .set_settings(api::RenderSettings {
                aovs,
                aov_samples: 1,
                size: api::RenderSize::Scale(preview_scale),
                sampling_pattern: target.final_render().settings()?.sampling_pattern,
                seed: self.settings.seed,
                clamping: self.settings.clamping,
                transmissive_output_alpha_min: self.settings.transmissive_output_alpha_min,
                ..denoiser::preview_settings()
            })?;
        target.engine.display().set_size(size[0], size[1])?;
        target.engine.set_scene_shared(bytes)?;
        target.pushed = true;
        self.pose_presented = false;
        self.error.clear();
        Ok(())
    }
    fn preview_resolution_scale(&self, size: [u32; 2]) -> f64 {
        let full = self.resolution.full;
        if full == [0; 2] {
            self.preview_scale as f64
        } else {
            (full[0] as f64 * self.preview_scale as f64 / size[0] as f64)
                .min(full[1] as f64 * self.preview_scale as f64 / size[1] as f64)
                .clamp(0.01, 1.)
        }
    }
    fn output_target_samples(&self) -> u32 {
        let mask = self.output_mask();
        if mask == 0 {
            self.settings.max_samples
        } else if mask & 31 == 0 {
            1
        } else {
            16
        }
    }
    fn output_mask(&self) -> u32 {
        match self.display_settings.output {
            5..=11 => 1 << (self.display_settings.output - 5),
            _ => 0,
        }
    }
    fn display_samples(&self, render: &api::Render) -> u32 {
        if self.output_mask() != 0 {
            render.aov_samples_rendered()
        } else {
            render.samples()
        }
    }
    fn tick(&mut self, ctx: &egui::Context) -> Result<()> {
        self.receive_textures();
        if let Some(result) = self.sky.poll(
            ctx,
            self.gpu.is_some()
                && self.environment.name == "Procedural sky"
                && !self.environment.studio.enabled,
            self.environment.image.is_none(),
        ) {
            match result {
                Ok(image) => {
                    self.environment.image = Some(image);
                    self.dirty(Change::Environment);
                }
                Err(e) => self.error = format!("Could not bake sky: {e:#}"),
            }
        }
        if self.texture_browser.busy() {
            ctx.request_repaint_after(Duration::from_millis(100));
        }
        let rotation_now = std::time::Instant::now();
        if self.auto_rotate && self.running && !ctx.input(|i| i.pointer.any_down()) {
            self.camera.yaw -= rotation_now
                .duration_since(self.rotation_clock)
                .as_secs_f32()
                .min(0.1)
                * std::f32::consts::TAU
                / 30.;
            self.camera_index = None;
            self.dirty(Change::Camera);
        }
        self.rotation_clock = rotation_now;
        // Playback uses the same one-sample live-denoising policy as held input.
        let playing = self.running && self.model.0.animation.as_ref().is_some_and(|a| a.playing);
        // Display controls recompose only; they must not select the preview or
        // suspend the completed final denoiser while their pointer is held.
        let held = ctx.input(|i| i.pointer.any_down())
            && (self.drag.active() || self.change != Change::None)
            || playing
            || self.auto_rotate && self.running;
        // A backend switch prepares a second engine; the current image stays.
        if self.backend == self.target.backend {
            self.replacement = None;
        } else if self.replacement.as_ref().map(|r| r.backend) != Some(self.backend) {
            self.replacement = Some(Target::new(
                self.gpu.as_ref(),
                self.submission_gate.as_ref(),
                self.backend,
                render_settings(&self.settings, self.size, held),
            )?);
            self.change = self.change.max(Change::Scene);
            self.applied_denoise = None;
        }
        self.gpu_loss.lock().unwrap().watch(
            std::iter::once(self.target.engine.device_loss_notifier()).chain(
                self.replacement
                    .as_ref()
                    .map(|target| target.engine.device_loss_notifier()),
            ),
        );
        let enabled = self.preview_enabled;
        for target in [Some(&mut self.target), self.replacement.as_mut()]
            .into_iter()
            .flatten()
        {
            let fallback = enabled.then(|| target.render_loop.preview().unwrap().clone());
            target.final_render().set_fallback(fallback.as_deref())?;
            target.render_loop.set_select(move |info| {
                if enabled && info.changing {
                    api::Selection::Preview
                } else {
                    api::Selection::Final
                }
            });
        }
        for target in [Some(&self.target), self.replacement.as_ref()]
            .into_iter()
            .flatten()
        {
            target.activity.lock().unwrap().set_active(held);
            let mut settings = target.final_render().settings()?;
            settings.allow_multiple_samples_per_frame = !held;
            let aovs = self.output_mask();
            settings.aovs = aovs;
            if let Some(preview) = target.render_loop.preview() {
                let mut preview_settings = preview.settings()?;
                preview_settings.aovs = aovs;
                preview_settings.aov_samples = 1;
                preview_settings.size =
                    api::RenderSize::Scale(self.preview_resolution_scale(self.size));
                preview.set_settings(preview_settings)?;
            }
            target.final_render().set_settings(settings)?;
        }
        let mut display = display_settings(&self.display_settings);
        display.aov = self.aov_display;
        let display_changed = self.applied_display != Some(display);
        if display_changed {
            self.target.engine.display().set_settings(display)?;
            if let Some(replacement) = &self.replacement {
                replacement.engine.display().set_settings(display)?;
            }
            self.applied_display = Some(display);
        }
        if let Some((receive, _, _)) = &self.scene_build {
            match receive.try_recv() {
                Ok(result) => {
                    let (_, candidate, size) = self.scene_build.take().unwrap();
                    let (descriptor, bytes) = result?;
                    self.descriptor = Some(descriptor);
                    self.push_bytes(bytes, size, held)?;
                    if let Some(candidate) = candidate {
                        if let Some(retired) = self.pending_model.replace(candidate) {
                            std::thread::spawn(move || drop(retired));
                        }
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => {
                    self.scene_build = None;
                    anyhow::bail!("Scene assembly stopped");
                }
            }
        }
        let focus_ready = self.loading.is_none()
            && self.candidate.is_none()
            && self.pending_model.is_none()
            && self.scene_build.is_none()
            && self.change != Change::Scene;
        if self.focus.update(
            &self.model,
            &mut self.camera,
            self.size[0] as f32 / self.size[1] as f32,
            focus_ready,
            held,
            std::time::Instant::now(),
            ctx,
        ) {
            // Lens pulls change the rendered camera, but must not request another measurement.
            self.change = self.change.max(Change::Camera);
            self.generation += 1;
        }
        if self.focus.working(&self.camera) {
            ctx.request_repaint_after(Duration::from_millis(16));
        }
        // A moving pose must get a presented sample before the next pose can
        // replace it. Explicit seeks can supersede that pose, like any other edit.
        let now = std::time::Instant::now();
        let animation_ready = self.loading.is_none()
            && self.candidate.is_none()
            && self.pending_model.is_none()
            && self.scene_build.is_none()
            && self.change != Change::Scene
            && !self.editing().preparing();
        if let Some(animation) = &mut self.model.0.animation {
            if !animation.playing || !self.running || !animation_ready {
                self.animation_clock = now;
            } else if !animation.pending && self.frame_samples > 0 && self.pose_presented {
                animation.advance(now.duration_since(self.animation_clock).as_secs_f32());
                self.animation_clock = now;
            }
        }
        if animation_ready && self.model.apply_animation()? {
            self.dirty(Change::Transform);
        }
        // Edits wait while a scene is assembled or a full preparation runs, so held
        // input never cancels a preparation; the latest state commits afterwards.
        // Before applying input, the batch in flight finishes and is shown, so
        // continuous edits keep updating the image.
        let mut holding = false;
        if self.change != Change::None && self.scene_build.is_none() && !self.editing().preparing()
        {
            if self.running && self.replacement.is_none() && self.target.pushed {
                let render = self.target.collecting_render();
                let preview = !std::ptr::eq(render, self.final_render());
                let complete = render.collect()?;
                // Live preview owns its camera until the filtered image is ready.
                // This host-side batch collection must also collect inference;
                // RenderLoop cannot poll it while `holding` skips its tick.
                let filtered = self.output_mask() != 0
                    || !self.denoise
                    || !preview
                    || !complete
                    || render.samples() == 0
                    || render.denoise_current()?
                    || render.denoise_report().is_some_and(|r| r.error.is_some());
                if complete && filtered {
                    if let Some(presented) = self.target.engine.display().present(render)? {
                        self.present_frame(ctx, presented, preview || presented.fallback)?;
                    }
                } else {
                    holding = true;
                }
            }
        }
        if !holding
            && self.change != Change::None
            && self.scene_build.is_none()
            && !self.editing().preparing()
        {
            match self.change {
                Change::Scene => {
                    // Layout changes and new models assemble their descriptor off this thread.
                    let candidate = self.candidate.take();
                    let (model, camera) = candidate
                        .as_ref()
                        .map(|(m, c)| (m.clone(), c.clone()))
                        .unwrap_or_else(|| (self.model.clone(), self.camera.clone()));
                    let environment = if candidate.is_some() {
                        model.environment_for_load(&self.environment)
                    } else {
                        self.environment.clone()
                    };
                    if candidate.is_some() {
                        self.pending_environment = Some(environment.clone());
                    }
                    let (light, size) = (self.light.clone(), self.size);
                    let mut descriptor = self.descriptor.take();
                    let (send, receive) = std::sync::mpsc::channel();
                    let ctx = ctx.clone();
                    std::thread::spawn(move || {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            model.update_descriptor(
                                &mut descriptor,
                                &camera.bytes(size),
                                size,
                                &environment,
                                &light,
                            );
                            let descriptor = descriptor.unwrap();
                            let bytes = Arc::new(descriptor.bytes().to_vec());
                            (descriptor, bytes)
                        }))
                        .map_err(|_| anyhow::anyhow!("Scene assembly panicked"));
                        let _ = send.send(result);
                        ctx.request_repaint();
                    });
                    self.scene_build = Some((receive, candidate, size));
                }
                Change::Reset => {
                    if self.output_mask() != 0 {
                        self.final_render().restart_aovs()?
                    } else {
                        self.final_render().restart()?
                    }
                }
                _ => self.push(held)?,
            }
            self.change = Change::None;
        }
        // Keep denoising active during interaction for both OIDN and RR.
        // Temporal guides require pinhole rays. Depth of field uses OIDN and
        // returns to RR automatically when the lens is disabled.
        let temporal = self.denoiser_choice.temporal(
            self.custom_denoiser.is_some(),
            self.camera.orthographic || self.camera.f_stop == 0.,
        );
        let denoise = self.denoise;
        if self.applied_denoise
            != Some((
                denoise,
                temporal,
                self.oidn_settings,
                self.denoiser_choice,
                self.jnlm_settings,
                self.live_denoise,
            ))
        {
            for target in [Some(&mut self.target), self.replacement.as_mut()]
                .into_iter()
                .flatten()
            {
                denoiser::configure_full(
                    &mut target.render_loop,
                    denoise,
                    temporal,
                    self.custom_denoiser.as_ref(),
                    self.oidn_settings,
                    self.live_denoise,
                    (denoise && self.denoiser_choice == denoiser::Choice::Jnlm)
                        .then_some(self.jnlm_settings),
                )?;
            }
            self.applied_denoise = Some((
                denoise,
                temporal,
                self.oidn_settings,
                self.denoiser_choice,
                self.jnlm_settings,
                self.live_denoise,
            ));
            self.denoise_status.clear();
        }
        if self.denoise && self.denoiser_choice == denoiser::Choice::Jnlm {
            for target in [Some(&self.target), self.replacement.as_ref()]
                .into_iter()
                .flatten()
            {
                denoiser::configure_display_filter(
                    &target.render_loop,
                    Some(self.jnlm_settings),
                    self.live_denoise,
                )?;
            }
        }
        self.target.render_loop.coalesce_scene_updates =
            self.denoise && self.live_denoise && self.preview_enabled;
        if let Some(target) = &mut self.replacement {
            target.render_loop.coalesce_scene_updates =
                self.denoise && self.live_denoise && self.preview_enabled;
        }
        let final_was_finished = self.final_render().status() == api::RenderStatus::Finished;
        let status = if holding {
            ctx.request_repaint_after(Duration::from_millis(1));
            self.target.render_loop.status()
        } else if self.running {
            if let Some(replacement) = &mut self.replacement {
                replacement.render_loop.tick()?;
            }
            let refill = self.change == Change::None
                && !held
                && !display_changed
                && self.last_loop_frame.elapsed() < Duration::from_millis(16)
                && self.target.render_loop.needs_refill();
            if refill {
                self.target.render_loop.refill()?;
                ctx.request_repaint_after(Duration::from_millis(1));
                self.target.render_loop.status()
            } else {
                self.last_loop_frame = std::time::Instant::now();
                self.target.render_loop.tick()?
            }
        } else {
            self.target.render_loop.cancel_refill();
            // Paused: commit edits and recompose, but never trace.
            for target in [Some(&self.target), self.replacement.as_ref()]
                .into_iter()
                .flatten()
            {
                target.engine.update()?;
            }
            let preview_done = self.target.render_loop.preview().unwrap().collect()?;
            let final_done = self.final_render().collect()?;
            let denoised =
                self.output_mask() == 0 && denoise && self.final_render().denoise_current()?;
            if let Some(presented) = self.target.engine.display().present(self.final_render())? {
                self.present_frame(ctx, presented, presented.fallback)?;
            }
            if !preview_done || !final_done {
                ctx.request_repaint_after(Duration::from_millis(16));
            }
            // Wait for the batch in flight and the filter, unless denoising failed.
            let render = self.final_render();
            if self.output_mask() == 0
                && denoise
                && !denoised
                && render.samples() > 0
                && render.denoise_report().is_none_or(|r| r.error.is_none())
            {
                ctx.request_repaint_after(Duration::from_millis(16));
            }
            self.target.render_loop.status()
        };
        if !final_was_finished
            && status == api::RenderLoopStatus::Finished
            && self.denoise
            && !self.live_denoise
            && self.denoiser_choice == denoiser::Choice::Jnlm
        {
            ctx.request_repaint();
        }
        // Swap in a replacement engine once it shows an image.
        if self
            .replacement
            .as_ref()
            .is_some_and(|r| r.render_loop.last_presented().is_some())
        {
            let retired = std::mem::replace(&mut self.target, self.replacement.take().unwrap());
            if let (Some(gpu), Some((id, _))) = (&self.gpu, self.gpu_texture.take()) {
                gpu.renderer.write().free_texture(&id);
            }
            self.seen_presentations = 0;
            self.applied_denoise = None;
            drop(retired);
        }
        // Swap a loaded model in once its scene is published.
        if self.pending_model.is_some() && self.scene_build.is_none() && !self.target.preparing() {
            let (model, camera) = self.pending_model.take().unwrap();
            let retired = std::mem::replace(&mut self.model, model);
            std::thread::spawn(move || drop(retired));
            self.texture_browser.new_model();
            self.history.new_model();
            self.initial_materials = history::Materials::capture(&self.model);
            self.camera = camera;
            if let Some(environment) = self.pending_environment.take() {
                self.environment = environment;
            }
            self.examples.current = self
                .model
                .1
                .preset
                .as_ref()
                .map(|p| examples::text(p, "id").to_owned());
            self.camera_index = if self
                .model
                .1
                .preset
                .as_ref()
                .is_some_and(|p| p["category"] == "research")
                && !self.model.1.cameras.is_empty()
            {
                Some(0)
            } else {
                None
            };
            self.selected = self.model.0.meshes[0].material;
            self.selected_mesh = None;
            self.picking_focus = false;
            self.object_query.clear();
            self.scene_tree = Default::default();
            self.animation_clock = std::time::Instant::now();
        }
        let presentations = self.target.render_loop.presentations();
        if presentations != self.seen_presentations {
            self.seen_presentations = presentations;
            if let Some(presented) = self.target.render_loop.last_presented() {
                let preview = self
                    .target
                    .render_loop
                    .presented_render()
                    .is_some_and(|r| !Arc::ptr_eq(r, self.target.render_loop.final_render()));
                self.present_frame(ctx, presented, preview)?;
                // The loop presents only complete images of the committed inputs.
                self.pose_presented = self.change == Change::None
                    && self
                        .target
                        .render_loop
                        .presented_render()
                        .is_some_and(|r| self.display_samples(r) > 0);
            }
        }
        self.samples = self.display_samples(self.final_render());
        if !self.target.preparing() {
            self.last_commit_full =
                self.final_render().last_commit()? == Some(api::CommitKind::Full);
        }
        let shown = self
            .target
            .render_loop
            .presented_render()
            .map(|render| render.as_ref())
            .unwrap_or(self.final_render());
        if let Some(report) = shown.denoise_report() {
            self.denoise_status = match report.error {
                Some(error) => error,
                // GPU callbacks return after submission; their CPU wall time
                // does not measure the duration of RR on the GPU.
                None if self
                    .applied_denoise
                    .is_some_and(|(_, temporal, _, _, _, _)| temporal) =>
                {
                    "DLSS RR".into()
                }
                None => format!("{} · {:.0} ms", report.backend, report.milliseconds),
            };
        }
        let errors = std::mem::take(&mut *self.target.errors.lock().unwrap());
        if let Some(error) = errors.into_iter().last() {
            if status == api::RenderLoopStatus::Error {
                anyhow::bail!(error);
            }
            self.error = error;
        }
        if self.target.render_loop.needs_refill() {
            ctx.request_repaint_after(Duration::from_millis(1));
        }
        if self.running && self.target.render_loop.needs_tick()
            || self.replacement.is_some()
            || self.scene_build.is_some()
            || self.pending_model.is_some()
            || self.change != Change::None
            || self.auto_rotate && self.running
            || self
                .model
                .animation
                .as_ref()
                .is_some_and(|a| a.pending || a.playing && self.running)
        {
            ctx.request_repaint_after(Duration::from_millis(16));
        }
        Ok(())
    }
    /// Shows the frame the loop presented: registers the display texture with
    /// egui, or reads it back without a shared device.
    fn present_frame(
        &mut self,
        ctx: &egui::Context,
        presented: api::Presented,
        preview: bool,
    ) -> Result<()> {
        let display = self.target.engine.display();
        if let Some(gpu) = &self.gpu {
            let texture = display.texture().context("No presentation texture")?;
            if self.gpu_texture.as_ref().is_none_or(|(_, t)| *t != texture) {
                let mut renderer = gpu.renderer.write();
                if let Some((id, _)) = self.gpu_texture.take() {
                    renderer.free_texture(&id);
                }
                let id = renderer.register_native_texture(
                    &gpu.device,
                    &texture.create_view(&Default::default()),
                    wgpu::FilterMode::Linear,
                );
                self.gpu_texture = Some((id, texture));
            }
        } else {
            let render = if preview {
                self.target.render_loop.preview().unwrap()
            } else {
                self.target.render_loop.final_render()
            };
            // A loop tick can present a completed preview and then commit the
            // next input. Its source is already restarted; retain the CPU copy
            // collected before that commit, just as the GPU texture is retained.
            if self.display_samples(render) == 0 && self.texture.is_some() {
                return Ok(());
            }
            let (width, height, rgba) = display.read_rgba8(render)?;
            let pixels = if render.samples() > 0 {
                bottom_first(render.read_pixels(api::PixelKind::Hdr)?)
            } else {
                vec![]
            };
            let image =
                egui::ColorImage::from_rgba_unmultiplied([width as usize, height as usize], &rgba);
            match &mut self.texture {
                Some(texture) => texture.set(image, egui::TextureOptions::LINEAR),
                None => {
                    self.texture = Some(ctx.load_texture(
                        "MuTracer render",
                        image,
                        egui::TextureOptions::LINEAR,
                    ))
                }
            }
            self.pixels = pixels;
        }
        self.pixel_size = [presented.width, presented.height];
        self.frame_samples = presented.samples;
        self.frame_preview = preview;
        if presented.samples > 0 {
            if let Ok(backend) = self.final_render().backend() {
                self.backend_status = Self::describe_backend(backend);
            }
        }
        self.frames += 1;
        Ok(())
    }
    fn save_image(&self, path: &Path) -> Result<()> {
        ensure!(self.can_export(), "No completed final image to export");
        let (width, height, rgba) = self
            .target
            .engine
            .display()
            .read_rgba8(self.final_render())
            .context("No completed image to export")?;
        image::save_buffer_with_format(
            path,
            &rgba,
            width,
            height,
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        )?;
        Ok(())
    }
    fn can_export(&self) -> bool {
        !self.preparing()
            && self.change == Change::None
            && self.display_samples(self.final_render()) > 0
    }
    fn input_files(&mut self, ctx: &egui::Context) {
        let paths = ctx.input(|i| {
            i.raw
                .dropped_files
                .iter()
                .map(|f| f.path().to_owned())
                .collect::<Vec<_>>()
        });
        if paths.is_empty() {
            return;
        }
        let drop = ctx.input(|i| i.pointer.hover_pos()).and_then(|pos| {
            self.texture_browser
                .drop_targets
                .iter()
                .find(|(rect, _, _)| rect.contains(pos))
                .copied()
        });
        if let Some((_, material, slot)) = drop {
            if let Some(path) = paths.iter().find(|p| {
                p.extension().is_some_and(|e| {
                    ["png", "jpg", "jpeg", "webp"]
                        .iter()
                        .any(|ext| e.eq_ignore_ascii_case(ext))
                })
            }) {
                self.texture_browser
                    .upload(&self.model, material, slot, path.clone(), ctx);
                return;
            }
        }
        if let Some(path) = paths.iter().find(|p| {
            p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("glb") || e.eq_ignore_ascii_case("gltf"))
        }) {
            self.load(path.clone(), ctx);
        } else {
            self.error="Drop a .gltf or .glb file. Keep external buffers and textures beside the .gltf file.".into();
        }
    }
}
impl eframe::App for Viewer {
    fn ui(&mut self, root: &mut egui::Ui, _frame: &mut eframe::Frame) {
        if let Some(gate) = &self.submission_gate {
            gate.resume();
        }
        let ctx = root.ctx().clone();
        let frame_started = std::time::Instant::now();
        let during_commit = self.preparing();
        let mut pick_ms = 0.;
        if self.metrics.is_some() {
            self.denoise = false;
            self.settings.max_samples = 8;
            let preparing = self.preparing();
            let m = self.metrics.as_mut().unwrap();
            if !preparing
                && self.frame_samples > 0
                && m.commits < 3
                && m.frames.len() >= (m.commits as usize + 1) * 70
            {
                m.commits += 1;
                self.environment.color[0] = 1. - m.commits as f32 * 0.01;
                self.dirty(Change::Scene);
            } else if !preparing && self.frame_samples > 0 && m.frames.len() % 3 == 0 {
                self.camera.yaw += 0.01;
                self.dirty(Change::Camera);
            }
            let started = std::time::Instant::now();
            let _ = self.model.pick(&self.camera, [0.5, 0.5], 1280. / 720.);
            pick_ms = started.elapsed().as_secs_f64() * 1000.;
        }
        self.receive_model(&ctx);
        self.input_files(&ctx);
        #[cfg(all(feature = "hot-reload", debug_assertions))]
        hot_reload::panels(self, root);
        #[cfg(not(all(feature = "hot-reload", debug_assertions)))]
        self.panels(root);
        if ctx.input(|i| !i.raw.hovered_files.is_empty()) {
            let painter = ctx.layer_painter(egui::LayerId::new(
                egui::Order::Foreground,
                egui::Id::new("drop_hint"),
            ));
            let rect = ctx.content_rect();
            painter.rect_filled(rect, 0., egui::Color32::from_black_alpha(200));
            painter.rect_stroke(
                rect.shrink(24.),
                12.,
                egui::Stroke::new(2_f32, theme::ACCENT),
                egui::StrokeKind::Inside,
            );
            painter.text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                if ctx.input(|i| {
                    i.raw.hovered_files.iter().any(|f| {
                        f.path.as_ref().is_some_and(|p| {
                            p.extension().is_some_and(|e| {
                                ["png", "jpg", "jpeg", "webp"]
                                    .iter()
                                    .any(|ext| e.eq_ignore_ascii_case(ext))
                            })
                        })
                    })
                }) {
                    "Drop an image on a texture slot"
                } else {
                    "Drop a GLTF or GLB to open"
                },
                egui::FontId::proportional(26.),
                egui::Color32::WHITE,
            );
        }
        if let Err(e) = self.tick(&ctx) {
            if renderer::NativeError::is_busy(&e) {
                ctx.request_repaint_after(Duration::from_millis(16));
            } else {
                self.error = format!("Render stopped: {e:#}");
                self.running = false;
                self.backend = self.target.backend;
                self.change = Change::None;
            }
        }

        // Input can arrive after tick, including the final event of a short drag.
        // Ensure camera changes are committed even when accumulation was idle.
        if self.change != Change::None {
            ctx.request_repaint();
        }
        let preparing = self.preparing();
        if let Some(metrics) = &mut self.metrics {
            let done = metrics.record(
                frame_started.elapsed().as_secs_f64() * 1000.,
                during_commit || preparing,
                pick_ms,
                self.gpu_texture.is_some(),
                self.pixels.is_empty(),
                &self.error,
            );
            if done {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            } else {
                ctx.request_repaint_after(Duration::from_millis(16));
            }
        }
        if let Some((path, started, frames)) = &mut self.startup_smoke {
            // Exercise surface reconfiguration while scene preparation runs.
            match ctx.cumulative_frame_nr() {
                2 => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(egui::vec2(800., 560.)))
                }
                4 => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(egui::vec2(1200., 800.)))
                }
                _ => {}
            }
            if self.gpu_texture.is_some() && self.frame_samples > 0 {
                *frames += 1;
            }
            let passed = *frames >= 3 && self.error.is_empty();
            if passed || !self.error.is_empty() || started.elapsed() > Duration::from_secs(90) {
                let report = serde_json::json!({"passed":passed,"frames":frames,"samples":self.frame_samples,"error":self.error,"windowSize":[ctx.content_rect().width(),ctx.content_rect().height()],"grip":ctx.data(|data| data.get_temp::<egui::Rect>(egui::Id::new("smoke-grip"))).map(|r| [r.min.x,r.min.y,r.max.x,r.max.y])});
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(path, report.to_string());
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            ctx.request_repaint_after(Duration::from_millis(16));
        }
        // eframe configures/reconfigures its surface outside this callback.
        // Drain only active submissions; CPU preparation stays asynchronous.
        if let Some(gate) = &self.submission_gate {
            gate.pause();
        }
    }
}
impl Drop for Viewer {
    fn drop(&mut self) {
        self.load_cancel.store(true, Ordering::Relaxed);
        // Renderer teardown can wait for a pending background commit.
        if let Some(gate) = &self.submission_gate {
            gate.resume();
        }
    }
}
fn dropped_file(path: PathBuf) -> egui::DroppedFileHandle {
    #[derive(Debug)]
    struct File(PathBuf);
    impl egui::DroppedFile for File {
        fn path(&self) -> &Path {
            &self.0
        }
        fn bytes(&self) -> std::result::Result<Vec<u8>, String> {
            std::fs::read(&self.0).map_err(|e| e.to_string())
        }
    }
    std::sync::Arc::new(File(path))
}
fn default_model() -> PathBuf {
    bundled_asset(
        "sample.glb",
        Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"),
    )
}
fn bundled_asset(name: &str, fallback: PathBuf) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for path in [dir.join("../Resources").join(name), dir.join(name)] {
                if path.exists() {
                    return path;
                }
            }
        }
    }
    fallback
}
fn smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut model = Model::load(path)?;
    let mut camera = Camera::fit(model.0.center, model.0.radius);
    let mut environment = Environment::default();
    let size = [320, 216];
    let mut renderer = Renderer::with_backend(0)?;
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    let original = renderer.finish_l1(16)?;
    renderer::save(&out.join("original.png"), &original, size, 0.)?;
    let mut hardware = Renderer::with_backend(1)?;
    hardware.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    let hardware_pixels = hardware.finish_l1(16)?;
    let (backend, reason) = hardware.backend()?;
    let mut max_diff = 0f32;
    for (a, b) in original.iter().zip(&hardware_pixels) {
        max_diff = max_diff.max((a - b).abs());
    }
    ensure!(backend == 1, "HWRT smoke silently fell back: {reason}");
    for kind in 0..3 {
        ensure!(
            hardware.image(kind)?.iter().all(|x| x.is_finite()),
            "Non-finite HWRT AOV"
        );
    }
    std::fs::write(
        out.join("hardware.txt"),
        format!("backend {backend}; {reason}; max HDR difference {max_diff}\n"),
    )?;
    drop(hardware);

    let (denoised, denoise_ms) = package_smoke::denoise_model(&model, size, 16)?;
    ensure!(
        denoised != original,
        "oidn-webgpu did not change noisy pixels"
    );
    ensure!(
        denoised
            .chunks_exact(4)
            .zip(original.chunks_exact(4))
            .all(|(a, b)| a[3] == b[3]),
        "oidn-webgpu changed alpha"
    );
    renderer::save(&out.join("denoised.png"), &denoised, size, 0.)?;
    let reference = renderer.finish_l1(240)?;
    renderer::save(&out.join("reference.png"), &reference, size, 0.)?;
    let rmse = |pixels: &[f32]| {
        (pixels
            .iter()
            .zip(&reference)
            .enumerate()
            .filter(|(i, _)| i % 4 != 3)
            .map(|(_, (a, b))| f64::from(a - b).powi(2))
            .sum::<f64>()
            / (size[0] * size[1] * 3) as f64)
            .sqrt()
    };
    let report = format!(
        "{}: {:.2} ms; noisy RMSE {}; denoised RMSE {}\n",
        "oidn-webgpu",
        denoise_ms,
        rmse(&original),
        rmse(&denoised)
    );
    std::fs::write(out.join("denoise.txt"), &report)?;
    println!("{report}");
    std::fs::write(
        out.join("denoised.rgba32f"),
        denoised
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )?;
    renderer.reset()?;
    ensure!(
        renderer.finish(16)? == original,
        "Denoising modified accumulation"
    );

    renderer.start(4)?;
    renderer.cancel()?;
    ensure!(
        renderer.poll()? && renderer.samples()? == 16,
        "Queued cancellation lost samples"
    );
    renderer.reset()?;
    ensure!(
        renderer.finish(16)? == original,
        "Restart changed the original image"
    );
    camera.orbit([70., -20.]);
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    ensure!(
        renderer.last_commit_incremental()?,
        "Camera commit rebuilt the scene"
    );
    let orbit = renderer.finish(16)?;
    ensure!(original != orbit, "Camera control did not change pixels");
    renderer::save(&out.join("orbit.png"), &orbit, size, 0.)?;
    camera = Camera::fit(model.0.center, model.0.radius);
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    ensure!(
        renderer.finish(16)? == original,
        "Restoring camera changed the original image"
    );
    // Imported mesh order does not imply visibility in the fitted camera. Edit
    // every material so this model-agnostic smoke always reaches visible surfaces.
    for material in &mut model.0.materials {
        material.color = [0.05, 0.85, 0.15];
        material.roughness = 0.8;
    }
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    let material = renderer.finish(16)?;
    ensure!(material != original, "Material edit did not change pixels");
    renderer::save(&out.join("material.png"), &material, size, 0.)?;
    environment.intensity = 0.2;
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    let env = renderer.finish(16)?;
    ensure!(env != material, "Environment edit did not change pixels");
    renderer::save(&out.join("environment.png"), &env, size, 0.)?;
    let hdr_path = out.join("studio.hdr");
    let mut hdr = b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n".to_vec();
    for _ in 0..8 {
        hdr.extend([128, 80, 32, 130]);
    }
    std::fs::write(&hdr_path, hdr)?;
    environment.load(&hdr_path)?;
    renderer.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    let hdr = renderer.finish(16)?;
    ensure!(
        hdr != env,
        "Loading an HDR environment did not change pixels"
    );
    renderer::save(&out.join("hdr.png"), &hdr, size, 0.)?;
    std::fs::write(
        out.join("original.rgba32f"),
        original
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )?;
    println!(
        "PASS native viewer: {} meshes, {} materials, {} textures; glTF/render/orbit/restore/material/environment",
        model.0.meshes.len(),
        model.0.materials.len(),
        model.0.textures.len()
    );
    Ok(())
}
fn interaction_smoke(path: &Path, out: &Path) -> Result<()> {
    for backend in [0, 1] {
        interaction_backend_smoke(path, &out.join(format!("backend-{backend}")), backend)?;
    }
    Ok(())
}
fn interaction_backend_smoke(path: &Path, out: &Path, backend: u32) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut viewer = Viewer::new(path)?;
    viewer.backend = backend;
    viewer.focus.enabled = false;
    viewer.denoise = false;
    let ctx = egui::Context::default();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while viewer.texture.is_none() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Initial preview timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let before = viewer.pixels.clone();
    let mut frames = 0;
    let mut previews = 0;
    let mut last = viewer.pixels.clone();
    for step in 0..120 {
        ctx.begin_pass(egui::RawInput {
            events: if step == 0 {
                vec![egui::Event::PointerButton {
                    pos: egui::pos2(700., 400.),
                    button: egui::PointerButton::Primary,
                    pressed: true,
                    modifiers: egui::Modifiers::NONE,
                }]
            } else {
                vec![]
            },
            ..Default::default()
        });
        viewer.camera.orbit([1., 0.]);
        viewer.dirty(Change::Camera);
        if step >= 60 {
            viewer.model.0.materials[viewer.selected].roughness = 0.2 + step as f32 / 200.;
            viewer.dirty(Change::Material);
        }
        viewer.tick(&ctx)?;
        ensure!(
            viewer.texture.is_some() && !viewer.pixels.is_empty(),
            "Interaction blanked preview"
        );
        ensure!(
            viewer.pixels.len() == (viewer.pixel_size[0] * viewer.pixel_size[1] * 4) as usize,
            "Presented channel and pixel dimensions disagree"
        );
        if viewer.frame_preview {
            ensure!(
                viewer.pixel_size[0] < viewer.size[0] && viewer.pixel_size[1] < viewer.size[1],
                "Preview did not reduce resolution"
            );
            previews += 1;
        }
        ctx.end_pass().textures_delta.clear();
        if viewer.pixels != last {
            frames += 1;
            last = viewer.pixels.clone();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    // Finish accepting the latest edit, pause on a preview, and recompose it
    // without tracing or exporting it as a full-resolution final image.
    while viewer.change != Change::None || !viewer.frame_preview {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Pending preview timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.running = false;
    viewer.tick(&ctx)?;
    let paused_preview = viewer.target.render_loop.preview().unwrap().samples();
    let paused_final = viewer.final_render().samples();
    viewer.display_settings.exposure = 1.25;
    for _ in 0..3 {
        viewer.tick(&ctx)?;
    }
    ensure!(
        viewer.target.render_loop.preview().unwrap().samples() == paused_preview
            && viewer.final_render().samples() == paused_final
            && viewer.frame_preview,
        "Paused preview traced or lost its presentation source"
    );
    ensure!(
        !viewer.can_export()
            && viewer
                .save_image(&out.join("unexpected-preview.png"))
                .is_err(),
        "Preview became a final export"
    );
    viewer.running = true;
    let mut output = ctx.run_ui(
        egui::RawInput {
            events: vec![egui::Event::PointerButton {
                pos: egui::pos2(700., 400.),
                button: egui::PointerButton::Primary,
                pressed: false,
                modifiers: egui::Modifiers::NONE,
            }],
            ..Default::default()
        },
        |_| {},
    );
    output.textures_delta.clear();
    ensure!(
        frames >= 3 && previews > 0 && last != before,
        "Continuous input starved preview rendering: {frames} updates"
    );
    renderer::save(
        &out.join("interactive.png"),
        &viewer.pixels,
        viewer.pixel_size,
        0.,
    )?;
    std::fs::write(
        out.join("interaction.txt"),
        format!(
            "PASS backend {backend}: 120 camera/material updates, {frames} changed frames, {previews} reduced previews, zero blank frames; paused preview retained, final export rejected\n"
        ),
    )?;
    println!(
        "PASS backend {backend}: 120 camera/material updates, {frames} changed frames, {previews} reduced previews, zero blank frames; paused preview retained, final export rejected"
    );
    viewer.settings.max_samples = 8;
    viewer.dirty(Change::Scene);
    viewer.denoise = true;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !viewer.final_render().denoising() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Denoise submission timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.denoise = false;
    viewer.size = [320, 213];
    viewer.dirty(Change::Scene);
    let stale = viewer.final_render().denoise_report().map(|r| r.samples);
    while viewer.preparing() || viewer.change != Change::None {
        viewer.tick(&ctx)?;
        ensure!(
            viewer.final_render().denoise_report().map(|r| r.samples) == stale,
            "Stale denoise replaced a changed scene"
        );
        ensure!(
            viewer.texture.is_some(),
            "Resolution change blanked preview"
        );
        ensure!(
            std::time::Instant::now() < deadline,
            "Stale denoise did not finish"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.denoise = true;
    while !viewer.settled() || viewer.denoised()?.is_none() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Final denoise did not finish"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let denoised = viewer.denoised()?.unwrap();
    ensure!(
        viewer.pixel_size == [320, 213] && denoised.len() == 320 * 213 * 4,
        "Wrong denoise dimensions"
    );
    renderer::save(
        &out.join("interactive-denoised.png"),
        &denoised,
        viewer.pixel_size,
        0.,
    )?;
    println!(
        "PASS stale denoised result ignored; resized preview retained; final native denoise completed"
    );
    viewer.denoise = false;
    viewer.settings.max_samples = 12;
    viewer.dirty(Change::Scene);
    while viewer.samples < 12 {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Extra samples timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.settings.max_samples = 8;
    viewer.dirty(Change::Scene);
    viewer.denoise = true;
    while viewer.denoised()?.is_none() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Lowered-target denoise timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    println!("PASS native denoise after lowering target below completed samples");
    // Paused, the current samples are denoised once and shown without tracing;
    // resuming continues the progressive points.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    viewer.settings.max_samples = 64;
    viewer.dirty(Change::Scene);
    while viewer.preparing() || viewer.change != Change::None || viewer.samples < 6 {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Samples before pause timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    viewer.running = false;
    let frames = viewer.frames;
    let paused = loop {
        viewer.tick(&ctx)?;
        let samples = viewer.samples;
        if viewer.final_render().denoise_report().map(|r| r.samples) == Some(samples)
            && viewer.frames > frames
        {
            break samples;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "Paused denoise timed out: {}",
            viewer.denoise_status
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    let shown = viewer.read_rgba(&viewer.display_settings)?;
    for _ in 0..20 {
        viewer.tick(&ctx)?;
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        viewer.samples == paused && viewer.final_render().samples() == paused,
        "Traced while paused"
    );
    ensure!(
        viewer.read_rgba(&viewer.display_settings)? == shown
            && viewer
                .denoised()?
                .is_some_and(|d| d.len() == viewer.hdr().unwrap().len()),
        "Paused denoised image not kept"
    );
    viewer.running = true;
    while viewer
        .final_render()
        .denoise_report()
        .is_none_or(|r| r.samples <= paused)
    {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Progressive denoise after resume timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let resumed = viewer.final_render().denoise_report().unwrap().samples;
    ensure!(
        resumed == (paused * 2).min(64),
        "Resumed denoise at {resumed} samples after a pause at {paused}"
    );
    println!("PASS paused denoise at {paused} samples without tracing; resumed at {resumed}");
    viewer.denoise = false;
    let old = viewer.pixels.clone();
    let old_name = viewer.model.0.name.clone();
    let mut output = ctx.run_ui(
        egui::RawInput {
            dropped_files: vec![dropped_file(path.to_path_buf())],
            ..Default::default()
        },
        |ui| viewer.input_files(ui.ctx()),
    );
    output.textures_delta.clear();
    ensure!(
        viewer.loading.is_some() && viewer.pixels == old,
        "Drop did not retain preview while loading"
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while viewer.loading.is_some() || !viewer.settled() {
        viewer.receive_model(&ctx);
        viewer.tick(&ctx)?;
        ensure!(
            viewer.error.is_empty() && std::time::Instant::now() < deadline,
            "Dropped model did not render: {}",
            viewer.error
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        viewer.model.0.name == old_name && !viewer.pixels.is_empty(),
        "Dropped model did not replace scene"
    );
    let mut output = ctx.run_ui(
        egui::RawInput {
            dropped_files: vec![dropped_file(PathBuf::from("texture.png"))],
            ..Default::default()
        },
        |ui| viewer.input_files(ui.ctx()),
    );
    output.textures_delta.clear();
    ensure!(
        !viewer.error.is_empty() && viewer.model.0.name == old_name,
        "Invalid drop was not rejected transactionally"
    );
    println!("PASS native file-drop event loads and renders; invalid drop preserves scene");
    viewer.error.clear();
    viewer.denoise = false;
    let id = viewer.model.0.meshes[0].material;
    let mut previews = 0;
    let mut previous = viewer.pixels.clone();
    viewer.light.enabled = true;
    viewer.dirty(Change::Scene);
    while !viewer.settled() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Key light setup timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let mut output = ctx.run_ui(
        egui::RawInput {
            events: vec![egui::Event::PointerButton {
                pos: egui::pos2(700., 400.),
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: egui::Modifiers::NONE,
            }],
            ..Default::default()
        },
        |_| {},
    );
    output.textures_delta.clear();
    let preparations = viewer.target.preparations.load(Ordering::Relaxed);
    let original_transform = viewer.model.0.meshes[0].transform;
    for step in 0..80 {
        viewer.model.0.meshes[0].transform =
            glam::Mat4::from_translation(glam::Vec3::new(step as f32 * 0.002, 0., 0.))
                * original_transform;
        viewer.model.refresh_bounds();
        viewer.dirty(Change::Transform);
        viewer.light.azimuth = step as f32 * 7.;
        viewer.light.intensity = 0.5 + step as f32 / 40.;
        viewer.dirty(Change::Light);
        viewer.environment.intensity = 0.3 + step as f32 * 0.02;
        viewer.environment.rotation = step as f32 * 9.;
        viewer.dirty(Change::Environment);
        viewer.model.0.materials[id].color = [0.1 + step as f32 / 100., 0.4, 0.7];
        viewer.model.0.materials[id].roughness = (step % 20) as f32 / 20.;
        viewer.dirty(Change::Material);
        if step % 5 == 0 {
            viewer.camera.orbit([1., 0.]);
            viewer.dirty(Change::Camera);
        }
        viewer.tick(&ctx)?;
        ensure!(
            viewer.texture.is_some() && !viewer.pixels.is_empty(),
            "Material interaction blanked preview"
        );
        if viewer.pixels != previous {
            previews += 1;
            previous = viewer.pixels.clone();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut output = ctx.run_ui(
        egui::RawInput {
            events: vec![egui::Event::PointerButton {
                pos: egui::pos2(700., 400.),
                button: egui::PointerButton::Primary,
                pressed: false,
                modifiers: egui::Modifiers::NONE,
            }],
            ..Default::default()
        },
        |_| {},
    );
    output.textures_delta.clear();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !viewer.settled() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Material interaction did not settle"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        previews >= 3,
        "Held environment/material edits starved previews"
    );
    ensure!(
        viewer.target.preparations.load(Ordering::Relaxed) == preparations,
        "Partial edits rebuilt the scene"
    );
    let mut reference = Renderer::with_backend(viewer.backend)?;
    reference.commit(&viewer.model.descriptor_with_light(
        &viewer.camera.bytes(viewer.size),
        viewer.size,
        &viewer.environment,
        &viewer.light,
    ))?;
    ensure!(
        reference.finish_l1(viewer.samples)? == viewer.hdr()?,
        "Combined transform/light/environment/material/camera updates differ from full commit"
    );
    renderer::save(
        &out.join("interactive-material.png"),
        &viewer.hdr()?,
        viewer.pixel_size,
        0.,
    )?;
    println!(
        "PASS 80 held transform/light/environment/material updates plus camera motion: {previews} changed previews, zero blanks, final HDR byte-exact to full commit"
    );
    viewer.model.0.materials[id].unlit = true;
    viewer.dirty(Change::Scene);
    while !viewer.settled() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Unlit setup timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    // The previous commit prepared the scene fully, so this edit commits on the
    // worker while the preview stays on screen.
    viewer.model.0.materials[id].color = [0.1, 0.7, 0.2];
    viewer.dirty(Change::Material);
    viewer.tick(&ctx)?;
    ensure!(
        viewer.preparing() && viewer.texture.is_some(),
        "Edit after a full preparation did not commit in the background with retained preview"
    );
    while !viewer.settled() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Unlit fallback timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        viewer.last_commit_full,
        "Unlit material color edit did not prepare the scene fully"
    );
    reference.commit(&viewer.model.descriptor_with_light(
        &viewer.camera.bytes(viewer.size),
        viewer.size,
        &viewer.environment,
        &viewer.light,
    ))?;
    ensure!(
        reference.finish_l1(viewer.samples)? == viewer.hdr()?,
        "Unlit full-commit fallback mismatch"
    );
    println!(
        "PASS unlit material edit prepares the scene fully on the worker; preview retained; final HDR byte-exact"
    );

    viewer.environment.background = !viewer.environment.background;
    viewer.dirty(Change::Environment);
    viewer.tick(&ctx)?;
    ensure!(
        viewer.preparing() && viewer.texture.is_some(),
        "Environment feature change did not commit in the background with retained preview"
    );
    while !viewer.settled() {
        viewer.tick(&ctx)?;
        ensure!(
            std::time::Instant::now() < deadline,
            "Environment fallback timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(
        viewer.last_commit_full,
        "Background visibility change did not prepare the scene fully"
    );
    reference.commit(&viewer.model.descriptor_with_light(
        &viewer.camera.bytes(viewer.size),
        viewer.size,
        &viewer.environment,
        &viewer.light,
    ))?;
    ensure!(
        reference.finish_l1(viewer.samples)? == viewer.hdr()?,
        "Environment full-commit fallback mismatch"
    );
    println!(
        "PASS background visibility change prepares the scene fully; preview retained; HDR byte-exact"
    );

    Ok(())
}
fn material_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut descriptor = None;
    let mut model = Model::load(path)?;
    let camera = Camera::fit(model.0.center, model.0.radius);
    let environment = Environment::default();
    let size = [160, 106];
    let mut renderer = Renderer::with_backend(1)?;
    let mut reference = Renderer::with_backend(1)?;
    let initial = model.descriptor(&camera.bytes(size), size, &environment);
    renderer.commit(&initial)?;
    let baseline = renderer.finish(8)?;
    let id = model.0.meshes[0].material;
    let mut bad = model.clone();
    bad.materials[id].roughness = f32::NAN;
    ensure!(
        renderer
            .commit(bad.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default()
            ))
            .is_err()
            && renderer.pixels()? == baseline,
        "Invalid material modified the scene"
    );
    renderer.start(1)?;
    renderer.cancel()?;
    while !renderer.poll()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    ensure!(
        renderer.pixels()? == baseline,
        "Queued cancellation changed pixels"
    );
    let mut partial_ms = Vec::new();
    let mut full_ms = Vec::new();
    let used: std::collections::BTreeSet<_> = model.0.meshes.iter().map(|m| m.material).collect();
    let mut count = 0;
    for &id in used.iter().take(3) {
        if model.0.materials[id].unlit {
            continue;
        }
        for step in 0..6 {
            let m = &mut model.0.materials[id];
            m.color = [0.2 + step as f32 * 0.1, 0.35, 0.8];
            m.roughness = step as f32 / 5.;
            m.metalness = 1. - m.roughness;
            m.transmission = m.roughness * 0.6;
            m.ior = 1.1 + step as f32 * 0.15;
            let started = std::time::Instant::now();
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default(),
            ))?;
            partial_ms.push(started.elapsed().as_secs_f64() * 1000.);
            ensure!(
                renderer.last_commit_incremental()?,
                "Expected an incremental material commit"
            );
            ensure!(
                renderer.samples()? == 0,
                "Material commit did not reset samples"
            );
            let actual = renderer.finish(8)?;
            let started = std::time::Instant::now();
            reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
            full_ms.push(started.elapsed().as_secs_f64() * 1000.);
            let expected = reference.finish(8)?;
            ensure!(
                actual == expected
                    && renderer.image(1)? == reference.image(1)?
                    && renderer.image(2)? == reference.image(2)?,
                "Partial material differed from full commit at {id}/{step}"
            );
            count += 1;
        }
    }
    ensure!(count > 0, "No supported material updates tested");
    renderer::save(&out.join("partial.png"), &renderer.pixels()?, size, 0.)?;
    renderer.commit(&initial)?;
    ensure!(
        renderer.finish(8)? == baseline,
        "Full commit after partial failed to restore"
    );
    std::fs::write(
        out.join("timings.txt"),
        format!("incremental commit ms {partial_ms:?}\nfull commit ms {full_ms:?}\n"),
    )?;
    println!(
        "PASS {count} incremental material commits: HDR/normal/albedo byte-exact to full commits; baseline restored"
    );
    material_layers_smoke(path, out)?;
    Ok(())
}
// New viewer controls exercise the existing raw-scene OpenPBR contract on both
// intersection paths. Fresh contexts are independent full-preparation oracles.
fn material_layers_smoke(path: &Path, out: &Path) -> Result<()> {
    use mutracer_native_probe::layout::{header as h, material as mat};
    let original = Model::load(path)?;
    let camera = Camera::fit(original.center, original.radius);
    let size = [160, 106];
    let environment = Environment::default();
    let initial = original.descriptor(&camera.bytes(size), size, &environment);
    // The first six records are precisely the pre-layer viewer's properties.
    let mut legacy = initial.clone();
    let word = |data: &[u8], at: usize| {
        u32::from_le_bytes(data[at * 4..at * 4 + 4].try_into().unwrap()) as usize
    };
    let offset = word(&legacy, h::MATERIAL_OFFSET);
    for i in 0..original.materials.len() {
        let at = (offset + i * mat::WORDS + mat::EXTENSION_COUNT) * 4;
        legacy[at..at + 4].copy_from_slice(&6u32.to_le_bytes());
    }
    for mode in [0, 1] {
        let mut retained = Renderer::with_backend(mode)?;
        retained.commit(&legacy)?;
        let baseline = retained.finish(8)?;
        let baseline_normal = retained.image(1)?;
        let baseline_albedo = retained.image(2)?;
        ensure!(
            retained.backend()?.0 == mode,
            "Layer gate requires requested backend {mode}"
        );
        retained.commit(&initial)?;
        ensure!(
            retained.finish(8)? == baseline
                && retained.image(1)? == baseline_normal
                && retained.image(2)? == baseline_albedo,
            "New layer defaults changed imported material output on backend {mode}"
        );
        let mut descriptor = None;
        let id = original.meshes[0].material;
        for case in 0..9 {
            for step in 0..2 {
                let mut model = original.clone();
                let m = &mut model.0.materials[id];
                let weight = 0.5 + step as f32 * 0.3;
                match case {
                    0 => {
                        m.transmission = weight;
                        m.layers.thin_walled = false;
                        m.layers.transmission_color = [0.3, 0.7, 0.9];
                        m.layers.transmission_depth = 0.2;
                        m.layers.dispersion = 0.1;
                    }
                    1 => {
                        m.layers.coat_weight = weight;
                        m.layers.coat_roughness = 0.12;
                        m.layers.coat_ior = 1.8;
                        m.layers.coat_color = [0.7, 0.9, 1.];
                    }
                    2 => {
                        m.layers.subsurface_weight = weight;
                        m.layers.subsurface_color = [0.9, 0.3, 0.1];
                        m.layers.subsurface_radius = 0.2;
                    }
                    3 => {
                        m.layers.fuzz_weight = weight;
                        m.layers.fuzz_color = [0.3, 0.6, 0.9];
                        m.layers.fuzz_roughness = 0.3;
                    }
                    4 => {
                        m.layers.film_weight = weight;
                        m.layers.film_thickness = 0.45;
                        m.layers.film_ior = 1.33;
                    }
                    5 => {
                        m.emission = [1., 0.3, 0.1];
                        m.emission_strength = weight * 4.;
                    }
                    6 => {
                        m.layers.anisotropy = weight;
                        m.layers.diffuse_roughness = 0.3;
                        m.layers.specular_weight = 0.6;
                        m.layers.bevel = 0.01;
                    }
                    7 => {
                        m.alpha_mode = 3;
                        m.opacity = weight;
                        m.normal_scale = 0.7;
                        m.double_sided = true;
                    }
                    _ => {
                        m.unlit = true;
                        m.color = [weight, 0.1, 0.3];
                    }
                }
                retained.commit(model.update_descriptor(
                    &mut descriptor,
                    &camera.bytes(size),
                    size,
                    &environment,
                    &KeyLight::default(),
                ))?;
                let actual = retained.finish(8)?;
                let mut fresh = Renderer::with_backend(mode)?;
                fresh.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
                ensure!(
                    !fresh.last_commit_incremental()?,
                    "Reference must prepare a fresh scene"
                );
                let expected = fresh.finish(8)?;
                ensure!(
                    actual.iter().all(|v| v.is_finite())
                        && actual == expected
                        && retained.image(1)? == fresh.image(1)?
                        && retained.image(2)? == fresh.image(2)?,
                    "Layer {case}/{step} differs from fresh preparation on backend {mode}"
                );
                ensure!(
                    actual != baseline,
                    "Layer {case}/{step} had no observable effect on backend {mode}"
                );
            }
        }
        let before = retained.pixels()?;
        let mut bad = original.clone();
        bad.materials[id].layers.coat_ior = f32::NAN;
        ensure!(
            retained
                .commit(&bad.descriptor(&camera.bytes(size), size, &environment))
                .is_err()
                && retained.pixels()? == before,
            "Invalid layer changed the accepted scene"
        );
        retained.commit(&initial)?;
        ensure!(
            retained.finish(8)? == baseline,
            "Layer edits failed to restore defaults on backend {mode}"
        );
        renderer::save(
            &out.join(format!("layers-{mode}-restored.png")),
            &baseline,
            size,
            0.,
        )?;
        println!(
            "PASS backend {mode}: defaults match legacy; 18 layer edits finite and HDR/normal/albedo exact to fresh contexts; effects, rejection and restoration checked"
        );
    }
    Ok(())
}
fn environment_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut descriptor = None;
    let model = Model::load(path)?;
    let camera = Camera::fit(model.0.center, model.0.radius);
    let mut environment = Environment::default();
    let size = [160, 106];
    let mut renderer = Renderer::with_backend(1)?;
    let mut reference = Renderer::with_backend(1)?;
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &KeyLight::default(),
    ))?;
    let original = renderer.finish(8)?;
    let mut bad = environment.clone();
    bad.intensity = f32::NAN;
    ensure!(
        renderer
            .commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &bad,
                &KeyLight::default()
            ))
            .is_err()
            && renderer.pixels()? == original,
        "Invalid environment changed scene"
    );
    renderer.start(1)?;
    renderer.cancel()?;
    while !renderer.poll()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    for mode in 0..2 {
        if mode == 1 {
            // A map with different dimensions still commits incrementally.
            environment.image = Some(std::sync::Arc::new(image::Rgb32FImage::from_fn(
                16,
                8,
                |x, y| image::Rgb([0.1 + x as f32 * 0.2, 0.2 + y as f32 * 0.3, 0.5]),
            )));
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default(),
            ))?;
            ensure!(
                renderer.last_commit_incremental()?,
                "Map resize rebuilt the scene"
            );
        }
        for step in 0..8 {
            environment.intensity = if step == 0 { 0. } else { step as f32 * 0.4 };
            environment.rotation = step as f32 * 57.;
            environment.color = [0.2 + step as f32 * 0.1, 0.8, 0.4];
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default(),
            ))?;
            ensure!(
                renderer.last_commit_incremental()?,
                "Expected an incremental environment commit"
            );
            ensure!(
                renderer.samples()? == 0,
                "Environment update did not reset samples"
            );
            let actual = renderer.finish(8)?;
            reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
            ensure!(
                actual == reference.finish(8)?
                    && renderer.image(1)? == reference.image(1)?
                    && renderer.image(2)? == reference.image(2)?,
                "Partial environment differs from full commit at {mode}/{step}"
            );
        }
    }
    renderer::save(&out.join("partial.png"), &renderer.pixels()?, size, 0.)?;
    environment.background = false;
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &KeyLight::default(),
    ))?;
    ensure!(
        !renderer.last_commit_incremental()?,
        "Background visibility changes the shader and needs a full preparation"
    );
    environment = Environment::default();
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &KeyLight::default(),
    ))?;
    ensure!(
        renderer.finish(8)? == original,
        "Environment baseline restore differs"
    );
    println!(
        "PASS 17 incremental studio/HDR environment commits including a map resize: HDR/normal/albedo byte-exact to full commits; invalid input rejected; visibility change prepared fully; original restored"
    );
    Ok(())
}
fn light_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut descriptor = None;
    let model = Model::load(path)?;
    let camera = Camera::fit(model.0.center, model.0.radius);
    let mut environment = Environment::default();
    let mut light = KeyLight {
        enabled: true,
        ..Default::default()
    };
    let size = [160, 106];
    let mut renderer = Renderer::with_backend(1)?;
    let mut reference = Renderer::with_backend(1)?;
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &light,
    ))?;
    let before = renderer.finish(8)?;
    let mut bad = light.clone();
    bad.intensity = f32::NAN;
    ensure!(
        renderer
            .commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &bad
            ))
            .is_err()
            && renderer.pixels()? == before,
        "Invalid light modified scene"
    );
    renderer.start(1)?;
    renderer.cancel()?;
    while !renderer.poll()? {
        std::thread::sleep(Duration::from_millis(1));
    }
    for step in 0..18 {
        if step == 9 {
            // Hiding the background changes the shader: a full preparation.
            environment.background = false;
            renderer.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &light,
            ))?;
            ensure!(
                !renderer.last_commit_incremental()?,
                "Background visibility commit stayed incremental"
            );
        }
        environment.intensity = 0.3 + step as f32 * 0.1;
        environment.rotation = step as f32 * 31.;
        light.intensity = if step % 6 == 0 {
            0.
        } else {
            0.5 + step as f32 * 0.4
        };
        light.color = [0.2 + step as f32 * 0.03, 0.8, 0.4];
        light.azimuth = step as f32 * 21.;
        light.elevation = 10. + (step % 8) as f32 * 9.;
        renderer.commit(model.update_descriptor(
            &mut descriptor,
            &camera.bytes(size),
            size,
            &environment,
            &light,
        ))?;
        ensure!(
            renderer.last_commit_incremental()?,
            "Expected an incremental light/environment commit"
        );
        ensure!(
            renderer.samples()? == 0,
            "Light commit did not reset samples"
        );
        let actual = renderer.finish(8)?;
        reference.commit(&model.descriptor_with_light(
            &camera.bytes(size),
            size,
            &environment,
            &light,
        ))?;
        ensure!(
            actual == reference.finish(8)?
                && renderer.image(1)? == reference.image(1)?
                && renderer.image(2)? == reference.image(2)?,
            "Incremental light/environment differed from full commit at {step}"
        );
    }
    let before = renderer.pixels()?;
    renderer::save(&out.join("partial.png"), &before, size, 0.)?;
    light.enabled = false;
    renderer.commit(model.update_descriptor(
        &mut descriptor,
        &camera.bytes(size),
        size,
        &environment,
        &light,
    ))?;
    ensure!(
        renderer.last_commit_incremental()?,
        "Removing the key light rebuilt the scene"
    );
    ensure!(
        renderer.finish(8)? != before,
        "Removing key light had no effect"
    );
    println!(
        "PASS 18 incremental key-light and environment commits: HDR/normal/albedo byte-exact; invalid input rejected; light removal incremental"
    );
    Ok(())
}
fn transform_smoke(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut descriptor = None;
    let mut model = Model::load(path)?;
    let camera = Camera::fit(model.0.center, model.0.radius);
    let mut environment = Environment::default();
    let size = [160, 104];
    let originals: Vec<_> = model.0.meshes.iter().map(|m| m.transform).collect();
    let mut partial = 0;
    let mut fallback = 0;
    for mode in [0, 1] {
        let mut renderer = Renderer::with_backend(mode)?;
        let mut reference = Renderer::with_backend(mode)?;
        renderer.commit(model.update_descriptor(
            &mut descriptor,
            &camera.bytes(size),
            size,
            &environment,
            &KeyLight::default(),
        ))?;
        renderer.finish(8)?;
        for (id, original) in originals.iter().enumerate().take(3) {
            for step in 0..8 {
                let scale = if step == 6 {
                    glam::Vec3::new(1.2, 0.8, 1.1)
                } else if step == 7 {
                    glam::Vec3::new(-1., 1., 1.)
                } else {
                    glam::Vec3::splat(1. + step as f32 * 0.03)
                };
                model.0.meshes[id].transform = glam::Mat4::from_translation(glam::Vec3::new(
                    step as f32 * model.0.radius * 0.025,
                    0.,
                    0.,
                )) * *original
                    * glam::Mat4::from_rotation_y(step as f32 * 0.15)
                    * glam::Mat4::from_scale(scale);
                let before = renderer.pixels()?;
                let mut invalid = model.clone();
                invalid.meshes[id].transform.x_axis.x = f32::NAN;
                ensure!(
                    renderer
                        .commit(invalid.update_descriptor(
                            &mut descriptor,
                            &camera.bytes(size),
                            size,
                            &environment,
                            &KeyLight::default()
                        ))
                        .is_err()
                        && renderer.pixels()? == before,
                    "Invalid transform mutated scene"
                );
                renderer.commit(model.update_descriptor(
                    &mut descriptor,
                    &camera.bytes(size),
                    size,
                    &environment,
                    &KeyLight::default(),
                ))?;
                if renderer.last_commit_incremental()? {
                    partial += 1;
                } else {
                    fallback += 1;
                }
                ensure!(renderer.samples()? == 0, "Transform did not reset samples");
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Transform full/partial mismatch {mode}/{id}/{step}"
                );
                // Accepted transform lighting must survive subsequent environment edits.
                environment.intensity = 0.5 + step as f32 * 0.2;
                renderer.commit(model.update_descriptor(
                    &mut descriptor,
                    &camera.bytes(size),
                    size,
                    &environment,
                    &KeyLight::default(),
                ))?;
                let actual = renderer.finish(8)?;
                reference.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
                ensure!(
                    actual == reference.finish(8)?
                        && renderer.image(1)? == reference.image(1)?
                        && renderer.image(2)? == reference.image(2)?,
                    "Environment after transform mismatch"
                );
                ensure!(renderer.backend()?.0 == mode, "Unexpected backend fallback");
            }
        }
        renderer::save(
            &out.join(format!("mode-{mode}.png")),
            &renderer.pixels()?,
            size,
            0.,
        )?;
        for (mesh, original) in model.0.meshes.iter_mut().zip(&originals) {
            mesh.transform = *original;
        }
    }
    ensure!(partial > 0, "No incremental transform commits executed");
    println!(
        "PASS {partial} incremental transform commits, {fallback} full commits; software/auto HDR/normal/albedo exact; interleaved environment and invalid-update preservation"
    );
    Ok(())
}
fn main() -> Result<()> {
    let mut use_dlss = false;
    let mut dlss_preset = 0;
    let mut dlss_smoke = None;
    let mut model = None;
    let mut smoke_out = None;
    let mut interaction_out = None;
    let mut inspect = false;
    let mut preview_out = None;
    let mut material_out = None;
    let mut edit_bench_out = None;
    let mut environment_out = None;
    let mut light_out = None;
    let mut transform_out = None;
    let mut geometry_out = None;
    let mut package_out = None;
    let mut parity_out = None;
    let mut texture_out = None;
    let mut texture_editor_out = None;
    let mut studio_out = None;
    let mut focus_out = None;
    let mut startup_out = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dlss-rr" => use_dlss = true,
            "--dlss-preset" => {
                dlss_preset = match args.next().as_deref() {
                    Some("default") => 0,
                    Some("D") => 4,
                    _ => anyhow::bail!("--dlss-preset expects default or D"),
                };
            }
            "--dlss-smoke" => {
                use_dlss = true;
                dlss_smoke = Some(PathBuf::from(
                    args.next().context("--dlss-smoke needs a directory")?,
                ));
            }
            "--focus-smoke" => {
                focus_out = Some(PathBuf::from(
                    args.next().context("--focus-smoke needs a directory")?,
                ));
            }
            "--studio-smoke" => {
                studio_out = Some(PathBuf::from(
                    args.next().context("--studio-smoke needs a directory")?,
                ));
            }
            "--texture-editor-smoke" => {
                texture_editor_out = Some(PathBuf::from(
                    args.next()
                        .context("--texture-editor-smoke needs a directory")?,
                ));
            }
            "--texture-smoke" => {
                texture_out = Some(PathBuf::from(
                    args.next().context("--texture-smoke needs a directory")?,
                ));
            }
            "--parity-smoke" => {
                parity_out = Some(PathBuf::from(
                    args.next().context("--parity-smoke needs a directory")?,
                ));
            }
            "--startup-smoke" => {
                startup_out = Some(PathBuf::from(
                    args.next().context("--startup-smoke needs a report path")?,
                ));
            }
            "--edit-bench" => {
                edit_bench_out = Some(PathBuf::from(
                    args.next().context("--edit-bench needs a directory")?,
                ));
            }
            "--package-smoke" => {
                package_out = Some(PathBuf::from(
                    args.next().context("--package-smoke needs a directory")?,
                ));
            }
            "--geometry-smoke" => {
                geometry_out = Some(PathBuf::from(
                    args.next().context("--geometry-smoke needs a directory")?,
                ));
            }
            "--transform-smoke" => {
                transform_out = Some(PathBuf::from(
                    args.next().context("--transform-smoke needs a directory")?,
                ));
            }
            "--light-smoke" => {
                light_out = Some(PathBuf::from(
                    args.next().context("--light-smoke needs a directory")?,
                ))
            }
            "--environment-smoke" => {
                environment_out = Some(PathBuf::from(
                    args.next()
                        .context("--environment-smoke needs a directory")?,
                ))
            }
            "--material-smoke" => {
                material_out = Some(PathBuf::from(
                    args.next().context("--material-smoke needs a directory")?,
                ))
            }
            "--inspect" => inspect = true,
            "--preview-out" => {
                preview_out = Some(PathBuf::from(
                    args.next().context("--preview-out needs a directory")?,
                ))
            }
            "--interaction-smoke" => {
                interaction_out = Some(PathBuf::from(
                    args.next()
                        .context("--interaction-smoke needs a directory")?,
                ))
            }
            "--smoke-out" => {
                smoke_out = Some(PathBuf::from(
                    args.next().context("--smoke-out needs a directory")?,
                ))
            }
            _ if arg.starts_with('-') => anyhow::bail!(
                "Usage: mutracer-viewer [MODEL.gltf|MODEL.glb] [--smoke-out DIRECTORY]"
            ),
            _ => model = Some(PathBuf::from(arg)),
        }
    }
    #[cfg(all(feature = "hot-reload", debug_assertions))]
    let model = model.or_else(hot_reload::startup_model);
    let model = model.unwrap_or_else(default_model);
    #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
    let dlss = if use_dlss {
        let directory = std::env::current_exe()?
            .parent()
            .context("Missing application directory")?
            .to_owned();
        let filter = dlss::Dlss::new(&directory, dlss_preset)?;
        if let Some(out) = dlss_smoke {
            return dlss::smoke(&filter, &model, &out);
        }
        Some(filter)
    } else {
        None
    };
    #[cfg(not(all(target_os = "windows", feature = "dlss-rr")))]
    {
        let _ = (dlss_preset, dlss_smoke);
        ensure!(
            !use_dlss,
            "This build has no DLSS RR support; use the optional Windows DLSS build"
        );
    }
    if let Some(out) = focus_out {
        return focus_smoke::run(&model, &out);
    }
    if let Some(out) = studio_out {
        return studio_smoke::run(&model, &out);
    }
    if let Some(out) = texture_editor_out {
        return textures::smoke(&model, &out);
    }
    if let Some(out) = texture_out {
        return parity_smoke::run_textures(&model, &out);
    }
    if let Some(out) = parity_out {
        return parity_smoke::run(&model, &out);
    }
    if let Some(out) = package_out {
        return package_smoke::run(&model, &out);
    }
    if let Some(out) = geometry_out {
        return geometry_smoke::run(&model, &out);
    }
    if let Some(out) = transform_out {
        return transform_smoke(&model, &out);
    }
    if let Some(out) = light_out {
        return light_smoke(&model, &out);
    }
    if let Some(out) = environment_out {
        return environment_smoke(&model, &out);
    }
    if let Some(out) = edit_bench_out {
        return edit_bench::run(&model, &out);
    }
    if let Some(out) = material_out {
        return material_smoke(&model, &out);
    }
    if inspect || preview_out.is_some() {
        let m = Model::load(&model)?;
        println!(
            "{} meshes, {} geometries, {} triangles, {} textures; {}",
            m.meshes.len(),
            m.geometries.len(),
            m.geometries
                .iter()
                .map(|g| g.indices.len() / 3)
                .sum::<usize>(),
            m.textures.len(),
            m.warnings.join("; ")
        );
        let mut r = Renderer::with_backend(1)?;
        let c = Camera::fit(m.center, m.radius);
        r.commit(&m.descriptor(&c.bytes([160, 106]), [160, 106], &Environment::default()))?;
        let pixels = r.finish(16)?;
        if let Some(out) = preview_out {
            std::fs::create_dir_all(&out)?;
            renderer::save(&out.join("preview.png"), &pixels, [160, 106], 0.)?;
        }
        println!("PASS render {} pixels {:?}", pixels.len() / 4, r.backend()?);
        return Ok(());
    }
    if let Some(out) = interaction_out {
        return interaction_smoke(&model, &out);
    }
    if let Some(out) = smoke_out {
        return smoke(&model, &out);
    }

    // All UI choices must share the NGX-capable device. The optional app probes
    // availability once at interactive startup; a failed probe keeps OIDN usable.
    #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
    let (dlss, dlss_unavailable) = if let Some(filter) = dlss {
        (Some(filter), None)
    } else {
        let directory = std::env::current_exe()?
            .parent()
            .context("Missing application directory")?
            .to_owned();
        if directory.join("mutracer_ngx.dll").is_file()
            && directory.join("nvngx_dlssd.dll").is_file()
        {
            match dlss::Dlss::new(&directory, dlss_preset) {
                Ok(filter) => (Some(filter), None),
                Err(error) => (None, Some(format!("DLSS RR unavailable: {error:#}"))),
            }
        } else {
            (None, Some("DLSS RR runtime files are missing".into()))
        }
    };

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_decorations(true)
            .with_fullsize_content_view(true)
            .with_title_shown(false)
            .with_titlebar_shown(false)
            .with_resizable(true)
            .with_icon(shell::icon())
            .with_drag_and_drop(true)
            .with_inner_size([1200., 800.])
            .with_min_inner_size([800., 560.]),
        renderer: eframe::Renderer::Wgpu,
        wgpu_options: eframe::egui_wgpu::WgpuConfiguration {
            wgpu_setup: eframe::egui_wgpu::WgpuSetup::CreateNew(
                eframe::egui_wgpu::WgpuSetupCreateNew {
                    device_descriptor: std::sync::Arc::new(|adapter| wgpu::DeviceDescriptor {
                        label: Some("MuTracer and egui"),
                        required_limits: adapter.limits(),
                        required_features: adapter.features()
                            & (wgpu::Features::EXPERIMENTAL_RAY_QUERY
                                | wgpu::Features::TIMESTAMP_QUERY
                                | wgpu::Features::SHADER_F16
                                | wgpu::Features::SUBGROUP
                                | wgpu::Features::EXPERIMENTAL_COOPERATIVE_MATRIX),
                        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
                        ..Default::default()
                    }),
                    ..eframe::egui_wgpu::WgpuSetupCreateNew::without_display_handle()
                },
            ),
            ..Default::default()
        },
        ..Default::default()
    };
    #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
    let options = {
        let mut options = options;
        if let Some(filter) = &dlss {
            options.wgpu_options.wgpu_setup = filter.setup();
        }
        options
    };
    let startup_report = startup_out.clone();
    eframe::run_native(
        "MuTracer Native Viewer",
        options,
        Box::new(move |cc| {
            theme::install(&cc.egui_ctx);
            #[cfg(all(feature = "hot-reload", debug_assertions))]
            hot_reload::connect(&cc.egui_ctx);
            let mut viewer = Viewer::new_on_device(&model, cc.wgpu_render_state.clone())?;
            #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
            {
                viewer.custom_denoiser = dlss.map(|filter| filter as Arc<dyn api::CustomDenoiser>);
                viewer.dlss_unavailable = dlss_unavailable;
                if use_dlss {
                    viewer.denoiser_choice = denoiser::Choice::Dlss;
                }
            }
            if let Some(path) = startup_out {
                viewer.size = [64, 48];
                viewer.resolution.scale = None;
                viewer.settings.max_samples = 1;
                viewer.backend = 0;
                viewer.denoise = false;
                viewer.startup_smoke = Some((path, std::time::Instant::now(), 0));
            }
            Ok(Box::new(viewer))
        }),
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if let Some(path) = startup_report {
        let report: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
        ensure!(
            report["passed"] == true,
            "Window startup smoke failed: {report}"
        );
    }
    Ok(())
}
