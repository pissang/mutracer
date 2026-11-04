//! Loading remains visible through preparation until the incoming scene presents.
use crate::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Download,
    Parse,
    Bvh,
    Shaders,
}
impl Stage {
    pub const ALL: [Self; 4] = [Self::Download, Self::Parse, Self::Bvh, Self::Shaders];
    pub fn label(self) -> &'static str {
        match self {
            Self::Download => "Download",
            Self::Parse => "Parse glTF",
            Self::Bvh => "Build BVH",
            Self::Shaders => "Compile shaders",
        }
    }
}
pub enum Update {
    Download { loaded: u64, total: u64 },
    Stage(Stage),
}
pub struct Progress {
    pub name: String,
    pub stage: Stage,
    pub loaded: u64,
    pub total: u64,
}
impl Progress {
    pub fn new(name: String, stage: Stage) -> Self {
        Self {
            name,
            stage,
            loaded: 0,
            total: 0,
        }
    }
    pub fn update(&mut self, update: Update) {
        match update {
            Update::Download { loaded, total } if self.stage == Stage::Download => {
                self.loaded = loaded;
                self.total = total;
            }
            Update::Stage(stage) => self.stage = self.stage.max(stage),
            _ => {}
        }
    }
    pub fn fraction(&self) -> f32 {
        if self.total == 0 {
            0.
        } else {
            (self.loaded as f64 / self.total as f64).clamp(0., 1.) as f32
        }
    }
    pub fn bytes_label(&self) -> String {
        if self.total == 0 {
            format!("{:.1} MB", self.loaded as f64 / 1048576.)
        } else {
            format!(
                "{:.1} / {:.1} MB",
                self.loaded as f64 / 1048576.,
                self.total as f64 / 1048576.
            )
        }
    }
}
impl Viewer {
    pub(super) fn loading_card(&mut self, ctx: &egui::Context, viewport: egui::Rect) -> egui::Rect {
        let Some(progress) = &self.load_status else {
            return egui::Rect::NOTHING;
        };
        let mut cancel = false;
        let width = 310_f32.min((viewport.width() - 32.).max(120.));
        let response = egui::Area::new(egui::Id::new("model-loading"))
            .order(egui::Order::Foreground)
            .pivot(egui::Align2::CENTER_CENTER)
            .fixed_pos(viewport.center())
            .show(ctx, |ui| {
                theme::panel()
                    .inner_margin(20)
                    .corner_radius(12)
                    .show(ui, |ui| {
                        ui.set_width(width);
                        ui.with_layout(egui::Layout::top_down(egui::Align::Center), |ui| {
                            ui.add(
                                egui::Label::new(
                                    egui::RichText::new(format!("Loading {}", progress.name))
                                        .strong()
                                        .size(14.),
                                )
                                .truncate(),
                            );
                        });
                        ui.add_space(14.);
                        for stage in Stage::ALL {
                            let done = stage < progress.stage;
                            let active = stage == progress.stage;
                            ui.horizontal(|ui| {
                                if active {
                                    ui.add(egui::Spinner::new().size(13.).color(theme::ACCENT));
                                } else {
                                    let (rect, _) = ui.allocate_exact_size(
                                        egui::vec2(13., 18.),
                                        egui::Sense::hover(),
                                    );
                                    let center = rect.center();
                                    if done {
                                        ui.painter().line_segment(
                                            [
                                                center + egui::vec2(-4., 0.),
                                                center + egui::vec2(-1., 3.),
                                            ],
                                            egui::Stroke::new(1.5, theme::ACCENT),
                                        );
                                        ui.painter().line_segment(
                                            [
                                                center + egui::vec2(-1., 3.),
                                                center + egui::vec2(5., -4.),
                                            ],
                                            egui::Stroke::new(1.5, theme::ACCENT),
                                        );
                                    } else {
                                        ui.painter().circle_stroke(
                                            center,
                                            4.5,
                                            egui::Stroke::new(1., theme::SUBTLE),
                                        );
                                    }
                                }
                                ui.label(egui::RichText::new(stage.label()).color(if active {
                                    theme::TEXT
                                } else {
                                    theme::MUTED
                                }));
                                if stage == Stage::Download && progress.loaded > 0 {
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            ui.label(
                                                egui::RichText::new(progress.bytes_label())
                                                    .monospace()
                                                    .small()
                                                    .color(theme::MUTED),
                                            );
                                        },
                                    );
                                }
                            });
                            ui.add_space(5.);
                        }
                        let overall = (progress.stage as usize as f32
                            + if progress.stage == Stage::Download {
                                progress.fraction()
                            } else {
                                0.
                            })
                            / 4.;
                        ui.add_space(4.);
                        ui.add(
                            egui::ProgressBar::new(overall.max(0.04))
                                .desired_height(4.)
                                .fill(theme::ACCENT),
                        );
                        // Cancelling parsing/download preserves the committed scene. Once
                        // preparation starts the SDK publishes it atomically; let it finish.
                        if self.loading.is_some() {
                            ui.add_space(10.);
                            let response = controls::button(ui, "Cancel");
                            #[cfg(test)]
                            ctx.data_mut(|d| {
                                d.insert_temp(egui::Id::new("load-cancel"), response.rect)
                            });
                            cancel = response.clicked();
                        }
                    });
            });
        if cancel {
            self.load_cancel.store(true, Ordering::Relaxed);
            self.loading = None;
            self.load_progress = None;
            self.load_status = None;
            self.examples.progress.clear();
        }
        ctx.request_repaint_after(Duration::from_millis(50));
        response.response.rect
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_progress_handles_unknown_and_incorrect_lengths() {
        let mut p = Progress::new("model".into(), Stage::Download);
        p.update(Update::Download {
            loaded: 1048576,
            total: 0,
        });
        assert_eq!(p.fraction(), 0.);
        assert_eq!(p.bytes_label(), "1.0 MB");
        p.update(Update::Download {
            loaded: 1048576,
            total: 2097152,
        });
        assert_eq!(p.fraction(), 0.5);
        assert_eq!(p.bytes_label(), "1.0 / 2.0 MB");
        p.update(Update::Download {
            loaded: 300,
            total: 100,
        });
        assert_eq!(p.fraction(), 1.);
        p.update(Update::Stage(Stage::Parse));
        p.update(Update::Download {
            loaded: 0,
            total: 0,
        });
        assert_eq!(p.loaded, 300);
        p.update(Update::Stage(Stage::Bvh));
        p.update(Update::Stage(Stage::Parse));
        assert_eq!(p.stage, Stage::Bvh);
    }
}
