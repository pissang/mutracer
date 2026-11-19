use crate::{
    assets::{self, Assets},
    encode::{self, Rate},
    error::{Error, Result},
    progress,
    scene::Prepared,
    shot::{self, Denoise, Seed, Shot},
};
use clap::{Args, ValueEnum};
use mutracer_native::api;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, ValueEnum, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Png,
    Exr,
}

#[derive(Args, Debug)]
pub struct Overrides {
    #[arg(long, value_parser = parse_size)]
    pub size: Option<[u32; 2]>,
    #[arg(long)]
    pub spp: Option<u32>,
    #[arg(long, value_enum)]
    pub seed: Option<Seed>,
    #[arg(long, value_enum)]
    pub denoise: Option<Denoise>,
    #[arg(long, value_enum, default_value = "png")]
    pub format: Format,
    #[arg(long)]
    pub gpu: Option<usize>,
}

#[derive(Args, Debug)]
pub struct Still {
    pub file: PathBuf,
    #[arg(short, long)]
    pub output: PathBuf,
    #[arg(long, default_value_t = 0.)]
    pub t: f64,
    #[command(flatten)]
    pub options: Overrides,
}

#[derive(Args, Debug)]
pub struct Sequence {
    pub file: PathBuf,
    #[arg(short, long)]
    pub output: PathBuf,
    #[arg(long)]
    pub fps: Option<u32>,
    #[arg(long, value_parser = parse_range)]
    pub frames: Option<[u32; 2]>,
    #[arg(long)]
    pub keep_frames: Option<PathBuf>,
    #[arg(long)]
    pub max_minutes: Option<f64>,
    #[arg(long)]
    pub contact_sheet: Option<PathBuf>,
    #[command(flatten)]
    pub options: Overrides,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    pub size: [u32; 2],
    pub spp: u32,
    pub fps: u32,
    pub stride: u32,
    pub seed: Seed,
    pub seed_value: u32,
    pub sample_sequence_offset: u32,
    pub denoise: Denoise,
    pub format: Format,
    pub gpu: Option<usize>,
}

impl Settings {
    pub fn resolve(
        shot: &Shot,
        overrides: &Overrides,
        fps: Option<u32>,
        preview: bool,
    ) -> Result<Self> {
        let output = &shot.output;
        let defaults = if preview {
            ([384, 216], 8, Denoise::None, 2)
        } else {
            (output.size, output.spp, output.denoise, 1)
        };
        let this = Self {
            size: overrides.size.unwrap_or(defaults.0),
            spp: overrides.spp.unwrap_or(defaults.1),
            fps: fps.unwrap_or(output.fps),
            stride: defaults.3,
            seed: overrides.seed.unwrap_or(output.seed),
            seed_value: output.seed_value,
            sample_sequence_offset: output.sample_sequence_offset,
            denoise: overrides.denoise.unwrap_or(defaults.2),
            format: overrides.format,
            gpu: overrides.gpu,
        };
        this.validate(shot.output.duration)?;
        Ok(this)
    }
    fn validate(self, duration: f64) -> Result<()> {
        shot::check_size(self.size)?;
        shot::check_samples(self.spp, self.sample_sequence_offset)?;
        shot::frame_count(duration, self.fps)?;
        if self.format == Format::Exr {
            return Err(Error::validation(
                "/format",
                "EXR output is unavailable",
                "Use PNG with this build.",
            ));
        }
        Ok(())
    }
    pub fn seed(self, frame: u32) -> u32 {
        match self.seed {
            Seed::Fixed => self.seed_value,
            Seed::Frame => self.seed_value.wrapping_add(frame),
        }
    }
}
fn parse_size(value: &str) -> std::result::Result<[u32; 2], String> {
    let (w, h) = value.split_once(['x', 'X']).ok_or("expected WxH")?;
    Ok([
        w.parse().map_err(|_| "invalid width")?,
        h.parse().map_err(|_| "invalid height")?,
    ])
}
fn parse_range(value: &str) -> std::result::Result<[u32; 2], String> {
    let (a, b) = value.split_once('-').ok_or("expected A-B")?;
    Ok([
        a.parse().map_err(|_| "invalid first frame")?,
        b.parse().map_err(|_| "invalid last frame")?,
    ])
}

