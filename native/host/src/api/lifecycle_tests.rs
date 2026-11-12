use super::*;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

pub(super) fn fixture() -> (Engine, Arc<Render>) {
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    engine.display().set_size(8, 6).unwrap();
    let render = Arc::new(
        Render::new(
            &engine,
            RenderSettings {
                max_samples: 2,
                ..Default::default()
            },
        )
        .unwrap(),
    );
    (engine, render)
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn partial_flight_recovery_matches_clean_converge_on_both_backends() {
    let _lock = crate::abi_test_lock();
    for backend in [Backend::Software, Backend::Hardware] {
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        engine.display().set_size(32, 24).unwrap();
        engine.set_scene(&crate::scene::tests::input()).unwrap();
        engine.update().unwrap();
        let settings = RenderSettings {
            max_samples: 8,
            seed: 12345,
            ..Default::default()
        };
        let clean = Render::new(&engine, settings.clone()).unwrap();
        clean.converge(ConvergeOptions::new(8)).unwrap();
        let expected: Vec<_> = [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo]
            .into_iter()
            .map(|kind| {
                clean
                    .read_pixels(kind)
                    .unwrap()
                    .data
                    .iter()
                    .map(|v| v.to_bits())
                    .collect::<Vec<_>>()
            })
            .collect();
        for partial in [0, 2, 7] {
            let render = Render::new(&engine, settings.clone()).unwrap();
            engine
                .inner
                .gpu
                .recovery_test
                .lock()
                .unwrap()
                .partial_sample = Some(partial);
            let mut options = ConvergeOptions::new(8);
            options.samples_per_batch = 8;
            render.converge(options).unwrap();
            assert_eq!(render.samples(), 8);
            assert_eq!(render.status(), RenderStatus::Finished);
            assert_eq!(
                render.gpu_sample_time_ms(),
                None,
                "repaired-only job fabricated a timing"
            );
            for (i, kind) in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo]
                .into_iter()
                .enumerate()
            {
                assert_eq!(
                    render
                        .read_pixels(kind)
                        .unwrap()
                        .data
                        .iter()
                        .map(|v| v.to_bits())
                        .collect::<Vec<_>>(),
                    expected[i],
                    "backend={backend:?} partial={partial}"
                );
            }
            assert!(engine.display().present(&render).unwrap().is_some());
            assert!(engine.last_error().is_none());
        }
        assert_eq!(engine.inner.gpu.recovery_test.lock().unwrap().repairs, 3);
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn persistent_repair_failure_keeps_error_and_sample_accounting() {
    let _lock = crate::abi_test_lock();
    for blocking in [false, true] {
        let (engine, render) = fixture();
        engine.display().set_size(32, 24).unwrap();
        engine.set_scene(&crate::scene::tests::input()).unwrap();
        engine.update().unwrap();
        {
            let mut hook = engine.inner.gpu.recovery_test.lock().unwrap();
            hook.partial_sample = Some(0);
            hook.repair_failures = 100;
        }
        if blocking {
            assert_eq!(
                render.converge(ConvergeOptions::new(2)).unwrap_err().status,
                Status::ContextFailed
            );
        } else {
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            while render.refine().unwrap() != RenderStatus::Error {
                assert!(std::time::Instant::now() < deadline);
            }
        }
        assert_eq!(render.samples(), 0, "unrepairable flight credited samples");
        assert_eq!(render.status(), RenderStatus::Error);
        let error = engine.last_error().unwrap();
        assert!(
            error.contains("controlled partial flight failure")
                && error.contains("controlled persistent repair failure"),
            "{error}"
        );
        assert_eq!(engine.inner.gpu.recovery_test.lock().unwrap().repairs, 1);
        engine
            .inner
            .gpu
            .recovery_test
            .lock()
            .unwrap()
            .repair_failures = 0;
        drop(render);
        let fresh = Render::new(
            &engine,
            RenderSettings {
                max_samples: 2,
                ..Default::default()
            },
        )
        .unwrap();
        fresh.converge(ConvergeOptions::new(2)).unwrap();
        assert_eq!(fresh.samples(), 2);
        assert_eq!(fresh.status(), RenderStatus::Finished);
    }
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn execution_failure_is_reported_and_a_new_render_recovers() {
    let _lock = crate::abi_test_lock();
    for blocking in [false, true] {
        let (engine, render) = fixture();
        engine.set_scene(&crate::scene::tests::input()).unwrap();
        engine.update().unwrap();
        let errors = Arc::new(Mutex::new(Vec::new()));
        let sink = errors.clone();
        let _subscription = engine.on(move |event| {
            if let EngineEvent::Error { message } = event {
                sink.lock().unwrap().push(message.clone());
            }
        });
        let other = render.clone();
        let injection = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                let state = other.engine().lock();
                let context = state.renders[&other.id()].context();
                if crate::context::inject_flight_failure(
                    context,
                    "controlled Metal execution failure",
                ) {
                    break;
                }
                drop(state);
                assert!(std::time::Instant::now() < deadline, "no flight to inject");
                std::thread::yield_now();
            }
        });
        if blocking {
            let error = render.converge(ConvergeOptions::new(2)).unwrap_err();
            assert_eq!(error.status, Status::ContextFailed);
        } else {
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            while render.refine().unwrap() != RenderStatus::Error {
                assert!(std::time::Instant::now() < deadline);
                std::thread::yield_now();
            }
        }
        injection.join().unwrap();
        assert_eq!(render.status(), RenderStatus::Error);
        assert_eq!(render.samples(), 0, "failed flight credited samples");
        assert!(
            engine
                .last_error()
                .unwrap()
                .contains("controlled Metal execution failure")
        );
        assert!(
            errors
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.contains("controlled Metal execution failure"))
        );
        drop(render);
        let recovered = Render::new(
            &engine,
            RenderSettings {
                max_samples: 2,
                ..Default::default()
            },
        )
        .unwrap();
        recovered.converge(ConvergeOptions::new(2)).unwrap();
        assert_eq!(recovered.status(), RenderStatus::Finished);
        assert_eq!(recovered.samples(), 2);
        assert!(
            recovered
                .read_pixels(PixelKind::Hdr)
                .unwrap()
                .data
                .iter()
                .all(|v| v.is_finite())
        );
    }
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn backlog_compile_status_is_observable_on_actual_miss() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture();
    let (entered, receive) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    *engine.inner.gpu.compilation.hold.lock().unwrap() = Some((entered, resumed));
    engine.set_scene(&crate::scene::tests::input()).unwrap();
    engine.update().unwrap();
    receive.recv_timeout(Duration::from_secs(30)).unwrap();
    let status = render.status();
    let compiling = engine.diagnostics().compiling;
    let refined = render.refine();
    resume.send(()).unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    assert_eq!(status, RenderStatus::Compiling);
    assert!(compiling);
    assert_eq!(refined.unwrap(), RenderStatus::Compiling);
    assert!(!engine.diagnostics().compiling);
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn clear_scene_diagnostics_and_cache_reuse() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture();
    assert_eq!(render.status(), RenderStatus::Idle);
    assert!(!engine.diagnostics().has_scene);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let listener = seen.clone();
    let _subscription = engine.on(move |e| listener.lock().unwrap().push(e.clone()));
    let scene = crate::scene::tests::input();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    engine.display().present(&render).unwrap();
    let initial = engine.diagnostics();
    assert!(initial.has_scene && initial.compilations_started > 0);
    assert_eq!(initial.compilations_started, initial.compilations_completed);
    assert_eq!(initial.renders[0].samples, 2);
    let events = seen.lock().unwrap();
    let start = events.iter().position(|e| matches!(e, EngineEvent::Progress { stage: ProgressStage::Compilation, progress } if *progress == 0.)).unwrap();
    let finish = events.iter().position(|e| matches!(e, EngineEvent::Progress { stage: ProgressStage::Compilation, progress } if *progress == 1.)).unwrap();
    let published = events.iter().position(|e| matches!(e, EngineEvent::Progress { stage: ProgressStage::Preparation, progress } if *progress == 1.)).unwrap();
    assert!(start < finish && finish < published);
    drop(events);
    let second = Render::new(&engine, RenderSettings::default()).unwrap();
    engine.clear_scene().unwrap();
    assert!(engine.diagnostics().has_scene); // Recorded, not committed.
    assert!(engine.update().unwrap());
    assert!(!engine.update().unwrap());
    for r in [&*render, &second] {
        assert_eq!(r.status(), RenderStatus::Idle);
        assert_eq!(r.samples(), 0);
        assert_eq!(r.refine().unwrap(), RenderStatus::Idle);
        assert!(r.get_output_texture(OutputKind::Hdr).unwrap().is_none());
        assert!(engine.display().present(r).unwrap().is_none());
    }
    assert!(engine.display().texture().is_none());
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    assert_eq!(render.samples(), 2);
    assert!(engine.diagnostics().pipeline_cache_hits > initial.pipeline_cache_hits);
    // Clear while a full candidate is pending, then immediately reload.
    engine.clear_scene().unwrap();
    engine.update().unwrap();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    engine.clear_scene().unwrap();
    engine.update().unwrap();
    assert!(!engine.diagnostics().preparing);
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
}

