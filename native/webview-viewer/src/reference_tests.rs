use super::*;
#[test]
#[ignore = "requires headless browser fixtures and a real GPU"]
fn shared_web_scenes_render_with_native_engine() {
    let dir = PathBuf::from(
        std::env::var_os("MUTRACER_WEBVIEW_REFERENCE")
            .expect("Run native/validation/webview-scene-reference.mjs first"),
    );
    let mut results = Vec::new();
    for backend in [api::Backend::Software, api::Backend::Hardware] {
        let engine = api::Engine::new(api::EngineOptions { backend }).unwrap();
        engine.display().set_size(96, 64).unwrap();
        let render = api::Render::new(
            &engine,
            api::RenderSettings {
                size: api::RenderSize::Fixed {
                    width: 96,
                    height: 64,
                },
                max_samples: 16,
                bounces: 3,
                seed: 0,
                ..Default::default()
            },
        )
        .unwrap();
        for name in ["gltf", "materialx", "hdr-studio", "denoised"] {
            engine
                .set_scene(&std::fs::read(dir.join(format!("{name}.bin"))).unwrap())
                .unwrap();
            engine.update().unwrap();
            if name == "denoised" {
                render
                    .set_viewer_denoiser(Some(api::DenoiserOptions {
                        backend: api::DENOISE_OIDN_WEBGPU,
                        library: Some(
                            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                                .join("../../oidn/weights/rt_hdr_alb_nrm.tza"),
                        ),
                        ..Default::default()
                    }))
                    .unwrap();
            }
            render.converge(api::ConvergeOptions::new(16)).unwrap();
            for (kind, label) in [
                (api::PixelKind::Hdr, "hdr"),
                (api::PixelKind::Normal, "normal"),
                (api::PixelKind::Albedo, "albedo"),
                (api::PixelKind::Denoised, "denoised"),
            ] {
                let image = render.read_pixels(kind).unwrap();
                let browser: Vec<f32> = std::fs::read(dir.join(format!("{name}-{label}.f32")))
                    .unwrap()
                    .chunks_exact(4)
                    .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                    .collect();
                assert_eq!(browser.len(), image.data.len());
                assert!(image.data.iter().all(|n| n.is_finite()));
                let max = image
                    .data
                    .iter()
                    .zip(&browser)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0f32, f32::max);
                let mse = image
                    .data
                    .iter()
                    .zip(&browser)
                    .map(|(a, b)| f64::from(a - b).powi(2))
                    .sum::<f64>()
                    / browser.len() as f64;
                results.push(json!({"case":name,"backend":format!("{backend:?}"),"kind":label,"maxAbsolute":max,"rmse":mse.sqrt()}));
                std::fs::write(
                    dir.join(format!("native-{backend:?}-{name}-{label}.f32")),
                    image
                        .data
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                )
                .unwrap();
            }
            std::fs::write(
                dir.join(format!("native-{backend:?}-{name}.png")),
                engine.display().encode_png(&render).unwrap(),
            )
            .unwrap();
        }
    }
    std::fs::write(
        dir.join("comparison.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
}
