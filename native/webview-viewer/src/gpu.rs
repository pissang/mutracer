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
        let default_adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            }))?;
        let adapter = if let Ok(name) = std::env::var("MUTRACER_VIEWER_GPU") {
            pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()))
                .into_iter()
                .find(|a| a.get_info().name == name && a.is_surface_supported(&surface))
                .ok_or_else(|| anyhow::anyhow!("Requested GPU unavailable: {name}"))?
        } else {
            default_adapter
        };
        // OIDN selects its inference path from the enabled device features.
        // Request the supported native fast paths as well as ray queries.
        let features = adapter.features()
            & (wgpu::Features::EXPERIMENTAL_RAY_QUERY
                | wgpu::Features::SHADER_F16
                | wgpu::Features::SUBGROUP
                | wgpu::Features::TIMESTAMP_QUERY
                | wgpu::Features::EXPERIMENTAL_COOPERATIVE_MATRIX);
        let textures = wgpu::Features::TEXTURE_BINDING_ARRAY
            | wgpu::Features::SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING;
        let features = features
            | if adapter.features().contains(textures) {
                textures
            } else {
                wgpu::Features::empty()
            };
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("MuTracer WebView"),
                required_limits: adapter.limits(),
                required_features: features,
                experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
                ..Default::default()
            }))?;
        Self::from_parts(window, instance, adapter, device, queue, surface)
    }
    #[cfg(all(target_os = "windows", feature = "dlss-rr"))]
    pub fn from_device(
        window: &Arc<Window>,
        parts: (wgpu::Instance, wgpu::Adapter, wgpu::Device, wgpu::Queue),
    ) -> Result<Self> {
        let (instance, adapter, device, queue) = parts;
        let surface = instance.create_surface(window.clone())?;
        Self::from_parts(window, instance, adapter, device, queue, surface)
    }
    fn from_parts(
        window: &Arc<Window>,
        instance: wgpu::Instance,
        adapter: wgpu::Adapter,
        device: wgpu::Device,
        queue: wgpu::Queue,
        surface: wgpu::Surface<'static>,
    ) -> Result<Self> {
        let caps = surface.get_capabilities(&adapter);
        ensure!(
            caps.usages.contains(wgpu::TextureUsages::COPY_DST),
            "Native viewport surface requires COPY_DST"
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
    pub fn hdr_supported(&self) -> bool {
        self.surface
            .get_capabilities(&self.adapter)
            .color_spaces(wgpu::TextureFormat::Rgba16Float)
            .contains(wgpu::SurfaceColorSpaces::EXTENDED_SRGB_LINEAR)
    }
    pub fn set_hdr(&mut self, requested: bool) -> bool {
        let active = requested && self.hdr_supported();
        let format = if active {
            wgpu::TextureFormat::Rgba16Float
        } else {
            wgpu::TextureFormat::Bgra8Unorm
        };
        let format = if !active
            && !self
                .surface
                .get_capabilities(&self.adapter)
                .formats
                .contains(&format)
        {
            wgpu::TextureFormat::Rgba8Unorm
        } else {
            format
        };
        if format != self.config.format {
            self.config.format = format;
            self.config.color_space = if active {
                wgpu::SurfaceColorSpace::ExtendedSrgbLinear
            } else {
                wgpu::SurfaceColorSpace::Auto
            };
            self.surface.configure(&self.device, &self.config);
            self.blitter = wgpu::util::TextureBlitter::new(&self.device, format);
            self.intermediate = None;
        }
        active
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
    ) -> Result<bool> {
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Lost => {
                self.surface = self.instance.create_surface(window.clone())?;
                self.surface.configure(&self.device, &self.config);
                return Ok(false);
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return Ok(false);
            }
            wgpu::CurrentSurfaceTexture::Validation => anyhow::bail!("Surface validation failed"),
            _ => return Ok(false),
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
        Ok(true)
    }
    pub fn engine(&self) -> api::Engine {
        let engine = api::Engine::on_device(
            &self.adapter,
            &self.device,
            &self.queue,
            api::EngineOptions {
                backend: if std::env::var("MUTRACER_VIEWER_BACKEND").as_deref() == Ok("software") {
                    api::Backend::Software
                } else {
                    api::Backend::Hardware
                },
            },
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
