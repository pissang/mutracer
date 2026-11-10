//! Relocation checks run without a desktop unless GPU validation was requested.
use super::*;
pub fn run(dir: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let response = assets::response("/index.html");
    ensure!(
        response.status().is_success() && !response.body().is_empty(),
        "Embedded UI missing"
    );
    for name in [
        "rt_hdr_alb_nrm.tza",
        "rt_hdr_alb_nrm_small.tza",
        "rt_hdr_calb_cnrm_large.tza",
        "rt_alb_large.tza",
        "rt_nrm_large.tza",
    ] {
        ensure!(
            std::fs::metadata(wire::weight_path(name))?.len() > 0,
            "Missing OIDN weights"
        );
    }
    let gpu = std::env::var("MUTRACER_NATIVE_GPU_VALIDATION").as_deref() == Ok("1");
    if gpu {
        use mutracer_native::scene_api as scene;
        let mut s = scene::Scene::new();
        let g = s.add_geometry(scene::Geometry::new(
            vec![-1., -1., 0., 1., -1., 0., 0., 1., 0.],
            vec![0, 1, 2],
        ))?;
        let m = s.add_material(scene::OpenPbrMaterial::default())?;
        s.add_mesh(scene::Mesh::new(g, m))?;
        let engine = api::Engine::new(Default::default())?;
        engine.display().set_size(64, 64)?;
        engine.set_scene_object(&s)?;
        let mut camera = api::Camera::default();
        camera.world_matrix[14] = 4.;
        engine.set_camera(Some(camera))?;
        engine.update()?;
        let render = api::Render::new(
            &engine,
            api::RenderSettings {
                max_samples: 4,
                ..Default::default()
            },
        )?;
        render.set_denoiser(Some(api::DenoiserOptions {
            backend: api::DENOISE_OIDN_WEBGPU,
            library: Some(wire::weight_path("rt_hdr_alb_nrm_small.tza")),
            ..Default::default()
        }))?;
        render.converge(api::ConvergeOptions::new(4))?;
        let pixels = render.read_pixels(api::PixelKind::Denoised)?;
        ensure!(
            pixels.data.iter().all(|n| n.is_finite()),
            "Non-finite denoised pixels"
        );
        std::fs::write(dir.join("image.png"), engine.display().encode_png(&render)?)?;
    }
    std::fs::write(
        dir.join("summary.json"),
        serde_json::to_vec_pretty(
            &json!({"passed":true,"denoiser":"oidn-webgpu","gpu":gpu,"gpuValidation":if gpu{"passed"}else{"skipped"},"denoisingValidation":if gpu{"passed"}else{"skipped"}}),
        )?,
    )?;
    Ok(())
}
