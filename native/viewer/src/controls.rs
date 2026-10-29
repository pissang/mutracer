//! Small egui wrappers for the native viewer. Keep egui's input, focus and value
//! editing behavior, with separate sliders/numeric fields and the Web visual hierarchy.
use crate::theme;
use eframe::egui::{self, Align2, Color32, FontId, Response, Sense, Stroke, Ui};

pub fn button(ui: &mut Ui, label: &str) -> Response {
    ui.add(egui::Button::new(label).min_size(egui::vec2(0., 24.)))
}

pub fn section(ui: &mut Ui, title: &str, contents: impl FnOnce(&mut Ui)) {
    section_open(ui, title, true, contents);
}

pub fn section_open(ui: &mut Ui, title: &str, open: bool, contents: impl FnOnce(&mut Ui)) {
    ui.push_id(title, |ui| {
        ui.spacing_mut().item_spacing.y = 0.;
        let mut state = egui::collapsing_header::CollapsingState::load_with_default_open(
            ui.ctx(),
            ui.id().with("open"),
            open,
        );
        let (rect, response) =
            ui.allocate_exact_size(egui::vec2(ui.available_width(), 40.), Sense::click());
        if response.clicked() {
            state.toggle(ui);
        }
        response.widget_info(|| {
            egui::WidgetInfo::selected(
                egui::WidgetType::CollapsingHeader,
                ui.is_enabled(),
                state.is_open(),
                title,
            )
        });
        if response.hovered() || response.has_focus() {
            ui.painter().rect_filled(
                rect.shrink2(egui::vec2(0., 3.)),
                6,
                theme::CONTROL.gamma_multiply(0.4),
            );
        }
        let icon = match title {
            "Quality" => Some(Icon::Render),
            "Color" | "Base" => Some(Icon::Material),
            "Environment" | "Studio" => Some(Icon::Lighting),
            "View" | "Depth of field" => Some(Icon::Camera),
            "Caustics" | "Effects" => Some(Icon::Sun),
            "Denoiser" => Some(Icon::Examples),
            "Background" => Some(Icon::Background),
            _ => None,
        };
        if let Some(icon) = icon {
            paint_icon(
                ui,
                rect.left_center() + egui::vec2(7., 0.),
                icon,
                theme::MUTED,
            );
        }
        ui.painter().text(
            rect.left_center() + egui::vec2(if icon.is_some() { 22. } else { 0. }, 0.),
            Align2::LEFT_CENTER,
            title,
            FontId::proportional(11.5),
            if state.is_open() {
                theme::TEXT
            } else {
                theme::MUTED
            },
        );
        let c = rect.right_center() - egui::vec2(8., 0.);
        let offsets = if state.is_open() {
            [
                egui::vec2(-3., -1.5),
                egui::vec2(0., 1.5),
                egui::vec2(3., -1.5),
            ]
        } else {
            [
                egui::vec2(-1.5, -3.),
                egui::vec2(1.5, 0.),
                egui::vec2(-1.5, 3.),
            ]
        };
        ui.painter().add(egui::Shape::line(
            offsets.map(|p| c + p).to_vec(),
            Stroke::new(1., theme::SUBTLE),
        ));
        state.show_body_unindented(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 7.;
            contents(ui);
            ui.add_space(7.);
        });
        ui.add(egui::Separator::default().spacing(0.));
    });
}

fn property<R>(ui: &mut Ui, label: &str, contents: impl FnOnce(&mut Ui, egui::Id) -> R) -> R {
    ui.push_id(label, |ui| {
        egui::Frame::new()
            .fill(theme::INPUT)
            .stroke(Stroke::new(1., theme::BORDER))
            .corner_radius(9)
            .inner_margin(egui::Margin::symmetric(10, 0))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                let label_width = (ui.available_width() * 0.37).min(104.);
                ui.horizontal(|ui| {
                    let label = ui
                        .allocate_ui_with_layout(
                            egui::vec2(label_width, 30.),
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| {
                                ui.set_min_width(label_width);
                                ui.add(
                                    egui::Label::new(
                                        egui::RichText::new(label).size(11.).color(theme::SUBTLE),
                                    )
                                    .truncate(),
                                )
                                .on_hover_text(label)
                            },
                        )
                        .inner;
                    ui.visuals_mut().widgets.inactive.weak_bg_fill = Color32::TRANSPARENT;
                    ui.visuals_mut().widgets.inactive.bg_stroke = Stroke::NONE;
                    contents(ui, label.id)
                })
                .inner
            })
            .inner
    })
    .inner
}

