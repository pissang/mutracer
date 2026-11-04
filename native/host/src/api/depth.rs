use super::{Engine, Result, Status, error};

/// Depth queries always return a 7×7 grid.
pub const DEPTH_SAMPLE_GRID: usize = 7;
/// Number of depths returned by one query.
pub const DEPTH_SAMPLE_COUNT: usize = DEPTH_SAMPLE_GRID * DEPTH_SAMPLE_GRID;

/// Square sampling area in viewport coordinates; all fields are required.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DepthSampleArea {
    /// Horizontal center, 0..1 from the left.
    pub x: f32,
    /// Vertical center, 0..1 from the top.
    pub y: f32,
    /// Half height as a fraction of viewport height; nonnegative, 0 queries one point.
    pub size: f32,
}
impl DepthSampleArea {
    pub(super) fn pack(self, aspect: f32) -> Result<[f32; 4]> {
        if ![self.x, self.y, self.size, aspect]
            .iter()
            .all(|v| v.is_finite())
            || !(0. ..=1.).contains(&self.x)
            || !(0. ..=1.).contains(&self.y)
            || self.size < 0.
            || aspect <= 0.
            || !(self.size / aspect).is_finite()
        {
            return Err(error(
                Status::InvalidArgument,
                "Depth sampling requires a center in 0..1, nonnegative size and positive aspect",
            ));
        }
        Ok([self.x, 1. - self.y, self.size / aspect, self.size])
    }
}
/// Source identities returned by a GPU viewport query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SurfaceHit {
    /// Source mesh AOV ID.
    pub object: u32,
    /// Source material AOV ID.
    pub material: u32,
    /// Local instance index; zero for an ordinary mesh.
    pub instance: u32,
}
/// Result of an internal viewer surface query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfacePick {
    /// No committed scene, preparation pending, or inputs changed during readback.
    Unavailable,
    /// The pinhole ray missed all visible surfaces.
    Background,
    /// The nearest visible surface and its source identities.
    Hit(SurfaceHit),
}
impl Engine {
    /// Queries 7×7 pinhole depths using the committed engine camera and display
    /// aspect, independently of render sizes and converge camera overrides.
    /// Returns None before a scene is committed or while preparing; call again
    /// later. Blocks for GPU compilation/readback (first query can cost more).
    /// Depths are distances along camera forward in scene units, top row first;
    /// misses/out-of-viewport rays are 0. Skips invisible catchers and alpha
    /// holes through at most 32 layers. No jitter/DOF, accumulation or denoising.
    pub fn read_depth_samples(
        &self,
        area: DepthSampleArea,
    ) -> Result<Option<[f32; DEPTH_SAMPLE_COUNT]>> {
        self.query_surface(area, false, |query, camera, packed| {
            query.read(camera, packed)
        })
    }
    /// Internal viewer picking at normalized top-left viewport coordinates.
    /// Rejects non-finite/out-of-range coordinates. Blocks for lazy GPU compilation
    /// and a small readback; skips alpha holes and invisible catchers like depth queries.
    /// Returns Unavailable when the scene/camera/viewport changes during the query.
    #[doc(hidden)]
    pub fn pick_surface(&self, x: f32, y: f32) -> Result<SurfacePick> {
        match self.query_surface(
            DepthSampleArea { x, y, size: 0. },
            true,
            |query, camera, packed| query.pick(camera, packed),
        )? {
            None => Ok(SurfacePick::Unavailable),
            Some(None) => Ok(SurfacePick::Background),
            Some(Some([object, material, instance])) => Ok(SurfacePick::Hit(SurfaceHit {
                object,
                material,
                instance,
            })),
        }
    }
    fn query_surface<T>(
        &self,
        area: DepthSampleArea,
        reject_stale: bool,
        read: impl FnOnce(crate::depth::Query, &[u8], [f32; 4]) -> crate::Result<T>,
    ) -> Result<Option<T>> {
        area.pack(1.)?;
        self.poll_device();
        let result = crate::runtime::with_loss(&self.inner.gpu, || {
            let (context, camera, size, revisions) = {
                let mut state = self.live()?;
                let Some(scene) = state.scene.clone() else {
                    return Ok(None);
                };
                let mut events = Vec::new();
                let step = super::render::scene_step(&mut state, false, &mut events);
                for event in events {
                    if let super::EngineEvent::Error { message } = &event {
                        state.last_error = Some(message.clone());
                    }
                    state.engine_events.push(event);
                }
                match step? {
                    super::render::SceneStep::Published => {}
                    super::render::SceneStep::Waiting => return Ok(None),
                    super::render::SceneStep::Failed(message) => {
                        return Err(error(Status::ContextFailed, message));
                    }
                }
                let camera = match state.camera {
                    Some(camera) => camera,
                    None => {
                        let offset = super::engine::camera_offset(&scene)?;
                        scene[offset..offset + 128].try_into().unwrap()
                    }
                };
                (
                    state.shared.context().unwrap(),
                    camera,
                    state.display.size,
                    (state.scene_revision, state.camera_revision),
                )
            };
            // Neither the engine state nor process registry is held during AOT
            // packing, lazy compilation or the GPU readback wait.
            let camera = crate::scene::prepare_camera(&camera, size[0], size[1]).map_err(|e| {
                error(
                    crate::status::classify(e.as_ref(), Status::InvalidArgument),
                    e.to_string(),
                )
            })?;
            let Some(query) = crate::context::depth_query(context).map_err(|e| {
                error(
                    crate::status::classify(e.as_ref(), Status::Error),
                    e.to_string(),
                )
            })?
            else {
                return Ok(None);
            };
            let samples = crate::platform_scope(|| {
                read(query, &camera, area.pack(size[0] as f32 / size[1] as f32)?)
            })
            .map_err(|e| {
                error(
                    crate::status::classify(e.as_ref(), Status::Error),
                    e.to_string(),
                )
            })?;
            self.check_device()?;
            let state = self.live()?;
            if reject_stale
                && ((state.scene_revision, state.camera_revision) != revisions
                    || state.display.size != size)
            {
                return Ok(None);
            }
            Ok(Some(samples))
        });
        self.flush();
        result
    }
}
