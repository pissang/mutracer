//! Real-device checks for viewer settings, including the asynchronous commit path.
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
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        viewer.tick(ctx)?;
        if viewer.settled() {
            ensure!(
                viewer.samples == viewer.settings.max_samples,
                "Viewer overshot the sample target"
            );
            return Ok(());
        }
        ensure!(Instant::now() < deadline, "Viewer settings timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn texture_sampling(
    viewer: &mut Viewer,
    ctx: &eframe::egui::Context,
    out: &Path,
    mode: u32,
) -> Result<()> {
    let Some((material, slot)) = viewer
        .model
        .materials
        .iter()
        .enumerate()
        .find_map(|(i, m)| {
            m.maps
                .iter()
                .position(|map| *map != u32::MAX)
                .map(|slot| (i, slot))
        })
    else {
        return Ok(());
    };
    let original = viewer.model.clone();
    let mut images = Vec::new();
    for s in 0..3 {
        for t in 0..3 {
            viewer
                .model
                .set_texture_sampling(material, slot, [s, t], [2.5, -1.5])?;
            viewer.dirty(Change::Material);
            settle(viewer, ctx)?;
            ensure!(
                !viewer.last_commit_full,
                "Sampling-only wrap edit rebuilt the scene"
            );
            let mut fresh = Renderer::with_backend(mode)?;
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
                viewer.hdr()? == fresh.finish_l1(viewer.samples)?
                    && viewer.image(1)? == fresh.image(1)?
                    && viewer.image(2)? == fresh.image(2)?,
                "Texture wrapping/fresh mismatch: backend {mode}, {s}/{t}"
            );
            renderer::save(
                &out.join(format!("wrap-{mode}-{s}-{t}.png")),
                &viewer.hdr()?,
                viewer.size,
                0.,
            )?;
            images.push(viewer.hdr()?);
            println!("PASS texture wrap backend {mode}, {s}/{t}");
        }
    }
    ensure!(
        images.iter().skip(1).any(|image| image != &images[0]),
        "Texture wrapping had no visible effect"
    );
    for scale in [[-2., 0.], [0., 0.], [25., -3.], [1., 1.]] {
        viewer
            .model
            .set_texture_sampling(material, slot, [0, 0], scale)?;
        viewer.dirty(Change::Material);
        settle(viewer, ctx)?;
        let mut fresh = Renderer::with_backend(mode)?;
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
            viewer.hdr()? == fresh.finish_l1(viewer.samples)?
                && viewer.image(1)? == fresh.image(1)?
                && viewer.image(2)? == fresh.image(2)?,
            "Texture repeat/fresh mismatch: backend {mode}, {scale:?}"
        );
        println!("PASS texture repeat backend {mode}, {scale:?}");
    }
    viewer.model = original;
    viewer.dirty(Change::Material);
    settle(viewer, ctx)
}

pub fn run_textures(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    for mode in [0, 1] {
        let mut viewer = Viewer::new(path)?;
        ensure!(
            viewer
                .model
                .materials
                .iter()
                .any(|m| m.maps.iter().any(|map| *map != u32::MAX)),
            "Texture smoke needs a model with an imported texture"
        );
        viewer.denoise = false;
        viewer.focus.enabled = false;
        viewer.backend = mode;
        viewer.size = [96, 64];
        viewer.settings.max_samples = 4;
        let ctx = eframe::egui::Context::default();
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        ensure!(
            viewer.render_backend()? == mode,
            "Requested backend unavailable"
        );
        texture_sampling(&mut viewer, &ctx, out, mode)?;
    }
    Ok(())
}

