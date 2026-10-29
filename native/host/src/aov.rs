//! Independent primary-surface passes; all allocations belong to one render.
use crate::*;
use wgpu::util::DeviceExt;

pub(crate) type PipelineCache = Arc<Mutex<Option<Arc<Pipelines>>>>;
pub(crate) struct Pipelines {
    layout: wgpu::BindGroupLayout,
    trace: wgpu::ComputePipeline,
    center: wgpu::ComputePipeline,
}
pub(crate) struct Query {
    pipelines: PipelineCache,
    gpu: GpuDevice,
    shader: wgpu::ShaderModule,
    layouts: Vec<wgpu::BindGroupLayout>,
    groups: Vec<wgpu::BindGroup>,
    retained: scene::PreparedState,
    size: [u32; 2],
}
impl Query {
    pub(crate) fn snapshot(scene: &GpuScene, target: &Target) -> Result<Self> {
        Ok(Self {
            pipelines: target.aov_pipelines.clone(),
            gpu: scene.gpu.clone(),
            shader: target.aov_shader.clone(),
            layouts: (0..3)
                .map(|i| {
                    target
                        .pipeline
                        .as_ref()
                        .unwrap_or(&scene.pipeline)
                        .get_bind_group_layout(i)
                })
                .collect(),
            groups: vec![
                scene.groups[0].clone(),
                target
                    .caustics
                    .as_ref()
                    .map(|c| c.textures.clone())
                    .unwrap_or_else(|| scene.groups[1].clone()),
                target.groups[0].clone(),
            ],
            retained: scene
                .retained
                .clone()
                .ok_or("AOV requires a retained scene")?,
            size: [target.width, target.height],
        })
    }
    pub(crate) fn metadata(&self, camera: &[u8]) -> Result<Vec<u32>> {
        self.retained.aov_metadata(camera, self.size)
    }
}

