use super::render_loop::{
    PreviewFrame, ProgressiveState, loop_status, preview_frame, waits_for_preview,
};
use super::tests::{assert_bytes, expected_descriptor, images, lit_scene, oracle, software_engine};
use super::*;
use crate::test_support::read_texture;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[test]
fn shared_postprocess_loop_policy_matches_js() {
    let Ok(path) = std::env::var("MUTRACER_POSTPROCESS_SOURCES") else {
        return;
    };
    let reference: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for case in reference["scales"].as_array().unwrap() {
        let a: Vec<f64> = serde_json::from_value(case["args"].clone()).unwrap();
        assert_eq!(
            super::render::next_preview_scale(a[0], a[1], a[2], a[3], a[4], a[5]),
            case["expected"].as_f64().unwrap()
        );
    }
    let base = Instant::now();
    for trace in reference["traces"].as_array().unwrap() {
        let mut state = ProgressiveState::default();
        for event in trace["events"].as_array().unwrap() {
            state = state.update(
                event["changed"].as_bool().unwrap(),
                event["active"].as_bool().unwrap(),
                base + Duration::from_secs_f64(event["now"].as_f64().unwrap() / 1e3),
                trace["idleMs"].as_f64().unwrap(),
            );
            let expected = &event["expected"];
            assert_eq!(state.changing, expected["changing"].as_bool().unwrap());
            assert_eq!(
                state.previous_changed,
                expected["previousChanged"].as_bool().unwrap()
            );
            let last = state
                .last_continuous_change
                .map(|v| v.duration_since(base).as_secs_f64() * 1e3);
            assert_eq!(last, expected["lastContinuousChange"].as_f64());
        }
    }
}

