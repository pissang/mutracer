use super::*;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

struct Cpu(bool);

struct ResidentCpuOutput(mpsc::Sender<DenoiseFrameStatus>);
impl CustomDenoiser for ResidentCpuOutput {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::ResidentGpu
    }
    fn denoise(
        &self,
        input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        self.0
            .send(input.resident.as_ref().unwrap().status())
            .unwrap();
        Ok(DenoiseOutput::Cpu(
            [0.2, 0.3, 0.4, 1.].repeat((input.size[0] * input.size[1]) as usize),
        ))
    }
}
#[test]
#[ignore = "requires real GPU; run npm run native:ci:gpu"]
fn resident_custom_cpu_output_publishes_the_same_frame_acceptance() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture(native_backend());
    let (send, receive) = mpsc::channel();
    render
        .set_custom_denoiser(
            Some(Arc::new(ResidentCpuOutput(send))),
            DenoiseSchedule::Converged,
        )
        .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    let status = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(status.acceptance(), DenoiseAcceptance::Accepted);
    let image = render.read_pixels(PixelKind::Denoised).unwrap();
    assert_eq!(
        image.data,
        [0.2, 0.3, 0.4, 1.].repeat((image.width * image.height) as usize)
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !status.is_retired() {
        engine.poll_device();
        assert!(Instant::now() < deadline);
    }
}

#[test]
#[ignore = "requires real GPU; run npm run native:ci:gpu"]
fn resident_snapshot_covers_images_larger_than_one_dispatch_dimension() {
    use wgpu::util::DeviceExt;
    let _lock = crate::abi_test_lock();
    let (engine, _) = fixture(native_backend());
    let gpu = &engine.inner.gpu;
    // The old 64-lane 1D dispatch exceeded the 65535-workgroup limit here.
    // Non-multiples of eight also exercise padding in both dimensions.
    let size = [2049u32, 2047u32];
    let count = size[0] as usize * size[1] as usize;
    let source = {
        let mut values = vec![0u8; count * 16];
        for (index, pixel) in values.chunks_exact_mut(16).enumerate() {
            let values = [
                index as f32 * 2.,
                (index / size[0] as usize) as f32 * 2.,
                -4.,
                2.,
            ];
            for (value, destination) in values.iter().zip(pixel.chunks_exact_mut(4)) {
                destination.copy_from_slice(&value.to_le_bytes());
            }
        }
        gpu.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Large resident snapshot input"),
                contents: &values,
                usage: wgpu::BufferUsages::STORAGE,
            })
    };
    let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let pipeline = super::custom_gpu::snapshot_pipeline(&gpu.device);
    let output =
        super::custom_gpu::snapshot_buffers(gpu, &pipeline, [&source; 3], size, 2).unwrap();
    let probes = [0, size[0] as usize - 1, size[0] as usize, count - 1];
    let readback = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Large snapshot corner probes"),
            contents: &[0; 192],
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    for (guide, buffer) in [&output.color, &output.normal, &output.albedo]
        .iter()
        .enumerate()
    {
        for (probe, index) in probes.iter().enumerate() {
            encoder.copy_buffer_to_buffer(
                buffer,
                (*index * 16) as u64,
                &readback,
                ((guide * 4 + probe) * 16) as u64,
                16,
            );
        }
    }
    let submission = gpu.queue.submit([encoder.finish()]);
    let (send, receive) = mpsc::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = send.send(result);
        });
    gpu.device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })
        .unwrap();
    receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert!(pollster::block_on(scope.pop()).is_none());
    let mapped = readback.slice(..).get_mapped_range().unwrap();
    for (probe, pixel) in mapped.chunks_exact(16).enumerate() {
        let index = probes[probe % 4];
        let actual: Vec<_> = pixel
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        assert_eq!(
            actual,
            [index as f32, (index / size[0] as usize) as f32, -2., 1.]
        );
    }
    println!(
        "{}x{} resident snapshot: all three guides match the first/last row probes",
        size[0], size[1]
    );
}

