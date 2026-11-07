use super::*;

mod shader_tests {
    use super::*;
    #[test]
    fn output_kinds_and_center_destination_contract() {
        for (kind, expected) in [
            MetalOutput::Hdr,
            MetalOutput::Depth,
            MetalOutput::Display,
            MetalOutput::CenterDepth,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(MetalOutput::from_abi(kind as u32).unwrap(), expected);
        }
        assert_eq!(
            MetalOutput::from_abi(4).unwrap_err().status,
            Status::InvalidArgument
        );
        let size = wgpu::Extent3d {
            width: 96,
            height: 64,
            depth_or_array_layers: 1,
        };
        for format in [
            wgpu::TextureFormat::R32Float,
            wgpu::TextureFormat::Rgba32Float,
        ] {
            MetalOutput::CenterDepth
                .validate_destination(format, size, size)
                .unwrap();
            for wrong in [
                wgpu::Extent3d { width: 95, ..size },
                wgpu::Extent3d { height: 63, ..size },
            ] {
                assert_eq!(
                    MetalOutput::CenterDepth
                        .validate_destination(format, size, wrong)
                        .unwrap_err()
                        .status,
                    Status::InvalidArgument
                );
            }
        }
        for format in [
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureFormat::Rgba8Unorm,
        ] {
            assert_eq!(
                MetalOutput::CenterDepth
                    .validate_destination(format, size, size)
                    .unwrap_err()
                    .status,
                Status::InvalidArgument
            );
        }
    }
    #[test]
    fn every_export_shader_validates() {
        for (format, kind) in [
            (wgpu::TextureFormat::Rgba32Float, 0),
            (wgpu::TextureFormat::Rgba16Float, 0),
            (wgpu::TextureFormat::Rgba32Float, 1),
            (wgpu::TextureFormat::R32Float, 1),
            (wgpu::TextureFormat::Rgba8Unorm, 2),
        ] {
            for flip in [false, true] {
                let source = shader(format, kind, flip);
                let module = naga::front::wgsl::parse_str(&source)
                    .unwrap_or_else(|e| panic!("{}", e.emit_to_string(&source)));
                naga::valid::Validator::new(
                    naga::valid::ValidationFlags::all(),
                    naga::valid::Capabilities::all(),
                )
                .validate(&module)
                .unwrap();
            }
        }
    }
}

mod arithmetic_tests {
    use super::*;
    #[test]
    #[ignore = "requires a real Metal GPU; run npm run native:ci:gpu"]
    fn metal_hdr_transport_arithmetic_matches_ieee_f32() {
        let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
        let gpu = crate::GpuDevice::with_backend(0).unwrap();
        assert_eq!(gpu.info.backend, wgpu::Backend::Metal);
        let mut pairs = Vec::<[u32; 2]>::new();
        for a in [
            0, 1, 2, 0x7fffff, 0x800000, 0x800001, 0x3f000000, 0x3f800000, 0x3f800001, 0x3fffffff,
            0x7f7fffff, 0x80000000, 0x80800001, 0xbf800001,
        ] {
            for b in [
                1, 2, 0x7fffff, 0x800000, 0x3eaaaaab, 0x3f000000, 0x3f800000, 0x40400000,
                0x40e00000, 0x46800000, 0x7f7fffff,
            ] {
                pairs.push([a, b]);
            }
        }
        let mut seed = 12345u32;
        for _ in 0..10000 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let a = seed % 0x7f800000;
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let b = (seed % 0x7f7fffff) + 1;
            pairs.push([a, b]);
        }
        let helper = include_str!("metal-hdr-resolve.wgsl")
            .split("@group")
            .next()
            .unwrap();
        let source = format!(
            "{helper}\n@group(0) @binding(0) var<storage,read> input: array<vec2u>;\n@group(0) @binding(1) var<storage,read_write> output: array<vec2u>;\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {{if(id.x>=arrayLength(&input)){{return;}}let p=input[id.x];let a=bitcast<f32>(p.x);let b=bitcast<f32>(p.y);output[id.x]=vec2u(bitcast<u32>(ieeeDivide(a,b)),bitcast<u32>(ieeeMultiply(a,b)));}}"
        );
        let module = gpu
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: None,
                source: wgpu::ShaderSource::Wgsl(source.into()),
            });
        let pipeline = gpu
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: None,
                layout: None,
                module: &module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let input = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&pairs),
                usage: wgpu::BufferUsages::STORAGE,
            });
        let output = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: input.size(),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: input.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: output.as_entire_binding(),
                },
            ],
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups((pairs.len() as u32).div_ceil(64), 1, 1);
        }
        gpu.queue.submit([encoder.finish()]);
        let bytes = gpu
            .queue
            .read_buffer(&gpu.device, output.slice(..))
            .unwrap();
        let values: Vec<[u32; 2]> = bytemuck::pod_collect_to_vec(&bytes);
        for (i, ([a, b], actual)) in pairs.into_iter().zip(values).enumerate() {
            let a = f32::from_bits(a);
            let b = f32::from_bits(b);
            assert_eq!(
                actual,
                [(a / b).to_bits(), (a * b).to_bits()],
                "pair {i}: {a:?} / or * {b:?}"
            );
        }
    }
}

