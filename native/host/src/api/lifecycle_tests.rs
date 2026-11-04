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
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn backlog_compile_status_is_observable_on_actual_miss() {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
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
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
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
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
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
