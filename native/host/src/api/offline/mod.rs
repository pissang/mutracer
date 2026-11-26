//! Symmetric offline temporal reconstruction.
mod gpu;
mod plan;
use self::gpu::{Passes, Resource};
pub use self::plan::{HistoryInvalidation, HistoryRadius, TemporalOptions, TemporalPlan};
use super::{DisplaySettings, Engine, Image, Render};
use crate::{GpuDevice, Result};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
};

/// Optional GPU spatial filter for the windowed scene-linear color and current-frame guides.
/// All buffers are top row first, RGBA32F. Write the result before returning.
pub trait OfflineSpatialFilter {
    fn denoise(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        size: [u32; 2],
        color: &wgpu::Buffer,
        albedo: &wgpu::Buffer,
        normal: &wgpu::Buffer,
        output: &wgpu::Buffer,
    ) -> Result<()>;
}
/// Filter run after the history window. OIDN accepts the path to the HDR TZA file.
pub enum TemporalSpatial {
    Oidn(Option<PathBuf>),
    Custom(Box<dyn OfflineSpatialFilter>),
    None,
}
/// Finished frame. Pixels and GPU buffers remain valid until the frame is dropped.
pub struct OfflineFrame {
    pub index: u32,
    size: [u32; 2],
    gpu: GpuDevice,
    accumulated: Resource,
    denoised: Resource,
    codes: bool,
}
impl OfflineFrame {
    /// Reads top-row-first linear RGBA32F. Select accumulated for pre-spatial HDR.
    pub fn read_pixels(&self, accumulated: bool) -> Result<Image> {
        let buffer = if accumulated {
            &self.accumulated
        } else {
            &self.denoised
        };
        let bytes = super::checked_gpu(&self.gpu, "temporal frame readback", || {
            self.gpu
                .queue
                .read_buffer(&self.gpu.device, buffer.buffer().slice(..))
        })?;
        let mut data: Vec<f32> = bytemuck::pod_collect_to_vec(&bytes);
        if !accumulated && self.codes {
            for pixel in data.chunks_exact_mut(4) {
                for v in &mut pixel[..3] {
                    let s = (*v / 255.).clamp(0., 1.);
                    *v = if s <= 0.04045 {
                        s / 12.92
                    } else {
                        ((s + 0.055) / 1.055).powf(2.4)
                    };
                }
                pixel[3] = 1.;
            }
        }
        Ok(Image {
            width: self.size[0],
            height: self.size[1],
            data,
            id_data: None,
        })
    }
}
pub(super) struct Capture {
    pub raw: bool,
    pub reflections: Option<(wgpu::Buffer, wgpu::Buffer)>,
    pub check_camera: bool,
    pub size: [u32; 2],
    pub samples: u32,
    pub camera: [f32; 20],
    pub display: DisplaySettings,
    pub revisions: Vec<[u32; 2]>,
    pub scene_key: u64,
    pub guides: [wgpu::Buffer; 9],
}
struct State {
    frame: u32,
    epoch: u64,
    samples: u32,
    display: DisplaySettings,
    revisions: Vec<[u32; 2]>,
    custom: Option<[Resource; 2]>,
    accumulated: Option<Resource>,
    spatial: Option<Resource>,
}
/// Offline GPU history bound to one engine. Push converged frames, drain in order,
/// then call flush until it returns None. Queue capacity is four finished frames.
pub struct TemporalDenoiser {
    engine: Engine,
    options: TemporalOptions,
    spatial: TemporalSpatial,
    passes: Option<Passes>,
    oidn: Option<crate::oidn_webgpu::Denoiser>,
    display: Option<crate::display::Display>,
    frames: BTreeMap<u32, State>,
    finished: VecDeque<OfflineFrame>,
    count: u32,
    window: u32,
    output: u32,
    epoch: u64,
    previous: Option<(u32, u64, u64)>,
    flushing: bool,
    failed: bool,
}
impl TemporalDenoiser {
    /// Surface outputs required on every converged input render.
    pub const AOVS: u32 = 4 | 32 | 64 | 512 | 1024 | 2048;
    /// Creates an empty shot. Resources are allocated on the first push.
    pub fn new(
        engine: &Engine,
        options: TemporalOptions,
        spatial: TemporalSpatial,
    ) -> Result<Self> {
        options.validate()?;
        Ok(Self {
            engine: engine.clone(),
            options,
            spatial,
            passes: None,
            oidn: None,
            display: None,
            frames: Default::default(),
            finished: Default::default(),
            count: 0,
            window: 0,
            output: 0,
            epoch: 0,
            previous: None,
            flushing: false,
            failed: false,
        })
    }
    /// Effective plan after the first push.
    pub fn plan(&self) -> Option<TemporalPlan> {
        self.passes.as_ref().map(|p| p.plan)
    }
    /// Required future frames. Before first push this uses the requested radii.
    pub fn latency(&self) -> u32 {
        self.plan().map_or_else(
            || {
                let r = match self.options.history_radius {
                    HistoryRadius::Fixed(r) => r,
                    HistoryRadius::Adaptive { max, .. } => max,
                };
                r + self.options.post_radius
            },
            TemporalPlan::latency,
        )
    }
    /// Marks a boundary before the next input, preserving pending output.
    pub fn cut(&mut self) {
        self.epoch += 1;
    }
    fn prepare(&mut self, size: [u32; 2], materials: usize) -> Result<()> {
        if let Some(p) = &mut self.passes {
            if p.size != size {
                return Err("Flush before changing temporal dimensions".into());
            }
            if materials as u32 > p.material_capacity {
                let cost = match self.spatial {
                    TemporalSpatial::None => plan::SpatialCost::None,
                    TemporalSpatial::Custom(_) => plan::SpatialCost::Custom,
                    _ => plan::SpatialCost::Oidn,
                };
                let plans = self
                    .options
                    .plans(size, materials, cost, &p.gpu.device.limits())?;
                let updated = plans
                    .into_iter()
                    .find(|x| {
                        (x.min, x.max, x.post_radius)
                            == (p.plan.min, p.plan.max, p.plan.post_radius)
                    })
                    .ok_or("Growing material table exceeds temporal memory budget")?;
                p.resize_materials(materials as u32);
                p.plan = updated;
            }
            return Ok(());
        }
        let gpu = self.engine.inner.gpu.clone();
        let cost = match self.spatial {
            TemporalSpatial::None => plan::SpatialCost::None,
            TemporalSpatial::Custom(_) => plan::SpatialCost::Custom,
            _ => plan::SpatialCost::Oidn,
        };
        let plans = self
            .options
            .plans(size, materials, cost, &gpu.device.limits())?;
        for plan in plans.into_iter().take(2) {
            let validation = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
            let oom = gpu.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
            let allocation = (|| -> Result<_> {
                let passes = Passes::new(
                    gpu.clone(),
                    size,
                    plan,
                    materials,
                    self.options.stabilize_sparkle,
                    self.options.guide_window(cost, plan.max),
                    self.options.reflection_motion,
                )?;
                let spatial = match &self.spatial {
                    TemporalSpatial::Oidn(weights) => Some((
                        crate::oidn_webgpu::Denoiser::new_offline(
                            &gpu,
                            size,
                            weights.as_deref(),
                            self.options.memory_budget,
                        )?,
                        crate::display::Display::new(gpu.clone(), size),
                    )),
                    _ => None,
                };
                Ok((passes, spatial))
            })();
            let exhausted = pollster::block_on(oom.pop()).is_some();
            let invalid = pollster::block_on(validation.pop());
            if exhausted {
                continue;
            }
            if let Some(e) = invalid {
                return Err(e.to_string().into());
            }
            let (passes, spatial) = allocation?;
            if let Some((oidn, display)) = spatial {
                self.oidn = Some(oidn);
                self.display = Some(display);
            }
            self.passes = Some(passes);
            return Ok(());
        }
        Err("Temporal GPU allocation failed after reducing the plan".into())
    }
    /// Push a converged render from this engine. Index gaps start a new history epoch.
    pub fn push(&mut self, index: u32, render: &Render) -> Result<()> {
        self.check_push()?;
        let capture = super::checked_gpu(&self.engine.inner.gpu, "temporal input capture", || {
            render.offline_capture(
                &self.engine,
                self.options.history_invalidation == HistoryInvalidation::Auto,
                self.options.reflection_motion,
            )
        })?;
        self.push_capture(index, capture)
    }
    fn check_push(&self) -> Result<()> {
        if self.failed {
            return Err("Recreate the temporal denoiser after a failed frame".into());
        }
        if self.flushing {
            return Err("Finish flushing before pushing".into());
        }
        if self.finished.len() >= 4 {
            return Err("Drain temporal output before pushing another frame".into());
        }
        Ok(())
    }
    pub(super) fn push_capture(&mut self, index: u32, capture: Capture) -> Result<()> {
        self.check_push()?;
        let gpu = self.engine.inner.gpu.clone();
        let ready = self.finished.len();
        let result = super::checked_gpu(&gpu, "temporal window", || {
            self.insert_capture(index, capture)
        });
        if result.is_err() {
            self.finished.truncate(ready);
        } else {
            self.failed = false;
        }
        result
    }

