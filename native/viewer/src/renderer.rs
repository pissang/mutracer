//! Native ABI client; complete scene preparation can run on a background worker.
use anyhow::{Result, bail, ensure};
use glam::{Affine3A, Mat4, Vec3};
use mutracer_native_probe::context as native;
use mutracer_native_probe::layout::camera as camera_wire;
pub use mutracer_native_probe::settings::RenderSettings;
use mutracer_native_probe::status::Status;
use std::{
    ffi::CStr,
    time::{Duration, Instant},
};

/// A plain L0 context: the viewer's fresh-context oracle and direct smokes.
/// Interactive rendering uses the library's Engine/Render/RenderLoop.
pub struct Renderer {
    handle: u64,
    job: Option<u64>,
    opaque_background: bool,
}
fn call(operation: impl FnOnce(*mut i8, usize) -> i32) -> (i32, String) {
    let mut error = [0i8; 4096];
    let code = operation(error.as_mut_ptr(), error.len());
    let message = unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy();
    (code, message.into_owned())
}
/// A failed native call with its mt_status code.
#[derive(Debug)]
pub struct NativeError {
    pub status: i32,
    message: String,
}
impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for NativeError {}
impl NativeError {
    /// True when another native call held the library; retry on a later frame.
    pub fn is_busy(error: &anyhow::Error) -> bool {
        error
            .downcast_ref::<NativeError>()
            .is_some_and(|e| e.status == Status::Busy as i32)
    }
}
fn check(operation: impl FnOnce(*mut i8, usize) -> i32) -> Result<()> {
    match call(operation) {
        (0, _) => Ok(()),
        (status, message) => Err(NativeError { status, message }.into()),
    }
}
impl Renderer {
    pub fn with_backend(mode: u32) -> Result<Self> {
        let mut handle = 0;
        check(|e, n| unsafe { native::mt_context_create_with_backend(mode, &mut handle, e, n) })?;
        Ok(Self {
            handle,
            job: None,
            opaque_background: false,
        })
    }
    pub fn backend(&self) -> Result<(u32, String)> {
        let mut active = 0;
        let mut reason = [0i8; 512];
        check(|e, n| unsafe {
            native::mt_context_backend(
                self.handle,
                &mut active,
                reason.as_mut_ptr(),
                reason.len(),
                e,
                n,
            )
        })?;
        Ok((
            active,
            unsafe { CStr::from_ptr(reason.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        ))
    }

    pub fn commit(&mut self, bytes: &[u8]) -> Result<()> {
        self.commit_with_settings(bytes, &RenderSettings::default())
    }
    pub fn commit_with_settings(&mut self, bytes: &[u8], settings: &RenderSettings) -> Result<()> {
        ensure!(self.job.is_none(), "Drain current job before committing");
        check(|e, n| unsafe {
            native::mt_context_commit_with_settings(
                self.handle,
                bytes.as_ptr(),
                bytes.len(),
                settings,
                e,
                n,
            )
        })?;
        let word = |at: usize| u32::from_le_bytes(bytes[at * 4..at * 4 + 4].try_into().unwrap());
        use mutracer_native_probe::layout::header as h;
        self.opaque_background = word(h::QUALITY_FLAGS) & 4 == 0
            && word(h::BACKGROUND_TEXTURE) == 0
            && f32::from_bits(word(h::BACKGROUND_COLOR + 3)) >= 0.99999;
        Ok(())
    }
    pub fn reset(&mut self) -> Result<()> {
        check(|e, n| unsafe { native::mt_context_reset(self.handle, e, n) })
    }
    fn info(&self) -> Result<native::ContextInfo> {
        let mut info = native::ContextInfo {
            struct_size: std::mem::size_of::<native::ContextInfo>() as u32,
            width: 0,
            height: 0,
            samples: 0,
            state: 0,
            last_commit: 0,
        };
        check(|e, n| unsafe { native::mt_context_info(self.handle, &mut info, e, n) })?;
        Ok(info)
    }
    pub fn samples(&self) -> Result<u32> {
        Ok(self.info()?.samples)
    }
    /// Whether the last successful commit kept the prepared scene (MT_COMMIT_INCREMENTAL).
    pub fn last_commit_incremental(&self) -> Result<bool> {
        Ok(self.info()?.last_commit == native::COMMIT_INCREMENTAL)
    }
    pub fn busy(&self) -> bool {
        self.job.is_some()
    }
    pub fn cancel(&mut self) -> Result<()> {
        if let Some(job) = self.job {
            check(|e, n| unsafe { native::mt_job_cancel(job, e, n) })?;
        }
        Ok(())
    }
    pub fn start(&mut self, samples: u32) -> Result<()> {
        ensure!(self.job.is_none(), "Render job is already active");
        let mut job = 0;
        check(|e, n| unsafe { native::mt_context_submit(self.handle, samples, &mut job, e, n) })?;
        self.job = Some(job);
        Ok(())
    }
    /// Returns true when a job reached completion/cancellation and allows readback.
    pub fn poll(&mut self) -> Result<bool> {
        let Some(job) = self.job else {
            return Ok(false);
        };
        match call(|e, n| unsafe { native::mt_job_poll(job, 1, e, n) }) {
            (0, _) => {}
            (code, _) if code == Status::Busy as i32 => return Ok(false),
            (status, message) => {
                self.job = None;
                return Err(NativeError { status, message }.into());
            }
        }
        let mut info = native::JobInfo {
            struct_size: std::mem::size_of::<native::JobInfo>() as u32,
            state: 0,
            requested_samples: 0,
            submitted_samples: 0,
            completed_samples: 0,
            base_samples: 0,
        };
        check(|e, n| unsafe { native::mt_job_info(job, &mut info, e, n) })?;
        match info.state {
            2 | 3 => {
                self.job = None;
                Ok(true)
            }
            4 => bail!("Native render job failed"),
            _ => Ok(false),
        }
    }
    pub fn image(&self, kind: u32) -> Result<Vec<f32>> {
        let mut bytes = 0;
        check(|e, n| unsafe {
            native::mt_context_read_pixels(
                self.handle,
                kind,
                std::ptr::null_mut(),
                0,
                &mut bytes,
                e,
                n,
            )
        })?;
        let mut pixels = vec![0u8; bytes];
        check(|e, n| unsafe {
            native::mt_context_read_pixels(
                self.handle,
                kind,
                pixels.as_mut_ptr(),
                pixels.len(),
                &mut bytes,
                e,
                n,
            )
        })?;
        let pixels: Vec<f32> = pixels
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        ensure!(
            pixels.iter().all(|v| v.is_finite()),
            "Non-finite rendered pixels"
        );
        Ok(pixels)
    }
    pub fn pixels(&self) -> Result<Vec<f32>> {
        self.image(0)
    }
    /// Fresh L0 oracle converted for comparisons with the viewer's L1 HDR.
    /// Direct L0 smokes continue to use finish/image without this conversion.
    pub fn finish_l1(&mut self, samples: u32) -> Result<Vec<f32>> {
        let mut color = self.finish(samples)?;
        let normal = self.image(1)?;
        let albedo = self.image(2)?;
        let minimum = 1. / self.samples()? as f32;
        for (i, pixel) in color.chunks_exact_mut(4).enumerate() {
            let count = normal[i * 4 + 3];
            let hit = albedo[i * 4 + 3];
            if count <= 0. {
                pixel.fill(0.);
                continue;
            }
            let total = count.max(minimum);
            let divisor = if hit > 0. { hit } else { total };
            let coverage = (hit / total).clamp(0., 1.);
            for value in &mut pixel[..3] {
                *value /= divisor;
                if self.opaque_background && coverage > 0. {
                    *value *= coverage;
                }
            }
            pixel[3] /= total;
        }
        Ok(color)
    }
    pub fn finish(&mut self, samples: u32) -> Result<Vec<f32>> {
        self.start(samples)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        while !self.poll()? {
            ensure!(Instant::now() < deadline, "Render timed out");
            std::thread::sleep(Duration::from_millis(1));
        }
        self.pixels()
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        let _ = self.cancel();
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.busy() && Instant::now() < deadline {
            if self.poll().is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        loop {
            match check(|e, n| unsafe { native::mt_context_destroy(self.handle, e, n) }) {
                Err(error)
                    if error.to_string().contains("Context registry is active")
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(1))
                }
                _ => break,
            }
        }
    }
}
#[derive(Clone)]
pub struct Camera {
    pub target: Vec3,
    pub up: Vec3,
    /// Reflection retained from the imported camera-to-world basis.
    pub mirrored: bool,
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
    pub radius: f32,
    pub fov: f32,
    pub orthographic: bool,
    pub f_stop: f32,
    pub focus_distance: f32,
    pub meters_per_unit: f32,
}
impl Camera {
    pub fn fit(center: Vec3, radius: f32) -> Self {
        Self {
            target: center,
            up: Vec3::Y,
            mirrored: false,
            yaw: 0.6,
            pitch: 0.3,
            distance: radius * 3.6,
            radius,
            fov: 35.,
            orthographic: false,
            f_stop: 0.,
            focus_distance: radius * 3.6,
            meters_per_unit: 1.,
        }
    }
    pub fn frame(&mut self, center: Vec3, radius: f32) {
        self.target = center;
        self.up = Vec3::Y;
        self.radius = radius.max(1e-5);
        self.distance = self.radius * 1.15 / (self.fov.to_radians() * 0.5).tan();
        self.focus_distance = self.distance;
    }
    pub fn half_height(&self) -> f32 {
        self.distance * (self.fov.to_radians() * 0.5).tan()
    }
    /// CPU pinhole reference for camera contract tests.
    #[cfg(test)]
    pub fn ray(&self, uv: [f32; 2], aspect: f32) -> (Vec3, Vec3) {
        let eye = self.eye();
        let forward = (self.target - eye).normalize();
        let right = forward.cross(self.up).normalize();
        let up = right.cross(forward);
        let right = if self.mirrored { -right } else { right };
        let offset = (right * ((uv[0] * 2. - 1.) * aspect) + up * (1. - uv[1] * 2.))
            * (self.fov.to_radians() * 0.5).tan();
        if self.orthographic {
            (eye + offset * self.distance, forward)
        } else {
            (eye, (forward + offset).normalize())
        }
    }
    pub fn set_view(&mut self, eye: Vec3, target: Vec3) {
        let delta = eye - target;
        self.distance = delta.length().max(1e-5);
        self.target = target;
        self.up = Vec3::Y;
        self.mirrored = false;
        self.yaw = delta.x.atan2(delta.z);
        self.pitch = (delta.y / self.distance).clamp(-1., 1.).asin();
        self.focus_distance = self.distance;
    }
    pub fn eye(&self) -> Vec3 {
        self.target
            + Vec3::new(
                self.yaw.sin() * self.pitch.cos(),
                self.pitch.sin(),
                self.yaw.cos() * self.pitch.cos(),
            ) * self.distance
    }
    pub fn orbit_yaw(&mut self, delta: f32) {
        // A reflected camera reverses screen X; compensate the input as well.
        self.yaw -= if self.mirrored { -delta } else { delta };
    }
    pub fn orbit(&mut self, delta: [f32; 2]) {
        self.up = Vec3::Y;
        self.orbit_yaw(delta[0] * 0.008);
        self.pitch = (self.pitch + delta[1] * 0.008).clamp(-1.5, 1.5);
    }
    pub fn pan(&mut self, delta: [f32; 2]) {
        let forward = (self.target - self.eye()).normalize();
        let right = forward.cross(self.up).normalize();
        let up = right.cross(forward);
        let right = if self.mirrored { -right } else { right };
        self.target += (-right * delta[0] + up * delta[1]) * self.distance * 0.002;
    }
    pub fn zoom(&mut self, delta: f32) {
        self.distance =
            (self.distance * (-delta * 0.002).exp()).clamp(self.radius * 0.03, self.radius * 100.);
    }
    pub fn bytes(&self, size: [u32; 2]) -> Vec<u8> {
        let mut f = [0f32; camera_wire::WORDS];
        f[camera_wire::PROJECTION] = f32::from_bits(u32::from(self.orthographic));
        f[camera_wire::FOV] = self.fov;
        f[camera_wire::NEAR] = (self.radius * 0.0001).max(0.00001);
        f[camera_wire::FAR] = (self.radius * 1000.).max(100.);
        f[camera_wire::LEFT] = -self.half_height() * size[0] as f32 / size[1] as f32;
        f[camera_wire::RIGHT] = self.half_height() * size[0] as f32 / size[1] as f32;
        f[camera_wire::BOTTOM] = -self.half_height();
        f[camera_wire::TOP] = self.half_height();
        f[camera_wire::ZOOM] = 1.;
        f[camera_wire::F_STOP] = if self.orthographic { 0. } else { self.f_stop };
        f[camera_wire::FOCUS_DISTANCE] = self.focus_distance;
        f[camera_wire::SENSOR_HEIGHT] = 24.;
        f[camera_wire::METERS_PER_UNIT] = self.meters_per_unit;
        // A general Mat4 inverse can round the homogeneous 1 away from 1.0,
        // which violates the native ABI's exact affine-transform contract.
        let mut world =
            Mat4::from(Affine3A::look_at_rh(self.eye(), self.target, self.up).inverse());
        if self.mirrored {
            world.x_axis = -world.x_axis;
        }
        f[camera_wire::TRANSFORM..camera_wire::WORDS].copy_from_slice(&world.to_cols_array());
        f.into_iter().flat_map(f32::to_le_bytes).collect()
    }
}
/// Display-only Reinhard/sRGB conversion; HDR stays unchanged for comparisons.
pub fn display(pixels: &[f32], size: [u32; 2], exposure: f32) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(pixels.len());
    let gain = 2f32.powf(exposure);
    for y in (0..size[1] as usize).rev() {
        for x in 0..size[0] as usize {
            let o = (y * size[0] as usize + x) * 4;
            for c in 0..3 {
                let v = (pixels[o + c] * gain).max(0.);
                let v = v / (1. + v);
                let s = if v <= 0.0031308 {
                    12.92 * v
                } else {
                    1.055 * v.powf(1. / 2.4) - 0.055
                };
                rgba.push((s.clamp(0., 1.) * 255. + 0.5) as u8);
            }
            rgba.push(255);
        }
    }
    rgba
}
pub fn save(path: &std::path::Path, pixels: &[f32], size: [u32; 2], exposure: f32) -> Result<()> {
    image::save_buffer_with_format(
        path,
        &display(pixels, size, exposure),
        size[0],
        size[1],
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a real GPU"]
    fn l0_oracle_converts_hdr_to_l1_without_changing_raw_readback() {
        use mutracer_native_probe::{api, layout::header as h};
        let model = crate::Model::load(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"),
        )
        .unwrap();
        let size = [13, 9];
        let camera = Camera::fit(model.0.center, model.0.radius);
        let mut descriptor =
            model.descriptor(&camera.bytes(size), size, &crate::Environment::default());
        let quality = u32::from_le_bytes(
            descriptor[h::QUALITY_FLAGS * 4..h::QUALITY_FLAGS * 4 + 4]
                .try_into()
                .unwrap(),
        );
        let engine = api::Engine::new(api::EngineOptions {
            backend: api::Backend::Software,
        })
        .unwrap();
        let render = api::Render::new(
            &engine,
            api::RenderSettings {
                max_samples: 7,
                size: api::RenderSize::Fixed {
                    width: size[0],
                    height: size[1],
                },
                bevel: quality & 1 != 0,
                dispersion_wavelengths: if quality & 2 != 0 { 3 } else { 1 },
                ..Default::default()
            },
        )
        .unwrap();
        let mut reference = Renderer::with_backend(0).unwrap();
        let settings = RenderSettings {
            max_samples: 4096,
            bounces: 3,
            direct_light_candidates: 4,
            ..Default::default()
        };
        for alpha in [0f32, 1.] {
            let at = (h::BACKGROUND_COLOR + 3) * 4;
            descriptor[at..at + 4].copy_from_slice(&alpha.to_le_bytes());
            reference
                .commit_with_settings(&descriptor, &settings)
                .unwrap();
            engine.set_scene(&descriptor).unwrap();
            engine.update().unwrap();
            render.converge(api::ConvergeOptions::new(7)).unwrap();
            let expected = reference.finish_l1(7).unwrap();
            let actual = crate::bottom_first(render.read_pixels(api::PixelKind::Hdr).unwrap());
            assert_eq!(actual, expected);
            let raw = reference.image(0).unwrap();
            assert_eq!(reference.pixels().unwrap(), raw);
        }
    }

    #[test]
    fn projection_rays_and_wire_bounds_agree_at_wide_and_tall_aspects() {
        let mut camera = Camera::fit(Vec3::ZERO, 2.);
        camera.yaw = 0.;
        camera.pitch = 0.;
        for size in [[300, 100], [100, 300]] {
            let aspect = size[0] as f32 / size[1] as f32;
            let (_, perspective) = camera.ray([0.8, 0.3], aspect);
            camera.orthographic = true;
            camera.f_stop = 2.8;
            let bytes = camera.bytes(size);
            let f: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            assert_eq!(f[camera_wire::PROJECTION].to_bits(), 1);
            assert_eq!(f[camera_wire::F_STOP], 0.);
            assert_eq!(f[camera_wire::RIGHT] / f[camera_wire::TOP], aspect);
            let (origin, direction) = camera.ray([0.8, 0.3], aspect);
            let target = origin + direction * camera.distance;
            assert!((target - camera.eye()).normalize().distance(perspective) < 1e-6);
            assert!((origin.x - 0.6 * f[camera_wire::RIGHT]).abs() < 1e-5);
            assert!((origin.y - 0.4 * f[camera_wire::TOP]).abs() < 1e-5);
            camera.orthographic = false;
        }
        camera.f_stop = 1.4;
        camera.meters_per_unit = 0.01;
        camera.frame(Vec3::ONE, 3.);
        assert_eq!(camera.f_stop, 1.4);
        assert_eq!(camera.meters_per_unit, 0.01);
        assert_eq!(camera.focus_distance, camera.distance);
    }
    #[test]
    fn orbit_drags_move_front_landmarks_in_the_pointer_direction() {
        fn screen(camera: &Camera, point: Vec3) -> glam::Vec2 {
            let bytes = camera.bytes([320, 240]);
            let values: Vec<f32> = bytes[camera_wire::TRANSFORM * 4..]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            let local = Mat4::from_cols_slice(&values)
                .inverse()
                .transform_point3(point);
            glam::Vec2::new(local.x, -local.y) / if camera.orthographic { 1. } else { -local.z }
        }
        for mirrored in [false, true] {
            for orthographic in [false, true] {
                for delta in [[10., 0.], [-10., 0.], [0., 10.], [0., -10.]] {
                    let mut camera = Camera::fit(Vec3::ZERO, 2.);
                    camera.set_view(Vec3::new(0., 0., 4.), Vec3::ZERO);
                    camera.mirrored = mirrored;
                    camera.orthographic = orthographic;
                    let point = Vec3::Z;
                    let before = screen(&camera, point);
                    camera.orbit(delta);
                    let movement = screen(&camera, point) - before;
                    assert!(
                        movement.dot(glam::Vec2::from_array(delta)) > 0.,
                        "Drag reversed: mirrored={mirrored}, orthographic={orthographic}, delta={delta:?}, movement={movement:?}"
                    );
                    assert_eq!(camera.mirrored, mirrored);
                }
            }
        }
    }
    #[test]
    fn camera_controls_preserve_the_affine_wire_contract() {
        for (center, radius) in [(Vec3::ZERO, 1.), (Vec3::new(2., -3., 5.), 12.)] {
            let mut camera = Camera::fit(center, radius);
            for step in 0..128 {
                match step % 4 {
                    0 => camera.orbit([7., -3.]),
                    1 => camera.pan([5., 2.]),
                    2 => camera.zoom(60.),
                    _ => camera.zoom(-60.),
                }
                let bytes = camera.bytes([300, 200]);
                let f: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|word| f32::from_le_bytes(word.try_into().unwrap()))
                    .collect();
                let world = Mat4::from_cols_slice(&f[camera_wire::TRANSFORM..]);
                // The native ABI requires this row exactly, not approximately.
                assert_eq!(world.row(3), glam::Vec4::W, "step {step}");
                assert!(world.is_finite() && world.determinant().abs() > 1e-12);
                assert!(world.w_axis.truncate().distance(camera.eye()) < radius * 1e-5);
                let forward = world.transform_vector3(Vec3::NEG_Z).normalize();
                assert!(forward.distance((camera.target - camera.eye()).normalize()) < 1e-5);
            }
        }
    }
}