pub(crate) struct Output {
    pub generation: u64,
    pub samples: u32,
    pub mask: u32,
    size: [u32; 2],
    gpu: GpuDevice,
    accumulated: wgpu::Buffer,
    center: wgpu::Buffer,
    previous_center: wgpu::Buffer,
    current_words: Vec<u32>,
    scene: wgpu::Buffer,
    pipelines: Arc<Pipelines>,
    resolve: std::sync::OnceLock<wgpu::ComputePipeline>,
    visualizations: HashMap<wgpu::TextureFormat, (wgpu::Texture, wgpu::ComputePipeline)>,
}
impl Output {
    pub(crate) fn new(
        query: &Query,
        generation: u64,
        words: &[u32],
        previous: Option<&Self>,
    ) -> Result<Self> {
        let device = &query.gpu.device;
        query.gpu.loss.check()?;
        let pixels = u64::from(query.size[0]) * u64::from(query.size[1]);
        if pixels * 64 > u64::from(device.limits().max_storage_buffer_binding_size) {
            return Err(fail(
                Status::InvalidArgument,
                "AOV accumulation exceeds the storage binding size limit",
            ));
        }
        let mut cached = query.pipelines.lock().unwrap_or_else(|e| e.into_inner());
        let pipelines = if let Some(pipelines) = cached.as_ref() {
            pipelines.clone()
        } else {
            let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
            // Driver pipeline failures are internal errors, outside validation's
            // scope. Return them to the render without an uncaptured-error panic.
            let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("AOV output"),
                entries: &[
                    (5, wgpu::BufferBindingType::Storage { read_only: false }),
                    (6, wgpu::BufferBindingType::Storage { read_only: false }),
                    (7, wgpu::BufferBindingType::Storage { read_only: true }),
                    (8, wgpu::BufferBindingType::Uniform),
                    (9, wgpu::BufferBindingType::Storage { read_only: true }),
                ]
                .map(|(binding, ty)| wgpu::BindGroupLayoutEntry {
                    binding,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }),
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("AOV layout"),
                bind_group_layouts: &[
                    Some(&query.layouts[0]),
                    Some(&query.layouts[1]),
                    Some(&query.layouts[2]),
                    Some(&layout),
                ],
                ..Default::default()
            });
            let pipeline = |entry| {
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(entry),
                    layout: Some(&pipeline_layout),
                    module: &query.shader,
                    entry_point: Some(entry),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &[("DEPTH_QUERY_MODE", 1.)],
                        ..Default::default()
                    },
                    cache: query.gpu.pipeline_cache.as_ref(),
                })
            };
            let trace = pipeline("aovTrace");
            let center_trace = pipeline("aovTraceCenter");
            let internal_error = pollster::block_on(internal.pop());
            let validation_error = pollster::block_on(validation.pop());
            if let Some(error) = internal_error {
                return Err(format!("AOV pipeline creation failed: {error}").into());
            }
            if let Some(error) = validation_error {
                return Err(error.to_string().into());
            }
            let pipelines = Arc::new(Pipelines {
                layout,
                trace,
                center: center_trace,
            });
            *cached = Some(pipelines.clone());
            pipelines
        };
        drop(cached);
        let buffer = |label, size| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let current_words = words.to_vec();
        let words = reproject_metadata(
            words,
            previous
                .filter(|p| p.size == query.size)
                .map(|p| p.current_words.as_slice()),
        );
        let previous_center = buffer("Previous AOV center", pixels * 32);
        if let Some(previous) = previous.filter(|p| p.size == query.size) {
            let mut encoder = device.create_command_encoder(&Default::default());
            encoder.copy_buffer_to_buffer(&previous.center, 0, &previous_center, 0, pixels * 32);
            query.gpu.queue.submit([encoder.finish()]);
        }
        let bytes: Vec<_> = bytemuck::cast_slice(&words).to_vec();
        let scene = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("AOV identities/history"),
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        Ok(Self {
            generation,
            visualizations: HashMap::new(),
            previous_center,
            current_words,
            samples: 0,
            mask: 0,
            size: query.size,
            gpu: query.gpu.clone(),
            accumulated: buffer("AOV accumulation", pixels * 64),
            center: buffer("AOV center", pixels * 32),
            scene,
            pipelines,
            resolve: Default::default(),
        })
    }
    pub(crate) fn render(&mut self, query: &Query, samples: u32, mask: u32) -> Result<()> {
        self.gpu.loss.check()?;
        let device = &self.gpu.device;
        let mut encoder = device.create_command_encoder(&Default::default());
        let run =
            |encoder: &mut wgpu::CommandEncoder, pipeline: &wgpu::ComputePipeline, sample: u32| {
                let parameters: Vec<_> =
                    bytemuck::cast_slice(&[self.size[0], self.size[1], sample, mask]).to_vec();
                let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("AOV parameters"),
                    contents: &parameters,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let outputs = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.pipelines.layout,
                    entries: &[
                        (5, &self.accumulated),
                        (6, &self.center),
                        (7, &self.scene),
                        (8, &parameters),
                        (9, &self.previous_center),
                    ]
                    .map(|(binding, buffer)| wgpu::BindGroupEntry {
                        binding,
                        resource: buffer.as_entire_binding(),
                    }),
                });
                {
                    let mut pass = encoder.begin_compute_pass(&Default::default());
                    pass.set_pipeline(pipeline);
                    for (i, group) in query.groups.iter().enumerate() {
                        pass.set_bind_group(i as u32, group, &[]);
                    }
                    pass.set_bind_group(3, &outputs, &[]);
                    pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
                }
            };
        if self.samples == 0 {
            run(&mut encoder, &self.pipelines.center, 0);
        }
        // ID and motion are center-ray outputs; no jittered accumulation pass.
        if mask & 31 == 0 {
            self.samples = samples.min(1);
        } else {
            while self.samples < samples {
                run(&mut encoder, &self.pipelines.trace, self.samples);
                self.samples += 1;
            }
        }
        self.mask = mask;
        self.gpu.queue.submit([encoder.finish()]);
        Ok(())
    }
    pub(crate) fn settle_motion(&mut self, query: &Query) -> Result<()> {
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(
            &self.center,
            0,
            &self.previous_center,
            0,
            self.size[0] as u64 * self.size[1] as u64 * 32,
        );
        let words = reproject_metadata(&self.current_words, Some(&self.current_words));
        let bytes: Vec<_> = bytemuck::cast_slice(&words).to_vec();
        self.gpu.queue.write_buffer(&self.scene, 0, &bytes);
        self.gpu.queue.submit([encoder.finish()]);
        // Motion is written by the center trace, rather than resolved from
        // metadata at display time. Refresh that record against the stationary
        // history without touching beauty or jittered surface accumulation.
        self.samples = 0;
        self.render(query, 1, self.mask)
    }
    pub(crate) fn snapshot(&self, mask: u32) -> Result<Vec<api::GpuAov>> {
        let device = &self.gpu.device;
        let pipeline = self.resolve.get_or_init(|| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("AOV resolve"),
                layout: None,
                module: &device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("AOV resolve"),
                    source: wgpu::ShaderSource::Wgsl(include_str!("aov-resolve.wgsl").into()),
                }),
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            })
        });
        let mut result = Vec::new();
        for index in 0..7 {
            if mask & (1 << index) == 0 {
                continue;
            }
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Custom AOV input"),
                size: self.size[0] as u64 * self.size[1] as u64 * 16,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let bytes: Vec<_> =
                bytemuck::cast_slice(&[self.size[0], self.size[1], self.samples, index]).to_vec();
            let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[&self.accumulated, &self.center, &buffer, &parameters]
                    .iter()
                    .enumerate()
                    .map(|(binding, buffer)| wgpu::BindGroupEntry {
                        binding: binding as u32,
                        resource: buffer.as_entire_binding(),
                    })
                    .collect::<Vec<_>>(),
            });
            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
            }
            self.gpu.queue.submit([encoder.finish()]);
            result.push(api::GpuAov {
                kind: api::PixelKind::from_aov_index(index),
                buffer,
            });
        }
        Ok(result)
    }
    pub(crate) fn visualize(
        &mut self,
        kind: u32,
        options: &api::AovDisplayOptions,
        hdr: bool,
    ) -> Result<wgpu::Texture> {
        if self.samples == 0 {
            return Err("AOV output is not ready".into());
        }
        let format = if hdr {
            wgpu::TextureFormat::Rgba16Float
        } else {
            wgpu::TextureFormat::Rgba8Unorm
        };
        let device = &self.gpu.device;
        let (texture, pipeline) = self.visualizations.entry(format).or_insert_with(|| {
            let source = if hdr {
                include_str!("aov-display-hdr.wgsl")
            } else {
                include_str!("aov-display.wgsl")
            };
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("AOV visualization"),
                layout: None,
                module: &device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("AOV visualization"),
                    source: wgpu::ShaderSource::Wgsl(source.into()),
                }),
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
            (crate::display::image(device, self.size, format), pipeline)
        });
        let words = [
            self.size[0],
            self.size[1],
            self.samples,
            kind,
            options.depth_range[0].to_bits(),
            options.depth_range[1].to_bits(),
            options.position_scale.to_bits(),
            options.motion_scale.to_bits(),
            options.id_component as u32,
            u32::from(hdr),
            0,
            0,
        ];
        let bytes: Vec<_> = bytemuck::cast_slice(&words).to_vec();
        let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("AOV display parameters"),
            contents: &bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let view = texture.create_view(&Default::default());
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.accumulated.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.center.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: parameters.as_entire_binding(),
                },
            ],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        }
        self.gpu.queue.submit([encoder.finish()]);
        Ok(texture.clone())
    }
    pub(crate) fn read(&self, kind: u32) -> Result<api::Image> {
        if !(4..=10).contains(&kind) {
            return Err("Unknown AOV kind".into());
        }
        // Use the same GPU resolve as immutable filter snapshots. Repeating the
        // normalization on the CPU can differ from the device reciprocal by an
        // ULP, even for two reads of the same accumulation on one adapter.
        let snapshot = self.snapshot(1 << (kind - 4))?.pop().unwrap();
        let bytes = self
            .gpu
            .queue
            .read_buffer(&self.gpu.device, snapshot.buffer.slice(..))?;
        let [width, height] = self.size;
        let mut words = Vec::with_capacity((width * height * 4) as usize);
        let row = width as usize * 16;
        // GPU accumulation/snapshots are bottom-first; public images are top-first.
        for y in (0..height as usize).rev() {
            words.extend(bytemuck::pod_collect_to_vec::<u8, u32>(
                &bytes[y * row..(y + 1) * row],
            ));
        }
        Ok(api::Image {
            width,
            height,
            data: if kind == 9 {
                Vec::new()
            } else {
                words.iter().map(|v| f32::from_bits(*v)).collect()
            },
            id_data: (kind == 9).then_some(words),
        })
    }
}