mod lifecycle_tests {
    use super::*;
    #[test]
    #[ignore = "requires a real Metal GPU; run npm run native:ci:gpu"]
    fn metal_imports_reject_stale_state_and_device_loss_is_terminal() {
        let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
        let raw = objc2_metal::MTLCreateSystemDefaultDevice().unwrap();
        let engine = unsafe {
            Engine::on_metal(
                Retained::as_ptr(&raw) as *mut c_void,
                std::ptr::null_mut(),
                EngineOptions::default(),
            )
        }
        .unwrap();
        assert!(engine.poll_metal_exports(0).unwrap());
        assert_eq!(
            engine.poll_metal_exports(1).unwrap_err().status,
            Status::InvalidArgument
        );
        assert_eq!(
            unsafe { engine.import_metal_image(std::ptr::null_mut()) }
                .err()
                .unwrap()
                .status,
            Status::InvalidArgument
        );
        assert_eq!(
            unsafe { engine.import_metal_timeline(std::ptr::null_mut()) }
                .err()
                .unwrap()
                .status,
            Status::InvalidArgument
        );
        engine
            .device_loss_notifier()
            .notify("injected loss notification");
        assert_eq!(
            engine.poll_metal_exports(0).unwrap_err().status,
            Status::Unavailable
        );
        assert_eq!(
            unsafe { engine.import_metal_timeline(std::ptr::null_mut()) }
                .err()
                .unwrap()
                .status,
            Status::Unavailable
        );
        engine.dispose();
        assert_eq!(
            engine.poll_metal_exports(0).unwrap_err().status,
            Status::InvalidHandle
        );
    }
}

#[test]
#[ignore = "requires a real Metal GPU; run npm run native:ci:gpu"]
fn completed_without_external_signal_reports_terminal_failure() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let device = objc2_metal::MTLCreateSystemDefaultDevice().unwrap();
    let engine = unsafe {
        Engine::on_metal(
            Retained::as_ptr(&device) as *mut c_void,
            std::ptr::null_mut(),
            EngineOptions::default(),
        )
    }
    .unwrap();
    let event = device.newSharedEvent().unwrap();
    let timeline =
        unsafe { engine.import_metal_timeline(Retained::as_ptr(&event) as *mut c_void) }.unwrap();
    {
        let mut state = engine.inner.metal.lock().unwrap();
        let state = state.as_mut().unwrap();
        state.sequence = 1;
        // A command-buffer callback can mean completion with a GPU error. Missing
        // native signals must quarantine the engine, rather than leave Busy forever.
        state.pending.push(Pending {
            sequence: 1,
            completed: Arc::new(AtomicBool::new(true)),
            done: timeline.event.clone(),
            value: 1,
            _textures: vec![],
            _sources: vec![],
            _ready: None,
        });
    }
    assert_eq!(
        engine.poll_metal_exports(0).unwrap_err().status,
        Status::Unavailable
    );
    assert!(engine.inner.gpu.loss.reason().is_some());
    assert_eq!(
        engine.poll_metal_exports(0).unwrap_err().status,
        Status::Unavailable
    );
    engine.dispose();
}

#[test]
#[ignore = "requires a real Metal GPU; run npm run native:ci:gpu"]
fn background_submissions_cannot_bypass_a_delayed_ready_signal() {
    use objc2_metal::{MTLCommandBuffer, MTLCommandQueue};
    use std::time::{Duration, Instant};
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let device = objc2_metal::MTLCreateSystemDefaultDevice().unwrap();
    let engine = unsafe {
        Engine::on_metal(
            Retained::as_ptr(&device) as *mut c_void,
            std::ptr::null_mut(),
            EngineOptions {
                backend: Backend::Software,
            },
        )
    }
    .unwrap();
    engine.set_scene(&crate::scene::tests::input()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        super::super::RenderSettings {
            size: super::super::RenderSize::Fixed {
                width: 16,
                height: 16,
            },
            ..Default::default()
        },
    )
    .unwrap();
    render
        .converge(super::super::ConvergeOptions::new(4))
        .unwrap();
    let output = engine
        .inner
        .gpu
        .device
        .create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: 16,
                height: 16,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
    let native = unsafe { output.as_hal::<Metal>() }.unwrap();
    let image =
        unsafe { engine.import_metal_image(native.raw_handle() as *const _ as *mut c_void) }
            .unwrap();
    drop(native);
    let ready = device.newSharedEvent().unwrap();
    let done = device.newSharedEvent().unwrap();
    let rt =
        unsafe { engine.import_metal_timeline(Retained::as_ptr(&ready) as *mut c_void) }.unwrap();
    let dt =
        unsafe { engine.import_metal_timeline(Retained::as_ptr(&done) as *mut c_void) }.unwrap();
    let queue = engine.inner.gpu.queue.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let end = stop.clone();
    let thread = std::thread::spawn(move || {
        while !end.load(Ordering::Acquire) {
            queue.submit([]);
            std::thread::sleep(Duration::from_micros(100));
        }
    });
    let sequence = render
        .export_metal(
            &[MetalExportImage {
                image: &image,
                kind: MetalOutput::Hdr,
                rows: MetalRowOrder::TopFirst,
            }],
            Some((&rt, 1)),
            (&dt, 1),
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let premature = done.signaledValue();
    // Always release before assertions, including on a regression, so failure
    // cannot strand the background worker or leave the native GPU queue blocked.
    let producer = device.newCommandQueue().unwrap();
    let signal = producer.commandBuffer().unwrap();
    signal.encodeSignalEvent_value(ready.as_ref(), 1);
    signal.commit();
    stop.store(true, Ordering::Release);
    thread.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !engine.poll_metal_exports(sequence).unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        premature, 0,
        "later submissions bypassed the host's ready wait"
    );
    assert!(done.signaledValue() >= 1);
    engine.dispose();
}