    fn insert_capture(&mut self, index: u32, capture: Capture) -> Result<()> {
        self.prepare(capture.size, capture.revisions.len())?;
        self.failed = true;
        let p = self.passes.as_ref().unwrap();
        let i = self.count;
        let mut guides = capture.guides.map(Resource::Buffer);
        let raw_albedo = (self.options.reflection_motion && capture.raw)
            .then(|| Resource::Buffer(guides[3].buffer().clone()));
        if capture.raw {
            let [hdr, albedo, normal] = ["Color", "Albedo", "Normal"].map(|s| p.alloc(s, p.bytes));
            p.image_pass(
                "resolve",
                &p.size,
                &[&guides[4], &guides[3], &guides[7], &hdr, &albedo, &normal],
            );
            guides[4] = hdr;
            guides[3] = albedo;
            guides[7] = normal;
        }
        let auto = self.options.history_invalidation == HistoryInvalidation::Auto;
        let revisions = if auto { capture.revisions } else { Vec::new() };
        p.capture(
            i,
            &guides,
            &capture.camera,
            &revisions,
            capture.raw && self.options.reflection_motion,
        );
        if self.options.reflection_motion {
            let (radiance, records) = capture
                .reflections
                .ok_or("Missing offline reflection capture")?;
            p.capture_reflections(
                i,
                capture.samples,
                radiance,
                records,
                raw_albedo
                    .as_ref()
                    .ok_or("Reflection capture requires raw guides")?,
                &guides[4],
            );
        }
        if let Some((previous, scene, epoch)) = self.previous {
            if previous.checked_add(1) != Some(index)
                || auto
                    && (scene != capture.scene_key
                        || capture.check_camera
                            && epoch == self.epoch
                            && p.plan.max > 0
                            && p.camera_cut(i, &guides[8])?)
            {
                self.epoch += 1;
            }
        }
        self.previous = Some((index, capture.scene_key, self.epoch));
        let custom = matches!(self.spatial, TemporalSpatial::Custom(_))
            .then(|| [3, 7].map(|k| Resource::Buffer(guides[k].buffer().clone())));
        self.frames.insert(
            i,
            State {
                frame: index,
                epoch: self.epoch,
                samples: capture.samples,
                display: capture.display,
                revisions,
                custom,
                accumulated: None,
                spatial: None,
            },
        );
        self.count += 1;
        self.process(false)
    }
    fn neighbors(&self, i: u32, count: u32, radius: u32) -> Vec<u32> {
        (1..=radius)
            .flat_map(|d| [i.checked_sub(d), i.checked_add(d)])
            .flatten()
            .filter(|&j| j < count && self.frames[&i].epoch == self.frames[&j].epoch)
            .collect()
    }
    fn process(&mut self, flush: bool) -> Result<()> {
        let Some(plan) = self.plan() else {
            return Ok(());
        };
        let ready = if flush {
            self.count
        } else {
            self.count.saturating_sub(plan.max)
        };
        // Flush finishes one frame per call, so the tail is paced like the
        // stream instead of arriving in bursts of the queue capacity.
        let capacity = if flush { 1 } else { 4 };
        while self.window < ready && self.finished.len() < capacity {
            let i = self.window;
            let neighbors = self.neighbors(i, self.count, plan.max);
            let p = self.passes.as_ref().unwrap();
            p.clear("rejects", 0, 64);
            let profile = std::env::var_os("MUTRACER_TEMPORAL_WINDOW_TIMING").is_some();
            if profile {
                GpuDevice::wait(&p.gpu.device)?;
            }
            let start = std::time::Instant::now();
            p.window(i, i, 0, true);
            for j in neighbors {
                p.window(i, j, 1, true);
            }
            p.window(i, i, 2, true);
            if profile {
                GpuDevice::wait(&p.gpu.device)?;
                eprintln!(
                    "temporal window frame {} ms {:.3}",
                    self.frames[&i].frame,
                    start.elapsed().as_secs_f64() * 1000.
                );
            }
            p.dump_window(self.frames[&i].frame)?;
            let f = self.frames.get_mut(&i).unwrap();
            let acc = p.alloc("Accumulated temporal frame", p.bytes);
            p.copy(&p["window"], &acc);
            let spatial = match &mut self.spatial {
                TemporalSpatial::None => Resource::Buffer(acc.buffer().clone()),
                TemporalSpatial::Custom(filter) => {
                    let [alb, nrm] = f.custom.take().unwrap();
                    let out = p.alloc("Custom temporal output", p.bytes);
                    filter.denoise(
                        &p.gpu.device,
                        &p.gpu.queue,
                        p.size,
                        acc.buffer(),
                        alb.buffer(),
                        nrm.buffer(),
                        out.buffer(),
                    )?;
                    out
                }
                TemporalSpatial::Oidn(_) => {
                    let packed = ["color", "albedo", "normal"].map(|name| p.alloc(name, p.bytes));
                    p.pack(i, f.samples, &acc, &packed);
                    let [color, albedo, normal] = packed;
                    let display = self.display.as_mut().unwrap();
                    display.capture(
                        color.buffer(),
                        normal.buffer(),
                        albedo.buffer(),
                        color.buffer(),
                        Default::default(),
                        f.samples,
                    );
                    let [c, a] = display.oidn_display_inputs(&f.display.composition())?;
                    Resource::Buffer(self.oidn.as_mut().unwrap().submit_display(
                        &p.gpu,
                        &c,
                        &a,
                        normal.buffer(),
                        f.samples,
                        true,
                    )?)
                }
            };
            f.accumulated = Some(acc);
            if plan.post_radius == 0 {
                f.spatial = Some(spatial)
            } else {
                p.store_display(i, &spatial);
            }
            self.window += 1;
            self.publish(self.window.saturating_sub(plan.post_radius), capacity)?;
        }
        if flush && self.window == self.count {
            self.publish(plan.ready_count(self.count, true), capacity)?;
        }
        Ok(())
    }
    fn publish(&mut self, ready: u32, capacity: usize) -> Result<()> {
        let p = self.passes.as_ref().unwrap();
        while self.output < ready && self.finished.len() < capacity {
            let i = self.output;
            let denoised = if p.plan.post_radius == 0 {
                self.frames.get_mut(&i).unwrap().spatial.take().unwrap()
            } else {
                let current = &self.frames[&i].revisions;
                let neighbors = self
                    .neighbors(i, self.window, p.plan.post_radius)
                    .into_iter()
                    .map(|j| {
                        let old = &self.frames[&j].revisions;
                        let changed = current
                            .iter()
                            .filter(|row| {
                                old.binary_search_by_key(&row[0], |x| x[0])
                                    .ok()
                                    .is_none_or(|k| old[k][1] != row[1])
                            })
                            .map(|r| r[0])
                            .collect();
                        (j, changed)
                    })
                    .collect::<Vec<_>>();
                p.post(i, &neighbors, self.options.stabilize_sparkle)
            };
            let f = self.frames.get_mut(&i).unwrap();
            self.finished.push_back(OfflineFrame {
                index: f.frame,
                size: p.size,
                gpu: p.gpu.clone(),
                accumulated: f.accumulated.take().unwrap(),
                denoised,
                codes: p.plan.post_radius > 0,
            });
            self.output += 1;
            let keep = self
                .output
                .saturating_sub(p.plan.post_radius)
                .min(self.window.saturating_sub(p.plan.max));
            self.frames.retain(|index, _| *index >= keep);
        }
        Ok(())
    }
    /// Removes the oldest ready frame without advancing the shot.
    pub fn drain(&mut self) -> Option<OfflineFrame> {
        self.finished.pop_front()
    }
    /// Finishes the shot with truncated windows. Call until None before reusing the denoiser.
    pub fn flush(&mut self) -> Result<Option<OfflineFrame>> {
        if self.failed {
            return Err("Recreate the temporal denoiser after a failed frame".into());
        }
        self.flushing = true;
        if self.finished.is_empty() {
            self.failed = true;
            let gpu = self.engine.inner.gpu.clone();
            if let Err(error) = super::checked_gpu(&gpu, "temporal flush", || self.process(true)) {
                self.finished.clear();
                return Err(error);
            }
            self.failed = false;
        }
        if let Some(f) = self.drain() {
            return Ok(Some(f));
        }
        self.count = 0;
        self.window = 0;
        self.output = 0;
        self.frames.clear();
        self.previous = None;
        self.flushing = false;
        self.epoch = 0;
        self.passes = None;
        self.display = None;
        self.oidn = None;
        Ok(None)
    }
}

