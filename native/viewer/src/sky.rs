//! Background GPU sky baking with the browser's shader, tables and pass order.
use anyhow::{Context, Result};
use eframe::egui;
use std::sync::{Arc, Mutex, mpsc};
use wgpu::util::DeviceExt;

pub struct Sky {
    pub time: f32,
    desired: Arc<Mutex<Option<f32>>>,
    output: mpsc::Receiver<(f32, Result<image::Rgb32FImage>)>,
    requested: Option<f32>,
    working: bool,
    last_image: Option<(f32, Arc<image::Rgb32FImage>)>,
}
impl Sky {
    pub fn new(gpu: Option<&eframe::egui_wgpu::RenderState>) -> Self {
        let desired = Arc::new(Mutex::new(None));
        let (send, output) = mpsc::channel();
        if let Some(gpu) = gpu {
            let (device, queue) = (gpu.device.clone(), gpu.queue.clone());
            let pending = desired.clone();
            std::thread::spawn(move || {
                let mut baker = Baker::new(device, queue);
                loop {
                    let time = pending.lock().unwrap().take();
                    if let Some(time) = time {
                        let result = baker.bake(time);
                        if send.send((time, result)).is_err() {
                            break;
                        }
                    } else if Arc::strong_count(&pending) == 1 {
                        break;
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(15));
                    }
                }
            });
        }
        Self {
            time: 15.,
            desired,
            output,
            requested: None,
            working: false,
            last_image: None,
        }
    }
    pub fn invalidate(&mut self) {
        self.requested = None;
    }
    pub fn poll(
        &mut self,
        ctx: &egui::Context,
        active: bool,
        needs_image: bool,
    ) -> Option<Result<Arc<image::Rgb32FImage>>> {
        if !active {
            return None;
        }
        if self.requested != Some(self.time) {
            *self.desired.lock().unwrap() = Some(self.time);
            self.requested = Some(self.time);
            self.working = true;
        }
        let mut result = None;
        for (time, image) in self.output.try_iter() {
            if time == self.time {
                let image = image.map(Arc::new);
                if let Ok(image) = &image {
                    self.last_image = Some((time, image.clone()));
                }
                result = Some(image);
                self.working = false;
            }
        }
        if needs_image && result.is_none() {
            if let Some((time, image)) = &self.last_image {
                if *time == self.time {
                    result = Some(Ok(image.clone()));
                }
            }
        }
        if self.working {
            ctx.request_repaint_after(std::time::Duration::from_millis(50));
        }
        result
    }
}
struct Baker {
    device: wgpu::Device,
    queue: wgpu::Queue,
    tables: Vec<wgpu::Texture>,
    pipelines: Vec<wgpu::ComputePipeline>,
    time: Option<f32>,
}
impl Baker {
    fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        let texture = |label, size: [u32; 2]| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: size[0],
                    height: size[1],
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba32Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            })
        };
        let tables = vec![
            texture("Sky transmittance", [256, 64]),
            texture("Sky multiple scattering", [32, 1]),
            texture("Sky view", [96, 192]),
            texture("Sky irradiance", [2, 1]),
            texture("Sky map", [1024, 512]),
        ];
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Procedural sky"),
            source: wgpu::ShaderSource::Wgsl(include_str!("sky.wgsl").into()),
        });
        let pipelines = [
            ("transmittance", vec![]),
            ("multiple", vec![1, 2]),
            ("skyView", vec![1, 2, 4]),
            ("irradiance", vec![1, 3]),
            ("map", vec![3, 4]),
        ]
        .map(|(name, inputs)| {
            let mut entries = vec![wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }];
            for binding in inputs {
                entries.push(wgpu::BindGroupLayoutEntry {
                    binding,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                });
            }
            entries.push(wgpu::BindGroupLayoutEntry {
                binding: 5,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba32Float,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            });
            let group = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(name),
                entries: &entries,
            });
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(name),
                bind_group_layouts: &[Some(&group)],
                ..Default::default()
            });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&layout),
                module: &shader,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        })
        .into();
        Self {
            device,
            queue,
            tables,
            pipelines,
            time: None,
        }
    }
    fn bake(&mut self, time: f32) -> Result<image::Rgb32FImage> {
        let (e, a) = sun_position(time);
        let (e, a) = (e.to_radians(), a.to_radians());
        let mut parameters = [
            e.cos(),
            e.sin(),
            0.,
            a,
            e.cos() * a.cos(),
            e.sin(),
            e.cos() * a.sin(),
            0.4f32.to_radians(),
            1024.,
            512.,
            0.,
            0.,
            1.,
            1.,
            1.,
            1.,
            0.,
            0.,
            0.,
            0.,
        ];
        let buffer = |data: &[f32]| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Sky parameters"),
                    contents: &data
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                    usage: wgpu::BufferUsages::UNIFORM,
                })
        };
        let sky = buffer(&parameters);
        parameters[11] = 1.;
        let ground = buffer(&parameters);
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let draw = |encoder: &mut wgpu::CommandEncoder, index: usize, ground_pass: bool| {
            let inputs: &[usize] = match index {
                0 => &[],
                1 => &[1, 2],
                2 => &[1, 2, 4],
                3 => &[1, 3],
                _ => &[3, 4],
            };
            let views: Vec<_> = inputs
                .iter()
                .map(|binding| {
                    self.tables[match binding {
                        1 => 0,
                        2 if index == 1 => 0,
                        2 => 1,
                        3 => 2,
                        _ => 3,
                    }]
                    .create_view(&Default::default())
                })
                .collect();
            let target = self.tables[index].create_view(&Default::default());
            let mut entries = vec![wgpu::BindGroupEntry {
                binding: 0,
                resource: if ground_pass {
                    ground.as_entire_binding()
                } else {
                    sky.as_entire_binding()
                },
            }];
            for (binding, view) in inputs.iter().zip(&views) {
                entries.push(wgpu::BindGroupEntry {
                    binding: *binding as u32,
                    resource: wgpu::BindingResource::TextureView(view),
                });
            }
            entries.push(wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::TextureView(&target),
            });
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.pipelines[index].get_bind_group_layout(0),
                entries: &entries,
            });
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipelines[index]);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(
                self.tables[index].width().div_ceil(8),
                self.tables[index].height().div_ceil(8),
                1,
            );
        };
        if self.time.is_none() {
            draw(&mut encoder, 0, false);
        }
        if self.time != Some(time) {
            draw(&mut encoder, 1, false);
            draw(&mut encoder, 2, false);
            draw(&mut encoder, 3, false);
            draw(&mut encoder, 2, true);
        }
        draw(&mut encoder, 4, true);
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Sky readback"),
            size: 1024 * 512 * 16,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            self.tables[4].as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(1024 * 16),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: 1024,
                height: 512,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        let (send, receive) = mpsc::channel();
        readback.map_async(wgpu::MapMode::Read, .., move |r| {
            let _ = send.send(r);
        });
        self.device.poll(wgpu::PollType::wait_indefinitely())?;
        receive.recv_timeout(std::time::Duration::from_secs(30))??;
        let bytes = readback.get_mapped_range(..)?;
        let pixels = bytes
            .chunks_exact(16)
            .flat_map(|p| {
                (0..3).map(move |c| f32::from_le_bytes(p[c * 4..c * 4 + 4].try_into().unwrap()))
            })
            .collect();
        self.time = Some(time);
        image::Rgb32FImage::from_raw(1024, 512, pixels).context("Invalid sky size")
    }
}
fn sun_position(hours: f32) -> (f32, f32) {
    let [elevation, azimuth] = mutracer_native::viewer_math::sun_position(hours);
    (elevation, azimuth)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn returning_from_scene_lighting_restores_the_cached_sky() {
        let ctx = egui::Context::default();
        let mut sky = Sky::new(None);
        let image = Arc::new(image::Rgb32FImage::from_pixel(
            1,
            1,
            image::Rgb([1., 2., 3.]),
        ));
        sky.last_image = Some((15., image.clone()));
        sky.requested = Some(15.);
        assert!(sky.poll(&ctx, false, true).is_none());
        let restored = sky.poll(&ctx, true, true).unwrap().unwrap();
        assert!(Arc::ptr_eq(&restored, &image));
        assert!(sky.poll(&ctx, true, false).is_none());
        sky.time = 12.;
        assert!(sky.poll(&ctx, true, true).is_none());
    }
    #[test]
    fn shared_sky_shader_and_sun_path() {
        let module = naga::front::wgsl::parse_str(include_str!("sky.wgsl")).unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
        let (e, a) = sun_position(15.);
        assert!((e - 32.79775).abs() < 0.001);
        assert_eq!(a, 50.);
        assert!(sun_position(5.5).0 < 0.);
        assert!(sun_position(12.).0 > 49.9);
    }
    #[test]
    #[ignore = "requires a real GPU"]
    fn gpu_sky_times_are_finite_and_keep_cached_passes_equivalent() {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&Default::default())).unwrap();
        let (device, queue) =
            pollster::block_on(adapter.request_device(&Default::default())).unwrap();
        let mut baker = Baker::new(device.clone(), queue.clone());
        let noon = baker.bake(12.).unwrap();
        let afternoon = baker.bake(15.).unwrap();
        assert!(
            afternoon
                .pixels()
                .all(|p| p.0.iter().all(|v| v.is_finite() && *v >= 0.))
        );
        assert_ne!(noon.as_raw(), afternoon.as_raw());
        let mut fresh = Baker::new(device, queue);
        assert_eq!(afternoon.as_raw(), fresh.bake(15.).unwrap().as_raw());
    }

    #[test]
    #[ignore = "requires a real GPU and OIDN"]
    fn gpu_environment_pole_render_stays_bounded_through_oidn() -> Result<()> {
        use mutracer_native::api;
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&Default::default()))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&Default::default()))?;
        let mut environment = crate::scene::Environment::default();
        environment.image = Some(Arc::new(Baker::new(device, queue).bake(15.)?));
        let model = crate::scene::Model::spheres()?;
        let size = [827, 767];
        // This camera/seed sends sample 47 at pixel (644, 463), top row first,
        // almost straight down after reflecting off the car-paint sphere.
        // The old south-pole PDF produced ~1e21 HDR and a large OIDN blotch.
        let camera = api::Camera {
            fov: 35.,
            near_clip: 0.00025400444,
            far_clip: 2540.0442,
            world_matrix: [
                0.9927212,
                0.,
                0.120436475,
                0.,
                0.01769299,
                0.9891504,
                -0.14583792,
                0.,
                -0.11912978,
                0.14690724,
                0.98195034,
                0.,
                -0.41777027,
                1.0324888,
                4.2373843,
                1.,
            ],
            ..Default::default()
        };
        let descriptor = model.descriptor(&camera.to_bytes(), size, &environment);
        for backend in [api::Backend::Software, api::Backend::Hardware] {
            let engine = api::Engine::new(api::EngineOptions { backend })?;
            engine.display().set_size(size[0], size[1])?;
            engine.set_scene(&descriptor)?;
            engine.update()?;
            let render = api::Render::new(
                &engine,
                api::RenderSettings {
                    max_samples: 64,
                    bounces: 6,
                    bevel: false,
                    dispersion_wavelengths: 1,
                    direct_light_candidates: 2,
                    seed: 12345,
                    size: api::RenderSize::Fixed {
                        width: size[0],
                        height: size[1],
                    },
                    ..Default::default()
                },
            )?;
            render.set_denoiser(Some(api::DenoiserOptions {
                backend: api::DENOISE_OIDN_WEBGPU,
                ..Default::default()
            }))?;
            render.converge(api::ConvergeOptions::new(64))?;
            for kind in [api::PixelKind::Hdr, api::PixelKind::Denoised] {
                let image = render.read_pixels(kind)?;
                if let Some(out) = std::env::var_os("MUTRACER_TEST_CAPTURE") {
                    let out = std::path::PathBuf::from(out);
                    std::fs::create_dir_all(&out)?;
                    std::fs::write(
                        out.join(format!("{backend:?}-{kind:?}.f32")),
                        image
                            .data
                            .iter()
                            .flat_map(|v| v.to_le_bytes())
                            .collect::<Vec<_>>(),
                    )?;
                    if kind == api::PixelKind::Denoised {
                        let (w, h, pixels) = engine.display().read_rgba8(&render)?;
                        image::save_buffer(
                            out.join(format!("{backend:?}-denoised.png")),
                            &pixels,
                            w,
                            h,
                            image::ColorType::Rgba8,
                        )?;
                    }
                }
                assert!(
                    image
                        .data
                        .iter()
                        .all(|v| v.is_finite() && *v >= 0. && *v < 1e6),
                    "Unbounded {kind:?} on {backend:?}"
                );
                let pixel = &image.data[(463 * size[0] as usize + 644) * 4..][..3];
                assert!(pixel.iter().all(|v| *v < 1.), "Pole firefly: {pixel:?}");
            }
        }
        Ok(())
    }
}
