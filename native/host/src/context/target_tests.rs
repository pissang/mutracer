use super::*;

struct Fixture {
    owner: u64,
    target: u64,
    other: u64,
    camera: [u8; 128],
}
fn ok(code: i32, error: &[c_char]) {
    assert_eq!(
        code,
        0,
        "{}",
        unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy()
    );
}
fn retry(mut call: impl FnMut() -> i32) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let code = call();
        if code != Status::Busy as i32 || Instant::now() >= deadline {
            return code;
        }
        std::thread::yield_now();
    }
}
impl Fixture {
    fn new() -> Self {
        let mut error = [0; 512];
        let gpu = GpuDevice::with_backend(0).expect("real GPU required");
        let owner = create_scene_with_gpu(gpu.clone(), 0).unwrap();
        let target = create_with_gpu(gpu.clone(), 0).unwrap();
        let other = create_with_gpu(gpu, 0).unwrap();
        let input = scene::tests::input();
        unsafe {
            ok(
                mt_context_commit(
                    owner,
                    input.as_ptr(),
                    input.len(),
                    error.as_mut_ptr(),
                    error.len(),
                ),
                &error,
            );
        }
        with_registry(|registry| {
            let owner = context(registry, owner)?;
            assert!(owner.target.is_none());
            let scene = ready(owner)?;
            for id in [
                layout::resource::CAMERA,
                layout::resource::TRACE_UNIFORM,
                layout::resource::COLOR,
                layout::resource::NORMAL,
                layout::resource::ALBEDO,
                layout::resource::SHADOW_CATCHER,
            ] {
                assert!(!scene.buffers.contains_key(&id));
            }
            Ok(())
        })
        .unwrap();
        let at = layout::header::CAMERA_OFFSET * 4;
        let at = u32::from_le_bytes(input[at..at + 4].try_into().unwrap()) as usize * 4;
        let result = Self {
            owner,
            target,
            other,
            camera: input[at..at + 128].try_into().unwrap(),
        };
        for handle in [target, other] {
            ok(result.set(handle, [8, 8], &mut error), &error);
        }
        render(other);
        result
    }
    fn set(&self, handle: u64, size: [u32; 2], error: &mut [c_char]) -> i32 {
        write_result(
            error.as_mut_ptr(),
            error.len(),
            set_target(
                handle,
                self.owner,
                &settings::RenderSettings::default(),
                size,
                0,
                0,
                &self.camera,
            ),
        )
    }
    fn start(&self) -> std::thread::JoinHandle<i32> {
        let (target, owner, camera) = (self.target, self.owner, self.camera);
        std::thread::spawn(move || {
            let mut error = [0; 512];
            write_result(
                error.as_mut_ptr(),
                error.len(),
                set_target(
                    target,
                    owner,
                    &settings::RenderSettings::default(),
                    [16, 8],
                    0,
                    0,
                    &camera,
                ),
            )
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let mut error = [0; 512];
        for handle in [self.target, self.other, self.owner] {
            unsafe {
                mt_context_destroy(handle, error.as_mut_ptr(), error.len());
            }
        }
    }
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn mesh_count_replacement_skips_sync_and_keeps_old_scene_until_full_commit() {
    let _test = ABI_TEST_LOCK.lock().unwrap();
    let f = Fixture::new();
    let input = scene::tests::input();
    let mut next = input.clone();
    use layout::{header as h, mesh as m};
    let word = |field: usize| {
        u32::from_le_bytes(input[field * 4..field * 4 + 4].try_into().unwrap()) as usize
    };
    let (offset, count) = (word(h::MESH_OFFSET), word(h::MESH_COUNT));
    let mut meshes = input[offset * 4..(offset + count * m::WORDS) * 4].to_vec();
    meshes.extend_from_slice(&input[offset * 4..(offset + m::WORDS) * 4]);
    let offset = next.len() / 4;
    next.extend(meshes);
    for (field, value) in [
        (h::MESH_OFFSET, offset),
        (h::MESH_COUNT, count + 1),
        (h::MESH_AOV_IDS, 0),
        (h::BATCH_OFFSET, 0),
        (h::LENGTH, next.len() / 4),
    ] {
        next[field * 4..field * 4 + 4].copy_from_slice(&(value as u32).to_le_bytes());
    }
    scene::validate(&next).unwrap();
    let next = Arc::new(next);
    // With AOT deliberately occupied, an incompatible incremental probe must
    // return immediately, leaving the committed scene available to render.
    let (started, entered) = mpsc::sync_channel(1);
    let (resume, resumed) = mpsc::sync_channel(1);
    runtime::enqueue(move || {
        started.send(()).unwrap();
        resumed.recv_timeout(Duration::from_secs(15)).unwrap();
    });
    entered.recv().unwrap();
    let (send, receive) = mpsc::sync_channel(1);
    let bytes = next.clone();
    let owner = f.owner;
    let probe = std::thread::spawn(move || {
        send.send(
            commit_path(
                owner,
                &bytes,
                &settings::RenderSettings::default(),
                CommitPath::IncrementalOnly,
            )
            .map_err(|error| error.to_string()),
        )
        .unwrap();
    });
    let result = receive.recv_timeout(Duration::from_secs(2));
    resume.send(()).unwrap();
    probe.join().unwrap();
    assert_eq!(result.unwrap().unwrap(), CommitOutcome::NeedsFull);
    render(f.other);
    assert_eq!(
        commit_path(
            f.owner,
            &next,
            &settings::RenderSettings::default(),
            CommitPath::FullOnly
        )
        .unwrap(),
        CommitOutcome::Done
    );
    let mut error = [0; 512];
    ok(f.set(f.other, [8, 8], &mut error), &error);
    render(f.other);
}
fn render(handle: u64) {
    let mut error = [0; 512];
    let mut job = 0;
    unsafe {
        ok(
            mt_context_submit(handle, 1, &mut job, error.as_mut_ptr(), error.len()),
            &error,
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            ok(mt_job_poll(job, 1, error.as_mut_ptr(), error.len()), &error);
            let mut info = JobInfo {
                struct_size: std::mem::size_of::<JobInfo>() as u32,
                state: 0,
                requested_samples: 0,
                submitted_samples: 0,
                completed_samples: 0,
                base_samples: 0,
            };
            ok(
                mt_job_info(job, &mut info, error.as_mut_ptr(), error.len()),
                &error,
            );
            if info.state == JobState::Complete as u32 {
                break;
            }
            assert!(Instant::now() < deadline, "render did not complete");
            std::thread::yield_now();
        }
        let mut pixels = [0; 8 * 8 * 16];
        let mut written = 0;
        ok(
            mt_context_read_pixels(
                handle,
                0,
                pixels.as_mut_ptr(),
                pixels.len(),
                &mut written,
                error.as_mut_ptr(),
                error.len(),
            ),
            &error,
        );
        assert_eq!(written, pixels.len());
        ok(
            mt_context_submit(handle, 1, &mut job, error.as_mut_ptr(), error.len()),
            &error,
        );
        ok(mt_job_cancel(job, error.as_mut_ptr(), error.len()), &error);
        ok(mt_job_poll(job, 0, error.as_mut_ptr(), error.len()), &error);
    }
}
fn gate() -> (mpsc::Receiver<()>, mpsc::SyncSender<()>) {
    let (entered, started) = mpsc::sync_channel(1);
    let (resume, resumed) = mpsc::sync_channel(1);
    *runtime::CALL_GATE.lock().unwrap() = Some((entered, resumed));
    (started, resume)
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn target_aot_waits_leave_other_contexts_available() {
    let _test = ABI_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let (entered, resume) = gate();
    let setting = fixture.start();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    // First wait: target uniforms/shader. Old code held REGISTRY here.
    render(fixture.other);
    // Install a second gate before releasing the first request. This pauses the
    // sample-sequence AOT call, which used to be hidden in GPU target creation.
    let (frames_entered, frames_resume) = gate();
    resume.send(()).unwrap();
    frames_entered.recv_timeout(Duration::from_secs(5)).unwrap();
    render(fixture.other);
    frames_resume.send(()).unwrap();
    assert_eq!(setting.join().unwrap(), 0);
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn target_preparation_rejects_a_scene_commit_that_started_after_its_snapshot() {
    let _test = ABI_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let (entered, resume) = gate();
    let setting = fixture.start();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let owner = fixture.owner;
    let committing = std::thread::spawn(move || {
        let input = Arc::new(scene::tests::input());
        let mut error = [0; 512];
        retry(|| {
            write_result(
                error.as_mut_ptr(),
                error.len(),
                commit_path(
                    owner,
                    &input,
                    &settings::RenderSettings::default(),
                    CommitPath::FullOnly,
                )
                .map(|_| ()),
            )
        })
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut preparing = false;
        let mut error = [0; 512];
        ok(
            retry(|| {
                action(error.as_mut_ptr(), error.len(), |registry| {
                    preparing = context(registry, owner)?.commit.is_some();
                    Ok(())
                })
            }),
            &error,
        );
        if preparing {
            break;
        }
        assert!(Instant::now() < deadline, "scene commit did not start");
        std::thread::yield_now();
    }
    resume.send(()).unwrap();
    assert_eq!(setting.join().unwrap(), Status::Busy as i32);
    assert_eq!(committing.join().unwrap(), 0);
    let mut error = [0; 512];
    // Rejected preparation leaves the old target intact; retry on the published scene.
    ok(
        action(error.as_mut_ptr(), error.len(), |registry| {
            assert_eq!(
                context(registry, fixture.target)?
                    .target
                    .as_ref()
                    .unwrap()
                    .width,
                8
            );
            Ok(())
        }),
        &error,
    );
    ok(fixture.set(fixture.target, [16, 8], &mut error), &error);
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn target_preparation_rechecks_destroyed_target_and_owner_handles() {
    let _test = ABI_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    for destroy_owner in [false, true] {
        let fixture = Fixture::new();
        let (entered, resume) = gate();
        let setting = fixture.start();
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let handle = if destroy_owner {
            fixture.owner
        } else {
            fixture.target
        };
        let destroying = std::thread::spawn(move || {
            let mut error = [0; 512];
            retry(|| unsafe { mt_context_destroy(handle, error.as_mut_ptr(), error.len()) })
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut removed = false;
            let mut error = [0; 512];
            ok(
                retry(|| {
                    action(error.as_mut_ptr(), error.len(), |registry| {
                        removed = !registry.contexts.contains_key(&handle);
                        Ok(())
                    })
                }),
                &error,
            );
            if removed {
                break;
            }
            assert!(Instant::now() < deadline, "destroy did not remove context");
            std::thread::yield_now();
        }
        resume.send(()).unwrap();
        assert_eq!(setting.join().unwrap(), Status::InvalidHandle as i32);
        assert_eq!(destroying.join().unwrap(), 0);
    }
}