pub(super) fn scene_revisions(scene: &[u8]) -> (u64, Vec<[u32; 2]>) {
    use crate::layout::{header as h, light, material as m, mesh};
    use std::hash::{DefaultHasher, Hash, Hasher};
    // Inspect only the identity, lighting and material tables of a committed descriptor.
    let word = |i: usize| u32::from_le_bytes(scene[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
    let table = |i: usize, count: usize| &scene[i * 4..(i + count) * 4];
    use crate::layout::{extension, graph, texture};
    let stride = if word(h::VERSION) >= 7 {
        texture::WORDS
    } else {
        texture::WORDS - 1
    };
    let textures = (0..word(h::TEXTURE_COUNT))
        .map(|i| {
            let at = word(h::TEXTURE_OFFSET) + i * stride;
            let mut hash = DefaultHasher::new();
            table(at, 3).hash(&mut hash);
            table(at + texture::FLIP_Y, stride - texture::FLIP_Y).hash(&mut hash);
            let pixels = word(at + texture::WIDTH) * word(at + texture::HEIGHT);
            table(
                word(at + texture::PIXELS),
                pixels
                    * if word(at + texture::STORAGE) == 0 {
                        1
                    } else {
                        4
                    },
            )
            .hash(&mut hash);
            hash.finish()
        })
        .collect::<Vec<_>>();
    let mut global = DefaultHasher::new();
    for field in [h::ENVIRONMENT_TEXTURE, h::BACKGROUND_TEXTURE] {
        word(field)
            .checked_sub(1)
            .and_then(|i| textures.get(i))
            .hash(&mut global);
    }
    for (field, count) in [(h::ENVIRONMENT_SETTINGS, 4), (h::GROUNDED_BACKGROUND, 6)] {
        if word(field) != 0 {
            table(word(field), count).hash(&mut global);
        }
    }
    (word(h::QUALITY_FLAGS) & 4).hash(&mut global);
    table(h::BACKGROUND_COLOR, 6).hash(&mut global);
    let lights = word(h::LIGHT_COUNT);
    table(word(h::LIGHT_OFFSET), lights * light::WORDS).hash(&mut global);
    for light_index in 0..lights {
        let at = word(h::LIGHT_OFFSET) + light_index * light::WORDS;
        word(at + light::TEXTURE)
            .checked_sub(1)
            .and_then(|i| textures.get(i))
            .hash(&mut global);
    }
    for i in 0..word(h::MESH_COUNT) {
        let offset = word(h::MESH_OFFSET) + i * mesh::WORDS;
        word(offset + mesh::FLAGS).hash(&mut global);
    }
    let mut revisions = Vec::new();
    let ids = word(h::MATERIAL_AOV_IDS);
    for i in 0..word(h::MATERIAL_COUNT) {
        let offset = word(h::MATERIAL_OFFSET) + i * m::WORDS;
        let mut hash = DefaultHasher::new();
        table(offset, m::EXTENSION_COUNT).hash(&mut hash);
        for field in m::MAP..=m::EMISSIVE_MAP {
            textures.get(word(offset + field)).hash(&mut hash);
        }
        let graph = word(offset + m::GRAPH);
        if graph != 0 {
            for (count, ptr, stride) in [
                (graph::NODE_COUNT, graph::NODES, 5),
                (graph::INPUT_COUNT, graph::INPUTS, 5),
                (graph::TERMINAL_COUNT, graph::TERMINALS, 3),
                (graph::PARAMETER_COUNT, graph::PARAMETERS, 4),
                (graph::TEXTURE_COUNT, graph::TEXTURES, 1),
            ] {
                table(word(graph + ptr), word(graph + count) * stride).hash(&mut hash);
            }
            for k in 0..word(graph + graph::TEXTURE_COUNT) {
                textures
                    .get(word(word(graph + graph::TEXTURES) + k))
                    .hash(&mut hash);
            }
        }
        let extensions = word(offset + m::EXTENSION_OFFSET);
        let count = word(offset + m::EXTENSION_COUNT);
        table(extensions, count * extension::WORDS).hash(&mut hash);
        for k in 0..count {
            let at = extensions + k * extension::WORDS;
            let kind =
                crate::material_properties::MATERIAL_PROPERTIES.get(word(at + extension::ID));
            if kind.is_some_and(|&(kind, _)| kind == crate::commit_plan::TEXTURE_PROPERTY) {
                textures.get(word(at + extension::X)).hash(&mut hash);
            }
        }
        revisions.push([
            if ids == 0 {
                i as u32
            } else {
                word(ids + i) as u32
            },
            hash.finish() as u32,
        ]);
    }
    revisions.sort_unstable();
    (global.finish(), revisions)
}

#[cfg(test)]
mod tests;
