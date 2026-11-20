//! Independently sampled color, directional reflectance and optical guides.
use super::*;
use crate::{CachedPipeline, GpuScene, Result, compile_pipeline, layout, storage_layout};
use std::sync::Arc;
use wgpu::util::DeviceExt;

pub use crate::layout::FramePixelRecord;

/// Immutable scene bindings captured before releasing the context registry.
pub(crate) struct ProducerScene {
    pub gpu: crate::GpuDevice,
    pub scene: crate::Scene,
    pub hwrt_shader: bool,
    pub groups: Vec<wgpu::BindGroup>,
    pub buffers: std::collections::HashMap<usize, wgpu::Buffer>,
}
impl ProducerScene {
    pub fn snapshot(scene: &GpuScene) -> Self {
        Self {
            gpu: scene.gpu.clone(),
            scene: scene.scene.clone(),
            hwrt_shader: scene.hwrt_shader,
            groups: scene.groups[..2].to_vec(),
            buffers: std::collections::HashMap::from([(
                layout::resource::LIGHT_UNIFORM,
                scene.buffers[&layout::resource::LIGHT_UNIFORM].clone(),
            )]),
        }
    }
}
pub(crate) struct FrameProducer {
    trace: CachedPipeline,
    resolve: wgpu::ComputePipeline,
    device: DeviceKey,
}
impl FrameProducer {
    pub fn new(scene: &GpuScene, source: String) -> Result<Self> {
        Self::new_snapshot(&ProducerScene::snapshot(scene), source)
    }
    pub fn new_snapshot(scene: &ProducerScene, source: String) -> Result<Self> {
        let mut description = scene.scene.clone();
        description.bind_groups[layout::group::OUTPUT]
            .layout
            .extend([storage_layout(4, false), storage_layout(10, false)]);
        let scope = scene
            .gpu
            .device
            .push_error_scope(wgpu::ErrorFilter::Validation);
        let trace = compile_pipeline(&scene.gpu, &description, source, scene.hwrt_shader, false);
        let shader = scene
            .gpu
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("MuTracer first-surface frame resolve"),
                source: wgpu::ShaderSource::Wgsl(
                    crate::postprocess::sources()?.frame_resolve.as_str().into(),
                ),
            });
        let resolve = scene
            .gpu
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("MuTracer first-surface frame resolve"),
                layout: None,
                module: &shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        if let Some(error) = pollster::block_on(scope.pop()) {
            // compile_pipeline caches the handle before the enclosing error
            // scope resolves. Never let a rejected handle bypass validation on
            // the next request for the same shader.
            scene.gpu.pipelines.lock().unwrap().clear();
            scene
                .gpu
                .compilation
                .cached
                .store(0, std::sync::atomic::Ordering::Release);
            return Err(error.to_string().into());
        }
        let (trace, _) = trace?;
        Ok(Self {
            trace,
            resolve,
            device: scene.gpu.frame_device,
        })
    }
    /// The scene is borrowed only until its producer is submitted. Subsequent
    /// scene writes queue behind it; the returned frame owns its separate outputs.
    /// No previous progressive accumulation is sampled or reset here.
    pub fn produce(
        &self,
        scene: &GpuScene,
        history: &mut GpuFrameHistory,
        metadata: FrameMetadata,
        geometry: GeometrySnapshot,
        camera: &[u8],
        trace: &[u8],
    ) -> Result<(Arc<GpuFrame>, ProducerDependency)> {
        self.produce_snapshot(
            &ProducerScene::snapshot(scene),
            history,
            metadata,
            geometry,
            camera,
            trace,
        )
    }
    pub fn produce_snapshot(
        &self,
        scene: &ProducerScene,
        history: &mut GpuFrameHistory,
        mut metadata: FrameMetadata,
        geometry: GeometrySnapshot,
        camera: &[u8],
        trace: &[u8],
    ) -> Result<(Arc<GpuFrame>, ProducerDependency)> {
        metadata.validate()?;
        scene.gpu.loss.check()?;
        if self.device != scene.gpu.frame_device
            || camera.len() != 144
            || trace.len() != crate::layout::ray_uniform::BYTES
        {
            return Err("Frame producer device/camera/trace mismatch".into());
        }
        if f32::from_le_bytes(camera[128..132].try_into()?) != 0.0 {
            return Err("Frame producer requires the actual pinhole camera".into());
        }
        let packed: Vec<_> = bytemuck::pod_collect_to_vec::<u8, f32>(camera);
        let expected_inverse = glam::Mat4::from_cols_array(&metadata.camera.view_inverse)
            * glam::Mat4::from_cols_array(&metadata.camera.projection_inverse);
        for (actual, expected) in packed[..16]
            .iter()
            .zip(expected_inverse.to_cols_array())
            .chain(packed[16..32].iter().zip(metadata.camera.view_inverse))
        {
            if !actual.is_finite() || (actual - expected).abs() > 2e-5 * expected.abs().max(1.) {
                return Err("Frame camera metadata does not match the actual primary ray".into());
            }
        }
        metadata.capabilities.noisy_color = Support::Ready;
        metadata.capabilities.normal_roughness = Support::Ready;
        metadata.capabilities.linear_depth = Support::Ready;
        metadata.capabilities.diffuse_albedo = Support::Ready;
        metadata.capabilities.specular_albedo = Support::Ready;
        // These guides have per-pixel validity. Their presence never promotes
        // missing motion/path data into a declaration of complete RR inputs.
        metadata.capabilities.first_surface = Support::Ready;
        metadata.capabilities.camera_motion = Support::Ready;
        metadata.capabilities.rigid_motion = if geometry.aov_words.is_empty() {
            Support::Unverified
        } else {
            Support::Ready
        };
        metadata.capabilities.deformation_motion = Support::Unverified;
        metadata.capabilities.specular_distance = Support::Unverified;
        metadata.capabilities.specular_reflection = Support::Ready;
        metadata.capabilities.glass = GlassCapabilities::default();
        let gpu = &scene.gpu;
        let size = metadata.input_extent;
        let pixels = size[0] as u64 * size[1] as u64;
        if pixels * size_of::<FramePixelRecord>() as u64
            > gpu.device.limits().max_storage_buffer_binding_size as u64
        {
            return Err("Frame records exceed device storage limits".into());
        }
        let mut resources = GpuFrameResources::allocate(
            gpu,
            size,
            &[
                Guide::NoisyColor,
                Guide::NormalRoughness,
                Guide::LinearDepth,
                Guide::Validity,
                Guide::DiffuseAlbedo,
                Guide::SpecularAlbedo,
                Guide::Motion,
                Guide::SpecularReflection,
            ],
            0,
            0,
        )?;
        let mut trace = trace.to_vec();
        let mut word =
            |at: usize, value: u32| trace[at..at + 4].copy_from_slice(&value.to_le_bytes());
        use layout::ray_uniform as u;
        word(u::OUTPUT_SIZE, (size[0] as f32).to_bits());
        word(u::OUTPUT_SIZE + 4, (size[1] as f32).to_bits());
        word(u::SAMPLE_COUNT, 0f32.to_bits());
        word(u::SAMPLE_SEQUENCE_OFFSET, metadata.sample_index);
        word(u::SEQUENCE_SEED, metadata.seed);
        word(
            u::JITTER,
            (metadata.jitter_pixels[0] / size[0] as f32).to_bits(),
        );
        word(
            u::JITTER + 4,
            (-metadata.jitter_pixels[1] / size[1] as f32).to_bits(),
        );
        for (i, value) in [1f32, 1.0, 0.0, 0.0].iter().enumerate() {
            word(u::SCALE_OFFSET + i * 4, value.to_bits());
        }
        word(u::ADAPTIVE_SAMPLING, 0);
        let uniform = |label, data| {
            gpu.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents: data,
                    usage: wgpu::BufferUsages::UNIFORM,
                })
        };
        let camera = uniform("Frame immutable camera", camera);
        let trace = uniform("Frame immutable trace parameters", &trace);
        let allocate = |size| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Frame independent trace output"),
                size,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let outputs = [
            allocate(pixels * 16),
            allocate(pixels * 16),
            allocate(pixels * 16),
            allocate(pixels * 48),
            allocate(pixels * size_of::<FramePixelRecord>() as u64),
            allocate(pixels * 32),
        ];
        let bind_buffers = |group: usize, buffers: &[&wgpu::Buffer]| {
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Frame independent trace bindings"),
                layout: &self.trace.layouts[group],
                entries: &buffers
                    .iter()
                    .enumerate()
                    .map(|(binding, buffer)| wgpu::BindGroupEntry {
                        binding: if binding == 5 { 10 } else { binding as u32 },
                        resource: buffer.as_entire_binding(),
                    })
                    .collect::<Vec<_>>(),
            })
        };
        let frame_group = bind_buffers(
            layout::group::FRAME,
            &[
                &camera,
                &trace,
                &scene.buffers[&layout::resource::LIGHT_UNIFORM],
            ],
        );
        let output_group = bind_buffers(layout::group::OUTPUT, &outputs.iter().collect::<Vec<_>>());
        let trace_timer =
            crate::profiling::GpuTimer::new(&gpu.device, metadata.sample_count, false);
        let resolve_timer = crate::profiling::GpuTimer::new(&gpu.device, 1, false);
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        for sample in 0..metadata.sample_count {
            // Separate dispatches make each pixel's preceding mean and sample
            // index visible. All samples in this frame share camera jitter.
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Independent temporal sample"),
                timestamp_writes: trace_timer.as_ref().map(|timer| timer.pass(sample)),
            });
            pass.set_pipeline(&self.trace.pipeline);
            for (i, group) in [
                &scene.groups[0],
                &scene.groups[1],
                &frame_group,
                &output_group,
            ]
            .iter()
            .enumerate()
            {
                pass.set_bind_group(i as u32, *group, &[]);
            }
            pass.dispatch_workgroups(size[0].div_ceil(8), size[1].div_ceil(8), 1);
        }
        if let Some(timer) = &trace_timer {
            timer.resolve(&mut encoder);
        }
        let stable = !geometry.aov_words.is_empty();
        let previous = history.previous_snapshot().filter(|previous| {
            previous.metadata.camera.same_projection(&metadata.camera)
                && previous.metadata.input_extent == size
                && (stable
                    || (previous.metadata.scene_revision == metadata.scene_revision
                        && Arc::ptr_eq(&previous.geometry.publication, &geometry.publication)))
        });
        let metadata_words = if stable {
            crate::aov::reproject_metadata(
                &geometry.aov_words,
                previous.map(|p| p.geometry.aov_words.as_slice()),
            )
        } else {
            vec![0; 52]
        };
        let metadata_bytes: Vec<_> = bytemuck::cast_slice(&metadata_words).to_vec();
        let motion_metadata = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Frame stable transforms"),
                contents: &metadata_bytes,
                usage: wgpu::BufferUsages::STORAGE,
            });
        let stable_ids = allocate(pixels * 16);
        let empty_ids = allocate(16);
        let previous_ids = previous
            .and_then(|p| p.resources.stable_ids.as_ref())
            .unwrap_or(&empty_ids);
        let view_projection = |camera: &CameraSnapshot| {
            (glam::Mat4::from_cols_array(&camera.projection)
                * glam::Mat4::from_cols_array(&camera.view))
            .to_cols_array()
        };
        let current_matrix = view_projection(&metadata.camera);
        let previous_camera = previous.map_or(&metadata.camera, |p| &p.metadata.camera);
        let previous_matrix = view_projection(previous_camera);
        let inverse_view = previous_camera.view_inverse;
        let previous_forward = -glam::Vec3::from_slice(&inverse_view[8..11]).normalize();
        let previous_jitter = previous.map_or([0.; 2], |p| p.metadata.jitter_pixels);
        let resolve_values: Vec<f32> = current_matrix
            .into_iter()
            .chain(previous_matrix)
            .chain([inverse_view[12], inverse_view[13], inverse_view[14], 0.])
            .chain([
                previous_forward.x,
                previous_forward.y,
                previous_forward.z,
                0.,
            ])
            .chain([previous_jitter[0], previous_jitter[1], 0., 0.])
            .collect();
        let mut resolve_parameters = bytemuck::cast_slice(&resolve_values).to_vec();
        resolve_parameters.extend_from_slice(bytemuck::cast_slice(&[
            u32::from(previous.is_some()),
            u32::from(stable),
            u32::from(
                previous.is_some_and(|p| p.metadata.scene_revision == metadata.scene_revision),
            ),
            0,
        ]));
        let resolve_parameters = uniform("Frame correspondence parameters", &resolve_parameters);
        let previous_pixels = previous.map_or(&outputs[4], |p| &p.resources.producer_buffers[6]);
        let mut resolve_entries = vec![wgpu::BindGroupEntry {
            binding: 0,
            resource: outputs[4].as_entire_binding(),
        }];
        for (i, kind) in [
            Guide::NoisyColor,
            Guide::NormalRoughness,
            Guide::LinearDepth,
            Guide::Validity,
            Guide::DiffuseAlbedo,
            Guide::SpecularAlbedo,
            Guide::Motion,
        ]
        .iter()
        .enumerate()
        {
            resolve_entries.push(wgpu::BindGroupEntry {
                binding: i as u32 + 1,
                resource: wgpu::BindingResource::TextureView(&resources.guide(*kind).unwrap().view),
            });
        }
        resolve_entries.push(wgpu::BindGroupEntry {
            binding: 8,
            resource: resolve_parameters.as_entire_binding(),
        });
        resolve_entries.push(wgpu::BindGroupEntry {
            binding: 9,
            resource: previous_pixels.as_entire_binding(),
        });
        for (binding, buffer) in [
            (10, &motion_metadata),
            (11, previous_ids),
            (12, &stable_ids),
        ] {
            resolve_entries.push(wgpu::BindGroupEntry {
                binding,
                resource: buffer.as_entire_binding(),
            });
        }
        resolve_entries.push(wgpu::BindGroupEntry {
            binding: 13,
            resource: outputs[5].as_entire_binding(),
        });
        resolve_entries.push(wgpu::BindGroupEntry {
            binding: 14,
            resource: wgpu::BindingResource::TextureView(
                &resources.guide(Guide::SpecularReflection).unwrap().view,
            ),
        });
        let resolve_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.resolve.get_bind_group_layout(0),
            entries: &resolve_entries,
        });
        let mut resolve = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = resolve.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Resolve temporal guides"),
                timestamp_writes: resolve_timer.as_ref().map(|timer| timer.pass(0)),
            });
            pass.set_pipeline(&self.resolve);
            pass.set_bind_group(0, &resolve_group, &[]);
            pass.dispatch_workgroups(size[0].div_ceil(8), size[1].div_ceil(8), 1);
        }
        if let Some(timer) = &resolve_timer {
            timer.resolve(&mut resolve);
        }
        resources.gpu_bytes += outputs.iter().map(|b| b.size()).sum::<u64>()
            + camera.size()
            + trace.size()
            + resolve_parameters.size()
            + motion_metadata.size()
            + stable_ids.size()
            + empty_ids.size();
        resources.producer_buffers.extend([camera, trace]);
        resources.producer_buffers.extend(outputs);
        resources.producer_buffers.push(resolve_parameters);
        resources.producer_buffers.push(motion_metadata);
        resources.producer_buffers.push(empty_ids);
        resources.stable_ids = Some(stable_ids);
        let frame = history.prepare(metadata, geometry, resources)?;
        let dependency = ProducerDependency::Commands {
            frame: frame.clone(),
            commands: vec![encoder.finish(), resolve.finish()],
        }
        .submit_producer(gpu);
        let dependency = match dependency {
            Ok(dependency) => dependency,
            Err(error) => {
                history.reject(frame.key())?;
                if gpu.loss.reason().is_some() {
                    history.device_lost();
                }
                return Err(error);
            }
        };
        if let Some(timer) = trace_timer {
            let trace_ms = timer.optional_milliseconds(&gpu.device, &gpu.queue);
            let resolve_ms =
                resolve_timer.and_then(|t| t.optional_milliseconds(&gpu.device, &gpu.queue));
            eprintln!(
                "{}",
                serde_json::json!({"temporalGpuProfile": {
                  "sampleIndex": frame.current.metadata.sample_index,
                  "sampleCount": frame.current.metadata.sample_count,
                  "traceMs": trace_ms, "resolveMs": resolve_ms,
                  "frameBytes": frame.current.resources.gpu_bytes,
                }})
            );
        }
        Ok((frame, dependency))
    }
}
