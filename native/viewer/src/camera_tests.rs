//! Camera-only edits must keep the committed scene and agree with full commits.
use crate::*;

fn settle(viewer: &mut Viewer, ctx: &egui::Context) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        viewer.tick(ctx)?;
        ensure!(viewer.error.is_empty(), "{}", viewer.error);
        if viewer.settled() {
            return Ok(());
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "Camera edit timed out"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn matches_fresh(viewer: &Viewer) -> Result<()> {
    let mut fresh = renderer::Renderer::with_backend(viewer.backend)?;
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
        viewer.hdr()? == fresh.finish_l1(viewer.samples)?,
        "Camera/fresh HDR mismatch"
    );
    for kind in [1, 2] {
        ensure!(
            viewer.image(kind)? == fresh.image(kind)?,
            "Camera/fresh guide {kind} mismatch"
        );
    }
    Ok(())
}

#[test]
#[ignore = "requires real GPU with Software BVH and HWRT"]
fn camera_edits_keep_scene_and_survive_material_and_layout_updates() -> Result<()> {
    for backend in [0, 1] {
        let ctx = egui::Context::default();
        let mut viewer = Viewer::new(&default_model())?;
        viewer.backend = backend;
        viewer.size = [96, 64];
        viewer.settings.max_samples = 4;
        viewer.denoise = false;
        viewer.focus.enabled = false;
        settle(&mut viewer, &ctx)?;
        let revision = viewer.target.engine.diagnostics().scene_revision;
        let preparations = viewer.target.preparations.load(Ordering::Relaxed);

        viewer.camera.orbit([12., 3.]);
        viewer.dirty(Change::Camera);
        settle(&mut viewer, &ctx)?;
        ensure!(
            viewer.target.engine.diagnostics().scene_revision == revision,
            "Camera-only input replaced the scene descriptor"
        );
        ensure!(
            viewer.target.preparations.load(Ordering::Relaxed) == preparations,
            "Camera-only input rebuilt scene acceleration"
        );
        matches_fresh(&viewer)?;

        // Imported cameras can be reflected or orthographic; lens edits use the
        // same camera-only path as orbit/pan and retain those camera semantics.
        for (mirrored, orthographic, f_stop) in [(true, false, 4.), (false, true, 0.)] {
            viewer.camera.mirrored = mirrored;
            viewer.camera.orthographic = orthographic;
            viewer.camera.f_stop = f_stop;
            viewer.dirty(Change::Camera);
            settle(&mut viewer, &ctx)?;
            ensure!(
                viewer.target.engine.diagnostics().scene_revision == revision,
                "Projection/lens input replaced the scene descriptor"
            );
            matches_fresh(&viewer)?;
        }

        // A combined material/camera edit replaces the descriptor. It must not
        // leave the previous camera override on top of the newly encoded view.
        viewer.camera.pan([4., 2.]);
        viewer.model.0.materials[viewer.selected].roughness = 0.27;
        viewer.dirty(Change::Material);
        viewer.dirty(Change::Camera);
        settle(&mut viewer, &ctx)?;
        matches_fresh(&viewer)?;

        viewer.camera.orbit([5., -2.]);
        viewer.dirty(Change::Camera);
        settle(&mut viewer, &ctx)?;
        viewer.size = [120, 80];
        viewer.camera.fov = 43.;
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        matches_fresh(&viewer)?;
        println!("PASS camera/scene separation and fresh HDR/guides backend {backend}");
    }
    Ok(())
}