#[test]
#[ignore = "requires real GPU"]
fn coalesced_preview_collects_async_denoising_before_committing_motion() {
    struct HeldFilter {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
        first: std::sync::atomic::AtomicBool,
    }
    impl CustomDenoiser for HeldFilter {
        fn input_mode(&self) -> DenoiseInputMode {
            DenoiseInputMode::ResidentGpu
        }
        fn denoise(
            &self,
            mut input: DenoiseInput,
            _: CancelToken,
        ) -> std::result::Result<DenoiseOutput, String> {
            if self.first.swap(false, std::sync::atomic::Ordering::AcqRel) {
                self.entered.send(()).unwrap();
                self.release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(30))
                    .map_err(|e| e.to_string())?;
            }
            let frame = input.resident.take().unwrap();
            let output = frame.buffers.color.clone();
            frame.submit([], output).map(DenoiseOutput::Resident)
        }
    }
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = super::aov_tests::aov_engine(Backend::Software);
    engine.display().set_size(16, 12).unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    let (entered, observed) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: Some(LoopRender::Settings(RenderSettings {
                max_samples: 1,
                ..RenderLoop::preview_settings()
            })),
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 1,
                ..Default::default()
            }),
            coalesce_scene_updates: true,
            select: Some(Box::new(|_| Selection::Preview)),
            ..Default::default()
        },
    )
    .unwrap();
    render_loop
        .preview()
        .unwrap()
        .set_custom_denoiser(
            Some(Arc::new(HeldFilter {
                entered,
                release: Mutex::new(released),
                first: std::sync::atomic::AtomicBool::new(true),
            })),
            DenoiseSchedule::EverySample,
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        render_loop.tick().unwrap();
        if observed.try_recv().is_ok() {
            break;
        }
        assert!(Instant::now() < deadline, "Preview filter did not start");
        std::thread::sleep(Duration::from_millis(1));
    }
    let before = render_loop.presentations();
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] += 0.1;
    engine.set_camera(Some(camera)).unwrap();
    for _ in 0..3 {
        render_loop.tick().unwrap();
    }
    assert!(
        engine.inputs_pending(),
        "Committed motion while preview inference was pending"
    );
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while render_loop.presentations() == before || engine.inputs_pending() {
        render_loop.tick().unwrap();
        assert!(
            Instant::now() < deadline,
            "Preview inference completed but the loop never resumed motion/presentation"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(render_loop.last_presented().is_some());
    assert!(!render_loop.preview().unwrap().denoising());
}

#[test]
fn progressive_state_starts_final_for_isolated_edits() {
    let t0 = Instant::now();
    let ms = |v: u64| t0 + Duration::from_millis(v);
    // An isolated change does not count as motion.
    let one = ProgressiveState::default().update(true, false, ms(0), 150.);
    assert!(one.previous_changed && !one.changing);
    assert_eq!(one.last_continuous_change, None);
    // Consecutive changes do, until the idle delay passes without changes.
    let two = one.update(true, false, ms(10), 150.);
    assert!(two.changing);
    assert_eq!(two.last_continuous_change, Some(ms(10)));
    let quiet = two.update(false, false, ms(150), 150.);
    assert!(quiet.changing && !quiet.previous_changed);
    assert!(!quiet.update(false, false, ms(160), 150.).changing);
    // Sync activity is motion and clears the consecutive-edit timer.
    let active = two.update(true, true, ms(20), 150.);
    assert!(active.changing && !active.previous_changed);
    assert_eq!(active.last_continuous_change, None);
    let released = active.update(false, false, ms(21), 150.);
    assert!(!released.changing);
    // After activity, the next change is isolated again.
    assert!(!released.update(true, false, ms(22), 150.).changing);
    // A negative delay behaves like zero.
    assert!(!two.update(false, false, ms(10), -5.).changing);
    assert!(!two.update(true, false, ms(11), 0.).changing);
}

#[test]
fn preview_frame_and_presentation_decisions_follow_the_browser_tick() {
    let converging = Some((RenderStatus::Converging, 0, false));
    // No owner: nothing pending.
    assert_eq!(
        preview_frame(false, None, converging, false),
        PreviewFrame::default()
    );
    // The preview owns the frame and is tracing its first sample: hold.
    assert_eq!(
        preview_frame(true, Some(true), converging, false),
        PreviewFrame {
            pending: true,
            tracing: true,
            holding: true
        }
    );
    // The final render owns it but became complete: a preview never replaces it.
    assert_eq!(
        preview_frame(false, Some(true), converging, false),
        PreviewFrame::default()
    );
    // Final incomplete, preview already has a sample: present it, do not hold.
    assert_eq!(
        preview_frame(
            false,
            Some(false),
            Some((RenderStatus::Converging, 1, false)),
            false
        ),
        PreviewFrame {
            pending: true,
            tracing: false,
            holding: false
        }
    );
    // Coalescing holds while the preview filters.
    let denoising = Some((RenderStatus::Denoising, 4, true));
    assert!(preview_frame(true, Some(false), denoising, true).holding);
    assert!(!preview_frame(true, Some(false), denoising, false).holding);
    // A preparing preview is not tracing.
    assert!(
        !preview_frame(
            true,
            Some(false),
            Some((RenderStatus::Preparing, 0, false)),
            false
        )
        .holding
    );

    // Preview selected and tracing its first sample: wait.
    assert!(waits_for_preview(
        true,
        true,
        RenderStatus::Converging,
        0,
        false,
        false,
        false,
        false
    ));
    // Preview with a sample: present it.
    assert!(!waits_for_preview(
        true,
        true,
        RenderStatus::Converging,
        1,
        false,
        false,
        true,
        false
    ));
    // Final selected: only coalescing with a filtering preview fallback waits.
    assert!(!waits_for_preview(
        true,
        false,
        RenderStatus::Converging,
        0,
        false,
        false,
        false,
        true
    ));
    assert!(waits_for_preview(
        true,
        false,
        RenderStatus::Converging,
        0,
        true,
        true,
        false,
        true
    ));
    assert!(!waits_for_preview(
        true,
        false,
        RenderStatus::Converging,
        0,
        true,
        true,
        true,
        true
    ));
    assert!(!waits_for_preview(
        false,
        true,
        RenderStatus::Converging,
        0,
        true,
        true,
        false,
        true
    ));

    assert_eq!(
        loop_status(RenderStatus::Error, true),
        RenderLoopStatus::Error
    );
    assert_eq!(
        loop_status(RenderStatus::Finished, true),
        RenderLoopStatus::Previewing
    );
    assert_eq!(
        loop_status(RenderStatus::Preparing, false),
        RenderLoopStatus::Preparing
    );
    assert_eq!(
        select_default(SelectInfo { changing: true }),
        Selection::Preview
    );
    assert_eq!(
        select_default(SelectInfo { changing: false }),
        Selection::Final
    );
}

#[test]
fn sync_activity_tracks_flags_and_deadlines() {
    let mut activity = SyncActivity::default();
    assert!(!activity.active());
    activity.set_active(true);
    assert!(activity.active());
    activity.set_active(false);
    activity.activate_for(Duration::from_millis(40));
    activity.activate_for(Duration::from_millis(1));
    assert!(activity.active());
    std::thread::sleep(Duration::from_millis(50));
    assert!(!activity.active());
    activity.set_active(true);
    activity.clear();
    assert!(!activity.active());
    let preview = RenderLoop::preview_settings();
    assert_eq!(preview.size, RenderSize::Scale(0.5));
    assert_eq!(preview.time_budget_ms, 80.);
    assert_eq!(preview.bounces, 2);
    assert!(!preview.bevel);
    assert_eq!(preview.dispersion_wavelengths, 1);
    assert_eq!(preview.direct_light_candidates, 2);
    assert_eq!(
        preview.adaptive_resolution,
        Some(AdaptiveResolution {
            target_frame_ms: 80.,
            min_scale: 0.125
        })
    );
    assert!(preview.validate().is_ok());
    let options = RenderLoopOptions::default();
    assert!(matches!(options.preview, Some(LoopRender::Default)));
    assert_eq!(options.idle_ms, 150.);
    assert!(!options.coalesce_scene_updates);
}

/// Moves the camera on every update while `moving`.
struct CameraSync {
    engine: Engine,
    activity: SyncActivity,
    moving: bool,
    step: u32,
    base: Camera,
}
impl LoopSync for CameraSync {
    fn update(&mut self) {
        if self.moving {
            self.step += 1;
            let mut camera = self.base;
            camera.world_matrix[12] = 0.2 + 0.02 * (self.step % 10) as f32;
            self.engine.set_camera(Some(camera)).unwrap();
        }
    }
    fn activity(&self) -> &SyncActivity {
        &self.activity
    }
    fn activity_mut(&mut self) -> &mut SyncActivity {
        &mut self.activity
    }
}
fn camera_sync(engine: &Engine) -> Arc<Mutex<CameraSync>> {
    let scene = lit_scene();
    Arc::new(Mutex::new(CameraSync {
        engine: engine.clone(),
        activity: SyncActivity::default(),
        moving: false,
        step: 0,
        base: Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap(),
    }))
}
fn tick_until(
    render_loop: &mut RenderLoop,
    done: impl Fn(&RenderLoop, RenderLoopStatus) -> bool,
) -> Vec<RenderLoopStatus> {
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut seen = Vec::new();
    loop {
        let status = render_loop.tick().unwrap();
        if seen.last() != Some(&status) {
            seen.push(status);
        }
        if done(render_loop, status) {
            return seen;
        }
        assert_ne!(status, RenderLoopStatus::Error);
        assert!(Instant::now() < deadline, "loop stuck at {status:?}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn loop_converge_matches_a_fresh_l0_context() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.display().set_size(16, 12).unwrap();
    let scene = lit_scene();
    engine.set_scene(&scene).unwrap();
    let mut render_loop = RenderLoop::new(&engine, RenderLoopOptions::default()).unwrap();
    let preview = render_loop.preview().unwrap().clone();
    assert_eq!(preview.settings().unwrap(), RenderLoop::preview_settings());
    assert_eq!(render_loop.final_render().fallback_id(), Some(preview.id()));
    assert_eq!(render_loop.status(), RenderLoopStatus::Preparing);
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let recorded = statuses.clone();
    let _status = render_loop
        .on_status(move |status, previous| recorded.lock().unwrap().push((previous, status)));
    let samples = Arc::new(Mutex::new(Vec::new()));
    let counted = samples.clone();
    let _samples = render_loop.on_sample(move |event| counted.lock().unwrap().push(event.samples));
    let mut options = ConvergeOptions::new(6);
    options.samples_per_batch = 4;
    let result = render_loop.converge(options).unwrap();
    assert_eq!(result.samples, 6);
    assert_eq!(render_loop.status(), RenderLoopStatus::Finished);
    assert_eq!(render_loop.samples(), 6);
    assert_eq!(
        render_loop.presented(),
        Some(render_loop.final_render().id())
    );
    assert_eq!(
        statuses.lock().unwrap().last(),
        Some(&(RenderLoopStatus::Converging, RenderLoopStatus::Finished))
    );
    assert_eq!(*samples.lock().unwrap(), vec![4, 6]);
    let settings = render_loop.final_render().settings().unwrap();
    assert_bytes(
        &images(render_loop.final_render()),
        &oracle(
            0,
            &expected_descriptor(&scene, [16, 12], 3, None),
            &settings.l0(settings.sample_cap(6), 0),
            6,
        ),
        "loop converge",
    );
}

#[test]
fn interaction_keeps_an_image_and_never_reverts_a_finished_final() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    let display = engine.display();
    display.set_size(32, 24).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let sync = camera_sync(&engine);
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: Some(LoopRender::Default),
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 4,
                ..Default::default()
            }),
            syncs: vec![sync.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    let preview = render_loop.preview().unwrap().id();
    let final_id = render_loop.final_render().id();
    assert_eq!(render_loop.final_render().fallback_id(), Some(preview));
    assert!(render_loop.needs_tick());
    tick_until(&mut render_loop, |l, s| {
        s == RenderLoopStatus::Finished && !l.needs_tick()
    });
    assert_eq!(render_loop.presented(), Some(final_id));
    let settled = read_texture(&engine.inner.gpu, &display.texture().unwrap());
    assert!(
        settled.chunks(4).any(|p| p[3] != 0),
        "settled image is blank"
    );

    // Continuous camera motion with an active sync: every frame shows an image.
    {
        let mut sync = sync.lock().unwrap();
        sync.moving = true;
        sync.set_active(true);
    }
    let mut statuses = Vec::new();
    let mut preview_shown = false;
    for _ in 0..40 {
        statuses.push(render_loop.tick().unwrap());
        assert!(render_loop.changing());
        let image = read_texture(&engine.inner.gpu, &display.texture().unwrap());
        assert!(image.chunks(4).any(|p| p[3] != 0), "blank frame");
        preview_shown |= render_loop.presented() == Some(preview);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(
        preview_shown,
        "no preview frame was presented: {statuses:?}"
    );
    assert!(statuses.contains(&RenderLoopStatus::Previewing));
    assert_eq!(render_loop.samples(), 0);

    // Release: the final image replaces the preview and stays.
    {
        let mut sync = sync.lock().unwrap();
        sync.moving = false;
        sync.set_active(false);
    }
    let after = tick_until(&mut render_loop, |l, s| {
        s == RenderLoopStatus::Finished && !l.needs_tick()
    });
    assert!(!render_loop.changing());
    assert_eq!(render_loop.presented(), Some(final_id));
    assert_eq!(render_loop.samples(), 4);
    let finished = read_texture(&engine.inner.gpu, &display.texture().unwrap());
    for _ in 0..10 {
        assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Finished);
        assert_eq!(render_loop.presented(), Some(final_id));
        assert!(!render_loop.needs_tick());
    }
    assert_eq!(
        read_texture(&engine.inner.gpu, &display.texture().unwrap()),
        finished
    );
    // A display edit re-presents the finished final image, not the preview.
    display
        .set_settings(DisplaySettings {
            tone_mapping_exposure: 2.,
            ..Default::default()
        })
        .unwrap();
    assert!(render_loop.needs_tick());
    assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Finished);
    assert_eq!(render_loop.presented(), Some(final_id));
    assert_ne!(
        read_texture(&engine.inner.gpu, &display.texture().unwrap()),
        finished
    );
    assert!(!render_loop.needs_tick());
    // An engine edit needs a tick even before update.
    let mut moved = sync.lock().unwrap().base;
    moved.fov = 50.;
    engine.set_camera(Some(moved)).unwrap();
    assert!(render_loop.needs_tick());
    println!("loop statuses after release: {after:?}");
}

