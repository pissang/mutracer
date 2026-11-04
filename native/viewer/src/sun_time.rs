//! Native counterpart of the web SunTime control. Diagram math stays off the
//! AOT scene queue so a large model preparation cannot block pointer input.
use crate::{egui, theme};
use egui::{Color32, Pos2, Rect, Stroke, Vec2};

const MIN: f32 = 5.5;
const MAX: f32 = 18.5;
const WIDTH: f32 = 280.;
const HEIGHT: f32 = 104.;
const HORIZON: f32 = 76.;

fn elevation(hours: f32) -> f32 {
    (40_f32.to_radians().cos() * (15. * (hours - 12.)).to_radians().cos())
        .asin()
        .to_degrees()
}
fn quantize(hours: f32) -> f32 {
    (((hours * 12.).round() / 12.).clamp(MIN, MAX) * 10000.).round() / 10000.
}
fn time_label(hours: f32) -> String {
    let minutes = (hours * 60.).round() as u32;
    format!("{}:{:02}", minutes / 60, minutes % 60)
}
fn mix(a: Color32, b: Color32, t: f32) -> Color32 {
    Color32::from_rgb(
        (a.r() as f32 + (b.r() as f32 - a.r() as f32) * t).round() as u8,
        (a.g() as f32 + (b.g() as f32 - a.g() as f32) * t).round() as u8,
        (a.b() as f32 + (b.b() as f32 - a.b() as f32) * t).round() as u8,
    )
}
// A colored convex fan gives the rounded panel a vertical gradient without a
// bitmap texture. The two radii allow the sky and ground to share a horizon.
fn gradient(painter: &egui::Painter, rect: Rect, top: Color32, bottom: Color32, radii: [f32; 2]) {
    let [rt, rb] = radii.map(|r| r.min(rect.width() * 0.5).min(rect.height() * 0.5));
    let color = |y: f32| {
        mix(
            top,
            bottom,
            ((y - rect.top()) / rect.height()).clamp(0., 1.),
        )
    };
    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(rect.center(), color(rect.center().y));
    for (center, radius, start) in [
        (rect.left_top() + Vec2::splat(rt), rt, std::f32::consts::PI),
        (
            rect.right_top() + egui::vec2(-rt, rt),
            rt,
            1.5 * std::f32::consts::PI,
        ),
        (rect.right_bottom() - Vec2::splat(rb), rb, 0.),
        (
            rect.left_bottom() + egui::vec2(rb, -rb),
            rb,
            std::f32::consts::FRAC_PI_2,
        ),
    ] {
        for i in 0..=8 {
            let angle = start + i as f32 / 8. * std::f32::consts::FRAC_PI_2;
            let pos = center + radius * egui::vec2(angle.cos(), angle.sin());
            mesh.colored_vertex(pos, color(pos.y));
        }
    }
    let n = mesh.vertices.len() as u32;
    for i in 1..n {
        mesh.add_triangle(0, i, if i + 1 == n { 1 } else { i + 1 });
    }
    painter.add(egui::Shape::mesh(mesh));
}
pub(super) fn swatch(painter: &egui::Painter, rect: Rect) {
    let stops = [
        (0., Color32::from_rgb(60, 111, 196)),
        (0.48, Color32::from_rgb(185, 201, 220)),
        (0.52, Color32::from_rgb(90, 82, 75)),
        (1., Color32::from_rgb(43, 39, 37)),
    ];
    for pair in stops.windows(2) {
        gradient(
            painter,
            Rect::from_min_max(
                egui::pos2(rect.left(), rect.top() + rect.height() * pair[0].0),
                egui::pos2(rect.right(), rect.top() + rect.height() * pair[1].0),
            ),
            pair[0].1,
            pair[1].1,
            [0., 0.],
        );
    }
}
fn sky_colors(elevation: f32) -> [Color32; 2] {
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
    let color = |rgb: [u8; 3]| Color32::from_rgb(rgb[0], rgb[1], rgb[2]);
    [
        mix(color(stops[i].1), color(stops[i + 1].1), t),
        mix(color(stops[i].2), color(stops[i + 1].2), t),
    ]
}
fn glow(painter: &egui::Painter, center: Pos2, radius: f32, warm: bool) {
    let mut mesh = egui::Mesh::default();
    let colors = if warm {
        [[255, 197, 138], [255, 154, 92]]
    } else {
        [[255, 244, 220], [255, 233, 192]]
    };
    mesh.colored_vertex(
        center,
        Color32::from_rgba_unmultiplied(colors[0][0], colors[0][1], colors[0][2], 217),
    );
    const N: u32 = 48;
    for (r, color) in [
        (
            0.35,
            Color32::from_rgba_unmultiplied(colors[1][0], colors[1][1], colors[1][2], 89),
        ),
        (1., Color32::TRANSPARENT),
    ] {
        for i in 0..N {
            let angle = i as f32 / N as f32 * std::f32::consts::TAU;
            mesh.colored_vertex(
                center + radius * r * egui::vec2(angle.cos(), angle.sin()),
                color,
            );
        }
    }
    for i in 0..N {
        let a = 1 + i;
        let b = 1 + (i + 1) % N;
        mesh.add_triangle(0, a, b);
        mesh.add_triangle(a, a + N, b);
        mesh.add_triangle(b, a + N, b + N);
    }
    painter.add(egui::Shape::mesh(mesh));
}

