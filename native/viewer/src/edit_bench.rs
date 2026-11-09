//! `--edit-bench DIRECTORY`: commit latency of interactive edits on one model,
//! through a bare L0 context (`"path": "l0"`) and the way the viewer hands edits to
//! its engine (`"path": "l1"`).
use crate::renderer::{Camera, RenderSettings, Renderer};
use crate::scene::{Descriptor, Environment, KeyLight, Model};
use anyhow::{Result, ensure};
use mutracer_native::api;
use std::{path::Path, time::Instant};

const ITERATIONS: usize = 12;
const SIZE: [u32; 2] = [1280, 720];
const KINDS: [&str; 5] = ["material", "transform", "camera", "light", "environment"];

struct Scene {
    model: Model,
    camera: Camera,
    environment: Environment,
    light: KeyLight,
}
impl Scene {
    fn descriptor<'a>(&self, cached: &'a mut Option<Descriptor>) -> &'a [u8] {
        self.model.update_descriptor(
            cached,
            &self.camera.bytes(SIZE),
            SIZE,
            &self.environment,
            &self.light,
        )
    }
    /// Applies edit `kind` for iteration `i`; alternating values keep every commit a change.
    fn edit(&mut self, kind: &str, i: usize) {
        let flip = if i % 2 == 0 { 1.0 } else { -1.0 };
        match kind {
            "material" => self.model.0.materials[0].roughness = if i % 2 == 0 { 0.3 } else { 0.6 },
            "transform" => {
                let mesh = &mut self.model.0.meshes[0];
                mesh.transform.w_axis.x += 0.001 * flip;
            }
            "camera" => self.camera.orbit([0.002 * flip, 0.0]),
            "light" => self.light.intensity = if i % 2 == 0 { 2.0 } else { 3.0 },
            "environment" => self.environment.intensity = if i % 2 == 0 { 0.8 } else { 1.2 },
            _ => unreachable!(),
        }
    }
}

pub fn run(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    mutracer_native::logging::stderr();
    let model = Model::load(path)?;
    let camera = Camera::fit(model.0.center, model.0.radius);
    let mut scene = Scene {
        model,
        camera,
        environment: Environment::default(),
        light: KeyLight {
            enabled: true,
            ..KeyLight::default()
        },
    };
    let mut rows = Vec::new();
    for mode in [0, 1] {
        rows.extend(l1(&mut scene, mode)?);
        let mut renderer = Renderer::with_backend(mode)?;
        let mut descriptor = None;
        let started = Instant::now();
        let bytes = scene.descriptor(&mut descriptor);
        let build = started.elapsed().as_secs_f64() * 1e3;
        renderer.commit(bytes)?;
        let initial = started.elapsed().as_secs_f64() * 1e3 - build;
        rows.push(
            serde_json::json!({"path": "l0", "mode": mode, "kind": "initial",
            "descriptorBytes": bytes.len(), "buildMs": build, "commitMs": initial}),
        );
        for kind in KINDS {
            for i in 0..ITERATIONS {
                scene.edit(kind, i);
                let started = Instant::now();
                let bytes = scene.descriptor(&mut descriptor);
                let build = started.elapsed().as_secs_f64() * 1e3;
                renderer.commit(bytes)?;
                let commit = started.elapsed().as_secs_f64() * 1e3 - build;
                rows.push(
                    serde_json::json!({"path": "l0", "mode": mode, "kind": kind, "iteration": i,
                    "buildMs": build, "commitMs": commit,
                    "incremental": renderer.last_commit_incremental()?}),
                );
            }
        }
    }
    let text = rows
        .iter()
        .map(|row| row.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(out.join("edit-bench.jsonl"), text + "\n")?;
    println!("{}", out.join("edit-bench.jsonl").display());
    Ok(())
}

/// Hands the descriptor to the engine as `Viewer::push` does.
fn push(engine: &api::Engine, bytes: &[u8]) -> Result<()> {
    engine.set_scene_shared(std::sync::Arc::new(bytes.to_vec()))?;
    Ok(())
}

/// Whether the render is still preparing the scene or compiling its pipelines.
fn pending(render: &api::Render) -> bool {
    matches!(
        render.status(),
        api::RenderStatus::Preparing | api::RenderStatus::Compiling
    )
}

/// The viewer's edit path: patch the cached descriptor, push it, then `Engine::update`
/// commits the final render (incrementally on this thread when it can).
fn l1(scene: &mut Scene, mode: u32) -> Result<Vec<serde_json::Value>> {
    let engine = api::Engine::new(api::EngineOptions {
        backend: if mode == 1 {
            api::Backend::Hardware
        } else {
            api::Backend::Software
        },
    })?;
    let render = api::Render::new(
        &engine,
        crate::render_settings(&RenderSettings::default(), SIZE, false),
    )?;
    let mut rows = Vec::new();
    let mut descriptor = None;
    let started = Instant::now();
    let bytes = scene.descriptor(&mut descriptor);
    let build = started.elapsed().as_secs_f64() * 1e3;
    push(&engine, bytes)?;
    engine.update()?;
    while pending(&render) {
        render.refine()?;
    }
    let initial = started.elapsed().as_secs_f64() * 1e3 - build;
    ensure!(engine.last_error().is_none(), "{:?}", engine.last_error());
    rows.push(
        serde_json::json!({"path": "l1", "mode": mode, "kind": "initial",
        "descriptorBytes": bytes.len(), "buildMs": build, "commitMs": initial}),
    );
    for kind in KINDS {
        for i in 0..ITERATIONS {
            scene.edit(kind, i);
            let started = Instant::now();
            let bytes = scene.descriptor(&mut descriptor);
            let build = started.elapsed().as_secs_f64() * 1e3;
            push(&engine, bytes)?;
            engine.update()?;
            let commit = started.elapsed().as_secs_f64() * 1e3 - build;
            let incremental =
                !pending(&render) && render.last_commit()? == Some(api::CommitKind::Incremental);
            while pending(&render) {
                render.refine()?;
            }
            ensure!(engine.last_error().is_none(), "{:?}", engine.last_error());
            rows.push(
                serde_json::json!({"path": "l1", "mode": mode, "kind": kind, "iteration": i,
                "buildMs": build, "commitMs": commit, "incremental": incremental}),
            );
        }
    }
    Ok(rows)
}