pub(crate) fn read_denoise_aov(gpu: &GpuDevice, aov: &api::GpuAov) -> Result<api::DenoiseAov> {
    let bytes = gpu.queue.read_buffer(&gpu.device, aov.buffer.slice(..))?;
    let mut output = api::DenoiseAov {
        kind: aov.kind,
        data: Vec::new(),
        id_data: None,
    };
    if aov.kind == api::PixelKind::Id {
        output.id_data = Some(bytemuck::pod_collect_to_vec::<u8, u32>(&bytes));
    } else {
        output.data = bytemuck::pod_collect_to_vec::<u8, f32>(&bytes);
    }
    Ok(output)
}

pub(crate) fn reproject_metadata(current: &[u32], previous: Option<&[u32]>) -> Vec<u32> {
    let mut words = current.to_vec();
    words[..16].fill(0);
    if let Some(old) = previous.filter(|p| p.len() >= 52 && p[18] == words[18]) {
        words[..16].copy_from_slice(&old[20..36]);
        words[44..52].copy_from_slice(&old[36..44]);
        let mut records = HashMap::new();
        for offset in (52..old[16] as usize).step_by(24) {
            records.insert((old[offset], old[offset + 1]), offset);
        }
        for offset in (52..words[16] as usize).step_by(24) {
            if let Some(&prior) = records.get(&(words[offset], words[offset + 1])) {
                if words[offset + 20..offset + 23] == old[prior + 20..prior + 23] {
                    let matrix = glam::Mat4::from_cols_array(&std::array::from_fn(|i| {
                        f32::from_bits(words[offset + 4 + i])
                    }));
                    let before = glam::Mat4::from_cols_array(&std::array::from_fn(|i| {
                        f32::from_bits(old[prior + 4 + i])
                    }));
                    if matrix.determinant().abs() > 1e-20 {
                        for (i, value) in (before * matrix.inverse())
                            .to_cols_array()
                            .iter()
                            .enumerate()
                        {
                            words[offset + 4 + i] = value.to_bits();
                        }
                        words[offset + 2] = 1;
                    }
                }
            }
        }
    }
    words
}
