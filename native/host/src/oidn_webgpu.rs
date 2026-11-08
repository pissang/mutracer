//! oidn-webgpu consumer, using only the published Rust API documented at
//! https://github.com/pissang/oidn-webgpu/blob/main/native/README.md
use crate::{GpuDevice, Result};
use oidn_webgpu::{
    DenoiseBuffers, DenoiseParams, Denoiser as Network, DenoiserOptions, Model, PreparedDenoise,
};
use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use wgpu::util::DeviceExt;

pub(crate) const BACKEND: u32 = 5;
pub(crate) fn required_features() -> wgpu::Features {
    Network::required_features()
}
pub(crate) fn recommended_features(adapter: &wgpu::Adapter) -> wgpu::Features {
    Network::recommended_features(adapter)
}

#[cfg(test)]
static NEXT_PREPARATION: AtomicU64 = AtomicU64::new(1);

// The prepared network owns its workspace and keeps these image handles alive.
// The output is reused, so submit() copies both returned images for retention.
pub(crate) struct Denoiser {
    size: [u32; 2],
    prepared: PreparedDenoise,
    auxiliary: Option<Auxiliary>,
    color: wgpu::Buffer,
    albedo: wgpu::Buffer,
    normal: wgpu::Buffer,
    output: wgpu::Buffer,
    normalize: wgpu::ComputePipeline,
    restore: wgpu::ComputePipeline,
    display_prepare: Option<wgpu::ComputePipeline>,
    #[cfg(test)]
    identity: u64,
}
struct Auxiliary {
    prepared: [PreparedDenoise; 2],
    encoded: [wgpu::Buffer; 2],
    filtered: [wgpu::Buffer; 2],
    clean: [wgpu::Buffer; 2],
    encode: wgpu::ComputePipeline,
    decode: wgpu::ComputePipeline,
}
impl Denoiser {
    pub(crate) fn new(
        gpu: &GpuDevice,
        size: [u32; 2],
        weights: Option<&Path>,
        max_tile_size: u32,
    ) -> Result<Self> {
        if !size.into_iter().all(|edge| (1..=16384).contains(&edge)) {
            return Err("Invalid OIDN image dimensions".into());
        }
        let clean_aux = weights.filter(|p| {
            p.file_name()
                .is_some_and(|n| n == "rt_hdr_calb_cnrm_large.tza")
        });
        let weights = match weights {
            Some(path) => std::fs::read(path)?,
            None => include_bytes!("../../../oidn/weights/rt_hdr_alb_nrm.tza").to_vec(),
        };
        let model = Model::from_tza(&weights)?;
        if model.input_count() != 3 {
            return Err("OIDN requires color/albedo/normal weights".into());
        }
        let mut options = DenoiserOptions::default();
        options.max_tile_size = max_tile_size;
        // Keep upstream's checked shaders. No planner FFI, shader extraction,
        // unchecked execution or private network options are needed here.
        let mut network = Network::new(&gpu.device, &gpu.adapter, &model, options)?;
        let size_bytes = u64::from(size[0]) * u64::from(size[1]) * 16;
        let image = |label| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: size_bytes,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let color = image("OIDN linear HDR input");
        let albedo = image("OIDN linear albedo input");
        let normal = image("OIDN signed normal input");
        let output = image("OIDN filtered HDR output");
        let auxiliary = if let Some(path) = clean_aux {
            let encoded = [image("OIDN sRGB albedo"), image("OIDN encoded normal")];
            let filtered = [
                image("OIDN prefiltered albedo"),
                image("OIDN prefiltered normal"),
            ];
            let clean = [
                image("OIDN clean linear albedo"),
                image("OIDN clean signed normal"),
            ];
            let prepare = |i: usize, name: &str| -> Result<PreparedDenoise> {
                let weights = std::fs::read(path.with_file_name(name))?;
                let model = Model::from_tza(&weights)?;
                let mut options = DenoiserOptions::default();
                options.hdr = false;
                options.max_tile_size = max_tile_size;
                let mut filter = Network::new(&gpu.device, &gpu.adapter, &model, options)?;
                Ok(filter.prepare(
                    size,
                    DenoiseBuffers {
                        color: (&encoded[i]).into(),
                        albedo: None,
                        normal: None,
                        output: (&filtered[i]).into(),
                    },
                )?)
            };
            let prepared = [
                prepare(0, "rt_alb_large.tza")?,
                prepare(1, "rt_nrm_large.tza")?,
            ];
            let module = gpu
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("OIDN clean auxiliary transfer"),
                    source: wgpu::ShaderSource::Wgsl(
                        crate::postprocess::sources()?.auxiliary.as_str().into(),
                    ),
                });
            let pipeline = |entry| {
                gpu.device
                    .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                        label: Some(entry),
                        layout: None,
                        module: &module,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        cache: None,
                    })
            };
            Some(Auxiliary {
                prepared,
                encoded,
                filtered,
                clean,
                encode: pipeline("encode"),
                decode: pipeline("decode"),
            })
        } else {
            None
        };
        let prepared = network.prepare(
            size,
            DenoiseBuffers {
                color: (&color).into(),
                albedo: Some(auxiliary.as_ref().map_or(&albedo, |a| &a.clean[0]).into()),
                normal: Some(auxiliary.as_ref().map_or(&normal, |a| &a.clean[1]).into()),
                output: (&output).into(),
            },
        )?;
        let source = crate::postprocess::sources()?.normalize.as_str();
        let shader = gpu
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("MuTracer OIDN image normalization"),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            });
        let pipeline = |entry| {
            gpu.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(entry),
                    layout: None,
                    module: &shader,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    cache: None,
                })
        };
        Ok(Self {
            size,
            prepared,
            auxiliary,
            color,
            albedo,
            normal,
            output,
            normalize: pipeline("normalize"),
            restore: pipeline("restore"),
            display_prepare: None,
            #[cfg(test)]
            identity: NEXT_PREPARATION.fetch_add(1, Ordering::Relaxed),
        })
    }
    pub(crate) fn size(&self) -> [u32; 2] {
        self.size
    }
    #[cfg(test)]
    pub(crate) fn program_identity(&self) -> u64 {
        self.identity
    }

    pub(crate) fn submit(
        &mut self,
        gpu: &GpuDevice,
        sources: [&wgpu::Buffer; 3],
        samples: u32,
        flat: bool,
    ) -> Result<(wgpu::Buffer, wgpu::Buffer)> {
        if samples == 0 {
            return Err("OIDN needs complete samples".into());
        }
        gpu.loss.check()?;
        let params = [self.size[0], self.size[1], samples, u32::from(flat)];
        let params = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("OIDN image resolve parameters"),
                contents: bytemuck::cast_slice(&params),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let normalize = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("OIDN accumulation resolve"),
            layout: &self.normalize.get_bind_group_layout(0),
            entries: &[
                entry(0, sources[0]),
                entry(1, sources[1]),
                entry(2, sources[2]),
                entry(3, &self.color),
                entry(4, &self.albedo),
                entry(5, &self.normal),
                entry(6, &params),
            ],
        });
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("MuTracer OIDN denoising"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.normalize);
            pass.set_bind_group(0, &normalize, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        }
        self.finish(gpu, encoder, &params, Some([sources[1], sources[2]]))
    }

    pub(crate) fn submit_display(
        &mut self,
        gpu: &GpuDevice,
        color: &wgpu::Texture,
        albedo: &wgpu::Texture,
        normal: &wgpu::Buffer,
        samples: u32,
    ) -> Result<wgpu::Buffer> {
        gpu.loss.check()?;
        if self.display_prepare.is_none() {
            let module = gpu
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("OIDN composed display inputs"),
                    source: wgpu::ShaderSource::Wgsl(
                        crate::postprocess::sources()?.oidn_display.as_str().into(),
                    ),
                });
            self.display_prepare = Some(gpu.device.create_compute_pipeline(
                &wgpu::ComputePipelineDescriptor {
                    label: Some("OIDN composed display inputs"),
                    layout: None,
                    module: &module,
                    entry_point: Some("prepare"),
                    compilation_options: Default::default(),
                    cache: None,
                },
            ));
        }
        let params = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("OIDN composed input parameters"),
                contents: bytemuck::cast_slice(&[
                    self.size[0],
                    self.size[1],
                    (samples as f32).to_bits(),
                    0,
                ]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let pipeline = self.display_prepare.as_ref().unwrap();
        let views = [
            color.create_view(&Default::default()),
            albedo.create_view(&Default::default()),
        ];
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("OIDN composed input bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&views[0]),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&views[1]),
                },
                entry(2, normal),
                entry(3, &params),
                entry(4, &self.color),
                entry(5, &self.albedo),
                entry(6, &self.normal),
            ],
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        }
        Ok(self.finish(gpu, encoder, &params, None)?.0)
    }

    fn finish(
        &mut self,
        gpu: &GpuDevice,
        mut encoder: wgpu::CommandEncoder,
        params: &wgpu::Buffer,
        restore_sources: Option<[&wgpu::Buffer; 2]>,
    ) -> Result<(wgpu::Buffer, wgpu::Buffer)> {
        let retained = |label| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: self.output.size(),
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let pixels = retained("Retained OIDN HDR pixels");
        let dispatch = |encoder: &mut wgpu::CommandEncoder,
                        pipeline: &wgpu::ComputePipeline,
                        group: &wgpu::BindGroup| {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        };
        if let Some(aux) = &mut self.auxiliary {
            let bind = |pipeline: &wgpu::ComputePipeline, buffers: &[(u32, &wgpu::Buffer)]| {
                gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("OIDN auxiliary transfer"),
                    layout: &pipeline.get_bind_group_layout(0),
                    entries: &buffers
                        .iter()
                        .map(|(i, b)| entry(*i, b))
                        .collect::<Vec<_>>(),
                })
            };
            let encode = bind(
                &aux.encode,
                &[
                    (0, &self.albedo),
                    (1, &self.normal),
                    (2, &aux.encoded[0]),
                    (3, &aux.encoded[1]),
                    (8, params),
                ],
            );
            let decode = bind(
                &aux.decode,
                &[
                    (4, &aux.filtered[0]),
                    (5, &aux.filtered[1]),
                    (6, &aux.clean[0]),
                    (7, &aux.clean[1]),
                    (8, params),
                ],
            );
            dispatch(&mut encoder, &aux.encode, &encode);
            for filter in &mut aux.prepared {
                filter.encode(&mut encoder, DenoiseParams::default())?;
            }
            dispatch(&mut encoder, &aux.decode, &decode);
        }
        self.prepared
            .encode(&mut encoder, DenoiseParams::default().with_input_scale(1.0))?;

        let preview = if let Some(sources) = restore_sources {
            let preview = retained("OIDN display color");
            let restore = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("OIDN display normalization"),
                layout: &self.restore.get_bind_group_layout(0),
                entries: &[
                    entry(1, sources[0]),
                    entry(2, sources[1]),
                    entry(3, &self.output),
                    entry(4, &preview),
                    entry(5, params),
                ],
            });
            dispatch(&mut encoder, &self.restore, &restore);
            preview
        } else {
            pixels.clone()
        };
        encoder.copy_buffer_to_buffer(&self.output, 0, &pixels, 0, pixels.size());
        gpu.queue.submit([encoder.finish()]);
        Ok((pixels, preview))
    }
}