#[test]
fn final_render_presents_the_preview_until_it_is_complete() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let selection = Arc::new(Mutex::new(Selection::Preview));
    let chosen = selection.clone();
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: Some(LoopRender::Settings(RenderSettings {
                max_samples: 1,
                ..RenderLoop::preview_settings()
            })),
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 2,
                ..Default::default()
            }),
            select: Some(Box::new(move |_| *chosen.lock().unwrap())),
            ..Default::default()
        },
    )
    .unwrap();
    let preview = render_loop.preview().unwrap().clone();
    let final_render = render_loop.final_render().clone();
    assert!(render_loop.presented_render().is_none());
    tick_until(&mut render_loop, |l, _| {
        l.presented() == Some(preview.id()) && preview.samples() == 1
    });
    assert_eq!(render_loop.status(), RenderLoopStatus::Previewing);
    assert_eq!(render_loop.samples(), 0);
    assert!(Arc::ptr_eq(
        render_loop.presented_render().unwrap(),
        &preview
    ));
    *selection.lock().unwrap() = Selection::Final;
    // The final render has no complete image: its fallback is presented.
    assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Previewing);
    assert!(!final_render.complete());
    assert_eq!(render_loop.presented(), Some(preview.id()));
    assert!(Arc::ptr_eq(
        render_loop.presented_render().unwrap(),
        &preview
    ));
    let shown = engine.display().present(&final_render).unwrap().unwrap();
    assert!(shown.fallback);
    let statuses = tick_until(&mut render_loop, |l, s| {
        s == RenderLoopStatus::Finished && l.presented() == Some(final_render.id())
    });
    assert!(!statuses.contains(&RenderLoopStatus::Error));
    assert!(Arc::ptr_eq(
        render_loop.presented_render().unwrap(),
        &final_render
    ));
    assert!(
        !engine
            .display()
            .present(&final_render)
            .unwrap()
            .unwrap()
            .fallback
    );
    // Selecting the preview again shows it; the final image is not lost.
    *selection.lock().unwrap() = Selection::Preview;
    assert_eq!(render_loop.tick().unwrap(), RenderLoopStatus::Previewing);
    assert_eq!(final_render.samples(), 2);
}

