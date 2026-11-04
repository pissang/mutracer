//! Area autofocus through committed GPU depth queries. Only the current request
//! may start a lens pull.
use crate::renderer::Camera;
use eframe::egui;
use mutracer_native_probe::api;
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

const AREA: f32 = 0.07;
const GRID: usize = api::DEPTH_SAMPLE_GRID;
pub enum DepthReply {
    Ready(Option<f32>),
    Unavailable,
    Failed(String),
}
const SETTLE: Duration = Duration::from_millis(160);
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status {
    Waiting,
    Measuring,
    Pulling,
    Locked,
    Missed,
}
struct Pull {
    from: f32,
    to: f32,
    start: Instant,
}
pub struct AutoFocus {
    pub enabled: bool,
    pub show_frame: bool,
    pub area: [f32; 2],
    pub status: Status,
    pub error: Option<String>,
    revision: u64,
    pending: bool,
    changed_at: Instant,
    query: Option<(u64, mpsc::Receiver<DepthReply>)>,
    pull: Option<Pull>,
    drag: Option<egui::Vec2>,
}
impl Default for AutoFocus {
    fn default() -> Self {
        Self {
            enabled: true,
            show_frame: true,
            area: [0.5, 0.5],
            status: Status::Waiting,
            error: None,
            revision: 0,
            pending: true,
            changed_at: Instant::now(),
            query: None,
            pull: None,
            drag: None,
        }
    }
}
impl AutoFocus {
    pub fn request(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.pending = true;
        self.changed_at = Instant::now();
        self.pull = None;
        self.status = Status::Waiting;
    }
    pub fn manual(&mut self) {
        self.enabled = false;
        self.request();
    }
    pub fn active(&self, camera: &Camera) -> bool {
        self.enabled && camera.f_stop > 0. && !camera.orthographic
    }
    pub fn working(&self, camera: &Camera) -> bool {
        self.active(camera) && (self.pending || self.query.is_some() || self.pull.is_some())
    }
    pub fn place(&mut self, area: [f32; 2]) {
        let area = area.map(|v| v.clamp(0.02, 0.98));
        if self.area != area {
            self.area = area;
            self.request();
        }
    }
    pub fn update(
        &mut self,
        start: impl FnOnce([f32; 2]) -> mpsc::Receiver<DepthReply>,
        camera: &mut Camera,
        ready: bool,
        held: bool,
        now: Instant,
        ctx: &egui::Context,
    ) -> bool {
        if !self.active(camera) {
            self.pull = None;
            return false;
        }
        if let Some((revision, query)) = &self.query {
            match query.try_recv() {
                Ok(reply) => {
                    let current = *revision == self.revision && ready && !held;
                    self.query = None;
                    if current {
                        ctx.request_repaint();
                        let depth = match reply {
                            DepthReply::Ready(depth) => depth,
                            DepthReply::Unavailable => {
                                self.pending = true;
                                self.changed_at = now;
                                self.status = Status::Waiting;
                                return false;
                            }
                            DepthReply::Failed(error) => {
                                self.pending = false;
                                self.status = Status::Missed;
                                self.error = Some(error);
                                return false;
                            }
                        };
                        self.pending = false;
                        if let Some(to) = depth {
                            if (to / camera.focus_distance).ln().abs() < 0.004 {
                                self.status = Status::Locked;
                                let changed = camera.focus_distance != to;
                                camera.focus_distance = to;
                                return changed;
                            }
                            self.pull = Some(Pull {
                                from: camera.focus_distance,
                                to,
                                start: now,
                            });
                            self.status = Status::Pulling;
                        } else {
                            self.status = Status::Missed;
                        }
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    let current = *revision == self.revision;
                    self.query = None;
                    if current {
                        self.pending = false;
                        self.status = Status::Missed;
                        ctx.request_repaint();
                    }
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if !ready || held {
            return false;
        }
        if self.pending
            && self.query.is_none()
            && now.saturating_duration_since(self.changed_at) >= SETTLE
        {
            self.query = Some((self.revision, start(self.area)));
            self.status = Status::Measuring;
        }
        if let Some(pull) = &self.pull {
            let (distance, done) = focus_pull(
                pull.from,
                pull.to,
                now.saturating_duration_since(pull.start).as_secs_f64() * 1000.,
            );
            let changed = camera.focus_distance != distance;
            camera.focus_distance = distance;
            if done {
                self.pull = None;
                self.status = Status::Locked;
                ctx.request_repaint();
            }
            return changed;
        }
        false
    }
    pub fn frame(&mut self, ui: &mut egui::Ui, rect: egui::Rect, camera: &Camera) -> bool {
        if !self.active(camera) || !self.show_frame {
            self.drag = None;
            return false;
        }
        let center =
            rect.min + egui::vec2(self.area[0] * rect.width(), self.area[1] * rect.height());
        let handle = egui::Rect::from_center_size(center, egui::vec2(18., 18.));
        let response = ui
            .interact(
                handle,
                ui.id().with("focus-area"),
                egui::Sense::click_and_drag(),
            )
            .on_hover_text("Drag to move focus area. Arrow keys move it; Shift moves faster.");
        let mut consumed = self.drag.is_some();
        let events = ui.input(|i| i.events.clone());
        for event in events {
            match event {
                egui::Event::PointerButton {
                    pos,
                    button: egui::PointerButton::Primary,
                    pressed: true,
                    modifiers,
                } if !modifiers.shift
                    && handle.contains(pos)
                    && ui.ctx().layer_id_at(pos) == Some(ui.layer_id()) =>
                {
                    self.drag = Some(pos - center);
                    consumed = true;
                }
                egui::Event::PointerMoved(pos) if self.drag.is_some() => {
                    let p = pos - self.drag.unwrap();
                    self.place([
                        (p.x - rect.min.x) / rect.width(),
                        (p.y - rect.min.y) / rect.height(),
                    ]);
                    consumed = true;
                }
                egui::Event::PointerButton {
                    pos,
                    button: egui::PointerButton::Primary,
                    pressed: false,
                    ..
                } if self.drag.is_some() => {
                    let p = pos - self.drag.take().unwrap();
                    self.place([
                        (p.x - rect.min.x) / rect.width(),
                        (p.y - rect.min.y) / rect.height(),
                    ]);
                    consumed = true;
                }
                egui::Event::PointerGone | egui::Event::WindowFocused(false) => {
                    self.drag = None;
                }
                _ => {}
            }
        }
        if response.has_focus() {
            let step = ui.input(|i| if i.modifiers.shift { 0.05 } else { 0.01 });
            let delta = ui.input(|i| {
                [
                    step * (i.key_pressed(egui::Key::ArrowRight) as i32
                        - i.key_pressed(egui::Key::ArrowLeft) as i32)
                        as f32,
                    step * (i.key_pressed(egui::Key::ArrowDown) as i32
                        - i.key_pressed(egui::Key::ArrowUp) as i32)
                        as f32,
                ]
            });
            if delta != [0., 0.] {
                self.place([self.area[0] + delta[0], self.area[1] + delta[1]]);
                consumed = true;
            }
        }
        let center =
            rect.min + egui::vec2(self.area[0] * rect.width(), self.area[1] * rect.height());
        let frame =
            egui::Rect::from_center_size(center, egui::Vec2::splat(rect.height() * AREA * 2.));
        let color = match self.status {
            Status::Locked => egui::Color32::from_rgb(112, 200, 144),
            Status::Missed => crate::theme::ERROR,
            Status::Measuring | Status::Pulling => crate::theme::ACCENT,
            _ => crate::theme::MUTED,
        };
        for (corner, dx, dy) in [
            (frame.left_top(), 1., 1.),
            (frame.right_top(), -1., 1.),
            (frame.left_bottom(), 1., -1.),
            (frame.right_bottom(), -1., -1.),
        ] {
            for delta in [egui::vec2(dx * 9., 0.), egui::vec2(0., dy * 9.)] {
                ui.painter()
                    .line_segment([corner, corner + delta], egui::Stroke::new(1.5, color));
            }
        }
        if self.drag.is_some() || ui.rect_contains_pointer(frame) || response.has_focus() {
            ui.painter()
                .circle_stroke(center, 6., egui::Stroke::new(1.5, color));
            ui.painter().line_segment(
                [center - egui::vec2(9., 0.), center + egui::vec2(9., 0.)],
                egui::Stroke::new(1., color),
            );
            ui.painter().line_segment(
                [center - egui::vec2(0., 9.), center + egui::vec2(0., 9.)],
                egui::Stroke::new(1., color),
            );
        }
        consumed
    }
}
pub fn request_depth(
    engine: api::Engine,
    area: [f32; 2],
    ctx: egui::Context,
) -> mpsc::Receiver<DepthReply> {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(match measure(&engine, area) {
            Ok(Some(depth)) => DepthReply::Ready(depth),
            Ok(None) => DepthReply::Unavailable,
            Err(error) => DepthReply::Failed(error.to_string()),
        });
        ctx.request_repaint();
    });
    receive
}
pub fn measure(engine: &api::Engine, area: [f32; 2]) -> api::Result<Option<Option<f32>>> {
    engine
        .read_depth_samples(api::DepthSampleArea {
            x: area[0],
            y: area[1],
            size: AREA,
        })
        .map(|samples| {
            samples.map(|samples| {
                let mut depths: Vec<_> = samples
                    .into_iter()
                    .filter(|d| d.is_finite() && *d > 0.)
                    .collect();
                pick_depth(&mut depths, GRID * GRID)
            })
        })
}
/// Nearest sufficiently supported depth cluster, matching Web areaFocus.ts.
pub fn pick_depth(depths: &mut [f32], rays: usize) -> Option<f32> {
    if depths.is_empty() {
        return None;
    }
    depths.sort_by(f32::total_cmp);
    let support = 2usize.max((rays as f64 * 0.12).ceil() as usize);
    for i in 0..depths.len() {
        let limit = depths[i] as f64 * 1.08;
        let mut end = i;
        while end + 1 < depths.len() && depths[end + 1] as f64 <= limit {
            end += 1;
        }
        if end - i + 1 >= support {
            return Some(depths[i + (end - i) / 2]);
        }
    }
    Some(depths[depths.len() / 2])
}
/// Dioptre easing and duration match the Web focus pull.
pub fn focus_pull(from: f32, to: f32, elapsed: f64) -> (f32, bool) {
    let from = from as f64;
    let to = to as f64;
    let duration = (260. + 220. * (to / from).ln().abs()).min(650.);
    let p = (elapsed / duration).clamp(0., 1.);
    let q = p - 1.;
    let eased = 1. + 2.2 * q * q * q + 1.2 * q * q;
    let inverse = 1. / from + (1. / to - 1. / from) * eased;
    let distance = if inverse > 1e-9 {
        1. / inverse
    } else {
        from.max(to) * 4.
    };
    (if p >= 1. { to as f32 } else { distance as f32 }, p >= 1.)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::Model;
    fn model() -> Model {
        Model::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"))
            .unwrap()
    }
    fn reply(focus: &mut AutoFocus, revision: u64, depth: Option<f32>) {
        let (send, receive) = mpsc::channel();
        send.send(DepthReply::Ready(depth)).unwrap();
        focus.query = Some((revision, receive));
    }
    #[test]
    fn current_depth_pulls_once_misses_keep_distance_and_stale_results_are_ignored() {
        let model = model();
        let mut camera = Camera::fit(model.0.center, model.0.radius);
        camera.f_stop = 2.8;
        let ctx = egui::Context::default();
        let now = Instant::now();
        let initial = camera.focus_distance;
        let mut focus = AutoFocus::default();
        reply(&mut focus, 0, Some(initial * 0.7));
        focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            false,
            now,
            &ctx,
        );
        assert_eq!(focus.status, Status::Pulling);
        assert!(focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            false,
            now + Duration::from_secs(1),
            &ctx
        ));
        assert_eq!(camera.focus_distance, initial * 0.7);
        assert_eq!(focus.status, Status::Locked);
        assert!(!focus.working(&camera));
        assert!(!focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            false,
            now + Duration::from_secs(2),
            &ctx
        ));
        focus.request();
        let revision = focus.revision;
        reply(&mut focus, revision, None);
        focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            false,
            Instant::now(),
            &ctx,
        );
        assert_eq!(focus.status, Status::Missed);
        assert_eq!(camera.focus_distance, initial * 0.7);
        focus.request();
        let stale = focus.revision;
        focus.place([0.8, 0.7]);
        reply(&mut focus, stale, Some(initial * 0.1));
        focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            false,
            Instant::now(),
            &ctx,
        );
        assert_eq!(camera.focus_distance, initial * 0.7);
        assert!(focus.pending);
        assert!(focus.pull.is_none());
        let current = focus.revision;
        reply(&mut focus, current, Some(initial * 0.1));
        focus.manual();
        focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            false,
            now + Duration::from_secs(3),
            &ctx,
        );
        assert_eq!(camera.focus_distance, initial * 0.7);
        assert!(!focus.working(&camera));
    }
    #[test]
    fn orthographic_and_disabled_lenses_do_not_query_or_change_focus() {
        let model = model();
        let mut camera = Camera::fit(model.0.center, model.0.radius);
        let ctx = egui::Context::default();
        let mut focus = AutoFocus::default();
        let now = Instant::now() + Duration::from_secs(1);
        assert!(!focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            false,
            now,
            &ctx
        ));
        assert!(focus.query.is_none());
        camera.f_stop = 2.8;
        camera.orthographic = true;
        assert!(!focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            false,
            now,
            &ctx
        ));
        assert!(focus.query.is_none());
        camera.orthographic = false;
        assert!(!focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            true,
            true,
            now,
            &ctx
        ));
        assert!(focus.query.is_none());
        assert!(!focus.update(
            |_| panic!("unexpected query"),
            &mut camera,
            false,
            false,
            now,
            &ctx
        ));
        assert!(focus.query.is_none());
    }
    #[test]
    fn a_supported_depth_cluster_ignores_stray_foreground_edges() {
        let mut depths = vec![1., 1.01, 3., 3.01, 3.02, 3.03, 3.04, 3.05, 8., 9.];
        assert_eq!(pick_depth(&mut depths, 49), Some(3.02));
        assert_eq!(pick_depth(&mut [], 49), None);
        assert_eq!(pick_depth(&mut [1., 9., 2.], 49), Some(2.));
    }
    #[test]
    fn coalesced_and_separate_focus_handle_drags_do_not_orbit() {
        use egui::{Event, PointerButton, Pos2, Rect};
        for combined in [false, true] {
            let ctx = egui::Context::default();
            let mut focus = AutoFocus::default();
            let mut camera = Camera::fit(glam::Vec3::ZERO, 1.);
            camera.f_stop = 2.8;
            let mut drag = crate::input::ViewportDrag::default();
            let mut frame = |events| {
                let mut motions = vec![];
                let mut output = ctx.run_ui(
                    egui::RawInput {
                        events,
                        ..Default::default()
                    },
                    |ui| {
                        egui::CentralPanel::default().show(ui, |ui| {
                            let rect =
                                Rect::from_min_max(egui::pos2(10., 10.), egui::pos2(310., 210.));
                            let viewport =
                                ui.interact(rect, ui.id().with("viewport"), egui::Sense::drag());
                            let consumed = focus.frame(ui, rect, &camera);
                            if consumed {
                                drag = crate::input::ViewportDrag::default();
                            }
                            motions = ui.input(|i| {
                                drag.motion(rect, !consumed && viewport.contains_pointer(), &[], i)
                            });
                            assert!(drag.take_click().is_none());
                        });
                    },
                );
                output.textures_delta.clear();
                assert!(motions.is_empty());
            };
            frame(vec![]);
            let button = |pos: Pos2, pressed| Event::PointerButton {
                pos,
                button: PointerButton::Primary,
                pressed,
                modifiers: Default::default(),
            };
            let start = egui::pos2(160., 110.);
            let end = egui::pos2(220., 130.);
            if combined {
                frame(vec![
                    Event::PointerMoved(start),
                    button(start, true),
                    Event::PointerMoved(end),
                    button(end, false),
                ]);
            } else {
                frame(vec![Event::PointerMoved(start), button(start, true)]);
                frame(vec![Event::PointerMoved(end)]);
                frame(vec![button(end, false)]);
            }
            assert!((focus.area[0] - 0.7).abs() < 1e-6 && (focus.area[1] - 0.6).abs() < 1e-6);
        }
    }
}