/// Native slider options, with a separate numeric field. Keep live lens values
/// untouched until an actual edit; retain egui's text editing and accessibility.
pub struct Scrub<'a, Num: egui::emath::Numeric> {
    value: &'a mut Num,
    range: std::ops::RangeInclusive<Num>,
    logarithmic: bool,
    decimals: usize,
    suffix: &'a str,
    prefix: &'a str,
}
impl<'a, Num: egui::emath::Numeric> Scrub<'a, Num> {
    pub fn new(value: &'a mut Num, range: std::ops::RangeInclusive<Num>) -> Self {
        Self {
            value,
            range,
            logarithmic: false,
            decimals: if Num::INTEGRAL { 0 } else { 2 },
            suffix: "",
            prefix: "",
        }
    }
    pub fn logarithmic(mut self, logarithmic: bool) -> Self {
        self.logarithmic = logarithmic;
        self
    }
    pub fn max_decimals(mut self, decimals: usize) -> Self {
        self.decimals = decimals;
        self
    }
    pub fn suffix(mut self, suffix: &'a str) -> Self {
        self.suffix = suffix;
        self
    }
    pub fn prefix(mut self, prefix: &'a str) -> Self {
        self.prefix = prefix;
        self
    }
}

#[derive(Clone, Copy)]
struct NumericGesture {
    start: egui::Pos2,
    handled: bool,
}

fn numeric_value<Num: egui::emath::Numeric>(
    ui: &mut Ui,
    size: egui::Vec2,
    scrub: Scrub<'_, Num>,
    speed: f64,
) -> Response {
    let Scrub {
        value,
        range,
        decimals,
        prefix,
        suffix,
        logarithmic,
    } = scrub;
    let before = value.to_f64();
    let min = range.start().to_f64();
    let max = range.end().to_f64();
    let key = ui.id().with("numeric-edit-generation");
    let generation = ui.data(|data| data.get_temp::<u64>(key).unwrap_or(0));
    let focused = ui.memory(|memory| memory.focused());
    let mut response = ui
        .push_id(generation, |ui| {
            ui.add_sized(
                size,
                egui::DragValue::new(&mut *value)
                    .range(range)
                    .clamp_existing_to_range(false)
                    .speed(speed)
                    .max_decimals(decimals)
                    .prefix(prefix)
                    .suffix(suffix)
                    .update_while_editing(false),
            )
        })
        .inner;
    // DragValue handles ordinary drags. A complete press/move/release can also
    // arrive between frames; use its relative displacement instead of focusing.
    let pointer_key = ui.id().with("numeric-pointer");
    let mut gesture = ui.data(|data| data.get_temp::<NumericGesture>(pointer_key));
    if let Some(current) = &mut gesture {
        current.handled |= response.changed();
    }
    let fast_delta = ui.input(|input| {
        let mut result = None;
        for event in &input.events {
            match event {
                egui::Event::PointerButton {
                    pos,
                    button: egui::PointerButton::Primary,
                    pressed,
                    ..
                } => {
                    if *pressed {
                        gesture = response.rect.contains(*pos).then_some(NumericGesture {
                            start: *pos,
                            handled: focused == Some(response.id) || response.changed(),
                        });
                    } else if let Some(current) = gesture.take() {
                        let delta = *pos - current.start;
                        if !current.handled && delta.x.abs() >= 4. {
                            result = Some(
                                (delta.x - delta.y) as f64
                                    * if input.modifiers.shift { 0.1 } else { 1. },
                            );
                        }
                    }
                }
                egui::Event::PointerGone => gesture = None,
                _ => (),
            }
        }
        result
    });
    ui.data_mut(|data| {
        if let Some(current) = gesture {
            data.insert_temp(pointer_key, current);
        } else {
            data.remove::<NumericGesture>(pointer_key);
        }
    });
    let fast_drag = ui.is_enabled()
        && focused != Some(response.id)
        && !response.changed()
        && fast_delta.is_some();
    if fast_drag {
        *value = Num::from_f64(egui::emath::round_to_decimals(
            (if logarithmic {
                before * 2f64.powf(fast_delta.unwrap() / 40.)
            } else {
                before + fast_delta.unwrap() * speed
            })
            .clamp(min, max),
            decimals,
        ));
        if value.to_f64() != before {
            response.mark_changed();
        }
        ui.ctx().request_repaint();
    }
    if fast_drag
        || (ui.input(|input| input.key_pressed(egui::Key::Escape))
            && (focused == Some(response.id) || response.has_focus() || response.lost_focus()))
    {
        // egui retains cancelled text until the following lost-focus frame.
        // A fresh ID prevents that draft, or a coalesced drag's click, from editing later.
        ui.memory_mut(|memory| memory.surrender_focus(response.id));
        ui.data_mut(|data| data.insert_temp(key, generation.wrapping_add(1)));
    }
    response
}

