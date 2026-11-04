//! The production shader's pinhole query, with private camera/output buffers.
use super::*;
use std::sync::OnceLock;

pub(crate) struct Pipeline {
    pipeline: wgpu::ComputePipeline,
    output: wgpu::BindGroupLayout,
}
pub(crate) struct Query {
    gpu: GpuDevice,
    shader: wgpu::ShaderModule,
    layouts: Vec<wgpu::BindGroupLayout>,
    groups: [wgpu::BindGroup; 2],
    frame: [wgpu::Buffer; 2],
    pipeline: Arc<OnceLock<Pipeline>>,
    retained: Option<scene::PreparedState>,
}
impl Query {
    pub(super) fn snapshot(scene: &GpuScene) -> Self {
        Self {
            gpu: scene.gpu.clone(),
            shader: scene.depth_shader.clone(),
            layouts: scene.layouts[..3].to_vec(),
            groups: [scene.groups[0].clone(), scene.groups[1].clone()],
            frame: [
                scene
                    .gpu
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Depth query trace settings"),
                        contents: &scene.display_trace,
                        usage: wgpu::BufferUsages::UNIFORM,
                    }),
                scene.buffers[&layout::resource::LIGHT_UNIFORM].clone(),
            ],
            pipeline: scene.depth_pipeline.clone(),
            retained: scene.retained.clone(),
        }
    }
    pub(crate) fn read(
        self,
        camera: &[u8],
        area: [f32; 4],
    ) -> Result<[f32; api::DEPTH_SAMPLE_COUNT]> {
        let mapped = self.read_raw(camera, area)?;
        let result = std::array::from_fn(|i| {
            f32::from_le_bytes(mapped[i * 16..i * 16 + 4].try_into().unwrap())
        });
        if result.iter().any(|v| !v.is_finite() || *v < 0.) {
            return Err("Invalid depth samples".into());
        }
        Ok(result)
    }
    pub(crate) fn pick(self, camera: &[u8], mut area: [f32; 4]) -> Result<Option<[u32; 3]>> {
        let retained = self.retained.clone().ok_or("Missing surface query scene")?;
        area[2] = -1.;
        area[3] = -1.;
        let mapped = self.read_raw(camera, area)?;
        let result = std::array::from_fn(|i| {
            f32::from_le_bytes(mapped[i * 4..i * 4 + 4].try_into().unwrap())
        });
        retained.surface_hit(result)
    }
    fn read_raw(self, camera: &[u8], area: [f32; 4]) -> Result<Vec<u8>> {
        let gpu = &self.gpu;
        gpu.loss.check()?;
        let device = &gpu.device;
        let compiled = self.pipeline.get_or_init(|| {
            let output = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Depth query output"),
                entries: &[
                    (0, wgpu::BufferBindingType::Storage { read_only: false }),
                    (4, wgpu::BufferBindingType::Uniform),
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
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Depth query layout"),
                bind_group_layouts: &[
                    Some(&self.layouts[0]),
                    Some(&self.layouts[1]),
                    Some(&self.layouts[2]),
                    Some(&output),
                ],
                ..Default::default()
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Depth query"),
                layout: Some(&layout),
                module: &self.shader,
                entry_point: Some("depthQuery"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[("DEPTH_QUERY_MODE", 1.)],
                    ..Default::default()
                },
                cache: gpu.pipeline_cache.as_ref(),
            });
            Pipeline { pipeline, output }
        });
        let uniform = |label, bytes: &[u8]| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            })
        };
        let camera = uniform("Depth query camera", camera);
        let area = uniform("Depth query area", bytemuck::bytes_of(&area));
        let frame = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Depth query frame"),
            layout: &self.layouts[2],
            entries: &[(0, &camera), (1, &self.frame[0]), (2, &self.frame[1])].map(
                |(binding, buffer)| wgpu::BindGroupEntry {
                    binding,
                    resource: buffer.as_entire_binding(),
                },
            ),
        });
        let bytes = (api::DEPTH_SAMPLE_COUNT * 16) as u64;
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Depth samples"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let outputs = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &compiled.output,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: output.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: area.as_entire_binding(),
                },
            ],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&compiled.pipeline);
            pass.set_bind_group(0, &self.groups[0], &[]);
            pass.set_bind_group(1, &self.groups[1], &[]);
            pass.set_bind_group(2, &frame, &[]);
            pass.set_bind_group(3, &outputs, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        gpu.queue.submit([encoder.finish()]);
        let mapped = gpu
            .queue
            .read_buffer(device, output.slice(..))
            .map_err(|error| {
                if matches!(
                    error.downcast_ref::<wgpu::PollError>(),
                    Some(wgpu::PollError::Timeout)
                ) {
                    fail(Status::Timeout, "Depth readback timed out")
                } else {
                    error
                }
            })?;
        gpu.loss.check()?;
        Ok(mapped)
    }
}