pub struct Input {
    pub shot: Shot,
    pub prepared: Prepared,
    assets: Assets,
    hash: String,
}

impl Input {
    pub fn load(file: &Path) -> Result<Self> {
        let base = file
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let input =
            File::open(file).map_err(|e| Error::asset("", format!("{}: {e}", file.display())))?;
        let mut bytes = vec![];
        input
            .take(shot::MAX_SHOT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| Error::asset("", e.to_string()))?;
        if bytes.len() as u64 > shot::MAX_SHOT_BYTES {
            return Err(Error::budget(
                "Shot JSON exceeds 32 MiB. Move large arrays to binary sidecars.",
            ));
        }
        let shot = shot::parse(&bytes)?;
        let mut assets = Assets::load(&shot, base)?;
        let prepared = Prepared::new(&shot, &mut assets)?;
        Ok(Self {
            shot,
            prepared,
            assets,
            hash: assets::digest(&bytes),
        })
    }

    fn manifest(&self, settings: Settings) -> serde_json::Value {
        json!({
            "version": 1,
            "build": env!("MUTRACER_CLI_BUILD_ID"),
            "shotSha256": self.hash,
            "assets": self.assets.fingerprints().collect::<Vec<_>>(),
            "settings": settings,
        })
    }

    fn estimate(&self, settings: Settings, frames: u32) -> serde_json::Value {
        let pixels = u64::from(settings.size[0]) * u64::from(settings.size[1]);
        let workload = pixels * u64::from(settings.spp) * u64::from(frames);
        let complex = self
            .shot
            .objects
            .iter()
            .filter(|obj| {
                obj.asset.is_some()
                    || obj
                        .material
                        .as_ref()
                        .is_some_and(|m| m.transmission.is_some() || m.coat.is_some())
            })
            .count();
        let material_factor = 1. + 0.75 * complex as f64 / self.shot.objects.len() as f64;
        json!({
            "frames": frames, "pixelsPerFrame": pixels, "spp": settings.spp,
            "pixelSamples": workload, "materialFactor": material_factor,
            "weightedPixelSamples": workload as f64 * material_factor
        })
    }
}

pub fn validate(file: &Path) -> Result<()> {
    let input = Input::load(file)?;
    let settings = Settings::resolve(
        &input.shot,
        &Overrides {
            size: None,
            spp: None,
            seed: None,
            denoise: None,
            format: Format::Png,
            gpu: None,
        },
        None,
        false,
    )?;
    let frames = shot::frame_count(input.shot.output.duration, settings.fps)?;
    progress(
        json!({"event":"validated","shot":file,"assets":input.assets.fingerprints().count(),"cost":input.estimate(settings,frames)}),
    );
    Ok(())
}

