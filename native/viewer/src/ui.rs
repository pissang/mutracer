//! Native viewer layout. Rendering and scene updates stay in Viewer.
use crate::{Change, Viewer, scene::Environment};
use crate::{api, controls, theme};
use eframe::egui;

fn debug_header(ui: &mut egui::Ui, open: &mut bool, times: &[f64]) -> egui::Response {
    let mut response = ui.add_sized(
        [ui.available_width(), 24.],
        egui::Button::new("").frame(false),
    );
    let label = if *open { "Hide debug" } else { "Show debug" };
    response.widget_info(|| {
        egui::WidgetInfo::selected(egui::WidgetType::Button, ui.is_enabled(), *open, label)
    });
    let rect = response.rect;
    ui.ctx()
        .data_mut(|data| data.insert_temp(egui::Id::new("debug-header-rect"), rect));
    ui.painter().text(
        rect.left_center() + egui::vec2(4., 0.),
        egui::Align2::LEFT_CENTER,
        "Debug",
        egui::FontId::proportional(theme::FONT_LABEL),
        theme::TEXT,
    );
    // Keep the timing readout and graph in the header, as in the web viewer.
    let graph = egui::Rect::from_min_size(
        egui::pos2(
            rect.right() - 28. - if *open { 60. } else { 30. },
            rect.center().y - 8.,
        ),
        egui::vec2(if *open { 60. } else { 30. }, 16.),
    );
    ui.painter().text(
        graph.left_center() - egui::vec2(6., 0.),
        egui::Align2::RIGHT_CENTER,
        times
            .last()
            .map_or_else(|| "– ms".into(), |ms| format!("{ms:.1} ms")),
        egui::FontId::monospace(10.5),
        theme::MUTED,
    );
    ui.painter()
        .rect_filled(graph, 3, egui::Color32::from_white_alpha(14));
    let times = &times[times.len().saturating_sub(40)..];
    let mut sorted = times.to_vec();
    sorted.sort_by(f64::total_cmp);
    let max = sorted.get(sorted.len() / 2).copied().unwrap_or(0.).max(1.) * 1.35;
    for (i, ms) in times
        .iter()
        .rev()
        .take((graph.width() / 1.5) as usize)
        .enumerate()
    {
        let right = graph.right() - i as f32 * 1.5;
        let height = ((*ms / max).clamp(0., 1.) as f32 * graph.height()).max(1.);
        ui.painter().rect_filled(
            egui::Rect::from_min_max(
                egui::pos2(right - 1., graph.bottom() - height),
                egui::pos2(right, graph.bottom()),
            ),
            0,
            theme::TEXT,
        );
    }
    let c = rect.right_center() - egui::vec2(9., 0.);
    let direction = if *open { -1. } else { 1. };
    ui.painter().add(egui::Shape::line(
        vec![
            c + egui::vec2(-3., -1.5 * direction),
            c + egui::vec2(0., 1.5 * direction),
            c + egui::vec2(3., -1.5 * direction),
        ],
        egui::Stroke::new(1.2, theme::MUTED),
    ));
    if response.clicked() {
        *open = !*open;
        response.mark_changed();
    }
    response.on_hover_text(label)
}

