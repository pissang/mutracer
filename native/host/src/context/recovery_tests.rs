use super::*;

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn blocking_repair_matches_clean_outputs_and_restores_full_frame_state() {
    let _lock = crate::abi_test_lock();
    for backend in [0, 1] {
        let gpu = GpuDevice::with_backend(backend).unwrap();
        let handle = create_with_gpu(gpu.clone(), backend).unwrap();
        let mut input = scene::tests::input();
        for (word, value) in [(layout::header::WIDTH, 32u32), (layout::header::HEIGHT, 24)] {
            input[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        let commit = || {
            let mut error = [0i8; 1024];
            assert_eq!(
                unsafe {
                    mt_context_commit(
                        handle,
                        input.as_ptr(),
                        input.len(),
                        error.as_mut_ptr(),
                        error.len(),
                    )
                },
                0,
                "{}",
                unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy()
            );
        };
        let render = |samples| {
            let mut error = [0i8; 1024];
            assert_eq!(
                unsafe { mt_context_render(handle, samples, error.as_mut_ptr(), error.len()) },
                0,
                "{}",
                unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy()
            );
        };
        commit();
        render(8);
        let expected: Vec<_> = (0..3)
            .map(|kind| {
                read_pixels(handle, kind)
                    .unwrap()
                    .iter()
                    .map(|v| v.to_bits())
                    .collect::<Vec<_>>()
            })
            .collect();
        {
            let hook = gpu.recovery_test.lock().unwrap();
            assert_eq!(
                (hook.repairs, hook.submissions),
                (
                    0,
                    if backend == 1 && gpu.info.backend == wgpu::Backend::Metal {
                        2
                    } else {
                        8
                    }
                ),
                "successful rendering added recovery work"
            );
        }
        commit();
        gpu.recovery_test.lock().unwrap().partial_sample = Some(2);
        render(4);
        assert_eq!(gpu.recovery_test.lock().unwrap().repairs, 1);
        // Ordinary samples after repair also exercise the restored adaptive state.
        render(4);
        for kind in 0..3 {
            assert_eq!(
                read_pixels(handle, kind)
                    .unwrap()
                    .iter()
                    .map(|v| v.to_bits())
                    .collect::<Vec<_>>(),
                expected[kind as usize],
                "backend={backend} kind={kind}"
            );
        }
        let mut error = [0i8; 1024];
        assert_eq!(
            unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
            0
        );
    }
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn repaired_flight_retains_previous_gpu_timing_and_denominator() {
    let _lock = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(0).unwrap();
    let handle = create_with_gpu(gpu.clone(), 0).unwrap();
    let input = scene::tests::input();
    let mut error = [0i8; 1024];
    assert_eq!(
        unsafe {
            mt_context_commit(
                handle,
                input.as_ptr(),
                input.len(),
                error.as_mut_ptr(),
                error.len(),
            )
        },
        0
    );
    let job = submit(handle, 4).unwrap();
    poll_job(job, 2).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while job_info(job).unwrap().completed_samples < 2 {
        poll_job(job, 0).unwrap();
        assert!(Instant::now() < deadline);
    }
    // A fixed prior measurement isolates accounting from timestamp availability
    // and timer noise on tiny scenes. The next flight really executes repair.
    {
        let mut registry = REGISTRY.lock().unwrap();
        let job = registry
            .contexts
            .get_mut(&handle)
            .unwrap()
            .job
            .as_mut()
            .unwrap();
        job.gpu_ms = Some(12.);
        job.gpu_samples = 2;
    }
    gpu.recovery_test.lock().unwrap().partial_sample = Some(2);
    poll_job(job, 2).unwrap();
    // Exercise the same-device renewal branch deterministically, while the
    // real partial dispatch still leaves missing pixels to replay afterwards.
    REGISTRY
        .lock()
        .unwrap()
        .contexts
        .get_mut(&handle)
        .unwrap()
        .job
        .as_mut()
        .unwrap()
        .flight
        .as_mut()
        .unwrap()
        .native
        .injected_kind = Some(crate::native_completion::FailureKind::SubmissionsIgnored);
    while job_info(job).unwrap().completed_samples < 4 {
        poll_job(job, 0).unwrap();
        assert!(Instant::now() < deadline);
    }
    assert_eq!(gpu.recovery_test.lock().unwrap().repairs, 1);
    assert_eq!(job_gpu_sample_time(handle), Some(6.));
    assert_eq!(
        unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
        0
    );
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn collection_without_scene_owner_preserves_original_failure_state() {
    let _lock = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(0).unwrap();
    let owner = create_scene_with_gpu(gpu.clone(), 0).unwrap();
    let target = create_with_gpu(gpu.clone(), 0).unwrap();
    let input = scene::tests::input();
    let mut error = [0i8; 1024];
    assert_eq!(
        unsafe {
            mt_context_commit(
                owner,
                input.as_ptr(),
                input.len(),
                error.as_mut_ptr(),
                error.len(),
            )
        },
        0
    );
    let at = layout::header::CAMERA_OFFSET * 4;
    let at = u32::from_le_bytes(input[at..at + 4].try_into().unwrap()) as usize * 4;
    let camera = input[at..at + 128].try_into().unwrap();
    set_target(
        target,
        owner,
        &settings::RenderSettings::default(),
        [32, 24],
        0,
        0,
        &camera,
    )
    .unwrap();
    let job = submit(target, 2).unwrap();
    poll_job(job, 2).unwrap();
    assert!(inject_flight_failure(
        target,
        "controlled ownerless collection failure"
    ));
    GpuDevice::wait(&gpu.device).unwrap();
    with_registry(|registry| {
        let context = registry.contexts.get_mut(&target).unwrap();
        context
            .job
            .as_mut()
            .unwrap()
            .flight
            .as_mut()
            .unwrap()
            .native
            .injected_kind = Some(crate::native_completion::FailureKind::Retry);
        let failure = advance_job(context, None, 0).unwrap_err();
        assert!(
            failure
                .to_string()
                .contains("controlled ownerless collection failure")
        );
        assert!(context.failed);
        let job = context.job.as_ref().unwrap();
        assert_eq!(job.state as u32, JobState::Failed as u32);
        assert_eq!(job.completed, 0);
        Ok(())
    })
    .unwrap();
    for handle in [target, owner] {
        assert_eq!(
            unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
            0
        );
    }
}