pub struct Renderer {
    pub engine: api::Engine,
    pub render: api::Render,
    camera: Option<api::Camera>,
}
impl Renderer {
    pub fn new(settings: Settings) -> Result<Self> {
        let engine = if let Some(index) = settings.gpu {
            let adapters = api::Engine::adapters();
            let adapter = adapters.get(index).ok_or_else(|| {
                Error::gpu(format!(
                    "GPU index {index} out of range. Available adapters: {}",
                    adapters
                        .iter()
                        .enumerate()
                        .map(|(i, a)| format!("{i}: {}", a.get_info().name))
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?;
            api::Engine::on_adapter(adapter, Default::default())
        } else {
            api::Engine::new(Default::default())
        }
        .map_err(|e| Error::gpu(e.to_string()))?;
        let [width, height] = settings.size;
        let render = api::Render::new(
            &engine,
            api::RenderSettings {
                size: api::RenderSize::Fixed { width, height },
                max_samples: settings.spp,
                bounces: 6,
                seed: settings.seed_value,
                ..Default::default()
            },
        )
        .map_err(|e| Error::gpu(e.to_string()))?;
        if settings.denoise == Denoise::Oidn {
            render
                .set_denoiser(Some(api::DenoiserOptions {
                    backend: api::DENOISE_OIDN_WEBGPU,
                    ..Default::default()
                }))
                .map_err(|e| Error::gpu(e.to_string()))?;
        }
        Ok(Self {
            engine,
            render,
            camera: None,
        })
    }

    pub fn shot_frame(
        &mut self,
        input: &mut Input,
        settings: Settings,
        frame: u32,
        t: f64,
    ) -> Result<Vec<u8>> {
        let (camera, display) = input.prepared.evaluate(&input.shot, t, settings.size)?;
        self.engine
            .set_scene_object(&input.prepared.scene)
            .map_err(|e| Error::gpu(e.to_string()))?;
        if self.camera != Some(camera) {
            self.engine
                .set_camera(Some(camera))
                .map_err(|e| Error::gpu(e.to_string()))?;
            self.camera = Some(camera);
        }
        self.engine
            .display()
            .set_settings(display)
            .map_err(|e| Error::gpu(e.to_string()))?;
        self.engine
            .update()
            .map_err(|e| Error::gpu(e.to_string()))?;
        self.capture(settings, frame)
    }

    pub fn capture(&self, settings: Settings, frame: u32) -> Result<Vec<u8>> {
        let mut options = self
            .render
            .settings()
            .map_err(|e| Error::gpu(e.to_string()))?;
        let seed = settings.seed(frame);
        if options.seed != seed {
            options.seed = seed;
            self.render
                .set_settings(options)
                .map_err(|e| Error::gpu(e.to_string()))?;
        }
        let mut converge = api::ConvergeOptions::new(settings.spp);
        converge.sample_sequence_offset = settings.sample_sequence_offset;
        self.render
            .converge(converge)
            .map_err(|e| Error::gpu(e.to_string()))?;
        if settings.denoise == Denoise::Oidn {
            match self.render.denoise_report() {
                Some(report) if report.samples == settings.spp && report.error.is_none() => {}
                Some(report) => {
                    return Err(Error::gpu(report.error.unwrap_or_else(|| {
                        "OIDN did not finish the requested samples".into()
                    })));
                }
                None => return Err(Error::gpu("OIDN did not return a result")),
            }
        }
        self.engine
            .display()
            .encode_png(&self.render)
            .map_err(|e| Error::gpu(e.to_string()))
    }
}

pub fn still(args: Still, worker: bool) -> Result<()> {
    if !worker {
        return run_worker(None);
    }
    let started = Instant::now();
    let mut input = Input::load(&args.file)?;
    let settings = Settings::resolve(&input.shot, &args.options, None, false)?;
    if !args.t.is_finite() || !(0. ..=input.shot.output.duration).contains(&args.t) {
        return Err(Error::validation(
            "/t",
            "Still time must be inside the shot",
            "Use --t between 0 and duration.",
        ));
    }
    let frame = (args.t * f64::from(settings.fps)).floor() as u32;
    let image = Renderer::new(settings)?.shot_frame(&mut input, settings, frame, args.t)?;
    encode::atomic_bytes(&args.output, |file| file.write_all(&image))
        .map_err(|e| encode::failure(e.to_string()))?;
    progress(
        json!({"event":"frame","frame":frame,"t":args.t,"path":args.output,"samples":settings.spp,"elapsedMs":ms(started)}),
    );
    Ok(())
}

fn cache_dir(args: &Sequence) -> PathBuf {
    args.keep_frames.clone().unwrap_or_else(|| {
        let mut name = args.output.file_name().unwrap_or_default().to_os_string();
        name.push(".frames");
        args.output.with_file_name(name)
    })
}

fn lock(path: &Path) -> Result<File> {
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| encode::failure(e.to_string()))?;
    file.try_lock()
        .map_err(|e| encode::failure(format!("Cannot lock {}: {e}", path.display())))?;
    Ok(file)
}

fn verify_manifest(directory: &Path, manifest: &serde_json::Value, create: bool) -> Result<()> {
    let path = directory.join("manifest.json");
    match fs::read(&path) {
        Ok(bytes) => {
            if serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .as_ref()
                != Some(manifest)
            {
                return Err(Error::validation(
                    "/output/manifest",
                    format!("{} describes a different render job", path.display()),
                    "Use a new frame directory for changed shots, assets or render settings.",
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
            if fs::read_dir(directory)
                .map_err(|e| encode::failure(e.to_string()))?
                .any(|entry| {
                    entry.map_or(true, |entry| {
                        entry
                            .path()
                            .extension()
                            .is_some_and(|ext| ext == "png" || ext == "exr")
                    })
                })
            {
                return Err(Error::validation(
                    "/output/manifest",
                    "Frame directory contains images without a manifest",
                    "Use a fresh frame directory.",
                ));
            }
            let mut bytes = serde_json::to_vec_pretty(manifest).unwrap();
            bytes.push(b'\n');
            encode::atomic_bytes(&path, |file| file.write_all(&bytes))
                .map_err(|e| encode::failure(e.to_string()))?;
        }
        Err(error) => return Err(encode::failure(format!("{}: {error}", path.display()))),
    }
    Ok(())
}

fn frame_path(directory: &Path, index: u32) -> PathBuf {
    directory.join(format!("frame_{index:06}.png"))
}

fn reusable(path: &Path, size: [u32; 2]) -> bool {
    image::ImageReader::open(path)
        .ok()
        .and_then(|file| file.decode().ok())
        .is_some_and(|image| [image.width(), image.height()] == size)
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.
}

pub fn sequence(args: Sequence, preview: bool, worker: bool) -> Result<()> {
    let started = Instant::now();
    let mut input = Input::load(&args.file)?;
    let settings = Settings::resolve(&input.shot, &args.options, args.fps, preview)?;
    let count = shot::frame_count(input.shot.output.duration, settings.fps)?;
    let [first, last] = args.frames.unwrap_or([0, count - 1]);
    if first > last || last >= count {
        return Err(Error::validation(
            "/frames",
            format!("Expected an inclusive frame range inside 0-{}", count - 1),
            "Check the shot duration and effective fps.",
        ));
    }
    if args
        .output
        .extension()
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("mp4"))
    {
        return Err(Error::validation(
            "/output",
            "Expected an .mp4 output path",
            "Use -o FILE.mp4. Rendered PNGs remain in the frame directory.",
        ));
    }
    if settings.size.iter().any(|&edge| edge < 2 || edge % 2 != 0) {
        return Err(Error::validation(
            "/output/size",
            "MP4 encoding requires even dimensions of at least 2",
            "Use an even size.",
        ));
    }
    let deadline = if let Some(minutes) = args.max_minutes {
        let span = Duration::try_from_secs_f64(minutes * 60.)
            .ok()
            .filter(|d| !d.is_zero())
            .ok_or_else(|| {
                Error::validation(
                    "/max-minutes",
                    "Expected a positive time budget",
                    "Specify the maximum render time in minutes.",
                )
            })?;
        Some(
            started
                .checked_add(span)
                .ok_or_else(|| Error::budget("Time budget is too large"))?,
        )
    } else {
        None
    };
    let directory = cache_dir(&args);
    let indices: Vec<u32> = (first..=last).step_by(settings.stride as usize).collect();
    let files: Vec<_> = indices.iter().map(|&i| frame_path(&directory, i)).collect();
    let manifest = input.manifest(settings);

    if worker {
        let _worker_lock = lock(&directory.join("worker.lock"))?;
        verify_manifest(&directory, &manifest, false)?;
        let mut renderer = None;
        let mut seen = 0u32;
        let mut render_ms = 0.;
        for (&frame, path) in indices.iter().zip(&files) {
            let t = f64::from(frame) / f64::from(settings.fps);
            if reusable(path, settings.size) {
                progress(json!({"event":"reused","frame":frame,"t":t,"path":path}));
                continue;
            }
            if renderer.is_none() {
                progress(json!({"event":"worker","pid":std::process::id()}));
                renderer = Some(Renderer::new(settings)?);
            }
            let tick = Instant::now();
            let image = renderer
                .as_mut()
                .unwrap()
                .shot_frame(&mut input, settings, frame, t)?;
            encode::atomic_bytes(path, |file| file.write_all(&image))
                .map_err(|e| encode::failure(e.to_string()))?;
            let elapsed = ms(tick);
            seen += 1;
            render_ms += elapsed;
            progress(
                json!({"event":"frame","frame":frame,"t":t,"path":path,"samples":settings.spp,"elapsedMs":elapsed}),
            );
            if seen == 2 {
                progress(
                    json!({"event":"calibrated","steadyMsPerFrame":elapsed,"observedMeanMs":render_ms/2.,
                    "estimatedRemainingMs": elapsed * f64::from((last-frame)/settings.stride)}),
                );
            }
        }
        return Ok(());
    }

    fs::create_dir_all(&directory).map_err(|e| encode::failure(e.to_string()))?;
    let _lock = lock(&directory.join("supervisor.lock"))?;
    verify_manifest(&directory, &manifest, true)?;
    progress(
        json!({"event":"plan","frames":directory,"cost":input.estimate(settings, indices.len() as u32)}),
    );
    drop(input);
    run_worker(deadline)?;
    if let Some(path) = &args.contact_sheet {
        encode::contact_sheet(&files, path)?;
        progress(json!({"event":"contactSheet","path":path}));
    }
    if encode::encode(
        &files,
        &args.output,
        Rate {
            fps: settings.fps,
            stride: settings.stride,
        },
    )? {
        progress(
            json!({"event":"encoded","path":args.output,"frames":files.len(),"elapsedMs":ms(started)}),
        );
    } else {
        let message = "ffmpeg was unavailable. PNG frames are ready to encode.";
        eprintln!("{message}");
        progress(json!({"event":"sequence","path":directory,"message":message}));
    }
    Ok(())
}

fn run_worker(deadline: Option<Instant>) -> Result<()> {
    let exe = std::env::current_exe().map_err(|e| Error::gpu(e.to_string()))?;
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let configured = std::env::var("MUTRACER_GPU_RETRIES")
        .ok()
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(2)
        .min(10);
    for attempt in 0..=configured {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            return Err(Error::budget("Render time budget reached"));
        }
        let mut child = Command::new(&exe)
            .arg("--worker")
            .args(&args)
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| Error::gpu(format!("Cannot start render worker: {e}")))?;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| Error::gpu(e.to_string()))? {
                break status;
            }
            if deadline.is_some_and(|d| Instant::now() >= d) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::budget(
                    "Render time budget reached. Completed frames were saved.",
                ));
            }
            thread::sleep(Duration::from_millis(20));
        };
        match status.code() {
            Some(0) => return Ok(()),
            Some(code @ 2..=4) => {
                return Err(Error {
                    code: code as u8,
                    pointer: None,
                    message: "Render worker stopped. See the preceding error.".into(),
                    hint: "Correct the reported error before retrying.".into(),
                });
            }
            _ if attempt < configured => {
                progress(json!({"event":"retry","attempt":attempt+1,"status":status.to_string()}))
            }
            _ => {
                return Err(Error::gpu(format!(
                    "Render worker stopped after {} attempt(s): {status}",
                    attempt + 1
                )));
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_reuses_exact_job_and_rejects_changed_settings() {
        let root =
            std::env::temp_dir().join(format!("mutracer-manifest-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let original = json!({"version":1,"settings":{"spp":32}});
        let changed = json!({"version":1,"settings":{"spp":8}});
        verify_manifest(&root, &original, true).unwrap();
        verify_manifest(&root, &original, false).unwrap();
        assert_eq!(verify_manifest(&root, &changed, true).unwrap_err().code, 2);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(root.join("manifest.json")).unwrap()
            )
            .unwrap(),
            original
        );
        fs::remove_dir_all(root).unwrap();
    }
}
