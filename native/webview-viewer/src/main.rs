//! Independent wry prototype. The native SDK owns every traced pixel.
mod assets;
mod gpu;
mod input;
mod scene;
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use glam::Vec3;
use mutracer_native::api;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
    window::{Window, WindowId},
};
use wry::{WebView, WebViewBuilder};

#[derive(Clone)]
struct Message {
    body: String,
    received: Instant,
}
struct Host {
    // Drop the overlay and engine before destroying their parent window/device.
    webview: WebView,
    render_loop: api::RenderLoop,
    engine: api::Engine,
    model: scene::Model,
    orbit: input::Orbit,
    gpu: gpu::Gpu,
    window: Arc<Window>,
    rect: [u32; 4],
    logical_height: f32,
    paused: bool,
    ready: bool,
    last_publish: Instant,
    last_samples: u32,
    accumulation_start: Instant,
    sample_elapsed: f64,
    sample_ms: f64,
    frame_times: Arc<Mutex<Vec<f64>>>,
    engine_events: Arc<Mutex<Vec<Value>>>,
    _events: Vec<api::Subscription>,
    pending_edit: Option<(f64, Instant, u64)>,
    latencies: Vec<Value>,
    camera_packets: u64,
    material_edits: u64,
    smoke_phase: u32,
}
impl Host {
    fn new(
        event_loop: &ActiveEventLoop,
        proxy: EventLoopProxy<Message>,
        path: Option<&std::path::Path>,
    ) -> Result<Self> {
        let window = Arc::new(
            event_loop.create_window(
                Window::default_attributes()
                    .with_title("MuTracer · Native WebView prototype")
                    .with_inner_size(LogicalSize::new(1280., 800.)),
            )?,
        );
        let gpu = gpu::Gpu::new(event_loop, &window)?;
        let engine = gpu.engine();
        let model = if let Some(path) = path {
            scene::Model::path(path)?
        } else {
            scene::Model::bytes(
                include_bytes!("../../../examples/assets/chess.glb"),
                "Chess.glb",
            )?
        };
        let mut orbit = input::Orbit::default();
        orbit.target = model.center;
        orbit.radius = model.radius * 3.;
        engine.display().set_size(640, 400)?;
        engine.set_camera(Some(orbit.camera()))?;
        engine.set_scene_object(&model.scene)?;
        let render_loop = api::RenderLoop::new(
            &engine,
            api::RenderLoopOptions {
                preview: None,
                final_render: api::LoopRender::Settings(api::RenderSettings {
                    max_samples: 64,
                    bounces: 6,
                    seed: 12345,
                    size: api::RenderSize::Scale(0.5),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )?;
        let frame_times = Arc::new(Mutex::new(Vec::new()));
        let times = frame_times.clone();
        let samples = render_loop
            .final_render()
            .on_sample(move |event| times.lock().unwrap().push(event.frame_time_ms));
        let engine_events = Arc::new(Mutex::new(Vec::new()));
        let events = engine_events.clone();
        let subscription=engine.on(move |event|match event {
            api::EngineEvent::Progress {progress,..}=>events.lock().unwrap().push(json!({"event":"progress","value":{"name":"Native scene","stage":"bvh","loaded":progress,"total":1}})),
            api::EngineEvent::Error {message}=>events.lock().unwrap().push(json!({"event":"error","value":message})),_=>{}
        });
        let size = window.inner_size();
        let webview=WebViewBuilder::new()
            .with_transparent(true)
            .with_bounds(wry::Rect{position:wry::dpi::PhysicalPosition::new(0,0).into(),size:wry::dpi::PhysicalSize::new(size.width,size.height).into()})
            .with_custom_protocol("mutracer".into(),|_,request|assets::response(request.uri().path()))
            .with_initialization_script("window.addEventListener('error', e => window.ipc.postMessage(JSON.stringify({version:1,id:0,command:'frontendError',args:{message:e.message}})));window.addEventListener('unhandledrejection', e => window.ipc.postMessage(JSON.stringify({version:1,id:0,command:'frontendError',args:{message:String(e.reason)}})));")
            .with_ipc_handler(move |request|{let _=proxy.send_event(Message{body:request.into_body(),received:Instant::now()});})
            .with_navigation_handler(|url|url.starts_with("mutracer://localhost/")||url.starts_with("http://mutracer.localhost/"))
            .with_url("mutracer://localhost/index.html")
            .build_as_child(&*window)?;
        Ok(Self {
            webview,
            render_loop,
            engine,
            model,
            orbit,
            gpu,
            window,
            rect: [0, 0, 640, 400],
            logical_height: 400.,
            paused: false,
            ready: false,
            last_publish: Instant::now(),
            last_samples: 0,
            accumulation_start: Instant::now(),
            sample_elapsed: 0.,
            sample_ms: 0.,
            frame_times,
            engine_events,
            _events: vec![samples, subscription],
            pending_edit: None,
            latencies: vec![],
            camera_packets: 0,
            material_edits: 0,
            smoke_phase: 0,
        })
    }
    fn send(&self, value: Value) -> Result<()> {
        self.webview
            .evaluate_script(&format!("window.mutracerNativeReceive?.({value})"))?;
        Ok(())
    }
    fn event(&self, event: &str, value: Value) -> Result<()> {
        self.send(json!({"event":event,"value":value}))
    }
    fn replace_model(&mut self, model: scene::Model) -> Result<()> {
        self.orbit.target = model.center;
        self.orbit.radius = model.radius * 3.;
        self.model = model;
        self.engine.set_scene_object(&self.model.scene)?;
        self.engine.set_camera(Some(self.orbit.camera()))?;
        self.event("scene", self.model.snapshot()?)?;
        Ok(())
    }
    fn command(&mut self, request: &Value, received: Instant) -> Result<Value> {
        ensure!(request["version"] == 1, "Unsupported protocol version");
        let args = &request["args"];
        match request["command"].as_str().context("Missing command")? {
            "ready" => {
                self.ready = true;
                self.event("scene", self.model.snapshot()?)?;
                self.event(
                    "backend",
                    json!(format!(
                        "{} · {:?}",
                        self.engine.info().adapter_name,
                        self.engine.info().backend
                    )),
                )?;
                return Ok(
                    json!({"maxSamples":self.render_loop.final_render().settings()?.max_samples}),
                );
            }
            "sample" => self.replace_model(scene::Model::bytes(
                include_bytes!("../../../examples/assets/chess.glb"),
                "Chess.glb",
            )?)?,
            "loadBytes" => {
                let data = args["bytes"].as_str().context("Missing model bytes")?;
                ensure!(
                    data.len() <= (128 * 1024 * 1024usize).div_ceil(3) * 4,
                    "Prototype model upload is limited to 128 MiB"
                );
                let bytes = STANDARD.decode(data)?;
                self.replace_model(scene::Model::bytes(
                    &bytes,
                    args["name"].as_str().unwrap_or("model.glb"),
                )?)?;
            }
            "viewport" => {
                let dpr = self.window.scale_factor();
                let size = self.window.inner_size();
                let number = |name: &str| -> Result<f64> {
                    let v = args[name].as_f64().context("Invalid viewport coordinate")?;
                    ensure!(v.is_finite() && v >= 0., "Invalid viewport coordinate");
                    Ok(v)
                };
                let x = (number("x")? * dpr).round() as u32;
                let y = (number("y")? * dpr).round() as u32;
                let width =
                    ((number("width")? * dpr).round() as u32).min(size.width.saturating_sub(x));
                let height =
                    ((number("height")? * dpr).round() as u32).min(size.height.saturating_sub(y));
                self.logical_height = number("height")? as f32;
                if width > 0 && height > 0 && self.rect != [x, y, width, height] {
                    self.rect = [x, y, width, height];
                    self.engine.display().set_size(width, height)?;
                }
            }
            "material" => {
                let key = args["materialId"].as_str().context("Missing material ID")?;
                self.model.edit(key, &args["values"])?;
                self.engine.set_scene_object(&self.model.scene)?;
                self.event("material", self.model.material_snapshot(key)?)?;
                self.pending_edit = Some((
                    args["sentAt"].as_f64().unwrap_or(0.),
                    received,
                    self.render_loop.presentations(),
                ));
                self.material_edits += 1;
            }
            "resetMaterial" => {
                let key = args["materialId"].as_str().context("Missing material ID")?;
                self.model.reset(key)?;
                self.engine.set_scene_object(&self.model.scene)?;
                self.event("material", self.model.material_snapshot(key)?)?;
            }
            "visible" => {
                let key = args["objectId"].as_str().context("Missing mesh ID")?;
                let id = *self.model.meshes.get(key).context("Unknown mesh")?;
                self.model
                    .scene
                    .set_mesh_visible(id, args["visible"].as_bool().context("Missing visible")?)?;
                self.engine.set_scene_object(&self.model.scene)?;
            }
            "fit" => {
                self.orbit.target = self.model.center;
                self.orbit.radius = self.model.radius * 3.;
                self.engine.set_camera(Some(self.orbit.camera()))?;
            }
            "lookAt" => {
                let vector = |name: &str| -> Result<Vec3> {
                    let values = args[name].as_array().context("Expected vector")?;
                    ensure!(values.len() == 3, "Expected XYZ");
                    Ok(Vec3::new(
                        values[0].as_f64().context("Expected number")? as f32,
                        values[1].as_f64().context("Expected number")? as f32,
                        values[2].as_f64().context("Expected number")? as f32,
                    ))
                };
                self.orbit.look_at(vector("position")?, vector("target")?);
                self.engine.set_camera(Some(self.orbit.camera()))?;
            }
            "settings" => self.settings(args)?,
            "pause" => self.paused = args["paused"].as_bool().context("Expected pause bool")?,
            "capture" => {
                return Ok(json!(
                    STANDARD.encode(
                        self.engine
                            .display()
                            .encode_png(self.render_loop.final_render())?
                    )
                ));
            }
            "savePng" => {
                if let Some(path) = rfd::FileDialog::new()
                    .add_filter("PNG", &["png"])
                    .set_file_name("mutracer.png")
                    .save_file()
                {
                    std::fs::write(
                        path,
                        self.engine
                            .display()
                            .encode_png(self.render_loop.final_render())?,
                    )?;
                }
            }
            "readPixels" => {
                let kind = match args["kind"].as_str().unwrap_or("hdr") {
                    "hdr" => api::PixelKind::Hdr,
                    "denoised" => api::PixelKind::Denoised,
                    "normal" => api::PixelKind::Normal,
                    "albedo" => api::PixelKind::Albedo,
                    _ => anyhow::bail!(
                        "Prototype readback supports HDR, denoised, normal and albedo"
                    ),
                };
                let image = self.render_loop.final_render().read_pixels(kind)?;
                return Ok(json!({"width":image.width,"height":image.height,"data":image.data}));
            }
            "measurement" => {
                self.latencies.push(args.clone());
                eprintln!("IPC latency: {args}");
            }
            "frontendError" => anyhow::bail!("Frontend: {}", args["message"]),
            unknown => anyhow::bail!("Unknown prototype command: {unknown}"),
        }
        Ok(Value::Null)
    }
    fn settings(&mut self, patch: &Value) -> Result<()> {
        let mut render = self.render_loop.final_render().settings()?;
        let mut display = self.engine.display().settings();
        let mut camera = self.orbit.camera;
        let mut env = self.model.scene.environment_settings();
        let mut env_changed = false;
        for (key, value) in patch.as_object().context("Expected settings object")? {
            let number = || -> Result<f64> { value.as_f64().context("Expected numeric setting") };
            match key.as_str() {
                "maxSamples" => render.max_samples = number()? as u32,
                "bounces" => render.bounces = number()? as u32,
                "clamping" => render.clamping = number()?,
                "resolutionScale" => render.size = api::RenderSize::Scale(number()?),
                "samplingPattern" => {
                    render.sampling_pattern = match value.as_str() {
                        Some("sobol") => api::SamplingPattern::Sobol,
                        Some("zsobol") => api::SamplingPattern::ZSobol,
                        Some("random") => api::SamplingPattern::Random,
                        _ => anyhow::bail!("Unknown sampling pattern"),
                    }
                }
                "fov" => camera.fov = number()? as f32,
                "fStop" => camera.f_stop = number()? as f32,
                "focusDistance" => camera.focus_distance = number()? as f32,
                "exposure" => display.tone_mapping_exposure = number()? as f32,
                "contrast" => display.contrast = number()? as f32,
                "saturation" => display.saturation = number()? as f32,
                "temperature" => display.temperature = number()? as f32,
                "tint" => display.tint = number()? as f32,
                "bloomIntensity" => display.bloom_intensity = number()? as f32,
                "bloomThreshold" => display.bloom_threshold = number()? as f32,
                "bloomRadius" => display.bloom_radius = number()? as f32,
                "vignette" => display.vignette = number()? as f32,
                "toneMapping" => {
                    display.tone_mapping = match value.as_str() {
                        Some("agx") => api::ToneMapping::Agx,
                        Some("aces") => api::ToneMapping::Aces,
                        Some("cineon") => api::ToneMapping::Cineon,
                        Some("reinhard") => api::ToneMapping::Reinhard,
                        Some("linear") => api::ToneMapping::Linear,
                        _ => anyhow::bail!("Unknown tone mapper"),
                    }
                }
                "envIntensity" => {
                    env.intensity = number()? as f32;
                    env_changed = true;
                }
                "envRotation" => {
                    env.rotation = (number()? as f32).to_radians();
                    env_changed = true;
                }
                _ => anyhow::bail!("Native prototype: setting {key} is not available yet"),
            }
        }
        self.render_loop.final_render().set_settings(render)?;
        self.engine.display().set_settings(display)?;
        self.orbit.camera = camera;
        self.engine.set_camera(Some(self.orbit.camera()))?;
        if env_changed {
            self.model.scene.set_environment_settings(env)?;
            self.engine.set_scene_object(&self.model.scene)?;
        }
        Ok(())
    }
    fn message(&mut self, message: Message) -> Result<()> {
        if message.body.starts_with('~') {
            self.camera_packets += 1;
            if self.orbit.packet(&message.body, self.logical_height)? {
                self.engine.set_camera(Some(self.orbit.camera()))?;
            }
            return Ok(());
        }
        ensure!(message.body.len() <= 180_001_000, "IPC message too large");
        let request: Value = serde_json::from_str(&message.body)?;
        let reply = match self.command(&request, message.received) {
            Ok(result) => json!({"id":request["id"],"result":result}),
            Err(error) => {
                eprintln!("Command error: {error:#}");
                json!({"id":request["id"],"error":format!("{error:#}")})
            }
        };
        self.send(reply)
    }
    fn frame(&mut self) -> Result<()> {
        if !self.paused {
            self.render_loop.tick()?;
        }
        if self.window.inner_size().width == 0 || self.window.inner_size().height == 0 {
            return Ok(());
        }
        self.gpu
            .present(&self.window, self.engine.display().texture(), self.rect)?;
        if !self.ready {
            return Ok(());
        }
        let events: Vec<_> = self.engine_events.lock().unwrap().drain(..).collect();
        for event in events {
            self.send(event)?;
        }
        let samples = self.render_loop.final_render().samples();
        if samples < self.last_samples || samples == 0 {
            self.accumulation_start = Instant::now();
        }
        if samples != self.last_samples {
            self.sample_elapsed = self.accumulation_start.elapsed().as_secs_f64();
        }
        self.last_samples = samples;
        if samples > 0 {
            if self
                .pending_edit
                .as_ref()
                .is_some_and(|(_, _, presentations)| {
                    self.render_loop.presentations() > *presentations
                })
                && matches!(
                    self.render_loop.status(),
                    api::RenderLoopStatus::Converging | api::RenderLoopStatus::Finished
                )
            {
                let (sent_at, received, _) = self.pending_edit.take().unwrap();
                self.event(
                    "presented",
                    json!({"sentAt":sent_at,"hostMs":received.elapsed().as_secs_f64()*1000.}),
                )?;
            }
        }
        let times: Vec<_> = self.frame_times.lock().unwrap().drain(..).collect();
        if let Some(time) = times.last() {
            self.sample_ms = *time;
        }
        for time in &times {
            self.event(
                "sample",
                json!({"samples":samples,"isFirstFrame":samples==1,"frameTimeMs":time}),
            )?;
        }
        if self.last_publish.elapsed() > Duration::from_millis(120) {
            let render = self.render_loop.final_render();
            let size = render.settings()?.size;
            let scale = match size {
                api::RenderSize::Scale(scale) => scale,
                _ => 1.,
            };
            let phase = if self.paused {
                "paused".into()
            } else {
                format!("{:?}", self.render_loop.status()).to_lowercase()
            };
            self.event("stats",json!({"phase":phase,"samples":samples,"elapsed":self.sample_elapsed,"msPerSample":self.sample_ms,"width":(self.rect[2] as f64*scale).round() as u32,"height":(self.rect[3] as f64*scale).round() as u32}))?;
            self.last_publish = Instant::now();
        }
        Ok(())
    }
    fn save(&self, dir: &std::path::Path, label: &str) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        let render = self.render_loop.final_render();
        std::fs::write(
            dir.join(format!("{label}.png")),
            self.engine.display().encode_png(render)?,
        )?;
        let image = render.read_pixels(api::PixelKind::Hdr)?;
        let bytes: Vec<u8> = image.data.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(dir.join(format!("{label}.hdr.f32")), bytes)?;
        std::fs::write(
            dir.join(format!("{label}.json")),
            serde_json::to_vec_pretty(
                &json!({"width":image.width,"height":image.height,"samples":render.samples(),"seed":render.settings()?.seed,"camera":self.orbit.camera().world_matrix,"scene":self.model.snapshot()?}),
            )?,
        )?;
        Ok(())
    }
}
struct App {
    host: Option<Host>,
    proxy: EventLoopProxy<Message>,
    model: Option<PathBuf>,
    evidence: Option<PathBuf>,
    started: Instant,
    error: Option<String>,
}
impl ApplicationHandler<Message> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.host.is_none() {
            match Host::new(event_loop, self.proxy.clone(), self.model.as_deref()) {
                Ok(host) => {
                    if self.evidence.is_some() {
                        let mut settings = host.render_loop.final_render().settings().unwrap();
                        settings.max_samples = 16;
                        if let Err(error) = host.render_loop.final_render().set_settings(settings) {
                            self.error = Some(error.to_string());
                            event_loop.exit();
                            return;
                        }
                    }
                    self.host = Some(host);
                }
                Err(error) => {
                    self.error = Some(format!("{error:#}"));
                    event_loop.exit();
                }
            }
        }
    }
    fn user_event(&mut self, _: &ActiveEventLoop, message: Message) {
        if let Some(host) = &mut self.host {
            if let Err(error) = host.message(message) {
                eprintln!("IPC error: {error:#}");
            }
        }
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let Some(host) = &mut self.host else {
            return;
        };
        let result = match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
                Ok(())
            }
            WindowEvent::Resized(size) => {
                host.gpu.resize(size.width, size.height);
                host.webview
                    .set_bounds(wry::Rect {
                        position: wry::dpi::PhysicalPosition::new(0, 0).into(),
                        size: wry::dpi::PhysicalSize::new(size.width, size.height).into(),
                    })
                    .map_err(Into::into)
            }
            WindowEvent::RedrawRequested => host.frame(),
            _ => Ok(()),
        };
        if let Err(error) = result {
            self.error = Some(format!("{error:#}"));
            event_loop.exit();
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        #[cfg(target_os = "linux")]
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        if let Some(host) = &mut self.host {
            host.window.request_redraw();
            if let Some(dir) = &self.evidence {
                if host.ready
                    && host.render_loop.final_render().samples() >= 16
                    && host.smoke_phase == 0
                {
                    if let Err(error) = host.save(dir, "baseline") {
                        self.error = Some(format!("{error:#}"));
                        event_loop.exit();
                    }
                    host.smoke_phase = 1;
                }
                if host.render_loop.final_render().samples() == 16
                    && host.material_edits > 0
                    && host.smoke_phase == 1
                {
                    if let Err(error) = host.save(dir, "material-edited") {
                        self.error = Some(format!("{error:#}"));
                        event_loop.exit();
                    }
                    host.smoke_phase = 2;
                }
                if host.render_loop.final_render().samples() == 16
                    && host.camera_packets >= 3
                    && host.smoke_phase == 2
                {
                    if let Err(error) = host.save(dir, "orbit") {
                        self.error = Some(format!("{error:#}"));
                        event_loop.exit();
                    }
                    host.smoke_phase = 3;
                }
                if self.started.elapsed() > Duration::from_secs(120) {
                    event_loop.exit();
                }
            }
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(
            Instant::now() + Duration::from_millis(16),
        ));
    }
}
fn main() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        ensure!(
            std::env::var_os("DISPLAY").is_some(),
            "Prototype child WebView requires X11; Wayland is not implemented"
        );
        gtk::init()?;
    }
    let mut model = None;
    let mut evidence = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--evidence" {
            evidence = Some(PathBuf::from(
                args.next().context("--evidence needs a directory")?,
            ));
        } else {
            model = Some(PathBuf::from(arg));
        }
    }
    let event_loop = EventLoop::<Message>::with_user_event().build()?;
    let proxy = event_loop.create_proxy();
    let mut app = App {
        host: None,
        proxy,
        model,
        evidence,
        started: Instant::now(),
        error: None,
    };
    event_loop.run_app(&mut app)?;
    if let (Some(host), Some(dir)) = (&app.host, &app.evidence) {
        std::fs::create_dir_all(dir)?;
        host.save(dir, "final")?;
        std::fs::write(
            dir.join("run.json"),
            serde_json::to_vec_pretty(
                &json!({"adapter":host.engine.info().adapter_name,"hardwareRayQuery":host.engine.info().hardware_ray_query,"backend":format!("{:?}",host.render_loop.final_render().backend()?.0),"presentations":host.gpu.presentations,"cameraPackets":host.camera_packets,"materialEdits":host.material_edits,"latencies":host.latencies,"viewport":host.rect,"error":app.error}),
            )?,
        )?;
    }
    if let Some(error) = app.error {
        anyhow::bail!(error);
    }
    Ok(())
}
