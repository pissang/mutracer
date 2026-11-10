//! Reuses the existing native/Web sky shader and pass order.
use anyhow::Result;
use std::sync::mpsc;
use wgpu::util::DeviceExt;
pub struct Baker {
    device: wgpu::Device,
    queue: wgpu::Queue,
    tables: Vec<wgpu::Texture>,
    pipelines: Vec<wgpu::ComputePipeline>,
    time: Option<f32>,
}
impl Baker {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
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
    pub fn bake(&mut self, time: f32, width: u32, height: u32) -> Result<Vec<f32>> {
        if self.tables[4].width() != width || self.tables[4].height() != height {
            self.tables[4] = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Sky map"),
                size: wgpu::Extent3d {
                    width,
                    height,
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
            });
        }
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
            width as f32,
            height as f32,
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
        let row = (width * 16).div_ceil(256) * 256;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Sky readback"),
            size: u64::from(row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            self.tables[4].as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width,
                height,
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
            .chunks_exact(row as usize)
            .flat_map(|r| {
                r[..width as usize * 16]
                    .chunks_exact(4)
                    .map(|p| f32::from_le_bytes(p.try_into().unwrap()))
            })
            .collect();
        self.time = Some(time);
        Ok(pixels)
    }
}
fn sun_position(hours: f32) -> (f32, f32) {
    let [elevation, azimuth] = mutracer_native::viewer_math::sun_position(hours);
    (elevation, azimuth)
}
