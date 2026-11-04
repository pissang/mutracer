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
                        sky_gradient(&painter, rect.shrink(1.), self.sky.time);
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
            sun_time(ui, &mut self.sky.time);
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
// The diagram uses the same equinox/40° latitude as skyParameters.ts. Keep
// this UI-only calculation off the AOT scene queue during large model loads.
fn sun_elevation(hours: f32) -> f32 {
    (40_f32.to_radians().cos() * (15. * (hours - 12.)).to_radians().cos())
        .asin()
        .to_degrees()
}
fn sky_gradient(painter: &egui::Painter, rect: egui::Rect, hours: f32) {
    let elevation = sun_elevation(hours);
    let stops = [
        (-6., [14, 22, 48], [52, 50, 82]),
        (-1., [34, 52, 96], [196, 116, 98]),
        (3., [52, 86, 148], [238, 160, 104]),
        (10., [58, 104, 178], [236, 200, 160]),
        (25., [56, 108, 194], [176, 204, 232]),
        (90., [44, 98, 192], [168, 198, 232]),
    ];
    let i = (0..stops.len() - 2)
        .find(|&i| elevation <= stops[i + 1].0)
        .unwrap_or(stops.len() - 2);
    let t = ((elevation - stops[i].0) / (stops[i + 1].0 - stops[i].0)).clamp(0., 1.);
    let mix = |a: [u8; 3], b: [u8; 3], t: f32| {
        egui::Color32::from_rgb(
            (a[0] as f32 + (b[0] as f32 - a[0] as f32) * t).round() as u8,
            (a[1] as f32 + (b[1] as f32 - a[1] as f32) * t).round() as u8,
            (a[2] as f32 + (b[2] as f32 - a[2] as f32) * t).round() as u8,
        )
    };
    let top = mix(stops[i].1, stops[i + 1].1, t);
    let bottom = mix(stops[i].2, stops[i + 1].2, t);
    let horizon = rect.top() + rect.height() * 0.73;
    let mut mesh = egui::Mesh::default();
    for (pos, color) in [
        (rect.left_top(), top),
        (rect.right_top(), top),
        (egui::pos2(rect.left(), horizon), bottom),
        (egui::pos2(rect.right(), horizon), bottom),
    ] {
        mesh.colored_vertex(pos, color);
    }
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(1, 3, 2);
    painter.add(egui::Shape::mesh(mesh));
    painter.rect_filled(
        egui::Rect::from_min_max(egui::pos2(rect.left(), horizon), rect.right_bottom()),
        0.,
        egui::Color32::from_rgb(0x35, 0x2f, 0x29),
    );
}
fn sun_time(ui: &mut egui::Ui, hours: &mut f32) {
    let (rect, mut response) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), 104.),
        egui::Sense::click_and_drag(),
    );
    let before = *hours;
    if response.clicked() || response.dragged() {
        if let Some(pos) = response.interact_pointer_pos() {
            *hours = (5.5 + ((pos.x - rect.left()) / rect.width()).clamp(0., 1.) * 13.) * 12.;
            *hours = hours.round() / 12.;
        }
        response.request_focus();
    }
    if response.double_clicked() {
        *hours = 15.;
    }
    if response.has_focus() {
        ui.input(|i| {
            let step = if i.modifiers.shift { 1. } else { 0.25 };
            if i.key_pressed(egui::Key::ArrowRight) || i.key_pressed(egui::Key::ArrowUp) {
                *hours += step;
            }
            if i.key_pressed(egui::Key::ArrowLeft) || i.key_pressed(egui::Key::ArrowDown) {
                *hours -= step;
            }
            if i.key_pressed(egui::Key::Home) {
                *hours = 5.5;
            }
            if i.key_pressed(egui::Key::End) {
                *hours = 18.5;
            }
        });
    }
    *hours = hours.clamp(5.5, 18.5);
    if *hours != before {
        response.mark_changed();
    }
    response.on_hover_text("Drag to set the time of day; double-click to reset");
    let painter = ui.painter_at(rect);
    sky_gradient(&painter, rect, *hours);
    let peak = sun_elevation(12.);
    let horizon = rect.top() + 76.;
    let point = |hours| {
        egui::pos2(
            rect.left() + (hours - 5.5) / 13. * rect.width(),
            horizon - sun_elevation(hours) / peak * 62.,
        )
    };
    static ELEVATIONS: std::sync::OnceLock<[f32; 65]> = std::sync::OnceLock::new();
    let elevations = ELEVATIONS
        .get_or_init(|| std::array::from_fn(|i| sun_elevation(5.5 + 13. * i as f32 / 64.)));
    let path = elevations
        .iter()
        .enumerate()
        .map(|(i, elevation)| {
            egui::pos2(
                rect.left() + i as f32 / 64. * rect.width(),
                horizon - elevation / peak * 62.,
            )
        })
        .collect();
    painter
        .with_clip_rect(egui::Rect::from_min_max(
            rect.min,
            egui::pos2(rect.right(), horizon),
        ))
        .add(egui::Shape::line(
            path,
            egui::Stroke::new(1., egui::Color32::from_white_alpha(90)),
        ));
    let sun = point(*hours);
    painter.circle_filled(
        sun,
        14.,
        egui::Color32::from_rgba_unmultiplied(255, 210, 150, 35),
    );
    painter.circle_filled(sun, 6.5, egui::Color32::from_rgb(255, 241, 218));
    for hour in [6., 12., 18.] {
        painter.text(
            egui::pos2(point(hour).x, rect.bottom() - 9.),
            if hour == 6. {
                egui::Align2::LEFT_CENTER
            } else if hour == 18. {
                egui::Align2::RIGHT_CENTER
            } else {
                egui::Align2::CENTER_CENTER
            },
            format!("{hour:.0}:00"),
            egui::FontId::monospace(10.),
            theme::MUTED,
        );
    }
    let minutes = (*hours * 60.).round() as u32;
    painter.text(
        rect.right_top() + egui::vec2(-8., 8.),
        egui::Align2::RIGHT_TOP,
        format!("{}:{:02}", minutes / 60, minutes % 60),
        egui::FontId::monospace(12.),
        egui::Color32::WHITE,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagram_elevation_matches_the_shared_sky() {
        for hours in [5.5, 6., 9., 12., 15., 18., 18.5] {
            let shared = mutracer_native_probe::viewer_math::sun_position(hours)[0];
            assert!(
                (sun_elevation(hours) - shared).abs() < 0.00002,
                "Solar elevation at {hours}"
            );
        }
    }
}
