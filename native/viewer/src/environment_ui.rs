//! Environment choices mirror the web panel; downloading never replaces live lighting.
use crate::*;

impl Viewer {
    pub(super) fn environment_choices(&mut self, ui: &mut egui::Ui) -> bool {
        ui.add(
            egui::Label::new(egui::RichText::new(&self.environment.name).color(theme::MUTED))
                .truncate(),
        );
        let mut changed = false;
        let mut pick = None;
        let width = (ui.available_width() - 6.) / 2.;
        if self.model.1.available
            && controls::preset_card(
                ui,
                ui.available_width(),
                "Scene lighting",
                "",
                self.environment.model_lighting,
            )
            .clicked()
        {
            self.environments.cancel();
            self.environment = self.model.environment_for_load(&self.environment);
            changed = true;
        }
        for row in environment_browser::presets().chunks(2) {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.;
                for preset in row {
                    let selected = self.environment.preset.as_deref() == Some(preset.id.as_str());
                    let (rect, response) =
                        ui.allocate_exact_size(egui::vec2(width, 64.), egui::Sense::click());
                    let painter = ui.painter_at(rect);
                    painter.rect_filled(rect, 7., theme::CONTROL);
                    if preset.poly_haven {
                        if let Some(texture) = self.environments.thumbnail(&preset.id, ui.ctx()) {
                            painter.image(
                                texture.id(),
                                rect.shrink(1.),
                                egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1., 1.)),
                                egui::Color32::WHITE,
                            );
                        }
                    } else {
                        crate::sun_time::swatch(&painter, rect.shrink(1.));
                    }
                    let caption = egui::Rect::from_min_max(
                        egui::pos2(rect.left() + 1., rect.bottom() - 22.),
                        rect.right_bottom() - egui::vec2(1., 1.),
                    );
                    painter.rect_filled(caption, 0., egui::Color32::from_black_alpha(170));
                    painter.text(
                        caption.left_center() + egui::vec2(7., 0.),
                        egui::Align2::LEFT_CENTER,
                        &preset.name,
                        egui::FontId::proportional(11.),
                        theme::TEXT,
                    );
                    if let Some(active) = self
                        .environments
                        .active
                        .as_ref()
                        .filter(|a| a.preset.as_deref() == Some(&preset.id))
                    {
                        let bar = egui::Rect::from_min_size(
                            rect.left_bottom() - egui::vec2(0., 3.),
                            egui::vec2(rect.width() * active.fraction().max(0.04), 3.),
                        );
                        painter.rect_filled(bar, 1., theme::ACCENT);
                    }
                    painter.rect_stroke(
                        rect,
                        7.,
                        egui::Stroke::new(
                            if selected { 2. } else { 1. },
                            if selected {
                                theme::ACCENT
                            } else if response.hovered() {
                                theme::CONTROL_BORDER_HOVER
                            } else {
                                theme::BORDER
                            },
                        ),
                        egui::StrokeKind::Inside,
                    );
                    #[cfg(test)]
                    ui.ctx().data_mut(|d| {
                        d.insert_temp(egui::Id::new(("environment-preset", &preset.id)), rect)
                    });
                    if response.clicked() {
                        pick = Some(preset);
                    }
                }
            });
            ui.add_space(4.);
        }
        ui.horizontal_wrapped(|ui| {
            if controls::button(ui, "Upload .hdr").clicked() {
                if let Some(path) = rfd::FileDialog::new()
                    .add_filter("Radiance HDR", &["hdr"])
                    .pick_file()
                {
                    self.environments.cancel();
                    match self.environment.load(&path) {
                        Ok(()) => {
                            self.environment.model_lighting = false;
                            changed = true;
                        }
                        Err(e) => self.error = format!("Could not load environment: {e:#}"),
                    }
                }
            }
            if controls::button(ui, "Browse Poly Haven").clicked() {
                self.environments.open = true;
            }
        });
        if let Some(preset) = pick {
            if preset.poly_haven {
                self.environments
                    .load(preset.id.clone(), preset.name.clone(), ui.ctx());
            } else {
                self.environments.cancel();
                self.environment.model_lighting = false;
                self.environment.preset = Some(preset.id.clone());
                self.environment.image = None;
                self.environment.color = [1.; 3];
                self.environment.name = preset.name.clone();
                self.sky.invalidate();
                changed = true;
            }
        }
        if self.environment.preset.as_deref() == Some("sky") {
            crate::sun_time::show(ui, &mut self.sky.time);
        }
        if let Some(active) = &self.environments.active {
            ui.add_space(6.);
            ui.label(egui::RichText::new(format!("Downloading {}", active.name)).small());
            ui.label(
                egui::RichText::new(active.label())
                    .monospace()
                    .small()
                    .color(theme::MUTED),
            );
            ui.add(
                egui::ProgressBar::new(active.fraction().max(0.02))
                    .desired_height(4.)
                    .fill(theme::ACCENT),
            );
            if controls::button(ui, "Cancel download").clicked() {
                self.environments.cancel();
            }
        }
        let current = self.environment.preset.as_deref().and_then(|id| {
            environment_browser::presets()
                .iter()
                .find(|p| p.id == id && p.poly_haven)
        });
        // A resolution change supersedes an in-flight request for the same map.
        let pending = self
            .environments
            .active
            .as_ref()
            .and_then(|a| a.preset.as_deref())
            .and_then(|id| environment_browser::presets().iter().find(|p| p.id == id));
        let reload = pending.or(current);
        if self.environments.active.is_none() && current.is_some() {
            self.environments.resolution = self.environment.resolution;
        }
        let old_resolution = self.environments.resolution;
        ui.add_enabled_ui(reload.is_some(), |ui| {
            controls::segmented(
                ui,
                "Resolution",
                &mut self.environments.resolution,
                &[(0, "1K"), (1, "2K"), (2, "4K")],
            );
        });
        if old_resolution != self.environments.resolution {
            if let Some(preset) = reload {
                self.environments
                    .load(preset.id.clone(), preset.name.clone(), ui.ctx());
            }
        }
        if self.environments.resolution == 2 && reload.is_some() {
            ui.small("4K HDRIs are reduced to the native 4M-pixel limit.");
        }
        ui.hyperlink_to("Poly Haven · CC0", "https://polyhaven.com/hdris");
        if self.model.1.available {
            ui.small("Scene lights stay active with environment or studio lighting.");
        }
        changed
    }
}