pub(super) fn show(ui: &mut egui::Ui, hours: &mut f32) -> egui::Response {
    let width = ui.available_width();
    let (rect, mut response) = ui.allocate_exact_size(
        egui::vec2(width, (width - 2.) * HEIGHT / WIDTH + 2.),
        egui::Sense::click_and_drag(),
    );
    let before = *hours;
    let primary_down =
        response.is_pointer_button_down_on() && ui.input(|i| i.pointer.primary_down());
    if ui.is_enabled()
        && (primary_down
            || response.clicked_by(egui::PointerButton::Primary)
            || response.dragged_by(egui::PointerButton::Primary))
    {
        if let Some(pos) = response.interact_pointer_pos() {
            *hours = quantize(MIN + (pos.x - rect.left()) / rect.width() * (MAX - MIN));
        }
        response.request_focus();
    }
    if response.double_clicked_by(egui::PointerButton::Primary) {
        *hours = 15.;
    }
    if response.has_focus() && ui.is_enabled() {
        ui.input_mut(|i| {
            let step = if i.modifiers.shift { 1. } else { 0.25 };
            let modifiers = i.modifiers;
            for (key, delta) in [
                (egui::Key::ArrowRight, step),
                (egui::Key::ArrowUp, step),
                (egui::Key::ArrowLeft, -step),
                (egui::Key::ArrowDown, -step),
            ] {
                if i.consume_key(modifiers, key) {
                    *hours = quantize(*hours + delta);
                }
            }
            if i.consume_key(modifiers, egui::Key::Home) {
                *hours = MIN;
            }
            if i.consume_key(modifiers, egui::Key::End) {
                *hours = MAX;
            }
        });
    }
    *hours = hours.clamp(MIN, MAX);
    if *hours != before {
        response.mark_changed();
    }
    response
        .widget_info(|| egui::WidgetInfo::slider(ui.is_enabled(), *hours as f64, "Time of day"));
    let response = response
        .on_hover_cursor(egui::CursorIcon::ResizeHorizontal)
        .on_hover_text("Drag to set the time of day; double-click to reset");
    let painter = ui.painter_at(rect.expand(4.));
    let inner = rect.shrink(1.);
    let scale = inner.width() / WIDTH;
    let pos = |x, y| inner.left_top() + scale * egui::vec2(x, y);
    let horizon = pos(0., HORIZON).y;
    let sky_rect = Rect::from_min_max(inner.min, egui::pos2(inner.right(), horizon));
    let ground_rect = Rect::from_min_max(egui::pos2(inner.left(), horizon), inner.max);
    let e = elevation(*hours);
    let [zenith, sky_horizon] = sky_colors(e);
    gradient(&painter, sky_rect, zenith, sky_horizon, [8., 0.]);
    gradient(
        &painter,
        ground_rect,
        Color32::from_rgb(74, 64, 56),
        Color32::from_rgb(31, 28, 26),
        [0., 8.],
    );
    let point = |time| {
        pos(
            (time - MIN) / (MAX - MIN) * WIDTH,
            HORIZON - elevation(time) / elevation(12.) * 62.,
        )
    };
    let path: Vec<_> = (0..=64)
        .map(|i| point(MIN + (MAX - MIN) * i as f32 / 64.))
        .collect();
    let sky = painter.with_clip_rect(sky_rect);
    sky.extend(egui::Shape::dashed_line(
        &path,
        Stroke::new(scale, Color32::from_white_alpha(140)),
        2. * scale,
        3. * scale,
    ));
    let sun = point(*hours);
    let warm = (1. - e / 18.).clamp(0., 1.);
    glow(&sky, sun, (30. + 14. * warm) * scale, warm > 0.5);
    let radius = ui.ctx().animate_value_with_time(
        response.id.with("sun-radius"),
        if response.hovered() || response.dragged() {
            7.5
        } else {
            6.5
        },
        0.15,
    );
    sky.circle(
        sun,
        radius * scale,
        if warm > 0.5 {
            Color32::from_rgb(255, 226, 184)
        } else {
            Color32::from_rgb(255, 250, 240)
        },
        Stroke::new(scale, Color32::from_white_alpha(230)),
    );
    painter.line_segment(
        [pos(0., HORIZON), pos(WIDTH, HORIZON)],
        Stroke::new(scale, Color32::from_white_alpha(71)),
    );
    for time in [6., 12., 18.] {
        let x = (time - MIN) / (MAX - MIN) * WIDTH;
        painter.line_segment(
            [pos(x, HORIZON), pos(x, HORIZON + 4.)],
            Stroke::new(scale, Color32::from_white_alpha(77)),
        );
        let offset = if time == 6. {
            -4.
        } else if time == 18. {
            4.
        } else {
            0.
        };
        painter.text(
            pos(x + offset, HEIGHT - 9.),
            if time == 6. {
                egui::Align2::LEFT_BOTTOM
            } else if time == 18. {
                egui::Align2::RIGHT_BOTTOM
            } else {
                egui::Align2::CENTER_BOTTOM
            },
            time_label(time),
            egui::FontId::monospace(9. * scale),
            Color32::from_white_alpha(107),
        );
    }
    if response.dragged() || primary_down || response.has_focus() {
        painter.line_segment(
            [
                egui::pos2(sun.x, horizon),
                egui::pos2(sun.x, inner.bottom()),
            ],
            Stroke::new(1.5 * scale, theme::ACCENT),
        );
    }
    let text = painter.layout_no_wrap(
        time_label(*hours),
        egui::FontId::monospace(11.),
        Color32::WHITE,
    );
    let badge = Rect::from_min_size(
        inner.left_top() + egui::vec2(9., 7.),
        text.size() + egui::vec2(12., 4.),
    );
    painter.rect_filled(badge, 6., Color32::from_black_alpha(71));
    painter.galley(badge.min + egui::vec2(6., 2.), text, Color32::WHITE);
    if response.has_focus() {
        painter.rect_stroke(
            rect.expand(2.),
            11.,
            Stroke::new(2., theme::ACCENT),
            egui::StrokeKind::Outside,
        );
    }
    painter.rect_stroke(
        rect,
        9.,
        Stroke::new(
            1.,
            if response.has_focus() {
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
    ui.ctx()
        .data_mut(|d| d.insert_temp(egui::Id::new("sun-time-rect"), rect));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(
        ctx: &egui::Context,
        hours: &mut f32,
        width: f32,
        enabled: bool,
        time: f64,
        events: Vec<egui::Event>,
    ) -> (egui::Response, bool) {
        let modifiers = events
            .iter()
            .find_map(|e| match e {
                egui::Event::Key { modifiers, .. }
                | egui::Event::PointerButton { modifiers, .. } => Some(*modifiers),
                _ => None,
            })
            .unwrap_or_default();
        let mut events = events;
        events.insert(0, egui::Event::ModifiersChanged(modifiers));
        let mut result = None;
        let mut unconsumed = false;
        let mut output = ctx.run_ui(
            egui::RawInput {
                screen_rect: Some(Rect::from_min_size(
                    Pos2::ZERO,
                    egui::vec2(width + 16., 200.),
                )),
                time: Some(time),
                events,
                ..Default::default()
            },
            |root| {
                egui::CentralPanel::default().show(root, |ui| {
                    ui.set_width(width);
                    ui.add_enabled_ui(enabled, |ui| result = Some(show(ui, hours)));
                    unconsumed = ui.input(|i| i.key_pressed(egui::Key::ArrowRight));
                });
            },
        );
        output.textures_delta.clear();
        (result.unwrap(), unconsumed)
    }
    fn pointer(pos: Pos2, button: egui::PointerButton, pressed: bool) -> Vec<egui::Event> {
        vec![
            egui::Event::PointerMoved(pos),
            egui::Event::PointerButton {
                pos,
                button,
                pressed,
                modifiers: egui::Modifiers::NONE,
            },
        ]
    }
    #[test]
    fn pointer_press_updates_immediately_and_drag_keeps_capture_at_the_edges() {
        let ctx = egui::Context::default();
        let mut time = 15.;
        let (r, _) = frame(&ctx, &mut time, 280., true, 0., vec![]);
        let pos = egui::pos2(r.rect.left() + r.rect.width() * 0.25, r.rect.center().y);
        let (r, _) = frame(
            &ctx,
            &mut time,
            280.,
            true,
            1.,
            pointer(pos, egui::PointerButton::Primary, true),
        );
        assert_eq!(
            time, 8.75,
            "Time must change before release or drag threshold"
        );
        assert!(r.changed());
        let outside = egui::pos2(r.rect.right() + 40., r.rect.center().y);
        frame(
            &ctx,
            &mut time,
            280.,
            true,
            1.1,
            vec![egui::Event::PointerMoved(outside)],
        );
        assert_eq!(time, MAX);
        frame(
            &ctx,
            &mut time,
            280.,
            true,
            1.2,
            pointer(outside, egui::PointerButton::Primary, false),
        );
        frame(
            &ctx,
            &mut time,
            280.,
            true,
            2.,
            pointer(pos, egui::PointerButton::Secondary, true),
        );
        frame(
            &ctx,
            &mut time,
            280.,
            true,
            2.1,
            pointer(pos, egui::PointerButton::Secondary, false),
        );
        assert_eq!(time, MAX, "Secondary clicks must not set the time");
    }
    #[test]
    fn keyboard_uses_web_steps_limits_and_consumes_navigation() {
        let ctx = egui::Context::default();
        let mut time = 15.;
        let (r, _) = frame(&ctx, &mut time, 280., true, 0., vec![]);
        ctx.memory_mut(|m| m.request_focus(r.id));
        for (i, (key, shift, expected)) in [
            (egui::Key::ArrowRight, false, 15.25),
            (egui::Key::ArrowUp, true, 16.25),
            (egui::Key::Home, false, MIN),
            (egui::Key::ArrowLeft, false, MIN),
            (egui::Key::End, false, MAX),
            (egui::Key::ArrowRight, false, MAX),
        ]
        .into_iter()
        .enumerate()
        {
            let (_, unconsumed) = frame(
                &ctx,
                &mut time,
                280.,
                true,
                i as f64 + 1.,
                vec![egui::Event::Key {
                    key,
                    physical_key: None,
                    pressed: true,
                    repeat: false,
                    modifiers: egui::Modifiers {
                        shift,
                        ..Default::default()
                    },
                }],
            );
            assert_eq!(time, expected);
            assert!(!unconsumed, "The focused dial must consume arrow keys");
        }
        frame(
            &ctx,
            &mut time,
            280.,
            false,
            8.,
            vec![egui::Event::Key {
                key: egui::Key::Home,
                physical_key: None,
                pressed: true,
                repeat: false,
                modifiers: egui::Modifiers::NONE,
            }],
        );
        assert_eq!(time, MAX, "Disabled dials must not accept keys");
    }
    #[test]
    fn double_click_resets_and_card_keeps_the_web_aspect_ratio() {
        let ctx = egui::Context::default();
        let mut time = 9.;
        let (r, _) = frame(&ctx, &mut time, 280., true, 0., vec![]);
        let pos = egui::pos2(r.rect.left() + r.rect.width() * 0.25, r.rect.center().y);
        for (clock, pressed) in [(1., true), (1.05, false), (1.1, true), (1.15, false)] {
            frame(
                &ctx,
                &mut time,
                280.,
                true,
                clock,
                pointer(pos, egui::PointerButton::Primary, pressed),
            );
        }
        assert_eq!(time, 15.);
        for width in [224., 280., 340.] {
            let (r, _) = frame(&ctx, &mut time, width, true, 2. + width as f64, vec![]);
            use egui::emath::GuiRounding as _;
            let expected = ((r.rect.width() - 2.) * HEIGHT / WIDTH + 2.).round_ui();
            assert_eq!(
                r.rect.height(),
                expected,
                "The hit rectangle follows egui layout rounding"
            );
        }
        assert_eq!(time_label(quantize(15.07)), "15:05");
        assert_eq!(time_label(MIN), "5:30");
        assert_eq!(time_label(MAX), "18:30");
    }
    #[test]
    fn diagram_elevation_matches_the_shared_sky() {
        for hours in [5.5, 6., 9., 12., 15., 18., 18.5] {
            assert!(
                (elevation(hours) - mutracer_native_probe::viewer_math::sun_position(hours)[0])
                    .abs()
                    < 0.00002
            );
        }
    }
}
