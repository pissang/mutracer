//! Relocated-package CPU gate; rendering is an explicit real-GPU validation mode.
use crate::{
    renderer::{Camera, Renderer},
    scene::{Environment, Model},
};
use anyhow::{Result, ensure};
use std::path::Path;

pub fn run(model_path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    let model = Model::load(model_path)?;
    let size = [32, 24];
    ensure!(
        mutracer_native::api::OIDN_WEBGPU_AVAILABLE,
        "Missing native denoiser"
    );
    crate::denoiser::preview_oidn_options()?;
    let gpu = std::env::var("MUTRACER_NATIVE_GPU_VALIDATION").is_ok_and(|value| value == "1");
    if gpu {
        let (denoised, _) = denoise_model(&model, size, 4)?;
        ensure!(
            denoised.iter().all(|v| v.is_finite()),
            "Non-finite packaged denoising"
        );
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))?;
        ensure!(
            matches!(
                adapter.get_info().device_type,
                wgpu::DeviceType::IntegratedGpu
                    | wgpu::DeviceType::DiscreteGpu
                    | wgpu::DeviceType::VirtualGpu
            ),
            "Packaged GPU validation requires a real GPU"
        );
        let mut renderer = Renderer::with_backend(0)?;
        let camera = Camera::fit(model.0.center, model.0.radius);
        renderer.commit(&model.descriptor(&camera.bytes(size), size, &Environment::default()))?;
        let pixels = renderer.finish(4)?;
        ensure!(
            pixels.iter().all(|v| v.is_finite()),
            "Non-finite packaged render"
        );
        ensure!(
            pixels
                .chunks_exact(4)
                .any(|p| p[..3].iter().any(|v| *v > 0.0)),
            "Empty packaged render"
        );
        for kind in 0..3 {
            ensure!(
                renderer.image(kind)?.iter().all(|v| v.is_finite()),
                "Non-finite packaged AOV"
            );
        }
        ensure!(
            renderer.backend()?.0 == 0,
            "Package smoke must exercise software BVH"
        );
        renderer.reset()?;
        ensure!(
            renderer.finish(4)? == pixels,
            "Packaged accumulation reset differs"
        );
        crate::renderer::save(&out.join("render.png"), &pixels, size, 0.0)?;
        let engine = mutracer_native::api::Engine::new(Default::default())?;
        crate::live_denoise_smoke::run(&engine, &model, None, None, &out.join("live"))?;
    }
    let summary = serde_json::json!({"passed":true,"gpu":gpu,"gpuValidation":if gpu {"passed"} else {"not-run (CPU-only)"},"denoiser":"oidn-webgpu","denoisingValidation":if gpu {"passed"} else {"not-run (CPU-only)"},"model":model_path});
    std::fs::write(
        out.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    println!("{summary}");
    Ok(())
}

// Exercise the configured built-in path, including packaged weights/runtime.
pub(crate) fn denoise_model(
    model: &Model,
    size: [u32; 2],
    samples: u32,
) -> Result<(Vec<f32>, f64)> {
    use mutracer_native::api;
    let engine = api::Engine::new(api::EngineOptions::default())?;
    let camera = Camera::fit(model.0.center, model.0.radius);
    engine.set_scene(&model.descriptor(&camera.bytes(size), size, &Environment::default()))?;
    engine.update()?;
    let render = api::Render::new(
        &engine,
        api::RenderSettings {
            max_samples: samples,
            size: api::RenderSize::Fixed {
                width: size[0],
                height: size[1],
            },
            ..Default::default()
        },
    )?;
    render.set_denoiser(Some(api::DenoiserOptions {
        max_tile_size: 512,
        backend: api::DENOISE_OIDN_WEBGPU,
        ..Default::default()
    }))?;
    render.converge(api::ConvergeOptions::new(samples))?;
    let raw = render.read_pixels(api::PixelKind::Hdr)?.data;
    let denoised = render.read_pixels(api::PixelKind::Denoised)?.data;
    ensure!(
        raw != denoised,
        "Packaged denoiser did not change noisy pixels"
    );
    ensure!(
        raw.chunks_exact(4)
            .zip(denoised.chunks_exact(4))
            .all(|(a, b)| a[3] == b[3]),
        "Packaged denoiser changed alpha"
    );
    let report = render
        .denoise_report()
        .ok_or_else(|| anyhow::anyhow!("No packaged denoise report"))?;
    ensure!(
        report.backend == "oidn-webgpu" && report.error.is_none(),
        "Wrong packaged denoiser: {report:?}"
    );
    // Direct L0 smokes/save() use bottom-row-first pixels.
    let row = size[0] as usize * 4;
    let bottom_first = denoised
        .chunks_exact(row)
        .rev()
        .flatten()
        .copied()
        .collect();
    Ok((bottom_first, report.milliseconds))
}
