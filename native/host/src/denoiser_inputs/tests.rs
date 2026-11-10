use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

pub(super) fn metadata() -> FrameMetadata {
    let identity = glam::Mat4::IDENTITY.to_cols_array();
    FrameMetadata {
        scene_revision: 1,
        camera_revision: 1,
        seed: 12345,
        sample_index: 0,
        sample_count: 1,
        jitter_pixels: [0.25, -0.25],
        input_extent: [8, 8],
        output_extent: [8, 8],
        camera: CameraSnapshot {
            view: identity,
            projection: identity,
            view_inverse: identity,
            projection_inverse: identity,
            near: 0.01,
            far: 100.0,
            kind: Projection::Perspective,
            aperture_radius: 0.0,
        },
        delta_seconds: 1.0 / 60.0,
        pre_exposure: 1.0,
        capabilities: InputCapabilities::default(),
    }
}
fn frame<R>(state: &mut FrameHistory<R>, resource: R) -> Arc<InputFrame<R>> {
    state
        .prepare(metadata(), GeometrySnapshot::default(), resource)
        .unwrap()
}
fn accept<R>(state: &mut FrameHistory<R>, frame: &Arc<InputFrame<R>>) -> FrameSubmission<R> {
    let receipt = FrameSubmission::test_submission(frame.clone());
    state.accept(&receipt).unwrap();
    receipt
}

#[test]
fn acceptance_is_ordered_per_target_and_independent_of_retirement() {
    let device = DeviceKey::new();
    let mut a = FrameHistory::new(device, [8, 8]);
    let mut b = FrameHistory::new(device, [8, 8]);
    let f1 = frame(&mut a, 1);
    assert_eq!(f1.previous_frame_id(), None);
    assert_eq!(f1.reset_reasons, [ResetReason::FirstFrame]);
    assert!(
        a.prepare(metadata(), GeometrySnapshot::default(), 2)
            .is_err()
    );
    let foreign = frame(&mut b, 9);
    assert!(
        a.accept(&FrameSubmission::test_submission(foreign.clone()))
            .is_err()
    );
    let receipt = accept(&mut a, &f1);
    assert!(!receipt.retired());
    assert_eq!(a.previous_frame_id(), Some(1));
    assert!(a.accept(&receipt).is_err());
    assert!(a.reject(f1.key()).is_err());
    let f2 = frame(&mut a, 2);
    assert_eq!(f2.previous_frame_id(), Some(1));
    assert!(f2.reset_reasons.is_empty());
    a.reject(f2.key()).unwrap();
    let f3 = frame(&mut a, 3);
    assert_eq!(f3.previous_frame_id(), Some(1));
    assert_eq!(f3.reset_reasons, [ResetReason::ConsumerRejected]);
    assert_eq!(f3.key().frame, 3);
    assert_eq!(b.previous_frame_id(), None);
    accept(&mut b, &foreign);
    assert_eq!(*foreign.current.resources(), 9);
}

// Access through a test-only helper keeps the production snapshot immutable.
impl<R> Snapshot<R> {
    fn resources(&self) -> &R {
        &self.resources
    }
}

#[test]
fn invalid_frames_do_not_consume_ids_or_replace_previous() {
    let mut history = FrameHistory::new(DeviceKey::new(), [8, 8]);
    for mutate in [
        |m: &mut FrameMetadata| m.camera.aperture_radius = 0.1,
        |m: &mut FrameMetadata| m.camera.view[0] = f32::NAN,
        |m: &mut FrameMetadata| m.camera.projection = [0.0; 16],
        |m: &mut FrameMetadata| m.output_extent = [16, 16],
        |m: &mut FrameMetadata| m.pre_exposure = 2.0,
        |m: &mut FrameMetadata| m.delta_seconds = 0.0,
        |m: &mut FrameMetadata| m.jitter_pixels[0] = 0.6,
        |m: &mut FrameMetadata| m.sample_count = 2,
    ] {
        let mut m = metadata();
        mutate(&mut m);
        assert!(history.prepare(m, GeometrySnapshot::default(), ()).is_err());
    }
    assert_eq!(frame(&mut history, ()).key().frame, 1);
}