#[test]
fn sync_activity_and_consecutive_edits_drive_changing() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.display().set_size(8, 6).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let sync = camera_sync(&engine);
    let shared: SharedSync = sync.clone();
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 1,
                ..Default::default()
            }),
            idle_ms: 60.,
            ..Default::default()
        },
    )
    .unwrap();
    render_loop.add_sync(shared.clone());
    render_loop.add_sync(shared.clone());
    tick_until(&mut render_loop, |_, s| s == RenderLoopStatus::Finished);
    assert!(!render_loop.changing());
    // Explicit activity without edits.
    sync.lock().unwrap().set_active(true);
    render_loop.tick().unwrap();
    assert!(render_loop.changing());
    assert!(render_loop.needs_tick());
    sync.lock().unwrap().set_active(false);
    render_loop.tick().unwrap();
    assert!(!render_loop.changing());
    sync.lock().unwrap().activate_for(Duration::from_millis(40));
    render_loop.tick().unwrap();
    assert!(render_loop.changing());
    std::thread::sleep(Duration::from_millis(50));
    render_loop.tick().unwrap();
    assert!(!render_loop.changing());
    // Consecutive edits without activity: changing until the idle delay passes.
    sync.lock().unwrap().moving = true;
    render_loop.tick().unwrap();
    assert!(!render_loop.changing(), "an isolated edit is not motion");
    render_loop.tick().unwrap();
    assert!(render_loop.changing());
    sync.lock().unwrap().moving = false;
    render_loop.tick().unwrap();
    assert!(render_loop.changing());
    std::thread::sleep(Duration::from_millis(70));
    render_loop.tick().unwrap();
    assert!(!render_loop.changing());
    // A removed sync is no longer updated or consulted.
    render_loop.remove_sync(&shared);
    sync.lock().unwrap().set_active(true);
    render_loop.tick().unwrap();
    assert!(!render_loop.changing());
    sync.lock().unwrap().dispose();
    assert!(!sync.lock().unwrap().active());
}

