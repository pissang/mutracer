use super::*;
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    pub flags: u32,
    pub workgroup_size: u32,
    pub light_width: u32,
    pub light_height: u32,
    pub distribution_width: u32,
    pub distribution_height: u32,
    pub light_photons: u32,
    pub photon_map_photons: u32,
    pub initial_radius: f32,
    pub per_caster_radius: f32,
    pub light_shader: String,
    pub photon_shader: String,
    pub grid_shader: String,
    pub accumulate_shader: String,
    pub compose_shader: String,
}
pub(crate) struct Packet {
    pub metadata: Metadata,
    pub distribution: Vec<u8>,
    pub lighting: Vec<u8>,
    pub uniform: Vec<u8>,
}
struct Emission {
    pipeline: wgpu::ComputePipeline,
    group: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    count: u32,
}
struct Light {
    emit: Emission,
    splats: wgpu::Buffer,
    accumulation: wgpu::Buffer,
    resolve: wgpu::ComputePipeline,
    resolve_group: wgpu::BindGroup,
    compose: wgpu::ComputePipeline,
    compose_group: wgpu::BindGroup,
}
struct Photons {
    emit: Emission,
    buckets: u32,
    grid: wgpu::Buffer,
    uniform: wgpu::Buffer,
    pipelines: Vec<wgpu::ComputePipeline>,
    group: wgpu::BindGroup,
    _data: wgpu::Texture,
    _headers: wgpu::Texture,
}
#[derive(Clone, Copy)]
enum RadiusScaling {
    None,
    Ppm,
    ConstantCount,
}
impl RadiusScaling {
    // Internal experiment switch. Public settings retain the unscaled schedule.
    fn probe() -> Self {
        match std::env::var("MUTRACER_PHOTON_RADIUS_MODE").as_deref() {
            Ok("ppm") => Self::Ppm,
            Ok("constant-count") => Self::ConstantCount,
            _ => Self::None,
        }
    }
    fn radius(self, initial: f32, batch: u32, photons: u32) -> f32 {
        let radius = f64::from(initial) * f64::from(batch.max(1)).powf(-1. / 6.);
        let exponent = match self {
            Self::None => return radius as f32,
            Self::Ppm => -1. / 6.,
            Self::ConstantCount => -1. / 2.,
        };
        (radius * (f64::from(photons.max(1)) / 262144.).powf(exponent)) as f32
    }
}
pub(crate) struct State {
    pub textures: wgpu::BindGroup,
    emission_textures: wgpu::BindGroup,
    pub pt_color: Option<wgpu::Buffer>,
    light: Option<Light>,
    photons: Option<Photons>,
    template: Vec<u8>,
    initial_radius: f32,
    radius_scaling: RadiusScaling,
    experiments: u32,
    size: [u32; 2],
    pixels: u32,
    _distribution: wgpu::Texture,
    _lighting: wgpu::Texture,
}
fn buffer(device: &wgpu::Device, size: u64, uniform: bool) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Caustic data"),
        size,
        usage: if uniform {
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST
        } else {
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST
        },
        mapped_at_creation: false,
    })
}
fn texture(
    gpu: &GpuDevice,
    width: u32,
    height: u32,
    data: Option<&[u8]>,
    storage: bool,
    format: wgpu::TextureFormat,
) -> wgpu::Texture {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Caustic texture"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | if storage {
                wgpu::TextureUsages::STORAGE_BINDING
            } else {
                wgpu::TextureUsages::empty()
            },
        view_formats: &[],
    });
    if let Some(bytes) = data {
        gpu.queue.write_texture(
            texture.as_image_copy(),
            bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(
                    width
                        * if format == wgpu::TextureFormat::R32Uint {
                            4
                        } else {
                            16
                        },
                ),
                rows_per_image: Some(height),
            },
            texture.size(),
        );
    }
    texture
}
fn pipeline(
    device: &wgpu::Device,
    source: &str,
    entry: &str,
    layout: Option<&wgpu::PipelineLayout>,
) -> wgpu::ComputePipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Shared caustic WGSL"),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("Caustic pass"),
        layout,
        module: &module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}