pub fn parameter<Num: egui::emath::Numeric>(
    ui: &mut Ui,
    label: &str,
    scrub: Scrub<'_, Num>,
) -> Response {
    ui.push_id(label, |ui| {
        let Scrub {
            value,
            range,
            logarithmic,
            decimals,
            suffix,
            prefix,
        } = scrub;
        let min = range.start().to_f64();
        let max = range.end().to_f64();
        let (row, _) =
            ui.allocate_exact_size(egui::vec2(ui.available_width(), 30.), Sense::hover());
        let value_width = (row.width() * 0.3).clamp(64., 100.);
        let numeric =
            egui::Rect::from_min_max(egui::pos2(row.right() - value_width, row.top()), row.max);
        let rect = egui::Rect::from_min_max(row.min, egui::pos2(numeric.left() - 6., row.bottom()));
        ui.painter().rect_filled(rect, 9, theme::INPUT);
        let mut response = ui
            .scope_builder(egui::UiBuilder::new().max_rect(rect), |ui| {
                ui.spacing_mut().slider_width = rect.width();
                ui.spacing_mut().interact_size.y = 30.;
                // Paint our full-row fill below; retain the standard slider's interaction.
                let widgets = &mut ui.visuals_mut().widgets;
                for visuals in [
                    &mut widgets.inactive,
                    &mut widgets.hovered,
                    &mut widgets.active,
                ] {
                    visuals.bg_fill = Color32::TRANSPARENT;
                    visuals.fg_stroke = Stroke::NONE;
                }
                ui.add(
                    egui::Slider::new(&mut *value, range.clone())
                        .show_value(false)
                        .logarithmic(logarithmic)
                        .max_decimals(decimals)
                        .clamping(egui::SliderClamping::Edits)
                        .trailing_fill(false)
                        .handle_shape(egui::style::HandleShape::Rect { aspect_ratio: 0.08 }),
                )
            })
            .inner;
        let v = value.to_f64();
        let fraction = if logarithmic {
            (v / min).ln() / (max / min).ln()
        } else {
            (v - min) / (max - min)
        };
        let x = egui::lerp(rect.x_range(), fraction.clamp(0., 1.) as f32);
        if x > rect.left() {
            ui.painter()
                .with_clip_rect(rect.intersect(egui::Rect::from_min_max(
                    rect.min,
                    egui::pos2(x, rect.bottom()),
                )))
                .rect_filled(rect, 9, theme::SCRUB_FILL);
        }
        if x > rect.left() + 2. && x < rect.right() - 2. {
            ui.painter().line_segment(
                [
                    egui::pos2(x, rect.top() + 7.),
                    egui::pos2(x, rect.bottom() - 7.),
                ],
                Stroke::new(1.5, theme::MUTED),
            );
        }
        let text = egui::WidgetText::from(egui::RichText::new(label).size(11.).color(theme::TEXT))
            .into_galley(
                ui,
                Some(egui::TextWrapMode::Truncate),
                (rect.width() - 20.).max(1.),
                egui::TextStyle::Body,
            );
        ui.painter().galley(
            rect.left_center() + egui::vec2(10., -text.size().y * 0.5),
            text,
            theme::TEXT,
        );
        let speed = if logarithmic {
            value.to_f64().abs().max(min) * std::f64::consts::LN_2 / 40.
        } else {
            let step = if Num::INTEGRAL || max - min >= 50. {
                1.
            } else if max - min >= 5. {
                0.1
            } else {
                0.01
            };
            step / 4.
        };
        let edit = ui
            .scope_builder(egui::UiBuilder::new().max_rect(numeric), |ui| {
                ui.spacing_mut().interact_size.y = 30.;
                numeric_value(
                    ui,
                    numeric.size(),
                    Scrub {
                        value,
                        range,
                        logarithmic,
                        decimals,
                        prefix,
                        suffix,
                    },
                    speed,
                )
            })
            .inner
            .on_hover_text(label);
        if edit.changed() {
            response.mark_changed();
        }
        let border = if response.has_focus() || edit.has_focus() {
            theme::ACCENT
        } else if response.hovered() || edit.hovered() {
            theme::CONTROL_BORDER_HOVER
        } else {
            theme::BORDER
        };
        ui.painter()
            .rect_stroke(rect, 9, Stroke::new(1., border), egui::StrokeKind::Inside);
        response.widget_info(|| egui::WidgetInfo::slider(ui.is_enabled(), value.to_f64(), label));
        response.on_hover_text(label)
    })
    .inner
}

pub fn scalar(
    ui: &mut Ui,
    label: &str,
    value: &mut f32,
    range: std::ops::RangeInclusive<f32>,
) -> bool {
    parameter(ui, label, Scrub::new(value, range)).changed()
}