#[test]
fn unsubscribing_inside_a_callback_stops_later_events() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.display().set_size(8, 6).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 4,
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .unwrap();
    // Each callback drops its own subscription on its first call.
    fn once<S: Send + 'static>() -> (Arc<Mutex<Option<S>>>, Arc<Mutex<u32>>) {
        (Arc::new(Mutex::new(None)), Arc::new(Mutex::new(0)))
    }
    let (status_slot, status_calls) = once::<LoopSubscription>();
    let (slot, calls) = (status_slot.clone(), status_calls.clone());
    *status_slot.lock().unwrap() = Some(render_loop.on_status(move |_, _| {
        *calls.lock().unwrap() += 1;
        slot.lock().unwrap().take();
    }));
    let (loop_sample_slot, loop_sample_calls) = once::<LoopSubscription>();
    let (slot, calls) = (loop_sample_slot.clone(), loop_sample_calls.clone());
    *loop_sample_slot.lock().unwrap() = Some(render_loop.on_sample(move |_| {
        *calls.lock().unwrap() += 1;
        slot.lock().unwrap().take();
    }));
    let (render_slot, render_calls) = once::<Subscription>();
    let (slot, calls) = (render_slot.clone(), render_calls.clone());
    *render_slot.lock().unwrap() = Some(render_loop.final_render().on_sample(move |_| {
        *calls.lock().unwrap() += 1;
        slot.lock().unwrap().take();
    }));
    let (engine_slot, engine_calls) = once::<Subscription>();
    let (slot, calls) = (engine_slot.clone(), engine_calls.clone());
    *engine_slot.lock().unwrap() = Some(engine.on(move |_| {
        *calls.lock().unwrap() += 1;
        slot.lock().unwrap().take();
    }));
    // Control listeners that stay subscribed.
    let statuses = Arc::new(Mutex::new(0));
    let counted = statuses.clone();
    let _statuses = render_loop.on_status(move |_, _| *counted.lock().unwrap() += 1);
    let samples = Arc::new(Mutex::new(0));
    let counted = samples.clone();
    let _samples = render_loop.on_sample(move |_| *counted.lock().unwrap() += 1);
    let progress = Arc::new(Mutex::new(0));
    let counted = progress.clone();
    let _progress = engine.on(move |_| *counted.lock().unwrap() += 1);
    tick_until(&mut render_loop, |_, s| s == RenderLoopStatus::Finished);
    assert!(*statuses.lock().unwrap() >= 2);
    assert_eq!(*samples.lock().unwrap(), 4);
    assert!(*progress.lock().unwrap() >= 2);
    for (name, calls) in [
        ("loop status", &status_calls),
        ("loop sample", &loop_sample_calls),
        ("render sample", &render_calls),
        ("engine", &engine_calls),
    ] {
        assert_eq!(*calls.lock().unwrap(), 1, "{name}");
    }
}