impl Viewer {
    pub(super) fn panels(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        let record = !self.drag.active()
            && ctx.input(|i| {
                i.pointer.any_down()
                    || i.pointer.any_pressed()
                    || i.pointer.any_released()
                    || i.events.iter().any(|e| {
                        matches!(
                            e,
                            egui::Event::Key { .. } | egui::Event::Text(_) | egui::Event::Paste(_)
                        )
                    })
            });
        let before = record.then(|| crate::history::Snapshot::capture(self));
        self.history.replayed = false;
        self.history.dragging = ctx.input(|i| i.pointer.any_down());
        self.texture_browser.drop_targets.clear();
        if !self.hide_ui {
            self.titlebar(root);
            self.inspector_rail(root);
            if self.inspector_open {
                if self.tab == 5 {
                    self.examples_panel(root);
                } else {
                    self.inspector(root);
                }
            }
            // Narrow windows keep the viewport usable; hiding the inspector makes room for the list.
            if self.scene_open && root.available_width() > 600. {
                self.scene_panel(root);
            }
            self.texture_browser_panel(root);
        }
        self.viewport(root);
        self.workflow_dialogs(&ctx);
        self.environment_browser(&ctx);

        let grip = crate::shell::resize_grip(root);
        if self.startup_smoke.is_some() {
            ctx.data_mut(|data| data.insert_temp(egui::Id::new("smoke-grip"), grip));
        }
        if !ctx.egui_wants_keyboard_input() {
            if ctx.input(|i| i.key_pressed(egui::Key::H)) {
                self.hide_ui = !self.hide_ui;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::E)) {
                self.open_export(&ctx);
            }
            if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Z)) {
                self.undo(ctx.input(|i| i.modifiers.shift));
            }
            for (key, tab) in [
                (egui::Key::Num1, 2),
                (egui::Key::Num2, 1),
                (egui::Key::Num3, 4),
                (egui::Key::Num4, 0),
            ] {
                if ctx.input(|i| i.key_pressed(key)) {
                    self.tab = tab;
                    self.inspector_open = true;
                    self.hide_ui = false;
                }
            }
            if ctx.input(|i| i.key_pressed(egui::Key::Space)) {
                self.toggle_animation_or_render();
            }
            if ctx.input(|i| i.key_pressed(egui::Key::D)) {
                self.denoise = !self.denoise;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::OpenBracket)) {
                self.scene_open = !self.scene_open;
            }
            if ctx.input(|i| i.key_pressed(egui::Key::CloseBracket)) {
                self.inspector_open = !self.inspector_open;
            }
        }
        if let Some(before) = before {
            let after = crate::history::Snapshot::capture(self);
            self.history.record(before, after);
        }
    }
    pub(super) fn toggle_inspector_tab(&mut self, tab: usize) {
        let active = self.inspector_open && self.tab == tab;
        self.inspector_open = !active;
        self.tab = tab;
    }
    fn inspector_rail(&mut self, root: &mut egui::Ui) {
        egui::Panel::right("inspector_rail")
            .exact_size(72.) // 64px rail and the 8px workspace gap.
            .resizable(false)
            .show_separator_line(false)
            .frame(theme::panel().inner_margin(6))
            .show(root, |ui| {
                ui.spacing_mut().button_padding.x = 2.;
                use controls::Icon;
                for (tab, name, icon) in [
                    (2, "Lighting", Icon::Lighting),
                    (1, "Material", Icon::Material),
                    (4, "Camera", Icon::Camera),
                    (0, "Render", Icon::Render),
                ] {
                    let selected = self.inspector_open && self.tab == tab;
                    if controls::category(ui, name, icon, selected).clicked() {
                        self.toggle_inspector_tab(tab);
                    }
                }
            });
    }
    fn examples_panel(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        let mut chosen = None;
        egui::Panel::right("examples")
            .resizable(true)
            .default_size(360.)
            .min_size(290.)
            .max_size(540.)
            .show_separator_line(false)
            .frame(theme::panel().inner_margin(12))
            .show(root, |ui| {
                ui.heading("Examples");
                chosen = self.examples.contents(ui);
            });
        if let Some(id) = chosen {
            self.load_preset(&id, &ctx);
        }
    }
    fn scene_panel(&mut self, root: &mut egui::Ui) {
        egui::Panel::left("scene")
            .resizable(false)
            .exact_size(260.) // 252px scene panel and the 8px outer margin.
            .show_separator_line(false)
            .frame(theme::panel().outer_margin(egui::Margin {
                left: 8,
                right: 0,
                top: 8,
                bottom: 8,
            }))
            .show(root, |ui| {
                ui.horizontal(|ui| {
                    ui.strong("Scene");
                    ui.add(
                        egui::Label::new(
                            egui::RichText::new(&self.model.0.name)
                                .small()
                                .color(theme::SUBTLE),
                        )
                        .truncate(),
                    );
                });
                ui.add(
                    egui::TextEdit::singleline(&mut self.object_query)
                        .hint_text("Search objects")
                        .desired_width(f32::INFINITY),
                );
                controls::panel_separator(ui, 6.);
                egui::Panel::bottom("scene_summary")
                    .show_separator_line(false)
                    .frame(egui::Frame::new().inner_margin(egui::Margin {
                        bottom: 8,
                        ..Default::default()
                    }))
                    .show(ui, |ui| {
                        controls::panel_separator(ui, 0.);
                        ui.add_space(8.);
                        let triangles: usize = self
                            .model
                            .meshes
                            .iter()
                            .map(|mesh| self.model.geometries[mesh.geometry].indices.len() / 3)
                            .sum();
                        ui.columns(3, |columns| {
                            for (ui, (count, label)) in columns.iter_mut().zip([
                                (self.model.meshes.len(), "meshes"),
                                (triangles, "triangles"),
                                (self.model.materials.len(), "materials"),
                            ]) {
                                ui.monospace(if count >= 1000 {
                                    format!("{:.1}k", count as f32 / 1000.)
                                } else {
                                    count.to_string()
                                });
                                ui.label(egui::RichText::new(label).size(10.).color(theme::SUBTLE));
                            }
                        });
                    });
                self.scene_rows(ui);
            });
    }
    fn inspector(&mut self, root: &mut egui::Ui) {
        egui::Panel::right("settings")
            .resizable(false)
            .exact_size(324.) // 316px inspector and the 8px workspace gap.
            .show_separator_line(false)
            .frame(theme::panel().inner_margin(12))
            .show(root, |ui| {
                let title = match self.tab {
                    0 => "Render",
                    1 => "Material",
                    2 => "Lighting",
                    3 => "Object",
                    _ => "Camera",
                };
                let icon = match self.tab {
                    0 => controls::Icon::Render,
                    1 => controls::Icon::Material,
                    2 => controls::Icon::Lighting,
                    3 => controls::Icon::Object,
                    _ => controls::Icon::Camera,
                };
                controls::heading(ui, title, icon);
                controls::panel_separator(ui, 0.);
                egui::ScrollArea::vertical()
                    .id_salt(("inspector", self.tab))
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 7.;
                        ui.add_space(5.);
                        match self.tab {
                            0 => self.render_settings(ui),
                            1 => self.material_settings(ui),
                            2 => self.lighting_settings(ui),
                            3 => self.object_settings(ui),
                            _ => self.camera_settings(ui),
                        }
                    });
            });
    }
    fn render_settings(&mut self, ui: &mut egui::Ui) {
        let previous = self.settings;
        controls::section(ui, "Quality", |ui| {
            controls::parameter(
                ui,
                "Max samples",
                controls::Scrub::new(&mut self.settings.max_samples, 4..=16384).logarithmic(true),
            );
            controls::parameter(
                ui,
                "Bounces",
                controls::Scrub::new(&mut self.settings.bounces, 1..=16),
            );
            let label = self.resolution_label();
            ui.scope(|ui| {
                ui.spacing_mut().combo_height = 320.;
                controls::select(ui, "Resolution", label, |ui| self.resolution_choices(ui));
                controls::select(
                    ui,
                    "Sampling",
                    ["Sobol", "Z-Sobol", "Random"][self.settings.sampling_pattern as usize],
                    |ui| {
                        for (mode, name) in [(0, "Sobol"), (1, "Z-Sobol"), (2, "Random")] {
                            ui.selectable_value(&mut self.settings.sampling_pattern, mode, name);
                        }
                    },
                );
                controls::parameter(
                    ui,
                    "Clamping",
                    controls::Scrub::new(&mut self.settings.clamping, 0.0..=100.0),
                );
            });
        });
        controls::section(ui, "Caustics", |ui| {
            let mut light = self.settings.caustic_flags & 2 != 0;
            controls::toggle(ui, "Light tracing", &mut light);
            let mut photons = self.settings.caustic_flags & 4 != 0;
            controls::toggle(ui, "Photon mapping", &mut photons);
            self.settings.caustic_flags = (self.settings.caustic_flags & !6)
                | if light { 2 } else { 0 }
                | if photons { 4 } else { 0 };
        });
        if previous != self.settings {
            self.dirty(Change::Scene);
        }
        let mut denoise = self.denoise;
        controls::section_toggle(ui, "Denoiser", &mut denoise, |ui, enabled| {
            if enabled {
                controls::select(ui, "Method", self.denoiser_choice.label(), |ui| {
                    ui.selectable_value(
                        &mut self.denoiser_choice,
                        crate::denoiser::Choice::Jnlm,
                        "JNLM",
                    );
                    ui.selectable_value(
                        &mut self.denoiser_choice,
                        crate::denoiser::Choice::Oidn,
                        "OIDN",
                    );
                    let response = ui
                        .add_enabled_ui(self.custom_denoiser.is_some(), |ui| {
                            ui.selectable_value(
                                &mut self.denoiser_choice,
                                crate::denoiser::Choice::Dlss,
                                "DLSS RR",
                            )
                        })
                        .inner;
                    if let Some(reason) = &self.dlss_unavailable {
                        response.on_disabled_hover_text(reason);
                    }
                });
                if self.denoiser_choice != crate::denoiser::Choice::Dlss {
                    controls::toggle(ui, "Live denoise", &mut self.live_denoise);
                }
                if self.denoiser_choice == crate::denoiser::Choice::Dlss
                    && self.camera.f_stop > 0.
                    && !self.camera.orthographic
                {
                    ui.weak("Depth of field uses OIDN");
                }
                if self.denoiser_choice == crate::denoiser::Choice::Jnlm {
                    controls::scalar(ui, "Strength", &mut self.jnlm_settings.strength, 0.1..=3.);
                    controls::section_open(ui, "More parameters", false, |ui| {
                        controls::parameter(
                            ui,
                            "Search radius",
                            controls::Scrub::new(&mut self.jnlm_settings.search_radius, 1..=16),
                        );
                        controls::parameter(
                            ui,
                            "Patch radius",
                            controls::Scrub::new(&mut self.jnlm_settings.patch_radius, 0..=3),
                        );
                        controls::scalar(
                            ui,
                            "Albedo tolerance",
                            &mut self.jnlm_settings.albedo_bandwidth,
                            0.01..=1.,
                        );
                        controls::scalar(
                            ui,
                            "Normal tolerance",
                            &mut self.jnlm_settings.normal_bandwidth,
                            0.005..=0.5,
                        );
                        controls::parameter(
                            ui,
                            "Filter passes",
                            controls::Scrub::new(&mut self.jnlm_settings.iterations, 1..=4),
                        );
                    });
                    if controls::button(ui, "Reset denoiser settings").clicked() {
                        self.jnlm_settings = Default::default();
                    }
                }
                if self.denoiser_choice == crate::denoiser::Choice::Oidn {
                    controls::select(ui, "Model", self.oidn_settings.model.label(), |ui| {
                        for model in [
                            crate::denoiser::OidnModel::Standard,
                            crate::denoiser::OidnModel::Small,
                            crate::denoiser::OidnModel::Large,
                        ] {
                            ui.selectable_value(
                                &mut self.oidn_settings.model,
                                model,
                                model.label(),
                            );
                        }
                    });
                    let tile = self.oidn_settings.max_tile_size;
                    controls::select(
                        ui,
                        "Max tile",
                        if tile == 0 {
                            "Auto".into()
                        } else {
                            format!("{tile} px")
                        },
                        |ui| {
                            ui.selectable_value(&mut self.oidn_settings.max_tile_size, 0, "Auto");
                            for tile in [256, 512, 1024, 2048] {
                                ui.selectable_value(
                                    &mut self.oidn_settings.max_tile_size,
                                    tile,
                                    format!("{tile} px"),
                                );
                            }
                        },
                    );
                    if controls::button(ui, "Reset denoiser settings").clicked() {
                        self.oidn_settings = Default::default();
                    }
                }
                ui.weak(&self.denoise_status);
            }
        });
        self.denoise = denoise;
        controls::section(ui, "Color", |ui| {
            let mut hdr = false;
            ui.add_enabled_ui(false,|ui| { controls::toggle(ui,"HDR output",&mut hdr); }).response.on_disabled_hover_text("This viewer window uses an SDR surface. Native SDK window hosts support HDR on compatible displays.");
            controls::select(
                ui,
                "Tone mapping",
                ["AgX", "ACES", "Cineon", "Reinhard", "Linear"]
                    [self.display_settings.tone_mapping as usize],
                |ui| {
                    for (mode, name) in [
                        (0, "AgX"),
                        (1, "ACES"),
                        (2, "Cineon"),
                        (3, "Reinhard"),
                        (4, "Linear"),
                    ] {
                        ui.selectable_value(&mut self.display_settings.tone_mapping, mode, name);
                    }
                },
            );
            controls::scalar(
                ui,
                "Exposure",
                &mut self.display_settings.exposure,
                0.0..=4.0,
            );
            ui.columns(2, |columns| {
                controls::scalar(
                    &mut columns[0],
                    "Contrast",
                    &mut self.display_settings.contrast,
                    0.5..=1.5,
                );
                controls::scalar(
                    &mut columns[1],
                    "Saturation",
                    &mut self.display_settings.saturation,
                    0.0..=2.0,
                );
                controls::scalar(
                    &mut columns[0],
                    "Temp",
                    &mut self.display_settings.temperature,
                    -1.0..=1.0,
                );
                controls::scalar(
                    &mut columns[1],
                    "Tint",
                    &mut self.display_settings.tint,
                    -1.0..=1.0,
                );
            });
        });
        controls::section_open(ui, "Effects", false, |ui| {
            controls::scalar(
                ui,
                "Bloom",
                &mut self.display_settings.bloom_intensity,
                0.0..=1.0,
            );
            if self.display_settings.bloom_intensity > 0. {
                controls::scalar(
                    ui,
                    "Threshold",
                    &mut self.display_settings.bloom_threshold,
                    0.0..=4.0,
                );
                controls::scalar(
                    ui,
                    "Radius",
                    &mut self.display_settings.bloom_radius,
                    0.0..=1.0,
                );
            }
            controls::scalar(
                ui,
                "Vignette",
                &mut self.display_settings.vignette,
                0.0..=1.0,
            );
        });
        controls::section(ui, "Device", |ui| {
            let old = self.backend;
            controls::select(
                ui,
                "Ray tracing",
                ["Software", "HWRT"][self.backend as usize],
                |ui| {
                    for (mode, name) in [(1, "HWRT"), (0, "Software")] {
                        ui.selectable_value(&mut self.backend, mode, name);
                    }
                },
            );
            if old != self.backend {
                self.dirty(Change::Scene);
            }
            ui.weak(&self.backend_status);
        });
    }
    fn debug_overlay(&mut self, ctx: &egui::Context, viewport: egui::Rect) -> egui::Rect {
        egui::Area::new(egui::Id::new("debug-overlay"))
            .order(egui::Order::Foreground)
            .fixed_pos(viewport.left_top() + egui::vec2(10., 10.))
            .show(ctx, |ui| {
                let margin = if self.debug_open { 10 } else { 6 };
                theme::panel().inner_margin(margin).show(ui, |ui| {
                    ui.set_width(if self.debug_open { 270. } else { 160. });
                    let times: Vec<_> = self
                        .target
                        .sample_times
                        .lock()
                        .unwrap()
                        .iter()
                        .copied()
                        .collect();
                    if debug_header(ui, &mut self.debug_open, &times).changed() {
                        let path = crate::examples::cache_root();
                        let _ = std::fs::create_dir_all(&path);
                        let _ =
                            std::fs::write(path.join("debug.json"), self.debug_open.to_string());
                    }
                    if !self.debug_open {
                        return;
                    }
                    if self.debug_open {
                        let channels = [
                            (0, "Final"),
                            (1, "Normal"),
                            (2, "Albedo"),
                            (5, "Depth"),
                            (6, "Position"),
                            (7, "Roughness"),
                            (8, "Diffuse reflectance"),
                            (9, "Specular reflectance"),
                            (10, "ID"),
                            (11, "Motion"),
                        ];
                        let label = channels
                            .iter()
                            .find(|(v, _)| *v == self.display_settings.output)
                            .map_or("Final", |(_, label)| *label);
                        controls::select(ui, "Output", label, |ui| {
                            for (mode, name) in channels {
                                ui.selectable_value(&mut self.display_settings.output, mode, name);
                            }
                        });
                        {
                            match self.display_settings.output {
                                5 => {
                                    controls::scalar(
                                        ui,
                                        "Depth range",
                                        &mut self.aov_display.depth_range[1],
                                        0.01..=10000.,
                                    );
                                }
                                6 => {
                                    controls::scalar(
                                        ui,
                                        "Position scale",
                                        &mut self.aov_display.position_scale,
                                        0.001..=10000.,
                                    );
                                }
                                11 => {
                                    controls::scalar(
                                        ui,
                                        "Motion scale",
                                        &mut self.aov_display.motion_scale,
                                        0.01..=1000.,
                                    );
                                }
                                10 => {
                                    let components = [
                                        (api::AovIdComponent::Object, "Object"),
                                        (api::AovIdComponent::Instance, "Instance"),
                                        (api::AovIdComponent::Material, "Material"),
                                        (api::AovIdComponent::Primitive, "Primitive"),
                                    ];
                                    let label =
                                        components[self.aov_display.id_component as usize].1;
                                    controls::select(ui, "ID component", label, |ui| {
                                        for (value, name) in components {
                                            ui.selectable_value(
                                                &mut self.aov_display.id_component,
                                                value,
                                                name,
                                            );
                                        }
                                    });
                                }
                                _ => {}
                            }
                        }

                        controls::toggle(ui, "Interactive preview", &mut self.preview_enabled);
                        if self.preview_enabled {
                            controls::scalar(
                                ui,
                                "Max preview scale",
                                &mut self.preview_scale,
                                0.25..=1.,
                            );
                        }
                        controls::panel_separator(ui, 6.);
                        let diagnostics = self.target.engine.diagnostics();
                        ui.small(format!(
                            "{} · {}",
                            diagnostics.info.adapter_name, self.backend_status
                        ));
                        ui.small(format!(
                            "Drawing buffer  {} × {}",
                            self.pixel_size[0], self.pixel_size[1]
                        ));
                        ui.small(format!(
                            "Shader cache  {} variants · {} hits",
                            diagnostics.cached_pipelines, diagnostics.pipeline_cache_hits
                        ));
                        ui.small(format!("Textures  {}", self.model.textures.len()));
                        if self.denoise && self.live_denoise {
                            ui.weak("Live denoise also runs while interacting.");
                        }
                    }
                });
            })
            .response
            .rect
    }
    fn material_settings(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if let Some(id) = self.selected_mesh {
                    if controls::frame_selection_button(ui).clicked() {
                        let (min, max) = self.model.mesh_bounds(id);
                        self.camera
                            .frame((min + max) * 0.5, (max - min).length() * 0.5);
                        self.camera_index = None;
                        self.dirty(Change::Camera);
                    }
                }
                ui.vertical(|ui| {
                    ui.set_width(ui.available_width());
                    let name = &self.model.materials[self.selected].name;
                    let object = self
                        .selected_mesh
                        .map(|id| self.model.meshes[id].name.as_str())
                        .filter(|object| *object != name.as_str());
                    let label = egui::Label::new(egui::RichText::new(name).strong())
                        .halign(egui::Align::Min)
                        .truncate();
                    if object.is_some() {
                        ui.add(label).on_hover_text(name);
                    } else {
                        ui.allocate_ui_with_layout(
                            egui::vec2(ui.available_width(), 26.),
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| ui.add(label).on_hover_text(name),
                        );
                    }
                    if let Some(object) = object {
                        ui.add(
                            egui::Label::new(
                                egui::RichText::new(object).small().color(theme::SUBTLE),
                            )
                            .truncate(),
                        )
                        .on_hover_text(object);
                    }
                });
            });
        });
        ui.add_space(6.);
        controls::segmented(
            ui,
            "Preset category",
            &mut self.texture_browser.preset_category,
            &[(0, "Basic"), (1, "Metal"), (2, "Glass"), (3, "Soft")],
        );
        let category = ["basic", "metal", "glass", "soft"][self.texture_browser.preset_category];
        let presets: Vec<_> = crate::material_presets::presets()
            .iter()
            .filter(|p| p.category == category)
            .collect();
        let width = (ui.available_width() - 18.) / 4.;
        for presets in presets.chunks(4) {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.;
                for preset in presets {
                    let texture = preset.texture(ui.ctx());
                    let response = ui.add_sized(
                        [width, width + 24.],
                        egui::Button::new("")
                            .fill(theme::INPUT)
                            .stroke(egui::Stroke::new(1., theme::BORDER))
                            .corner_radius(9),
                    );
                    response.widget_info(|| {
                        egui::WidgetInfo::labeled(
                            egui::WidgetType::Button,
                            ui.is_enabled(),
                            format!("Apply {} preset", preset.label),
                        )
                    });
                    egui::Image::from_texture(&texture)
                        .corner_radius(egui::CornerRadius {
                            nw: 8,
                            ne: 8,
                            sw: 0,
                            se: 0,
                        })
                        .paint_at(
                            ui,
                            egui::Rect::from_min_size(
                                response.rect.min + egui::vec2(1., 1.),
                                egui::vec2(width - 2., width - 2.),
                            ),
                        );
                    let label = egui::WidgetText::from(
                        egui::RichText::new(&preset.label)
                            .size(9.5)
                            .color(theme::MUTED),
                    )
                    .into_galley(
                        ui,
                        Some(egui::TextWrapMode::Truncate),
                        (width - 6.).max(1.),
                        egui::TextStyle::Small,
                    );
                    ui.painter().galley(
                        response.rect.center_bottom() - egui::vec2(label.size().x / 2., 18.),
                        label,
                        theme::MUTED,
                    );
                    if response
                        .on_hover_text(format!("Apply {} preset", preset.label))
                        .clicked()
                    {
                        self.texture_browser.cancel();
                        preset.apply(&mut self.model.0.materials[self.selected]);
                        self.dirty(Change::Material);
                    }
                }
            });
        }
        if crate::textures::browse_button(ui, self.texture_browser.open).clicked() {
            self.texture_browser.open = !self.texture_browser.open;
        }
        let material = &mut self.model.0.materials[self.selected];
        let mut changed = false;
        ui.push_id(self.selected, |ui| {
            controls::section(ui, "Base", |ui| {
                changed |= controls::color(ui, "Color", &mut material.color).changed();
                changed |= controls::scalar(ui, "Roughness", &mut material.roughness, 0.0..=1.0);
                changed |= controls::scalar(ui, "Metalness", &mut material.metalness, 0.0..=1.0);
                changed |= controls::scalar(ui, "IOR", &mut material.ior, 1.0..=3.0);
            });
            controls::section_open(ui, "Transmission", material.transmission > 0., |ui| {
                changed |= controls::scalar(ui, "Weight", &mut material.transmission, 0.0..=1.0);
                changed |=
                    controls::color(ui, "Color", &mut material.layers.transmission_color).changed();
                changed |= controls::scalar(
                    ui,
                    "Depth (m)",
                    &mut material.layers.transmission_depth,
                    0.0..=5.0,
                );
                changed |=
                    controls::scalar(ui, "Dispersion", &mut material.layers.dispersion, 0.0..=1.0);
                changed |=
                    controls::toggle(ui, "Thin walled", &mut material.layers.thin_walled).changed();
            });
            controls::section_open(ui, "Coat", material.layers.coat_weight > 0., |ui| {
                changed |=
                    controls::scalar(ui, "Weight", &mut material.layers.coat_weight, 0.0..=1.0);
                changed |= controls::scalar(
                    ui,
                    "Roughness",
                    &mut material.layers.coat_roughness,
                    0.0..=1.0,
                );
                changed |= controls::scalar(ui, "IOR", &mut material.layers.coat_ior, 1.0..=3.0);
                changed |= controls::color(ui, "Tint", &mut material.layers.coat_color).changed();
            });
            controls::section_open(
                ui,
                "Subsurface",
                material.layers.subsurface_weight > 0.,
                |ui| {
                    changed |= controls::scalar(
                        ui,
                        "Weight",
                        &mut material.layers.subsurface_weight,
                        0.0..=1.0,
                    );
                    changed |= controls::color(ui, "Color", &mut material.layers.subsurface_color)
                        .changed();
                    changed |= controls::scalar(
                        ui,
                        "Radius",
                        &mut material.layers.subsurface_radius,
                        0.0..=2.0,
                    );
                },
            );
            controls::section_open(ui, "Fuzz", material.layers.fuzz_weight > 0., |ui| {
                changed |=
                    controls::scalar(ui, "Weight", &mut material.layers.fuzz_weight, 0.0..=1.0);
                changed |= controls::color(ui, "Color", &mut material.layers.fuzz_color).changed();
                changed |= controls::scalar(
                    ui,
                    "Roughness",
                    &mut material.layers.fuzz_roughness,
                    0.0..=1.0,
                );
            });
            controls::section_open(ui, "Thin film", material.layers.film_weight > 0., |ui| {
                changed |=
                    controls::scalar(ui, "Weight", &mut material.layers.film_weight, 0.0..=1.0);
                changed |= controls::scalar(
                    ui,
                    "Thickness (µm)",
                    &mut material.layers.film_thickness,
                    0.0..=2.0,
                );
                changed |= controls::scalar(ui, "IOR", &mut material.layers.film_ior, 1.0..=3.0);
            });
            let emitting =
                material.emission_strength > 0. && material.emission.iter().any(|v| *v > 0.);
            controls::section_open(ui, "Emission", emitting, |ui| {
                changed |= controls::color(ui, "Color", &mut material.emission).changed();
                changed |=
                    controls::scalar(ui, "Luminance", &mut material.emission_strength, 0.0..=50.0);
            });
            controls::section_open(ui, "Advanced", false, |ui| {
                changed |=
                    controls::scalar(ui, "Anisotropy", &mut material.layers.anisotropy, 0.0..=1.0);
                changed |= controls::scalar(
                    ui,
                    "Diffuse roughness",
                    &mut material.layers.diffuse_roughness,
                    0.0..=1.0,
                );
                changed |= controls::scalar(
                    ui,
                    "Specular weight",
                    &mut material.layers.specular_weight,
                    0.0..=1.0,
                );
                changed |= controls::scalar(ui, "Bevel", &mut material.layers.bevel, 0.0..=0.05);
                let previous = material.alpha_mode;
                controls::select(
                    ui,
                    "Alpha",
                    ["Auto", "Opaque", "Mask", "Blend"][material.alpha_mode as usize],
                    |ui| {
                        for (value, label) in
                            [(0, "Auto"), (1, "Opaque"), (2, "Mask"), (3, "Blend")]
                        {
                            ui.selectable_value(&mut material.alpha_mode, value, label);
                        }
                    },
                );
                changed |= previous != material.alpha_mode;
                ui.add_enabled_ui(material.alpha_mode != 1, |ui| {
                    changed |= controls::scalar(ui, "Opacity", &mut material.opacity, 0.0..=1.0);
                })
                .response
                .on_hover_text("Opacity applies in Auto, Mask or Blend alpha mode.");
                ui.add_enabled_ui(material.maps[1] != u32::MAX, |ui| {
                    changed |= controls::scalar(
                        ui,
                        "Normal scale",
                        &mut material.normal_scale,
                        -2.0..=2.0,
                    );
                })
                .response
                .on_hover_text("Requires a normal map.");
                changed |=
                    controls::toggle(ui, "Double sided", &mut material.double_sided).changed();
                changed |= controls::toggle(ui, "Unlit", &mut material.unlit).changed();
                if material.alpha_mode == 2 {
                    changed |=
                        controls::scalar(ui, "Alpha cutoff", &mut material.alpha_cutoff, 0.0..=1.0);
                }
            });
        });
        controls::section_open(ui, "Displacement", true, |ui| {
            let material = &mut self.model.0.materials[self.selected];
            changed |= controls::scalar(
                ui,
                "Scale",
                &mut material.layers.displacement_scale,
                -self.model.0.radius * 0.1..=self.model.0.radius * 0.1,
            );
            changed |= controls::scalar(
                ui,
                "Bias",
                &mut material.layers.displacement_bias,
                -self.model.0.radius * 0.1..=self.model.0.radius * 0.1,
            );
            changed |= controls::scalar(
                ui,
                "Step size",
                &mut material.layers.displacement_step,
                0. ..=self.model.0.radius * 0.01,
            );
            let before = material.layers.displacement_projection;
            controls::select(
                ui,
                "Projection",
                ["UV", "Triplanar", "Spherical", "Cylindrical"][before as usize],
                |ui| {
                    for (id, label) in [
                        (0, "UV"),
                        (1, "Triplanar"),
                        (2, "Spherical"),
                        (3, "Cylindrical"),
                    ] {
                        ui.selectable_value(
                            &mut material.layers.displacement_projection,
                            id,
                            label,
                        );
                    }
                },
            );
            changed |= before != material.layers.displacement_projection;
            changed |= controls::scalar(
                ui,
                "Projection scale",
                &mut material.layers.displacement_projection_scale,
                0.01..=10.,
            );
            ui.small("Offset = texture × Scale + Bias, in mesh-local units. Requires a displacement texture. Adds preparation and render time.");
        });
        let textured = self.model.0.materials[self.selected]
            .maps
            .iter()
            .any(|id| *id != u32::MAX);
        controls::section_open(ui, "Textures", textured, |ui| {
            for &(slot, label, hint) in crate::textures::SLOTS {
                let id = self.model.0.materials[self.selected].maps[slot];
                ui.push_id((self.selected, slot), |ui| {
                    let row = ui.horizontal(|ui| {
                        let response = if let Some(texture) = self.model.0.textures.get(id as usize)
                        {
                            let handle = self.texture_browser.preview(
                                self.selected,
                                slot,
                                texture,
                                ui.ctx(),
                            );
                            ui.add(egui::Button::image(
                                egui::Image::from_texture(&handle)
                                    .fit_to_exact_size(egui::vec2(40., 40.)),
                            ))
                        } else {
                            ui.add_sized([40., 40.], egui::Button::new("+"))
                        };
                        if response
                            .on_hover_text(format!("Upload or replace {label}"))
                            .clicked()
                        {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("Image", &["png", "jpg", "jpeg", "webp"])
                                .pick_file()
                            {
                                self.texture_browser.upload(
                                    &self.model,
                                    self.selected,
                                    slot,
                                    path,
                                    ui.ctx(),
                                );
                            }
                        }
                        ui.vertical(|ui| {
                            ui.label(label);
                            ui.small(hint);
                            if let Some(texture) = self.model.0.textures.get(id as usize) {
                                ui.small(format!("{} × {}", texture.width, texture.height));
                            }
                        });
                        if id != u32::MAX
                            && controls::button(ui, "×")
                                .on_hover_text(format!("Remove {label}"))
                                .clicked()
                        {
                            self.texture_browser.cancel();
                            match self
                                .model
                                .replace_textures(self.selected, vec![(slot, None)])
                            {
                                Ok(()) => changed = true,
                                Err(e) => self.error = e.to_string(),
                            }
                        }
                    });
                    self.texture_browser.drop_targets.push((
                        row.response.rect,
                        self.selected,
                        slot,
                    ));
                    let id = self.model.0.materials[self.selected].maps[slot];
                    if let Some(texture) = self.model.0.textures.get(id as usize) {
                        let mut wrap = texture.wrap;
                        let mut scale = texture.scale;
                        controls::section_open(ui, "Wrap & repeat", false, |ui| {
                            if controls::texture_sampling(ui, &mut wrap, &mut scale) {
                                self.texture_browser.cancel();
                                match self.model.set_texture_sampling(
                                    self.selected,
                                    slot,
                                    wrap,
                                    scale,
                                ) {
                                    Ok(edited) => changed |= edited,
                                    Err(e) => self.error = e.to_string(),
                                }
                            }
                        });
                    }
                });
            }
        });
        if changed {
            self.dirty(Change::Material);
        }
    }

    fn lighting_settings(&mut self, ui: &mut egui::Ui) {
        let previous_studio = self.environment.studio.clone();
        let mut changed = false;
        let was_studio = self.environment.studio.enabled;
        controls::segmented(
            ui,
            "Lighting",
            &mut self.environment.studio.enabled,
            &[(false, "Environment"), (true, "Studio")],
        );
        changed |= was_studio != self.environment.studio.enabled;
        if self.environment.studio.enabled {
            controls::section(ui, "Studio", |ui| {
                let studio = &mut self.environment.studio;
                let previous = studio.clone();
                let width = (ui.available_width() - 6.) / 2.;
                for row in crate::studio::presets().chunks(2).enumerate() {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.;
                        for (column, preset) in row.1.iter().enumerate() {
                            let id = row.0 * 2 + column;
                            if controls::preset_card(
                                ui,
                                width,
                                &preset.name,
                                &preset.tag,
                                studio.preset == id,
                            )
                            .clicked()
                            {
                                studio.preset = id;
                            }
                        }
                    });
                }
                controls::scalar(ui, "Intensity", &mut studio.intensity, 0.0..=4.0);
                controls::parameter(
                    ui,
                    "Rotation",
                    controls::Scrub::new(&mut studio.rotation, -180.0..=180.0)
                        .max_decimals(0)
                        .suffix("°"),
                );
                controls::parameter(
                    ui,
                    "Size",
                    controls::Scrub::new(&mut studio.size, 0.25..=3.0).suffix("×"),
                );
                controls::scalar(ui, "Ambient", &mut studio.ambient, 0.0..=1.0);
                controls::color(ui, "Ambient color", &mut studio.ambient_color);
                changed |= previous != *studio;
            });
        } else {
            controls::section(ui, "Environment", |ui| {
                ui.add(
                    egui::Label::new(
                        egui::RichText::new(&self.environment.name).color(theme::MUTED),
                    )
                    .truncate(),
                );
                ui.horizontal_wrapped(|ui| {
                    if controls::button(ui, "Browse Poly Haven HDRIs").clicked() {
                        self.environments.open = true;
                    }
                    if controls::button(ui, "Load HDR…").clicked() {
                        if let Some(path) = rfd::FileDialog::new()
                            .add_filter("Radiance HDR", &["hdr"])
                            .pick_file()
                        {
                            match self.environment.load(&path) {
                                Ok(()) => {
                                    self.environment.model_lighting = false;
                                    changed = true;
                                }
                                Err(e) => self.error = format!("Could not load environment: {e:#}"),
                            }
                        }
                    }
                    if self.model.1.available && controls::button(ui, "Scene lighting").clicked() {
                        self.environment = self.model.environment_for_load(&self.environment);
                        changed = true;
                    }
                    if controls::button(ui, "Procedural sky").clicked() {
                        self.environment.model_lighting = false;
                        self.environment.image = None;
                        self.environment.color = [1.; 3];
                        self.environment.name = Environment::default().name;
                        self.sky.invalidate();
                        changed = true;
                    }
                });
                if self.environment.name == "Procedural sky" {
                    controls::parameter(
                        ui,
                        "Time of day",
                        controls::Scrub::new(&mut self.sky.time, 5.5..=18.5).suffix(" h"),
                    );
                }
                changed |= controls::parameter(
                    ui,
                    "Intensity",
                    controls::Scrub::new(&mut self.environment.intensity, 0.0..=4.0),
                )
                .changed();
                changed |= controls::parameter(
                    ui,
                    "Rotation",
                    controls::Scrub::new(&mut self.environment.rotation, 0.0..=360.0).suffix("°"),
                )
                .changed();
                changed |= controls::color(ui, "Tint", &mut self.environment.color).changed();
            });
        }
        controls::section(ui, "Background", |ui| {
            let old = if self.environment.background {
                if self.environment.grounded && !self.environment.studio.enabled {
                    3
                } else {
                    0
                }
            } else if self.environment.background_alpha > 0. {
                1
            } else {
                2
            };
            let mut mode = old;
            let options = [
                (
                    0,
                    if self.environment.studio.enabled {
                        "Studio"
                    } else {
                        "Environment"
                    },
                ),
                (3, "Grounded"),
                (1, "Color"),
                (2, "Transparent"),
            ];
            for row in options.chunks(2) {
                ui.columns(2, |columns| {
                    for (ui, &(value, label)) in columns.iter_mut().zip(row) {
                        if ui
                            .add_sized(
                                [ui.available_width(), theme::CONTROL_HEIGHT],
                                egui::Button::selectable(mode == value, label),
                            )
                            .clicked()
                        {
                            mode = value;
                        }
                    }
                });
            }
            if mode != old {
                self.environment.background = mode == 0 || mode == 3;
                self.environment.grounded = mode == 3;
                self.environment.background_alpha = if mode == 2 { 0. } else { 1. };
                changed = true;
            }
            if mode == 3 {
                let mut height = self
                    .environment
                    .grounded_height
                    .unwrap_or((self.model.radius * 4.).max(1.6));
                let mut radius = self.environment.grounded_radius.unwrap_or(height * 20.);
                if controls::scalar(ui, "Height", &mut height, 0.1..=50.) {
                    height = height.clamp(0.001, 1e6);
                    if self
                        .environment
                        .grounded_radius
                        .is_some_and(|r| r <= height)
                    {
                        self.environment.grounded_radius = Some(height * 20.);
                    }
                    self.environment.grounded_height = Some(height);
                    changed = true;
                }
                if controls::scalar(ui, "Radius", &mut radius, height + 0.1..=1000.) {
                    self.environment.grounded_radius = Some(radius.max(height + 0.001));
                    changed = true;
                }
                if controls::button(ui, "Use auto").clicked() {
                    self.environment.grounded_height = None;
                    self.environment.grounded_radius = None;
                    changed = true;
                }
            }
            if mode == 1 {
                changed |=
                    controls::color(ui, "Color", &mut self.environment.background_color).changed();
            }
            if mode == 2 {
                ui.weak("The environment still lights the scene. PNG keeps transparency.");
            }
        });
        if changed {
            self.dirty(
                if previous_studio.enabled != self.environment.studio.enabled
                    || previous_studio.preset != self.environment.studio.preset
                {
                    Change::Scene
                } else {
                    Change::Environment
                },
            );
        }
        let before = self.environment.ground_shadow;
        let mut ground_shadow = before;
        controls::section_toggle(ui, "Ground shadow", &mut ground_shadow, |ui, enabled| {
            if enabled {
                controls::scalar(
                    ui,
                    "Opacity",
                    &mut self.display_settings.shadow_catcher_alpha,
                    0.0..=1.0,
                );
            }
        });
        self.environment.ground_shadow = ground_shadow;
        if before != ground_shadow {
            self.dirty(Change::Scene);
        }
        let mut light_changed = false;
        let was_enabled = self.light.enabled;
        controls::section(ui, "Key light", |ui| {
            controls::toggle(ui, "Directional light", &mut self.light.enabled);
            ui.add_enabled_ui(self.light.enabled, |ui| {
                light_changed |= controls::parameter(
                    ui,
                    "Intensity",
                    controls::Scrub::new(&mut self.light.intensity, 0.0..=10.0),
                )
                .changed();
                light_changed |= controls::color(ui, "Color", &mut self.light.color).changed();
                light_changed |= controls::parameter(
                    ui,
                    "Azimuth",
                    controls::Scrub::new(&mut self.light.azimuth, 0.0..=360.0).suffix("°"),
                )
                .changed();
                light_changed |= controls::parameter(
                    ui,
                    "Elevation",
                    controls::Scrub::new(&mut self.light.elevation, 5.0..=85.0).suffix("°"),
                )
                .changed();
            });
        });
        if was_enabled != self.light.enabled {
            self.dirty(Change::Scene);
        } else if light_changed {
            self.dirty(Change::Light);
        }
    }
    fn object_settings(&mut self, ui: &mut egui::Ui) {
        if let Some(id) = self.selected_mesh {
            ui.add(
                egui::Label::new(
                    egui::RichText::new(&self.model.0.meshes[id].name).color(theme::ACCENT),
                )
                .truncate(),
            );
            let mesh = &mut self.model.0.meshes[id];
            let before = mesh.transform;
            let mut position = mesh.transform.w_axis.truncate();
            let mut changed = false;
            controls::section(ui, "Transform", |ui| {
                ui.weak("World position");
                for (label, value) in [
                    ("X", &mut position.x),
                    ("Y", &mut position.y),
                    ("Z", &mut position.z),
                ] {
                    changed |=
                        controls::number(ui, label, value, self.model.0.radius as f64 * 0.005)
                            .changed();
                }
                if changed {
                    mesh.transform.w_axis = position.extend(1.);
                }
                ui.horizontal(|ui| {
                    for (label, degrees) in [("Y −15°", -15f32), ("Y +15°", 15f32)] {
                        if controls::button(ui, label).clicked() {
                            mesh.transform *= glam::Mat4::from_rotation_y(degrees.to_radians());
                            changed = true;
                        }
                    }
                });
                ui.horizontal(|ui| {
                    for (label, scale) in [("Smaller", 1. / 1.1), ("Larger", 1.1)] {
                        if controls::button(ui, label).clicked() {
                            let candidate =
                                mesh.transform * glam::Mat4::from_scale(glam::Vec3::splat(scale));
                            let determinant = candidate.determinant();
                            if candidate.is_finite()
                                && determinant.is_finite()
                                && determinant.abs() >= 1e-10
                                && determinant.abs() <= 1e12
                            {
                                mesh.transform = candidate;
                                changed = true;
                            }
                        }
                    }
                });
            });
            if changed {
                if let Some(animation) = &mut self.model.0.animation {
                    animation.edit_transform(id, before, self.model.0.meshes[id].transform);
                }
                self.model.refresh_bounds();
                self.dirty(Change::Transform);
            }
        } else {
            ui.weak("Select an object in the scene list or viewport to edit its transform.");
        }
        controls::section(ui, "Scene info", |ui| {
            ui.weak(format!(
                "{} meshes · {} triangles",
                self.model.0.meshes.len(),
                self.model
                    .geometries
                    .iter()
                    .map(|g| g.indices.len() / 3)
                    .sum::<usize>()
            ));
            for warning in &self.model.0.warnings {
                ui.colored_label(theme::WARNING, warning);
            }
        });
    }
    fn camera_settings(&mut self, ui: &mut egui::Ui) {
        let mut changed = false;
        controls::section(ui, "View", |ui| {
            if !self.model.1.cameras.is_empty() {
                let previous = self.camera_index;
                let label = self
                    .camera_index
                    .and_then(|i| self.model.1.cameras.get(i))
                    .map(|v| v.name.as_str())
                    .unwrap_or("Orbit camera");
                controls::select(ui, "Camera", label, |ui| {
                    ui.selectable_value(&mut self.camera_index, None, "Orbit camera");
                    for (i, view) in self.model.1.cameras.iter().enumerate() {
                        ui.selectable_value(&mut self.camera_index, Some(i), &view.name);
                    }
                });
                if previous != self.camera_index {
                    if let Some(index) = self.camera_index {
                        self.model.1.cameras[index].apply(&mut self.camera, self.model.center);
                    }
                    changed = true;
                }
            }
            controls::toggle(ui, "Auto-rotate", &mut self.auto_rotate);
            ui.add_enabled_ui(self.camera_index.is_none(), |ui| {
                let before = self.camera.orthographic;
                controls::segmented(
                    ui,
                    "Projection",
                    &mut self.camera.orthographic,
                    &[(false, "Perspective"), (true, "Orthographic")],
                );
                changed |= before != self.camera.orthographic;
                ui.add_enabled_ui(!self.camera.orthographic, |ui| {
                    changed |= controls::parameter(
                        ui,
                        "Field of view",
                        controls::Scrub::new(&mut self.camera.fov, 10.0..=100.0)
                            .max_decimals(0)
                            .suffix("°"),
                    )
                    .changed();
                });
            });
            if ui
                .add_sized(
                    [ui.available_width(), theme::CONTROL_HEIGHT],
                    egui::Button::new("Fit to model · F"),
                )
                .clicked()
            {
                self.camera.frame(self.model.0.center, self.model.0.radius);
                self.camera_index = None;
                changed = true;
            }
        });
        let was_dof_enabled = self.camera.f_stop > 0.;
        let mut dof_enabled = was_dof_enabled;
        ui.add_enabled_ui(!self.camera.orthographic, |ui| {
            controls::section_toggle(ui, "Depth of field", &mut dof_enabled, |ui, enabled| {
                if enabled && !was_dof_enabled {
                    self.camera.f_stop = 2.8;
                }
                if enabled {
                    changed |= controls::parameter(
                        ui,
                        "f-number",
                        controls::Scrub::new(&mut self.camera.f_stop, 0.7..=22.)
                            .logarithmic(true)
                            .prefix("f/"),
                    )
                    .changed();
                    if controls::toggle(ui, "Area autofocus", &mut self.focus.enabled).changed() {
                        self.focus.request();
                        self.picking_focus = false;
                    }
                    ui.add_enabled_ui(self.focus.enabled, |ui| {
                        controls::toggle(ui, "Show focus frame", &mut self.focus.show_frame);
                    });
                    let unit = self.camera.meters_per_unit;
                    let mut focus = self.camera.focus_distance * unit;
                    let min = self.model.0.radius * 0.05 * unit;
                    let max =
                        (self.model.0.radius * 60.).max(self.camera.focus_distance * 2.) * unit;
                    if controls::parameter(
                        ui,
                        "Focus (m)",
                        controls::Scrub::new(&mut focus, min..=max)
                            .logarithmic(true)
                            .max_decimals(4),
                    )
                    .changed()
                    {
                        self.camera.focus_distance = focus / unit;
                        self.focus.manual();
                        changed = true;
                    }
                    if !self.focus.enabled
                        && ui
                            .selectable_label(self.picking_focus, "Pick focus point")
                            .clicked()
                    {
                        self.picking_focus = !self.picking_focus;
                    }
                    if self.focus.enabled {
                        ui.weak(match self.focus.status {
                            crate::focus::Status::Locked => "Focus locked",
                            crate::focus::Status::Missed => "No surface in focus area · focus kept",
                            _ => "Focusing…",
                        });
                    }
                    let old = self.camera.meters_per_unit;
                    controls::select(
                        ui,
                        "Scene unit",
                        if self.auto_units {
                            "Auto"
                        } else {
                            match old {
                                0.001 => "Millimetres",
                                0.01 => "Centimetres",
                                0.0254 => "Inches",
                                _ => "Metres",
                            }
                        },
                        |ui| {
                            if ui.selectable_label(self.auto_units, "Auto").clicked() {
                                self.auto_units = true;
                                self.camera.meters_per_unit = self.model.guessed_units();
                            }
                            for (value, name) in [
                                (0.001, "Millimetres"),
                                (0.01, "Centimetres"),
                                (0.0254, "Inches"),
                                (1., "Metres"),
                            ] {
                                if ui
                                    .selectable_value(&mut self.camera.meters_per_unit, value, name)
                                    .clicked()
                                {
                                    self.auto_units = false;
                                }
                            }
                        },
                    );
                    changed |= old != self.camera.meters_per_unit;
                    if self.picking_focus {
                        ui.weak("Click a surface in the viewport to focus.");
                    }
                }
            });
        });
        if dof_enabled != was_dof_enabled {
            if !dof_enabled {
                self.camera.f_stop = 0.;
            } else if self.camera.f_stop == 0. {
                self.camera.f_stop = 2.8;
            }
            self.picking_focus = false;
            changed = true;
        }
        if self.camera.orthographic {
            self.picking_focus = false;
            ui.weak("Orthographic views have no depth of field.");
        }
        if changed {
            self.dirty(Change::Camera);
        }
    }
    fn viewport(&mut self, root: &mut egui::Ui) {
        let ctx = root.ctx().clone();
        if !self.error.is_empty() {
            egui::Window::new("Unable to complete action")
                .collapsible(false).resizable(true).default_width(480.)
                .show(&ctx, |ui| {
                    ui.colored_label(theme::ERROR, &self.error);
                    ui.small("The previous image is kept. You can open another model or change settings.");
                    if controls::button(ui, "Dismiss").clicked() { self.error.clear(); }
                });
        }
        egui::CentralPanel::default()
            .frame(theme::panel().fill(theme::WORKSPACE).outer_margin(6))
            .show(root, |ui| {
                let available = ui.available_size();
                self.update_resolution(&ctx, available);
                let dock_rect = if self.hide_ui {
                    egui::Rect::NOTHING
                } else {
                    self.render_dock(&ctx, ui.max_rect())
                };
                #[cfg(test)]
                ctx.data_mut(|data| {
                    data.insert_temp(egui::Id::new("dock-bounds"), (dock_rect, ui.max_rect()));
                });
                let debug_rect = if self.hide_ui {
                    egui::Rect::NOTHING
                } else {
                    self.debug_overlay(&ctx, ui.max_rect())
                };
                let loading_rect = if self.loading.is_some() {
                    egui::Area::new(egui::Id::new("model-download"))
                        .order(egui::Order::Foreground)
                        .fixed_pos(egui::pos2(
                            ui.max_rect().right() - 260.,
                            ui.max_rect().top() + 10.,
                        ))
                        .show(&ctx, |ui| {
                            theme::panel().inner_margin(10).show(ui, |ui| {
                                ui.set_width(240.);
                                ui.horizontal(|ui| {
                                    ui.spinner();
                                    ui.label(&self.loading_name);
                                });
                                ui.small(&self.examples.progress);
                                if controls::button(ui, "Cancel").clicked() {
                                    self.load_cancel
                                        .store(true, std::sync::atomic::Ordering::Relaxed);
                                    self.loading = None;
                                    self.load_progress = None;
                                    self.examples.progress.clear();
                                }
                            });
                        })
                        .response
                        .rect
                } else {
                    egui::Rect::NOTHING
                };
                let aspect = self.pixel_size[0] as f32 / self.pixel_size[1] as f32;
                let width = available.x.min(available.y * aspect);
                let size = egui::vec2(width, width / aspect);
                let rect = egui::Rect::from_center_size(ui.max_rect().center(), size);
                if !self.environment.background && self.environment.background_alpha == 0. {
                    let checker = self.checker.get_or_insert_with(|| {
                        ctx.load_texture(
                            "Transparency checker",
                            egui::ColorImage::new(
                                [2, 2],
                                vec![
                                    egui::Color32::from_gray(38),
                                    egui::Color32::from_gray(48),
                                    egui::Color32::from_gray(48),
                                    egui::Color32::from_gray(38),
                                ],
                            ),
                            egui::TextureOptions {
                                wrap_mode: egui::TextureWrapMode::Repeat,
                                ..egui::TextureOptions::NEAREST
                            },
                        )
                    });
                    ui.painter().image(
                        checker.id(),
                        rect,
                        egui::Rect::from_min_size(egui::Pos2::ZERO, rect.size() / 24.),
                        egui::Color32::WHITE,
                    );
                }
                if let Some(texture) = self
                    .gpu_texture
                    .as_ref()
                    .map(|(id, _)| *id)
                    .or_else(|| self.texture.as_ref().map(|t| t.id()))
                {
                    ui.painter().image(
                        texture,
                        rect,
                        egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1., 1.)),
                        egui::Color32::WHITE,
                    );
                } else {
                    ui.painter().text(
                        rect.center(),
                        egui::Align2::CENTER_CENTER,
                        if self.running {
                            "Rendering…"
                        } else {
                            "Paused — Resume to render"
                        },
                        egui::FontId::proportional(18.),
                        egui::Color32::GRAY,
                    );
                }
                let response = ui.interact(rect, ui.id().with("viewport"), egui::Sense::drag());
                if self.picking_focus && response.hovered() {
                    ctx.set_cursor_icon(egui::CursorIcon::Crosshair);
                }
                if self.picking_focus && ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
                    self.picking_focus = false;
                }
                let focus_drag = !self.hide_ui && self.focus.frame(ui, rect, &self.camera);
                if focus_drag {
                    self.drag = crate::input::ViewportDrag::default();
                }
                for (pan, delta) in ui.input(|i| {
                    self.drag.motion(
                        rect,
                        !focus_drag && response.contains_pointer(),
                        &[dock_rect, debug_rect, loading_rect],
                        i,
                    )
                }) {
                    if pan {
                        self.camera.pan([delta.x, delta.y]);
                    } else {
                        self.camera.orbit([delta.x, delta.y]);
                    }
                    self.camera_index = None;
                    self.dirty(Change::Camera);
                }
                if let Some(pos) = self.drag.take_click().filter(|p| {
                    rect.contains(*p)
                        && ![dock_rect, debug_rect, loading_rect]
                            .iter()
                            .any(|rect| rect.contains(*p))
                }) {
                    let uv = [
                        (pos.x - rect.min.x) / rect.width(),
                        (pos.y - rect.min.y) / rect.height(),
                    ];
                    if self.picking_focus {
                        if let Some((_, point)) = self.model.pick_hit(&self.camera, uv, aspect) {
                            let forward = (self.camera.target - self.camera.eye()).normalize();
                            self.camera.focus_distance =
                                (point - self.camera.eye()).dot(forward).max(1e-5);
                            self.picking_focus = false;
                            self.dirty(Change::Camera);
                        }
                    } else {
                        self.selected_mesh = self.model.pick(&self.camera, uv, aspect);
                        if let Some(id) = self.selected_mesh {
                            self.selected = self.model.0.meshes[id].material;
                            self.tab = 1;
                            self.inspector_open = true;
                        }
                    }
                }
                if let Some(preset) = &self.model.1.preset {
                    let text = format!(
                        "{} · {}",
                        crate::examples::text(preset, "credit"),
                        crate::examples::text(preset, "license")
                    );
                    ui.scope_builder(
                        egui::UiBuilder::new().max_rect(egui::Rect::from_min_size(
                            egui::pos2(
                                ui.max_rect().left() + 12.,
                                if self.hide_ui {
                                    ui.max_rect().bottom() - 36.
                                } else {
                                    dock_rect.top() - 32.
                                },
                            ),
                            egui::vec2(ui.available_width() - 24., 24.),
                        )),
                        |ui| {
                            ui.hyperlink_to(text, crate::examples::text(preset, "sourceUrl"));
                        },
                    );
                }
                if let Some(id) = self.selected_mesh {
                    ui.painter().text(
                        egui::pos2(rect.left() + 14., debug_rect.bottom() + 10.),
                        egui::Align2::LEFT_TOP,
                        &self.model.0.meshes[id].name,
                        egui::FontId::proportional(14.),
                        theme::ACCENT,
                    );
                }
                if response.hovered()
                    && !dock_rect.contains(ctx.pointer_hover_pos().unwrap_or(egui::Pos2::ZERO))
                    && ![debug_rect, loading_rect].iter().any(|rect| {
                        rect.contains(ctx.pointer_hover_pos().unwrap_or(egui::Pos2::ZERO))
                    })
                {
                    let scroll = ui.input(|i| i.smooth_scroll_delta.y);
                    if scroll != 0. {
                        self.camera.zoom(scroll);
                        self.dirty(Change::Camera);
                    }
                }
            });
        if ctx.input(|i| i.key_pressed(egui::Key::F)) && !ctx.egui_wants_keyboard_input() {
            self.camera.frame(self.model.0.center, self.model.0.radius);
            self.dirty(Change::Camera);
        }
    }
}
