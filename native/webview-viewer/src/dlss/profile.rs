//! GPU stage timings and an offscreen profile using the real NGX adapter.
use super::{Dlss, api};
use anyhow::{Context, Result, ensure};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(super) struct Stages {
    queries: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    readback: wgpu::Buffer,
    period: f64,
}
impl Stages {
    pub(super) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<Self> {
        if !device
            .features()
            .contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)
        {
            return None;
        }
        let buffer = |usage| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("DLSS stage timing"),
                size: 32,
                usage,
                mapped_at_creation: false,
            })
        };
        Some(Self {
            queries: device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("DLSS stage timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count: 4,
            }),
            resolve: buffer(wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC),
            readback: buffer(wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST),
            period: f64::from(queue.get_timestamp_period()) / 1e6,
        })
    }
    pub(super) fn stamp(&self, encoder: &mut wgpu::CommandEncoder, index: u32) {
        encoder.write_timestamp(&self.queries, index);
    }
    pub(super) fn resolve(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.resolve_query_set(&self.queries, 0..4, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.readback, 0, 32);
    }
    pub(super) fn log(self, frame: u64, sample: u32) {
        let readback = self.readback.clone();
        let period = self.period;
        self.readback
            .map_async(wgpu::MapMode::Read, .., move |result| {
                if result.is_err() {
                    return;
                }
                if let Ok(mapped) = readback.get_mapped_range(..) {
                    // The middle interval brackets the separate raw command
                    // buffer, including its barriers. wgpu timestamps cannot be
                    // recorded inside an encoder accessed by the Vulkan SDK.
                    let stamps: Vec<_> = mapped
                        .chunks_exact(8)
                        .map(|stamp| u64::from_le_bytes(stamp.try_into().unwrap()))
                        .collect();
                    let stage = |start: usize| {
                        stamps[start + 1]
                            .checked_sub(stamps[start])
                            .map(|ticks| ticks as f64 * period)
                    };
                    eprintln!(
                        "{}",
                        serde_json::json!({"dlssGpuProfile": {
                                "frame": frame, "sampleIndex": sample,
                        "prepareMs": stage(0), "ngxMs": stage(1), "resolveMs": stage(2),
                            }})
                    );
                }
                readback.unmap();
            });
    }
}

