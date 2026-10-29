//! Native window chrome and shared Web branding.
use crate::{Change, Viewer, theme};
use eframe::egui::{self, Color32, Sense, Stroke};
use std::sync::OnceLock;

fn logo_image() -> &'static egui::ColorImage {
    static IMAGE: OnceLock<egui::ColorImage> = OnceLock::new();
    IMAGE.get_or_init(|| {
        let image =
            image::load_from_memory(include_bytes!("../../../site/src/assets/mutracer-logo.png"))
                .expect("MuTracer logo")
                .into_rgba8();
        egui::ColorImage::from_rgba_unmultiplied(
            [image.width() as usize, image.height() as usize],
            image.as_raw(),
        )
    })
}
pub fn icon() -> egui::IconData {
    #[cfg(target_os = "macos")]
    {
        // Let AppKit use the bundle's icon, including system appearance variants.
        // eframe treats an empty IconData as a request to keep the OS icon.
        if crate::bundled_asset("MuTracer.icns", std::path::PathBuf::new()).is_file() {
            return egui::IconData::default();
        }
        let image = image::load_from_memory(include_bytes!("../assets/macos-icon.png"))
            .expect("MuTracer macOS icon")
            .into_rgba8();
        egui::IconData {
            width: image.width(),
            height: image.height(),
            rgba: image.into_raw(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let image = logo_image();
        egui::IconData {
            rgba: image.pixels.iter().flat_map(|p| p.to_array()).collect(),
            width: image.size[0] as u32,
            height: image.size[1] as u32,
        }
    }
}
fn logo(ctx: &egui::Context) -> egui::TextureHandle {
    let id = egui::Id::new("brand-logo");
    if let Some(image) = ctx.data(|data| data.get_temp::<egui::TextureHandle>(id)) {
        return image;
    }
    let image = ctx.load_texture(
        "MuTracer logo",
        logo_image().clone(),
        egui::TextureOptions::LINEAR,
    );
    ctx.data_mut(|data| data.insert_temp(id, image.clone()));
    image
}
fn zoom(ctx: &egui::Context) {
    ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(
        !ctx.input(|i| i.viewport().maximized.unwrap_or(false)),
    ));
}
fn panel_button(ui: &mut egui::Ui, label: &str, right: bool, open: &mut bool) {
    let response = ui.add_sized(
        [28., 28.],
        egui::Button::new("").frame(false).fill(if *open {
            theme::ACCENT_SURFACE
        } else {
            Color32::TRANSPARENT
        }),
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(egui::WidgetType::Checkbox, ui.is_enabled(), *open, label)
    });
    let rect = egui::Rect::from_center_size(response.rect.center(), egui::vec2(15., 13.));
    let stroke = Stroke::new(1.2, if *open { theme::ACCENT } else { theme::MUTED });
    ui.painter()
        .rect_stroke(rect, 2, stroke, egui::StrokeKind::Inside);
    let x = if right {
        rect.right() - 5.
    } else {
        rect.left() + 5.
    };
    ui.painter().line_segment(
        [egui::pos2(x, rect.top()), egui::pos2(x, rect.bottom())],
        stroke,
    );
    if response.on_hover_text(label).clicked() {
        *open = !*open;
    }
}
fn utility_button(ui: &mut egui::Ui, label: &str, reset: bool) -> egui::Response {
    let response = ui.add_sized([26., 26.], egui::Button::new("").frame(false));
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, ui.is_enabled(), label)
    });
    let c = response.rect.center();
    let stroke = Stroke::new(1.2, theme::MUTED);
    if reset {
        let points = (0..=24)
            .map(|i| c + egui::Vec2::angled(-2.5 + i as f32 * 5.5 / 24.) * 6.)
            .collect();
        ui.painter().add(egui::Shape::line(points, stroke));
        ui.painter().add(egui::Shape::line(
            vec![
                c + egui::vec2(-6., -7.),
                c + egui::vec2(-6., -2.),
                c + egui::vec2(-1., -2.),
            ],
            stroke,
        ));
    } else {
        ui.painter().circle_stroke(c, 6.5, stroke);
        ui.painter().text(
            c - egui::vec2(0., 0.5),
            egui::Align2::CENTER_CENTER,
            "?",
            egui::FontId::proportional(11.),
            theme::MUTED,
        );
    }
    response.on_hover_text(label)
}

