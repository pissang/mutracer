//! Opt-in native frame inputs. These are renderer contracts, not NGX formats.
//!
//! A frame owns both current and previous snapshots. Consumer acceptance advances
//! history; queue completion only retires GPU leases. No public C ABI is frozen.
// The producer and SDK bridge are staged independently. Keep the internal
// contract available before every guide has a production implementation.
#![allow(dead_code)]

mod glass;
mod gpu;
mod history;
mod producer;

pub use glass::*;
pub use gpu::Guide;
pub(crate) use gpu::*;
pub(crate) use history::*;
pub use producer::FramePixelRecord;
pub(crate) use producer::*;

use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) fn identity() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .expect("Native frame identities exhausted")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DeviceKey {
    pub id: u64,
    pub generation: u64,
}
impl DeviceKey {
    pub fn new() -> Self {
        Self {
            id: identity(),
            generation: 1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FrameKey {
    pub device: DeviceKey,
    pub target: u64,
    pub generation: u64,
    pub frame: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetReason {
    FirstFrame,
    Explicit,
    CameraCut,
    ExtentChanged,
    ProjectionChanged,
    TargetRebuilt,
    DeviceLost,
    TopologyChanged,
    MaterialChanged,
    LightingChanged,
    ConsumerRejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Projection {
    Perspective,
    Orthographic,
}

/// Column-major, unjittered matrices. Native camera clip Z is [-1, 1].
#[derive(Clone, Debug)]
pub struct CameraSnapshot {
    pub view: [f32; 16],
    pub projection: [f32; 16],
    pub view_inverse: [f32; 16],
    pub projection_inverse: [f32; 16],
    pub near: f32,
    pub far: f32,
    pub kind: Projection,
    pub aperture_radius: f32,
}
impl CameraSnapshot {
    pub fn same_projection(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.near == other.near
            && self.far == other.far
            && self.projection.iter().zip(other.projection).all(|(a, b)| {
                // Deriving P from the packed inverse view-projection involves
                // FP32 inversions. Camera translation must not look like a FOV
                // change merely because its cancellation leaves a few ULPs.
                (a - b).abs() <= 2e-6 * a.abs().max(b.abs()).max(1.)
            })
    }
    fn validate(&self) -> crate::Result<()> {
        if self.aperture_radius != 0.0 {
            return Err("Frame inputs require a pinhole camera".into());
        }
        if !self.near.is_finite()
            || !self.far.is_finite()
            || self.near < 0.0
            || self.far <= self.near
        {
            return Err("Invalid frame camera clipping range".into());
        }
        for matrix in [
            &self.view,
            &self.projection,
            &self.view_inverse,
            &self.projection_inverse,
        ] {
            let matrix = glam::Mat4::from_cols_array(matrix);
            if !matrix.is_finite() || matrix.determinant().abs() < 1e-20 {
                return Err("Invalid frame camera matrix".into());
            }
        }
        Ok(())
    }
}

/// This describes a separate 1-spp frame, never a difference of accumulations.
#[derive(Clone, Debug)]
pub struct FrameMetadata {
    pub scene_revision: u64,
    pub camera_revision: u64,
    pub seed: u32,
    pub sample_index: u32,
    pub sample_count: u32,
    /// Offset from pixel centers, input pixels, x right and y down.
    pub jitter_pixels: [f32; 2],
    pub input_extent: [u32; 2],
    pub output_extent: [u32; 2],
    pub camera: CameraSnapshot,
    pub delta_seconds: f32,
    /// Fixed at one: display exposure never enters frame radiance.
    pub pre_exposure: f32,
    pub capabilities: InputCapabilities,
}
impl FrameMetadata {
    fn validate(&self) -> crate::Result<()> {
        self.camera.validate()?;
        if self.input_extent.contains(&0) || self.output_extent != self.input_extent {
            return Err("Initial frame inputs require nonempty DLAA extents".into());
        }
        if self.sample_count != 1 {
            return Err("Initial frame inputs require exactly one sample".into());
        }
        if self.pre_exposure != 1.0
            || !self.delta_seconds.is_finite()
            || self.delta_seconds <= 0.0
            || !self
                .jitter_pixels
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 0.5)
        {
            return Err("Invalid frame exposure, interval or jitter".into());
        }
        self.capabilities.validate()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Support {
    Unverified,
    Ready,
    Unsupported(String),
}

#[derive(Clone, Debug)]
pub struct InputCapabilities {
    pub noisy_color: Support,
    pub normal_roughness: Support,
    pub linear_depth: Support,
    pub diffuse_albedo: Support,
    pub specular_albedo: Support,
    pub first_surface: Support,
    pub camera_motion: Support,
    pub rigid_motion: Support,
    pub deformation_motion: Support,
    pub specular_distance: Support,
    /// Packed reflection motion and first-segment distance availability.
    pub specular_reflection: Support,
    pub glass: GlassCapabilities,
}
impl Default for InputCapabilities {
    fn default() -> Self {
        Self {
            noisy_color: Support::Unverified,
            normal_roughness: Support::Unverified,
            linear_depth: Support::Unverified,
            diffuse_albedo: Support::Unverified,
            specular_albedo: Support::Unverified,
            first_surface: Support::Unverified,
            camera_motion: Support::Unverified,
            rigid_motion: Support::Unverified,
            deformation_motion: Support::Unverified,
            specular_distance: Support::Unverified,
            specular_reflection: Support::Unverified,
            glass: GlassCapabilities::default(),
        }
    }
}
impl InputCapabilities {
    fn validate(&self) -> crate::Result<()> {
        self.glass.validate()
    }
}

/// Bit flags in temporal validity textures and `TemporalPixelRecord::identity[3]`.
/// These describe MuTracer surfaces and must be mapped to the consumer SDK.
pub mod validity {
    pub const PRIMARY_HIT: u32 = 1 << 0;
    /// Primary-surface correspondence only, never optical reflection/refraction.
    pub const MOTION: u32 = 1 << 1;
    pub const SPECULAR_HIT: u32 = 1 << 2;
    pub const SPECULAR_MISS: u32 = 1 << 3;
    pub const NO_SPECULAR: u32 = 1 << 4;
    pub const UNSUPPORTED_SURFACE: u32 = 1 << 5;
    pub const NO_HISTORY_COVERAGE: u32 = 1 << 6;
    pub const REFLECTANCE: u32 = 1 << 7;
    /// Virtual-image correspondence for the sampled reflection.
    pub const SPECULAR_MOTION: u32 = 1 << 8;
}

#[cfg(test)]
mod motion_tests;
#[cfg(test)]
mod producer_tests;
#[cfg(test)]
mod tests;
