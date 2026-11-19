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

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn metal_sampling_submits_the_next_buffer_only_after_flight_retirement() {
    let _lock = crate::abi_test_lock();
    for limit in [4, 8, 32] {
        let gpu = GpuDevice::with_backend(1).unwrap();
        if gpu.info.backend != wgpu::Backend::Metal {
            continue;
        }
        let handle = create_with_gpu(gpu.clone(), 1).unwrap();
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
        with_registry(|registry| {
            let target = registry
                .contexts
                .get_mut(&handle)
                .unwrap()
                .target
                .as_mut()
                .unwrap();
            target
                .sampling_batch
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .set_limit(limit);
            target.dispatch_audit = Some(crate::DispatchAudit::new(&gpu.device));
            Ok(())
        })
        .unwrap();
        let requested = limit * 2 + 1;
        let job = submit(handle, requested).unwrap();
        poll_job(job, 64).unwrap();
        // The GPU may already have finished this tiny scene. Hold only the
        // retirement notification so the test deterministically exercises polls
        // with an outstanding flight, independent of device speed.
        let gate = Arc::new(AtomicBool::new(false));
        with_registry(|registry| {
            let job = registry
                .contexts
                .get_mut(&handle)
                .unwrap()
                .job
                .as_mut()
                .unwrap();
            assert_eq!(job.submitted, limit);
            assert_eq!(job.completed, 0);
            job.flight.as_mut().unwrap().done = gate.clone();
            Ok(())
        })
        .unwrap();
        for _ in 0..3 {
            poll_job(job, 64).unwrap();
        }
        assert_eq!(gpu.recovery_test.lock().unwrap().submissions, 1);
        assert_eq!(job_info(job).unwrap().submitted_samples, limit);
        GpuDevice::wait(&gpu.device).unwrap();
        gate.store(true, Ordering::Release);
        while job_info(job).unwrap().state != JobState::Complete as u32 {
            poll_job(job, 64).unwrap();
            GpuDevice::wait(&gpu.device).unwrap();
        }
        let info = job_info(job).unwrap();
        assert_eq!(info.completed_samples, requested);
        assert_eq!(gpu.recovery_test.lock().unwrap().submissions, 3);
        with_registry(|registry| {
            let context = registry.contexts.get(&handle).unwrap();
            let counts = context.scene.as_ref().unwrap().read_dispatch_audit(
                context.target.as_ref().unwrap(),
                0,
                requested,
            )?;
            assert_eq!(counts, vec![1; requested as usize]);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
            0
        );
    }
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn shared_device_sampling_does_not_require_the_previous_render_to_be_polled() {
    let _lock = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(1).unwrap();
    if gpu.info.backend != wgpu::Backend::Metal {
        return;
    }
    let mut error = [0i8; 1024];
    let input = scene::tests::input();
    let mut handles = Vec::new();
    let other = GpuDevice::on_device(&gpu.adapter, &gpu.device, &gpu.queue, None);
    for imported in [gpu.clone(), other.clone()] {
        let handle = create_with_gpu(imported, 1).unwrap();
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
        handles.push(handle);
    }
    let first = submit(handles[0], 9).unwrap();
    let second = submit(handles[1], 9).unwrap();
    // A different producer is still encoding a sampling buffer. Polling must
    // yield without allocating/submitting work or waiting for its CPU lock.
    let reservation = gpu.sampling_admission.flight.lock().unwrap();
    poll_job(second, 64).unwrap();
    assert_eq!(job_info(second).unwrap().submitted_samples, 0);
    assert_eq!(other.recovery_test.lock().unwrap().submissions, 0);
    drop(reservation);
    poll_job(first, 64).unwrap();
    // Leave the first job uncollected; device retirement, not another caller's
    // progress query, must allow the second render to finish.
    while job_info(second).unwrap().state != JobState::Complete as u32 {
        poll_job(second, 64).unwrap();
        GpuDevice::wait(&gpu.device).unwrap();
    }
    assert_eq!(job_info(first).unwrap().completed_samples, 0);
    while job_info(first).unwrap().state != JobState::Complete as u32 {
        poll_job(first, 64).unwrap();
        GpuDevice::wait(&gpu.device).unwrap();
    }
    for imported in [&gpu, &other] {
        assert_eq!(imported.recovery_test.lock().unwrap().submissions, 3);
    }
    for kind in 0..3 {
        assert_eq!(
            read_pixels(handles[0], kind).unwrap(),
            read_pixels(handles[1], kind).unwrap()
        );
    }
    // Also mix an asynchronous job with the already-blocking C render API.
    let next = submit(handles[0], 4).unwrap();
    poll_job(next, 64).unwrap();
    assert_eq!(
        unsafe { mt_context_render(handles[1], 4, error.as_mut_ptr(), error.len()) },
        0
    );
    while job_info(next).unwrap().state != JobState::Complete as u32 {
        poll_job(next, 64).unwrap();
        GpuDevice::wait(&gpu.device).unwrap();
    }
    for handle in handles {
        assert_eq!(
            unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
            0
        );
    }
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn expired_sampling_callback_fails_without_credit_but_late_collection_succeeds() {
    let _lock = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(1).unwrap();
    if gpu.info.backend != wgpu::Backend::Metal {
        return;
    }
    for missing_callback in [false, true] {
        let handle = create_with_gpu(gpu.clone(), 1).unwrap();
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
        poll_job(job, 4).unwrap();
        GpuDevice::wait(&gpu.device).unwrap();
        with_registry(|registry| {
            let context = registry.contexts.get_mut(&handle).unwrap();
            let flight = context.job.as_mut().unwrap().flight.as_mut().unwrap();
            flight.native.deadline = Some(Instant::now() - Duration::from_secs(1));
            if missing_callback {
                flight.done.store(false, Ordering::Release);
            }
            let result = advance_job(context, None, 0);
            if missing_callback {
                let error = result.unwrap_err();
                assert_eq!(
                    status::classify(error.as_ref(), Status::Error),
                    Status::ContextFailed
                );
                assert!(error.to_string().contains("completion deadline"));
                assert!(context.failed);
                assert_eq!(context.job.as_ref().unwrap().completed, 0);
                assert_eq!(context.target.as_ref().unwrap().samples, 0);
            } else {
                result?;
                assert_eq!(context.job.as_ref().unwrap().completed, 4);
                assert!(!context.failed);
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(
            unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
            0
        );
    }
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn guarded_retry_limit_fails_the_job_without_crediting_a_partial_flight() {
    let _lock = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(1).unwrap();
    if gpu.info.backend != wgpu::Backend::Metal {
        return;
    }
    let handle = create_with_gpu(gpu.clone(), 1).unwrap();
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
    {
        let mut hook = gpu.recovery_test.lock().unwrap();
        hook.partial_sample = Some(0);
        hook.repair_failures = 13;
    }
    let job = submit(handle, 4).unwrap();
    poll_job(job, 4).unwrap();
    GpuDevice::wait(&gpu.device).unwrap();
    let error_result = poll_job(job, 0).unwrap_err();
    assert_eq!(
        status::classify(error_result.as_ref(), Status::Error),
        Status::ContextFailed
    );
    assert!(
        error_result
            .to_string()
            .contains("repair exceeded its bound")
    );
    let info = job_info(job).unwrap();
    assert_eq!(info.state, JobState::Failed as u32);
    assert_eq!(info.completed_samples, 0);
    assert_eq!(gpu.recovery_test.lock().unwrap().repairs, 1);
    assert_eq!(gpu.recovery_test.lock().unwrap().repair_failures, 1);
    assert_eq!(
        unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
        0
    );
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn an_expired_shared_device_flight_does_not_leave_other_jobs_waiting_forever() {
    let _lock = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(1).unwrap();
    if gpu.info.backend != wgpu::Backend::Metal {
        return;
    }
    let mut handles = Vec::new();
    let mut error = [0i8; 1024];
    let input = scene::tests::input();
    for _ in 0..2 {
        let handle = create_with_gpu(gpu.clone(), 1).unwrap();
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
        handles.push(handle);
    }
    let first = submit(handles[0], 4).unwrap();
    poll_job(first, 4).unwrap();
    GpuDevice::wait(&gpu.device).unwrap();
    with_registry(|registry| {
        let flight = registry
            .contexts
            .get_mut(&handles[0])
            .unwrap()
            .job
            .as_mut()
            .unwrap()
            .flight
            .as_mut()
            .unwrap();
        flight.native.deadline = Some(Instant::now() - Duration::from_secs(1));
        flight.done.store(false, Ordering::Release);
        *gpu.sampling_admission.flight.lock().unwrap() = Some(crate::sampling_batch::Pending::new(
            flight.native.clone(),
            flight.done.clone(),
        ));
        Ok(())
    })
    .unwrap();
    let second = submit(handles[1], 4).unwrap();
    let failure = poll_job(second, 4).unwrap_err();
    assert!(failure.to_string().contains("completion deadline"));
    assert_eq!(job_info(second).unwrap().state, JobState::Failed as u32);
    assert_eq!(job_info(second).unwrap().submitted_samples, 0);
    assert!(poll_job(first, 0).is_err());
    for handle in handles {
        assert_eq!(
            unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
            0
        );
    }
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn adaptive_async_repair_finishes_the_large_flight_before_reducing_the_next_one() {
    let _lock = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(1).unwrap();
    if gpu.info.backend != wgpu::Backend::Metal {
        return;
    }
    let handle = create_with_gpu(gpu.clone(), 1).unwrap();
    let reference = create_with_gpu(gpu.clone(), 1).unwrap();
    let input = scene::tests::input();
    let mut error = [0i8; 1024];
    for context in [handle, reference] {
        assert_eq!(
            unsafe {
                mt_context_commit(
                    context,
                    input.as_ptr(),
                    input.len(),
                    error.as_mut_ptr(),
                    error.len(),
                )
            },
            0
        );
    }
    with_registry(|registry| {
        let target = registry
            .contexts
            .get_mut(&handle)
            .unwrap()
            .target
            .as_mut()
            .unwrap();
        let mut state = target.sampling_batch.as_ref().unwrap().lock().unwrap();
        state.reset_adaptation();
        for _ in 0..2 {
            state.observe(4, Some(0.4), None, false);
        }
        assert_eq!(state.limit(), 32);
        Ok(())
    })
    .unwrap();
    gpu.recovery_test.lock().unwrap().partial_sample = Some(20);
    let job = submit(handle, 65).unwrap();
    poll_job(job, 64).unwrap();
    assert_eq!(job_info(job).unwrap().submitted_samples, 32);
    GpuDevice::wait(&gpu.device).unwrap();
    poll_job(job, 0).unwrap();
    assert_eq!(job_info(job).unwrap().completed_samples, 32);
    with_registry(|registry| {
        let target = registry
            .contexts
            .get(&handle)
            .unwrap()
            .target
            .as_ref()
            .unwrap();
        assert_eq!(
            target
                .sampling_batch
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .limit(),
            4
        );
        Ok(())
    })
    .unwrap();
    poll_job(job, 64).unwrap();
    assert_eq!(job_info(job).unwrap().submitted_samples, 36);
    while job_info(job).unwrap().state != JobState::Complete as u32 {
        GpuDevice::wait(&gpu.device).unwrap();
        poll_job(job, 64).unwrap();
    }
    assert_eq!(
        unsafe { mt_context_render(reference, 65, error.as_mut_ptr(), error.len()) },
        0
    );
    for kind in 0..3 {
        assert_eq!(
            read_pixels(handle, kind).unwrap(),
            read_pixels(reference, kind).unwrap()
        );
    }
    for context in [handle, reference] {
        assert_eq!(
            unsafe { mt_context_destroy(context, error.as_mut_ptr(), error.len()) },
            0
        );
    }
}

#[test]
#[ignore = "requires a real Metal GPU"]
fn cancellation_discards_prepared_work_and_a_smaller_poll_budget_wins() {
    let _lock = crate::abi_test_lock();
    let gpu = GpuDevice::with_backend(1).unwrap();
    if gpu.info.backend != wgpu::Backend::Metal {
        return;
    }
    let handle = create_with_gpu(gpu.clone(), 1).unwrap();
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
    let prepared = || {
        with_registry(|registry| {
            Ok(registry.contexts[&handle]
                .job
                .as_ref()
                .unwrap()
                .prepared
                .is_some())
        })
        .unwrap()
    };
    let job = submit(handle, 12).unwrap();
    poll_job(job, 4).unwrap();
    assert!(prepared());
    cancel_job(job).unwrap();
    assert!(!prepared());
    GpuDevice::wait(&gpu.device).unwrap();
    poll_job(job, 0).unwrap();
    let info = job_info(job).unwrap();
    assert_eq!(info.state, JobState::Cancelled as u32);
    assert_eq!((info.submitted_samples, info.completed_samples), (4, 4));
    let job = submit(handle, 10).unwrap();
    poll_job(job, 4).unwrap();
    assert!(prepared());
    GpuDevice::wait(&gpu.device).unwrap();
    poll_job(job, 1).unwrap();
    assert_eq!(job_info(job).unwrap().submitted_samples, 5);
    while job_info(job).unwrap().state != JobState::Complete as u32 {
        GpuDevice::wait(&gpu.device).unwrap();
        poll_job(job, 4).unwrap();
    }
    assert_eq!(job_info(job).unwrap().completed_samples, 10);
    assert_eq!(
        unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
        0
    );
}