pub fn segmented<T: Copy + PartialEq>(
    ui: &mut Ui,
    label: &str,
    value: &mut T,
    options: &[(T, &str)],
) -> bool {
    let mut changed = false;
    ui.push_id(label, |ui| {
        egui::Frame::new()
            .fill(theme::INPUT)
            .stroke(Stroke::new(1., theme::BORDER))
            .corner_radius(10)
            .inner_margin(3)
            .show(ui, |ui| {
                let width =
                    (ui.available_width() - 3. * (options.len() - 1) as f32) / options.len() as f32;
                ui.spacing_mut().item_spacing.x = 3.;
                ui.horizontal(|ui| {
                    for &(option, text) in options {
                        let selected = *value == option;
                        let response = ui.add_sized(
                            [width, 24.],
                            egui::Button::new(
                                egui::RichText::new(text).size(11.).color(if selected {
                                    theme::TEXT
                                } else {
                                    theme::SUBTLE
                                }),
                            )
                            .wrap_mode(egui::TextWrapMode::Truncate)
                            .fill(if selected {
                                theme::CONTROL
                            } else {
                                Color32::TRANSPARENT
                            })
                            .stroke(if selected {
                                Stroke::new(1., theme::CONTROL_BORDER_HOVER)
                            } else {
                                Stroke::NONE
                            })
                            .corner_radius(7),
                        );
                        if response.clicked() && !selected {
                            *value = option;
                            changed = true;
                        }
                    }
                });
            });
    });
    changed
}

pub fn number(ui: &mut Ui, label: &str, value: &mut f32, speed: f64) -> Response {
    property(ui, label, |ui, label_id| {
        numeric_value(
            ui,
            egui::vec2(ui.available_width(), 24.),
            Scrub::new(value, -1e6..=1e6).max_decimals(10),
            speed,
        )
        .labelled_by(label_id)
    })
}

pub fn texture_sampling(ui: &mut Ui, wrap: &mut [u32; 2], scale: &mut [f32; 2]) -> bool {
    let previous = (*wrap, *scale);
    ui.scope(|ui| {
        ui.spacing_mut().item_spacing.x = 6.;
        ui.columns(2, |columns| {
            for axis in 0..2 {
                let ui = &mut columns[axis];
                let label = ui.label(
                    egui::RichText::new(["Wrap S", "Wrap T"][axis])
                        .small()
                        .color(theme::MUTED),
                );
                egui::ComboBox::from_id_salt(("texture-wrap", axis))
                    .selected_text(
                        ["Repeat", "Clamp to edge", "Mirrored repeat"][wrap[axis] as usize],
                    )
                    .width(ui.available_width())
                    .wrap_mode(egui::TextWrapMode::Truncate)
                    .show_ui(ui, |ui| {
                        for (mode, name) in ["Repeat", "Clamp to edge", "Mirrored repeat"]
                            .iter()
                            .enumerate()
                        {
                            ui.selectable_value(&mut wrap[axis], mode as u32, *name);
                        }
                    })
                    .response
                    .labelled_by(label.id);
            }
        });
        ui.columns(2, |columns| {
            for axis in 0..2 {
                let ui = &mut columns[axis];
                let label = ui.label(
                    egui::RichText::new(["Repeat S", "Repeat T"][axis])
                        .small()
                        .color(theme::MUTED),
                );
                numeric_value(
                    ui,
                    egui::vec2(ui.available_width(), 30.),
                    Scrub::new(&mut scale[axis], f32::NEG_INFINITY..=f32::INFINITY).max_decimals(4),
                    0.025,
                )
                .labelled_by(label.id);
            }
        });
    });
    previous != (*wrap, *scale)
}

pub fn select(
    ui: &mut Ui,
    label: &str,
    value: impl Into<egui::WidgetText>,
    contents: impl FnOnce(&mut Ui),
) {
    property(ui, label, |ui, label_id| {
        egui::ComboBox::from_id_salt("choice")
            .selected_text(value)
            .width(ui.available_width())
            .wrap_mode(egui::TextWrapMode::Truncate)
            .show_ui(ui, contents)
            .response
            .labelled_by(label_id);
    });
}