pub fn run(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    for mode in [0, 1] {
        let mut viewer = Viewer::new(path)?;
        viewer.denoise = false;
        viewer.focus.enabled = false;
        viewer.backend = mode;
        viewer.size = [96, 64];
        viewer.settings.max_samples = 4;
        let ctx = eframe::egui::Context::default();
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        ensure!(
            viewer.render_backend()? == mode,
            "Requested backend unavailable"
        );
        let original = viewer.model.0.materials[viewer.selected].clone();
        for preset in crate::material_presets::presets() {
            preset.apply(&mut viewer.model.0.materials[viewer.selected]);
            viewer.dirty(Change::Material);
            settle(&mut viewer, &ctx)?;
            let mut fresh = Renderer::with_backend(mode)?;
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
                viewer.hdr()? == fresh.finish_l1(viewer.samples)?
                    && viewer.image(1)? == fresh.image(1)?
                    && viewer.image(2)? == fresh.image(2)?,
                "Material preset/fresh mismatch: backend {mode}, {}",
                preset.id
            );
            renderer::save(
                &out.join(format!("material-{mode}-{}.png", preset.id)),
                &viewer.hdr()?,
                viewer.size,
                0.,
            )?;
            println!("PASS material preset backend {mode}, {}", preset.id);
        }
        viewer.model.0.materials[viewer.selected] = original;
        viewer.dirty(Change::Material);
        settle(&mut viewer, &ctx)?;
        for (i, scale) in [0.25, 0.5, 0.75, 1.].into_iter().enumerate() {
            viewer.resolution.scale = Some(scale);
            let now = Instant::now();
            viewer
                .resolution
                .update(eframe::egui::vec2(100., 64.), 2., viewer.size, true, now);
            let size = viewer
                .resolution
                .update(
                    eframe::egui::vec2(100., 64.),
                    2.,
                    viewer.size,
                    false,
                    now + Duration::from_millis(200),
                )
                .unwrap();
            viewer.size = size;
            viewer.dirty(Change::Scene);
            settle(&mut viewer, &ctx)?;
            let mut fresh = Renderer::with_backend(mode)?;
            fresh.commit_with_settings(
                &viewer.model.descriptor_with_light(
                    &viewer.camera.bytes(size),
                    size,
                    &viewer.environment,
                    &viewer.light,
                ),
                &viewer.settings,
            )?;
            ensure!(
                viewer.hdr()?.len() == size[0] as usize * size[1] as usize * 4
                    && viewer.hdr()? == fresh.finish_l1(viewer.samples)?
                    && viewer.image(1)? == fresh.image(1)?
                    && viewer.image(2)? == fresh.image(2)?,
                "Scaled resolution/fresh mismatch: backend {mode}, {scale}"
            );
            let png = out.join(format!("resolution-{mode}-{i}.png"));
            viewer.save_image(&png)?;
            let exported = image::open(&png)?;
            ensure!(
                [exported.width(), exported.height()] == size,
                "Resolution export size mismatch"
            );
        }
        viewer.resolution.scale = None;
        viewer.size = [96, 64];
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        println!("PASS viewport resolution scales and PNG sizes backend {mode}");
        let camera = viewer.camera.clone();
        let settings = viewer.settings;
        let baseline = viewer.hdr()?;
        for case in 0..10 {
            viewer.camera = camera.clone();
            viewer.settings = settings;
            match case {
                0 => viewer.camera.orthographic = true,
                1 => viewer.camera.f_stop = 0.7,
                2 => {
                    viewer.camera.f_stop = 1.4;
                    viewer.camera.meters_per_unit = 0.01;
                }
                3 => {
                    viewer.camera.f_stop = 1.4;
                    viewer.camera.meters_per_unit = 0.01;
                    viewer.camera.focus_distance *= 0.7;
                }
                4 => viewer.settings.bounces = 1,
                5 => viewer.settings.bounces = 12,
                6 => viewer.settings.sampling_pattern = 1,
                7 => viewer.settings.sampling_pattern = 2,
                8 => viewer.settings.clamping = 0.1,
                _ => {
                    viewer.settings.sampling_pattern = 1;
                    viewer.settings.max_samples = 16;
                }
            }
            viewer.dirty(if case < 4 {
                Change::Camera
            } else {
                Change::Scene
            });
            settle(&mut viewer, &ctx)?;
            let mut fresh = Renderer::with_backend(mode)?;
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
                viewer.hdr()? == fresh.finish_l1(viewer.samples)?
                    && viewer.image(1)? == fresh.image(1)?
                    && viewer.image(2)? == fresh.image(2)?,
                "Viewer/fresh mismatch: backend {mode}, case {case}"
            );
            ensure!(
                viewer.hdr()? != baseline,
                "Control had no effect: backend {mode}, case {case}"
            );
            if case == 0 || case == 3 {
                renderer::save(
                    &out.join(format!("camera-{mode}-{case}.png")),
                    &viewer.hdr()?,
                    viewer.size,
                    0.,
                )?;
            }
            println!("PASS viewer settings backend {mode}, case {case}");
        }
        // Following quality changes, camera/material/environment edits must keep
        // using the selected settings, including when their commit is incremental.
        for change in [Change::Camera, Change::Material, Change::Environment] {
            match change {
                Change::Camera => viewer.camera.orbit([8., 2.]),
                Change::Material => viewer.model.0.materials[0].roughness = 0.85,
                _ => viewer.environment.rotation = 75.,
            }
            viewer.dirty(change);
            settle(&mut viewer, &ctx)?;
            let mut fresh = Renderer::with_backend(mode)?;
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
                "Settings lost after an edit"
            );
        }
        viewer.backend = 1 - mode;
        viewer.dirty(Change::Scene);
        settle(&mut viewer, &ctx)?;
        let mut fresh = Renderer::with_backend(1 - mode)?;
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
            "Settings lost after backend switch"
        );
        println!("PASS retained settings after edits and backend switch {mode}");
        let display = mutracer_native::display::Settings::default();
        let hdr = viewer.hdr()?;
        let generation = viewer.generation;
        let samples = viewer.samples;
        let before = viewer.read_rgba(&display)?;
        for case in 0..12 {
            viewer.display_settings = display;
            match case {
                0..=4 => viewer.display_settings.tone_mapping = case,
                5 => viewer.display_settings.exposure = 0.5,
                6 => viewer.display_settings.contrast = 1.4,
                7 => viewer.display_settings.saturation = 0.,
                8 => viewer.display_settings.temperature = -0.8,
                9 => viewer.display_settings.tint = 0.8,
                10 => viewer.display_settings.output = 1,
                _ => viewer.display_settings.output = 2,
            }
            viewer.tick(&ctx)?;
            ensure!(
                viewer.generation == generation
                    && viewer.samples == samples
                    && viewer.hdr()? == hdr,
                "Display control restarted or mutated HDR"
            );
            let png = out.join(format!("display-{mode}-{case}.png"));
            viewer.save_image(&png)?;
            let exported = image::open(&png)?.into_rgba8();
            let rgba = viewer.read_rgba(&viewer.display_settings)?;
            ensure!(
                exported.as_raw() == &rgba,
                "PNG differs from current composition"
            );
            ensure!(
                case == 0 || rgba != before,
                "Display control had no visible effect: {case}"
            );
        }
        viewer.display_settings = display;
        for transparent in [false, true] {
            viewer.environment.background = false;
            viewer.environment.background_color = [0.6, 0.1, 0.2];
            viewer.environment.background_alpha = if transparent { 0. } else { 1. };
            viewer.dirty(Change::Environment);
            settle(&mut viewer, &ctx)?;
            let rgba = viewer.read_rgba(&display)?;
            if transparent {
                ensure!(
                    rgba.chunks_exact(4).any(|p| p[3] == 0)
                        && rgba.chunks_exact(4).any(|p| p[3] == 255)
                        && rgba.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255),
                    "Missing transparent/opaque/antialiased pixels"
                );
            } else {
                ensure!(
                    rgba.chunks_exact(4).all(|p| p[3] == 255),
                    "Color background is not opaque"
                );
            }
            let png = out.join(format!("background-{mode}-{transparent}.png"));
            viewer.save_image(&png)?;
            ensure!(
                image::open(&png)?.into_rgba8().as_raw() == &rgba,
                "Background export mismatch"
            );
        }
        // Denoising must preserve alpha, and AOVs bypass both denoising and color controls.
        viewer.denoise = true;
        let deadline = Instant::now() + Duration::from_secs(30);
        while viewer.denoised()?.is_none() {
            viewer.tick(&ctx)?;
            ensure!(
                Instant::now() < deadline,
                "Transparent denoising timed out: {}",
                viewer.denoise_status
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        ensure!(
            viewer
                .denoised()?
                .unwrap()
                .chunks_exact(4)
                .zip(viewer.hdr()?.chunks_exact(4))
                .all(|(a, b)| a[3] == b[3]),
            "Denoise changed alpha"
        );
        viewer.save_image(&out.join(format!("denoised-transparent-{mode}.png")))?;
        viewer.display_settings.output = 1;
        viewer.tick(&ctx)?;
        let normal = viewer.read_rgba(&viewer.display_settings)?;
        viewer.denoise = false;
        viewer.display_settings.exposure = 0.;
        viewer.tick(&ctx)?;
        ensure!(
            viewer.read_rgba(&viewer.display_settings)? == normal,
            "AOV affected by denoise or exposure"
        );
        println!(
            "PASS display controls, HDR retention, alpha, denoising, AOV and PNG export backend {}",
            1 - mode
        );
    }
    Ok(())
}