#[test]
fn reset_resize_projection_and_loss_invalidate_stale_receipts() {
    let device = DeviceKey::new();
    let mut state = FrameHistory::new(device, [8, 8]);
    let f1 = frame(&mut state, ());
    let receipt = accept(&mut state, &f1);
    // Moving a camera and restarting raw accumulation do not call invalidate.
    let mut moving = metadata();
    moving.camera_revision = 2;
    moving.camera.view[12] = -1.0;
    moving.camera.view_inverse[12] = 1.0;
    moving.jitter_pixels = [-0.25, 0.25];
    let f2 = state
        .prepare(moving, GeometrySnapshot::default(), ())
        .unwrap();
    assert_eq!(f2.previous_frame_id(), Some(1));
    assert!(f2.reset_reasons.is_empty());
    state.resize([16, 8]);
    assert!(state.accept(&FrameSubmission::test_submission(f2)).is_err());
    let mut resized = metadata();
    resized.input_extent = [16, 8];
    resized.output_extent = [16, 8];
    let f3 = state
        .prepare(resized.clone(), GeometrySnapshot::default(), ())
        .unwrap();
    assert_eq!(f3.previous_frame_id(), None);
    assert!(f3.reset_reasons.contains(&ResetReason::ExtentChanged));
    assert!(f3.key().generation > f1.key().generation);
    accept(&mut state, &f3);
    resized.camera.kind = Projection::Orthographic;
    let f4 = state
        .prepare(resized, GeometrySnapshot::default(), ())
        .unwrap();
    assert!(f4.reset_reasons.contains(&ResetReason::ProjectionChanged));
    assert_eq!(f4.previous_frame_id(), None);
    state.device_lost();
    assert!(state.accept(&receipt).is_err());
    assert!(
        state
            .prepare(metadata(), GeometrySnapshot::default(), ())
            .is_err()
    );
}

struct DropCount(Arc<AtomicUsize>);

#[test]
fn projection_parameters_reset_history_but_camera_motion_does_not() {
    let mut history = FrameHistory::new(DeviceKey::new(), [8, 8]);
    let first = frame(&mut history, ());
    accept(&mut history, &first);
    let mut moved = metadata();
    moved.camera.view[12] = -0.25;
    moved.camera.view_inverse[12] = 0.25;
    let second = history
        .prepare(moved.clone(), GeometrySnapshot::default(), ())
        .unwrap();
    assert_eq!(second.previous_frame_id(), Some(first.key().frame));
    assert!(second.reset_reasons.is_empty());
    accept(&mut history, &second);
    moved.camera.projection[0] = 2.;
    moved.camera.projection_inverse[0] = 0.5;
    let third = history
        .prepare(moved, GeometrySnapshot::default(), ())
        .unwrap();
    assert_eq!(third.previous_frame_id(), None);
    assert_eq!(third.reset_reasons, [ResetReason::ProjectionChanged]);
    assert!(third.key().generation > second.key().generation);
}

impl Drop for DropCount {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
#[test]
fn history_has_no_recursive_resource_chain_and_leases_outlive_target() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let mut state = FrameHistory::new(DeviceKey::new(), [8, 8]);
    for _ in 0..20 {
        let f = frame(&mut state, DropCount(dropped.clone()));
        accept(&mut state, &f);
    }
    assert_eq!(dropped.load(Ordering::SeqCst), 19);
    let pending = frame(&mut state, DropCount(dropped.clone()));
    state.reject(pending.key()).unwrap();
    drop(state);
    // A borrowed frame keeps both itself and its exact previous snapshot alive.
    assert_eq!(dropped.load(Ordering::SeqCst), 19);
    drop(pending);
    assert_eq!(dropped.load(Ordering::SeqCst), 21);
}

#[test]
fn glass_capabilities_do_not_conflate_data_correspondence_and_rr() {
    let mut c = GlassCapabilities::default();
    assert_eq!(
        c.get(GlassKind::Thin, GlassMotion::Camera).data_ready,
        Support::Unverified
    );
    c.0.push(GlassCapability {
        kind: GlassKind::Thin,
        motion: GlassMotion::Static,
        data_ready: Support::Ready,
        temporal_correspondence: Support::Unverified,
        rr_validated: Support::Unverified,
    });
    c.validate().unwrap();
    assert_eq!(
        c.get(GlassKind::Solid, GlassMotion::Static).data_ready,
        Support::Unverified
    );
    c.0[0].data_ready = Support::Unverified;
    c.0[0].rr_validated = Support::Ready;
    assert!(c.validate().is_err());
    c.0[0].rr_validated = Support::Unverified;
    c.0.push(c.0[0].clone());
    assert!(c.validate().is_err());
}

#[test]
fn optical_record_layouts_keep_integer_identity_and_separate_terminal_guides() {
    use std::mem::{align_of, offset_of, size_of};
    assert_eq!(align_of::<GlassPixelRecord>(), 16);
    assert_eq!(size_of::<GlassSurfaceRecord>(), 80);
    assert_eq!(offset_of!(GlassSurfaceRecord, identity), 48);
    assert_eq!(size_of::<GlassMaterialRecord>(), 64);
    assert_eq!(size_of::<OpticalEventRecord>(), 80);
    assert_eq!(size_of::<TerminalGuideRecord>(), 112);
    assert_eq!(offset_of!(GlassBranchRecord, terminal), 144);
    assert_eq!(size_of::<GlassBranchRecord>(), 256);
    assert_eq!(offset_of!(GlassPixelRecord, reflection), 144);
    assert_eq!(offset_of!(GlassPixelRecord, transmission), 400);
    assert_eq!(size_of::<GlassPixelRecord>(), 672);
    let mut pixel = GlassPixelRecord::default();
    pixel.surface.identity = [u32::MAX, 17, 123, 99];
    pixel.reflection.terminal.identity = [7, 0, 2, 0];
    assert_ne!(pixel.surface.identity, pixel.reflection.terminal.identity);
    assert_eq!(pixel.surface.identity[0], u32::MAX);
}