pub fn color(ui: &mut Ui, label: &str, value: &mut [f32; 3]) -> Response {
    ui.push_id(label, |ui| {
        egui::Frame::new()
            .fill(theme::INPUT)
            .stroke(Stroke::new(1., theme::BORDER))
            .corner_radius(9)
            .inner_margin(egui::Margin::symmetric(4, 3))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().interact_size = egui::vec2(22., 22.);
                    let mut edited = *value;
                    let response = ui.color_edit_button_rgb(&mut edited);
                    if response.changed() {
                        *value = edited;
                    }
                    ui.label(egui::RichText::new(label).size(11.));
                    let color: Color32 = egui::Rgba::from_rgb(value[0], value[1], value[2]).into();
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            egui::RichText::new(format!(
                                "#{:02X}{:02X}{:02X}",
                                color.r(),
                                color.g(),
                                color.b()
                            ))
                            .monospace()
                            .size(10.5)
                            .color(theme::SUBTLE),
                        );
                    });
                    response.on_hover_text(label)
                })
                .inner
            })
            .inner
    })
    .inner
}

pub fn toggle(ui: &mut Ui, label: &str, value: &mut bool) -> Response {
    let (rect, mut response) =
        ui.allocate_exact_size(egui::vec2(ui.available_width(), 30.), Sense::click());
    if response.clicked() {
        *value = !*value;
        response.mark_changed();
    }
    response.widget_info(|| {
        egui::WidgetInfo::selected(egui::WidgetType::Checkbox, ui.is_enabled(), *value, label)
    });
    let painter = ui.painter();
    painter.text(
        rect.left_center(),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(11.),
        theme::MUTED,
    );
    let track = egui::Rect::from_center_size(
        rect.right_center() - egui::vec2(17., 0.),
        egui::vec2(34., 20.),
    );
    painter.rect_filled(
        track,
        9,
        if *value {
            theme::ACCENT_SOLID
        } else {
            theme::CONTROL
        },
    );
    if response.has_focus() || response.hovered() {
        painter.rect_stroke(
            track.expand(2.),
            11,
            Stroke::new(1., theme::ACCENT),
            egui::StrokeKind::Outside,
        );
    }
    painter.circle_filled(
        egui::pos2(
            if *value {
                track.right() - 10.
            } else {
                track.left() + 10.
            },
            track.center().y,
        ),
        8.,
        theme::TEXT,
    );
    response
}

#[derive(Clone, Copy)]
pub enum Icon {
    Examples,
    Sun,
    Background,
    Lighting,
    Material,
    Camera,
    Render,
    Object,
}

pub fn preset_card(ui: &mut Ui, width: f32, name: &str, detail: &str, selected: bool) -> Response {
    let response = ui.add_sized(
        [width, 44.],
        egui::Button::new("")
            .fill(if selected {
                theme::ACCENT_SURFACE
            } else {
                theme::INPUT
            })
            .stroke(Stroke::new(
                1.,
                if selected {
                    theme::ACCENT
                } else {
                    theme::BORDER
                },
            ))
            .corner_radius(9),
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::RadioButton,
            ui.is_enabled(),
            selected,
            name,
        )
    });
    for (text, y, size, color) in [
        (name, 7., 11., theme::TEXT),
        (detail, 24., 9.5, theme::SUBTLE),
    ] {
        let galley = egui::WidgetText::from(egui::RichText::new(text).size(size).color(color))
            .into_galley(
                ui,
                Some(egui::TextWrapMode::Truncate),
                (width - 16.).max(1.),
                egui::TextStyle::Body,
            );
        ui.painter()
            .galley(response.rect.left_top() + egui::vec2(8., y), galley, color);
    }
    response.on_hover_text(format!("{name} · {detail}"))
}

pub fn heading(ui: &mut Ui, title: &str, icon: Icon) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 40.), Sense::hover());
    let badge = egui::Rect::from_center_size(
        rect.left_center() + egui::vec2(16., 0.),
        egui::vec2(32., 32.),
    );
    ui.painter().rect_filled(badge, 10, theme::ACCENT_SURFACE);
    ui.painter().rect_stroke(
        badge,
        10,
        Stroke::new(1., theme::ACCENT.gamma_multiply(0.36)),
        egui::StrokeKind::Inside,
    );
    paint_icon(ui, badge.center(), icon, theme::ACCENT);
    ui.painter().text(
        rect.left_center() + egui::vec2(42., 0.),
        Align2::LEFT_CENTER,
        title,
        FontId::proportional(13.),
        theme::TEXT,
    );
}

pub fn category(ui: &mut Ui, label: &str, icon: Icon, selected: bool) -> Response {
    let response = ui.add_sized(
        [ui.available_width(), 60.],
        egui::Button::selectable(selected, "").corner_radius(12),
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::SelectableLabel,
            ui.is_enabled(),
            selected,
            label,
        )
    });
    let color = if selected {
        theme::ACCENT
    } else if response.hovered() {
        theme::TEXT
    } else {
        theme::SUBTLE
    };
    let center = response.rect.center_top() + egui::vec2(0., 18.);
    paint_icon(ui, center, icon, color);
    ui.painter().text(
        response.rect.center_bottom() - egui::vec2(0., 8.),
        Align2::CENTER_BOTTOM,
        label,
        FontId::proportional(10.),
        color,
    );
    response.on_hover_text(label)
}

