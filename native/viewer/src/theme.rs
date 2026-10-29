//! Visual tokens shared with viewer/src/styles/app.css. Keep native styling here;
//! the browser remains independent and no CSS parser or theme framework is needed.
use eframe::egui::{self, Color32, FontId, Margin, Stroke, TextStyle};

pub const BG: Color32 = Color32::from_rgb(0x11, 0x12, 0x14);
pub const WORKSPACE: Color32 = Color32::from_rgb(0x15, 0x16, 0x1a);
pub const PANEL: Color32 = Color32::from_rgb(0x18, 0x19, 0x1b);
pub const INPUT: Color32 = Color32::from_rgb(0x19, 0x1b, 0x20);
pub const CONTROL: Color32 = Color32::from_rgb(0x2a, 0x2c, 0x33);
pub const CONTROL_HOVER: Color32 = Color32::from_rgb(0x33, 0x36, 0x3f);
pub const CONTROL_BORDER_HOVER: Color32 = Color32::from_rgb(0x4b, 0x50, 0x60);
pub const SCRUB_FILL: Color32 = Color32::from_rgb(0x30, 0x32, 0x38);
pub const ACCENT_SOLID: Color32 = Color32::from_rgb(0xb8, 0x47, 0x25);
pub const BORDER: Color32 = Color32::from_rgb(0x34, 0x37, 0x40);
pub const TEXT: Color32 = Color32::from_rgb(0xe8, 0xe9, 0xed);
pub const MUTED: Color32 = Color32::from_rgb(0xa8, 0xad, 0xb7);
pub const SUBTLE: Color32 = Color32::from_rgb(0x8b, 0x91, 0x9c);
pub const ACCENT: Color32 = Color32::from_rgb(0xec, 0x96, 0x73);
pub const ACCENT_SURFACE: Color32 = Color32::from_rgb(0x32, 0x27, 0x24);
pub const WARNING: Color32 = Color32::from_rgb(0xe6, 0xb7, 0x6a);
pub const ERROR: Color32 = Color32::from_rgb(0xf1, 0x87, 0x87);

pub fn install(ctx: &egui::Context) {
    ctx.set_theme(egui::Theme::Dark);
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = BG;
    visuals.window_fill = PANEL;
    visuals.extreme_bg_color = INPUT;
    visuals.text_edit_bg_color = Some(INPUT);
    visuals.faint_bg_color = WORKSPACE;
    visuals.weak_text_color = Some(SUBTLE);
    visuals.selection.bg_fill = ACCENT_SURFACE;
    visuals.selection.stroke = Stroke::new(1., ACCENT);
    visuals.hyperlink_color = ACCENT;
    visuals.warn_fg_color = WARNING;
    visuals.error_fg_color = ERROR;
    visuals.window_corner_radius = 16.into();
    visuals.menu_corner_radius = 12.into();
    visuals.window_stroke = Stroke::new(1., BORDER);
    visuals.slider_trailing_fill = true;
    visuals.disabled_alpha = 0.4;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1., TEXT);
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1., Color32::from_white_alpha(14));
    for widget in [
        &mut visuals.widgets.inactive,
        &mut visuals.widgets.hovered,
        &mut visuals.widgets.active,
        &mut visuals.widgets.open,
    ] {
        widget.corner_radius = 12.into();
        widget.expansion = 0.;
        widget.bg_stroke = Stroke::new(1., BORDER);
        widget.fg_stroke = Stroke::new(1., TEXT);
    }
    visuals.widgets.inactive.bg_fill = CONTROL;
    visuals.widgets.inactive.weak_bg_fill = CONTROL;
    visuals.widgets.hovered.bg_fill = CONTROL_HOVER;
    visuals.widgets.hovered.weak_bg_fill = CONTROL_HOVER;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1., MUTED);
    visuals.widgets.active.bg_fill = ACCENT_SURFACE;
    visuals.widgets.active.weak_bg_fill = ACCENT_SURFACE;
    visuals.widgets.active.bg_stroke = Stroke::new(1., ACCENT);
    visuals.widgets.open = visuals.widgets.active;
    ctx.set_visuals(visuals);
    ctx.style_mut_of(egui::Theme::Dark, |style| {
        style
            .text_styles
            .insert(TextStyle::Body, FontId::proportional(12.));
        style
            .text_styles
            .insert(TextStyle::Button, FontId::proportional(11.5));
        style
            .text_styles
            .insert(TextStyle::Small, FontId::proportional(10.5));
        style
            .text_styles
            .insert(TextStyle::Heading, FontId::proportional(13.));
        style
            .text_styles
            .insert(TextStyle::Monospace, FontId::monospace(11.));
        style.spacing.item_spacing = egui::vec2(6., 4.);
        style.spacing.button_padding = egui::vec2(8., 3.);
        style.spacing.interact_size = egui::vec2(32., 24.);
        style.spacing.slider_rail_height = 2.;
        style.spacing.slider_width = 130.;
        style.spacing.combo_width = 130.;
        style.spacing.window_margin = Margin::same(16);
    });
}

pub fn panel() -> egui::Frame {
    egui::Frame::new()
        .fill(PANEL)
        .corner_radius(16)
        .inner_margin(10)
        .outer_margin(Margin {
            left: 0,
            right: 8,
            top: 8,
            bottom: 8,
        })
}