fn code_button(ui: &mut egui::Ui) -> egui::Response {
    let response = ui.add_sized([68., 28.], egui::Button::new("").corner_radius(8));
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, ui.is_enabled(), "Code")
    });
    let c = response.rect.left_center() + egui::vec2(16., 0.);
    let stroke = Stroke::new(1.2, theme::TEXT);
    for direction in [-1., 1.] {
        ui.painter().add(egui::Shape::line(
            vec![
                c + egui::vec2(direction * 3., -4.),
                c + egui::vec2(direction * 7., 0.),
                c + egui::vec2(direction * 3., 4.),
            ],
            stroke,
        ));
    }
    ui.painter().text(
        response.rect.center() + egui::vec2(9., 0.),
        egui::Align2::CENTER_CENTER,
        "Code",
        egui::FontId::proportional(theme::FONT_LABEL),
        theme::TEXT,
    );
    response.on_hover_text("Render setup in Rust")
}

fn header_button(ui: &mut egui::Ui, label: &str, export: bool, sample: bool) -> egui::Response {
    let response = ui.add_sized(
        [if export { 86. } else { 96. }, 28.],
        egui::Button::new("").corner_radius(8).fill(if export {
            theme::ACCENT_SOLID
        } else {
            theme::CONTROL
        }),
    );
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, ui.is_enabled(), label)
    });
    let c = response.rect.left_center() + egui::vec2(17., 0.);
    let p = ui.painter();
    let stroke = Stroke::new(1.2, theme::TEXT);
    if sample {
        crate::controls::paint_icon(ui, c, crate::controls::Icon::Examples, theme::TEXT);
    } else {
        let sign = if export { 1. } else { -1. };
        p.line_segment([c + egui::vec2(0., -5.), c + egui::vec2(0., 5.)], stroke);
        p.add(egui::Shape::line(
            vec![
                c + egui::vec2(-3., 2. * sign),
                c + egui::vec2(0., 5. * sign),
                c + egui::vec2(3., 2. * sign),
            ],
            stroke,
        ));
        p.line_segment([c + egui::vec2(-6., 6.), c + egui::vec2(-6., 3.)], stroke);
        p.line_segment([c + egui::vec2(-6., 6.), c + egui::vec2(6., 6.)], stroke);
        p.line_segment([c + egui::vec2(6., 6.), c + egui::vec2(6., 3.)], stroke);
    }
    p.text(
        c + egui::vec2(13., 0.),
        egui::Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(theme::FONT_LABEL),
        theme::TEXT,
    );
    response
}

