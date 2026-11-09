//! Continuous-input validation through RenderLoop, without window automation.
use anyhow::{Result, ensure};
use mutracer_native::api::LoopSync;
use mutracer_native::{api, submission::SubmissionGate};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

struct Motion {
    engine: api::Engine,
    camera: crate::renderer::Camera,
    model: crate::scene::Model,
    descriptor: Option<crate::scene::Descriptor>,
    size: [u32; 2],
    step: u32,
    activity: api::SyncActivity,
}
struct ResumeOnDrop(Option<Arc<SubmissionGate>>);
impl Drop for ResumeOnDrop {
    fn drop(&mut self) {
        if let Some(gate) = &self.0 {
            gate.resume();
        }
    }
}
impl api::LoopSync for Motion {
    fn update(&mut self) {
        if self.activity.active() && !self.engine.diagnostics().preparing {
            self.step += 1;
            self.camera.yaw += 0.0007;
            // Match the viewer: preparation completes before another retained edit.
            // Input remains active while rendering/inference coalesces updates.
            let bytes = self
                .model
                .update_descriptor(
                    &mut self.descriptor,
                    &self.camera.bytes(self.size),
                    self.size,
                    &crate::scene::Environment::default(),
                    &crate::scene::KeyLight::default(),
                )
                .to_vec();
            self.engine.set_scene_shared(Arc::new(bytes)).unwrap();
        }
    }
    fn activity(&self) -> &api::SyncActivity {
        &self.activity
    }
    fn activity_mut(&mut self) -> &mut api::SyncActivity {
        &mut self.activity
    }
}

