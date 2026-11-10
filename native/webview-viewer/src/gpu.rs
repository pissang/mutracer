use anyhow::{Result, ensure};
use mutracer_native::api;
use std::sync::Arc;
use winit::{event_loop::ActiveEventLoop, window::Window};

pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
    blitter: wgpu::util::TextureBlitter,
    intermediate: Option<wgpu::Texture>,
    pub presentations: u64,
}
impl Gpu {
    pub fn new(event_loop: &ActiveEventLoop, window: &Arc<Window>) -> Result<Self> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_with_display_handle(
            Box::new(event_loop.owned_display_handle()),
        ));
        let surface = instance.create_surface(window.clone())?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))?;
        let features = adapter.features() & wgpu::Features::EXPERIMENTAL_RAY_QUERY;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("MuTracer WebView"),
                required_limits: adapter.limits(),
                required_features: features,
                experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
                ..Default::default()
            }))?;
        let caps = surface.get_capabilities(&adapter);
        ensure!(
            caps.usages.contains(wgpu::TextureUsages::COPY_DST),
            "Prototype surface requires COPY_DST"
        );
        // Display already encodes SDR. An unorm surface avoids another sRGB transfer.
        let format = [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|f| caps.formats.contains(f))
        .ok_or_else(|| anyhow::anyhow!("No unorm surface format"))?;
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&device, &config);
        let blitter = wgpu::util::TextureBlitter::new(&device, format);
        Ok(Self {
            instance,
            adapter,
            device,
            queue,
            surface,
            config,
            blitter,
            intermediate: None,
            presentations: 0,
        })
    }
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }
    pub fn present(
        &mut self,
        window: &Arc<Window>,
        image: Option<wgpu::Texture>,
        rect: [u32; 4],
    ) -> Result<()> {
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Lost => {
                self.surface = self.instance.create_surface(window.clone())?;
                self.surface.configure(&self.device, &self.config);
                return Ok(());
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return Ok(());
            }
            wgpu::CurrentSurfaceTexture::Validation => anyhow::bail!("Surface validation failed"),
            _ => return Ok(()),
        };
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let view = frame.texture.create_view(&Default::default());
        {
            let _clear = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.06,
                            g: 0.065,
                            b: 0.075,
                            a: 1.,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
        }
        if let Some(image) = image {
            let [x, y, w, h] = rect;
            let w = w.min(self.config.width.saturating_sub(x));
            let h = h.min(self.config.height.saturating_sub(y));
            if w > 0 && h > 0 {
                if self
                    .intermediate
                    .as_ref()
                    .is_none_or(|texture| texture.width() != w || texture.height() != h)
                {
                    self.intermediate =
                        Some(self.device.create_texture(&wgpu::TextureDescriptor {
                            label: Some("Viewport presentation"),
                            size: wgpu::Extent3d {
                                width: w,
                                height: h,
                                depth_or_array_layers: 1,
                            },
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: wgpu::TextureDimension::D2,
                            format: self.config.format,
                            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                                | wgpu::TextureUsages::COPY_SRC,
                            view_formats: &[],
                        }));
                }
                let target = self.intermediate.as_ref().unwrap();
                self.blitter.copy(
                    &self.device,
                    &mut encoder,
                    &image.create_view(&Default::default()),
                    &target.create_view(&Default::default()),
                );
                encoder.copy_texture_to_texture(
                    target.as_image_copy(),
                    wgpu::TexelCopyTextureInfo {
                        origin: wgpu::Origin3d { x, y, z: 0 },
                        ..frame.texture.as_image_copy()
                    },
                    wgpu::Extent3d {
                        width: w,
                        height: h,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }
        self.queue.submit([encoder.finish()]);
        window.pre_present_notify();
        self.queue.present(frame);
        self.presentations += 1;
        Ok(())
    }
    pub fn engine(&self) -> api::Engine {
        let engine = api::Engine::on_device(
            &self.adapter,
            &self.device,
            &self.queue,
            api::EngineOptions::default(),
            None,
        );
        let notify = engine.device_loss_notifier();
        self.device
            .set_device_lost_callback(move |reason, message| {
                notify.notify(format!("{reason:?}: {message}"))
            });
        engine
    }
}