fn history_button(ui: &mut egui::Ui, redo: bool) -> egui::Response {
    let response = ui.add_sized([28., 28.], egui::Button::new("").frame(false));
    let c = response.rect.center();
    let sign = if redo { 1. } else { -1. };
    let color = if ui.is_enabled() {
        theme::MUTED
    } else {
        theme::SUBTLE
    };
    let stroke = Stroke::new(1.2, color);
    let points = (0..20)
        .map(|i| {
            let t = i as f32 / 19. * 4.4 - 2.2;
            c + egui::vec2(t.cos() * 5. * sign, t.sin() * 5.)
        })
        .collect();
    ui.painter().add(egui::Shape::line(points, stroke));
    ui.painter().add(egui::Shape::line(
        vec![
            c + egui::vec2(-6. * sign, -1.),
            c + egui::vec2(-3. * sign, -5.),
            c + egui::vec2(1. * sign, -2.),
        ],
        stroke,
    ));
    response.widget_info(|| {
        egui::WidgetInfo::labeled(
            egui::WidgetType::Button,
            ui.is_enabled(),
            if redo { "Redo" } else { "Undo" },
        )
    });
    response
}
impl Viewer {
    pub(super) fn titlebar(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        egui::Panel::top("toolbar")
            .exact_size(48.)
            .resizable(false)
            .show_separator_line(false)
            .frame(
                egui::Frame::new()
                    .fill(Color32::from_rgb(0x14, 0x15, 0x17))
                    .inner_margin(egui::Margin::symmetric(12, 6)),
            )
            .show(root, |ui| {
                let rect = ui.max_rect();
                let drag = ui.interact(rect, ui.id().with("window-drag"), Sense::click_and_drag());
                if drag.double_clicked() {
                    zoom(&ctx);
                } else if drag.drag_started() {
                    ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag);
                }
                let compact = rect.width() < 1000.;
                ui.scope_builder(egui::UiBuilder::new().max_rect(rect), |ui| {
                    ui.horizontal_centered(|ui| {
                        ui.spacing_mut().interact_size.y = 28.;
                        ui.spacing_mut().item_spacing.x = 2.;
                        // AppKit owns the traffic lights and rounded window frame.
                        #[cfg(target_os = "macos")]
                        ui.add_space(72.);
                        ui.add_space(12.);
                        ui.add(
                            egui::Image::from_texture(&logo(&ctx))
                                .fit_to_exact_size(egui::vec2(26., 26.))
                                .corner_radius(9),
                        );
                        ui.add_space(8.);
                        ui.label(
                            egui::RichText::new(if compact {
                                "MuTracer"
                            } else {
                                "MuTracer Viewer"
                            })
                            .size(12.)
                            .strong(),
                        );
                        ui.add_space(8.);
                        panel_button(ui, "Toggle scene panel ([)", false, &mut self.scene_open);
                    });
                });
                let center = egui::Rect::from_center_size(rect.center(), egui::vec2(200., 28.));
                ui.scope_builder(egui::UiBuilder::new().max_rect(center), |ui| {
                    ui.horizontal_centered(|ui| {
                        ui.spacing_mut().item_spacing.x = 8.;
                        let open = header_button(ui, "Open", false, false);
                        let c = open.rect.right_center() - egui::vec2(12., 0.);
                        ui.painter().add(egui::Shape::line(
                            vec![
                                c + egui::vec2(-3., -1.5),
                                c + egui::vec2(0., 1.5),
                                c + egui::vec2(3., -1.5),
                            ],
                            Stroke::new(1.2, theme::MUTED),
                        ));
                        egui::Popup::menu(&open).show(|ui| {
                            if ui.button("Open files…").clicked() {
                                ui.close();
                                self.open_model(&ctx);
                            }
                            if ui.button("Open folder…").clicked() {
                                ui.close();
                                if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                                    let path = std::fs::read_dir(folder)
                                        .ok()
                                        .into_iter()
                                        .flatten()
                                        .filter_map(|e| e.ok().map(|e| e.path()))
                                        .find(|p| {
                                            p.extension().is_some_and(|e| {
                                                e.eq_ignore_ascii_case("gltf")
                                                    || e.eq_ignore_ascii_case("glb")
                                            })
                                        });
                                    if let Some(path) = path {
                                        self.load(path, &ctx);
                                    } else {
                                        self.error =
                                            "No glTF or GLB file in the selected folder".into();
                                    }
                                }
                            }
                            if ui.button("Open from URL…").clicked() {
                                self.tools.url_open = true;
                                ui.close();
                            }
                            if ui.button("Load environment (.hdr)…").clicked() {
                                self.load_hdr();
                                ui.close();
                            }
                        });
                        let examples = header_button(ui, "Examples", false, true);
                        ctx.data_mut(|data| {
                            data.insert_temp(egui::Id::new("examples-button-rect"), examples.rect)
                        });
                        if examples.clicked() {
                            self.toggle_inspector_tab(5);
                        }
                    });
                });
                ui.scope_builder(egui::UiBuilder::new().max_rect(rect), |ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.spacing_mut().interact_size.y = 28.;
                        ui.spacing_mut().button_padding = egui::vec2(8., 6.);
                        panel_button(ui, "Toggle inspector (])", true, &mut self.inspector_open);
                        if ui
                            .add_enabled_ui(self.can_export(), |ui| {
                                header_button(ui, "Export", true, false)
                            })
                            .inner
                            .clicked()
                        {
                            self.open_export(&ctx);
                        }
                        if utility_button(ui, "Keyboard shortcuts", false).clicked() {
                            self.tools.help_open = true;
                        }
                        if !compact {
                            if code_button(ui).clicked() {
                                self.tools.code_open = true;
                            }
                            if utility_button(ui, "Reset all…", true).clicked() {
                                self.tools.reset_open = true;
                            }
                            let (undo, redo) = self.history.labels();
                            let can_undo = undo.is_some();
                            let can_redo = redo.is_some();
                            if ui
                                .add_enabled_ui(can_redo, |ui| history_button(ui, true))
                                .inner
                                .on_hover_text("Redo (⇧⌘Z / Ctrl+Shift+Z)")
                                .clicked()
                            {
                                self.undo(true);
                            }
                            if ui
                                .add_enabled_ui(can_undo, |ui| history_button(ui, false))
                                .inner
                                .on_hover_text("Undo (⌘Z / Ctrl+Z)")
                                .clicked()
                            {
                                self.undo(false);
                            }
                            let old = self.backend;
                            egui::ComboBox::from_id_salt("header-backend")
                                .width(98.)
                                .selected_text(if self.backend == 1 {
                                    "HWRT"
                                } else {
                                    "Software"
                                })
                                .show_ui(ui, |ui| {
                                    ui.selectable_value(&mut self.backend, 1, "HWRT");
                                    ui.selectable_value(&mut self.backend, 0, "Software BVH");
                                })
                                .response
                                .on_hover_text(&self.backend_status);
                            if old != self.backend {
                                self.dirty(Change::Scene);
                            }
                        }
                    });
                });
                ui.painter().hline(
                    rect.x_range(),
                    rect.bottom() + 5.,
                    Stroke::new(1., Color32::from_white_alpha(14)),
                );
            });
        if !ctx.egui_wants_keyboard_input()
            && ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::O))
        {
            self.open_model(&ctx);
        }
    }
    fn load_hdr(&mut self) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("Radiance HDR", &["hdr"])
            .pick_file()
        {
            match self.environment.load(&path) {
                Ok(()) => {
                    self.environment.model_lighting = false;
                    self.dirty(Change::Environment);
                }
                Err(e) => self.error = format!("Could not load environment: {e:#}"),
            }
        }
    }
    fn open_model(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("glTF", &["gltf", "glb"])
            .pick_file()
        {
            self.load(path, ctx);
        }
    }
}

