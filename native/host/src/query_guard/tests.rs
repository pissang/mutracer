use super::*;
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn guarded_replay_restores_all_accumulations_and_preserves_the_verified_prefix() {
    let _test = crate::abi_test_lock();
    let _entry = crate::entry_lock();
    let gpu = GpuDevice::with_backend(1).unwrap();
    if gpu.info.backend != wgpu::Backend::Metal {
        return;
    }
    gpu.recovery_test.lock().unwrap().query_window = true;
    let mut input = crate::scene::tests::translated_camera_input();
    let slot = layout::header::MATERIAL_OFFSET * 4;
    let material = u32::from_le_bytes(input[slot..slot + 4].try_into().unwrap()) as usize;
    // An undetected primary miss must change radiance even without a scene light.
    for word in layout::material::EMISSION_COLOR..=layout::material::EMISSION_LUMINANCE {
        let offset = 4 * (material + word);
        input[offset..offset + 4].copy_from_slice(&1f32.to_le_bytes());
    }
    let (mut scene, mut assets, _) = crate::scene::prepare_retained(&input, true).unwrap();
    scene.hwrt = Some(
        crate::hardware::capture_from_resources(&mut assets, scene.native_layout.as_ref().unwrap())
            .unwrap(),
    );
    let (renderer, mut target) = GpuScene::new(
        scene,
        &RenderOptions {
            flags: 4,
            ..Default::default()
        },
        &assets,
        gpu.clone(),
    )
    .unwrap();
    let read = |target: &Target| {
        (0..4)
            .map(|i| {
                gpu.queue
                    .read_buffer(&gpu.device, target.output(i).unwrap().slice(..))
                    .unwrap()
            })
            .collect::<Vec<_>>()
    };
    renderer.add_samples(&mut target, 9).unwrap();
    let expected = read(&target);
    let visible = renderer.read_target(&target, 0).unwrap();
    renderer.add_samples(&mut target, 1).unwrap();
    let expected10 = read(&target);
    renderer.reset_target(&mut target).unwrap();
    renderer.add_samples(&mut target, 4).unwrap();
    gpu.recovery_test.lock().unwrap().silent_sample = Some(6);
    renderer.add_samples(&mut target, 4).unwrap();
    renderer.add_samples(&mut target, 1).unwrap();
    assert_eq!(
        read(&target),
        expected,
        "tail failure escaped checkpoint replay"
    );
    assert_eq!(gpu.recovery_test.lock().unwrap().repairs, 1);
    // A bad tail is intentionally not a dependency of the next submission.
    // Its poisoned image may not replace a verified checkpoint or be read.
    renderer.reset_target(&mut target).unwrap();
    renderer.add_samples(&mut target, 4).unwrap();
    gpu.recovery_test.lock().unwrap().silent_sample = Some(6);
    let first = renderer.dispatch_target(&target, 4, 4, None).unwrap();
    GpuDevice::wait(&gpu.device).unwrap();
    assert!(first.require_success("deferred tail").is_ok());
    let next = renderer.dispatch_target(&target, 8, 1, None).unwrap();
    GpuDevice::wait(&gpu.device).unwrap();
    assert!(next.require_success("following batch").is_ok());
    target.samples = 9;
    assert_ne!(
        read(&target),
        expected,
        "fault injection did not poison output"
    );
    drop(first);
    drop(next);
    {
        let mut state = target.sampling_batch.as_ref().unwrap().lock().unwrap();
        Arc::get_mut(state.checkpoint.as_mut().unwrap())
            .unwrap()
            .captured = std::time::Instant::now() - Duration::from_secs(2);
    }
    {
        let mut hook = gpu.recovery_test.lock().unwrap();
        hook.repair_failures = 2;
        hook.restore_failures = 1;
    }
    renderer.add_samples(&mut target, 1).unwrap();
    assert_eq!(
        read(&target),
        expected10,
        "an unverified epoch became a checkpoint"
    );
    assert_eq!(
        target
            .sampling_batch
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .checkpoint
            .as_ref()
            .unwrap()
            .start,
        9
    );
    assert_eq!(gpu.recovery_test.lock().unwrap().repair_failures, 0);
    assert_eq!(gpu.recovery_test.lock().unwrap().restore_failures, 0);
    renderer.reset_target(&mut target).unwrap();
    renderer.add_samples(&mut target, 4).unwrap();
    let mut failed = renderer.dispatch_target(&target, 4, 4, None).unwrap();
    GpuDevice::wait(&gpu.device).unwrap();
    // Damage every plane, including an otherwise-zero shadow catcher, so
    // a missing restoration copy cannot hide behind that scene's zeros.
    for plane in 0..4 {
        gpu.queue
            .write_buffer(target.output(plane).unwrap(), 0, &1e6f32.to_le_bytes());
    }
    gpu.queue.submit([]);
    GpuDevice::wait(&gpu.device).unwrap();
    failed.injected_error = Some("controlled torn accumulation store".into());
    failed.injected_kind = Some(native_completion::FailureKind::Retry);
    renderer
        .repair_target(
            &target,
            4,
            8,
            &failed,
            "controlled torn accumulation store".into(),
        )
        .unwrap();
    target.samples = 8;
    renderer.add_samples(&mut target, 1).unwrap();
    assert_eq!(read(&target), expected);
    // An output read between private SDK chunks must verify the pending epoch.
    renderer.reset_target(&mut target).unwrap();
    renderer.add_samples(&mut target, 4).unwrap();
    gpu.recovery_test.lock().unwrap().silent_sample = Some(6);
    for (start, count) in [(4, 4), (8, 1)] {
        let chunk = renderer
            .dispatch_target(&target, start, count, None)
            .unwrap();
        GpuDevice::wait(&gpu.device).unwrap();
        chunk.require_success("internal chunk").unwrap();
        target.samples = start + count;
    }
    let before = gpu.recovery_test.lock().unwrap().repairs;
    assert_ne!(read(&target), expected);
    assert_eq!(renderer.read_target(&target, 0).unwrap(), visible);
    assert_eq!(read(&target), expected);
    renderer.read_hdr(&target).unwrap();
    assert_eq!(gpu.recovery_test.lock().unwrap().repairs, before + 1);
    failed.injected_error = None;
    failed.injected_kind = None;
    // Deliver the checkpoint-copy error before its first completion check.
    // A completed Metal command buffer has an immutable final status.
    failed.checkpoint = Some(Arc::new(Checkpoint::capture(
        &renderer,
        &target,
        target.samples,
    )));
    GpuDevice::wait(&gpu.device).unwrap();
    {
        let mut proof = failed.checkpoint.as_ref().unwrap().native.lock().unwrap();
        proof.injected_error = Some("controlled invalid checkpoint".into());
        proof.injected_kind = Some(native_completion::FailureKind::Retry);
    }
    assert!(
        failed
            .check("invalid checkpoint")
            .unwrap_err()
            .to_string()
            .contains("controlled invalid checkpoint")
    );
    assert_eq!(
        failed.failure_kind(),
        native_completion::FailureKind::Unrecoverable
    );
    // Measure a healthy sample on this TLAS, then start the fault halfway
    // through that query sequence. Persist the ticket counter across replay.
    let window = renderer
        .query_guard
        .as_ref()
        .unwrap()
        .resources
        .window
        .as_ref()
        .unwrap();
    let reset_window = |lo: u32, hi: u32| {
        gpu.queue
            .write_buffer(window, 0, bytemuck::cast_slice(&[0u32, lo, hi, 0, 0]))
    };
    let counts = || {
        let bytes = gpu
            .queue
            .read_buffer(&gpu.device, window.slice(..))
            .unwrap();
        bytes
            .chunks_exact(4)
            .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
            .collect::<Vec<_>>()
    };
    renderer.reset_target(&mut target).unwrap();
    reset_window(0, 0);
    renderer.add_samples(&mut target, 1).unwrap();
    let queries = counts()[0];
    assert!(queries > 0);
    let healthy = read(&target);
    // Search a short global query interval, including the canary calls. A
    // masked scene query may be a genuine miss and leave every pixel unchanged.
    let mut escaped = false;
    for start in 0..queries {
        renderer.reset_target(&mut target).unwrap();
        reset_window(start, start + 1);
        let mut batch = renderer.dispatch_target(&target, 0, 1, None).unwrap();
        GpuDevice::wait(&gpu.device).unwrap();
        let observed = counts();
        if observed[3] == 0 || observed[4] != 0 {
            continue;
        }
        batch.require_success("short query window").unwrap();
        assert!(!renderer.verify_sampling_target(&target, 1).unwrap());
        let modified = read(&target);
        if modified == healthy {
            continue;
        }
        let changed = modified[0]
            .chunks_exact(16)
            .zip(healthy[0].chunks_exact(16))
            .filter(|(a, b)| a != b)
            .count();
        if changed == 0 {
            continue;
        }
        // An independent execution error can replay the same unchecked samples.
        batch.injected_error = Some("later execution error".into());
        batch.injected_kind = Some(native_completion::injected_metal_errors(&[2, 1]));
        renderer
            .repair_target(&target, 0, 1, &batch, "later execution error".into())
            .unwrap();
        assert_eq!(read(&target), healthy);
        eprintln!(
            "escaped query window {start}..{}: scene={} canary={} changed HDR pixels={changed}",
            start + 1,
            observed[3],
            observed[4]
        );
        escaped = true;
        break;
    }
    assert!(escaped, "expected a short window between workgroup checks");
    renderer.reset_target(&mut target).unwrap();
    reset_window(queries / 2, queries + queries / 2);
    let previous = gpu.recovery_test.lock().unwrap().repairs;
    renderer.add_samples(&mut target, 9).unwrap();
    let observed = counts();
    assert!(
        observed[3] > 0 && observed[4] > 0,
        "window must hit scene and canary queries"
    );
    assert_eq!(gpu.recovery_test.lock().unwrap().repairs, previous + 1);
    assert_eq!(read(&target), expected);
    assert_eq!(renderer.read_target(&target, 0).unwrap(), visible);
}