#[test]
fn collect_accounts_a_batch_without_submitting_another() {
    let _test = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(engine) = software_engine(Backend::Software) else {
        return;
    };
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 8,
            size: RenderSize::Fixed {
                width: 16,
                height: 12,
            },
            ..Default::default()
        },
    )
    .unwrap();
    // Refine until one batch is in flight.
    let deadline = Instant::now() + Duration::from_secs(60);
    while !render.engine().lock().renders[&render.id()].in_flight() {
        render.refine().unwrap();
        assert!(Instant::now() < deadline);
    }
    let before = render.samples();
    while !render.collect().unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(render.samples(), before + 1);
    assert!(!render.engine().lock().renders[&render.id()].in_flight());
    assert!(render.complete());
    // Collecting again changes nothing; the next refine continues.
    assert!(render.collect().unwrap());
    assert_eq!(render.samples(), before + 1);
    render.refine().unwrap();
    assert!(render.engine().lock().renders[&render.id()].in_flight());
}

#[test]
#[ignore = "requires real GPU timestamps"]
fn refill_preserves_frame_ownership_expires_and_cancels_on_input() {
    let _test = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = super::aov_tests::aov_engine(Backend::Software);
    engine.display().set_size(64, 48).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    let updates = Arc::new(std::sync::atomic::AtomicU32::new(0));
    struct CountSync(Arc<std::sync::atomic::AtomicU32>, SyncActivity);
    impl LoopSync for CountSync {
        fn update(&mut self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        fn activity(&self) -> &SyncActivity {
            &self.1
        }
        fn activity_mut(&mut self) -> &mut SyncActivity {
            &mut self.1
        }
    }
    let sync: SharedSync = Arc::new(Mutex::new(CountSync(
        updates.clone(),
        SyncActivity::default(),
    )));
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: None,
            final_render: LoopRender::Settings(RenderSettings {
                // Keep enough work and short tick batches to observe several
                // refill leases before this fixture reaches its sample cap.
                max_samples: 16384,
                time_budget_ms: 1.,
                batch_samples: true,
                aovs: 1,
                aov_samples: 3,
                ..Default::default()
            }),
            syncs: vec![sync.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        !render_loop.final_render().refill_ready(),
        "no queued sampling must not grant a refill"
    );
    tick_until(&mut render_loop, |l, _| l.needs_refill());
    assert!(render_loop.final_render().gpu_sample_time_ms().unwrap() > 0.);
    let table: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/display-schedule.json"
    ))
    .unwrap();
    for ms in table["refillSampleTimesMs"].as_array().unwrap() {
        let render = render_loop.final_render();
        let mut settings = render.settings().unwrap();
        settings.time_budget_ms = render.gpu_sample_time_ms().unwrap() * 21. / ms.as_f64().unwrap();
        render.set_settings(settings).unwrap();
        assert!(
            render_loop.needs_refill(),
            "backend queue limits permit refilling expensive samples"
        );
    }

    let samples = render_loop.samples();
    let presentations = render_loop.presentations();
    let sync_updates = updates.load(std::sync::atomic::Ordering::Relaxed);
    let deadline = Instant::now() + Duration::from_millis(15);
    while render_loop.samples() == samples && Instant::now() < deadline {
        render_loop.refill().unwrap();
        std::thread::yield_now();
    }
    assert!(render_loop.samples() > samples);
    assert_eq!(render_loop.presentations(), presentations);
    assert_eq!(
        updates.load(std::sync::atomic::Ordering::Relaxed),
        sync_updates
    );
    render_loop.cancel_refill();
    assert!(!render_loop.refill().unwrap());
    tick_until(&mut render_loop, |l, _| l.needs_refill());
    std::thread::sleep(Duration::from_millis(17));
    assert!(!render_loop.refill().unwrap());
    tick_until(&mut render_loop, |l, _| l.needs_refill());
    sync.lock().unwrap().set_active(true);
    assert!(!render_loop.refill().unwrap());
    render_loop.tick().unwrap();
    let s = render_loop.final_render().settings().unwrap();
    assert!(
        s.batch_samples,
        "interaction must override one call, preserving user settings"
    );
    sync.lock().unwrap().set_active(false);
    let mut camera = Camera::default();
    camera.world_matrix[12] = 0.2;
    engine.set_camera(Some(camera)).unwrap();
    assert!(!render_loop.refill().unwrap());
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    let _events = render_loop.on_sample(move |e| observed.lock().unwrap().push(e.samples));
    let mut display = engine.display().settings();
    display.channel = Channel::Depth;
    engine.display().set_settings(display).unwrap();
    tick_until(&mut render_loop, |_, s| s == RenderLoopStatus::Finished);
    assert_eq!(render_loop.final_render().aov_samples_rendered(), 3);
    assert_eq!(render_loop.samples(), render_loop.final_render().samples());
    assert!(
        events.lock().unwrap().is_empty(),
        "AOV samples must not emit beauty sample events"
    );
    assert!(!render_loop.needs_refill());
}

