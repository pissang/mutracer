//! Viewport render dock, sharing the inspector's settings and native commit path.
use crate::{Change, Viewer, resolution, theme};
use eframe::egui::{self, Align2, Color32, FontId, Sense, Stroke};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
enum Action {
    Pause,
    Play,
    Focus,
    Fit,
    PickFocus,
    Settings,
}
fn action(ui: &mut egui::Ui, label: &str, icon: Action) -> egui::Response {
    let response = ui.add_sized(
        [28., 28.],
        egui::Button::new("").frame(false).corner_radius(7),
    );
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, ui.is_enabled(), label)
    });
    let c = response.rect.center();
    let p = ui.painter();
    let stroke = Stroke::new(1.3, theme::MUTED);
    match icon {
        Action::Pause => {
            for x in [-2.5, 2.5] {
                p.line_segment(
                    [c + egui::vec2(x, -5.), c + egui::vec2(x, 5.)],
                    Stroke::new(2.2, theme::MUTED),
                );
            }
        }
        Action::Play => {
            p.add(egui::Shape::convex_polygon(
                vec![
                    c + egui::vec2(-3., -5.),
                    c + egui::vec2(5., 0.),
                    c + egui::vec2(-3., 5.),
                ],
                theme::MUTED,
                Stroke::NONE,
            ));
        }
        Action::Focus | Action::Fit => {
            for (x, y) in [(-1., -1.), (1., -1.), (-1., 1.), (1., 1.)] {
                p.add(egui::Shape::line(
                    vec![
                        c + egui::vec2(x * 3., y * 6.),
                        c + egui::vec2(x * 6., y * 6.),
                        c + egui::vec2(x * 6., y * 3.),
                    ],
                    stroke,
                ));
            }
        }
        Action::PickFocus => {
            p.circle_stroke(c, 4., stroke);
            for v in [
                egui::vec2(1., 0.),
                egui::vec2(-1., 0.),
                egui::vec2(0., 1.),
                egui::vec2(0., -1.),
            ] {
                p.line_segment([c + v * 2., c + v * 7.], stroke);
            }
        }
        Action::Settings => {
            for (y, x) in [(-4., -2.), (0., 3.), (4., -1.)] {
                p.line_segment([c + egui::vec2(-6., y), c + egui::vec2(6., y)], stroke);
                p.circle_filled(c + egui::vec2(x, y), 2., theme::SUBTLE);
            }
        }
    }
    response.on_hover_text(label)
}
fn toggle(ui: &mut egui::Ui, value: &mut bool, label: &str) -> egui::Response {
    ui.scope(|ui| {
        let widgets = &mut ui.visuals_mut().widgets;
        for widget in [
            &mut widgets.inactive,
            &mut widgets.hovered,
            &mut widgets.active,
        ] {
            widget.corner_radius = 3.into();
            widget.bg_stroke = Stroke::new(1., theme::SUBTLE);
        }
        ui.checkbox(value, label)
    })
    .inner
}

fn floating_frame() -> egui::Frame {
    egui::Frame::new()
        .fill(Color32::from_rgba_unmultiplied(26, 27, 31, 219))
        .corner_radius(16)
        .shadow(egui::epaint::Shadow {
            offset: [0, 6],
            blur: 20,
            spread: 0,
            color: Color32::from_black_alpha(55),
        })
        .inner_margin(egui::Margin::symmetric(8, 7))
}

