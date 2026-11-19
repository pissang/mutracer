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
    let (mut scene, mut assets, _) =
        crate::scene::prepare_retained(&crate::scene::tests::translated_camera_input(), true)
            .unwrap();
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