#[test]
#[ignore = "requires real GPU"]
fn jnlm_shapes_recompose_without_changing_accumulation() {
    let _test = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = super::aov_tests::aov_engine(Backend::Software);
    let display = engine.display();
    display.set_size(24, 16).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 16,
            ..Default::default()
        },
    )
    .unwrap();
    render
        .set_jnlm_display_filter(Some(JnlmOptions::default()))
        .unwrap();
    render.converge(ConvergeOptions::new(16)).unwrap();
    let hdr = render.read_pixels(PixelKind::Hdr).unwrap();
    let mut settings = display.settings();
    settings.vignette = 0.3;
    settings.bloom_intensity = 0.15;
    settings.tone_mapping_exposure = 1.2;
    display.set_settings(settings).unwrap();
    render.set_jnlm_display_filter(None).unwrap();
    let raw = display.read_rgba8(&render).unwrap().2;
    let mut images = Vec::new();
    for options in [
        JnlmOptions::default(),
        JnlmOptions {
            strength: 0.3,
            search_radius: 2,
            patch_radius: 0,
            albedo_bandwidth: 0.07,
            normal_bandwidth: 0.02,
            iterations: 1,
        },
        JnlmOptions {
            strength: 2.,
            search_radius: 7,
            patch_radius: 3,
            albedo_bandwidth: 0.2,
            normal_bandwidth: 0.1,
            iterations: 4,
        },
    ] {
        render.set_jnlm_display_filter(Some(options)).unwrap();
        let image = display.read_rgba8(&render).unwrap().2;
        assert_eq!(display.read_rgba8(&render).unwrap().2, image);
        assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), hdr);
        assert_eq!(render.samples(), 16);
        images.push(image);
    }
    assert!(images.iter().any(|image| *image != raw));
    assert!(images.windows(2).any(|pair| pair[0] != pair[1]));
    render.set_jnlm_display_filter(None).unwrap();
    assert_eq!(display.read_rgba8(&render).unwrap().2, raw);
    if let Some(folder) = std::env::var_os("MUTRACER_JNLM_EVIDENCE") {
        let folder = std::path::PathBuf::from(folder);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("raw.rgba8"), raw).unwrap();
        for (i, image) in images.iter().enumerate() {
            std::fs::write(folder.join(format!("shape-{i}.rgba8")), image).unwrap();
        }
    }
}

