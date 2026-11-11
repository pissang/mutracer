use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use glam::{Mat4, Vec3};
use mutracer_native::api;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct Activity(api::SyncActivity);
impl api::LoopSync for Activity {
    fn update(&mut self) {}
    fn activity(&self) -> &api::SyncActivity {
        &self.0
    }
    fn activity_mut(&mut self) -> &mut api::SyncActivity {
        &mut self.0
    }
}

pub struct Orbit {
    pub target: Vec3,
    pub radius: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub camera: api::Camera,
    pub revision: u64,
    pub activity: api::SharedSync,
    held: Option<[f32; 5]>,
}
impl Default for Orbit {
    fn default() -> Self {
        Self {
            target: Vec3::ZERO,
            radius: 6.,
            yaw: 0.5,
            pitch: 0.3,
            camera: api::Camera {
                fov: 35.,
                ..Default::default()
            },
            revision: 0,
            activity: Arc::new(Mutex::new(Activity::default())),
            held: None,
        }
    }
}
impl Orbit {
    pub fn camera(&self) -> api::Camera {
        let offset = Vec3::new(
            self.yaw.sin() * self.pitch.cos(),
            self.pitch.sin(),
            self.yaw.cos() * self.pitch.cos(),
        ) * self.radius;
        api::Camera {
            world_matrix: Mat4::look_at_rh(self.target + offset, self.target, Vec3::Y)
                .inverse()
                .to_cols_array(),
            ..self.camera
        }
    }
    pub fn look_at(&mut self, position: Vec3, target: Vec3) {
        let delta = position - target;
        self.radius = delta.length().max(0.0001);
        self.target = target;
        self.yaw = delta.x.atan2(delta.z);
        self.pitch = (delta.y / self.radius).clamp(-1., 1.).asin();
    }
    pub fn packet(&mut self, message: &str, height: f32) -> Result<bool> {
        let bytes = STANDARD.decode(message.strip_prefix('~').unwrap_or(message))?;
        ensure!(bytes.len() == 20, "Invalid pointer packet length");
        let p: [f32; 5] = std::array::from_fn(|i| {
            f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap())
        });
        ensure!(p.iter().all(|v| v.is_finite()), "Non-finite pointer packet");
        self.input(p, height)
    }
    pub fn sync_camera(
        &mut self,
        mut camera: api::Camera,
        target: Option<Vec3>,
        revision: Option<u64>,
    ) -> api::Camera {
        if revision.is_some_and(|revision| revision < self.revision) {
            // A delayed UI edit may change the lens, but cannot rewind a newer
            // native drag. Keep the orbit target and its latest pose.
            camera.world_matrix = self.camera().world_matrix;
            if camera.projection == self.camera.projection {
                camera.zoom = self.camera.zoom;
            }
        } else {
            let world = Mat4::from_cols_array(&camera.world_matrix);
            let position = world.w_axis.truncate();
            self.look_at(
                position,
                target.unwrap_or(position - world.z_axis.truncate() * self.radius),
            );
        }
        self.camera = camera;
        camera
    }
    pub fn input(&mut self, p: [f32; 5], height: f32) -> Result<bool> {
        let changed = self.apply_input(p, height)?;
        let mut activity = self.activity.lock().unwrap();
        // Input arrives less often than GPU polls. Keep the interaction active
        // between packets so a held drag never starts full-resolution work.
        activity.set_active(self.held.is_some());
        if changed && p[0] == 3. {
            activity.activate_for(Duration::from_millis(100));
        }
        if changed {
            self.revision += 1;
        }
        Ok(changed)
    }
    fn apply_input(&mut self, p: [f32; 5], height: f32) -> Result<bool> {
        ensure!(p.iter().all(|v| v.is_finite()), "Non-finite input");
        match p[0] as u32 {
            0 => self.held = Some(p),
            1 => {
                if let Some(last) = self.held {
                    let (dx, dy) = (p[1] - last[1], p[2] - last[2]);
                    if last[3] != 0. || p[4] != 0. {
                        let world = Mat4::from_cols_array(&self.camera().world_matrix);
                        let scale = if self.camera.projection == 1 {
                            (self.camera.top - self.camera.bottom)
                                / self.camera.zoom
                                / height.max(1.)
                        } else {
                            2. * self.radius * (self.camera.fov.to_radians() / 2.).tan()
                                / height.max(1.)
                        };
                        self.target +=
                            (-world.x_axis.truncate() * dx + world.y_axis.truncate() * dy) * scale;
                    } else {
                        self.yaw -= dx * 0.006;
                        self.pitch = (self.pitch + dy * 0.006).clamp(-1.5, 1.5);
                    }
                    self.held = Some([p[0], p[1], p[2], last[3], p[4]]);
                    return Ok(dx != 0. || dy != 0.);
                }
            }
            2 => self.held = None,
            3 => {
                if self.camera.projection == 1 {
                    self.camera.zoom = (self.camera.zoom * (-p[1] * 0.001).clamp(-1., 1.).exp())
                        .clamp(0.0001, 1e8);
                    return Ok(true);
                }
                self.radius =
                    (self.radius * (p[1] * 0.001).clamp(-1., 1.).exp()).clamp(0.0001, 1e8);
                return Ok(true);
            }
            _ => anyhow::bail!("Unknown pointer operation"),
        }
        Ok(false)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn packet(p: [f32; 5]) -> String {
        format!(
            "~{}",
            STANDARD.encode(p.into_iter().flat_map(f32::to_le_bytes).collect::<Vec<_>>())
        )
    }
    #[test]
    fn only_held_drags_move_the_camera_and_release_stops_them() {
        let mut orbit = Orbit::default();
        let before = orbit.camera().world_matrix;
        assert!(!orbit.packet(&packet([1., 30., 20., 0., 0.]), 400.).unwrap());
        orbit.packet(&packet([0., 10., 20., 0., 0.]), 400.).unwrap();
        assert!(orbit.activity.lock().unwrap().active());
        assert!(orbit.packet(&packet([1., 30., 20., 0., 0.]), 400.).unwrap());
        assert_ne!(before, orbit.camera().world_matrix);
        orbit.packet(&packet([2., 30., 20., 0., 0.]), 400.).unwrap();
        assert!(!orbit.activity.lock().unwrap().active());
        assert!(!orbit.packet(&packet([1., 50., 20., 0., 0.]), 400.).unwrap());
    }
    #[test]
    fn delayed_camera_echo_cannot_rewind_a_drag_but_lens_edits_apply() {
        let mut orbit = Orbit::default();
        orbit.input([0., 10., 20., 0., 0.], 400.).unwrap();
        orbit.input([1., 30., 20., 0., 0.], 400.).unwrap();
        let mut echoed = orbit.camera();
        let revision = orbit.revision;
        orbit.input([1., 50., 40., 0., 0.], 400.).unwrap();
        let latest = orbit.camera();
        echoed.fov = 50.;
        let accepted = orbit.sync_camera(echoed, Some(Vec3::X), Some(revision));
        assert_eq!(accepted.world_matrix, latest.world_matrix);
        assert_eq!(accepted.fov, 50.);
        assert_eq!(orbit.target, Vec3::ZERO);
        let mut edit = accepted;
        edit.world_matrix[12] += 1.;
        let accepted = orbit.sync_camera(edit, Some(Vec3::X), Some(orbit.revision));
        assert_eq!(accepted.world_matrix, edit.world_matrix);
        assert_eq!(orbit.target, Vec3::X);
    }
    #[test]
    fn malformed_packets_do_not_change_camera() {
        let mut orbit = Orbit::default();
        let before = orbit.camera().world_matrix;
        assert!(orbit.packet("~AAAA", 400.).is_err());
        assert!(
            orbit
                .packet(&packet([0., f32::NAN, 0., 0., 0.]), 400.)
                .is_err()
        );
        assert_eq!(before, orbit.camera().world_matrix);
    }
}