#[test]
fn glass_recomposition_distinguishes_unsampled_geometry_and_zero_radiance() {
    let mut pixel = GlassPixelRecord::default();
    pixel.residual = [0.1, 0.2, 0.3, 0.0];
    pixel.reflection.state[0] = BranchSampling::RadianceSample as u32;
    pixel.reflection.flags[2] = 1;
    pixel.reflection.radiance = [1.0, 2.0, 3.0, 0.0];
    assert_eq!(pixel.recomposed_radiance().unwrap(), [1.1, 2.2, 3.3]);
    pixel.transmission.state[0] = BranchSampling::GeometryOnly as u32;
    pixel.transmission.radiance[0] = 0.01;
    assert!(pixel.recomposed_radiance().is_err());
    pixel.transmission.radiance[0] = 0.0;
    pixel.transmission.state[0] = BranchSampling::RadianceSample as u32;
    pixel.transmission.flags[2] = 1;
    assert!(pixel.recomposed_radiance().is_ok()); // A sampled black branch is valid.
    pixel.reflection.flags[2] = 0;
    assert!(pixel.recomposed_radiance().is_err());
}

#[test]
#[ignore = "requires real Vulkan and DX12 GPUs; run npm run native:ci:gpu"]
fn gpu_frame_leases_order_producer_consumer_and_retire_after_target_destruction() {
    for backend in [wgpu::Backends::VULKAN, wgpu::Backends::DX12] {
        if cfg!(target_os = "macos")
            || (cfg!(target_os = "linux") && backend == wgpu::Backends::DX12)
        {
            continue;
        }
        gpu_frame_lifecycle(backend);
    }
}
fn gpu_frame_lifecycle(backend: wgpu::Backends) {
    use crate::*;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: backend,
        ..wgpu::InstanceDescriptor::new_without_display_handle_from_env()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .unwrap();
    assert!(!matches!(
        adapter.get_info().device_type,
        wgpu::DeviceType::Cpu | wgpu::DeviceType::Other
    ));
    let gpu = GpuDevice::for_adapter(&adapter, 0).unwrap();
    println!("frame lifecycle adapter: {:?}", gpu.info);
    let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut state = GpuFrameHistory::new(gpu.frame_device, [8, 8]);
    let resources =
        GpuFrameResources::allocate(&gpu, [8, 8], &[Guide::NoisyColor, Guide::Validity], 1, 16)
            .unwrap();
    assert_eq!(resources.gpu_bytes, 8 * 8 * 20 + 672 + 16 * 80);
    let frame = state
        .prepare(metadata(), GeometrySnapshot::default(), resources)
        .unwrap();
    let weak = Arc::downgrade(&frame);
    let shader = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Frame lease producer test"), source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(
            "@group(0) @binding(0) var output: texture_storage_2d<rgba32float, write>;\n@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) p: vec3u) { textureStore(output, vec2i(p.xy), vec4f(1.0, 2.0, 3.0, 1.0)); }"))
    });
    let pipeline = gpu
        .device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(
                &frame
                    .current
                    .resources
                    .guide(Guide::NoisyColor)
                    .unwrap()
                    .view,
            ),
        }],
    });
    let mut producer = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = producer.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    let dependency = ProducerDependency::Commands {
        frame: frame.clone(),
        commands: vec![producer.finish()],
    }
    .submit_producer(&gpu)
    .unwrap();
    let output = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 8 * 256,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let receipt = state
        .evaluate_and_submit(&gpu, dependency, |frame| {
            let mut consumer = gpu.device.create_command_encoder(&Default::default());
            consumer.copy_texture_to_buffer(
                frame
                    .current
                    .resources
                    .guide(Guide::NoisyColor)
                    .unwrap()
                    .texture
                    .as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &output,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(256),
                        rows_per_image: Some(8),
                    },
                },
                wgpu::Extent3d {
                    width: 8,
                    height: 8,
                    depth_or_array_layers: 1,
                },
            );
            Ok(EvaluatedCommands {
                native: vec![],
                consumer: vec![consumer.finish()],
            })
        })
        .unwrap();
    assert_eq!(state.previous_frame_id(), Some(frame.key().frame));
    assert!(state.accept(&receipt).is_err());
    drop(state);
    drop(frame);
    drop(group);
    drop(pipeline);
    let (tx, rx) = mpsc::channel();
    output
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| tx.send(result).unwrap());
    gpu.device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(15)),
        })
        .unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    assert!(receipt.retired());
    let bytes = output.slice(..).get_mapped_range().unwrap();
    for row in bytes.chunks_exact(256) {
        for pixel in row[..128].chunks_exact(16) {
            let values: Vec<_> = pixel
                .chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            assert_eq!(values, [1.0, 2.0, 3.0, 1.0]);
        }
    }
    drop(bytes);
    output.unmap();
    drop(receipt);
    assert!(weak.upgrade().is_none());
    assert!(pollster::block_on(scope.pop()).is_none());
}
