use serde::{Deserialize, Serialize};

/// Neighbors in each direction. Offline defaults to adaptive 8 through 16.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum HistoryRadius {
    Fixed(u32),
    Adaptive { min: u32, max: u32 },
}

impl Default for HistoryRadius {
    fn default() -> Self {
        Self::Adaptive { min: 8, max: 16 }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum HistoryInvalidation {
    #[default]
    Auto,
    Manual,
}

/// Offline history and stabilization options.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TemporalOptions {
    /// Window size in each direction, from 0 through 32.
    pub history_radius: HistoryRadius,
    /// Display stabilization radius, from 0 through 3. Default 3.
    pub post_radius: u32,
    /// Suppress isolated impulses. Default true, requires post stabilization.
    pub stabilize_sparkle: bool,
    /// Accumulate albedo and normal for offline OIDN when the history radius is positive. Default false.
    pub accumulate_guides: bool,
    /// Follow apparent reflection motion, with curvature correction in perspective
    /// views. Changing reflections and uncertain motion can leave more noise.
    /// Default false.
    /// Enable [crate::api::RenderSettings::capture_reflections] on input renders.
    pub reflection_motion: bool,
    /// Default Auto. Light edits can reduce history locally.
    /// Manual uses explicit cuts and frame gaps only.
    pub history_invalidation: HistoryInvalidation,
    /// Maximum temporal GPU bytes. Default None selects the full plan.
    pub memory_budget: Option<u64>,
}
impl Default for TemporalOptions {
    fn default() -> Self {
        Self {
            history_radius: Default::default(),
            post_radius: 3,
            stabilize_sparkle: true,
            accumulate_guides: false,
            reflection_motion: false,
            history_invalidation: HistoryInvalidation::Auto,
            memory_budget: None,
        }
    }
}
/// Effective history, post radius, and temporal memory estimate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TemporalPlan {
    pub min: u32,
    pub max: u32,
    pub post_radius: u32,
    pub bytes: u64,
}
impl TemporalPlan {
    /// Number of future inputs required before an output is ready.
    pub fn latency(self) -> u32 {
        self.max + self.post_radius
    }
    pub(super) fn ready_count(self, count: u32, flush: bool) -> u32 {
        if flush {
            count
        } else {
            count.saturating_sub(self.latency())
        }
    }
    pub(super) fn slots(self) -> u32 {
        (2 * self.max).max(self.max + 2 * self.post_radius) + 1
    }
    pub(super) fn guide_slots(self, accumulate_guides: bool) -> u32 {
        if accumulate_guides {
            self.slots()
        } else {
            self.max + 1
        }
    }
    pub(super) fn post_slots(self) -> u32 {
        if self.post_radius == 0 {
            0
        } else {
            2 * self.post_radius + 1
        }
    }
}
#[derive(Clone, Copy)]
pub(super) enum SpatialCost {
    Oidn,
    None,
    Custom,
}
impl TemporalOptions {
    /// Returns an error for out-of-range radii or incompatible sparkle settings.
    pub fn validate(self) -> std::result::Result<(), String> {
        let (min, max) = self.range();
        if min > max || max > 32 {
            return Err("historyRadius requires 0 <= min <= max <= 32".into());
        }
        if self.post_radius > 3 || self.post_radius == 0 && self.stabilize_sparkle {
            return Err(
                "postRadius must be 0 through 3; set stabilizeSparkle to false for radius 0".into(),
            );
        }
        if self
            .memory_budget
            .is_some_and(|n| n > 9_007_199_254_740_991)
        {
            return Err("memoryBudget must be a non-negative safe integer".into());
        }
        Ok(())
    }
    fn range(self) -> (u32, u32) {
        match self.history_radius {
            HistoryRadius::Fixed(n) => (n, n),
            HistoryRadius::Adaptive { min, max } => (min, max),
        }
    }
    pub(super) fn guide_window(self, spatial: SpatialCost, max: u32) -> bool {
        self.accumulate_guides && matches!(spatial, SpatialCost::Oidn) && max > 0
    }
    pub(super) fn plans(
        self,
        size: [u32; 2],
        materials: usize,
        spatial: SpatialCost,
        limits: &wgpu::Limits,
    ) -> crate::Result<Vec<TemporalPlan>> {
        self.validate()?;
        let [w, h] = size.map(u64::from);
        if w == 0 || h == 0 || size.into_iter().max().unwrap() > limits.max_texture_dimension_2d {
            return Err("Invalid temporal dimensions".into());
        }
        let (mut min, mut max) = self.range();
        let post = self.post_radius;
        let mut tiers = vec![(min, max, post)];
        for n in [8, 4, 2] {
            if max > n {
                max = n;
                min = min.min(n);
                tiers.push((min, max, post));
            }
        }
        for p in [2, 1] {
            if post > p {
                tiers.push((min, max, p));
            }
        }
        if max > 1 || post > 0 {
            tiers.push((max.min(1), max.min(1), 0));
        }
        let mut out = Vec::new();
        for (min, max, post_radius) in tiers {
            let mut plan = TemporalPlan {
                min,
                max,
                post_radius,
                bytes: 0,
            };
            let history = u64::from(plan.slots());
            let post = u64::from(plan.post_slots());
            let accumulate_guides = self.guide_window(spatial, max);
            let guides = u64::from(plan.guide_slots(accumulate_guides));
            let px = w * h;
            let layer = |scale| w.div_ceil(scale) * h.div_ceil(scale) * 8;
            let pyramid = layer(2) + layer(4) + layer(8);
            let grid = 4 * layer(6) + 2 * layer(12) + 2 * layer(24);
            let revisions = (materials as u64 * 8).max(8);
            let changed = post * ((materials as u64 + 1) * 4).max(8);
            let overflow = history * 4096 * 32;
            let max_buffer = limits
                .max_buffer_size
                .min(limits.max_storage_buffer_binding_size as u64);
            if history * 2 > limits.max_texture_array_layers as u64
                || (self.reflection_motion && px * 96 > max_buffer)
                || [px * 16, overflow, history * 80, revisions, changed]
                    .into_iter()
                    .any(|bytes| bytes > max_buffer)
            {
                continue;
            }
            let frames = 4
                * px
                * if matches!(spatial, SpatialCost::Oidn) {
                    96
                } else {
                    80
                };
            plan.bytes = history * (px * 60 + 80)
                + overflow
                // Specular RGB, endpoint records and half-precision motion per history
                // slot. Include the window sum, center capture and beauty/checkpoint sums.
                + if self.reflection_motion { px * (24 * history + 80) } else { 0 }
                + guides * px * 16
                + 32
                + px * if accumulate_guides { 64 } else { 32 }
                + 112
                + post * (px * 16 + pyramid)
                + if post > 0 { px * 76 + grid + 120 } else { 0 }
                + px.div_ceil(64) * 4
                + 16
                + if self.stabilize_sparkle && post > 0 {
                    32
                } else {
                    0
                }
                + frames
                + px * (u64::from(post_radius) * 64 + 32)
                + revisions
                + changed
                + if matches!(spatial, SpatialCost::Custom) {
                    guides * px * 32
                } else {
                    0
                };
            if self.memory_budget.is_none_or(|b| plan.bytes <= b) {
                out.push(plan);
            }
        }
        if out.is_empty() {
            return Err("Temporal budget or device limits cannot fit the minimum plan".into());
        }
        Ok(out)
    }
    /// Estimates offline OIDN memory before a device is selected. A device may impose tighter limits.
    pub fn estimate(self, size: [u32; 2], materials: usize) -> crate::Result<TemporalPlan> {
        self.plan(
            size,
            materials,
            &wgpu::Limits {
                max_texture_dimension_2d: 16384,
                max_buffer_size: u64::MAX,
                max_storage_buffer_binding_size: u32::MAX as _,
                ..Default::default()
            },
        )
    }
    /// Estimates the first offline OIDN plan that fits the supplied device limits and budget.
    pub fn plan(
        self,
        size: [u32; 2],
        materials: usize,
        limits: &wgpu::Limits,
    ) -> crate::Result<TemporalPlan> {
        Ok(self.plans(size, materials, SpatialCost::Oidn, limits)?[0])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guide_window_budget_reduces_the_enabled_plan_first() {
        let disabled = TemporalOptions::default();
        let enabled = TemporalOptions { accumulate_guides: true, ..disabled };
        let size = [1280, 720];
        let enabled_plan = enabled.estimate(size, 0).unwrap();
        let disabled_plan = disabled.estimate(size, 0).unwrap();
        assert_eq!(enabled_plan.bytes - disabled_plan.bytes, 265_420_800);
        let constrained = TemporalOptions { memory_budget: Some(disabled_plan.bytes), ..enabled };
        let plans = constrained.plans(size, 0, SpatialCost::Oidn, &wgpu::Limits::default()).unwrap();
        assert_eq!((plans[0].max, plans[1].max), (8, 4));
    }

    #[test]
    fn reflection_motion_is_opt_in_and_counts_the_history_allocation() {
        let legacy = TemporalOptions::default();
        assert!(!legacy.reflection_motion);
        let options = TemporalOptions {
            reflection_motion: true,
            ..legacy
        };
        let size = [1280, 720];
        let original = legacy.estimate(size, 0).unwrap();
        let reflected = options.estimate(size, 0).unwrap();
        assert_eq!(reflected.max, 16);
        assert_eq!(reflected.bytes - original.bytes, 803_635_200);
        let constrained = TemporalOptions {
            memory_budget: Some(original.bytes),
            ..options
        };
        assert!(constrained.estimate(size, 0).unwrap().max < 16);
    }

    #[test]
    fn shared_memory_contract() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/temporal-offline.json"
        ))
        .unwrap();
        for case in f["options"].as_array().unwrap() {
            let mut input = case["input"].clone();
            input.as_object_mut().unwrap().remove("denoiser");
            let opts: TemporalOptions = serde_json::from_value(input).unwrap();
            let expected = &case["expected"];
            let (min, max) = opts.range();
            assert_eq!(
                serde_json::json!({"min":min,"max":max}),
                expected["historyRadius"]
            );
            let fields = serde_json::to_value(opts).unwrap();
            for field in [
                "postRadius",
                "stabilizeSparkle",
                "accumulateGuides",
                "reflectionMotion",
                "historyInvalidation",
                "memoryBudget",
            ] {
                assert_eq!(fields[field], expected[field]);
            }
        }
        for case in f["schedule"].as_array().unwrap() {
            let opts: TemporalOptions = serde_json::from_value(case["input"].clone()).unwrap();
            let plan = opts.plan([16, 16], 0, &Default::default()).unwrap();
            assert_eq!(u64::from(plan.latency()), case["latency"].as_u64().unwrap());
            let count = case["pushed"].as_u64().unwrap() as u32;
            assert_eq!(
                i64::from(plan.ready_count(count, case["flush"].as_bool().unwrap())) - 1,
                case["ready"].as_i64().unwrap()
            );
        }
        for c in f["memory"].as_array().unwrap() {
            let mut raw = c["input"].clone();
            let cost = if raw.as_object_mut().unwrap().remove("denoiser").is_some() {
                SpatialCost::None
            } else {
                SpatialCost::Oidn
            };
            let options: TemporalOptions = serde_json::from_value(raw).unwrap();
            let limits = wgpu::Limits {
                max_texture_dimension_2d: 16384,
                max_texture_array_layers: c["overrides"]["maxTextureArrayLayers"]
                    .as_u64()
                    .unwrap_or(256) as u32,
                max_storage_buffer_binding_size: 134217728,
                max_buffer_size: 268435456,
                ..Default::default()
            };
            let plan = options
                .plans(
                    [
                        c["width"].as_u64().unwrap() as u32,
                        c["height"].as_u64().unwrap() as u32,
                    ],
                    c["materials"].as_u64().unwrap() as usize,
                    cost,
                    &limits,
                )
                .unwrap()[0];
            let e = &c["expected"];
            assert_eq!(plan.bytes, e["bytes"].as_u64().unwrap());
            assert_eq!(
                (plan.min, plan.max, plan.post_radius),
                (
                    e["historyRadius"]["min"].as_u64().unwrap() as u32,
                    e["historyRadius"]["max"].as_u64().unwrap() as u32,
                    e["postRadius"].as_u64().unwrap() as u32
                )
            );
        }
        for c in f["invalid"].as_array().unwrap() {
            assert!(serde_json::from_value::<TemporalOptions>(c.clone())
                .map_or(true, |o| o.validate().is_err()));
        }
    }
}
