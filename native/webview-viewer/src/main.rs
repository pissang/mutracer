//! Shared WebEngine + React UI; only Engine/Render/Display execution crosses IPC.
mod assets;
mod binary;
mod catalog;
#[cfg(all(target_os = "windows", feature = "dlss-rr"))]
mod dlss;
mod gpu;
mod initial_files;
mod input;
#[cfg(test)]
mod reference_tests;
mod sky;
mod smoke;
mod wire;
use anyhow::{Context, Result, bail, ensure};
use glam::Mat4;
use mutracer_native::api;
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::BTreeMap,
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
struct Message {
    body: String,
}
#[cfg(target_os = "linux")]
use gtk::prelude::*;
struct Export {
    request: Value,
    target: u64,
    samples: u32,
    completed: bool,
    camera: api::Camera,
}
struct Host {
    #[cfg(target_os = "linux")]
    gtk_window: gtk::Window,
    restart: Option<Value>,
    closing: bool,
    workflow: bool,
    #[cfg(target_os = "linux")]
    cursor: [f32; 2],
    #[cfg(target_os = "linux")]
    down: Option<[f32; 2]>,
    webview: WebView,
    render_loop: Option<api::RenderLoop>,
    targets: BTreeMap<u64, Arc<api::Render>>,
    target_configs: BTreeMap<u64, Value>,
    sample_subscriptions: BTreeMap<u64, api::Subscription>,
    events: Arc<Mutex<Vec<Value>>>,
    _engine_subscription: api::Subscription,
    engine: api::Engine,
    #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
    dlss: Option<Arc<dlss::Dlss>>,
    orbit: input::Orbit,
    gpu: gpu::Gpu,
    window: Arc<Window>,
    binary: binary::Shared,
    sky: sky::Baker,
    descriptor: Option<Arc<Vec<u8>>>,
    camera: api::Camera,
    rect: [u32; 4],
    logical_height: f32,
    output_aspect: f64,
    ready: bool,
    paused: bool,
    dirty: bool,
    phase: String,
    last_publish: Instant,
    upscale: Option<api::PostProcessSubscription>,
    export: Option<Export>,
    evidence: Option<PathBuf>,
    started: Instant,
}
impl Host {
    #[cfg(target_os = "linux")]
    fn native_bounds(&mut self) -> Result<()> {
        let size = self.window.inner_size();
        let (mut w, mut h) = (size.width.max(1), size.height.max(1));
        if self.output_aspect > 0. {
            w = w
                .min((f64::from(h) * self.output_aspect).round() as u32)
                .max(1);
            h = (f64::from(w) / self.output_aspect).round().max(1.) as u32;
        }
        self.rect = [
            size.width.saturating_sub(w) / 2,
            size.height.saturating_sub(h) / 2,
            w,
            h,
        ];
        self.logical_height = h as f32;
        self.engine.display().set_size(w, h)?;
        Ok(())
    }
    fn dlss_available(&self) -> bool {
        #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
        {
            self.dlss.is_some()
        }
        #[cfg(not(all(target_os = "windows", feature = "dlss-rr")))]
        {
            false
        }
    }

