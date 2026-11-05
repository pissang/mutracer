//! Reversible editor state; GPU resources and animation time never enter history.
use crate::{
    Change, Viewer, api, denoiser,
    scene::{Environment, KeyLight, Material, Mesh, Texture},
};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq)]
pub struct Settings {
    environment: Environment,
    sky_time: f32,
    light: KeyLight,
    render: crate::RenderSettings,
    display: mutracer_native_probe::display::Settings,
    aov: api::AovDisplayOptions,
    size: [u32; 2],
    scale: Option<f32>,
    preview: bool,
    preview_scale: f32,
    display_upscale: bool,
    denoise: bool,
    method: denoiser::Choice,
    oidn: denoiser::OidnSettings,
    jnlm: api::JnlmOptions,
    live_denoise: bool,
    auto_rotate: bool,
    camera: CameraSettings,
}
#[derive(Clone, PartialEq)]
struct CameraSettings {
    index: Option<usize>,
    orthographic: bool,
    fov: f32,
    f_stop: f32,
    focus_distance: f32,
    meters_per_unit: f32,
    auto_units: bool,
    auto_focus: bool,
}
#[derive(Clone)]
pub struct Materials {
    materials: Vec<Material>,
    properties: Vec<BTreeMap<u32, [u32; 3]>>,
    textures: Arc<Vec<Texture>>,
    meshes: Vec<Mesh>,
    hidden: HashSet<usize>,
}
impl PartialEq for Materials {
    fn eq(&self, other: &Self) -> bool {
        self.materials == other.materials
            && self.properties == other.properties
            && Arc::ptr_eq(&self.textures, &other.textures)
            && self.meshes == other.meshes
            && self.hidden == other.hidden
    }
}
impl Materials {
    pub fn capture(model: &crate::Model) -> Self {
        Self {
            materials: model.materials.clone(),
            properties: model.properties.clone(),
            textures: model.textures.clone(),
            meshes: model.meshes.clone(),
            hidden: model.1.hidden.clone(),
        }
    }
    fn apply(self, viewer: &mut Viewer) {
        viewer.model.0.materials = self.materials;
        viewer.model.0.properties = self.properties;
        viewer.model.0.textures = self.textures;
        viewer.model.0.meshes = self.meshes;
        viewer.model.1.hidden = self.hidden;
        viewer.dirty(Change::Scene);
    }
}
#[derive(Clone)]
pub struct Snapshot {
    settings: Settings,
    materials: Materials,
}
impl Snapshot {
    pub fn capture(v: &Viewer) -> Self {
        Self {
            settings: Settings {
                environment: v.environment.clone(),
                sky_time: v.sky.time,
                light: v.light.clone(),
                render: v.settings,
                display: v.display_settings,
                aov: v.aov_display,
                size: v.size,
                scale: v.resolution.scale,
                preview: v.preview_enabled,
                preview_scale: v.preview_scale,
                display_upscale: v.display_upscale,
                denoise: v.denoise,
                method: v.denoiser_choice,
                oidn: v.oidn_settings,
                jnlm: v.jnlm_settings,
                live_denoise: v.live_denoise,
                auto_rotate: v.auto_rotate,
                camera: CameraSettings {
                    index: v.camera_index,
                    orthographic: v.camera.orthographic,
                    fov: v.camera.fov,
                    f_stop: v.camera.f_stop,
                    focus_distance: v.camera.focus_distance,
                    meters_per_unit: v.camera.meters_per_unit,
                    auto_units: v.auto_units,
                    auto_focus: v.focus.enabled,
                },
            },
            materials: Materials::capture(&v.model),
        }
    }
    fn apply(self, v: &mut Viewer, settings: bool, materials: bool) {
        if settings {
            let s = self.settings;
            v.environments.cancel();
            v.environment = s.environment;
            if v.sky.time != s.sky_time {
                v.sky.invalidate();
            }
            v.sky.time = s.sky_time;
            v.light = s.light;
            v.settings = s.render;
            v.display_settings = s.display;
            v.aov_display = s.aov;
            v.size = s.size;
            v.resolution.scale = s.scale;
            v.preview_enabled = s.preview;
            v.preview_scale = s.preview_scale;
            v.display_upscale = s.display_upscale;
            v.denoise = s.denoise;
            v.denoiser_choice = s.method;
            v.oidn_settings = s.oidn;
            v.jnlm_settings = s.jnlm;
            v.live_denoise = s.live_denoise;
            v.auto_rotate = s.auto_rotate;
            let c = s.camera;
            let index = c.index.filter(|&i| i < v.model.1.cameras.len());
            if index != v.camera_index {
                if let Some(index) = index {
                    v.model.1.cameras[index].apply(&mut v.camera, v.model.center);
                }
            }
            v.camera_index = index;
            v.camera.orthographic = c.orthographic;
            v.camera.fov = c.fov;
            v.camera.f_stop = c.f_stop;
            v.camera.focus_distance = c.focus_distance;
            v.camera.meters_per_unit = c.meters_per_unit;
            v.auto_units = c.auto_units;
            v.focus.enabled = c.auto_focus;
            v.focus.request();
            v.dirty(Change::Scene);
        }
        if materials {
            self.materials.apply(v);
        }
    }
}
struct Edit {
    before: Snapshot,
    after: Snapshot,
    settings: bool,
    materials: bool,
    label: &'static str,
    time: Instant,
    dragging: bool,
}
#[derive(Default)]
pub struct History {
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    pub replayed: bool,
    pub dragging: bool,
}
impl History {
    pub fn record(&mut self, before: Snapshot, after: Snapshot) {
        if self.replayed {
            self.replayed = false;
            return;
        }
        let settings = before.settings != after.settings;
        let materials = before.materials != after.materials;
        if !settings && !materials {
            if !self.dragging {
                if let Some(last) = self.undo.last_mut() {
                    last.dragging = false;
                }
            }
            return;
        }
        let label = if settings && materials {
            "edits"
        } else if materials {
            "material and object edits"
        } else {
            "settings"
        };
        let now = Instant::now();
        self.redo.clear();
        if let Some(last) = self.undo.last_mut().filter(|last| {
            last.dragging
                && last.settings == settings
                && last.materials == materials
                && now.duration_since(last.time) < Duration::from_secs(1)
        }) {
            last.after = after;
            last.time = now;
            last.dragging = self.dragging;
        } else {
            self.undo.push(Edit {
                before,
                after,
                settings,
                materials,
                label,
                time: now,
                dragging: self.dragging,
            });
            if self.undo.len() > 100 {
                self.undo.remove(0);
            }
        }
    }
    pub fn labels(&self) -> (Option<&str>, Option<&str>) {
        (
            self.undo.last().map(|e| e.label),
            self.redo.last().map(|e| e.label),
        )
    }
    pub fn new_model(&mut self) {
        self.undo.retain(|e| !e.materials);
        self.redo.retain(|e| !e.materials);
    }
}
impl Viewer {
    pub(super) fn undo(&mut self, redo: bool) {
        let edit = if redo {
            self.history.redo.pop()
        } else {
            self.history.undo.pop()
        };
        if let Some(edit) = edit {
            if redo {
                edit.after.clone()
            } else {
                edit.before.clone()
            }
            .apply(self, edit.settings, edit.materials);
            if redo {
                self.history.undo.push(edit);
            } else {
                self.history.redo.push(edit);
            }
            self.history.replayed = true;
        }
    }
    pub(super) fn reset_all(&mut self) {
        let before = Snapshot::capture(self);
        self.initial_materials.clone().apply(self);
        self.environment = Environment::default();
        self.light = KeyLight::default();
        self.settings = crate::RenderSettings::default();
        self.display_settings = mutracer_native_probe::display::Settings {
            shadow_catcher_alpha: 0.8,
            ..Default::default()
        };
        self.aov_display = Default::default();
        self.preview_enabled = true;
        self.preview_scale = 0.5;
        self.display_upscale = true;
        self.denoise = true;
        self.denoiser_choice = Default::default();
        self.oidn_settings = Default::default();
        self.jnlm_settings = Default::default();
        self.live_denoise = true;
        self.auto_rotate = false;
        self.auto_units = true;
        self.resolution.scale = Some(0.5);
        self.camera = self
            .model
            .camera_for_load(&crate::Camera::fit(self.model.center, self.model.radius));
        self.camera.meters_per_unit = self.model.guessed_units();
        self.camera_index = self.model.camera_index_for_load();
        self.focus = Default::default();
        self.dirty(Change::Scene);
        let after = Snapshot::capture(self);
        self.history.record(before, after);
        self.history.replayed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Snapshot {
        Snapshot {
            settings: Settings {
                environment: Default::default(),
                sky_time: 15.,
                light: Default::default(),
                render: Default::default(),
                display: Default::default(),
                aov: Default::default(),
                size: [480, 320],
                scale: Some(0.5),
                preview: true,
                preview_scale: 0.5,
                display_upscale: true,
                denoise: true,
                method: Default::default(),
                oidn: Default::default(),
                jnlm: Default::default(),
                live_denoise: true,
                auto_rotate: false,
                camera: CameraSettings {
                    index: None,
                    orthographic: false,
                    fov: 35.,
                    f_stop: 0.,
                    focus_distance: 4.,
                    meters_per_unit: 1.,
                    auto_units: true,
                    auto_focus: true,
                },
            },
            materials: Materials {
                materials: vec![],
                properties: vec![],
                textures: Arc::new(vec![]),
                meshes: vec![],
                hidden: HashSet::new(),
            },
        }
    }
    #[test]
    fn dragging_merges_but_distinct_settings_edits_and_model_scopes_stay_separate() {
        let mut h = History::default();
        let a = state();
        let mut b = a.clone();
        b.settings.render.bounces = 8;
        h.dragging = true;
        h.record(a.clone(), b.clone());
        let mut c = b.clone();
        c.settings.render.bounces = 9;
        h.record(b.clone(), c.clone());
        assert_eq!(h.undo.len(), 1);
        h.dragging = false;
        h.record(c.clone(), c.clone());
        let mut d = c.clone();
        d.settings.display.exposure = 2.;
        h.record(c.clone(), d.clone());
        assert_eq!(h.undo.len(), 2);
        let mut e = d.clone();
        e.materials.hidden.insert(1);
        h.record(d, e);
        assert_eq!(h.undo.len(), 3);
        h.new_model();
        assert_eq!(h.undo.len(), 2);
        assert_eq!(h.undo[0].before.settings.render.bounces, 6);
        assert_eq!(h.undo[0].after.settings.render.bounces, 9);
    }
}
