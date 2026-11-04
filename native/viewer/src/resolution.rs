//! Viewport-relative resolution without repeated scene commits during resizing.
use eframe::egui;
use std::time::{Duration, Instant};
const SETTLE: Duration = Duration::from_millis(160);
pub const FIXED: [(&str, [u32; 2]); 4] = [
    ("720p", [1280, 720]),
    ("1080p", [1920, 1080]),
    ("2K", [2560, 1440]),
    ("4K", [3840, 2160]),
];
pub fn fixed_name(size: [u32; 2]) -> Option<&'static str> {
    FIXED
        .iter()
        .find(|(_, pixels)| *pixels == size)
        .map(|(name, _)| *name)
}
/// Convert viewport-relative preview bounds to the display's render size.
pub fn preview_scales(viewport: [u32; 2], size: [u32; 2], maximum: f32) -> [f64; 2] {
    let relative = if viewport == [0; 2] {
        1.
    } else {
        (viewport[0] as f64 / size[0] as f64).min(viewport[1] as f64 / size[1] as f64)
    };
    let maximum = maximum as f64;
    let max = (relative * maximum).clamp(0.01, 1.);
    let min = (relative * maximum.min(0.125)).clamp(0.01, max);
    [min, max]
}
pub struct Resolution {
    pub scale: Option<f32>,
    pub full: [u32; 2],
    desired: [u32; 2],
    changed: Instant,
}
impl Resolution {
    pub fn new(scale: Option<f32>) -> Self {
        Self {
            scale,
            full: [0; 2],
            desired: [0; 2],
            changed: Instant::now(),
        }
    }
    pub fn scaled(&self, scale: f32) -> [u32; 2] {
        self.full
            .map(|v| ((v as f32 * scale).round() as u32).max(1))
    }
    pub fn update(
        &mut self,
        points: egui::Vec2,
        dpr: f32,
        current: [u32; 2],
        held: bool,
        now: Instant,
    ) -> Option<[u32; 2]> {
        let first = self.full == [0; 2];
        self.full = [points.x, points.y].map(|v| (v.max(1.) * dpr.clamp(1., 2.)).round() as u32);
        let desired = self.scaled(self.scale?);
        if desired != self.desired {
            self.desired = desired;
            self.changed = now;
        }
        if !held && current != desired && (first || now.duration_since(self.changed) >= SETTLE) {
            Some(desired)
        } else {
            None
        }
    }
    pub fn pending(&self, current: [u32; 2]) -> bool {
        self.scale.is_some() && current != self.desired
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_bounds_follow_viewport_independently_of_final_resolution() {
        for (viewport, size, maximum, expected) in [
            ([0, 0], [640, 480], 0.5, [0.125, 0.5]),
            ([1600, 1200], [1600, 1200], 0.5, [0.125, 0.5]),
            ([1600, 1200], [800, 600], 0.5, [0.25, 1.]),
            ([1600, 1200], [400, 300], 0.5, [0.5, 1.]),
            ([640, 360], [3840, 2160], 0.5, [1. / 48., 1. / 12.]),
            ([1600, 900], [800, 600], 0.5, [0.1875, 0.75]),
            ([0, 0], [640, 480], 0.0625, [0.0625, 0.0625]),
        ] {
            let actual = preview_scales(viewport, size, maximum);
            assert_eq!(actual, expected);
            let settings = mutracer_native_probe::api::RenderSettings {
                size: mutracer_native_probe::api::RenderSize::Scale(actual[1]),
                adaptive_resolution: Some(mutracer_native_probe::api::AdaptiveResolution {
                    target_frame_ms: 80.,
                    min_scale: actual[0],
                }),
                ..Default::default()
            };
            settings.validate().unwrap();
        }
    }
    #[test]
    fn retina_scaling_settles_once_and_fixed_sizes_ignore_viewport_changes() {
        let now = Instant::now();
        let mut resolution = Resolution::new(Some(0.5));
        let points = egui::vec2(600., 400.);
        assert_eq!(
            resolution.update(points, 2., [480, 320], false, now),
            Some([600, 400])
        );
        assert_eq!(
            resolution.update(points * 1.2, 2., [600, 400], true, now),
            None
        );
        assert_eq!(
            resolution.update(
                points * 1.4,
                2.,
                [600, 400],
                false,
                now + Duration::from_millis(100)
            ),
            None
        );
        assert_eq!(
            resolution.update(
                points * 1.4,
                2.,
                [600, 400],
                false,
                now + Duration::from_millis(300)
            ),
            Some([840, 560])
        );
        assert_eq!(
            resolution.update(
                points * 1.4,
                2.,
                [840, 560],
                false,
                now + Duration::from_millis(400)
            ),
            None
        );
        resolution.scale = Some(1.);
        assert_eq!(
            resolution.update(
                points * 1.4,
                3.,
                [840, 560],
                false,
                now + Duration::from_millis(500)
            ),
            None
        );
        assert_eq!(
            resolution.update(
                points * 1.4,
                3.,
                [840, 560],
                false,
                now + Duration::from_millis(700)
            ),
            Some([1680, 1120])
        );
        resolution.scale = None;
        assert_eq!(
            resolution.update(
                points * 2.,
                2.,
                [1920, 1080],
                false,
                now + Duration::from_secs(1)
            ),
            None
        );
        assert!(!resolution.pending([1920, 1080]));
    }
}
