//! Minimal window host and real-surface lifecycle smoke.
//! cargo run --example surface --manifest-path native/viewer/Cargo.toml -- SCENE REPORT
use anyhow::{Result, ensure};
use mutracer_native_probe::api::{self, SurfaceStatus};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    dpi::PhysicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::{Window, WindowId},
};
struct Host {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    engine: api::Engine,
    render_loop: api::RenderLoop,
    window: Arc<Window>,
    phase: u32,
    backend: api::Backend,
    original: Option<api::Image>,
    hdr_pass: Option<api::PostProcessSubscription>,
    hdr_calls: Arc<std::sync::atomic::AtomicU32>,
    hdr_report: Option<serde_json::Value>,
}
impl Host {
    fn engine(
        adapter: &wgpu::Adapter,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        window: &Arc<Window>,
        instance: &wgpu::Instance,
        scene: &[u8],
        backend: api::Backend,
    ) -> Result<(api::Engine, api::RenderLoop)> {
        let engine =
            api::Engine::on_device(adapter, device, queue, api::EngineOptions { backend }, None);
        let notify = engine.device_loss_notifier();
        device.set_device_lost_callback(move |reason, message| {
            notify.notify(format!("{reason:?}: {message}"))
        });
        let display = engine.display();
        let size = window.inner_size();
        display.set_size(size.width.max(1), size.height.max(1))?;
        display.attach_surface(instance.create_surface(window.clone())?, Default::default())?;
        engine.set_scene(scene)?;
        let render_loop = api::RenderLoop::new(
            &engine,
            api::RenderLoopOptions {
                preview: None,
                final_render: api::LoopRender::Settings(api::RenderSettings {
                    max_samples: 2,
                    size: api::RenderSize::Fixed {
                        width: 9,
                        height: 6,
                    },
                    ..Default::default()
                }),
                ..Default::default()
            },
        )?;
        Ok((engine, render_loop))
    }
    fn new(event_loop: &ActiveEventLoop, scene: &[u8]) -> Result<Self> {
        let window = Arc::new(
            event_loop.create_window(
                Window::default_attributes()
                    .with_title("MuTracer surface")
                    .with_inner_size(PhysicalSize::new(96, 64)),
            )?,
        );
        let mut descriptor = wgpu::InstanceDescriptor::new_with_display_handle(Box::new(
            event_loop.owned_display_handle(),
        ));
        if let Ok(api) = std::env::var("MUTRACER_TEST_GRAPHICS_API") {
            descriptor.backends = match api.as_str() {
                "vulkan" => wgpu::Backends::VULKAN,
                "dx12" => wgpu::Backends::DX12,
                _ => anyhow::bail!("MUTRACER_TEST_GRAPHICS_API must be vulkan or dx12"),
            };
        }
        let instance = wgpu::Instance::new(descriptor);
        let surface = instance.create_surface(window.clone())?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))?;
        drop(surface);
        let features = adapter.features() & wgpu::Features::EXPERIMENTAL_RAY_QUERY;
        if std::env::var("MUTRACER_NATIVE_GPU_VALIDATION").as_deref() == Ok("1") {
            ensure!(
                features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
                "Surface adapter lacks hardware ray queries"
            );
        }
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("MuTracer surface example"),
                required_limits: adapter.limits(),
                required_features: features,
                experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
                ..Default::default()
            }))?;
        let backend = api::Backend::Software;
        let (engine, render_loop) = Self::engine(
            &adapter, &device, &queue, &window, &instance, scene, backend,
        )?;
        Ok(Self {
            instance,
            adapter,
            device,
            queue,
            engine,
            render_loop,
            window,
            phase: 0,
            backend,
            original: None,
            hdr_pass: None,
            hdr_calls: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            hdr_report: None,
        })
    }
    fn frame(&mut self, scene: &[u8], results: &mut Vec<serde_json::Value>) -> Result<bool> {
        self.window.pre_present_notify();
        self.render_loop.tick()?;
        let display = self.engine.display();
        let Some(info) = display.surface_info() else {
            anyhow::bail!("surface detached unexpectedly")
        };
        ensure!(
            info.status != SurfaceStatus::Lost && info.status != SurfaceStatus::Error,
            "surface error: {info:?}"
        );
        if self.render_loop.status() != api::RenderLoopStatus::Finished
            || info.status != SurfaceStatus::Presented
        {
            return Ok(false);
        }
        let render = self.render_loop.final_render();
        let active_backend = render.backend()?.0;
        if std::env::var("MUTRACER_NATIVE_GPU_VALIDATION").as_deref() == Ok("1") {
            ensure!(
                active_backend == self.backend,
                "Surface render fell back from {:?} to {:?}",
                self.backend,
                active_backend
            );
        }

        ensure!(display.texture().is_some());
        match self.phase {
            0 => {
                self.original = Some(render.read_pixels(api::PixelKind::Hdr)?);
                display.resize_surface(0, 0)?;
                ensure!(display.surface_info().unwrap().status == SurfaceStatus::Suspended);
                display.present(render)?;
                ensure!(display.surface_info().unwrap().status == SurfaceStatus::Suspended);
                ensure!(
                    render.read_pixels(api::PixelKind::Hdr)? == *self.original.as_ref().unwrap()
                );
                let _ = self.window.request_inner_size(PhysicalSize::new(128, 80));
                display.resize_surface(128, 80)?;
                ensure!(self.render_loop.needs_tick());
                self.phase = 1;
            }
            1 => {
                let size = self.window.inner_size();
                if size != PhysicalSize::new(128, 80) {
                    return Ok(false);
                }
                ensure!(info.size == [128, 80]);
                let image = display.texture().unwrap();
                ensure!([image.width(), image.height()] == info.size);
                ensure!(
                    render.samples() == 2
                        && render.read_pixels(api::PixelKind::Hdr)?
                            == *self.original.as_ref().unwrap()
                );
                let surface = display.detach_surface()?.unwrap();
                ensure!(display.surface_info().is_none());
                display.present(render)?;
                // Exercise a non-sRGB surface attachment when the window supports it.
                let format = [
                    wgpu::TextureFormat::Bgra8Unorm,
                    wgpu::TextureFormat::Rgba8Unorm,
                ]
                .into_iter()
                .find(|f| surface.get_capabilities(&self.adapter).formats.contains(f))
                .or(Some(info.format));
                display.attach_surface(
                    surface,
                    api::SurfaceOptions {
                        format,
                        ..Default::default()
                    },
                )?;
                ensure!(self.render_loop.needs_tick());
                self.phase = 2;
            }
            2 => {
                let exported = display.read_rgba8(render)?.2;
                let mut settings = display.settings();
                settings.hdr_output_enabled = true;
                display.set_settings(settings)?;
                ensure!(display.read_rgba8(render)?.2 == exported);
                let info = display.surface_info().unwrap();
                ensure!(
                    info.hdr_requested && !info.hdr_active && info.hdr_unavailable_reason.is_some()
                );
                let surface = display.detach_surface()?.unwrap();
                display.attach_surface(surface, Default::default())?;
                settings.tone_mapping_exposure = 64.;
                display.set_settings(settings)?;
                let calls = self.hdr_calls.clone();
                self.hdr_pass = Some(display.add_hdr_post_process(move |ctx| {
                    ensure_hdr_format(ctx.input, ctx.output)?;
                    calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    ctx.encoder.copy_texture_to_texture(
                        ctx.input.as_image_copy(),
                        ctx.output.as_image_copy(),
                        ctx.input.size(),
                    );
                    Ok(())
                })?);
                self.phase = 3;
            }
            3 => {
                let mut peak = None;
                if info.hdr_active {
                    ensure!(
                        info.format == wgpu::TextureFormat::Rgba16Float
                            && info.color_space == wgpu::SurfaceColorSpace::ExtendedSrgbLinear
                    );
                    let texture = display.hdr_texture().expect("HDR window image");
                    let value = hdr_peak(&self.device, &self.queue, &texture)?;
                    ensure!(value > 1. && value.is_finite(), "HDR peak was {value}");
                    peak = Some(value);
                    ensure!(self.hdr_calls.load(std::sync::atomic::Ordering::Relaxed) > 0);
                } else {
                    ensure!(info.hdr_unavailable_reason.is_some());
                    ensure!(display.hdr_texture().is_none());
                    ensure!(self.hdr_calls.load(std::sync::atomic::Ordering::Relaxed) == 0);
                }
                self.hdr_report = Some(
                    serde_json::json!({"active":info.hdr_active,"format":format!("{:?}",info.format),"colorSpace":format!("{:?}",info.color_space),"fallback":info.hdr_unavailable_reason,"peak":peak,"headroom":display.display_hdr_info().and_then(|i|i.tone_map_headroom()),"display":format!("{:?}",display.display_hdr_info())}),
                );
                let _ = self.window.request_inner_size(PhysicalSize::new(96, 72));
                display.resize_surface(96, 72)?;
                self.phase = 4;
            }
            4 => {
                if self.window.inner_size() != PhysicalSize::new(96, 72) {
                    return Ok(false);
                }
                if info.hdr_active {
                    let image = display.hdr_texture().unwrap();
                    ensure!([image.width(), image.height()] == [96, 72]);
                }
                ensure!(
                    render.read_pixels(api::PixelKind::Hdr)? == *self.original.as_ref().unwrap()
                );
                let exported = display.read_rgba8(render)?.2;
                let mut settings = display.settings();
                settings.hdr_output_enabled = false;
                display.set_settings(settings)?;
                ensure!(display.hdr_texture().is_none());
                ensure!(self.render_loop.needs_tick());
                ensure!(display.read_rgba8(render)?.2 == exported);
                self.phase = 5;
            }
            _ => {
                ensure!(!info.hdr_requested && !info.hdr_active);
                ensure!(
                    render.read_pixels(api::PixelKind::Hdr)? == *self.original.as_ref().unwrap()
                );
                let rgba = display.read_rgba8(render)?.2;
                ensure!(rgba.iter().any(|v| *v > 0));
                results.push(serde_json::json!({"graphicsApi":format!("{:?}",self.adapter.get_info().backend),"adapter":self.adapter.get_info().name,"backend":format!("{:?}", self.backend),"activeBackend":format!("{:?}",active_backend),"hardwareRayQuery":self.engine.info().hardware_ray_query,"format":format!("{:?}",info.format),"size":info.size,"samples":render.samples(),"suspendRestore":true,"detachReattach":true,"rawUnchanged":true,"hdr":self.hdr_report,"hdrResizeAndToggle":true}));
                // A terminal device-loss notification must release the attachment,
                // while the independent window remains owned by this host.
                self.engine
                    .device_loss_notifier()
                    .notify("surface smoke device loss");
                ensure!(display.surface_info().is_none());
                ensure!(self.render_loop.tick().unwrap_err().status == api::Status::Unavailable);
                self.hdr_pass = None;
                self.engine.dispose();
                if self.backend == api::Backend::Hardware {
                    return Ok(true);
                }
                self.backend = api::Backend::Hardware;
                (self.engine, self.render_loop) = Self::engine(
                    &self.adapter,
                    &self.device,
                    &self.queue,
                    &self.window,
                    &self.instance,
                    scene,
                    self.backend,
                )?;
                self.original = None;
                self.hdr_report = None;
                self.hdr_calls
                    .store(0, std::sync::atomic::Ordering::Relaxed);
                self.phase = 0;
            }
        }
        Ok(false)
    }
}
fn ensure_hdr_format(input: &wgpu::Texture, output: &wgpu::Texture) -> api::Result<()> {
    if input.format() != wgpu::TextureFormat::Rgba16Float || output.format() != input.format() {
        return Err(api::Error {
            status: api::Status::InvalidState,
            message: "HDR callback image format".into(),
        });
    }
    Ok(())
}
fn hdr_peak(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture) -> Result<f64> {
    let stride = (texture.width() * 8).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: stride as u64 * texture.height() as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: None,
            },
        },
        texture.size(),
    );
    queue.submit([encoder.finish()]);
    let (send, recv) = std::sync::mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |r| {
        let _ = send.send(r);
    });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(10)),
    })?;
    recv.recv_timeout(Duration::from_secs(5))??;
    let mapped = buffer.get_mapped_range(..)?;
    let mut peak = 0f64;
    for row in mapped.chunks_exact(stride as usize) {
        for p in row[..texture.width() as usize * 8].chunks_exact(8) {
            for c in 0..3 {
                let n = u16::from_le_bytes(p[c * 2..c * 2 + 2].try_into().unwrap());
                let e = (n >> 10) & 31;
                let f = (n & 1023) as f64;
                let value = if e == 0 {
                    f * 2f64.powi(-24)
                } else if e == 31 {
                    f64::INFINITY
                } else {
                    (1. + f / 1024.) * 2f64.powi(e as i32 - 15)
                };
                peak = peak.max(value);
            }
        }
    }
    Ok(peak)
}
struct App {
    scene: Vec<u8>,
    host: Option<Host>,
    results: Vec<serde_json::Value>,
    failure: Option<String>,
    done: bool,
    started: Instant,
}
impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.host.is_some() {
            return;
        }
        match Host::new(event_loop, &self.scene) {
            Ok(host) => self.host = Some(host),
            Err(e) => {
                self.failure = Some(format!("{e:#}"));
                event_loop.exit();
            }
        }
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        // exit() is deferred; a queued redraw/resize can still arrive after the
        // terminal frame disposed its engine. Preserve the terminal result.
        if self.done || self.failure.is_some() {
            return;
        }
        let Some(host) = &mut self.host else {
            return;
        };
        let result = match event {
            WindowEvent::Resized(size) => host
                .engine
                .display()
                .resize_surface(size.width, size.height)
                .map(|_| false)
                .map_err(Into::into),
            WindowEvent::RedrawRequested => host.frame(&self.scene, &mut self.results),
            WindowEvent::CloseRequested => {
                event_loop.exit();
                Ok(false)
            }
            _ => Ok(false),
        };
        match result {
            Ok(true) => {
                self.done = true;
                event_loop.exit();
            }
            Ok(false) => (),
            Err(e) => {
                self.failure = Some(format!("{e:#}"));
                event_loop.exit();
            }
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self.done || self.failure.is_some() {
            return;
        }
        if self.started.elapsed() > Duration::from_secs(60) {
            self.failure = Some("surface smoke timed out".into());
            event_loop.exit();
            return;
        }
        if let Some(host) = &self.host {
            host.window.request_redraw();
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(
            Instant::now() + Duration::from_millis(16),
        ));
    }
}
fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let scene = std::fs::read(PathBuf::from(args.next().expect("SCENE path")))?;
    let report = PathBuf::from(args.next().expect("REPORT path"));
    let mut app = App {
        scene,
        host: None,
        results: vec![],
        failure: None,
        done: false,
        started: Instant::now(),
    };
    EventLoop::new()?.run_app(&mut app)?;
    let summary = serde_json::json!({"passed":app.done && app.failure.is_none(),"results":app.results,"error":app.failure});
    if let Some(parent) = report.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(report, serde_json::to_vec_pretty(&summary)?)?;
    println!("{summary}");
    ensure!(
        summary["passed"] == true,
        "Surface example failed: {summary}"
    );
    Ok(())
}
