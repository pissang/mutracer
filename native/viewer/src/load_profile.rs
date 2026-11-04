//! Opt-in loading measurements through the same drop, assembly and tick path as
//! the window. Keep receive/tick timings separate from deliberate polling sleeps.
use crate::{Viewer, renderer};
use anyhow::{Result, ensure};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn settle(viewer: &mut Viewer, ctx: &eframe::egui::Context) -> Result<serde_json::Value> {
    let started = Instant::now();
    let mut frames = Vec::new();
    let mut first_image = None;
    loop {
        let receive = Instant::now();
        viewer.receive_model(ctx);
        let receive_ms = receive.elapsed().as_secs_f64() * 1000.;
        let tick = Instant::now();
        viewer.tick(ctx)?;
        let tick_ms = tick.elapsed().as_secs_f64() * 1000.;
        ensure!(viewer.error.is_empty(), "{}", viewer.error);
        let loading = viewer.loading.is_some();
        let assembling = viewer.scene_build.is_some() || viewer.candidate.is_some();
        let preparing = viewer.target.preparing();
        // Ignore the old scene's presentation while a new model is pending.
        if !loading
            && !assembling
            && !preparing
            && viewer.pending_model.is_none()
            && viewer.pose_presented
            && viewer.frame_samples > 0
            && first_image.is_none()
        {
            first_image = Some(started.elapsed().as_secs_f64());
        }
        frames.push(
            serde_json::json!({"elapsedSeconds":started.elapsed().as_secs_f64(),
            "receiveMs":receive_ms,"tickMs":tick_ms,"loading":loading,
            "assembling":assembling,"preparing":preparing,"samples":viewer.frame_samples}),
        );
        if !loading && !assembling && viewer.settled() {
            return Ok(
                serde_json::json!({"seconds":started.elapsed().as_secs_f64(),
                "firstImageSeconds":first_image,"frames":frames}),
            );
        }
        ensure!(
            started.elapsed() < Duration::from_secs(300),
            "Loading timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

pub fn run(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    mutracer_native_probe::logging::stderr();
    let backend: u32 = std::env::var("MUTRACER_SCENE_BACKEND")
        .unwrap_or_else(|_| "1".into())
        .parse()?;
    ensure!(backend <= 1, "Loading profile requires backend 0 or 1");
    let ctx = eframe::egui::Context::default();
    let mut viewer = Viewer::new(&crate::default_model())?;
    viewer.backend = backend;
    viewer.size = [96, 64];
    viewer.settings.max_samples = 8;
    viewer.preview_enabled = false;
    viewer.denoise = false;
    viewer.focus.enabled = false;
    let startup = settle(&mut viewer, &ctx)?;
    let mut output = ctx.run_ui(
        eframe::egui::RawInput {
            dropped_files: vec![crate::dropped_file(path.to_path_buf())],
            ..Default::default()
        },
        |ui| viewer.input_files(ui.ctx()),
    );
    output.textures_delta.clear();
    ensure!(viewer.loading.is_some(), "Drop did not start loading");
    let dropped = settle(&mut viewer, &ctx)?;
    let active_backend = viewer.render_backend()?;
    ensure!(
        active_backend == backend,
        "Loading profile backend fell back"
    );
    let model = serde_json::json!({"meshes":viewer.model.meshes.len(),
        "geometries":viewer.model.geometries.len(),"textures":viewer.model.textures.len()});
    let environment = serde_json::json!({
        "name":viewer.environment.name,"sceneLighting":viewer.environment.model_lighting,
        "selectedSize":viewer.environment.image.as_ref().map(|i| [i.width(),i.height()]),
        "selectedPeak":viewer.environment.image.as_ref().map(|i| i.as_raw().iter().copied().fold(0f32,f32::max)),
        "sceneSize":viewer.model.1.environment.as_ref().map(|i| [i.width(),i.height()]),
        "selectedSceneImage":match (&viewer.environment.image,&viewer.model.1.environment) {
            (Some(a),Some(b))=>std::sync::Arc::ptr_eq(a,b),_=>false,
        },
        "companionSize":viewer.model.1.dropped_environment.as_ref().map(|(i,_)| [i.width(),i.height()]),
        "warnings":viewer.model.warnings,
    });
    std::fs::write(
        out.join("loaded.json"),
        serde_json::to_vec_pretty(&dropped)?,
    )?;
    for kind in 0..3 {
        let pixels = viewer.image(kind)?;
        ensure!(
            pixels.iter().all(|v| v.is_finite()),
            "Non-finite image {kind}"
        );
        std::fs::write(
            out.join(format!("image-{kind}.rgba32f")),
            pixels
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        )?;
        if kind == 0 {
            renderer::save(&out.join("preview.png"), &pixels, viewer.size, 0.)?;
        }
    }
    // Replace the large scene through the same async import path, measuring both
    // publication and retirement while the caller is receiving/ticking frames.
    viewer.load(crate::default_model(), &ctx);
    let replaced = settle(&mut viewer, &ctx)?;
    let started = Instant::now();
    drop(viewer);
    let report = serde_json::json!({"path":path,"backend":backend,"activeBackend":active_backend,
        "model":model,"environment":environment,"startup":startup,
        "dropped":dropped,"replaced":replaced,"destroySeconds":started.elapsed().as_secs_f64()});
    std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&report)?)?;
    println!("Loading profile: {}", out.display());
    Ok(())
}