#[test]
#[ignore = "requires a real GPU; device and scene diagnostics only"]
fn material_texture_diagnostics_report_enabled_device_and_committed_scene() {
    let _lock = crate::abi_test_lock();
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    let before = engine.diagnostics();
    assert_eq!(before.material_textures_bindless, None);
    assert_eq!(
        before.material_texture_budget_bytes,
        crate::texture_budget::bytes() as u64
    );
    engine.set_scene(&crate::scene::small_fixture()).unwrap();
    engine.update().unwrap();
    {
        let mut state = engine.lock();
        let mut events = Vec::new();
        while !matches!(
            super::render::scene_step(&mut state, true, &mut events).unwrap(),
            super::render::SceneStep::Published
        ) {}
    }
    let current = engine.diagnostics();
    assert_eq!(
        current.material_textures_bindless,
        Some(current.bindless_texture_capacity > 0)
    );
    eprintln!(
        "{}",
        serde_json::json!({"adapter": current.info.adapter_name, "bindlessEnabled": current.bindless_texture_capacity > 0, "capacity": current.bindless_texture_capacity, "sceneBindless": current.material_textures_bindless, "textureBudgetMiB": current.material_texture_budget_bytes / (1024 * 1024)})
    );
    engine.clear_scene().unwrap();
    engine.update().unwrap();
    assert_eq!(engine.diagnostics().material_textures_bindless, None);
}