#[test]
#[ignore = "requires a real Metal GPU"]
fn incompatible_beauty_shaders_render_without_guard_and_targets_reselect_their_pipelines() {
    let _test = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(1).unwrap();
    if gpu.info.backend != wgpu::Backend::Metal {
        return;
    }
    let descriptor = scene::tests::translated_camera_input();
    let (mut scene, mut assets, retained) = scene::prepare_retained(&descriptor, true).unwrap();
    let source = String::from_utf8(assets[&scene.shader].clone()).unwrap();
    // Equivalent WGSL with a spelling the guard does not recognize.
    let incompatible = source.replace("@workgroup_size(8, 8, 1)", "@workgroup_size(8, 8)");
    assert!(instrument(&incompatible).is_err());
    assets.insert(scene.shader, incompatible.clone().into_bytes());
    scene.hwrt = Some(
        hardware::capture_from_resources(&mut assets, scene.native_layout.as_ref().unwrap())
            .unwrap(),
    );
    let size = [scene.width, scene.height];
    let offset = layout::header::CAMERA_OFFSET * 4;
    let camera =
        u32::from_le_bytes(descriptor[offset..offset + 4].try_into().unwrap()) as usize * 4;
    // A native log callback receives one warning on the cache miss. Reusing
    // that fallback for another target should not warn on each render.
    use std::sync::atomic::{AtomicUsize, Ordering};
    static WARNINGS: AtomicUsize = AtomicUsize::new(0);
    unsafe extern "C" fn count_warning(_: *mut std::ffi::c_void, bytes: *const u8, len: usize) {
        let line = unsafe { std::slice::from_raw_parts(bytes, len) };
        if line.starts_with(b"Warning: Metal HWRT silent-miss protection") {
            WARNINGS.fetch_add(1, Ordering::Relaxed);
        }
    }
    struct LogRegistration;
    impl Drop for LogRegistration {
        fn drop(&mut self) {
            unsafe {
                crate::logging::mt_set_log_callback(None, std::ptr::null_mut());
            }
        }
    }
    WARNINGS.store(0, Ordering::Relaxed);
    unsafe {
        crate::logging::mt_set_log_callback(Some(count_warning), std::ptr::null_mut());
    }
    let _registration = LogRegistration;
    let (renderer, mut target) = GpuScene::new(
        scene,
        &RenderOptions {
            flags: 4,
            ..Default::default()
        },
        &assets,
        gpu.clone(),
    )
    .unwrap();
    let packet = || {
        retained
            .target(
                &settings::RenderSettings::default(),
                size,
                0,
                0,
                true,
                &descriptor[camera..camera + 128],
                &gpu.loss,
                false,
            )
            .unwrap()
    };
    let render = |target: &mut Target| {
        renderer.add_samples(target, 4).unwrap();
        renderer.read_target(target, 0).unwrap()
    };
    assert!(target.query_guard.is_none());
    let reference = render(&mut target);
    let mut previous_pipelines = None;
    for (shader, guarded) in [(&source, true), (&incompatible, false), (&source, true)] {
        let mut next = packet();
        next.shader = Some(shader.clone());
        target = renderer.target(next, size, Some(target)).unwrap();
        assert_eq!(target.query_guard.is_some(), guarded);
        if let Some(guard) = &target.query_guard {
            let pipelines = (guard.pipelines.replay.clone(), guard.pipelines.miss.clone());
            if let Some(previous) = previous_pipelines.replace(pipelines.clone()) {
                assert_eq!(pipelines, previous);
            }
        }
        assert_eq!(render(&mut target), reference);
    }
    // Compile an actual AOT target variant and use both of its warmed PSOs.
    let next = retained
        .target(
            &settings::RenderSettings {
                sampling_pattern: 2,
                ..Default::default()
            },
            size,
            0,
            0,
            true,
            &descriptor[camera..camera + 128],
            &gpu.loss,
            false,
        )
        .unwrap();
    assert!(next.shader.is_some());
    target = renderer.target(next, size, Some(target)).unwrap();
    let variant = &target.query_guard.as_ref().unwrap().pipelines;
    let (base_replay, base_miss) = previous_pipelines.unwrap();
    assert_ne!(variant.replay, base_replay);
    assert_ne!(variant.miss, base_miss);
    let expected = render(&mut target);
    renderer.reset_target(&mut target).unwrap();
    gpu.recovery_test.lock().unwrap().silent_sample = Some(0);
    let before = gpu.recovery_test.lock().unwrap().repairs;
    assert_eq!(render(&mut target), expected);
    assert_eq!(gpu.recovery_test.lock().unwrap().repairs, before + 1);
    assert_eq!(WARNINGS.load(Ordering::Relaxed), 1);
}
