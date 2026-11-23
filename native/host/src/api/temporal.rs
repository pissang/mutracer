//! Independently sampled frames for resident temporal filters.
use super::*;
use crate::denoiser_inputs as frame;
pub use crate::denoiser_inputs::{
    CameraSnapshot as TemporalCamera, FrameMetadata as TemporalMetadata,
    GlassCapabilities as TemporalGlassCapabilities, GlassCapability as TemporalGlassCapability,
    GlassKind as TemporalGlassKind, GlassMotion as TemporalGlassMotion, Guide as TemporalGuide,
    GuideModel as TemporalGuideModel, InputCapabilities as TemporalCapabilities,
    Projection as TemporalProjection, ResetReason as TemporalResetReason,
    Support as TemporalSupport,
};
use std::sync::Arc;
use std::time::Instant;

/// Immutable independently sampled frame. Guide textures are top row first; raw pixel
/// records and stable RGBA32UI IDs are bottom row first. Keep this object alive
/// until submitted work completes; never destroy or write its borrowed resources.
#[derive(Clone)]
pub struct TemporalFrame {
    pub(crate) frame: Arc<frame::GpuFrame>,
}
impl TemporalFrame {
    /// Perspective correspondence through a stationary thin pane or parallel slab.
    /// Bottom-row-first RGBA32F. XY is previous minus current in input pixels,
    /// Z is 1 if a compatible previous sampled path is present, and W is reserved.
    /// Present only on request via `CustomDenoiser::temporal_transmission_motion`
    /// for perspective frames. The NVIDIA reflection input describes reflected paths.
    pub fn transmission_motion(&self) -> Option<&wgpu::Buffer> {
        self.frame.current.resources.transmission_motion.as_ref()
    }
    /// Current unjittered camera, jitter, sequence and capability declarations.
    pub fn metadata(&self) -> &TemporalMetadata {
        &self.frame.current.metadata
    }
    /// Last accepted frame metadata; None after a reset or before acceptance.
    pub fn previous_metadata(&self) -> Option<&TemporalMetadata> {
        self.frame.previous.as_ref().map(|p| &p.metadata)
    }
    /// Reasons the consumer must discard its temporal history. Empty when reusable.
    pub fn reset_reasons(&self) -> &[TemporalResetReason] {
        &self.frame.reset_reasons
    }
    /// Borrowed immutable texture, top row first, with the format declared by
    /// `TemporalGuide::format`. Unsupported guides return None.
    pub fn guide(&self, kind: TemporalGuide) -> Option<&wgpu::Texture> {
        self.frame.current.resources.guide(kind).map(|g| &g.texture)
    }
    /// Object, local instance, material, source triangle; UINT32_MAX for background.
    pub fn stable_ids(&self) -> &wgpu::Buffer {
        self.frame.current.resources.stable_ids.as_ref().unwrap()
    }
    /// First-surface, optical and RNG records; each pixel occupies 240 bytes.
    pub fn pixel_records(&self) -> &wgpu::Buffer {
        &self.frame.current.resources.producer_buffers[6]
    }
    /// Bytes of current and previous owned temporal frame resources, including
    /// guides and trace buffers. Does not measure total driver VRAM usage.
    pub fn resident_frame_bytes(&self) -> [u64; 2] {
        [
            self.frame.current.resources.gpu_bytes,
            self.frame
                .previous
                .as_ref()
                .map_or(0, |p| p.resources.gpu_bytes),
        ]
    }
    /// Diagnostic first optical path, bottom row first, 32 bytes per pixel.
    /// Lane 0 contains endpoint xyz and geometric length, with zero length
    /// until a finite endpoint is sampled. Lane 1 stores a bitcast vec3 and
    /// a u32. For reflection the vec3 is its plane normal and the low 27 bits
    /// are the terminal instance. For transmission bit 31 marks the branch,
    /// bit 30 a solid, bit 29 a finite terminal, bit 28 an environment miss,
    /// bit 27 a sampled exit and bit 26 two nearly parallel geometric normals.
    /// For transmission the low 26 bits are the terminal instance, and the vec3
    /// is the exit position when bit 27 is set. All-ones low bits mean no instance.
    /// These are sampled records,
    /// and incomplete paths carry no valid terminal.
    pub fn optical_path_records(&self) -> &wgpu::Buffer {
        &self.frame.current.resources.producer_buffers[7]
    }
}
pub(crate) struct Request<'a> {
    pub context: u64,
    pub size: [u32; 2],
    pub output_size: [u32; 2],
    pub camera: &'a [u8],
    pub settings: &'a crate::settings::RenderSettings,
    pub quality: u32,
    pub alpha: u32,
    pub scene_revision: u64,
    pub camera_revision: u64,
    pub sample_count: u32,
    pub transmission_motion: bool,
    pub guide_model: TemporalGuideModel,
}
pub(crate) struct State {
    history: frame::GpuFrameHistory,
    pending: Option<frame::FrameSubmission<frame::GpuFrameResources>>,
    producer: Option<frame::FrameProducer>,
    source: String,
    guide_model: TemporalGuideModel,
    sequence: u32,
    sample_cursor: u32,
    last: Option<Instant>,
    projection: Option<(Camera, [u32; 2], glam::Mat4)>,
}
impl State {
    pub fn new(gpu: &crate::GpuDevice, size: [u32; 2]) -> Self {
        Self {
            history: frame::GpuFrameHistory::new(gpu.frame_device, size),
            pending: None,
            producer: None,
            source: String::new(),
            guide_model: TemporalGuideModel::Physical,
            sequence: 0,
            sample_cursor: 0,
            last: None,
            projection: None,
        }
    }
    pub fn reject(&mut self) {
        if let Some(receipt) = self.pending.take() {
            let _ = self.history.reject(receipt.key());
        }
    }
    pub fn accept(&mut self) -> crate::Result<()> {
        if let Some(receipt) = self.pending.take() {
            self.history.accept(&receipt)?;
        }
        Ok(())
    }
    pub fn reset(&mut self) {
        self.reject();
        self.history.invalidate(frame::ResetReason::Explicit);
    }
    pub fn produce(&mut self, request: Request<'_>) -> crate::Result<TemporalFrame> {
        self.history.resize(request.size);
        let (snapshot, retained) = crate::context::temporal_query(request.context)?;
        let packet = retained.target(
            request.settings,
            request.size,
            request.quality,
            request.alpha,
            snapshot.hwrt_shader,
            request.camera,
            &snapshot.gpu.loss,
            true,
        )?;
        let source = packet.shader.ok_or("Missing temporal frame shader")?;
        if self.producer.is_none()
            || self.source != source
            || self.guide_model != request.guide_model
        {
            self.producer = Some(frame::FrameProducer::new_snapshot(
                &snapshot,
                source.clone(),
                request.guide_model,
            )?);
            if self.guide_model != request.guide_model {
                self.reset();
            }
            self.source = source;
            self.guide_model = request.guide_model;
        }
        let camera_values: Vec<_> = bytemuck::pod_collect_to_vec::<u8, f32>(&packet.camera);
        let raw = Camera::from_bytes(request.camera).ok_or("Invalid temporal camera")?;
        let world = glam::Mat4::from_cols_slice(&camera_values[16..32]);
        let view = world.inverse();
        // Removing a translated view from the already rounded FP32 inverse VP
        // loses precision, especially with small near planes. Pack the same
        // lens with an identity view through the shared camera implementation.
        // Cache it across ordinary camera movement; do not duplicate TS math.
        let mut lens = raw;
        lens.world_matrix = glam::Mat4::IDENTITY.to_cols_array();
        if self
            .projection
            .as_ref()
            .is_none_or(|(camera, size, _)| *camera != lens || *size != request.size)
        {
            let packed =
                crate::scene::prepare_camera(&lens.to_bytes(), request.size[0], request.size[1])?;
            let values: Vec<_> = bytemuck::pod_collect_to_vec::<u8, f32>(&packed[..64]);
            self.projection = Some((lens, request.size, glam::Mat4::from_cols_slice(&values)));
        }
        let projection_inverse = self.projection.as_ref().unwrap().2;
        let camera = frame::CameraSnapshot {
            view: view.to_cols_array(),
            projection: projection_inverse.inverse().to_cols_array(),
            view_inverse: world.to_cols_array(),
            projection_inverse: projection_inverse.to_cols_array(),
            near: raw.near_clip,
            far: raw.far_clip,
            kind: if raw.projection == 0 {
                frame::Projection::Perspective
            } else {
                frame::Projection::Orthographic
            },
            aperture_radius: camera_values[32],
        };
        let next_frame = self
            .sequence
            .checked_add(1)
            .ok_or("Temporal frame sequence exhausted")?;
        let next_sample = self
            .sample_cursor
            .checked_add(request.sample_count)
            .ok_or("Temporal sample sequence exhausted")?;
        let metadata = frame::FrameMetadata {
            scene_revision: request.scene_revision,
            camera_revision: request.camera_revision,
            seed: request.settings.seed,
            sample_index: self.sample_cursor,
            sample_count: request.sample_count,
            jitter_pixels: [halton(next_frame, 2) - 0.5, halton(next_frame, 3) - 0.5],
            input_extent: request.size,
            output_extent: request.output_size,
            camera,
            delta_seconds: self
                .last
                .map_or(1. / 60., |t| t.elapsed().as_secs_f32().max(1e-6)),
            pre_exposure: 1.,
            capabilities: Default::default(),
        };
        let words = retained.aov_metadata(request.camera, request.size)?;
        if let Some(previous) = self.history.previous_snapshot() {
            let old = &previous.geometry.aov_words;
            let mut topology = std::collections::HashMap::new();
            if old.len() >= 52 {
                for o in (52..old[16] as usize).step_by(24) {
                    topology.insert((old[o], old[o + 1]), (old[o + 20], old[o + 22]));
                }
            }
            if (52..words[16] as usize).step_by(24).any(|o| {
                topology
                    .get(&(words[o], words[o + 1]))
                    .is_some_and(|v| *v != (words[o + 20], words[o + 22]))
            }) {
                self.history.invalidate(frame::ResetReason::TopologyChanged);
            }
        }
        let geometry = frame::GeometrySnapshot {
            aov_words: words,
            ..Default::default()
        };
        let (frame, dependency) = self.producer.as_ref().unwrap().produce_snapshot(
            &snapshot,
            &mut self.history,
            metadata,
            geometry,
            &packet.camera,
            &packet.trace,
            request.transmission_motion,
        )?;
        let receipt = self
            .history
            .submit_pending(&snapshot.gpu, dependency, |_| {
                Ok(frame::EvaluatedCommands {
                    native: vec![],
                    consumer: vec![],
                })
            })?;
        self.pending = Some(receipt);
        self.sample_cursor = next_sample;
        self.sequence = next_frame;
        self.last = Some(Instant::now());
        Ok(TemporalFrame { frame })
    }
}
fn halton(mut index: u32, base: u32) -> f32 {
    let mut value = 0.;
    let mut scale = 1.;
    while index > 0 {
        scale /= base as f32;
        value += scale * (index % base) as f32;
        index /= base;
    }
    value
}

pub use crate::denoiser_inputs::FramePixelRecord as TemporalPixelRecord;
pub use crate::denoiser_inputs::validity as temporal_validity;
