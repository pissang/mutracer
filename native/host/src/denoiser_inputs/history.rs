use super::*;
use std::sync::Arc;

/// Only data required for correspondence, copied or versioned before publication.
/// Stable IDs refer to scene objects, never to reordered BVH node/leaf indices.
#[derive(Default)]
pub(crate) struct GeometrySnapshot {
    pub aov_words: Vec<u32>,
    pub instances: Vec<InstanceSnapshot>,
    pub deformations: Vec<DeformationSnapshot>,
    /// Retains the exact publication without copying an entire scene every frame.
    pub publication: Arc<()>,
}
pub(crate) struct InstanceSnapshot {
    pub stable_id: u64,
    pub topology_revision: u64,
    pub transform: [f32; 16],
}
pub(crate) struct DeformationSnapshot {
    pub stable_geometry_id: u64,
    pub topology_revision: u64,
    /// Immutable previous positions and triangle correspondence; producer must
    /// rotate buffers instead of writing through these handles after publication.
    pub positions: wgpu::Buffer,
    pub stable_triangle_ids: wgpu::Buffer,
}

pub(crate) struct Snapshot<R> {
    pub key: FrameKey,
    pub metadata: FrameMetadata,
    pub geometry: GeometrySnapshot,
    pub resources: R,
}
pub(crate) struct InputFrame<R> {
    pub version: u32,
    pub current: Arc<Snapshot<R>>,
    // A snapshot has no previous pointer: accepting frames cannot retain an
    // unbounded recursive chain of all historical GPU resources.
    pub previous: Option<Arc<Snapshot<R>>>,
    pub reset_reasons: Vec<ResetReason>,
}
impl<R> InputFrame<R> {
    pub fn key(&self) -> FrameKey {
        self.current.key
    }
    pub fn previous_frame_id(&self) -> Option<u64> {
        self.previous.as_ref().map(|p| p.key.frame)
    }
}

/// CPU history state. A single frame may await accept/reject per target.
/// Retirement is deliberately owned by submissions, independently of this state.
pub(crate) struct FrameHistory<R> {
    device: DeviceKey,
    target: u64,
    generation: u64,
    next_frame: u64,
    extent: [u32; 2],
    pending: Option<Arc<InputFrame<R>>>,
    previous: Option<Arc<Snapshot<R>>>,
    reset_reasons: Vec<ResetReason>,
    lost: bool,
}
impl<R> FrameHistory<R> {
    pub fn new(device: DeviceKey, extent: [u32; 2]) -> Self {
        Self {
            device,
            target: identity(),
            generation: 1,
            next_frame: 1,
            extent,
            pending: None,
            previous: None,
            reset_reasons: vec![ResetReason::FirstFrame],
            lost: false,
        }
    }
    pub fn prepare(
        &mut self,
        metadata: FrameMetadata,
        geometry: GeometrySnapshot,
        resources: R,
    ) -> crate::Result<Arc<InputFrame<R>>> {
        if self.lost {
            return Err("Frame input device is lost".into());
        }
        if self.pending.is_some() {
            return Err("Frame input target already has a pending frame".into());
        }
        metadata.validate()?;
        if metadata.input_extent != self.extent {
            return Err("Frame extent does not match target generation".into());
        }
        let next = self
            .next_frame
            .checked_add(1)
            .ok_or("Frame IDs exhausted")?;
        if self
            .previous
            .as_ref()
            .is_some_and(|p| p.metadata.output_extent != metadata.output_extent)
        {
            self.invalidate(ResetReason::ExtentChanged);
        }
        if self
            .previous
            .as_ref()
            .is_some_and(|p| !p.metadata.camera.same_projection(&metadata.camera))
        {
            self.invalidate(ResetReason::ProjectionChanged);
        }
        let current = Arc::new(Snapshot {
            key: FrameKey {
                device: self.device,
                target: self.target,
                generation: self.generation,
                frame: self.next_frame,
            },
            metadata,
            geometry,
            resources,
        });
        let frame = Arc::new(InputFrame {
            version: 1,
            current,
            previous: self.previous.clone(),
            reset_reasons: self.reset_reasons.clone(),
        });
        self.next_frame = next;
        self.pending = Some(frame.clone());
        Ok(frame)
    }
    pub fn pending(&self, key: FrameKey) -> crate::Result<&Arc<InputFrame<R>>> {
        self.pending
            .as_ref()
            .filter(|p| p.key() == key)
            .ok_or_else(|| "Stale, foreign or already consumed frame".into())
    }
    /// Only the GPU submission path can mint a receipt. Encode/evaluate and
    /// queue submission must succeed before this call; completion is not required.
    pub fn accept(&mut self, receipt: &FrameSubmission<R>) -> crate::Result<()> {
        if self.lost {
            return Err("Cannot accept a frame from a lost device".into());
        }
        self.pending(receipt.key())?;
        self.previous = Some(self.pending.take().unwrap().current.clone());
        self.reset_reasons.clear();
        Ok(())
    }
    pub fn reject(&mut self, key: FrameKey) -> crate::Result<()> {
        self.pending(key)?;
        self.pending = None;
        // Keep the last accepted CPU correspondence, but invalidate backend history.
        self.add_reset(ResetReason::ConsumerRejected);
        Ok(())
    }
    fn add_reset(&mut self, reason: ResetReason) {
        if !self.reset_reasons.contains(&reason) {
            self.reset_reasons.push(reason);
        }
    }
    pub fn invalidate(&mut self, reason: ResetReason) {
        self.pending = None;
        self.previous = None;
        self.add_reset(reason);
        // Invalidate prepared handles as well as the temporal model's history.
        self.generation = self
            .generation
            .checked_add(1)
            .expect("Frame generation exhausted");
    }
    pub fn resize(&mut self, extent: [u32; 2]) {
        if extent != self.extent {
            self.extent = extent;
            self.invalidate(ResetReason::ExtentChanged);
        }
    }
    pub fn device_lost(&mut self) {
        self.lost = true;
        self.invalidate(ResetReason::DeviceLost);
    }
    pub fn previous_frame_id(&self) -> Option<u64> {
        self.previous.as_ref().map(|p| p.key.frame)
    }
    pub fn previous_snapshot(&self) -> Option<&Arc<Snapshot<R>>> {
        self.previous.as_ref()
    }
}