    fn new(
        event_loop: &ActiveEventLoop,
        proxy: EventLoopProxy<Message>,
        path: Option<&std::path::Path>,
        evidence: Option<PathBuf>,
        workflow: bool,
    ) -> Result<Self> {
        let window = Arc::new(
            event_loop.create_window(
                Window::default_attributes()
                    .with_title("MuTracer")
                    .with_inner_size(LogicalSize::new(1280., 800.)),
            )?,
        );
        #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
        let dlss = if std::env::var("MUTRACER_VIEWER_DLSS").as_deref() == Ok("1") {
            let dir = std::env::current_exe()?
                .parent()
                .context("App directory")?
                .to_path_buf();
            Some(dlss::Dlss::new(&dir, 0)?)
        } else {
            None
        };
        #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
        let gpu = if let Some(filter) = &dlss {
            gpu::Gpu::from_device(&window, filter.device())?
        } else {
            gpu::Gpu::new(event_loop, &window)?
        };
        #[cfg(not(all(target_os = "windows", feature = "dlss-rr")))]
        let gpu = gpu::Gpu::new(event_loop, &window)?;
        let engine = gpu.engine();
        let events = Arc::new(Mutex::new(Vec::new()));
        let outgoing = events.clone();
        let subscription=engine.on(move|event|{
            let event=match event{
                api::EngineEvent::Error{message}=>json!({"event":"error","value":message}),
                api::EngineEvent::DeviceLost{reason,..}=>json!({"event":"error","value":reason}),
                api::EngineEvent::Progress{stage,progress}=>json!({"event":"progress","value":{"stage":if *stage==api::ProgressStage::Preparation{"bvh"}else{"shaders"},"progress":progress}})
            };outgoing.lock().unwrap().push(event);
        });
        let sky = sky::Baker::new(gpu.device.clone(), gpu.queue.clone());
        let binary = binary::Shared::default();
        let mailbox = binary.clone();
        let mut initial_model = Value::Null;
        if let Some(path) = path {
            initial_model = initial_files::stage(path, &binary)?;
        }
        let size = window.inner_size();
        let protocol = move |_: wry::WebViewId, request: wry::http::Request<Vec<u8>>| {
            let (parts, body) = request.into_parts();
            if let Some(key) = parts.uri.path().strip_prefix("/bridge/") {
                let result = if parts.method == wry::http::Method::POST {
                    let number = |key: &str| -> Result<usize> {
                        Ok(parts
                            .headers
                            .get(key)
                            .context("Missing upload header")?
                            .to_str()?
                            .parse()?)
                    };
                    if parts.headers.contains_key("X-Mutracer-Offset") {
                        (|| {
                            mailbox.lock().unwrap().receive_chunk(
                                key,
                                number("X-Mutracer-Offset")?,
                                number("X-Mutracer-Length")?,
                                body,
                            )?;
                            Ok(Vec::new())
                        })()
                    } else {
                        mailbox
                            .lock()
                            .unwrap()
                            .receive(key, body)
                            .map(|_| Vec::new())
                    }
                } else if parts.method == wry::http::Method::DELETE {
                    mailbox.lock().unwrap().discard(key);
                    Ok(Vec::new())
                } else {
                    mailbox.lock().unwrap().take(key)
                };
                return match result {
                    Ok(bytes) => wry::http::Response::builder()
                        .header("Content-Type", "application/octet-stream")
                        .header("Cache-Control", "no-store")
                        .body(Cow::Owned(bytes))
                        .unwrap(),
                    Err(error) => wry::http::Response::builder()
                        .status(400)
                        .body(Cow::Owned(error.to_string().into_bytes()))
                        .unwrap(),
                };
            }
            assets::response(parts.uri.path())
        };
        let import_only = std::env::var_os("MUTRACER_VIEWER_IMPORT_ONLY").is_some();
        let init = format!(
            "window.mutracerImportOnly={import_only};window.mutracerWorkflow={workflow};window.mutracerEvidence={};window.mutracerInitialModel={initial_model};window.addEventListener('error',e=>window.ipc.postMessage(JSON.stringify({{version:1,id:0,command:'frontendError',args:{{message:e.message}}}})));window.addEventListener('unhandledrejection',e=>window.ipc.postMessage(JSON.stringify({{version:1,id:0,command:'frontendError',args:{{message:String(e.reason)}}}})));",
            evidence.is_some()
        );
        #[cfg(target_os = "linux")]
        let ui_proxy = proxy.clone();
        #[cfg(target_os = "macos")]
        let recovery_proxy = proxy.clone();
        let builder = WebViewBuilder::new()
            .with_incognito(evidence.is_some())
            .with_transparent(true)
            .with_bounds(wry::Rect {
                position: wry::dpi::PhysicalPosition::new(0, 0).into(),
                size: wry::dpi::PhysicalSize::new(size.width, size.height).into(),
            })
            .with_asynchronous_custom_protocol("mutracer".into(), move |id, request, responder| {
                if request.uri().path().starts_with("/api/gpuopen/")
                    && request.method() == wry::http::Method::GET
                {
                    let path = request
                        .uri()
                        .path_and_query()
                        .map(|v| v.as_str())
                        .unwrap_or("")
                        .to_owned();
                    std::thread::spawn(move || responder.respond(catalog::response(&path)));
                } else {
                    responder.respond(protocol(id, request));
                }
            })
            .with_initialization_script(&init)
            .with_ipc_handler(move |request| {
                let _ = proxy.send_event(Message {
                    body: request.into_body(),
                });
            })
            .with_navigation_handler(|url| {
                url.starts_with("mutracer://localhost/")
                    || url.starts_with("http://mutracer.localhost/")
            })
            .with_url("mutracer://localhost/index.html");
        #[cfg(target_os = "macos")]
        let builder = {
            use wry::WebViewBuilderExtDarwin;
            builder.with_on_web_content_process_terminate_handler(move || {
                eprintln!("WebView content process terminated; restoring UI");
                let _ = recovery_proxy.send_event(Message {
                    body: "__content_process_terminated".into(),
                });
            })
        };
        #[cfg(not(target_os = "linux"))]
        let webview = builder.build_as_child(&*window)?;
        #[cfg(target_os = "linux")]
        let (webview, gtk_window) = {
            use wry::WebViewBuilderExtUnix;
            let ui = gtk::Window::new(gtk::WindowType::Toplevel);
            ui.set_title("MuTracer · Controls");
            let close_proxy = ui_proxy.clone();
            ui.connect_delete_event(move |_, _| {
                let _ = close_proxy.send_event(Message {
                    body: "{\"version\":1,\"id\":0,\"command\":\"quit\",\"args\":{}}".into(),
                });
                gtk::glib::Propagation::Proceed
            });
            ui.set_default_size(900, 800);
            let fixed = gtk::Fixed::new();
            let resize_proxy = ui_proxy.clone();
            fixed.connect_size_allocate(move|_,size|{let _=resize_proxy.send_event(Message{body:json!({"version":1,"id":0,"command":"uiBounds","args":{"width":size.width(),"height":size.height()}}).to_string()});});
            ui.add(&fixed);
            ui.show_all();
            let view = builder.with_transparent(false).build_gtk(&fixed)?;
            (view, ui)
        };
        Ok(Self {
            #[cfg(target_os = "linux")]
            gtk_window,
            restart: None,
            closing: false,
            workflow,
            #[cfg(target_os = "linux")]
            cursor: [0., 0.],
            #[cfg(target_os = "linux")]
            down: None,
            webview,
            render_loop: None,
            targets: BTreeMap::new(),
            target_configs: BTreeMap::new(),
            sample_subscriptions: BTreeMap::new(),
            events,
            _engine_subscription: subscription,
            engine,
            #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
            dlss,
            orbit: input::Orbit::default(),
            gpu,
            window,
            binary,
            sky,
            descriptor: None,
            camera: api::Camera::default(),
            rect: [0, 0, 640, 400],
            logical_height: 400.,
            output_aspect: 0.,
            ready: false,
            paused: false,
            dirty: true,
            phase: "preparing".into(),
            last_publish: Instant::now(),
            upscale: None,
            export: None,
            evidence,
            started: Instant::now(),
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
    fn target(&self, v: &Value) -> Result<&Arc<api::Render>> {
        self.targets
            .get(&v["target"].as_u64().context("Missing target")?)
            .context("Unknown render target")
    }
    fn settings(&mut self, v: &Value) -> Result<()> {
        // Parse all settings before mutating the engine. SDK validation guards values.
        let configs = v["targets"].as_array().context("Expected targets")?;
        let parsed = configs
            .iter()
            .map(|c| {
                Ok((
                    c["id"].as_u64().context("Target ID")?,
                    wire::render(&c["settings"], &c["fixedSize"])?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let display = wire::display(&v["display"])?;
        for (id, settings) in parsed {
            if let Some(target) = self.targets.get(&id) {
                if self.target_configs.get(&id) != configs.iter().find(|c| c["id"] == id) {
                    target.set_settings(settings)?;
                }
            } else {
                let target = Arc::new(api::Render::new(&self.engine, settings)?);
                let events = self.events.clone();
                let subscription=target.on_sample(move|event|events.lock().unwrap().push(json!({"event":"sample","value":{"target":id,"samples":event.samples,"isFirstFrame":event.is_first_frame,"frameTimeMs":event.frame_time_ms}})));
                self.sample_subscriptions.insert(id, subscription);
                self.targets.insert(id, target);
            }
        }
        for c in configs {
            let id = c["id"].as_u64().unwrap();
            if self.target_configs.get(&id) != Some(c) {
                let target = &self.targets[&id];
                let fallback = c["fallback"].as_u64().and_then(|id| self.targets.get(&id));
                target.set_fallback(fallback.map(Arc::as_ref))?;
                #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
                if c["denoiser"]["type"] == "dlss" {
                    let filter = self
                        .dlss
                        .as_ref()
                        .context("DLSS runtime is unavailable")?
                        .clone();
                    target.set_jnlm_display_filter(None)?;
                    target.set_custom_denoiser(Some(filter), api::DenoiseSchedule::EverySample)?;
                } else {
                    wire::denoiser(target, &c["denoiser"])?;
                }
                #[cfg(not(all(target_os = "windows", feature = "dlss-rr")))]
                wire::denoiser(target, &c["denoiser"])?;
                self.target_configs.insert(id, c.clone());
            }
        }
        self.engine.display().set_settings(display)?;
        #[cfg(not(target_os = "linux"))]
        let size = v["size"].as_array().context("Expected display size")?;
        #[cfg(not(target_os = "linux"))]
        {
            ensure!(size.len() == 2, "Expected display size");
            self.engine.display().set_size(
                size[0].as_u64().context("Invalid width")? as u32,
                size[1].as_u64().context("Invalid height")? as u32,
            )?;
        }
        self.output_aspect = v["aspect"]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.)
            .unwrap_or(0.);
        #[cfg(target_os = "linux")]
        self.native_bounds()?;
        let upscale = v["upscale"].as_bool().unwrap_or(false);
        if upscale && self.upscale.is_none() {
            self.upscale = Some(self.engine.display().add_upscale(api::EasuOptions {
                albedo_detail: true,
                ..Default::default()
            })?);
        } else if !upscale {
            self.upscale = None;
        }
        let final_id = v["final"].as_u64();
        if let Some(final_target) = final_id.and_then(|id| self.targets.get(&id)) {
            if self.render_loop.is_none() {
                self.render_loop = Some(api::RenderLoop::new(
                    &self.engine,
                    api::RenderLoopOptions {
                        preview: v["preview"]
                            .as_u64()
                            .and_then(|id| self.targets.get(&id))
                            .map(|t| api::LoopRender::Render(t.clone())),
                        final_render: api::LoopRender::Render(final_target.clone()),
                        coalesce_scene_updates: v["coalesce"].as_bool().unwrap_or(false),
                        ..Default::default()
                    },
                )?);
            }
            self.render_loop.as_mut().unwrap().coalesce_scene_updates =
                v["coalesce"].as_bool().unwrap_or(false);
            let preview_enabled = final_target.settings().is_ok()
                && configs
                    .iter()
                    .find(|c| c["id"].as_u64() == final_id)
                    .is_some_and(|c| !c["fallback"].is_null());
            let requested = v["selection"] == "preview";
            self.render_loop.as_mut().unwrap().set_select(move |info| {
                if preview_enabled && (requested || info.changing) {
                    api::Selection::Preview
                } else {
                    api::Selection::Final
                }
            });
        }
        Ok(())
    }
    fn command(&mut self, request: &Value) -> Result<Option<Value>> {
        ensure!(request["version"] == 1, "Unsupported IPC version");
        let args = &request["args"];
        match request["command"].as_str().context("Missing command")? {
            "ready" => {
                self.ready = true;
                return Ok(Some(
                    json!({"adapterName":self.engine.info().adapter_name,"maxImageDimension":self.gpu.device.limits().max_texture_dimension_2d.min(8192),"hwrt":self.engine.info().hardware_ray_query,"dlssRR":self.dlss_available(),"gpuSelection":!self.dlss_available(),"adapters":pollster::block_on(self.gpu.instance.enumerate_adapters(wgpu::Backends::all())).iter().filter(|a|a.is_surface_supported(&self.gpu.surface)).map(|a|a.get_info().name).collect::<Vec<_>>(),"backend":if self.engine.info().backend==api::Backend::Software{"software"}else{"hardware"},"hdrWindow":self.gpu.hdr_supported(),"layout":if cfg!(target_os="linux"){"split"}else{"overlay"}}),
                ));
            }
            "commit" => {
                let next = if let Some(key) = args["blob"].as_str() {
                    let bytes = self.binary.lock().unwrap().take(key)?;
                    Some(Arc::new(wire::delta_owned(
                        self.descriptor.as_deref().map(Vec::as_slice),
                        bytes,
                    )?))
                } else {
                    None
                };
                if args["settings"].is_object() {
                    self.settings(&args["settings"])?;
                }
                if let Some(next) = next {
                    self.engine.set_scene_shared(next.clone())?;
                    self.descriptor = Some(next);
                }
                if args["clear"] == true {
                    self.engine.clear_scene()?;
                    self.descriptor = None;
                }
                if args["camera"].is_array() {
                    self.camera = wire::camera(&args["camera"])?;
                    self.engine.set_camera(Some(self.camera))?;
                    self.orbit.camera = self.camera;
                    let world = Mat4::from_cols_array(&self.camera.world_matrix);
                    let p = world.w_axis.truncate();
                    let target = args["cameraTarget"]
                        .as_array()
                        .filter(|v| v.len() == 3)
                        .map(|v| {
                            glam::Vec3::new(
                                v[0].as_f64().unwrap_or(0.) as f32,
                                v[1].as_f64().unwrap_or(0.) as f32,
                                v[2].as_f64().unwrap_or(0.) as f32,
                            )
                        })
                        .unwrap_or(p - world.z_axis.truncate() * self.orbit.radius);
                    self.orbit.look_at(p, target);
                }
            }
            "settled" => {
                self.engine.update()?;
                return Ok(Some(json!(self.render_loop.as_ref().is_some_and(
                    |l| l.status() == api::RenderLoopStatus::Finished
                        && l.final_render().status() == api::RenderStatus::Finished
                        && !self.engine.diagnostics().preparing
                        && !self.engine.diagnostics().compiling
                ))));
            }
            "artifact" => {
                ensure!(self.workflow, "Evidence driver is disabled");
                let label = args["label"].as_str().context("Artifact name")?;
                ensure!(
                    !label.is_empty()
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
                    "Invalid artifact name"
                );
                let kind = args["kind"].as_str().context("Artifact type")?;
                ensure!(
                    ["png", "f32", "json"].contains(&kind),
                    "Invalid artifact type"
                );
                let bytes = self
                    .binary
                    .lock()
                    .unwrap()
                    .take(args["blob"].as_str().context("Artifact payload")?)?;
                let dir = self.evidence.as_ref().unwrap();
                std::fs::create_dir_all(dir)?;
                std::fs::write(dir.join(format!("{label}.{kind}")), bytes)?;
            }
            "workflowDone" => {
                ensure!(self.workflow, "Evidence driver is disabled");
                let dir = self.evidence.as_ref().unwrap();
                std::fs::create_dir_all(dir)?;
                std::fs::write(dir.join("workflow.json"), serde_json::to_vec_pretty(args)?)?;
                self.closing = true;
            }
            "uiBounds" => {
                self.webview.set_bounds(wry::Rect {
                    position: wry::dpi::LogicalPosition::new(0., 0.).into(),
                    size: wry::dpi::LogicalSize::new(
                        args["width"].as_f64().unwrap_or(900.),
                        args["height"].as_f64().unwrap_or(800.),
                    )
                    .into(),
                })?;
            }
            "quit" => self.closing = true,
            "device" => {
                self.restart = Some(args.clone());
            }
            "viewport" => {
                #[cfg(target_os = "linux")]
                {
                    return Ok(Some(Value::Null));
                }
                let dpr = self.window.scale_factor();
                let s = self.window.inner_size();
                let n = |k: &str| -> Result<u32> {
                    let value = args[k].as_f64().context("Viewport coordinate")?;
                    ensure!(value.is_finite() && value >= 0., "Invalid viewport");
                    Ok((value * dpr).round() as u32)
                };
                let x = n("x")?;
                let y = n("y")?;
                self.rect = [
                    x,
                    y,
                    n("width")?.min(s.width.saturating_sub(x)),
                    n("height")?.min(s.height.saturating_sub(y)),
                ];
                self.logical_height = args["height"].as_f64().unwrap_or(1.) as f32;
            }
            "pause" => self.paused = args["paused"].as_bool().context("Pause bool")?,
            "sky" => {
                let width = args["width"].as_u64().context("Sky width")? as u32;
                let height = args["height"].as_u64().context("Sky height")? as u32;
                ensure!(
                    width > 0
                        && height > 0
                        && width <= self.gpu.device.limits().max_texture_dimension_2d
                        && height <= self.gpu.device.limits().max_texture_dimension_2d,
                    "Sky dimensions exceed device limits"
                );
                let time = args["sky"]["time"].as_f64().context("Sky time")? as f32;
                let intensity = args["intensity"].as_f64().context("Sky intensity")? as f32;
                let ambient = args["ambient"].as_array().context("Sky ambient")?;
                ensure!(ambient.len() == 3, "Sky RGB ambient");
                let ambient = ambient
                    .iter()
                    .map(|n| n.as_f64().context("Ambient number").map(|v| v as f32))
                    .collect::<Result<Vec<_>>>()?;
                let pixels = self.sky.bake(time, width, height)?;
                let bytes = pixels
                    .iter()
                    .enumerate()
                    .flat_map(|(i, v)| {
                        if i % 4 == 3 {
                            1f32
                        } else {
                            v * intensity + ambient[i % 4]
                        }
                        .to_le_bytes()
                    })
                    .collect();
                let blob = self.binary.lock().unwrap().put(bytes);
                return Ok(Some(json!({"blob":blob})));
            }
            "save" => {
                let bytes = self
                    .binary
                    .lock()
                    .unwrap()
                    .take(args["blob"].as_str().context("Missing binary")?)?;
                let path = rfd::FileDialog::new()
                    .set_file_name(args["name"].as_str().unwrap_or("mutracer.png"))
                    .save_file();
                if let Some(path) = path {
                    std::fs::write(path, bytes)?;
                    return Ok(Some(json!(true)));
                }
                return Ok(Some(json!(false)));
            }
            "pixels" => {
                let kind = wire::pixel(args["kind"].as_str().unwrap_or("hdr"))?;
                let mut image = self.target(args)?.read_pixels(kind)?;
                if kind == api::PixelKind::Normal {
                    // Browser readPixels('normal') exposes encoded RGB plus guide
                    // coverage; the SDK's normal guide is signed, with alpha 1.
                    let coverage = self.target(args)?.read_pixels(api::PixelKind::Albedo)?;
                    for (normal, albedo) in image
                        .data
                        .chunks_exact_mut(4)
                        .zip(coverage.data.chunks_exact(4))
                    {
                        if albedo[3] > 0. {
                            for value in &mut normal[..3] {
                                *value = *value * 0.5 + 0.5;
                            }
                            normal[3] = albedo[3];
                        } else {
                            normal.fill(0.);
                        }
                    }
                }
                let bytes = if kind == api::PixelKind::Id {
                    image
                        .id_data
                        .unwrap_or_default()
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect()
                } else {
                    image.data.iter().flat_map(|v| v.to_le_bytes()).collect()
                };
                let blob = self.binary.lock().unwrap().put(bytes);
                return Ok(Some(
                    json!({"width":image.width,"height":image.height,"blob":blob}),
                ));
            }
            "image" => {
                let bytes = self.engine.display().encode_png(self.target(args)?)?;
                let blob = self.binary.lock().unwrap().put(bytes);
                return Ok(Some(json!({"blob":blob})));
            }
            "pick" => {
                let result = self.engine.pick_surface(
                    args["x"].as_f64().context("Pick X")? as f32,
                    args["y"].as_f64().context("Pick Y")? as f32,
                )?;
                return Ok(Some(match result {
                    api::SurfacePick::Unavailable => json!("unavailable"),
                    api::SurfacePick::Background => json!(null),
                    api::SurfacePick::Hit(hit) => {
                        json!({"object":hit.object,"material":hit.material,"instance":hit.instance})
                    }
                }));
            }
            "depth" => {
                let depth = self.engine.read_depth_samples(api::DepthSampleArea {
                    x: args["x"].as_f64().unwrap_or(0.5) as f32,
                    y: args["y"].as_f64().unwrap_or(0.5) as f32,
                    size: args["size"].as_f64().unwrap_or(0.004) as f32,
                })?;
                return Ok(Some(json!(depth.map(|a| a.to_vec()))));
            }
            "graphs" => {
                self.engine.update()?;
                let d = self.engine.diagnostics();
                return Ok(Some(
                    json!({"outcome":"settled","state":{"revision":d.scene_revision,"installedRevision":d.scene_revision,"status":if d.compiling||d.preparing{"compiling"}else if d.material_graphs.is_empty(){"ready"}else{"failed"},"diagnostics":d.material_graphs,"topologyCount":d.cached_pipelines}}),
                ));
            }
            "converge" => {
                ensure!(self.export.is_none(), "Export already running");
                let target = self.target(args)?;
                let mut settings = target.settings()?;
                settings.max_samples = args["samples"].as_u64().context("Samples")? as u32;
                target.set_settings(settings.clone())?;
                let camera = self.camera;
                if args["camera"].is_array() {
                    self.engine
                        .set_camera(Some(wire::camera(&args["camera"])?))?;
                }
                self.engine.update()?;
                self.export = Some(Export {
                    request: request.clone(),
                    target: args["target"].as_u64().unwrap(),
                    samples: settings.max_samples,
                    completed: false,
                    camera,
                });
                return Ok(None);
            }
            "cancel" => {
                if let Some(job) = self.export.take() {
                    self.engine.set_camera(Some(job.camera))?;
                    self.send(json!({"id":job.request["id"],"error":"Export cancelled"}))?;
                }
            }
            "dropTarget" => {
                if let Some(id) = args["target"].as_u64() {
                    if self.export.as_ref().is_some_and(|job| job.target == id) {
                        let job = self.export.take().unwrap();
                        self.engine.set_camera(Some(job.camera))?;
                    }
                    self.sample_subscriptions.remove(&id);
                    self.targets.remove(&id);
                    self.target_configs.remove(&id);
                }
            }
            "frontendError" => bail!("Frontend: {}", args["message"]),
            name => bail!("Unknown Engine command: {name}"),
        }
        self.dirty = true;
        Ok(Some(Value::Null))
    }
    fn message(&mut self, message: Message) -> Result<()> {
        if message.body == "__content_process_terminated" {
            // A new document has fresh target/request IDs. Drop all session state
            // and incomplete uploads before it reconnects; never replay the import
            // that terminated the process from initialization scripts or cache.
            self.ready = false;
            self.paused = false;
            self.orbit = input::Orbit::default();
            self.phase = "preparing".into();
            self.render_loop = None;
            self.export = None;
            self.sample_subscriptions.clear();
            self.targets.clear();
            self.target_configs.clear();
            self.upscale = None;
            self.engine.clear_scene()?;
            self.engine.update()?;
            self.descriptor = None;
            self.binary.lock().unwrap().clear();
            self.events.lock().unwrap().clear();
            self.webview
                .load_url("mutracer://localhost/index.html?recovered=1#model=spheres")?;
            self.dirty = true;
            return Ok(());
        }
        if message.body.starts_with('~') {
            if self.export.is_some() {
                return Ok(());
            }
            if self.orbit.packet(&message.body, self.logical_height)? {
                self.camera = self.orbit.camera();
                self.engine.set_camera(Some(self.camera))?;
                self.event("camera",json!({"matrix":self.camera.world_matrix,"target":self.orbit.target.to_array(),"zoom":self.camera.zoom}))?;
                self.dirty = true;
            }
            return Ok(());
        }
        let request: Value = serde_json::from_str(&message.body)?;
        match self.command(&request) {
            Ok(Some(result)) => self.send(json!({"id":request["id"],"result":result})),
            Ok(None) => Ok(()),
            Err(error) => {
                eprintln!("Engine command: {error:#}");
                self.send(json!({"id":request["id"],"error":format!("{error:#}")}))
            }
        }
    }
    fn frame(&mut self) -> Result<()> {
        if let Some(job) = self.export.as_ref().filter(|job| !job.completed) {
            let target = &self.targets[&job.target];
            let status = target.refine()?;
            let samples = target.samples();
            self.event("exportProgress",json!({"target":job.target,"stage":if target.denoising(){"denoising"}else{"final"},"samples":samples,"targetSamples":job.samples}))?;
            if status == api::RenderStatus::Error {
                let job = self.export.take().unwrap();
                self.engine.set_camera(Some(job.camera))?;
                self.send(json!({"id":job.request["id"],"error":self.engine.last_error()}))?;
            } else if status == api::RenderStatus::Finished {
                let request_id = self.export.as_ref().unwrap().request["id"].clone();
                self.export.as_mut().unwrap().completed = true;
                self.send(json!({"id":request_id,"result":{"samples":samples,"averageSamplesPerPixel":samples,"pilotSamples":0,"adaptiveSampling":false}}))?;
            }
        } else if self.export.is_none() && !self.paused {
            if let Some(render_loop) = &mut self.render_loop {
                self.phase = format!("{:?}", render_loop.tick()?).to_lowercase();
            }
        }
        for (id, config) in &self.target_configs {
            if config["denoiser"]["type"] == "jnlm" {
                wire::denoiser(&self.targets[id], &config["denoiser"])?;
            }
        }
        let events = self.events.lock().unwrap().drain(..).collect::<Vec<_>>();
        for event in events {
            self.send(event)?;
        }
        let hdr = self
            .gpu
            .set_hdr(self.engine.display().settings().hdr_output_enabled);
        let image = if hdr {
            if let Some(loop_) = &self.render_loop {
                if let Some(render) = loop_.presented_render() {
                    self.engine.display().compose_hdr(render)?
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            self.engine.display().texture()
        };
        self.gpu.present(&self.window, image, self.rect)?;
        if self.ready
            && (self.last_publish.elapsed() > Duration::from_millis(100) || !self.needs_tick())
        {
            let states=self.targets.iter().map(|(id,r)|(id.to_string(),json!({"samples":r.samples(),"aovSamples":r.aov_samples_rendered(),"width":r.width(),"height":r.height(),"status":format!("{:?}",r.status()).to_lowercase(),"denoising":r.denoising(),"frameTimeMs":r.gpu_sample_time_ms()}))).collect::<serde_json::Map<_,_>>();
            let d = self.engine.diagnostics();
            let graphs = json!({"revision":d.scene_revision,"installedRevision":d.scene_revision,"status":if d.compiling||d.preparing{"compiling"}else if d.material_graphs.is_empty(){"ready"}else{"failed"},"diagnostics":d.material_graphs,"topologyCount":d.cached_pipelines});
            self.event("state",json!({"phase":if self.paused{"paused"}else{&self.phase},"targets":states,"viewportSize":self.engine.display().size(),"diagnostics":{"backend":"webgpu","adapterName":d.info.adapter_name,"width":self.engine.display().size()[0],"height":self.engine.display().size()[1],"lastError":d.last_error,"materialGraphs":graphs}}))?;
            self.last_publish = Instant::now();
        }
        self.dirty = false;
        if let (Some(dir), Some(loop_)) = (&self.evidence, &self.render_loop) {
            if loop_.status() == api::RenderLoopStatus::Finished
                && !dir.join("final.hdr.f32").exists()
            {
                std::fs::create_dir_all(dir)?;
                let render = loop_.final_render();
                let image = render.read_pixels(api::PixelKind::Hdr)?;
                std::fs::write(
                    dir.join("final.hdr.f32"),
                    image
                        .data
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                )?;
                std::fs::write(
                    dir.join("final.png"),
                    self.engine.display().encode_png(render)?,
                )?;
                std::fs::write(
                    dir.join("run.json"),
                    serde_json::to_vec_pretty(
                        &json!({"width":image.width,"height":image.height,"samples":render.samples(),"seed":render.settings()?.seed,"presentations":self.gpu.presentations}),
                    )?,
                )?;
            }
        }
        Ok(())
    }
    fn needs_tick(&self) -> bool {
        self.dirty
            || self.export.as_ref().is_some_and(|job| !job.completed)
            || !self.paused
                && self
                    .render_loop
                    .as_ref()
                    .is_some_and(api::RenderLoop::needs_tick)
    }
}
struct App {
    host: Option<Host>,
    proxy: EventLoopProxy<Message>,
    model: Option<PathBuf>,
    evidence: Option<PathBuf>,
    workflow: bool,
    error: Option<String>,
}
impl ApplicationHandler<Message> for App {
    fn resumed(&mut self, e: &ActiveEventLoop) {
        if self.host.is_none() {
            match Host::new(
                e,
                self.proxy.clone(),
                self.model.as_deref(),
                self.evidence.clone(),
                self.workflow,
            ) {
                Ok(h) => self.host = Some(h),
                Err(error) => {
                    self.error = Some(format!("{error:#}"));
                    e.exit();
                }
            }
        }
    }
    fn user_event(&mut self, e: &ActiveEventLoop, message: Message) {
        if let Some(host) = &mut self.host {
            if let Err(error) = host.message(message) {
                eprintln!("IPC: {error:#}");
            }
            host.window.request_redraw();
            if host.closing {
                e.exit();
            }
            if let Some(options) = host.restart.take() {
                let mut command = std::process::Command::new(std::env::current_exe().unwrap());
                if let Some(gpu) = options["gpu"].as_str() {
                    command.env("MUTRACER_VIEWER_GPU", gpu);
                }
                if let Some(backend) = options["backend"].as_str() {
                    command.env("MUTRACER_VIEWER_BACKEND", backend);
                }
                match command.spawn() {
                    Ok(_) => e.exit(),
                    Err(error) => {
                        eprintln!("Restart failed: {error}");
                    }
                }
            }
        }
    }
    fn window_event(&mut self, e: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let Some(host) = &mut self.host else {
            return;
        };
        #[cfg(target_os = "linux")]
        {
            use winit::event::{ElementState, MouseButton, MouseScrollDelta};
            let input = match &event {
                WindowEvent::CursorMoved { position, .. } => {
                    host.cursor = [position.x as f32, position.y as f32];
                    Some([1., host.cursor[0], host.cursor[1], 0., 0.])
                }
                WindowEvent::MouseInput { state, button, .. } => {
                    let button = match button {
                        MouseButton::Left => 0.,
                        MouseButton::Right => 2.,
                        MouseButton::Middle => 1.,
                        _ => 3.,
                    };
                    if *state == ElementState::Pressed {
                        host.down = Some(host.cursor);
                    } else if button == 0.
                        && host.down.take().is_some_and(|p| {
                            (p[0] - host.cursor[0]).hypot(p[1] - host.cursor[1]) < 4.
                        })
                    {
                        let size = host.window.inner_size();
                        let _=host.event("viewportClick",json!({"x":(host.cursor[0]-host.rect[0] as f32)/host.rect[2].max(1) as f32,"y":(host.cursor[1]-host.rect[1] as f32)/host.rect[3].max(1) as f32}));
                    }
                    Some([
                        if *state == ElementState::Pressed {
                            0.
                        } else {
                            2.
                        },
                        host.cursor[0],
                        host.cursor[1],
                        button,
                        0.,
                    ])
                }
                WindowEvent::MouseWheel { delta, .. } => Some([
                    3.,
                    match delta {
                        MouseScrollDelta::LineDelta(_, y) => -y * 16.,
                        MouseScrollDelta::PixelDelta(p) => -p.y as f32,
                    },
                    0.,
                    0.,
                    0.,
                ]),
                _ => None,
            };
            if let Some(packet) = input {
                match host.orbit.input(packet, host.logical_height) {
                    Ok(true) => {
                        host.camera = host.orbit.camera();
                        let _ = host.engine.set_camera(Some(host.camera));
                        let _=host.event("camera",json!({"matrix":host.camera.world_matrix,"target":host.orbit.target.to_array(),"zoom":host.camera.zoom}));
                        host.dirty = true;
                        host.window.request_redraw();
                    }
                    Err(error) => eprintln!("Input: {error}"),
                    _ => {}
                }
            }
        }
        let result = match event {
            WindowEvent::CloseRequested => {
                e.exit();
                Ok(())
            }
            WindowEvent::Resized(size) => {
                host.gpu.resize(size.width, size.height);
                host.dirty = true;
                #[cfg(not(target_os = "linux"))]
                {
                    host.webview
                        .set_bounds(wry::Rect {
                            position: wry::dpi::PhysicalPosition::new(0, 0).into(),
                            size: wry::dpi::PhysicalSize::new(size.width, size.height).into(),
                        })
                        .map_err(Into::into)
                }
                #[cfg(target_os = "linux")]
                {
                    host.native_bounds()
                }
            }
            WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => {
                host.dirty = true;
                host.window.request_redraw();
                Ok(())
            }
            WindowEvent::RedrawRequested => host.frame(),
            _ => Ok(()),
        };
        if let Err(error) = result {
            self.error = Some(format!("{error:#}"));
            e.exit();
        }
    }
    fn about_to_wait(&mut self, e: &ActiveEventLoop) {
        #[cfg(target_os = "linux")]
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        if let Some(host) = &self.host {
            if host.needs_tick() {
                host.window.request_redraw();
                e.set_control_flow(ControlFlow::WaitUntil(
                    Instant::now() + Duration::from_millis(16),
                ));
            } else {
                e.set_control_flow(ControlFlow::Wait);
            }
            if !host.workflow
                && host.evidence.is_some()
                && std::env::var("MUTRACER_NATIVE_GPU_VALIDATION").as_deref() == Ok("1")
                && host
                    .evidence
                    .as_ref()
                    .is_some_and(|dir| dir.join("run.json").is_file())
            {
                e.exit();
            }
            if host.evidence.is_some() {
                if host.started.elapsed() > Duration::from_secs(120) {
                    e.exit();
                } else {
                    e.set_control_flow(ControlFlow::WaitUntil(
                        Instant::now() + Duration::from_millis(16),
                    ));
                }
            }
        }
        #[cfg(target_os = "linux")]
        e.set_control_flow(ControlFlow::WaitUntil(
            Instant::now() + Duration::from_millis(16),
        ));
    }
}
fn main() -> Result<()> {
    #[cfg(target_os = "linux")]
    gtk::init()?;
    let mut model = None;
    let mut evidence = None;
    let mut workflow = false;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--package-smoke" {
            return smoke::run(&PathBuf::from(
                args.next().context("Package output directory")?,
            ));
        }
        if arg == "--workflow-evidence" {
            workflow = true;
            evidence = Some(PathBuf::from(
                args.next().context("Workflow evidence directory")?,
            ));
        } else if arg == "--evidence" {
            evidence = Some(PathBuf::from(args.next().context("Evidence directory")?));
        } else if arg == "--startup-smoke" {
            let report = PathBuf::from(args.next().context("Startup report")?);
            evidence = Some(
                report
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("startup-window"),
            );
        } else {
            model = Some(PathBuf::from(arg));
        }
    }
    let event_loop = EventLoop::<Message>::with_user_event().build()?;
    let mut app = App {
        host: None,
        proxy: event_loop.create_proxy(),
        model,
        evidence,
        workflow,
        error: None,
    };
    event_loop.run_app(&mut app)?;
    if let Some(error) = app.error {
        bail!(error);
    }
    Ok(())
}
