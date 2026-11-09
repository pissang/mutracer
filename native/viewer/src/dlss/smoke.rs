//! Headless real-GPU validation using the same adapter as the interactive app.
use super::*;
use std::time::{Duration, Instant};

pub fn run(dlss: &Arc<Dlss>, model_path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let gpu = &dlss.runtime.gpu;
    check_resolve(dlss)?;
    let model = crate::scene::Model::load(model_path)?;
    let engine = api::Engine::on_device(
        &gpu.adapter,
        &gpu.device,
        &gpu.queue,
        api::EngineOptions::default(),
        None,
    );
    let render = api::Render::new(
        &engine,
        api::RenderSettings {
            max_samples: 16,
            ..Default::default()
        },
    )?;
    render.set_custom_denoiser(Some(dlss.clone()), api::DenoiseSchedule::EverySample)?;
    let mut rows = Vec::new();
    for (width, height) in [(128, 96), (160, 104)] {
        let size = [width, height];
        engine.display().set_size(width, height)?;
        engine.set_camera(None)?;
        let mut camera = crate::renderer::Camera::fit(model.center, model.radius);
        engine.set_scene(&model.descriptor(
            &camera.bytes(size),
            size,
            &crate::scene::Environment::default(),
        ))?;
        let mut settings = render.settings()?;
        settings.max_samples = 16;
        render.set_settings(settings)?;
        engine.update()?;
        let started = Instant::now();
        finish(&render, 16)?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.;
        let report = render.denoise_report().context("No RR result")?;
        ensure!(report.error.is_none(), "RR error: {:?}", report.error);
        engine.display().present(&render)?;
        ensure!(
            engine.display().texture().is_some(),
            "No composed GPU display result"
        );
        let result = render.read_pixels(api::PixelKind::Denoised)?;
        let raw = render.read_pixels(api::PixelKind::Hdr)?;
        validate(&result.data)?;
        ensure!(result.data != raw.data, "RR output equals raw input");
        let (_, _, rr_display) = engine.display().read_rgba8(&render)?;
        save_display(&out.join(format!("rr-{width}.png")), &rr_display, size)?;
        let baseline = api::Render::new(&engine, api::RenderSettings::default())?;
        baseline.converge(api::ConvergeOptions::new(16))?;
        let (_, _, raw_display) = engine.display().read_rgba8(&baseline)?;
        save_display(&out.join(format!("raw-{width}.png")), &raw_display, size)?;
        std::fs::write(
            out.join(format!("rr-{width}.rgba32f")),
            result
                .data
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        )?;
        // An independent progressive reference is only an image-quality
        // measurement; it cannot replace actual NGX execution assertions.
        let reference = api::Render::new(&engine, api::RenderSettings::default())?;
        reference.converge(api::ConvergeOptions::new(256))?;
        let (_, _, reference_display) = engine.display().read_rgba8(&reference)?;
        save_display(
            &out.join(format!("reference-{width}.png")),
            &reference_display,
            size,
        )?;
        rows.push(serde_json::json!({"size":size,"samples":render.samples(),"submission_cpu_ms":report.milliseconds,
            "total_16_frame_ms":elapsed,"rr_display_rmse":rmse(&rr_display,&reference_display),"raw_16_spp_display_rmse":rmse(&raw_display,&reference_display)}));

        // An explicit reset only takes effect on the next frame, not by
        // re-reading an already completed denoise result.
        render.reset_temporal_history()?;
        let before = dlss.counts();
        let mut settings = render.settings()?;
        settings.max_samples = 17;
        render.set_settings(settings)?;
        engine.update()?;
        finish(&render, 17)?;
        ensure!(
            dlss.counts().1 == before.1 + 1,
            "Explicit reset was not consumed"
        );

        // A second Render uses a separate NGX history. Returning to the first
        // render must preserve its accepted history.
        let second = api::Render::new(
            &engine,
            api::RenderSettings {
                max_samples: 3,
                ..Default::default()
            },
        )?;
        second.set_custom_denoiser(Some(dlss.clone()), api::DenoiseSchedule::EverySample)?;
        finish(&second, 3)?;
        let before = dlss.counts();
        let mut settings = render.settings()?;
        settings.max_samples = 18;
        render.set_settings(settings)?;
        engine.update()?;
        finish(&render, 18)?;
        ensure!(
            dlss.counts().1 == before.1,
            "Switching targets reset unrelated history"
        );

        // Ordinary camera motion keeps the previous frame; no camera-cut reset.
        camera.yaw += 0.1;
        engine.set_camera(Some(
            api::Camera::from_bytes(&camera.bytes(size)).context("Invalid smoke camera")?,
        ))?;
        engine.update()?;
        let before = dlss.counts();
        finish(&render, 18)?;
        ensure!(
            dlss.counts().1 == before.1,
            "Ordinary camera motion reset RR history: {:?}",
            dlss.state.lock().unwrap().last_reset
        );
        validate(&render.read_pixels(api::PixelKind::Denoised)?.data)?;
    }
    check_cancel_and_replace(dlss, &engine)?;
    check_denoiser_selection(dlss, &engine)?;
    let live_gate = Arc::new(mutracer_native::submission::SubmissionGate::default());
    let live_engine = api::Engine::on_device(
        &gpu.adapter,
        &gpu.device,
        &gpu.queue,
        api::EngineOptions::default(),
        Some(live_gate.clone()),
    );
    let before_live = dlss.counts();
    crate::live_denoise_smoke::run(
        &live_engine,
        &model,
        Some(dlss.clone()),
        Some(&live_gate),
        &out.join("live"),
    )?;
    let after_live = dlss.counts();
    ensure!(
        after_live.0 >= before_live.0 + 13 && after_live.1 == before_live.1 + 2,
        "Moving RR must reuse preview history, with only preview/final first-use resets: {before_live:?} -> {after_live:?}"
    );
    if std::env::var_os("MUTRACER_DLSS_SMOKE_LARGE").is_some() {
        let size = [1920, 1080];
        engine.set_camera(None)?;
        engine.display().set_size(size[0], size[1])?;
        let camera = crate::renderer::Camera::fit(model.center, model.radius);
        engine.set_scene(&model.descriptor(
            &camera.bytes(size),
            size,
            &crate::scene::Environment::default(),
        ))?;
        let mut settings = render.settings()?;
        settings.max_samples = 1;
        render.set_settings(settings)?;
        engine.update()?;
        let started = Instant::now();
        finish(&render, 1)?;
        validate(&render.read_pixels(api::PixelKind::Denoised)?.data)?;
        rows.push(serde_json::json!({"size":size,"samples":1,"total_ms":started.elapsed().as_secs_f64()*1000.}));
    }
    gpu.device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(30)),
    })?;
    let (evaluations, resets) = dlss.counts();
    ensure!(
        evaluations >= 78 && resets >= 6,
        "Insufficient lifecycle coverage: {evaluations} evaluations, {resets} resets"
    );
    let summary = serde_json::json!({"passed":true,"adapter":gpu.adapter.get_info().name,"evaluations":evaluations,"resets":resets,"renders":rows,
        "max_storage_buffer_binding_size":gpu.device.limits().max_storage_buffer_binding_size,"runtime":dlss.runtime.ngx.loaded_path()});
    std::fs::write(
        out.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    println!("{summary}");
    Ok(())
}
fn check_denoiser_selection(dlss: &Arc<Dlss>, engine: &api::Engine) -> Result<()> {
    let mut render_loop = api::RenderLoop::new(
        engine,
        api::RenderLoopOptions {
            preview: Some(api::LoopRender::Settings(
                crate::denoiser::preview_settings(),
            )),
            final_render: api::LoopRender::Settings(api::RenderSettings {
                max_samples: 2,
                ..Default::default()
            }),
            ..Default::default()
        },
    )?;
    let filter: Arc<dyn CustomDenoiser> = dlss.clone();
    crate::denoiser::configure(&mut render_loop, true, true, Some(&filter))?;
    finish(render_loop.final_render(), 2)?;
    ensure!(
        render_loop.final_render().denoise_report().unwrap().backend == "custom",
        "RR selection did not install the custom filter"
    );
    ensure!(
        render_loop.preview().unwrap().denoise_schedule()
            == Some(api::DenoiseSchedule::EverySample),
        "RR preview not enabled"
    );
    let raw = render_loop
        .final_render()
        .read_pixels(api::PixelKind::Hdr)?
        .data;
    for temporal in [false, true, false] {
        crate::denoiser::configure(&mut render_loop, true, temporal, Some(&filter))?;
        finish(render_loop.final_render(), 2)?;
        let expected = if temporal { "custom" } else { "oidn-webgpu" };
        ensure!(
            render_loop.final_render().denoise_report().unwrap().backend == expected,
            "Wrong backend after UI selection"
        );
        ensure!(
            render_loop
                .final_render()
                .read_pixels(api::PixelKind::Hdr)?
                .data
                == raw,
            "Denoiser selection changed accumulation"
        );
        ensure!(
            render_loop.coalesce_scene_updates,
            "Wrong preview scheduling after switch"
        );
        if !temporal {
            ensure!(
                render_loop.preview().unwrap().denoise_schedule()
                    == Some(api::DenoiseSchedule::EverySample),
                "OIDN live preview is not enabled"
            );
        }
    }
    crate::denoiser::configure(&mut render_loop, false, false, Some(&filter))?;
    ensure!(
        render_loop.final_render().denoise_schedule().is_none(),
        "Denoise switch did not disable filtering"
    );
    Ok(())
}
fn check_cancel_and_replace(dlss: &Arc<Dlss>, engine: &api::Engine) -> Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    struct CancelAfterEncode {
        filter: Arc<Dlss>,
        encoded: Arc<AtomicBool>,
    }
    impl CustomDenoiser for CancelAfterEncode {
        fn input_mode(&self) -> api::DenoiseInputMode {
            api::DenoiseInputMode::TemporalGpu
        }
        fn denoise(
            &self,
            input: api::DenoiseInput,
            cancel: api::CancelToken,
        ) -> std::result::Result<api::DenoiseOutput, String> {
            self.filter
                .filter(input, cancel.clone(), || {
                    self.encoded.store(true, Ordering::Release);
                    cancel.cancel();
                })
                .map_err(|e| e.to_string())
        }
    }
    let render = api::Render::new(
        engine,
        api::RenderSettings {
            max_samples: 1,
            ..Default::default()
        },
    )?;
    let encoded = Arc::new(AtomicBool::new(false));
    render.set_custom_denoiser(
        Some(Arc::new(CancelAfterEncode {
            filter: dlss.clone(),
            encoded: encoded.clone(),
        })),
        api::DenoiseSchedule::EverySample,
    )?;
    ensure!(
        finish(&render, 1).is_err() && encoded.load(Ordering::Acquire),
        "Did not exercise cancellation after NGX encoding"
    );
    render.set_custom_denoiser(Some(dlss.clone()), api::DenoiseSchedule::EverySample)?;
    render.restart()?;
    finish(&render, 1)?;
    validate(&render.read_pixels(api::PixelKind::Denoised)?.data)?;
    Ok(())
}
fn check_resolve(dlss: &Dlss) -> Result<()> {
    let gpu = &dlss.runtime.gpu;
    let device = &gpu.device;
    let extent = wgpu::Extent3d {
        width: 2,
        height: 2,
        depth_or_array_layers: 1,
    };
    let texture = |format| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("RR conversion oracle"),
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    };
    let color = texture(wgpu::TextureFormat::Rgba32Float);
    let validity = texture(wgpu::TextureFormat::R32Uint);
    let values = [
        2f32, 4., 8., 1., 1., 3., 5., 1., 5., 7., 9., 1., 9., 11., 13., 1.,
    ];
    let flags = [129u32, 1, 129, 161];
    for (texture, bytes, row) in [
        (
            &color,
            values
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
            32,
        ),
        (
            &validity,
            flags.iter().flat_map(|v| v.to_le_bytes()).collect(),
            8,
        ),
    ] {
        gpu.queue.write_texture(
            texture.as_image_copy(),
            &bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row),
                rows_per_image: Some(2),
            },
            extent,
        );
    }
    let buffer = |values: &[f32]| {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: &values
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
            usage: wgpu::BufferUsages::STORAGE,
        })
    };
    let raw = buffer(&[
        10., 20., 30., 0.4, 3., 6., 9., 0.2, 0., 0., 0., 0.75, 8., 16., 24., 0.6,
    ]);
    let albedo = buffer(&[
        0., 0., 0., 0.25, 0., 0., 0., 0.5, 0., 0., 0., 0.5, 0., 0., 0., 1.,
    ]);
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let read = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let color = color.create_view(&Default::default());
    let validity = validity.create_view(&Default::default());
    let group = group(
        device,
        &dlss.resolve,
        &[
            wgpu::BindingResource::TextureView(&color),
            wgpu::BindingResource::TextureView(&validity),
            raw.as_entire_binding(),
            output.as_entire_binding(),
            albedo.as_entire_binding(),
        ],
    );
    let mut encoder = device.create_command_encoder(&Default::default());
    dispatch(&mut encoder, &dlss.resolve, &group, [2, 2]);
    encoder.copy_buffer_to_buffer(&output, 0, &read, 0, 64);
    gpu.queue.submit([encoder.finish()]);
    let (send, receive) = std::sync::mpsc::channel();
    read.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = send.send(r);
    });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(30)),
    })?;
    receive.recv_timeout(Duration::from_secs(30))??;
    let mapped = read.slice(..).get_mapped_range()?;
    let actual: Vec<_> = mapped
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    ensure!(
        actual
            == [
                1.25, 1.75, 2.25, 0.4, 3., 6., 9., 0.2, 1., 2., 4., 0.75, 8., 16., 24., 0.6
            ],
        "RR orientation/coverage/alpha/unsupported-material conversion failed: {actual:?}"
    );
    drop(mapped);
    read.unmap();
    Ok(())
}
fn finish(render: &api::Render, samples: u32) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let status = render.refine()?;
        if let Some(report) = render.denoise_report() {
            ensure!(
                report.error.is_none(),
                "DLSS filtering failed: {:?}",
                report.error
            );
            if report.samples == samples && status == api::RenderStatus::Finished {
                return Ok(());
            }
        }
        ensure!(status != api::RenderStatus::Error, "DLSS render failed");
        ensure!(Instant::now() < deadline, "DLSS rendering timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn validate(data: &[f32]) -> Result<()> {
    ensure!(data.iter().all(|v| v.is_finite()), "Nonfinite RR output");
    ensure!(
        data.chunks_exact(4).any(|p| p[..3].iter().any(|v| *v > 0.)),
        "Empty RR output"
    );
    ensure!(
        !data.chunks_exact(4).any(|p| p[..3] == [-99.; 3]),
        "Unwritten SDK sentinel"
    );
    Ok(())
}
fn save_display(path: &Path, pixels: &[u8], size: [u32; 2]) -> Result<()> {
    image::save_buffer(path, pixels, size[0], size[1], image::ColorType::Rgba8)?;
    Ok(())
}
fn rmse(a: &[u8], b: &[u8]) -> f64 {
    (a.chunks_exact(4)
        .zip(b.chunks_exact(4))
        .flat_map(|(a, b)| (0..3).map(move |c| ((a[c] as f64 - b[c] as f64) / 255.).powi(2)))
        .sum::<f64>()
        / (a.len() / 4 * 3) as f64)
        .sqrt()
}