pub fn run(model: &Path, output: &Path, camera: Option<&Path>) -> Result<()> {
    mutracer_native::logging::stderr();
    let output_size = match std::env::var("MUTRACER_DLSS_PROFILE_SIZE") {
        Ok(size) => {
            let (w, h) = size
                .split_once('x')
                .context("Profile size must be WIDTHxHEIGHT")?;
            [w.parse::<u32>()?, h.parse::<u32>()?]
        }
        Err(std::env::VarError::NotPresent) => [1920, 1080],
        Err(error) => return Err(error.into()),
    };
    let exe = std::env::current_exe()?;
    let capture = std::env::var_os("MUTRACER_DLSS_CAPTURE_DIR")
        .map(super::replay::Capture::new)
        .transpose()?;
    let filter = Dlss::new_internal(exe.parent().context("App directory")?, capture)?;
    let (_, adapter, device, queue) = filter.device();
    let engine = api::Engine::on_device(
        &adapter,
        &device,
        &queue,
        api::EngineOptions {
            backend: api::Backend::Hardware,
        },
        None,
    );
    let scene = mutracer_native::scene_api::Scene::import_gltf(model)?.scene;
    engine.set_scene_object(&scene)?;
    let camera = match camera {
        Some(path) => {
            api::Camera::from_bytes(&std::fs::read(path)?).context("Invalid camera record")?
        }
        None => api::Camera {
            world_matrix: glam::Mat4::look_at_rh(
                glam::Vec3::new(3.2, 1.45, 3.8),
                glam::Vec3::new(0.0, 1.35, 0.0),
                glam::Vec3::Y,
            )
            .inverse()
            .to_cols_array(),
            ..Default::default()
        },
    };
    engine.set_camera(Some(camera))?;
    let output_scale = api::CustomDenoiser::temporal_output_scale(&*filter);
    ensure!(
        output_size.iter().all(|&n| n > 0 && n % output_scale == 0),
        "Profile size must divide by scale"
    );
    let input_size = output_size.map(|n| n / output_scale);
    engine.display().set_size(output_size[0], output_size[1])?;
    engine.update()?;
    let render = api::Render::new(
        &engine,
        api::RenderSettings {
            size: api::RenderSize::Fixed {
                width: input_size[0],
                height: input_size[1],
            },
            max_samples: 24,
            ..Default::default()
        },
    )?;
    render.set_custom_denoiser(Some(filter.clone()), api::DenoiseSchedule::EverySample)?;
    converge(&engine, &render)?;
    let report = render.denoise_report().context("Missing DLSS report")?;
    ensure!(report.error.is_none(), "DLSS failed: {:?}", report.error);
    let (evaluations, resets) = filter.counts();
    ensure!(
        evaluations >= 12 && resets == 1,
        "Unexpected history: {evaluations} frames, {resets} resets"
    );
    let hdr = render.read_pixels(api::PixelKind::Denoised)?;
    ensure!(
        [hdr.width, hdr.height] == output_size,
        "Unexpected output size"
    );
    let original = render.read_pixels(api::PixelKind::Hdr)?;
    ensure!(
        [original.width, original.height] == input_size,
        "Unexpected raw extent"
    );
    ensure!(
        hdr.data
            .chunks_exact(4)
            .any(|pixel| pixel[..3].iter().any(|&v| v > 0.)),
        "Empty output"
    );
    std::fs::create_dir_all(output)?;
    std::fs::write(
        output.join("profile.png"),
        engine.display().encode_png(&render)?,
    )?;
    std::fs::write(
        output.join("profile.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "size": [hdr.width, hdr.height], "inputSize": input_size, "samples": render.samples(),
            "pixelsWithNegativeRadiance": hdr.data.chunks_exact(4)
                .filter(|pixel| pixel[..3].iter().any(|&v| v < -0.01)).count(),
            "pixelsWithNonfiniteRadiance": hdr.data.chunks_exact(4)
                .filter(|pixel| pixel[..3].iter().any(|v| !v.is_finite())).count(),
            "evaluations": evaluations, "resets": resets,
        }))?,
    )?;
    if let Some(capture) = &filter.capture {
        capture.finish(&filter, input_size, output_size, evaluations)?;
    }
    if let Some(samples) = std::env::var_os("MUTRACER_DLSS_REFERENCE_SPP") {
        let samples: u32 = samples
            .to_str()
            .context("Invalid reference sample count")?
            .parse()?;
        ensure!(samples >= 24, "Reference requires at least 24 samples");
        let reference = api::Render::new(
            &engine,
            api::RenderSettings {
                max_samples: samples,
                size: api::RenderSize::Fixed {
                    width: output_size[0],
                    height: output_size[1],
                },
                ..render.settings()?
            },
        )?;
        converge(&engine, &reference)?;
        ensure!(
            reference.samples() == samples,
            "Incomplete reference render"
        );
        let hdr = reference.read_pixels(api::PixelKind::Hdr)?;
        ensure!(
            [hdr.width, hdr.height] == output_size,
            "Unexpected reference extent"
        );
        let bytes: Vec<_> = hdr
            .data
            .chunks_exact(hdr.width as usize * 4)
            .rev()
            .flatten()
            .flat_map(|pixel| pixel.to_le_bytes())
            .collect();
        std::fs::write(output.join(format!("reference-{samples}.rgba32f")), bytes)?;
    }
    Ok(())
}

fn converge(engine: &api::Engine, render: &api::Render) -> Result<()> {
    let started = Instant::now();
    loop {
        match render.refine()? {
            api::RenderStatus::Finished => return Ok(()),
            api::RenderStatus::Error => anyhow::bail!("Render failed: {:?}", engine.last_error()),
            _ => (),
        }
        ensure!(
            started.elapsed() < Duration::from_secs(180),
            "DLSS profile timed out"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
