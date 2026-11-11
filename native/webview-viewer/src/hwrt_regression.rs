//! Manual GPU regression: external captures stay outside the repository.
use super::*;

#[test]
#[ignore = "requires a captured scene, external assets and a real Metal GPU"]
fn hwrt_hang_replay() {
    let scene = PathBuf::from(std::env::var_os("MUTRACER_HWRT_SCENE").expect("scene descriptor"));
    let out = PathBuf::from(std::env::var_os("MUTRACER_HWRT_OUTPUT").expect("evidence directory"));
    std::fs::create_dir_all(&out).unwrap();
    let mut bytes = std::fs::read(scene).unwrap();
    if let Some(path) = std::env::var_os("MUTRACER_HWRT_MODEL") {
        let path = PathBuf::from(path);
        let mut pool = model_import::Pool::default();
        pool.insert(
            mutracer_native::scene_api::viewer_support::Model::load(&path).unwrap(),
            initial_files::read_document(&path).unwrap(),
            &binary::Shared::default(),
        )
        .unwrap();
        let refs =
            std::fs::read(std::env::var_os("MUTRACER_HWRT_REFS").expect("resource references"))
                .unwrap();
        bytes = pool
            .hydrate(&bytes, &serde_json::from_slice(&refs).unwrap())
            .unwrap()
            .0;
    }
    let number = |name: &str, default: u32| {
        std::env::var(name)
            .map(|v| v.parse().unwrap())
            .unwrap_or(default)
    };
    let backend = match std::env::var("BACKEND").as_deref() {
        Ok("Software") => api::Backend::Software,
        _ => api::Backend::Hardware,
    };
    let size = [number("WIDTH", 96), number("HEIGHT", 64)];
    let samples = number("SPP", 4096);
    let engine = api::Engine::new(api::EngineOptions { backend }).unwrap();
    assert_eq!(
        engine.info().backend,
        backend,
        "backend fallback invalidates this regression"
    );
    engine.display().set_size(size[0], size[1]).unwrap();
    let render = api::Render::new(
        &engine,
        api::RenderSettings {
            size: api::RenderSize::Fixed {
                width: size[0],
                height: size[1],
            },
            max_samples: samples,
            bounces: number("BOUNCES", 3),
            direct_light_candidates: number("CANDIDATES", 4),
            bevel: number("BEVEL", 1) != 0,
            dispersion_wavelengths: number("WAVELENGTHS", 3),
            seed: 0,
            ..Default::default()
        },
    )
    .unwrap();
    engine.set_scene_shared(Arc::new(bytes)).unwrap();
    engine.update().unwrap();
    let mut options = api::ConvergeOptions::new(samples);
    options.samples_per_batch = number("BATCH", 8);
    let start = Instant::now();
    let result = render.converge(options);
    let elapsed = start.elapsed().as_secs_f64();
    let report = json!({"backend":format!("{backend:?}"),"actualBackend":format!("{:?}",render.backend()),"size":size,"samples":render.samples(),"seconds":elapsed,"msPerSample":elapsed*1000./f64::from(samples),"gpuMsPerSample":render.gpu_sample_time_ms(),"error":result.as_ref().err().map(ToString::to_string),"lastError":engine.last_error()});
    std::fs::write(
        out.join("result.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    eprintln!("HWRT_REGRESSION {report}");
    result.unwrap();
    assert_eq!(
        render.backend().unwrap().0,
        backend,
        "traversal fallback invalidates the regression"
    );
    assert_eq!(render.samples(), samples);
    let image = render.read_pixels(api::PixelKind::Hdr).unwrap();
    std::fs::write(
        out.join("hdr.f32"),
        image
            .data
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    std::fs::write(
        out.join("final.png"),
        engine.display().encode_png(&render).unwrap(),
    )
    .unwrap();
    assert!(image.data.iter().all(|v| v.is_finite()));
    assert!(
        image
            .data
            .chunks_exact(4)
            .any(|p| p[..3].iter().any(|v| *v > 0.)),
        "black image"
    );
}