pub fn run(
    engine: &api::Engine,
    model: &crate::scene::Model,
    filter: Option<Arc<dyn api::CustomDenoiser>>,
    gate: Option<&Arc<SubmissionGate>>,
    out: &Path,
) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let mut results = Vec::new();
    for temporal in [false, true] {
        if temporal && filter.is_none() {
            continue;
        }
        let name = if temporal { "dlss-rr" } else { "oidn-webgpu" };
        let size = [512, 384];
        engine.display().set_size(size[0], size[1])?;
        engine.set_camera(None)?;
        let camera = crate::renderer::Camera::fit(model.center, model.radius);
        engine.set_scene(&model.descriptor(
            &camera.bytes(size),
            size,
            &crate::scene::Environment::default(),
        ))?;
        let motion = Arc::new(Mutex::new(Motion {
            engine: engine.clone(),
            camera,
            model: model.clone(),
            descriptor: None,
            size,
            step: 0,
            activity: api::SyncActivity::default(),
        }));
        motion.lock().unwrap().set_active(true);
        let sync: api::SharedSync = motion.clone();
        let mut render_loop = api::RenderLoop::new(
            engine,
            api::RenderLoopOptions {
                preview: Some(api::LoopRender::Settings(
                    crate::denoiser::preview_settings(),
                )),
                final_render: api::LoopRender::Settings(api::RenderSettings {
                    max_samples: 4,
                    ..Default::default()
                }),
                syncs: vec![sync],
                ..Default::default()
            },
        )?;
        // Like Viewer::drop, reopen submissions before render teardown, also
        // on failed assertions. A paused test gate must not hide the error.
        let _resume = ResumeOnDrop(gate.cloned());
        crate::denoiser::configure(&mut render_loop, true, temporal, filter.as_ref())?;
        let sampled = Arc::new(AtomicUsize::new(0));
        let observed = sampled.clone();
        let _sample = render_loop.preview().unwrap().on_sample(move |sample| {
            if sample.is_first_frame {
                observed.fetch_add(1, Ordering::Relaxed);
            }
        });
        let start = Instant::now();
        let deadline = start + Duration::from_secs(90);
        let mut shown = 0;
        let mut seen = render_loop.presentations();
        let mut first = None;
        let mut last = None;
        let mut max_tick = 0f64;
        while shown < 12 {
            let began = Instant::now();
            let status = tick(&mut render_loop, gate)?;
            max_tick = max_tick.max(began.elapsed().as_secs_f64() * 1000.);
            ensure!(
                status != api::RenderLoopStatus::Error,
                "{name} live rendering failed: {:?}",
                engine.diagnostics().last_error
            );
            if render_loop.presentations() != seen {
                seen = render_loop.presentations();
                let preview = render_loop.preview().unwrap();
                if render_loop
                    .presented_render()
                    .is_some_and(|r| Arc::ptr_eq(r, preview))
                {
                    let report = preview
                        .denoise_report()
                        .ok_or_else(|| anyhow::anyhow!("Presented an unfiltered moving preview"))?;
                    ensure!(
                        report.samples == 1 && report.error.is_none(),
                        "{name} preview was not denoised at one sample: {report:?}"
                    );
                    ensure!(
                        report.backend == if temporal { "custom" } else { "oidn-webgpu" },
                        "Wrong moving denoiser"
                    );
                    shown += 1;
                    if shown == 1 || shown == 12 {
                        if let Some(gate) = gate {
                            gate.resume();
                        }
                        let (w, h, pixels) = engine.display().read_rgba8(preview)?;
                        image::save_buffer(
                            out.join(format!("{name}-moving-{shown}.png")),
                            &pixels,
                            w,
                            h,
                            image::ColorType::Rgba8,
                        )?;
                        if shown == 1 {
                            first = Some(pixels);
                        } else {
                            last = Some(pixels);
                        }
                    }
                }
            }
            ensure!(
                Instant::now() < deadline,
                "{name} live preview stalled: {shown} presentations, {:?}",
                engine.diagnostics()
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        let moving_ms = start.elapsed().as_secs_f64() * 1000.;
        eprintln!("Live {name}: {shown} denoised moving presentations in {moving_ms:.1} ms");
        ensure!(
            sampled.load(Ordering::Relaxed) >= 12,
            "Repeated an old preview instead of rendering camera movement"
        );
        ensure!(
            first != last,
            "Camera moved but displayed image did not change"
        );
        let inputs = motion.lock().unwrap().step;
        motion.lock().unwrap().set_active(false);
        let stop = Instant::now();
        loop {
            let status = tick(&mut render_loop, gate)?;
            ensure!(
                status != api::RenderLoopStatus::Error,
                "{name} failed after motion stopped"
            );
            if status == api::RenderLoopStatus::Finished {
                break;
            }
            ensure!(
                stop.elapsed() < Duration::from_secs(60),
                "{name} did not return to final convergence"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        let report = render_loop
            .final_render()
            .denoise_report()
            .ok_or_else(|| anyhow::anyhow!("Missing final denoising"))?;
        ensure!(
            report.samples == 4 && report.error.is_none(),
            "Final denoising did not finish"
        );
        ensure!(
            render_loop
                .presented_render()
                .is_some_and(|r| Arc::ptr_eq(r, render_loop.final_render())),
            "Preview remained after motion stopped"
        );
        results.push(serde_json::json!({"denoiser":name,"camera_inputs":inputs,"moving_denoised_presentations":shown,
            "fresh_preview_samples":sampled.load(Ordering::Relaxed),"moving_total_ms":moving_ms,"max_tick_including_first_use_ms":max_tick,
            "final_samples":report.samples,"passed":true}));
    }
    if let Some(gate) = gate {
        gate.resume();
    }
    let summary =
        serde_json::json!({"passed":true,"submission_gate":gate.is_some(),"results":results});
    std::fs::write(
        out.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    println!("Live denoising: {summary}");
    Ok(())
}
fn tick(
    render_loop: &mut api::RenderLoop,
    gate: Option<&Arc<SubmissionGate>>,
) -> Result<api::RenderLoopStatus> {
    if let Some(gate) = gate {
        gate.resume();
    }
    let result = render_loop.tick();
    if let Some(gate) = gate {
        gate.pause();
    }
    Ok(result?)
}