#[test]
#[ignore = "requires real GPU"]
fn jnlm_composes_and_exports_without_changing_beauty_and_large_oidn_prefilters_guides() {
    let _test = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = super::aov_tests::aov_engine(Backend::Software);
    engine.display().set_size(24, 16).unwrap();
    engine.set_scene(&lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 8,
            ..Default::default()
        },
    )
    .unwrap();
    render
        .set_jnlm_display_filter(Some(JnlmOptions::default()))
        .unwrap();
    render.converge(ConvergeOptions::new(8)).unwrap();
    let hdr = render.read_pixels(PixelKind::Hdr).unwrap();
    let display = engine.display();
    let (_, _, filtered) = display.read_rgba8(&render).unwrap();
    assert_eq!(filtered.len(), 24 * 16 * 4);
    assert_eq!(
        display.read_rgba8(&render).unwrap().2,
        filtered,
        "a finished filter is stable"
    );
    render.set_jnlm_display_filter(None).unwrap();
    let raw = display.read_rgba8(&render).unwrap().2;
    assert_ne!(raw, filtered, "JNLM should filter this noisy scene");
    assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), hdr);
    assert_eq!(render.samples(), 8);
    for filename in ["rt_hdr_alb_nrm_small.tza", "rt_hdr_calb_cnrm_large.tza"] {
        render
            .set_denoiser(Some(DenoiserOptions {
                backend: DENOISE_OIDN_WEBGPU,
                library: Some(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../oidn/weights")
                        .join(filename),
                ),
                max_tile_size: 32,
                ..Default::default()
            }))
            .unwrap();
        render.converge(ConvergeOptions::new(8)).unwrap();
        assert!(
            render
                .read_pixels(PixelKind::Denoised)
                .unwrap()
                .data
                .iter()
                .all(|v| v.is_finite())
        );
        assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), hdr);
    }
}

#[test]
#[ignore = "requires real GPU"]
fn grounded_background_edits_match_fresh_contexts() {
    use crate::scene_api::{Environment, GroundedBackground, Scene, Texture, TexturePixels};
    let _test = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = super::aov_tests::aov_engine(Backend::Software);
    engine.display().set_size(16, 12).unwrap();
    let mut scene = Scene::new();
    let geometry = scene
        .add_geometry(crate::scene_api::Geometry::new(
            vec![-0.7, -0.5, 0., 0.7, -0.5, 0., 0., 0.5, 0.],
            vec![0, 1, 2],
        ))
        .unwrap();
    let material = scene
        .add_material(crate::scene_api::OpenPbrMaterial::default())
        .unwrap();
    scene
        .add_mesh(crate::scene_api::Mesh::new(geometry, material))
        .unwrap();
    let pixels: Vec<f32> = (0..4)
        .flat_map(|y| (0..8).flat_map(move |x| [x as f32 / 7., y as f32 / 3., 0.2, 1.]))
        .collect();
    let texture = scene
        .add_texture(Texture {
            pixels: TexturePixels::Rgba32F(pixels.into()),
            ..Texture::rgba8(8, 4, vec![])
        })
        .unwrap();
    scene
        .set_environment(Environment {
            texture: Some(texture),
            background: Some(texture),
            ..Default::default()
        })
        .unwrap();
    let mut camera = Camera::default();
    camera.world_matrix[13] = 1.;
    camera.world_matrix[14] = 3.;
    engine.set_camera(Some(camera)).unwrap();
    let settings = RenderSettings {
        max_samples: 2,
        bevel: false,
        dispersion_wavelengths: 1,
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone()).unwrap();
    let mut previous = None;
    for value in [
        Some(GroundedBackground {
            height: 1.6,
            radius: 32.,
            ground_height: 0.,
            center: [0., 0.],
        }),
        Some(GroundedBackground {
            height: 2.7,
            radius: 30.,
            ground_height: -0.2,
            center: [0.3, -0.2],
        }),
        None,
    ] {
        scene.set_grounded_background(value).unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(2)).unwrap();
        let descriptor =
            expected_descriptor(&scene.descriptor().unwrap(), [16, 12], 0, Some(&camera));
        let actual = images(&render);
        assert_bytes(
            &actual,
            &oracle(0, &descriptor, &settings.l0(settings.sample_cap(2), 0), 2),
            "ground projection",
        );
        if let Some(before) = previous {
            assert_ne!(
                actual[0], before,
                "projection changes must reach the retained scene"
            );
        }
        previous = Some(actual[0].clone());
    }
}