impl CustomDenoiser for Cpu {
    fn denoise(
        &self,
        input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        assert!(input.resident.is_none());
        let mut output = input.color;
        if self.0 {
            for (index, pixel) in output.chunks_exact_mut(4).enumerate() {
                for c in 0..3 {
                    pixel[c] = pixel[c] * 0.5
                        + input.normal[index * 4 + c] * 0.25
                        + input.albedo[index * 4 + c] * 0.125
                        + (index / input.size[0] as usize) as f32 * 0.01;
                }
            }
        }
        Ok(DenoiseOutput::Cpu(output))
    }
}
pub(super) struct Gpu {
    pub transform: bool,
    pub events: mpsc::Sender<(DenoiseFrameId, DenoiseFrameStatus)>,
}
impl CustomDenoiser for Gpu {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::ResidentGpu
    }
    fn denoise(
        &self,
        input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        assert!(
            input.color.is_empty()
                && input.normal.is_empty()
                && input.albedo.is_empty()
                && input.buffers.is_none()
        );
        let input = input.resident.unwrap();
        self.events.send((input.id, input.status())).unwrap();
        let source = input.buffers.color.clone();
        if !self.transform {
            return input.submit([], source).map(DenoiseOutput::Resident);
        }
        let shader = input.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None, source: wgpu::ShaderSource::Wgsl(format!(
                "@group(0) @binding(0) var<storage, read> color: array<vec4f>;\n@group(0) @binding(1) var<storage, read> normal: array<vec4f>;\n@group(0) @binding(2) var<storage, read> albedo: array<vec4f>;\n@group(0) @binding(3) var<storage, read_write> output: array<vec4f>;\n@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) p: vec3u) {{ let i = p.x; output[i] = vec4f(color[i].rgb * 0.5 + normal[i].rgb * 0.25 + albedo[i].rgb * 0.125 + f32(i / {}u) * 0.01, color[i].a); }}", input.size[0]).into())
        });
        let pipeline = input
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: None,
                layout: None,
                module: &shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let output = input.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: source.size(),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let resources = [
            &source,
            &input.buffers.normal,
            &input.buffers.albedo,
            &output,
        ];
        let group = input.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &resources
                .iter()
                .enumerate()
                .map(|(binding, buffer)| wgpu::BindGroupEntry {
                    binding: binding as u32,
                    resource: buffer.as_entire_binding(),
                })
                .collect::<Vec<_>>(),
        });
        let mut encoder = input.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(input.size[0] * input.size[1], 1, 1);
        }
        input
            .submit([encoder.finish()], output)
            .map(DenoiseOutput::Resident)
    }
}

/// Real-GPU backend for single-backend tests: Metal on macOS, Vulkan elsewhere.
pub(super) fn native_backend() -> wgpu::Backends {
    if cfg!(target_os = "macos") {
        wgpu::Backends::METAL
    } else {
        wgpu::Backends::VULKAN
    }
}

pub(super) fn fixture(backend: wgpu::Backends) -> (Engine, Render) {
    let mut descriptor = wgpu::InstanceDescriptor {
        backends: backend,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    };
    if backend == wgpu::Backends::DX12 {
        // The production megakernel requires DXC; use the same caller-owned
        // device setup as the packaged viewer instead of falling back to FXC.
        descriptor.backend_options.dx12.shader_compiler = wgpu::Dx12Compiler::DynamicDxc {
            dxc_path: std::env::var("MUTRACER_TEST_DXC")
                .unwrap_or_else(|_| "dxcompiler.dll".into()),
        };
    }
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .unwrap();
    assert!(!matches!(
        adapter.get_info().device_type,
        wgpu::DeviceType::Cpu | wgpu::DeviceType::Other
    ));
    println!("resident custom denoiser: {:?}", adapter.get_info());
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .unwrap();
    let engine = Engine::on_device(
        &adapter,
        &device,
        &queue,
        EngineOptions {
            backend: Backend::Software,
        },
        None,
    );
    engine.display().set_size(8, 6).unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            ..Default::default()
        },
    )
    .unwrap();
    engine.set_scene(&super::tests::lit_scene()).unwrap();
    engine.update().unwrap();
    (engine, render)
}

