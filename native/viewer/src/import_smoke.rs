//! Real async file import and authored-camera image regression.
use crate::{
    Change, Viewer,
    renderer::{self, Renderer},
};
use anyhow::{Result, ensure};
use std::{
    path::Path,
    time::{Duration, Instant},
};
fn settle(viewer: &mut Viewer, ctx: &eframe::egui::Context) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        viewer.receive_model(ctx);
        viewer.tick(ctx)?;
        ensure!(viewer.error.is_empty(), "{}", viewer.error);
        if viewer.loading.is_none() && viewer.candidate.is_none() && viewer.settled() {
            return Ok(());
        }
        ensure!(Instant::now() < deadline, "Import did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn capture(viewer: &Viewer, out: &Path, tag: &str) -> Result<f32> {
    let hdr = viewer.hdr()?;
    let peak = hdr
        .chunks_exact(4)
        .flat_map(|p| p[..3].iter())
        .copied()
        .fold(0f32, f32::max);
    ensure!(hdr.iter().all(|v| v.is_finite()), "Non-finite import image");
    std::fs::write(
        out.join(format!("{tag}.rgba32f")),
        hdr.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>(),
    )?;
    renderer::save(&out.join(format!("{tag}.png")), &hdr, viewer.size, 0.)?;
    Ok(peak)
}
pub fn run(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut results = Vec::new();
    for backend in [0, 1] {
        let dest = out.join(format!("backend-{backend}"));
        std::fs::create_dir_all(&dest)?;
        let ctx = eframe::egui::Context::default();
        let mut viewer = Viewer::new(&crate::default_model())?;
        viewer.backend = backend;
        viewer.size = [96, 64];
        viewer.settings.max_samples = 8;
        viewer.preview_enabled = false;
        viewer.denoise = false;
        viewer.focus.enabled = false;
        settle(&mut viewer, &ctx)?;
        let mut output = ctx.run_ui(
            eframe::egui::RawInput {
                dropped_files: vec![crate::dropped_file(path.to_path_buf())],
                ..Default::default()
            },
            |ui| viewer.input_files(ui.ctx()),
        );
        output.textures_delta.clear();
        ensure!(
            viewer.loading.is_some(),
            "Dropped file did not start importing"
        );
        settle(&mut viewer, &ctx)?;
        let loaded = capture(&viewer, &dest, "dropped")?;
        let loaded_hdr = viewer.hdr()?;
        let imported_eye = viewer.camera.eye();
        let authored = viewer.model.1.cameras.first().cloned();
        if let Some(view) = &authored {
            view.apply(&mut viewer.camera, viewer.model.center);
            viewer.dirty(Change::Camera);
            settle(&mut viewer, &ctx)?;
        }
        let selected = capture(&viewer, &dest, "authored")?;
        if authored.is_some() {
            ensure!(
                viewer.camera_index == Some(0) && loaded_hdr == viewer.hdr()?,
                "Dropped model did not open on its first authored view"
            );
        }
        let mut startup = Viewer::new(path)?;
        startup.backend = backend;
        startup.size = viewer.size;
        startup.settings = viewer.settings;
        startup.preview_enabled = false;
        startup.denoise = false;
        startup.focus.enabled = false;
        settle(&mut startup, &ctx)?;
        capture(&startup, &dest, "startup")?;
        ensure!(
            startup.hdr()? == loaded_hdr,
            "Startup and dropped file differ"
        );
        let mut fresh = Renderer::with_backend(backend)?;
        fresh.commit_with_settings(
            &viewer.model.descriptor_with_light(
                &viewer.camera.bytes(viewer.size),
                viewer.size,
                &viewer.environment,
                &viewer.light,
            ),
            &viewer.settings,
        )?;
        ensure!(
            viewer.hdr()? == fresh.finish(8)?,
            "Import differs from fresh renderer"
        );
        results.push(serde_json::json!({"backend":backend,"loadedPeak":loaded,"authoredPeak":selected,"loadedEye":imported_eye.to_array(),"authoredEye":viewer.camera.eye().to_array(),"cameraIndex":viewer.camera_index,"cameras":viewer.model.1.cameras.len(),"environment":viewer.environment.name,"authoredLighting":viewer.model.1.authored,"availableLighting":viewer.model.1.available}));
    }
    std::fs::write(
        out.join("summary.json"),
        serde_json::to_vec_pretty(&results)?,
    )?;
    println!("{}", serde_json::to_string(&results)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model_files::tests::Folder, scene::Environment};

    fn drop_files(viewer: &mut Viewer, ctx: &eframe::egui::Context, paths: &[&Path]) {
        let mut output = ctx.run_ui(
            eframe::egui::RawInput {
                dropped_files: paths
                    .iter()
                    .map(|p| crate::dropped_file(p.to_path_buf()))
                    .collect(),
                ..Default::default()
            },
            |ui| viewer.input_files(ui.ctx()),
        );
        output.textures_delta.clear();
    }
    fn wait(viewer: &mut Viewer, ctx: &eframe::egui::Context, expected_name: &str) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            viewer.receive_model(ctx);
            viewer.environment_browser(ctx);
            viewer.tick(ctx)?;
            ensure!(viewer.error.is_empty(), "{}", viewer.error);
            if viewer.loading.is_none()
                && viewer.candidate.is_none()
                && viewer.settled()
                && viewer.environment.name == expected_name
            {
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "Dropped HDR/model did not settle: {}",
                viewer.environment.name
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    #[test]
    #[ignore = "requires a real GPU; checks HDR, model+HDR and folder drops on both backends"]
    fn independent_hdr_is_applied_for_all_drop_variants() -> Result<()> {
        let folder = Folder::new();
        let model = folder.model("package/models/scene.glb");
        let hdr = folder.hdr("package/env/light.HDR", [128, 80, 32, 130]);
        let alternate = folder.hdr("alternate.hdr", [32, 64, 128, 130]);
        let package = folder.0.join("package");
        let mut reports = vec![];
        for backend in [0, 1] {
            let ctx = eframe::egui::Context::default();
            let mut viewer = Viewer::new(&crate::default_model())?;
            viewer.backend = backend;
            viewer.size = [96, 64];
            viewer.settings.max_samples = 8;
            viewer.preview_enabled = false;
            viewer.denoise = false;
            viewer.focus.enabled = false;
            viewer.camera = viewer.model.camera_for_load(&viewer.camera);
            settle(&mut viewer, &ctx)?;
            let original = viewer.hdr()?;
            drop_files(&mut viewer, &ctx, &[&hdr]);
            wait(&mut viewer, &ctx, "light.HDR")?;
            ensure!(
                viewer.model.1.dropped_environment.is_none(),
                "HDR-only drop changed the model"
            );
            ensure!(
                viewer.environment.image.as_ref().unwrap().get_pixel(0, 0).0 == [2., 1.25, 0.5],
                "Wrong standalone HDR data"
            );
            let standalone = viewer.hdr()?;
            ensure!(
                standalone != original,
                "HDR drop did not change the rendered image"
            );
            drop_files(&mut viewer, &ctx, &[&model, &alternate]);
            wait(&mut viewer, &ctx, "alternate.hdr")?;
            ensure!(
                viewer.model.1.dropped_environment.is_some(),
                "Explicit HDR was not associated with the model load"
            );
            ensure!(
                viewer.environment.image.as_ref().unwrap().get_pixel(0, 0).0 == [0.5, 1., 2.],
                "Wrong paired HDR data"
            );
            ensure!(
                viewer.hdr()? != standalone,
                "Paired HDR did not change the rendered image"
            );
            drop_files(&mut viewer, &ctx, &[&package]);
            wait(&mut viewer, &ctx, "light.HDR")?;
            let dropped = viewer.hdr()?;
            let expected =
                crate::scene::Model::load(&model)?.environment_for_load(&Environment::default());
            ensure!(
                expected.name != viewer.environment.name,
                "Fixture did not exercise folder HDR discovery"
            );
            let mut fresh = Renderer::with_backend(backend)?;
            fresh.commit_with_settings(
                &viewer.model.descriptor_with_light(
                    &viewer.camera.bytes(viewer.size),
                    viewer.size,
                    &viewer.environment,
                    &viewer.light,
                ),
                &viewer.settings,
            )?;
            ensure!(
                fresh.finish(8)? == dropped,
                "Folder HDR render differs from a full commit"
            );
            ensure!(
                standalone == dropped,
                "Folder HDR and separately dropped HDR render differently"
            );
            reports.push(serde_json::json!({"requestedBackend":backend,"actualBackend":format!("{:?}",viewer.final_render().backend()?),"standalone":true,"paired":true,"folder":true,"fullCommitHdrExact":true,"separateHdrExact":true}));
        }
        if let Some(out) = std::env::var_os("MUTRACER_DROP_HDR_EVIDENCE") {
            std::fs::create_dir_all(&out)?;
            std::fs::write(
                std::path::PathBuf::from(out).join("summary.json"),
                serde_json::to_vec_pretty(&reports)?,
            )?;
        }
        println!("{}", serde_json::to_string(&reports)?);
        Ok(())
    }
}