pub(super) fn paint_icon(ui: &Ui, center: egui::Pos2, icon: Icon, color: Color32) {
    let painter = ui.painter();
    let stroke = Stroke::new(1.2, color);
    match icon {
        Icon::Examples => {
            for (offset, radius) in [(egui::vec2(-2., 2.), 6.), (egui::vec2(5., -5.), 3.)] {
                let c = center + offset;
                painter.add(egui::Shape::closed_line(
                    vec![
                        c - egui::vec2(0., radius),
                        c + egui::vec2(radius * 0.3, -radius * 0.3),
                        c + egui::vec2(radius, 0.),
                        c + egui::vec2(radius * 0.3, radius * 0.3),
                        c + egui::vec2(0., radius),
                        c + egui::vec2(-radius * 0.3, radius * 0.3),
                        c - egui::vec2(radius, 0.),
                        c - egui::vec2(radius * 0.3, radius * 0.3),
                    ],
                    stroke,
                ));
            }
        }
        Icon::Sun => {
            painter.circle_stroke(center, 3.5, stroke);
            for i in 0..8 {
                let d = egui::Vec2::angled(i as f32 * std::f32::consts::TAU / 8.);
                painter.line_segment([center + d * 5.5, center + d * 8.], stroke);
            }
        }
        Icon::Background => {
            painter.rect_stroke(
                egui::Rect::from_center_size(center, egui::vec2(16., 14.)),
                2,
                stroke,
                egui::StrokeKind::Inside,
            );
            painter.circle_stroke(center + egui::vec2(-3., -3.), 1.5, stroke);
            painter.add(egui::Shape::line(
                vec![
                    center + egui::vec2(-7., 5.),
                    center + egui::vec2(-1., -1.),
                    center + egui::vec2(3., 3.),
                    center + egui::vec2(6., 0.),
                ],
                stroke,
            ));
        }
        Icon::Lighting => {
            painter.circle_stroke(center, 8., stroke);
            painter.line_segment(
                [center - egui::vec2(8., 0.), center + egui::vec2(8., 0.)],
                stroke,
            );
            // Globe meridians, matching the Lighting tab's globe silhouette.
            for side in [-1., 1.] {
                painter.add(egui::Shape::line(
                    (0..=16)
                        .map(|i| {
                            let angle = i as f32 * std::f32::consts::PI / 16.;
                            center + egui::vec2(side * 3.5 * angle.sin(), -8. * angle.cos())
                        })
                        .collect(),
                    stroke,
                ));
            }
        }
        Icon::Material => {
            // A palette with a thumb notch, rather than a generic material sphere.
            let points = (0..=28)
                .map(|i| {
                    let angle = i as f32 * std::f32::consts::TAU / 28.;
                    let radius = if (0.2..1.4).contains(&angle) { 4.5 } else { 8. };
                    center + egui::Vec2::angled(angle) * radius
                })
                .collect();
            painter.add(egui::Shape::closed_line(points, stroke));
            for offset in [
                egui::vec2(-3., -3.),
                egui::vec2(2., -4.),
                egui::vec2(-4., 2.),
            ] {
                painter.circle_filled(center + offset, 1., color);
            }
        }
        Icon::Camera => {
            painter.add(egui::Shape::closed_line(
                vec![
                    center + egui::vec2(-8., -4.),
                    center + egui::vec2(-4., -4.),
                    center + egui::vec2(-2., -7.),
                    center + egui::vec2(3., -7.),
                    center + egui::vec2(5., -4.),
                    center + egui::vec2(8., -4.),
                    center + egui::vec2(8., 6.),
                    center + egui::vec2(-8., 6.),
                ],
                stroke,
            ));
            painter.circle_stroke(center + egui::vec2(0., 1.), 3., stroke);
        }
        Icon::Render => {
            painter.circle_stroke(center, 7., stroke);
            for i in 0..6 {
                let d = egui::Vec2::angled(i as f32 * std::f32::consts::TAU / 6.);
                let side = egui::Vec2::angled((i + 1) as f32 * std::f32::consts::TAU / 6.);
                painter.line_segment([center + d * 7., center + side * 3.], stroke);
            }
        }
        Icon::Object => {
            let top = center - egui::vec2(0., 8.);
            let left = center - egui::vec2(7., 4.);
            let right = center + egui::vec2(7., -4.);
            let bottom = center + egui::vec2(0., 8.);
            painter.add(egui::Shape::closed_line(
                vec![
                    top,
                    right,
                    right + egui::vec2(0., 8.),
                    bottom,
                    left + egui::vec2(0., 8.),
                    left,
                ],
                stroke,
            ));
            for (a, b) in [(left, center), (right, center), (center, bottom)] {
                painter.line_segment([a, b], stroke);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::{Context, Event, Key, Modifiers, PointerButton, RawInput};

    fn draw(ctx: &Context, value: &mut bool, enabled: bool, events: Vec<Event>) -> Response {
        let mut response = None;
        let mut output = ctx.run_ui(
            RawInput {
                events,
                ..Default::default()
            },
            |root| {
                egui::CentralPanel::default().show(root, |ui| {
                    ui.set_width(280.);
                    ui.add_enabled_ui(enabled, |ui| {
                        response = Some(toggle(ui, "Denoise", value));
                    });
                });
            },
        );
        output.textures_delta.clear();
        response.unwrap()
    }

    #[test]
    fn separate_slider_preserves_idle_values_and_accepts_pointer_and_keyboard_edits() {
        fn draw_scrub(ctx: &Context, value: &mut f32, events: Vec<Event>) -> Response {
            let mut response = None;
            let mut output = ctx.run_ui(
                RawInput {
                    events,
                    ..Default::default()
                },
                |root| {
                    egui::CentralPanel::default().show(root, |ui| {
                        ui.set_width(280.);
                        response = Some(parameter(
                            ui,
                            "Live focus",
                            Scrub::new(value, 0.01..=10.).max_decimals(2),
                        ));
                        let mut color = [0.1234567, 0.7654321, 0.2345678];
                        let before = color;
                        assert!(!super::color(ui, "Color", &mut color).changed());
                        assert_eq!(color, before);
                    });
                },
            );
            output.textures_delta.clear();
            response.unwrap()
        }
        let ctx = Context::default();
        let mut value = 0.1234567;
        let response = draw_scrub(&ctx, &mut value, vec![]);
        assert!(!response.changed());
        assert_eq!(value, 0.1234567);
        let pos = response.rect.left_center() + egui::vec2(response.rect.width() * 0.25, 0.);
        draw_scrub(
            &ctx,
            &mut value,
            vec![
                Event::PointerMoved(pos),
                Event::PointerButton {
                    pos,
                    button: PointerButton::Primary,
                    pressed: true,
                    modifiers: Modifiers::NONE,
                },
            ],
        );
        let response = draw_scrub(
            &ctx,
            &mut value,
            vec![Event::PointerButton {
                pos,
                button: PointerButton::Primary,
                pressed: false,
                modifiers: Modifiers::NONE,
            }],
        );
        assert!(
            (value - 2.5).abs() < 0.1,
            "Slider pointer position: {value}"
        );
        ctx.memory_mut(|m| m.request_focus(response.id));
        let before = value;
        let response = draw_scrub(
            &ctx,
            &mut value,
            vec![Event::Key {
                key: Key::ArrowRight,
                physical_key: None,
                pressed: true,
                repeat: false,
                modifiers: Modifiers::NONE,
            }],
        );
        assert!(response.changed() && value > before);
    }

    #[test]
    fn numeric_field_click_does_not_seek_slider_and_supports_typing_dragging_and_disabled_state() {
        fn frame(
            ctx: &Context,
            value: &mut f32,
            enabled: bool,
            events: Vec<Event>,
        ) -> (Response, egui::Pos2) {
            let mut result = None;
            let mut output = ctx.run_ui(
                RawInput {
                    events,
                    ..Default::default()
                },
                |root| {
                    egui::CentralPanel::default().show(root, |ui| {
                        ui.set_width(280.);
                        ui.add_enabled_ui(enabled, |ui| {
                            let response = parameter(
                                ui,
                                "Value",
                                Scrub::new(value, 0.01..=10.).max_decimals(2),
                            );
                            let numeric =
                                egui::pos2(ui.min_rect().right() - 20., response.rect.center().y);
                            assert!(numeric.x > response.rect.right());
                            result = Some((response, numeric));
                        });
                    });
                },
            );
            output.textures_delta.clear();
            result.unwrap()
        }
        let pointer = |pos, pressed| Event::PointerButton {
            pos,
            button: PointerButton::Primary,
            pressed,
            modifiers: Modifiers::NONE,
        };
        let enter = |key| Event::Key {
            key,
            physical_key: None,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::NONE,
        };
        for enabled in [true, false] {
            let ctx = Context::default();
            let mut value = 0.1234567;
            let (_, pos) = frame(&ctx, &mut value, enabled, vec![]);
            frame(
                &ctx,
                &mut value,
                enabled,
                vec![Event::PointerMoved(pos), pointer(pos, true)],
            );
            frame(&ctx, &mut value, enabled, vec![pointer(pos, false)]);
            assert_eq!(
                value, 0.1234567,
                "Clicking the number must preserve the live value"
            );
            frame(&ctx, &mut value, enabled, vec![Event::Text("4.25".into())]);
            assert_eq!(value, 0.1234567, "Typing waits for commit");
            frame(&ctx, &mut value, enabled, vec![enter(Key::Enter)]);
            assert_eq!(value, if enabled { 4.25 } else { 0.1234567 });
            frame(
                &ctx,
                &mut value,
                enabled,
                vec![Event::PointerMoved(pos), pointer(pos, true)],
            );
            frame(&ctx, &mut value, enabled, vec![pointer(pos, false)]);
            frame(&ctx, &mut value, enabled, vec![Event::Text("8.5".into())]);
            frame(&ctx, &mut value, enabled, vec![enter(Key::Escape)]);
            frame(&ctx, &mut value, enabled, vec![]);
            assert_eq!(
                value,
                if enabled { 4.25 } else { 0.1234567 },
                "Escape cancels typed edits"
            );
            let before = value;
            frame(
                &ctx,
                &mut value,
                enabled,
                vec![Event::PointerMoved(pos), pointer(pos, true)],
            );
            frame(
                &ctx,
                &mut value,
                enabled,
                vec![Event::PointerMoved(pos + egui::vec2(-40., 0.))],
            );
            frame(
                &ctx,
                &mut value,
                enabled,
                vec![pointer(pos + egui::vec2(-40., 0.), false)],
            );
            if enabled {
                assert!(
                    value < before,
                    "Dragging the numeric field must adjust its value: {before} -> {value}"
                );
            } else {
                assert_eq!(value, before);
            }
            frame(&ctx, &mut value, enabled, vec![]);
            let before = value;
            let end = pos + egui::vec2(-24., 0.);
            frame(
                &ctx,
                &mut value,
                enabled,
                vec![
                    Event::PointerMoved(pos),
                    pointer(pos, true),
                    Event::PointerMoved(end),
                    pointer(end, false),
                ],
            );
            if enabled {
                assert!(
                    value < before,
                    "Coalesced numeric drag must update the value"
                );
            } else {
                assert_eq!(value, before);
            }
            frame(&ctx, &mut value, enabled, vec![]);
            let before = value;
            frame(
                &ctx,
                &mut value,
                enabled,
                vec![Event::PointerMoved(pos), pointer(pos, true)],
            );
            frame(
                &ctx,
                &mut value,
                enabled,
                vec![Event::PointerMoved(end), pointer(end, false)],
            );
            if enabled {
                assert!(
                    value < before,
                    "A move coalesced with release must update the value"
                );
            } else {
                assert_eq!(value, before);
            }
        }
    }

    #[test]
    fn switch_click_updates_once_on_release_and_respects_disabled_state() {
        for enabled in [true, false] {
            let ctx = Context::default();
            let mut value = false;
            let pos = draw(&ctx, &mut value, enabled, vec![]).rect.center();
            let pressed = draw(
                &ctx,
                &mut value,
                enabled,
                vec![
                    Event::PointerMoved(pos),
                    Event::PointerButton {
                        pos,
                        button: PointerButton::Primary,
                        pressed: true,
                        modifiers: Modifiers::NONE,
                    },
                ],
            );
            assert!(!value);
            assert!(!pressed.changed());
            let released = draw(
                &ctx,
                &mut value,
                enabled,
                vec![Event::PointerButton {
                    pos,
                    button: PointerButton::Primary,
                    pressed: false,
                    modifiers: Modifiers::NONE,
                }],
            );
            assert_eq!(value, enabled);
            assert_eq!(released.changed(), enabled);
            assert!(!draw(&ctx, &mut value, enabled, vec![]).changed());
        }
    }

    #[test]
    fn focused_switch_accepts_space_and_disabled_switch_ignores_it() {
        for enabled in [true, false] {
            let ctx = Context::default();
            let mut value = false;
            let response = draw(&ctx, &mut value, enabled, vec![]);
            ctx.memory_mut(|m| m.request_focus(response.id));
            let mut changes = 0;
            for pressed in [true, false] {
                changes += usize::from(
                    draw(
                        &ctx,
                        &mut value,
                        enabled,
                        vec![Event::Key {
                            key: Key::Space,
                            physical_key: None,
                            pressed,
                            repeat: false,
                            modifiers: Modifiers::NONE,
                        }],
                    )
                    .changed(),
                );
            }
            assert_eq!(value, enabled);
            assert_eq!(changes, usize::from(enabled));
        }
    }
}