fn buffer_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    buffers: &[&wgpu::Buffer],
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Caustic buffers"),
        layout,
        entries: &buffers
            .iter()
            .enumerate()
            .map(|(i, b)| wgpu::BindGroupEntry {
                binding: i as u32,
                resource: b.as_entire_binding(),
            })
            .collect::<Vec<_>>(),
    })
}
fn emitter(
    gpu: &GpuDevice,
    source: &str,
    layouts: &[wgpu::BindGroupLayout],
    distribution: &wgpu::Texture,
    storage: Option<&wgpu::Buffer>,
    photon_texture: Option<&wgpu::Texture>,
    photon_directions: Option<&wgpu::Texture>,
    count: u32,
) -> Emission {
    let device = &gpu.device;
    let mut layout_entries = vec![
        wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
        if photon_texture.is_some() {
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba32Uint,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            }
        } else {
            storage_layout(1, false)
        },
        wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
    ];
    if photon_texture.is_some() {
        layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::R32Uint,
                view_dimension: wgpu::TextureViewDimension::D2,
            },
            count: None,
        });
    }
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Caustic emission"),
        entries: &layout_entries,
    });
    let full = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Caustic emission"),
        bind_group_layouts: &[
            Some(&layouts[0]),
            Some(&layouts[1]),
            Some(&layouts[2]),
            Some(&layout),
        ],
        ..Default::default()
    });
    let pipeline = pipeline(device, source, "main", Some(&full));
    let uniform = buffer(device, 112, true);
    let photon_view = photon_texture.map(|t| t.create_view(&Default::default()));
    let direction_view = photon_directions.map(|t| t.create_view(&Default::default()));
    let distribution_view = distribution.create_view(&Default::default());
    let mut entries = vec![
        wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform.as_entire_binding(),
        },
        wgpu::BindGroupEntry {
            binding: 1,
            resource: if let Some(view) = &photon_view {
                wgpu::BindingResource::TextureView(view)
            } else {
                storage.unwrap().as_entire_binding()
            },
        },
        wgpu::BindGroupEntry {
            binding: 2,
            resource: wgpu::BindingResource::TextureView(&distribution_view),
        },
    ];
    if let Some(view) = &direction_view {
        entries.push(wgpu::BindGroupEntry {
            binding: 3,
            resource: wgpu::BindingResource::TextureView(view),
        });
    }
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Caustic emission"),
        layout: &layout,
        entries: &entries,
    });
    Emission {
        pipeline,
        group,
        uniform,
        count,
    }
}
fn emit(
    gpu: &GpuDevice,
    encoder: &mut wgpu::CommandEncoder,
    emission: &Emission,
    groups: [&wgpu::BindGroup; 3],
    template: &[u8],
    batch: u32,
    timer: Option<&profiling::GpuTimer>,
    pair: u32,
) {
    let mut uniform = template.to_vec();
    uniform[80..84].copy_from_slice(&emission.count.to_le_bytes());
    uniform[84..88].copy_from_slice(&batch.to_le_bytes());
    gpu.queue.write_buffer(&emission.uniform, 0, &uniform);
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("Caustic emission"),
        timestamp_writes: timer.map(|t| t.pass(pair)),
        ..Default::default()
    });
    pass.set_pipeline(&emission.pipeline);
    for (i, group) in groups.iter().enumerate() {
        pass.set_bind_group(i as u32, *group, &[]);
    }
    pass.set_bind_group(3, &emission.group, &[]);
    let groups = emission.count.div_ceil(64);
    pass.dispatch_workgroups(groups.min(65535), groups.div_ceil(65535), 1);
}
impl State {
    pub fn pass_count(&self) -> u32 {
        1 + if self.photons.is_some() { 5 } else { 0 } + if self.light.is_some() { 3 } else { 0 }
    }
    pub fn pt_pair(&self) -> u32 {
        if self.photons.is_some() { 5 } else { 0 }
    }
    pub fn extend_scene(scene: &Scene, packet: &Packet) -> Scene {
        let mut scene = scene.clone();
        if packet.metadata.flags & 4 != 0 {
            for binding in [11, 12] {
                scene.bind_groups[layout::group::TEXTURES].layout.push(
                    wgpu::BindGroupLayoutEntry {
                        binding,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Uint,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                );
            }
        }
        scene
    }
    pub fn new(
        gpu: &GpuDevice,
        mut packet: Packet,
        layouts: &[wgpu::BindGroupLayout],
        scene: &Scene,
        buffers: &HashMap<usize, wgpu::Buffer>,
        textures: &HashMap<usize, wgpu::Texture>,
        samplers: &HashMap<usize, wgpu::Sampler>,
        target_buffers: &HashMap<usize, wgpu::Buffer>,
        size: [u32; 2],
    ) -> Result<Self> {
        #[cfg(test)]
        if let Ok(out) = std::env::var("MUTRACER_CAUSTICS_EVIDENCE") {
            std::fs::write(
                format!("{out}/target-{}-metadata.json", packet.metadata.flags),
                serde_json::to_vec_pretty(&packet.metadata)?,
            )?;
            std::fs::write(
                format!("{out}/target-{}-distribution.bin", packet.metadata.flags),
                &packet.distribution,
            )?;
            std::fs::write(
                format!("{out}/target-{}-uniform.bin", packet.metadata.flags),
                &packet.uniform,
            )?;
        }
        let m = packet.metadata;
        let local = std::env::var("MUTRACER_PHOTON_PER_CASTER_RADIUS").as_deref() == Ok("1");
        let view = std::env::var("MUTRACER_CAUSTIC_VIEW_IMPORTANCE").as_deref() == Ok("1");
        let deep = std::env::var("MUTRACER_PHOTON_DEEP_PIXELS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0)
            .min(65535);
        let experiments = u32::from(local) | (deep << 8);
        let words_per_photon = if local { 4u64 } else { 3 };
        let bytes_per_photon = 16 + words_per_photon * 4;
        let device = &gpu.device;
        let pixels = size[0] * size[1];
        if packet.uniform.len() != 112 {
            return Err("Invalid caustic uniform".into());
        }
        packet.uniform[108..112]
            .copy_from_slice(&(u32::from(local) | (u32::from(view) << 1)).to_le_bytes());
        let distribution = texture(
            gpu,
            m.distribution_width,
            m.distribution_height,
            Some(&packet.distribution),
            false,
            wgpu::TextureFormat::Rgba32Float,
        );
        let lighting = texture(
            gpu,
            m.light_width,
            m.light_height,
            Some(&packet.lighting),
            false,
            wgpu::TextureFormat::Rgba32Float,
        );
        let limit = device.limits();
        let max_count = (limit.max_storage_buffer_binding_size as u64 / 20)
            .min(
                u64::from(limit.max_texture_dimension_2d)
                    .pow(2)
                    .saturating_sub(262144 * 4 + 8)
                    / words_per_photon,
            )
            .min((128 * 1024 * 1024 - 13 * 1024 * 1024) / bytes_per_photon)
            as u32;
        let count = |requested: u32| {
            let mut n = requested.clamp(1, max_count);
            loop {
                let buckets = (n.saturating_mul(2).max(256).next_power_of_two()).min(262144);
                let capacity = |texels: u64| {
                    texels.min(u64::from(limit.max_texture_dimension_2d))
                        * texels.div_ceil(u64::from(limit.max_texture_dimension_2d))
                };
                let bytes = u64::from(buckets + buckets / 256) * 32
                    + capacity(u64::from(n)) * 16
                    + capacity(u64::from(n) * words_per_photon + u64::from(buckets) * 4 + 8) * 4
                    + 32;
                if bytes <= 128 * 1024 * 1024 || n == 1 {
                    break n;
                }
                n = n
                    .saturating_sub(((bytes - 128 * 1024 * 1024).div_ceil(bytes_per_photon)) as u32)
                    .max(1);
            }
        };
        let photons = if m.flags & 4 != 0 {
            let n = count(m.photon_map_photons);
            let buckets = (n.saturating_mul(2).max(256).next_power_of_two()).min(262144);
            let grid = buffer(device, u64::from(buckets + buckets / 256) * 32, false);
            let uniform = buffer(device, 32, true);
            let texels = n;
            let width = texels.min(limit.max_texture_dimension_2d);
            let data = texture(
                gpu,
                width,
                texels.div_ceil(width),
                None,
                true,
                wgpu::TextureFormat::Rgba32Uint,
            );
            let header_texels = n * words_per_photon as u32 + buckets * 4 + 8;
            let headers = texture(
                gpu,
                header_texels.min(limit.max_texture_dimension_2d),
                header_texels.div_ceil(limit.max_texture_dimension_2d),
                None,
                true,
                wgpu::TextureFormat::R32Uint,
            );
            let entries = [
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Uint,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                storage_layout(1, false),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::R32Uint,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
            ];
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Photon grid"),
                entries: &entries,
            });
            let full = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Photon grid"),
                bind_group_layouts: &[Some(&layout)],
                ..Default::default()
            });
            let pipelines = ["count", "scanBlocks", "scanSums", "scatter"]
                .iter()
                .map(|entry| pipeline(device, &m.grid_shader, entry, Some(&full)))
                .collect();
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Photon grid"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            &data.create_view(&Default::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: grid.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: uniform.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(
                            &headers.create_view(&Default::default()),
                        ),
                    },
                ],
            });
            Some(Photons {
                emit: emitter(
                    gpu,
                    &m.photon_shader,
                    layouts,
                    &distribution,
                    None,
                    Some(&data),
                    Some(&headers),
                    n,
                ),
                buckets,
                grid,
                uniform,
                pipelines,
                group,
                _data: data,
                _headers: headers,
            })
        } else {
            None
        };
        let views: Vec<_> = scene.bind_groups[layout::group::TEXTURES]
            .entries
            .iter()
            .filter(|b| matches!(b.kind, BindingKind::Texture))
            .map(|b| {
                (
                    b.binding,
                    if b.binding == 8 {
                        lighting.create_view(&Default::default())
                    } else {
                        textures[&b.id].create_view(&Default::default())
                    },
                )
            })
            .chain(photons.iter().flat_map(|p| {
                [
                    (11, p._data.create_view(&Default::default())),
                    (12, p._headers.create_view(&Default::default())),
                ]
            }))
            .collect();
        let entries: Vec<_> = scene.bind_groups[layout::group::TEXTURES]
            .entries
            .iter()
            .filter(|b| !matches!(b.kind, BindingKind::Texture))
            .map(|b| wgpu::BindGroupEntry {
                binding: b.binding,
                resource: match b.kind {
                    BindingKind::Buffer => buffers[&b.id].as_entire_binding(),
                    BindingKind::Sampler => wgpu::BindingResource::Sampler(&samplers[&b.id]),
                    _ => unreachable!(),
                },
            })
            .chain(views.iter().map(|(binding, view)| wgpu::BindGroupEntry {
                binding: *binding,
                resource: wgpu::BindingResource::TextureView(view),
            }))
            .collect();
        let texture_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Caustic scene textures"),
            layout: &layouts[layout::group::TEXTURES],
            entries: &entries,
        });
        // Unused sampled bindings must not alias the emission storage texture.
        let placeholder = texture(gpu, 1, 1, None, false, wgpu::TextureFormat::R32Uint);
        let placeholder_view = placeholder.create_view(&Default::default());
        let emission_entries = entries
            .iter()
            .map(|entry| wgpu::BindGroupEntry {
                binding: entry.binding,
                resource: if entry.binding == 11 || entry.binding == 12 {
                    wgpu::BindingResource::TextureView(&placeholder_view)
                } else {
                    entry.resource.clone()
                },
            })
            .collect::<Vec<_>>();
        let emission_textures = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Photon emission scene"),
            layout: &layouts[layout::group::TEXTURES],
            entries: &emission_entries,
        });
        let pt_color = if m.flags & 2 != 0 {
            Some(buffer(device, u64::from(pixels) * 16, false))
        } else {
            None
        };
        let light = if let Some(pt) = &pt_color {
            let splats = buffer(device, u64::from(pixels) * 12, false);
            let accumulation = buffer(device, u64::from(pixels) * 16, false);
            let resolve = pipeline(device, &m.accumulate_shader, "main", None);
            let resolve_group = buffer_group(
                device,
                &resolve.get_bind_group_layout(0),
                &[&splats, &accumulation],
            );
            let compose = pipeline(device, &m.compose_shader, "main", None);
            let compose_group = buffer_group(
                device,
                &compose.get_bind_group_layout(0),
                &[
                    pt,
                    &accumulation,
                    &target_buffers[&layout::resource::NORMAL],
                    &target_buffers[&layout::resource::COLOR],
                ],
            );
            Some(Light {
                emit: emitter(
                    gpu,
                    &m.light_shader,
                    layouts,
                    &distribution,
                    Some(&splats),
                    None,
                    None,
                    m.light_photons.min(4_194_240),
                ),
                splats,
                accumulation,
                resolve,
                resolve_group,
                compose,
                compose_group,
            })
        } else {
            None
        };
        Ok(Self {
            textures: texture_group,
            emission_textures,
            pt_color,
            light,
            photons,
            template: packet.uniform,
            initial_radius: if local {
                m.per_caster_radius
            } else {
                m.initial_radius
            },
            experiments,
            radius_scaling: RadiusScaling::probe(),
            size,
            pixels,
            _distribution: distribution,
            _lighting: lighting,
        })
    }
    pub fn before(
        &self,
        gpu: &GpuDevice,
        encoder: &mut wgpu::CommandEncoder,
        groups: [&wgpu::BindGroup; 3],
        sample: u32,
        batch: u32,
        timer: Option<&profiling::GpuTimer>,
        pair: u32,
    ) {
        if sample == 0 {
            if let Some(light) = &self.light {
                encoder.clear_buffer(&light.accumulation, 0, None);
                encoder.clear_buffer(self.pt_color.as_ref().unwrap(), 0, None);
            }
        }
        let Some(p) = &self.photons else { return };
        let groups = [groups[0], &self.emission_textures, groups[2]];
        encoder.clear_buffer(&p.grid, 0, None);
        emit(
            gpu,
            encoder,
            &p.emit,
            groups,
            &self.template,
            batch,
            timer,
            pair,
        );
        let radius = self
            .radius_scaling
            .radius(self.initial_radius, sample + 1, p.emit.count);
        let mut data = [0u8; 32];
        data[..4].copy_from_slice(&radius.to_le_bytes());
        data[4..8].copy_from_slice(&p.emit.count.to_le_bytes());
        data[8..12].copy_from_slice(&2.0f32.to_le_bytes());
        data[16..20].copy_from_slice(&p.buckets.to_le_bytes());
        // Same caster-center footprint as the web host; only the index changes.
        let word =
            |i: usize| f32::from_le_bytes(self.template[i * 4..i * 4 + 4].try_into().unwrap());
        let depth = if u32::from_le_bytes(self.template[104..108].try_into().unwrap()) != 0 {
            1.0
        } else {
            (word(7) * word(0) + word(11) * word(1) + word(15) * word(2) + word(19)).abs()
        };
        let projection = (word(4).powi(2) + word(8).powi(2) + word(12).powi(2)).sqrt();
        let footprint = 4.0 * depth / (self.size[0] as f32 * projection);
        let fine_radius = if footprint.is_finite() && footprint > 0.0 {
            radius.min(footprint.max(1e-8))
        } else {
            radius
        };
        data[20..24].copy_from_slice(&fine_radius.to_le_bytes());
        data[24..28].copy_from_slice(&self.experiments.to_le_bytes());
        gpu.queue.write_buffer(&p.uniform, 0, &data);
        let dispatch =
            |pass: &mut wgpu::ComputePass<'_>, i: usize, pipeline: &wgpu::ComputePipeline| {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &p.group, &[]);
                let groups = match i {
                    1 => p.buckets / 256,
                    2 => 1,
                    3 => p.emit.count.max(p.buckets).div_ceil(64),
                    _ => p.emit.count.div_ceil(64),
                };
                pass.dispatch_workgroups(
                    groups.min(65535),
                    if i == 1 || i == 2 {
                        2
                    } else {
                        groups.div_ceil(65535)
                    },
                    1,
                );
            };
        if let Some(timer) = timer {
            for (i, pipeline) in p.pipelines.iter().enumerate() {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("Photon grid stage"),
                    timestamp_writes: Some(timer.pass(pair + 1 + i as u32)),
                    ..Default::default()
                });
                dispatch(&mut pass, i, pipeline);
            }
        } else {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Photon grid"),
                ..Default::default()
            });
            for (i, pipeline) in p.pipelines.iter().enumerate() {
                dispatch(&mut pass, i, pipeline);
            }
        }
    }
    pub fn after(
        &self,
        gpu: &GpuDevice,
        encoder: &mut wgpu::CommandEncoder,
        groups: [&wgpu::BindGroup; 3],
        batch: u32,
        timer: Option<&profiling::GpuTimer>,
        pair: u32,
    ) {
        let Some(light) = &self.light else { return };
        encoder.clear_buffer(&light.splats, 0, None);
        emit(
            gpu,
            encoder,
            &light.emit,
            groups,
            &self.template,
            batch,
            timer,
            pair,
        );
        for (i, (pipeline, group)) in [
            (&light.resolve, &light.resolve_group),
            (&light.compose, &light.compose_group),
        ]
        .into_iter()
        .enumerate()
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Caustic resolve"),
                timestamp_writes: timer.map(|t| t.pass(pair + 1 + i as u32)),
                ..Default::default()
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(self.pixels.div_ceil(64), 1, 1);
        }
    }
}

#[cfg(test)]
mod radius_tests {
    use super::RadiusScaling;
    #[test]
    fn photon_count_radius_contract() {
        for photons in [65536, 262144, 1048576] {
            let legacy = RadiusScaling::None.radius(2., 64, photons);
            assert_eq!(legacy, 1.);
            let ppm = RadiusScaling::Ppm.radius(2., 64, photons);
            let constant = RadiusScaling::ConstantCount.radius(2., 64, photons);
            let ratio = f64::from(photons) / 262144.;
            assert_eq!(ppm, ratio.powf(-1. / 6.) as f32);
            assert_eq!(constant, ratio.powf(-1. / 2.) as f32);
            for mode in [
                RadiusScaling::None,
                RadiusScaling::Ppm,
                RadiusScaling::ConstantCount,
            ] {
                assert_eq!(
                    mode.radius(2., 4096, photons),
                    mode.radius(2., 64, photons) / 2.
                );
            }
        }
    }
}
