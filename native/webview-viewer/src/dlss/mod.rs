//! Optional application adapter. The native SDK has no NVIDIA dependency.
mod ffi;
mod gpu;
use anyhow::{Context, Result, ensure};
use ash::vk::Handle;
use mutracer_native::api::{self, CustomDenoiser, TemporalGuide as Guide};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
use wgpu::{hal::api::Vulkan, util::DeviceExt};

struct Runtime {
    ngx: ffi::Ngx,
    gpu: gpu::Gpu,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        // Every feature owns this runtime; core leases keep the filter alive
        // through queue completion, including cancellation and replacement.
        unsafe {
            (self.ngx.shutdown)();
        }
    }
}
struct Feature {
    runtime: Arc<Runtime>,
    handle: usize,
}
impl Drop for Feature {
    fn drop(&mut self) {
        unsafe {
            (self.runtime.ngx.release)(self.handle as ffi::Target);
        }
    }
}
struct Target {
    feature: Feature,
    size: [u32; 2],
    textures: [wgpu::Texture; 3], // converted depth, motion, SDK output
    last: Option<api::DenoiseFrameStatus>,
    flights: Vec<api::DenoiseFrameStatus>,
    last_frame: u64,
}
#[derive(Default)]
struct State {
    targets: HashMap<(u64, u64), Target>,
    retired: Vec<Target>,
    evaluations: u64,
    resets: u64,
    last_reset: Vec<api::TemporalResetReason>,
}
pub struct Dlss {
    state: Mutex<State>,
    prepare: wgpu::ComputePipeline,
    resolve: wgpu::ComputePipeline,
    runtime: Arc<Runtime>,
}
fn pipeline(device: &wgpu::Device, name: &str, source: &str) -> wgpu::ComputePipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(name),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(name),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    })
}
fn dispatch(
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::ComputePipeline,
    group: &wgpu::BindGroup,
    size: [u32; 2],
) {
    let mut pass = encoder.begin_compute_pass(&Default::default());
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.dispatch_workgroups(size[0].div_ceil(8), size[1].div_ceil(8), 1);
}
fn group(
    device: &wgpu::Device,
    pipeline: &wgpu::ComputePipeline,
    resources: &[wgpu::BindingResource<'_>],
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &resources
            .iter()
            .enumerate()
            .map(|(i, resource)| wgpu::BindGroupEntry {
                binding: i as u32,
                resource: resource.clone(),
            })
            .collect::<Vec<_>>(),
    })
}
impl Dlss {
    pub fn new(directory: &Path, preset: u32) -> Result<Arc<Self>> {
        // NGX configuration is process-wide. Only the startup path creates an
        // adapter; share the returned Arc between all renders and windows.
        static CREATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        ensure!(
            !CREATED.swap(true, std::sync::atomic::Ordering::AcqRel),
            "DLSS runtime already created in this process"
        );
        let logs = std::env::temp_dir().join("mutracer-ngx");
        std::fs::create_dir_all(&logs)?;
        let ngx = unsafe {
            ffi::Ngx::load(
                &directory.join("mutracer_ngx.dll"),
                directory,
                &logs,
                "ccf33493-d64b-4ee1-97b2-1533decb91a9",
            )
        }?;
        unsafe {
            (ngx.set_preset)(preset);
        }
        let gpu = gpu::bootstrap(&ngx)?;
        let runtime = Arc::new(Runtime { ngx, gpu });
        Ok(Arc::new(Self {
            prepare: pipeline(
                &runtime.gpu.device,
                "NGX guide conversion",
                include_str!("prepare.wgsl"),
            ),
            resolve: pipeline(
                &runtime.gpu.device,
                "NGX result to MuTracer",
                include_str!("resolve.wgsl"),
            ),
            runtime,
            state: Mutex::new(State::default()),
        }))
    }
    pub fn device(&self) -> (wgpu::Instance, wgpu::Adapter, wgpu::Device, wgpu::Queue) {
        let gpu = &self.runtime.gpu;
        (
            gpu.instance.clone(),
            gpu.adapter.clone(),
            gpu.device.clone(),
            gpu.queue.clone(),
        )
    }
    fn target(&self, frame: &api::GpuDenoiseInput) -> Result<(Target, wgpu::CommandBuffer)> {
        let device = &frame.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("NGX feature creation"),
        });
        let mut handle = std::ptr::null_mut();
        let mut result = 0;
        unsafe {
            encoder.as_hal_mut::<Vulkan, _, _>(|e| {
                result = (self.runtime.ngx.create)(
                    e.unwrap().raw_handle().as_raw(),
                    frame.size[0],
                    frame.size[1],
                    &mut handle,
                );
            });
        }
        let feature = Feature {
            runtime: self.runtime.clone(),
            handle: handle as usize,
        };
        ffi::check(
            result,
            "DLSS RR create (try --dlss-preset D on older drivers)",
        )?;
        let textures = [
            wgpu::TextureFormat::R32Float,
            wgpu::TextureFormat::Rg32Float,
            wgpu::TextureFormat::Rgba32Float,
        ]
        .map(|format| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("NGX owned image"),
                size: wgpu::Extent3d {
                    width: frame.size[0],
                    height: frame.size[1],
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        });
        Ok((
            Target {
                feature,
                textures,
                size: frame.size,
                last: None,
                flights: Vec::new(),
                last_frame: frame.id.frame,
            },
            encoder.finish(),
        ))
    }
    fn filter(
        &self,
        mut input: api::DenoiseInput,
        cancel: api::CancelToken,
        before_submit: impl FnOnce(),
    ) -> Result<api::DenoiseOutput> {
        let frame = input
            .resident
            .take()
            .context("Missing resident GPU frame")?;
        ensure!(
            frame.device == self.runtime.gpu.device,
            "DLSS frame uses a different device"
        );
        ensure!(!cancel.is_cancelled(), "DLSS frame cancelled");
        let temporal = frame.temporal.as_ref().context("Missing temporal guides")?;
        let meta = temporal.metadata();
        let key = (frame.id.device, frame.id.target);
        let mut state = self.state.lock().unwrap();
        state
            .retired
            .retain(|t| t.flights.iter().any(|s| !s.is_retired()));
        let mut commands = Vec::new();
        if state
            .targets
            .get(&key)
            .is_some_and(|t| t.size != frame.size)
        {
            let old = state.targets.remove(&key).unwrap();
            state.retired.push(old);
        }
        if !state.targets.contains_key(&key) {
            // Backend switches can leave obsolete render identities behind.
            // Evict only fully retired features; active GPU work owns its SDK
            // history independently of whether its result was accepted.
            while state.targets.len() >= 4 {
                let oldest = state
                    .targets
                    .iter()
                    .filter(|(_, t)| t.flights.iter().all(|s| s.is_retired()))
                    .min_by_key(|(_, t)| t.last_frame)
                    .map(|(key, _)| *key);
                let Some(oldest) = oldest else {
                    break;
                };
                state.targets.remove(&oldest);
            }
            let (target, command) = self.target(&frame)?;
            state.targets.insert(key, target);
            commands.push(command);
        }
        let target = state.targets.get_mut(&key).unwrap();
        target.last_frame = frame.id.frame;
        target.flights.retain(|s| !s.is_retired());
        let reset = !temporal.reset_reasons().is_empty()
            || temporal.previous_metadata().is_none()
            || target
                .last
                .as_ref()
                .is_none_or(|s| s.acceptance() != api::DenoiseAcceptance::Accepted);
        let device = &frame.device;
        let inputs = [
            Guide::NoisyColor,
            Guide::DiffuseAlbedo,
            Guide::SpecularAlbedo,
            Guide::NormalRoughness,
            Guide::LinearDepth,
            Guide::Motion,
            Guide::Validity,
        ]
        .map(|g| temporal.guide(g).context("Missing DLSS guide"))
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
        let views = inputs
            .iter()
            .map(|t| t.create_view(&Default::default()))
            .collect::<Vec<_>>();
        let converted = target
            .textures
            .each_ref()
            .map(|t| t.create_view(&Default::default()));
        let previous = temporal.previous_metadata().unwrap_or(meta);
        let previous_vp = glam::Mat4::from_cols_array(&previous.camera.projection)
            * glam::Mat4::from_cols_array(&previous.camera.view);
        let mut uniforms = Vec::new();
        for matrix in [
            meta.camera.projection_inverse,
            meta.camera.view_inverse,
            previous_vp.to_cols_array(),
        ] {
            uniforms.extend(matrix.iter().flat_map(|v| v.to_le_bytes()));
        }
        uniforms.extend(
            [meta.jitter_pixels[0], meta.jitter_pixels[1], 0., 0.]
                .iter()
                .flat_map(|v| v.to_le_bytes()),
        );
        uniforms.extend(
            [
                u32::from(!reset),
                u32::from(meta.camera.kind == api::TemporalProjection::Orthographic),
                0,
                0,
            ]
            .iter()
            .flat_map(|v| v.to_le_bytes()),
        );
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: &uniforms,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let tex = |v| wgpu::BindingResource::TextureView(v);
        let prepare = group(
            device,
            &self.prepare,
            &[
                tex(&views[4]),
                tex(&views[5]),
                tex(&views[6]),
                tex(&converted[0]),
                tex(&converted[1]),
                tex(&converted[2]),
                uniform.as_entire_binding(),
            ],
        );
        let mut producer = device.create_command_encoder(&Default::default());
        dispatch(&mut producer, &self.prepare, &prepare, frame.size);
        let sdk_inputs = [
            inputs[0],
            inputs[1],
            inputs[2],
            inputs[3],
            &target.textures[0],
            &target.textures[1],
        ];
        producer.transition_resources(
            std::iter::empty(),
            sdk_inputs.iter().map(|texture| wgpu::TextureTransition {
                texture: *texture,
                selector: None,
                state: wgpu::TextureUses::RESOURCE,
            }),
        );
        let mut descriptors = [ffi::Texture::default(); 8];
        for (i, texture) in sdk_inputs.iter().enumerate() {
            let view = if i < 4 { &views[i] } else { &converted[i - 4] };
            descriptors[i] = gpu::descriptor(&self.runtime.gpu.adapter, texture, view, false);
        }
        // Specular distance is optional. Never pass a fabricated zero guide.
        descriptors[7] = gpu::descriptor(
            &self.runtime.gpu.adapter,
            &target.textures[2],
            &converted[2],
            true,
        );
        let mut native = device.create_command_encoder(&Default::default());
        let mut result = 0;
        // Native Vulkan clip coordinates have down-positive Y and Z in [0,1].
        let clip = glam::Mat4::from_cols_array(&[
            1., 0., 0., 0., 0., -1., 0., 0., 0., 0., 0.5, 0., 0., 0., 0.5, 1.,
        ]);
        let projection =
            (clip * glam::Mat4::from_cols_array(&meta.camera.projection)).to_cols_array();
        unsafe {
            native.as_hal_mut::<Vulkan, _, _>(|e| {
                let cmd = e.unwrap().raw_handle();
                for d in &descriptors[..6] {
                    gpu::barrier(&self.runtime.gpu.raw, cmd, d.image, true);
                }
                gpu::output_barrier(&self.runtime.gpu.raw, cmd, descriptors[7].image);
                result = (self.runtime.ngx.eval)(
                    target.feature.handle as ffi::Target,
                    cmd.as_raw(),
                    descriptors.as_ptr(),
                    8,
                    reset as u32,
                    -meta.jitter_pixels[0],
                    -meta.jitter_pixels[1],
                    meta.camera.view.as_ptr(),
                    projection.as_ptr(),
                    meta.delta_seconds * 1000.,
                );
                for d in &descriptors[..6] {
                    gpu::barrier(&self.runtime.gpu.raw, cmd, d.image, false);
                }
            });
        }
        if let Err(error) = ffi::check(result, "DLSS RR evaluate") {
            // Evaluation can mutate SDK history before returning an error.
            let old = state.targets.remove(&key).unwrap();
            state.retired.push(old);
            return Err(error);
        }
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("NGX MuTracer result"),
            size: frame.size[0] as u64 * frame.size[1] as u64 * 16,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let resolve = group(
            device,
            &self.resolve,
            &[
                tex(&converted[2]),
                tex(&views[6]),
                frame.buffers.color.as_entire_binding(),
                output.as_entire_binding(),
                frame.buffers.albedo.as_entire_binding(),
            ],
        );
        let mut consumer = device.create_command_encoder(&Default::default());
        dispatch(&mut consumer, &self.resolve, &resolve, frame.size);
        commands.extend([producer.finish(), native.finish(), consumer.finish()]);
        target.last = Some(frame.status());
        target.flights.push(frame.status());
        let reset_reasons = temporal.reset_reasons().to_vec();
        // The headless lifecycle check can cancel precisely after SDK encoding.
        before_submit();
        // This path uses the public frame submission and publication contract.
        // No queue waits, readbacks or CPU image uploads occur here.
        let output = frame
            .submit(commands, output)
            .map(api::DenoiseOutput::Resident)
            .map_err(anyhow::Error::msg);
        if output.is_ok() {
            state.evaluations += 1;
            state.resets += u64::from(reset);
            if reset {
                state.last_reset = reset_reasons;
            }
        } else {
            // Cancellation may discard the command buffer that created this
            // feature, or submission may fail after partially enqueuing work.
            // Recreate it next time and retain every older flight until retirement.
            let old = state.targets.remove(&key).unwrap();
            state.retired.push(old);
        }
        output
    }
    pub fn counts(&self) -> (u64, u64) {
        let s = self.state.lock().unwrap();
        (s.evaluations, s.resets)
    }
}
impl CustomDenoiser for Dlss {
    fn input_mode(&self) -> api::DenoiseInputMode {
        api::DenoiseInputMode::TemporalGpu
    }
    fn denoise(
        &self,
        input: api::DenoiseInput,
        cancel: api::CancelToken,
    ) -> std::result::Result<api::DenoiseOutput, String> {
        self.filter(input, cancel, || {})
            .map_err(|e| format!("{e:#}"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sdk_conversion_shaders_validate_and_emit_spirv() {
        for source in [include_str!("prepare.wgsl"), include_str!("resolve.wgsl")] {
            let module = naga::front::wgsl::parse_str(source).unwrap();
            let info = naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::empty(),
            )
            .validate(&module)
            .unwrap();
            assert!(
                !naga::back::spv::write_vec(&module, &info, &Default::default(), None)
                    .unwrap()
                    .is_empty()
            );
        }
    }
}
