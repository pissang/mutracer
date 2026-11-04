//! Autofocus behavior and real-device viewer/fresh-context agreement.
use crate::Arc;
use crate::{
    Change, Viewer,
    focus::{self, Status},
    renderer::{Camera, Renderer},
    scene::{Geometry, Mesh, Model},
};
use anyhow::{Result, ensure};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn tick(viewer: &mut Viewer, ctx: &eframe::egui::Context) -> Result<()> {
    viewer.tick(ctx)
}
fn settle(viewer: &mut Viewer, ctx: &eframe::egui::Context) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        viewer.receive_model(ctx);
        tick(viewer, ctx)?;
        if viewer.loading.is_none()
            && viewer.settled()
            && viewer.samples == viewer.settings.max_samples
            && !viewer.focus.working(&viewer.camera)
        {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "Autofocus did not settle: {:?}, {} samples",
            viewer.focus.status,
            viewer.samples
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn measuring(viewer: &mut Viewer, ctx: &eframe::egui::Context) -> Result<()> {
    viewer.focus.request();
    let deadline = Instant::now() + Duration::from_secs(5);
    while viewer.focus.status != Status::Measuring {
        tick(viewer, ctx)?;
        ensure!(Instant::now() < deadline, "No focus measurement");
        std::thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}
fn compare(viewer: &Viewer) -> Result<()> {
    if viewer.focus.active(&viewer.camera) && viewer.focus.status == Status::Locked {
        let expected = focus::measure(&viewer.target.engine, viewer.focus.area)?
            .flatten()
            .unwrap();
        ensure!(
            (viewer.camera.focus_distance - expected).abs() < expected * 1e-5,
            "Locked to an obsolete depth"
        );
    }
    let mut fresh = Renderer::with_backend(viewer.backend)?;
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
        viewer.hdr()? == fresh.finish(viewer.samples)?
            && viewer.image(1)? == fresh.image(1)?
            && viewer.image(2)? == fresh.image(2)?,
        "Focused viewer differs from full commit"
    );
    Ok(())
}
fn measure_model(
    model: &Model,
    camera: &Camera,
    area: [f32; 2],
    size: [u32; 2],
) -> Result<Option<f32>> {
    use mutracer_native_probe::api;
    let engine = api::Engine::new(api::EngineOptions {
        backend: api::Backend::Software,
    })?;
    engine.display().set_size(size[0], size[1])?;
    engine.set_scene(&model.descriptor_with_light(
        &camera.bytes(size),
        size,
        &crate::scene::Environment::default(),
        &crate::scene::KeyLight::default(),
    ))?;
    engine.update()?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(depth) = focus::measure(&engine, area)? {
            return Ok(depth);
        }
        ensure!(
            Instant::now() < deadline,
            "GPU focus query did not become ready"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
pub fn run(path: &Path, out: &Path) -> Result<()> {
    let data: serde_json::Value =
        serde_json::from_slice(&std::fs::read(out.join("web-focus-reference.json"))?)?;
    for case in data["picks"].as_array().unwrap() {
        let mut values: Vec<f32> = case["depths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap() as f32)
            .collect();
        let expected = case["depth"].as_f64().map(|v| v as f32);
        ensure!(
            focus::pick_depth(&mut values, 49) == expected,
            "Web depth cluster mismatch"
        );
    }
    for case in data["pulls"].as_array().unwrap() {
        let (distance, done) = focus::focus_pull(
            case["from"].as_f64().unwrap() as f32,
            case["to"].as_f64().unwrap() as f32,
            case["elapsed"].as_f64().unwrap(),
        );
        let expected = case["distance"].as_f64().unwrap() as f32;
        ensure!(
            (distance - expected).abs() < expected.abs().max(0.001) * 1e-5
                && done == case["done"].as_bool().unwrap(),
            "Web focus pull mismatch"
        );
    }
    let sample = Model::load(path)?;
    for case in data["surfaces"].as_array().unwrap() {
        let mut model = sample.clone();
        let mut geometries = vec![];
        model.0.meshes.clear();
        for plane in case["planes"].as_array().unwrap() {
            let w = plane["width"].as_f64().unwrap() as f32 / 2.;
            let h = plane["height"].as_f64().unwrap() as f32 / 2.;
            let z = plane["z"].as_f64().unwrap() as f32;
            let id = geometries.len();
            geometries.push(Geometry {
                material_indices: Arc::from([]),
                min: glam::Vec3::new(-w, -h, z),
                max: glam::Vec3::new(w, h, z),
                positions: vec![-w, -h, z, w, -h, z, w, h, z, -w, h, z].into(),
                indices: vec![0, 1, 2, 0, 2, 3].into(),
                normals: vec![].into(),
                uv: [vec![].into(), vec![].into()],
                colors: vec![].into(),
                tangents: vec![].into(),
            });
            model.0.meshes.push(Mesh {
                materials: vec![],
                instances: None,
                name: "plane".into(),
                geometry: id,
                material: 0,
                transform: glam::Mat4::IDENTITY,
            });
        }
        model.0.geometries = geometries.into();
        let mut camera = Camera::fit(glam::Vec3::ZERO, 2.);
        camera.yaw = 0.;
        camera.pitch = 0.;
        camera.distance = 5.;
        let area = std::array::from_fn(|i| case["area"][i].as_f64().unwrap() as f32);
        let actual = measure_model(&model, &camera, area, [96, 64])?;
        let expected = case["depth"].as_f64().map(|v| v as f32);
        ensure!(
            match (actual, expected) {
                (None, None) => true,
                (Some(a), Some(b)) => (a - b).abs() < 1e-5,
                _ => false,
            },
            "Web area geometry mismatch"
        );
    }
    println!("PASS Web focus clusters, dioptre pulls and opaque geometry references");
    let ctx = eframe::egui::Context::default();
    for backend in [0, 1] {
        let mut viewer = Viewer::new(path)?;
        viewer.backend = backend;
        viewer.denoise = false;
        viewer.size = [128, 84];
        viewer.settings.max_samples = 8;
        viewer.environment.studio.enabled = true;
        viewer.camera.f_stop = 1.4;
        viewer.camera.meters_per_unit = 0.01;
        viewer.camera.focus_distance *= 0.5;
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        ensure!(
            viewer.render_backend()? == backend && viewer.focus.status == Status::Locked,
            "Autofocus did not lock on requested backend"
        );
        let expected = focus::measure(&viewer.target.engine, viewer.focus.area)?
            .flatten()
            .unwrap();
        ensure!(
            (viewer.camera.focus_distance - expected).abs() < 1e-5,
            "Autofocus depth mismatch"
        );
        compare(&viewer)?;
        // Rendering the actual Camera panel must not quantize a live lens value
        // or interpret display formatting as a manual-focus edit.
        viewer.tab = 4;
        let lens = viewer.camera.focus_distance;
        for _ in 0..3 {
            let mut output = ctx.run_ui(eframe::egui::RawInput::default(), |ui| viewer.panels(ui));
            output.textures_delta.clear();
            ensure!(
                viewer.focus.enabled
                    && viewer.camera.focus_distance == lens
                    && viewer.change == Change::None,
                "Idle Camera panel changed focus or disabled autofocus"
            );
        }
        // A result completed after the view changes cannot pull the old lens target.
        measuring(&mut viewer, &ctx)?;
        let old = viewer.camera.focus_distance;
        viewer.camera.orbit([20., 5.]);
        viewer.dirty(Change::Camera);
        tick(&mut viewer, &ctx)?;
        ensure!(
            viewer.camera.focus_distance == old,
            "Stale camera result applied"
        );
        settle(&mut viewer, &ctx)?;
        compare(&viewer)?;
        // Replace a model while its old query is in flight; fit and refocus the new bounds.
        measuring(&mut viewer, &ctx)?;
        let mut model = viewer.model.clone();
        for mesh in &mut model.0.meshes {
            mesh.transform = glam::Mat4::from_scale(glam::Vec3::splat(2.)) * mesh.transform;
        }
        model.refresh_bounds();
        let mut camera = viewer.camera.clone();
        camera.frame(model.0.center, model.0.radius);
        viewer.candidate = Some((model, camera));
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        compare(&viewer)?;
        // Real asynchronous file load retains lens settings, then refocuses.
        measuring(&mut viewer, &ctx)?;
        viewer.load(path.to_owned(), &ctx);
        settle(&mut viewer, &ctx)?;
        ensure!(
            viewer.camera.f_stop == 1.4 && viewer.camera.meters_per_unit == 0.01,
            "Model load discarded lens settings"
        );
        compare(&viewer)?;
        let current = viewer.camera.focus_distance;
        let generation = viewer.generation;
        viewer.focus.place([0.02, 0.02]);
        ensure!(
            focus::measure(&viewer.target.engine, viewer.focus.area)?
                .flatten()
                .is_none(),
            "Expected empty focus area"
        );
        settle(&mut viewer, &ctx)?;
        ensure!(
            viewer.focus.status == Status::Missed
                && viewer.camera.focus_distance == current
                && viewer.generation == generation,
            "Miss changed lens or accumulation"
        );
        viewer.focus.manual();
        viewer.camera.focus_distance = current * 0.7;
        viewer.dirty(Change::Camera);
        settle(&mut viewer, &ctx)?;
        ensure!(
            !viewer.focus.enabled && viewer.camera.focus_distance == current * 0.7,
            "Manual focus overridden"
        );
        compare(&viewer)?;
        viewer.focus.enabled = true;
        viewer.camera.orthographic = true;
        viewer.focus.request();
        viewer.dirty(Change::Camera);
        settle(&mut viewer, &ctx)?;
        compare(&viewer)?;
        println!(
            "PASS autofocus backend {backend}: stale view/model, async load, misses, manual override, orthographic and fresh HDR/AOV agreement"
        );
    }
    Ok(())
}