impl Viewer {
    pub(super) fn toggle_animation_or_render(&mut self) {
        if let Some(animation) = &mut self.model.0.animation {
            animation.toggle();
            self.animation_clock = Instant::now();
            if animation.playing {
                self.running = true;
            }
        } else {
            self.running = !self.running;
        }
    }
    pub(super) fn update_resolution(&mut self, ctx: &egui::Context, viewport: egui::Vec2) {
        if let Some(size) = self.resolution.update(
            viewport,
            ctx.pixels_per_point(),
            self.size,
            ctx.input(|i| i.pointer.any_down()),
            Instant::now(),
        ) {
            self.size = size;
            self.dirty(Change::Scene);
        }
        if self.resolution.pending(self.size) {
            ctx.request_repaint_after(Duration::from_millis(16));
        }
    }
    pub(super) fn resolution_label(&self) -> String {
        match self.resolution.scale {
            Some(scale) => format!("{:.0}% · {} × {}", scale * 100., self.size[0], self.size[1]),
            None => match resolution::fixed_name(self.size) {
                Some(name) => format!("{name} · {} × {}", self.size[0], self.size[1]),
                None => format!("{} × {}", self.size[0], self.size[1]),
            },
        }
    }
    pub(super) fn resolution_choices(&mut self, ui: &mut egui::Ui) {
        for scale in [0.25, 0.5, 0.75, 1.] {
            let size = self.resolution.scaled(scale);
            ui.selectable_value(
                &mut self.resolution.scale,
                Some(scale),
                format!("{:.0}% · {} × {}", scale * 100., size[0], size[1]),
            );
        }
        ui.separator();
        ui.weak("Fixed pixels");
        for (name, size) in resolution::FIXED {
            if ui
                .selectable_label(
                    self.resolution.scale.is_none() && self.size == size,
                    format!("{name} · {} × {}", size[0], size[1]),
                )
                .clicked()
            {
                self.resolution.scale = None;
                if self.size != size {
                    self.size = size;
                    self.dirty(Change::Scene);
                }
            }
        }
    }
    pub(super) fn render_dock(&mut self, ctx: &egui::Context, viewport: egui::Rect) -> egui::Rect {
        let available = (viewport.width() - 24.).max(1.);
        let tiny = available < 220.;
        let camera_width: f32 = if self.model.1.cameras.is_empty() {
            44.
        } else {
            168.
        };
        let focus_width = if self.camera.f_stop > 0. && !self.camera.orthographic {
            44.
        } else {
            0.
        };
        let inline_width = if self.denoise { 560. } else { 420. } + focus_width;
        let inline = available >= inline_width + camera_width + 8.;
        let stacked = !tiny && !inline && available < 260. + camera_width + 8.;
        let width = if tiny {
            available.min(180.)
        } else if inline {
            inline_width
        } else {
            available.min(260.)
        };
        let camera_width = camera_width.min(available);
        let total_width = if tiny {
            width
        } else if stacked {
            width.max(camera_width)
        } else {
            width + camera_width + 8.
        };
        let height = if tiny {
            46.
        } else if inline {
            46.
        } else {
            80.
        } + if stacked { 54. } else { 0. }
            + if !tiny && self.model.0.animation.is_some() {
                72.
            } else {
                0.
            };
        let offset =
            viewport.center_bottom() - ctx.content_rect().center_bottom() - egui::vec2(0., 12.);
        egui::Area::new(egui::Id::new("render-dock"))
            .order(egui::Order::Foreground)
            .movable(false)
            .constrain(false)
            .default_size(egui::vec2(total_width, height))
            .anchor(Align2::CENTER_BOTTOM, offset)
            .show(ctx, |ui| {
                ui.set_width(total_width);
                ui.spacing_mut().item_spacing = egui::vec2(8., 8.);
                if tiny {
                    self.dock_main(ui, width, false, true);
                } else if stacked {
                    ui.vertical_centered(|ui| {
                        self.dock_main(ui, width, false, false);
                        floating_frame().show(ui, |ui| {
                            ui.set_width(camera_width - 16.);
                            self.dock_camera(ui);
                        });
                    });
                } else {
                    ui.horizontal(|ui| {
                        self.dock_main(ui, width, inline, false);
                        floating_frame().show(ui, |ui| {
                            ui.set_width(camera_width - 16.);
                            self.dock_camera(ui);
                        });
                    });
                }
            })
            .response
            .rect
    }
    fn dock_main(&mut self, ui: &mut egui::Ui, width: f32, inline: bool, tiny: bool) {
        floating_frame().show(ui, |ui| {
            ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                ui.set_width((width - 16.).max(1.));
                ui.spacing_mut().item_spacing = egui::vec2(4., 4.);
                ui.spacing_mut().interact_size.y = 28.;
                ui.spacing_mut().button_padding = egui::vec2(5., 2.);
                ui.spacing_mut().icon_width = 13.;
                let widgets = &mut ui.visuals_mut().widgets;
                for widget in [&mut widgets.inactive, &mut widgets.hovered] {
                    widget.corner_radius = 9.into();
                    widget.bg_stroke = Stroke::NONE;
                }
                ui.visuals_mut().widgets.inactive.bg_fill = Color32::TRANSPARENT;
                ui.visuals_mut().widgets.inactive.weak_bg_fill = Color32::TRANSPARENT;
                if tiny {
                    ui.horizontal(|ui| {
                        self.dock_status(ui, true);
                        self.dock_options(ui, true);
                    });
                } else if inline {
                    ui.horizontal(|ui| {
                        self.dock_status(ui, false);
                        ui.separator();
                        self.dock_settings(ui, false);
                    });
                } else {
                    ui.horizontal(|ui| self.dock_status(ui, false));
                    ui.horizontal(|ui| self.dock_settings(ui, true));
                }
                if !tiny && self.model.0.animation.is_some() {
                    ui.separator();
                    self.animation_controls(ui);
                }
            });
        });
    }
    fn dock_camera(&mut self, ui: &mut egui::Ui) {
        ui.spacing_mut().interact_size.y = 28.;
        ui.spacing_mut().button_padding = egui::vec2(5., 2.);
        ui.visuals_mut().widgets.inactive.bg_fill = Color32::TRANSPARENT;
        ui.visuals_mut().widgets.inactive.weak_bg_fill = Color32::TRANSPARENT;
        ui.visuals_mut().widgets.inactive.bg_stroke = Stroke::NONE;
        ui.horizontal(|ui| {
            if !self.model.1.cameras.is_empty() {
                let previous = self.camera_index;
                let selector_width = (ui.available_width() - 32.).max(40.);
                ui.allocate_ui_with_layout(
                    egui::vec2(selector_width, 28.),
                    egui::Layout::left_to_right(egui::Align::Center),
                    |ui| {
                        egui::ComboBox::from_id_salt("viewport-camera")
                            .width(selector_width)
                            .wrap_mode(egui::TextWrapMode::Truncate)
                            .selected_text(
                                self.camera_index
                                    .and_then(|i| self.model.1.cameras.get(i))
                                    .map_or("Orbit", |c| c.name.as_str()),
                            )
                            .show_ui(ui, |ui| {
                                ui.selectable_value(&mut self.camera_index, None, "Orbit");
                                for (i, view) in self.model.1.cameras.iter().enumerate() {
                                    ui.selectable_value(
                                        &mut self.camera_index,
                                        Some(i),
                                        &view.name,
                                    );
                                }
                            });
                    },
                );
                if previous != self.camera_index {
                    if let Some(i) = self.camera_index {
                        self.model.1.cameras[i].apply(&mut self.camera, self.model.center);
                    }
                    self.dirty(Change::Camera);
                }
            }

            let fit = action(ui, "Fit to model (F)", Action::Fit);
            if fit.clicked() {
                self.camera.frame(self.model.center, self.model.radius);
                self.camera_index = None;
                self.dirty(Change::Camera);
            }
            if let Some(id) = self.selected_mesh {
                fit.context_menu(|ui| {
                    if ui.button("Frame selection").clicked() {
                        let (min, max) = self.model.mesh_bounds(id);
                        self.camera
                            .frame((min + max) * 0.5, (max - min).length() * 0.5);
                        self.camera_index = None;
                        self.dirty(Change::Camera);
                        ui.close();
                    }
                });
            }
        });
    }
    fn animation_controls(&mut self, ui: &mut egui::Ui) {
        let enabled = self.loading.is_none()
            && self.candidate.is_none()
            && self.pending_model.is_none()
            && !self
                .scene_build
                .as_ref()
                .is_some_and(|(_, candidate, _)| candidate.is_some());
        ui.add_enabled_ui(enabled, |ui| {
            let animation = self.model.0.animation.as_mut().unwrap();
            ui.horizontal(|ui| {
                if action(
                    ui,
                    if animation.playing {
                        "Pause animation (Space)"
                    } else {
                        "Play animation (Space)"
                    },
                    if animation.playing {
                        Action::Pause
                    } else {
                        Action::Play
                    },
                )
                .clicked()
                {
                    animation.toggle();
                    self.animation_clock = Instant::now();
                    if animation.playing {
                        self.running = true;
                    }
                }
                let mut time = animation.time;
                let duration = animation.duration();
                ui.spacing_mut().slider_width = (ui.available_width() - 120.).max(32.);
                if ui
                    .add(
                        egui::Slider::new(&mut time, 0.0..=duration)
                            .show_value(false)
                            .step_by(0.001),
                    )
                    .on_hover_text("Animation time")
                    .changed()
                {
                    animation.seek(time);
                    self.animation_clock = Instant::now();
                }
                ui.monospace(format!("{:.2} / {:.2} s", animation.time, duration));
            });
            ui.horizontal(|ui| {
                let previous = animation.clip;
                if animation.clips().len() > 1 {
                    let mut clip = previous;
                    let clip_width = (ui.available_width() - 126.).clamp(60., 220.);
                    ui.allocate_ui_with_layout(
                        egui::vec2(clip_width, 28.),
                        egui::Layout::left_to_right(egui::Align::Center),
                        |ui| {
                            egui::ComboBox::from_id_salt("animation-clip")
                                .width(clip_width)
                                .truncate()
                                .selected_text(&animation.clips()[clip].name)
                                .show_ui(ui, |ui| {
                                    for (id, option) in animation.clips().iter().enumerate() {
                                        ui.selectable_value(&mut clip, id, &option.name);
                                    }
                                })
                                .response
                                .on_hover_text("Animation clip");
                        },
                    );
                    if clip != previous {
                        animation.select(clip);
                        self.animation_clock = Instant::now();
                    }
                } else {
                    ui.add_sized(
                        [(ui.available_width() - 126.).max(1.), 28.],
                        egui::Label::new(&animation.clips()[previous].name).truncate(),
                    );
                }
                egui::ComboBox::from_id_salt("animation-speed")
                    .width(52.)
                    .selected_text(format!("{}×", animation.speed))
                    .show_ui(ui, |ui| {
                        for speed in [0.25, 0.5, 1., 2.] {
                            ui.selectable_value(&mut animation.speed, speed, format!("{speed}×"));
                        }
                    })
                    .response
                    .on_hover_text("Playback speed");
                ui.toggle_value(&mut animation.looping, "Loop");
            });
        });
    }
    fn dock_focus(&mut self, ui: &mut egui::Ui) {
        if self.camera.f_stop > 0. && !self.camera.orthographic {
            if self.focus.enabled {
                let response = action(
                    ui,
                    if self.focus.show_frame {
                        "Hide focus frame"
                    } else {
                        "Show focus frame"
                    },
                    Action::Focus,
                );
                if !self.focus.show_frame {
                    let c = response.rect.center();
                    ui.painter().line_segment(
                        [c - egui::vec2(6., 6.), c + egui::vec2(6., 6.)],
                        Stroke::new(1.2, theme::MUTED),
                    );
                }
                if response.clicked() {
                    self.focus.show_frame = !self.focus.show_frame;
                }
            } else if action(ui, "Pick focus point", Action::PickFocus).clicked() {
                self.picking_focus = !self.picking_focus;
            }
            ui.separator();
        }
    }
    fn dock_status(&mut self, ui: &mut egui::Ui, tiny: bool) {
        if !tiny {
            self.dock_focus(ui);
        }
        let preparing = self.loading.is_some() || self.preparing() || self.candidate.is_some();
        let animating = self.running && self.model.0.animation.as_ref().is_some_and(|a| a.playing);
        let status = self.target.render_loop.status();
        let done = !animating && !preparing && status == crate::api::RenderLoopStatus::Finished;
        let spinning = preparing
            || self.frame_preview
            || matches!(
                status,
                crate::api::RenderLoopStatus::Compiling | crate::api::RenderLoopStatus::Denoising
            );
        let label = if !self.error.is_empty() || status == crate::api::RenderLoopStatus::Error {
            "Error"
        } else if self.loading.is_some() {
            "Opening"
        } else if preparing {
            "Preparing"
        } else if !self.running {
            "Paused"
        } else if animating {
            "Playing"
        } else if status == crate::api::RenderLoopStatus::Denoising {
            "Denoising"
        } else if status == crate::api::RenderLoopStatus::Compiling {
            "Compiling"
        } else if done {
            "Done"
        } else if self.frame_preview {
            "Preview"
        } else if status == crate::api::RenderLoopStatus::Idle {
            "Starting"
        } else {
            "Converging"
        };
        let (rect, response) = ui.allocate_exact_size(egui::vec2(26., 28.), Sense::click());
        response.context_menu(|ui| {
            if ui.button("Restart rendering").clicked() {
                self.dirty(Change::Reset);
                ui.close();
            }
        });
        let progress = self.samples as f32 / self.output_target_samples().max(1) as f32;
        response.widget_info(|| {
            egui::WidgetInfo::slider(true, progress as f64 * 100., "Sample progress")
        });
        ui.painter().circle_stroke(
            rect.center(),
            10.,
            Stroke::new(2., Color32::from_white_alpha(25)),
        );
        let color = if done {
            Color32::from_rgb(114, 198, 156)
        } else {
            theme::ACCENT
        };
        let (start, amount) = if spinning {
            (ui.input(|i| i.time as f32 * 4.), 0.28)
        } else {
            (-std::f32::consts::FRAC_PI_2, progress.clamp(0., 1.))
        };
        let points = (0..=32)
            .map(|i| {
                rect.center()
                    + egui::Vec2::angled(start + std::f32::consts::TAU * amount * i as f32 / 32.)
                        * 10.
            })
            .collect();
        ui.painter()
            .add(egui::Shape::line(points, Stroke::new(2., color)));
        if done {
            ui.painter().add(egui::Shape::line(
                vec![
                    rect.center() + egui::vec2(-4., 0.),
                    rect.center() + egui::vec2(-1., 3.),
                    rect.center() + egui::vec2(5., -4.),
                ],
                Stroke::new(1.8, color),
            ));
        }
        if spinning {
            ui.ctx().request_repaint_after(Duration::from_millis(32));
        }
        response.on_hover_text(format!("{label} · {} spp", self.samples));
        if tiny {
            return;
        }
        let (rect, _) = ui.allocate_exact_size(egui::vec2(72., 30.), Sense::hover());
        ui.painter().text(
            rect.left_top(),
            Align2::LEFT_TOP,
            label,
            FontId::proportional(theme::FONT_LABEL),
            theme::TEXT,
        );
        ui.painter().text(
            rect.left_bottom(),
            Align2::LEFT_BOTTOM,
            format!("{} spp", self.samples),
            FontId::monospace(theme::FONT_SMALL),
            theme::SUBTLE,
        );
        if (!done || !self.running)
            && action(
                ui,
                if self.running {
                    if self.model.0.animation.is_some() {
                        "Pause rendering"
                    } else {
                        "Pause rendering (Space)"
                    }
                } else {
                    if self.model.0.animation.is_some() {
                        "Resume rendering"
                    } else {
                        "Resume rendering (Space)"
                    }
                },
                if self.running {
                    Action::Pause
                } else {
                    Action::Play
                },
            )
            .clicked()
        {
            self.running = !self.running;
        }
    }
    fn dock_settings(&mut self, ui: &mut egui::Ui, compact: bool) {
        let previous = self.settings.max_samples;
        egui::ComboBox::from_id_salt("dock-samples")
            .width(if compact { 58. } else { 88. })
            .selected_text(if compact {
                previous.to_string()
            } else {
                format!("Samples {}", previous)
            })
            .show_ui(ui, |ui| {
                for value in [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096] {
                    ui.selectable_value(&mut self.settings.max_samples, value, value.to_string());
                }
            });
        if previous != self.settings.max_samples {
            self.dirty(Change::Scene);
        }
        let label = self.resolution.scale.map_or_else(
            || {
                resolution::fixed_name(self.size).map_or_else(
                    || format!("{}×{}", self.size[0], self.size[1]),
                    str::to_string,
                )
            },
            |s| {
                if compact {
                    format!("{:.0}%", s * 100.)
                } else {
                    format!("Res {:.0}%", s * 100.)
                }
            },
        );
        egui::ComboBox::from_id_salt("dock-resolution")
            .height(320.)
            .wrap_mode(egui::TextWrapMode::Truncate)
            .width(76.)
            .selected_text(label)
            .show_ui(ui, |ui| self.resolution_choices(ui))
            .response
            .on_hover_text(self.resolution_label());
        if compact {
            self.dock_options(ui, false);
        } else {
            self.dock_denoise(ui);
        }
    }
    fn dock_options(&mut self, ui: &mut egui::Ui, all: bool) {
        let response = action(ui, "Render settings", Action::Settings);
        #[cfg(test)]
        ui.ctx()
            .data_mut(|data| data.insert_temp(egui::Id::new("dock-options-rect"), response.rect));
        egui::Popup::menu(&response).show(|ui| {
            ui.set_width(260.);
            if all {
                self.dock_settings(ui, false);
                ui.separator();
                if ui
                    .button(if self.running {
                        "Pause rendering"
                    } else {
                        "Resume rendering"
                    })
                    .clicked()
                {
                    self.running = !self.running;
                }
                ui.horizontal(|ui| self.dock_focus(ui));
                self.dock_camera(ui);
                if self.model.0.animation.is_some() {
                    ui.separator();
                    self.animation_controls(ui);
                }
            } else {
                self.dock_denoise(ui);
            }
            ui.separator();
            if ui.button("All render settings…").clicked() {
                self.tab = 0;
                self.inspector_open = true;
                ui.close();
            }
        });
    }
    fn dock_denoise(&mut self, ui: &mut egui::Ui) {
        toggle(ui, &mut self.denoise, "Denoise").on_hover_text(&self.denoise_status);
        if self.denoise {
            egui::ComboBox::from_id_salt("dock-denoiser")
                .width(64.)
                .selected_text(self.denoiser_choice.label())
                .show_ui(ui, |ui| {
                    ui.selectable_value(
                        &mut self.denoiser_choice,
                        crate::denoiser::Choice::Oidn,
                        "OIDN",
                    );
                    ui.selectable_value(
                        &mut self.denoiser_choice,
                        crate::denoiser::Choice::Jnlm,
                        "JNLM",
                    );
                    ui.add_enabled_ui(self.custom_denoiser.is_some(), |ui| {
                        ui.selectable_value(
                            &mut self.denoiser_choice,
                            crate::denoiser::Choice::Dlss,
                            "DLSS RR",
                        );
                    });
                })
                .response
                .on_hover_text("Denoiser type");
            if self.denoiser_choice != crate::denoiser::Choice::Dlss {
                toggle(ui, &mut self.live_denoise, "Live")
                    .on_hover_text("Denoise while converging, not only the final image");
            }
        }
    }
}