#[test]
#[ignore = "requires real Vulkan and DX12 GPUs; run npm run native:ci:gpu"]
fn resident_custom_identity_and_transform_use_registration_and_display_without_readbacks() {
    let _lock = crate::abi_test_lock();
    for backend in [wgpu::Backends::VULKAN, wgpu::Backends::DX12] {
        if cfg!(target_os = "macos")
            || (cfg!(target_os = "linux") && backend == wgpu::Backends::DX12)
        {
            continue;
        }
        let (engine, render) = fixture(backend);
        for transform in [false, true] {
            render
                .set_custom_denoiser(Some(Arc::new(Cpu(transform))), DenoiseSchedule::Converged)
                .unwrap();
            render.converge(ConvergeOptions::new(2)).unwrap();
            let reference = render.read_pixels(PixelKind::Denoised).unwrap();
            let raw = render.read_pixels(PixelKind::Hdr).unwrap();
            let (send, receive) = mpsc::channel();
            render
                .set_custom_denoiser(
                    Some(Arc::new(Gpu {
                        transform,
                        events: send,
                    })),
                    DenoiseSchedule::Converged,
                )
                .unwrap();
            let readbacks = engine.inner.gpu.queue.readback_count();
            let uploads = engine.lock().renders[&render.id()].display_uploads().0;
            render.converge(ConvergeOptions::new(2)).unwrap();
            let (id, status) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(status.acceptance(), DenoiseAcceptance::Accepted);
            assert_eq!(engine.inner.gpu.queue.readback_count(), readbacks);
            assert_eq!(
                engine.lock().renders[&render.id()].display_uploads().0,
                uploads
            );
            engine.display().present(&render).unwrap();
            assert_eq!(engine.inner.gpu.queue.readback_count(), readbacks);
            let output = render.read_pixels(PixelKind::Denoised).unwrap();
            assert_eq!(engine.inner.gpu.queue.readback_count(), readbacks + 1);
            let error = reference
                .data
                .iter()
                .zip(&output.data)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0f32, f32::max);
            assert!(error < 2e-6, "GPU/CPU output error {error}");
            assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), raw);
            let deadline = Instant::now() + Duration::from_secs(5);
            while !status.is_retired() {
                engine.poll_device();
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            assert_eq!(id.device, engine.inner.gpu.frame_device.id);
            println!(
                "resident identity transform={transform}: max error={error}, no scheduling readbacks/uploads, frame={id:?}"
            );
        }
    }
}

struct Held {
    entered: mpsc::Sender<(DenoiseFrameStatus, CancelToken)>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl CustomDenoiser for Held {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::ResidentGpu
    }
    fn denoise(
        &self,
        input: DenoiseInput,
        cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        let input = input.resident.unwrap();
        let source = input.buffers.color.clone();
        let status = input.status();
        let output = input.submit([], source)?;
        self.entered.send((status, cancel)).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(15))
            .unwrap();
        Ok(DenoiseOutput::Resident(output))
    }
}

#[test]
#[ignore = "requires real GPU; run npm run native:ci:gpu"]
fn resident_custom_cancel_replace_and_dispose_reject_without_joining_submitted_work() {
    let _lock = crate::abi_test_lock();
    for action in 0..3 {
        let (engine, render) = fixture(native_backend());
        let render = Arc::new(render);
        let (entered, receive) = mpsc::channel();
        let (release, released) = mpsc::channel();
        render
            .set_custom_denoiser(
                Some(Arc::new(Held {
                    entered,
                    release: Mutex::new(released),
                })),
                DenoiseSchedule::Converged,
            )
            .unwrap();
        let other = render.clone();
        let worker = std::thread::spawn(move || other.converge(ConvergeOptions::new(2)));
        let (status, cancel) = receive.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(status.acceptance(), DenoiseAcceptance::Pending);
        let started = Instant::now();
        match action {
            0 => render
                .set_custom_denoiser(None, DenoiseSchedule::Converged)
                .unwrap(),
            1 => {
                engine.clear_scene().unwrap();
                engine.update().unwrap();
            }
            _ => engine.dispose(),
        }
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(status.acceptance(), DenoiseAcceptance::Rejected);
        assert!(cancel.is_cancelled());
        release.send(()).unwrap();
        let _ = worker.join().unwrap();
    }
}

#[test]
#[ignore = "requires real GPU; run npm run native:ci:gpu"]
fn resident_custom_device_loss_rejects_a_submitted_unpublished_result() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture(native_backend());
    let loss = engine.device_loss_notifier();
    engine
        .inner
        .gpu
        .device
        .set_device_lost_callback(move |reason, message| {
            loss.notify(format!("{reason:?}: {message}"))
        });
    let render = Arc::new(render);
    let (entered, receive) = mpsc::channel();
    let (release, released) = mpsc::channel();
    render
        .set_custom_denoiser(
            Some(Arc::new(Held {
                entered,
                release: Mutex::new(released),
            })),
            DenoiseSchedule::Converged,
        )
        .unwrap();
    let worker_render = render.clone();
    let worker = std::thread::spawn(move || worker_render.converge(ConvergeOptions::new(2)));
    let (status, cancel) = receive.recv_timeout(Duration::from_secs(30)).unwrap();
    engine.inner.gpu.device.destroy();
    let deadline = Instant::now() + Duration::from_secs(5);
    while engine.update().is_ok() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(status.acceptance(), DenoiseAcceptance::Rejected);
    assert!(cancel.is_cancelled());
    release.send(()).unwrap();
    assert!(worker.join().unwrap().is_err());
    assert_eq!(
        render.read_pixels(PixelKind::Denoised).unwrap_err().status,
        Status::Unavailable
    );
}