fn entry(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_shader_is_valid_wgsl() {
        let module =
            naga::front::wgsl::parse_str(&crate::postprocess::sources().unwrap().normalize)
                .unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
    }
    #[test]
    #[ignore = "requires native OIDN on a real GPU"]
    fn accumulated_inputs_match_the_documented_rust_api_and_retained_outputs() {
        let _test = crate::abi_test_lock();
        let gpu = GpuDevice::with_backend(0).unwrap();
        let size = [17, 13];
        let samples = 4;
        let pixels = size[0] as usize * size[1] as usize;
        let mut color = Vec::new();
        let mut albedo = Vec::new();
        let mut normal = Vec::new();
        for i in 0..pixels {
            let coverage = if i % 5 == 0 {
                0.
            } else if i % 3 == 0 {
                0.5
            } else {
                1.
            };
            color.extend(
                [
                    0.2 + (i % 11) as f32 * 0.01,
                    0.3,
                    0.4,
                    0.25 + (i % 3) as f32 * 0.25,
                ]
                .map(|v| v * samples as f32),
            );
            albedo.extend([0.3, 0.4, 0.5, coverage].map(|v| v * samples as f32));
            normal.extend([-0.4, 0.5, -0.1, 1.].map(|v| v * samples as f32));
        }
        let upload = |values: &[f32]| {
            gpu.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Accumulated OIDN test input"),
                    contents: &values
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                    usage: wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::COPY_SRC
                        | wgpu::BufferUsages::COPY_DST,
                })
        };
        let source_color = upload(&color);
        let source_albedo = upload(&albedo);
        let source_normal = upload(&normal);
        let small = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../oidn/weights/rt_hdr_alb_nrm_small.tza");
        for weights_path in [None, Some(small.as_path())] {
            let mut integrated = Denoiser::new(&gpu, size, weights_path, 16).unwrap();
            for flat in [false, true] {
                let (result, _) = integrated
                    .submit(
                        &gpu,
                        [&source_color, &source_albedo, &source_normal],
                        samples,
                        flat,
                    )
                    .unwrap();
                let resolved = crate::hdr::read(
                    &gpu,
                    [&source_color, &source_normal, &source_albedo],
                    size,
                    samples,
                    flat,
                )
                .unwrap();
                let direct_color = upload(&resolved);
                let direct_albedo = upload(
                    &albedo
                        .iter()
                        .map(|v| v / samples as f32)
                        .collect::<Vec<_>>(),
                );
                let direct_normal = upload(
                    &normal
                        .iter()
                        .map(|v| v / samples as f32)
                        .collect::<Vec<_>>(),
                );
                let output = upload(&vec![0.; pixels * 4]);
                let weights = weights_path
                    .map(std::fs::read)
                    .transpose()
                    .unwrap()
                    .unwrap_or_else(|| {
                        include_bytes!("../../../oidn/weights/rt_hdr_alb_nrm.tza").to_vec()
                    });
                let model = Model::from_tza(&weights).unwrap();
                let mut options = DenoiserOptions::default();
                options.max_tile_size = 16;
                let mut direct = Network::new(&gpu.device, &gpu.adapter, &model, options).unwrap();
                let mut prepared = direct
                    .prepare(
                        size,
                        DenoiseBuffers {
                            color: (&direct_color).into(),
                            albedo: Some((&direct_albedo).into()),
                            normal: Some((&direct_normal).into()),
                            output: (&output).into(),
                        },
                    )
                    .unwrap();
                let mut encoder = gpu.device.create_command_encoder(&Default::default());
                prepared
                    .encode(&mut encoder, DenoiseParams::default().with_input_scale(1.))
                    .unwrap();
                gpu.queue.submit([encoder.finish()]);
                let read = |buffer: &wgpu::Buffer| {
                    crate::read_average(&gpu.device, &gpu.queue, buffer, size[0], size[1], 1)
                        .unwrap()
                };
                let actual = read(&result);
                let expected = read(&output);
                let actual_f32: Vec<_> = actual
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|v| f32::from_le_bytes(*v))
                    .collect();
                let expected_f32: Vec<_> = expected
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|v| f32::from_le_bytes(*v))
                    .collect();
                let max_error = actual_f32
                    .iter()
                    .zip(&expected_f32)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0., f32::max);
                assert!(max_error < 1e-5, "normalization mismatch: {max_error}");
                for (actual, original) in actual_f32
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(resolved.as_chunks::<4>().0)
                {
                    assert!(actual[..3].iter().all(|v| v.is_finite() && *v >= 0.));
                    assert_eq!(actual[3], original[3]);
                }
                // A later frame must not overwrite the result retained for display.
                let zeros = vec![0u8; color.len() * 4];
                gpu.queue.write_buffer(&source_color, 0, &zeros);
                integrated
                    .submit(
                        &gpu,
                        [&source_color, &source_albedo, &source_normal],
                        samples,
                        flat,
                    )
                    .unwrap();
                assert_eq!(read(&result), actual);
                gpu.queue.write_buffer(
                    &source_color,
                    0,
                    &color
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                );
            }
        }
    }
}
