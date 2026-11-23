//! Optional application adapter. The native SDK has no NVIDIA dependency.
mod ffi;
mod gpu;
mod profile;
mod replay;
use anyhow::{Context, Result, ensure};
use ash::vk::Handle;
use mutracer_native::api::{self, CustomDenoiser, TemporalGuide as Guide};
pub use profile::run as profile_1080p;
pub use replay::run as replay_sequence;
use replay::{Evaluation, FrameParameters, GUIDE_KINDS};
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
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
enum SpecularGuide {
    Off,
    Motion,
    Distance,
}
impl SpecularGuide {
    fn from_environment() -> Result<Self> {
        match std::env::var("MUTRACER_DLSS_SPECULAR").as_deref() {
            Ok("motion") => Ok(Self::Motion),
            Ok("distance") => Ok(Self::Distance),
            Ok("off") | Err(std::env::VarError::NotPresent) => Ok(Self::Off),
            _ => Err(anyhow::anyhow!(
                "MUTRACER_DLSS_SPECULAR accepts off, motion or distance"
            )),
        }
    }
}
struct OpticalInput {
    kind: SpecularGuide,
    pipeline: wgpu::ComputePipeline,
    format: wgpu::TextureFormat,
}
#[derive(Clone, Copy, Debug)]
enum MaterialGuideMapping {
    DiffuseReinhard,
    CameraNormal,
}
impl MaterialGuideMapping {
    fn from_environment() -> Result<Option<Self>> {
        match std::env::var("MUTRACER_DLSS_MATERIAL_GUIDE").as_deref() {
            Ok("diffuse-reinhard") => Ok(Some(Self::DiffuseReinhard)),
            Ok("camera-normal") => Ok(Some(Self::CameraNormal)),
            Ok("physical") | Err(std::env::VarError::NotPresent) => Ok(None),
            _ => anyhow::bail!(
                "MUTRACER_DLSS_MATERIAL_GUIDE accepts physical, diffuse-reinhard or camera-normal"
            ),
        }
    }
    fn input_index(self) -> usize {
        match self {
            Self::DiffuseReinhard => 1,
            Self::CameraNormal => 3,
        }
    }
}
struct MaterialGuideInput {
    mapping: MaterialGuideMapping,
    pipeline: wgpu::ComputePipeline,
}
struct Encoded {
    commands: [wgpu::CommandBuffer; 3],
    output: wgpu::Buffer,
    guide: SpecularGuide,
    timer: Option<profile::Stages>,
}
struct Target {
    feature: Feature,
    size: [u32; 2],
    output_size: [u32; 2],
    textures: [wgpu::Texture; 3], // converted depth, motion, SDK output
    optical: Option<wgpu::Texture>,
    mapped_guide: Option<wgpu::Texture>,
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
const SDK_VERSION: &str = "310.9.16";

pub struct Dlss {
    state: Mutex<State>,
    prepare: wgpu::ComputePipeline,
    resolve: wgpu::ComputePipeline,
    runtime: Arc<Runtime>,
    trace: bool,
    preset: u32,
    input_samples: u32,
    output_scale: u32,
    optical: Option<OpticalInput>,
    material_guide: Option<MaterialGuideInput>,
    capture: Option<replay::Capture>,
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
    pub fn new(directory: &Path) -> Result<Arc<Self>> {
        Self::new_internal(directory, None)
    }
    fn new_internal(directory: &Path, capture: Option<replay::Capture>) -> Result<Arc<Self>> {
        // NGX configuration is process-wide. Only the startup path creates an
        // adapter; share the returned Arc between all renders and windows.
        static CREATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        ensure!(
            !CREATED.swap(true, std::sync::atomic::Ordering::AcqRel),
            "DLSS runtime already created in this process"
        );
        let guide = SpecularGuide::from_environment()?;
        let guide_mapping = MaterialGuideMapping::from_environment()?;
        let preset = match std::env::var("MUTRACER_DLSS_PRESET").as_deref() {
            Ok("default") | Err(std::env::VarError::NotPresent) => 0,
            Ok("D") => 4,
            Ok("E") => 5,
            Ok("F") => 6,
            _ => anyhow::bail!("MUTRACER_DLSS_PRESET accepts default, D, E or F"),
        };
        let input_samples = match std::env::var("MUTRACER_DLSS_INPUT_SPP").as_deref() {
            Ok("1") | Err(std::env::VarError::NotPresent) => 1,
            Ok("2") => 2,
            Ok("4") => 4,
            _ => return Err(anyhow::anyhow!("MUTRACER_DLSS_INPUT_SPP accepts 1, 2 or 4")),
        };
        let output_scale = match std::env::var("MUTRACER_DLSS_OUTPUT_SCALE").as_deref() {
            Ok("1") | Err(std::env::VarError::NotPresent) => 1,
            Ok("2") => 2,
            _ => anyhow::bail!("MUTRACER_DLSS_OUTPUT_SCALE accepts 1 or 2"),
        };
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
        let material_guide = guide_mapping.map(|mapping| MaterialGuideInput {
            mapping,
            pipeline: pipeline(
                &runtime.gpu.device,
                "NGX material guide mapping",
                include_str!("material-guide.wgsl"),
            ),
        });
        let optical = match guide {
            SpecularGuide::Off => None,
            kind => {
                let (format, name, value) = match kind {
                    SpecularGuide::Motion => (
                        wgpu::TextureFormat::Rg32Float,
                        "rg32float",
                        "vec4f(select(vec2f(size) * 2.0, record.xy, record.z > 0.0), 0.0, 0.0)",
                    ),
                    SpecularGuide::Distance => {
                        (wgpu::TextureFormat::R32Float, "r32float", "vec4f(record.w)")
                    }
                    SpecularGuide::Off => unreachable!(),
                };
                let shader = include_str!("specular.wgsl")
                    .replace("GUIDE_FORMAT", name)
                    .replace("GUIDE_VALUE", value);
                Some(OpticalInput {
                    kind,
                    format,
                    pipeline: pipeline(
                        &runtime.gpu.device,
                        "NGX optical guide conversion",
                        &shader,
                    ),
                })
            }
        };
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
            input_samples,
            output_scale,
            optical,
            material_guide,
            capture,
            state: Mutex::new(State::default()),
            trace: std::env::var("MUTRACER_DLSS_TRACE").as_deref() == Ok("1"),
            preset,
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
    fn target(
        &self,
        size: [u32; 2],
        output_size: [u32; 2],
        frame_id: u64,
    ) -> Result<(Target, wgpu::CommandBuffer)> {
        let device = &self.runtime.gpu.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("NGX feature creation"),
        });
        let mut handle = std::ptr::null_mut();
        let mut result = 0;
        unsafe {
            encoder.as_hal_mut::<Vulkan, _, _>(|e| {
                result = (self.runtime.ngx.create)(
                    e.unwrap().raw_handle().as_raw(),
                    size[0],
                    size[1],
                    output_size[0],
                    output_size[1],
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
            "DLSS RR create (try MUTRACER_DLSS_PRESET=D on older drivers)",
        )?;
        let image = |format, size: [u32; 2]| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("NGX owned image"),
                size: wgpu::Extent3d {
                    width: size[0],
                    height: size[1],
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };
        let textures = [
            image(wgpu::TextureFormat::R32Float, size),
            image(wgpu::TextureFormat::Rg32Float, size),
            image(wgpu::TextureFormat::Rgba32Float, output_size),
        ];
        Ok((
            Target {
                feature,
                textures,
                optical: self.optical.as_ref().map(|input| image(input.format, size)),
                mapped_guide: self
                    .material_guide
                    .as_ref()
                    .map(|_| image(wgpu::TextureFormat::Rgba32Float, size)),
                size,
                output_size,
                last: None,
                flights: Vec::new(),
                last_frame: frame_id,
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
        let output_size = frame.output_size();
        let key = (frame.id.device, frame.id.target);
        let mut state = self.state.lock().unwrap();
        state
            .retired
            .retain(|t| t.flights.iter().any(|s| !s.is_retired()));
        let mut commands = Vec::new();
        let resized = state
            .targets
            .get(&key)
            .is_some_and(|t| t.size != frame.size || t.output_size != output_size);
        if resized {
            let old = state.targets.remove(&key).unwrap();
            state.retired.push(old);
        }
        let created = !state.targets.contains_key(&key);
        if created {
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
            let (target, command) = self.target(frame.size, output_size, frame.id.frame)?;
            state.targets.insert(key, target);
            commands.push(command);
        }
        let capture_index = state.evaluations;
        let target = state.targets.get_mut(&key).unwrap();
        let frame_id = frame.id.frame;
        let previous_submission = target.last.as_ref().map(|_| target.last_frame);
        target.last_frame = frame_id;
        target.flights.retain(|s| !s.is_retired());
        let previous_accepted = target
            .last
            .as_ref()
            .is_some_and(|last| last.acceptance() == api::DenoiseAcceptance::Accepted);
        let reset = !temporal.reset_reasons().is_empty()
            || temporal.previous_metadata().is_none()
            || !previous_accepted;
        let inputs = GUIDE_KINDS
            .map(|kind| temporal.guide(kind).context("Missing DLSS guide"))
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        let previous = temporal.previous_metadata().unwrap_or(meta);
        let params = FrameParameters {
            reset,
            stationary: !reset
                && meta.scene_revision == previous.scene_revision
                && meta.camera_revision == previous.camera_revision,
            orthographic: meta.camera.kind == api::TemporalProjection::Orthographic,
            jitter: meta.jitter_pixels,
            delta_ms: meta.delta_seconds * 1000.,
            view: meta.camera.view,
            projection: meta.camera.projection,
            projection_inverse: meta.camera.projection_inverse,
            view_inverse: meta.camera.view_inverse,
            previous_view_projection: (glam::Mat4::from_cols_array(&previous.camera.projection)
                * glam::Mat4::from_cols_array(&previous.camera.view))
            .to_cols_array(),
        };
        let evaluation = Evaluation {
            params: &params,
            inputs: inputs.try_into().unwrap(),
            specular: temporal.guide(Guide::SpecularReflection),
            color: &frame.buffers.color,
            albedo: &frame.buffers.albedo,
        };
        let encoded = match self.encode(target, &evaluation, true) {
            Ok(encoded) => encoded,
            Err(error) => {
                // Evaluation can mutate SDK history before returning an error.
                let old = state.targets.remove(&key).unwrap();
                state.retired.push(old);
                return Err(error);
            }
        };
        let Encoded {
            commands: passes,
            output,
            guide,
            timer,
        } = encoded;
        commands.extend(passes);
        let capture = match self
            .capture
            .as_ref()
            .map(|capture| {
                let record =
                    capture.record(&frame.device, target, &evaluation, &output, &mut commands)?;
                Ok::<_, anyhow::Error>((capture, frame.device.clone(), record))
            })
            .transpose()
        {
            Ok(capture) => capture,
            Err(error) => {
                let old = state.targets.remove(&key).unwrap();
                state.retired.push(old);
                return Err(error);
            }
        };
        target.last = Some(frame.status());
        target.flights.push(frame.status());
        let reset_reasons = temporal.reset_reasons().to_vec();
        let sample_index = meta.sample_index;
        let trace = self.trace.then(|| {
            let reasons = reset_reasons.iter().map(|reason| format!("{reason:?}")).collect::<Vec<_>>();
            serde_json::json!({
                "dlssEvaluation": {
                    "target": key.1, "frame": frame_id, "previousSubmission": previous_submission,
                    "previousAccepted": previous_accepted, "previousSequence": temporal.previous_metadata().map(|m| m.sample_index),
                    "sequence": meta.sample_index, "samples": meta.sample_count, "jitter": meta.jitter_pixels,
                    "size": meta.input_extent, "outputSize": meta.output_extent,
                    "preset": self.preset, "sdk": SDK_VERSION, "backend": "vulkan",
                    "reset": reset, "reasons": reasons, "newTarget": created, "resized": resized,
                    "specularGuide": format!("{guide:?}"), "temporalBytes": temporal.resident_frame_bytes(),
                    "materialGuide": self.material_guide.as_ref().map(|g| format!("{:?}", g.mapping)),
                }
            })
        });
        // The headless lifecycle check can cancel precisely after SDK encoding.
        before_submit();
        // This path uses the public frame submission and publication contract.
        // Only offscreen capture reads back the adapter inputs and result.
        let output = frame
            .submit(commands, output)
            .map(api::DenoiseOutput::Resident)
            .map_err(anyhow::Error::msg);
        if let Some(mut trace) = trace {
            trace["dlssEvaluation"]["submitted"] = serde_json::Value::Bool(output.is_ok());
            eprintln!("{trace}");
        }
        if output.is_ok() {
            if let Some(timer) = timer {
                timer.log(frame_id, sample_index);
            }
            if let Some((capture, device, record)) = capture {
                capture.save(&device, capture_index, record)?;
            }
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
    fn encode(
        &self,
        target: &Target,
        evaluation: &Evaluation<'_>,
        profile: bool,
    ) -> Result<Encoded> {
        let device = &self.runtime.gpu.device;
        let Target {
            size, output_size, ..
        } = *target;
        let Evaluation {
            params,
            inputs,
            specular,
            color,
            albedo,
        } = *evaluation;
        let views = inputs
            .iter()
            .map(|t| t.create_view(&Default::default()))
            .collect::<Vec<_>>();
        let converted = target
            .textures
            .each_ref()
            .map(|t| t.create_view(&Default::default()));
        let mut uniforms = Vec::new();
        for matrix in [
            params.projection_inverse,
            params.view_inverse,
            params.previous_view_projection,
        ] {
            uniforms.extend(matrix.iter().flat_map(|v| v.to_le_bytes()));
        }
        uniforms.extend(
            [params.jitter[0], params.jitter[1], 0., 0.]
                .iter()
                .flat_map(|v| v.to_le_bytes()),
        );
        uniforms.extend(
            [
                u32::from(!params.reset),
                u32::from(params.orthographic),
                u32::from(params.stationary),
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
        let timer = profile
            .then(|| profile::Stages::new(device, &self.runtime.gpu.queue))
            .flatten();
        if let Some(timer) = &timer {
            timer.stamp(&mut producer, 0);
        }
        dispatch(&mut producer, &self.prepare, &prepare, size);
        let mut sdk_inputs = [
            inputs[0],
            inputs[1],
            inputs[2],
            inputs[3],
            &target.textures[0],
            &target.textures[1],
        ];
        let mut sdk_views = [
            &views[0],
            &views[1],
            &views[2],
            &views[3],
            &converted[0],
            &converted[1],
        ];
        let mapped_view = target
            .mapped_guide
            .as_ref()
            .map(|t| t.create_view(&Default::default()));
        if let (Some(convert), Some(texture), Some(view)) =
            (&self.material_guide, &target.mapped_guide, &mapped_view)
        {
            let index = convert.mapping.input_index();
            let mut options: Vec<_> = params.view.iter().flat_map(|v| v.to_le_bytes()).collect();
            options.extend(
                [u32::from(index == 3), 0, 0, 0]
                    .iter()
                    .flat_map(|v| v.to_le_bytes()),
            );
            let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: &options,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let mapping = group(
                device,
                &convert.pipeline,
                &[tex(&views[index]), tex(view), uniform.as_entire_binding()],
            );
            dispatch(&mut producer, &convert.pipeline, &mapping, size);
            sdk_inputs[index] = texture;
            sdk_views[index] = view;
        }
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
            descriptors[i] =
                gpu::descriptor(&self.runtime.gpu.adapter, texture, sdk_views[i], false);
        }
        let mut guide = SpecularGuide::Off;
        if let (Some(convert), Some(texture), Some(input)) =
            (&self.optical, &target.optical, specular)
        {
            let input_view = input.create_view(&Default::default());
            let output_view = texture.create_view(&Default::default());
            let bind_group = group(
                device,
                &convert.pipeline,
                &[
                    wgpu::BindingResource::TextureView(&input_view),
                    wgpu::BindingResource::TextureView(&output_view),
                ],
            );
            dispatch(&mut producer, &convert.pipeline, &bind_group, size);
            producer.transition_resources(
                std::iter::empty(),
                std::iter::once(wgpu::TextureTransition {
                    texture,
                    selector: None,
                    state: wgpu::TextureUses::RESOURCE,
                }),
            );
            descriptors[6] =
                gpu::descriptor(&self.runtime.gpu.adapter, texture, &output_view, false);
            guide = convert.kind;
        }
        descriptors[7] = gpu::descriptor(
            &self.runtime.gpu.adapter,
            &target.textures[2],
            &converted[2],
            true,
        );
        if let Some(timer) = &timer {
            timer.stamp(&mut producer, 1);
        }
        let mut native = device.create_command_encoder(&Default::default());
        let mut result = 0;
        // Native Vulkan clip coordinates have down-positive Y and Z in [0,1].
        let clip = glam::Mat4::from_cols_array(&[
            1., 0., 0., 0., 0., -1., 0., 0., 0., 0., 0.5, 0., 0., 0., 0.5, 1.,
        ]);
        let projection = (clip * glam::Mat4::from_cols_array(&params.projection)).to_cols_array();
        unsafe {
            native.as_hal_mut::<Vulkan, _, _>(|e| {
                let cmd = e.unwrap().raw_handle();
                for d in descriptors[..7].iter().filter(|d| d.image != 0) {
                    gpu::barrier(&self.runtime.gpu.raw, cmd, d.image, true);
                }
                gpu::output_barrier(&self.runtime.gpu.raw, cmd, descriptors[7].image);
                result = (self.runtime.ngx.eval)(
                    target.feature.handle as ffi::Target,
                    cmd.as_raw(),
                    descriptors.as_ptr(),
                    8,
                    params.reset as u32,
                    guide as u32,
                    -params.jitter[0],
                    -params.jitter[1],
                    params.view.as_ptr(),
                    projection.as_ptr(),
                    params.delta_ms,
                );
                for d in descriptors[..7].iter().filter(|d| d.image != 0) {
                    gpu::barrier(&self.runtime.gpu.raw, cmd, d.image, false);
                }
            });
        }
        ffi::check(result, "DLSS RR evaluate")?;
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("NGX MuTracer result"),
            size: u64::from(output_size[0]) * u64::from(output_size[1]) * 16,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let resolve = group(
            device,
            &self.resolve,
            &[
                tex(&converted[2]),
                tex(&views[6]),
                color.as_entire_binding(),
                output.as_entire_binding(),
                albedo.as_entire_binding(),
            ],
        );
        let mut consumer = device.create_command_encoder(&Default::default());
        if let Some(timer) = &timer {
            timer.stamp(&mut consumer, 2);
        }
        dispatch(&mut consumer, &self.resolve, &resolve, output_size);
        if let Some(timer) = &timer {
            timer.stamp(&mut consumer, 3);
            timer.resolve(&mut consumer);
        }
        Ok(Encoded {
            commands: [producer.finish(), native.finish(), consumer.finish()],
            output,
            guide,
            timer,
        })
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
    fn temporal_sample_count(&self) -> u32 {
        self.input_samples
    }
    fn temporal_output_scale(&self) -> u32 {
        self.output_scale
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
        for source in [
            include_str!("prepare.wgsl"),
            include_str!("resolve.wgsl"),
            include_str!("material-guide.wgsl"),
        ] {
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
