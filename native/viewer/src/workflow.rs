//! Desktop file, export and help workflows.
use crate::*;
use std::sync::mpsc;

pub struct ExportJob {
    receive: mpsc::Receiver<Result<()>>,
    progress: mpsc::Receiver<api::ConvergeProgress>,
    cancel: api::CancelToken,
    resume: bool,
}
pub struct Tools {
    pub export_open: bool,
    pub export_size: usize,
    pub export_samples: u32,
    pub export_denoise: bool,
    pub transparent: bool,
    pub preview: Option<egui::TextureHandle>,
    pub progress: Option<api::ConvergeProgress>,
    pub job: Option<ExportJob>,
    pub url_open: bool,
    pub url: String,
    pub help_open: bool,
    pub reset_open: bool,
    pub code_open: bool,
}
impl Default for Tools {
    fn default() -> Self {
        Self {
            export_open: false,
            export_size: 0,
            export_samples: 64,
            export_denoise: true,
            transparent: false,
            preview: None,
            progress: None,
            job: None,
            url_open: false,
            url: String::new(),
            help_open: false,
            reset_open: false,
            code_open: false,
        }
    }
}
impl Drop for Tools {
    fn drop(&mut self) {
        if let Some(job) = &self.job {
            job.cancel.cancel();
        }
    }
}
pub fn export_size(preset: usize, viewport: [u32; 2]) -> [u32; 2] {
    match preset {
        1 => [1920, 1080],
        2 => [2560, 1440],
        3 => [3840, 2160],
        4 => [2048, 2048],
        _ => viewport,
    }
}
impl Viewer {
    pub(super) fn open_export(&mut self, ctx: &egui::Context) {
        self.tools.export_open = true;
        self.tools.export_samples = self.settings.max_samples;
        self.tools.export_denoise = self.denoise;
        self.tools.transparent =
            !self.environment.background && self.environment.background_alpha == 0.;
        if let Some(render) = self.target.render_loop.presented_render() {
            if let Ok((w, h, rgba)) = self.target.engine.display().read_rgba8(render) {
                self.tools.preview = Some(ctx.load_texture(
                    "Export preview",
                    egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba),
                    egui::TextureOptions::LINEAR,
                ));
            }
        }
    }
    pub(super) fn start_export(&mut self, path: PathBuf, ctx: &egui::Context) {
        if self.tools.job.is_some() {
            return;
        }
        let size = export_size(self.tools.export_size, self.size);
        let mut settings = render_settings(&self.settings, size, false);
        settings.max_samples = self.tools.export_samples;
        settings.aovs = self.output_mask();
        let model = self.model.clone();
        let camera = self.camera.clone();
        let light = self.light.clone();
        let mut environment = self.environment.clone();
        if self.tools.transparent {
            environment.background = false;
            environment.background_alpha = 0.;
        }
        let mut display = display_settings(&self.display_settings);
        display.aov = self.aov_display;
        let gpu = self.gpu.clone();
        let gate = self.submission_gate.clone();
        let backend = self.backend;
        let denoise = self.tools.export_denoise;
        let oidn = self.oidn_settings;
        let jnlm = (self.denoiser_choice == denoiser::Choice::Jnlm).then_some(self.jnlm_settings);
        let cancel = api::CancelToken::new();
        let token = cancel.clone();
        let (send, receive) = mpsc::channel();
        let (progress, updates) = mpsc::channel();
        let ctx = ctx.clone();
        let resume = self.running;
        self.running = false;
        self.target.render_loop.cancel_refill();
        std::thread::spawn(move || {
            let result = (|| -> Result<()> {
                let options = api::EngineOptions {
                    backend: if backend == 1 {
                        api::Backend::Hardware
                    } else {
                        api::Backend::Software
                    },
                };
                let engine = match gpu {
                    Some(gpu) => {
                        api::Engine::on_device(&gpu.adapter, &gpu.device, &gpu.queue, options, gate)
                    }
                    None => api::Engine::new(options)?,
                };
                engine.display().set_size(size[0], size[1])?;
                engine.display().set_settings(display)?;
                let descriptor =
                    model.descriptor_with_light(&camera.bytes(size), size, &environment, &light);
                engine.set_scene(&descriptor)?;
                let mut render_loop = api::RenderLoop::new(
                    &engine,
                    api::RenderLoopOptions {
                        preview: None,
                        final_render: api::LoopRender::Settings(settings.clone()),
                        ..Default::default()
                    },
                )?;
                if denoise {
                    if let Some(jnlm) = jnlm {
                        render_loop
                            .final_render()
                            .set_jnlm_display_filter(Some(jnlm))?;
                    } else {
                        render_loop.final_render().set_viewer_denoiser(Some(
                            oidn.options(api::DenoiseSchedule::Converged),
                        ))?;
                    }
                }
                if settings.aovs != 0 {
                    loop {
                        ensure!(!token.is_cancelled(), "Export cancelled");
                        match render_loop.tick()? {
                            api::RenderLoopStatus::Finished => break,
                            api::RenderLoopStatus::Error => {
                                anyhow::bail!("Auxiliary export failed")
                            }
                            _ => {}
                        }
                        std::thread::sleep(Duration::from_millis(1));
                    }
                } else {
                    let wake = ctx.clone();
                    let mut options = api::ConvergeOptions::new(settings.max_samples);
                    options.cancel = Some(token.clone());
                    options.on_progress = Some(Box::new(move |p| {
                        let _ = progress.send(p.clone());
                        wake.request_repaint();
                    }));
                    render_loop.converge(options)?;
                }
                ensure!(!token.is_cancelled(), "Export cancelled");
                let png = engine.display().encode_png(render_loop.final_render())?;
                std::fs::write(path, png)?;
                Ok(())
            })();
            let _ = send.send(result);
            ctx.request_repaint();
        });
        self.tools.progress = None;
        self.tools.job = Some(ExportJob {
            receive,
            progress: updates,
            cancel,
            resume,
        });
    }
    pub(super) fn poll_export(&mut self, ctx: &egui::Context) {
        let Some(job) = &self.tools.job else {
            return;
        };
        for progress in job.progress.try_iter() {
            self.tools.progress = Some(progress);
        }
        let result = match job.receive.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => {
                ctx.request_repaint_after(Duration::from_millis(16));
                return;
            }
            Err(_) => Err(anyhow::anyhow!("Export worker stopped")),
        };
        let job = self.tools.job.take().unwrap();
        self.running = job.resume;
        if let Err(error) = result {
            if !job.cancel.is_cancelled() {
                self.error = format!("Export failed: {error:#}");
            }
        } else {
            self.tools.export_open = false;
        }
        self.tools.progress = None;
    }
    pub(super) fn workflow_dialogs(&mut self, ctx: &egui::Context) {
        self.poll_export(ctx);
        if self.tools.url_open {
            let mut open = true;
            egui::Window::new("Open from URL")
                .open(&mut open)
                .collapsible(false)
                .resizable(false)
                .default_width(440.)
                .show(ctx, |ui| {
                    let field = ui.add(
                        egui::TextEdit::singleline(&mut self.tools.url)
                            .hint_text("https://…/model.glb or environment.hdr")
                            .desired_width(f32::INFINITY),
                    );
                    let valid = url::Url::parse(self.tools.url.trim())
                        .is_ok_and(|u| matches!(u.scheme(), "https" | "http"));
                    if ui.add_enabled(valid, egui::Button::new("Open")).clicked()
                        || valid
                            && field.lost_focus()
                            && ui.input(|i| i.key_pressed(egui::Key::Enter))
                    {
                        let address = self.tools.url.trim().to_owned();
                        let name = url::Url::parse(&address)
                            .unwrap()
                            .path_segments()
                            .and_then(|mut p| p.next_back())
                            .unwrap_or("model.glb")
                            .to_owned();
                        if name.to_lowercase().ends_with(".hdr")
                            || name.to_lowercase().ends_with(".exr")
                        {
                            self.environments.load(address, name, ctx);
                        } else {
                            self.start_load(
                                None,
                                Some(serde_json::json!({"url":address,"name":name})),
                                ctx,
                            );
                        }
                        self.tools.url_open = false;
                    }
                });
            self.tools.url_open &= open;
        }
        if self.tools.reset_open {
            let mut open = true;
            egui::Window::new("Reset all?").open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
                ui.label("Restore lighting, render settings, materials and object visibility, and frame the model again. You can undo the edits; camera framing is immediate.");
                ui.horizontal(|ui| {
                    if controls::button(ui,"Cancel").clicked() { self.tools.reset_open=false; }
                    if controls::button(ui,"Reset all").clicked() { self.reset_all(); self.tools.reset_open=false; }
                });
            });
            self.tools.reset_open &= open;
        }
        if self.tools.help_open {
            let mut open = true;
            egui::Window::new("Keyboard shortcuts")
                .open(&mut open)
                .collapsible(false)
                .resizable(false)
                .show(ctx, |ui| {
                    egui::Grid::new("shortcuts")
                        .spacing([24., 8.])
                        .show(ui, |ui| {
                            for (key, label) in [
                                ("Drag / right-drag / scroll", "Orbit / pan / zoom"),
                                ("F", "Fit to model"),
                                ("Space", "Play or pause"),
                                ("D", "Toggle denoiser"),
                                ("E", "Export image"),
                                ("1–4", "Inspector tabs"),
                                ("[ / ]", "Scene / inspector"),
                                ("H", "Hide interface"),
                                ("⌘Z / Ctrl+Z", "Undo"),
                                ("⇧⌘Z / Ctrl+Shift+Z", "Redo"),
                                ("⌘O / Ctrl+O", "Open files"),
                            ] {
                                ui.monospace(key);
                                ui.label(label);
                                ui.end_row();
                            }
                        });
                });
            self.tools.help_open = open;
        }
        if self.tools.code_open {
            let mut open = true;
            let mut source = self.render_setup_code();
            egui::Window::new("Render setup · Rust")
                .open(&mut open)
                .default_width(640.)
                .default_height(520.)
                .show(ctx, |ui| {
                    if controls::button(ui, "Copy code").clicked() {
                        ctx.copy_text(source.clone());
                    }
                    ui.hyperlink_to(
                        "Native SDK guide",
                        "https://github.com/pissang/mutracer/blob/dev/native/README.md",
                    );
                    egui::ScrollArea::both().show(ui, |ui| {
                        ui.add(
                            egui::TextEdit::multiline(&mut source)
                                .font(egui::TextStyle::Monospace)
                                .code_editor()
                                .desired_width(f32::INFINITY),
                        );
                    });
                });
            self.tools.code_open = open;
        }
        if self.tools.export_open {
            let modal = egui::Modal::new(egui::Id::new("export-image")).show(ctx, |ui| {
                ui.set_width(440.);
                ui.horizontal(|ui| {
                    ui.heading("Export image");
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("×").clicked() {
                            self.tools.export_open = false;
                        }
                    });
                });
                ui.add_space(8.);
                let busy = self.tools.job.is_some();
                if let Some(texture) = &self.tools.preview {
                    let size = texture.size_vec2();
                    let scale = (420. / size.x).min(240. / size.y);
                    ui.vertical_centered(|ui| {
                        ui.add(egui::Image::from_texture(texture).fit_to_exact_size(size * scale));
                    });
                }
                if ui
                    .add_enabled(
                        !busy && self.frame_samples > 0,
                        egui::Button::new("Save viewport PNG")
                            .min_size(egui::vec2(ui.available_width(), 30.)),
                    )
                    .clicked()
                {
                    if let Some(path) = png_path() {
                        if let Err(e) = self.save_viewport(&path) {
                            self.error = format!("Export failed: {e:#}");
                        }
                    }
                }
                ui.add_enabled_ui(!busy, |ui| {
                    controls::select(
                        ui,
                        "Size",
                        ["Viewport", "1080p", "2K", "4K", "Square"][self.tools.export_size],
                        |ui| {
                            for (i, name) in ["Viewport", "1080p", "2K", "4K", "Square"]
                                .iter()
                                .enumerate()
                            {
                                ui.selectable_value(&mut self.tools.export_size, i, *name);
                            }
                        },
                    );
                    controls::parameter(
                        ui,
                        "Samples",
                        controls::Scrub::new(&mut self.tools.export_samples, 16..=16384)
                            .logarithmic(true),
                    );
                    controls::toggle(ui, "Denoise", &mut self.tools.export_denoise);
                    controls::toggle(ui, "Transparent background", &mut self.tools.transparent);
                });
                let size = export_size(self.tools.export_size, self.size);
                ui.horizontal(|ui| {
                    let estimate = self
                        .final_render()
                        .gpu_sample_time_ms()
                        .filter(|_| self.output_mask() == 0)
                        .map(|ms| {
                            ms * self.tools.export_samples as f64
                                * (size[0] as f64 * size[1] as f64)
                                / (self.size[0] as f64 * self.size[1] as f64)
                                / 1000.
                        });
                    ui.monospace(format!(
                        "{} × {}{}",
                        size[0],
                        size[1],
                        estimate
                            .filter(|_| !busy)
                            .map_or(String::new(), |s| format!(" · ≈ {:.0} s", s.max(1.)))
                    ));
                    if let Some(p) = self
                        .tools
                        .progress
                        .filter(|p| p.stage == api::ConvergeStage::Denoising)
                    {
                        let _ = p;
                        ui.spinner();
                        ui.label("Denoising…");
                    } else if let Some(p) = &self.tools.progress {
                        ui.add(
                            egui::ProgressBar::new(
                                p.samples as f32 / p.target_samples.max(1) as f32,
                            )
                            .text(format!("{} / {} spp", p.samples, p.target_samples)),
                        );
                    }
                });
                ui.horizontal(|ui| {
                    if controls::button(ui, if busy { "Cancel render" } else { "Cancel" }).clicked()
                    {
                        if let Some(job) = &self.tools.job {
                            job.cancel.cancel();
                        }
                        self.tools.export_open = false;
                    }
                    if ui
                        .add_enabled(
                            !busy && !self.preparing(),
                            egui::Button::new(if busy { "Rendering…" } else { "Render PNG" }),
                        )
                        .clicked()
                    {
                        if let Some(path) = png_path() {
                            self.start_export(path, ctx);
                        }
                    }
                });
            });
            if !self.tools.export_open
                || (modal.should_close()
                    && (self.tools.job.is_none() || !modal.backdrop_response.clicked()))
            {
                if let Some(job) = &self.tools.job {
                    job.cancel.cancel();
                }
                self.tools.export_open = false;
            }
        }
    }
    pub(super) fn render_setup_code(&self) -> String {
        let camera = api::Camera::from_bytes(&self.camera.bytes(self.size)).expect("Viewer camera");
        let pattern = match self.settings.sampling_pattern {
            1 => "ZSobol",
            2 => "Random",
            _ => "Sobol",
        };
        let c = render_settings(&self.settings, self.size, false).caustics;
        let caustics = if self.settings.caustic_flags == 0 {
            String::new()
        } else {
            format!(
                "            caustics: CausticSettings {{ light_tracing: {}, photon_mapping: {}, light_photons: {}, photon_map_photons: {}, photon_map_radius: {:?} }},\n",
                c.light_tracing,
                c.photon_mapping,
                c.light_photons,
                c.photon_map_photons,
                c.photon_map_radius
            )
        };
        format!(
            r#"use mutracer_native_probe::{{api::*, scene_api::Scene}};

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {{
    let imported = Scene::import_gltf("model.glb")?;
    let engine = Engine::new(EngineOptions {{ backend: Backend::{} }})?;
    engine.display().set_size({}, {})?;
    engine.display().set_settings(DisplaySettings {{
        tone_mapping: ToneMapping::{}, tone_mapping_exposure: {:?},
        contrast: {:?}, saturation: {:?}, temperature: {:?}, tint: {:?},
        bloom_intensity: {:?}, bloom_threshold: {:?}, bloom_radius: {:?}, vignette: {:?},
        ..Default::default()
    }})?;
    engine.set_scene_object(&imported.scene)?;
    engine.set_camera(Some({camera:?}))?;
    let mut render_loop = RenderLoop::new(&engine, RenderLoopOptions {{
        final_render: LoopRender::Settings(RenderSettings {{
            max_samples: {}, bounces: {}, clamping: {:?}, batch_samples: true,
            sampling_pattern: SamplingPattern::{pattern},
{caustics}            ..Default::default()
        }}),
        ..Default::default()
    }})?;
    engine.update()?;
    render_loop.converge(ConvergeOptions::new({}))?;
    std::fs::write("render.png", engine.display().encode_png(render_loop.final_render())?)?;
    Ok(())
}}
"#,
            if self.backend == 1 {
                "Hardware"
            } else {
                "Software"
            },
            self.size[0],
            self.size[1],
            ["Agx", "Aces", "Cineon", "Reinhard", "Linear"]
                [self.display_settings.tone_mapping as usize],
            self.display_settings.exposure,
            self.display_settings.contrast,
            self.display_settings.saturation,
            self.display_settings.temperature,
            self.display_settings.tint,
            self.display_settings.bloom_intensity,
            self.display_settings.bloom_threshold,
            self.display_settings.bloom_radius,
            self.display_settings.vignette,
            self.settings.max_samples,
            self.settings.bounces,
            self.settings.clamping,
            self.settings.max_samples
        )
    }
    fn save_viewport(&self, path: &Path) -> Result<()> {
        let render = self
            .target
            .render_loop
            .presented_render()
            .context("No completed viewport image")?;
        std::fs::write(path, self.target.engine.display().encode_png(render)?)?;
        Ok(())
    }
}
fn png_path() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_file_name("mutracer.png")
        .add_filter("PNG", &["png"])
        .save_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_dimensions_keep_viewport_and_square_distinct() {
        assert_eq!(export_size(0, [731, 419]), [731, 419]);
        assert_eq!(export_size(1, [1, 1]), [1920, 1080]);
        assert_eq!(export_size(3, [1, 1]), [3840, 2160]);
        assert_eq!(export_size(4, [1, 1]), [2048, 2048]);
    }
}