/// A small explicit grip is also available on macOS, where winit's native
/// drag_resize_window is unsupported. Keep it inset: macOS consumes pointer
/// presses at the outer window edge. The top-left remains fixed during resize.
pub fn resize_grip(ui: &mut egui::Ui) -> egui::Rect {
    let ctx = ui.ctx().clone();
    let id = egui::Id::new("window-resize-grip");
    egui::Area::new(id)
        .order(egui::Order::Foreground)
        .movable(false)
        .constrain(false)
        .default_size(egui::vec2(16., 16.))
        .fixed_pos(ctx.content_rect().right_bottom() - egui::vec2(32., 32.))
        .show(&ctx, |ui| {
            let (rect, response) = ui.allocate_exact_size(egui::vec2(16., 16.), Sense::drag());
            if response.hovered() || response.dragged() {
                ctx.set_cursor_icon(egui::CursorIcon::ResizeNwSe);
            }
            for offset in [4., 8., 12.] {
                ui.painter().line_segment(
                    [
                        rect.right_bottom() - egui::vec2(offset, 2.),
                        rect.right_bottom() - egui::vec2(2., offset),
                    ],
                    Stroke::new(1., theme::SUBTLE),
                );
            }
            let mut active = ctx.data(|data| data.get_temp::<(egui::Vec2, egui::Pos2)>(id));
            let events = ctx.input(|i| i.events.clone());
            for event in events {
                match event {
                    egui::Event::PointerButton {
                        pos,
                        button: egui::PointerButton::Primary,
                        pressed: true,
                        ..
                    } if rect.contains(pos) => active = Some((ctx.content_rect().size(), pos)),
                    egui::Event::PointerMoved(pos) if active.is_some() => {
                        let (size, origin) = active.unwrap();
                        ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(
                            (size + (pos - origin)).max(egui::vec2(800., 560.)),
                        ));
                    }
                    egui::Event::PointerButton {
                        button: egui::PointerButton::Primary,
                        pressed: false,
                        ..
                    }
                    | egui::Event::PointerGone
                    | egui::Event::WindowFocused(false) => active = None,
                    _ => {}
                }
            }
            ctx.data_mut(|data| {
                if let Some(active) = active {
                    data.insert_temp(id, active);
                } else {
                    data.remove::<(egui::Vec2, egui::Pos2)>(id);
                }
            });
        })
        .response
        .rect
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resize_grip_handles_a_coalesced_drag_and_keeps_the_window_minimum() {
        let ctx = egui::Context::default();
        let draw = |events| {
            let mut rect = egui::Rect::NOTHING;
            let mut output = ctx.run_ui(
                egui::RawInput {
                    screen_rect: Some(egui::Rect::from_min_size(
                        egui::Pos2::ZERO,
                        egui::vec2(1200., 800.),
                    )),
                    events,
                    ..Default::default()
                },
                |ui| {
                    rect = resize_grip(ui);
                },
            );
            output.textures_delta.clear();
            (rect, output)
        };
        draw(vec![]);
        let (rect, _) = draw(vec![]);
        assert_eq!(rect.right_bottom(), egui::pos2(1184., 784.));
        let from = rect.center();
        let to = from - egui::vec2(1000., 1000.);
        let button = |pos, pressed| egui::Event::PointerButton {
            pos,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: Default::default(),
        };
        let (_, output) = draw(vec![
            egui::Event::PointerMoved(from),
            button(from, true),
            egui::Event::PointerMoved(to),
            button(to, false),
        ]);
        assert!(output.viewport_output[&egui::ViewportId::ROOT].commands.iter().any(|command| matches!(command, egui::ViewportCommand::InnerSize(size) if *size == egui::vec2(800., 560.))));
    }
}
