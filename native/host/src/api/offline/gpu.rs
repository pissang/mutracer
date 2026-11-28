//! Native dispatch of the capture, window and post shaders from the AOT packet.
use super::plan::TemporalPlan;
use crate::{GpuDevice, Result};
use std::collections::HashMap;
use wgpu::util::DeviceExt;

pub(super) enum Resource {
    Buffer(wgpu::Buffer),
    Texture(wgpu::TextureView),
}
impl Resource {
    pub(super) fn buffer(&self) -> &wgpu::Buffer {
        match self {
            Self::Buffer(b) => b,
            _ => unreachable!(),
        }
    }
    fn binding(&self) -> wgpu::BindingResource<'_> {
        match self {
            Self::Buffer(b) => b.as_entire_binding(),
            Self::Texture(v) => wgpu::BindingResource::TextureView(v),
        }
    }
}
pub(super) struct Passes {
    pub gpu: GpuDevice,
    pub size: [u32; 2],
    pub plan: TemporalPlan,
    pub bytes: u64,
    pub material_capacity: u32,
    accumulate_guides: bool,
    reflection_motion: bool,
    /// Sample tile edge in pixels, or zero for uniform sampling.
    pub sample_tile: u32,
    supplement_dump: Option<std::path::PathBuf>,
    diagnostic: Option<std::path::PathBuf>,
    scan: Option<std::path::PathBuf>,
    pipelines: HashMap<String, wgpu::ComputePipeline>,
    resources: HashMap<&'static str, Resource>,
}
const PYRAMID: [&str; 3] = ["half", "quarter", "eighth"];
const FORWARD: [&str; 4] = ["forward2", "forward4", "forward8", "forwardRefined"];
const BACKWARD: [&str; 4] = ["back2", "back4", "back8", "backRefined"];
impl Passes {
    pub fn new(
        gpu: GpuDevice,
        size: [u32; 2],
        plan: TemporalPlan,
        materials: usize,
        sparkle: bool,
        accumulate_guides: bool,
        reflection_motion: bool,
        planar_reflections: bool,
        sample_tile: u32,
        supplement: bool,
    ) -> Result<Self> {
        let shaders = &crate::postprocess::sources()?.temporal;
        let pixels = u64::from(size[0]) * u64::from(size[1]);
        let diagnostic =
            std::env::var_os("MUTRACER_TEMPORAL_WINDOW_DUMP").map(std::path::PathBuf::from);
        let scan = std::env::var_os("MUTRACER_TEMPORAL_SCAN").map(std::path::PathBuf::from);
        if scan.is_some()
            && 64 + pixels * 48 > u64::from(gpu.device.limits().max_storage_buffer_binding_size)
        {
            return Err("Temporal scan diagnostics exceed the GPU storage binding limit".into());
        }
        let mut pass = Self {
            gpu,
            size,
            plan,
            bytes: pixels * 16,
            material_capacity: materials.max(1) as u32,
            accumulate_guides,
            reflection_motion,
            sample_tile,
            supplement_dump: supplement
                .then(|| std::env::var_os("MUTRACER_SUPPLEMENT_DUMP"))
                .flatten()
                .map(std::path::PathBuf::from),
            diagnostic,
            scan,
            pipelines: Default::default(),
            resources: Default::default(),
        };
        let slots = plan.slots();
        let post = plan.post_slots();
        use wgpu::TextureFormat::*;
        for (name, layers, format) in [
            ("surface", 2 * slots, Rgba16Float),
            ("motion", slots, Rgba32Float),
            ("material", slots, R32Uint),
            ("id", slots, Rgba32Uint),
            ("raw", slots, Rgba16Float),
            (
                "guides",
                2 * plan.guide_slots(accumulate_guides),
                Rgba16Float,
            ),
        ] {
            pass.texture(name, layers, size, format);
        }
        for (name, bytes) in [
            ("meta", u64::from(slots) * 80),
            ("overflow", u64::from(slots) * 4096 * 32),
            ("sum", pass.bytes),
            ("window", pass.bytes),
            (
                "rejects",
                64 + if pass.scan.is_some() { pixels * 48 } else { 0 },
            ),
            ("revision", u64::from(pass.material_capacity) * 8),
            ("coverage", pixels.div_ceil(64) * 4),
        ] {
            pass.buffer(name, bytes);
        }
        let mut names = vec![
            "resolve",
            "capture",
            if accumulate_guides {
                "windowGuides"
            } else {
                "window"
            },
            if accumulate_guides {
                "packGuides"
            } else {
                "pack"
            },
            "idSnapshot",
            "snapshot",
            "coverage",
        ];
        if reflection_motion {
            pass.texture("reflected", slots, size, Rgba16Float);
            pass.texture("endpoints", slots, size, Rgba32Uint);
            pass.buffer(
                "reflectedTotal",
                pass.bytes * if pass.diagnostic.is_some() { 3 } else { 1 },
            );
            names.push("captureReflections");
            names.push(if accumulate_guides {
                "windowGuidesReflections"
            } else {
                "windowReflections"
            });
        }
        if sample_tile > 0 {
            let bytes = (u64::from(size[0].div_ceil(sample_tile))
                * u64::from(size[1].div_ceil(sample_tile))
                + 1)
                * u64::from(slots)
                * 4;
            if bytes > u64::from(pass.gpu.device.limits().max_storage_buffer_binding_size) {
                return Err("Tile ring exceeds the GPU storage binding limit".into());
            }
            pass.buffer("sampleTiles", bytes);
            let (surface, reflected) = tile_kernels(sample_tile);
            names.push(surface);
            if reflection_motion {
                names.push(reflected);
            }
        }
        if supplement {
            pass.buffer("supplementList", (pixels + 1) * 4);
            pass.buffer("supplementInfo", pixels * 16);
            pass.buffer("supplementUnused", 16);
            pass.buffer("supplementHold0", pixels * 4);
            pass.buffer("supplementHold1", pixels * 4);
            names.extend(["supplementNeed", "supplementGather", "supplementBlend"]);
            let window = if sample_tile > 0 {
                tile_kernels(sample_tile)
            } else {
                ("window", "windowReflections")
            };
            names.push(sparse_kernel(window.0));
            if reflection_motion {
                names.push(sparse_kernel(window.1));
            }
        }
        if accumulate_guides {
            pass.buffer("albedoSum", pass.bytes);
            pass.buffer("normalSum", pass.bytes);
        }
        if post > 0 {
            for (name, length) in [
                ("map", pass.bytes),
                ("reverse", pass.bytes),
                ("postSum", pass.bytes),
                (
                    "postOutput",
                    pass.bytes * if pass.scan.is_some() && sparkle { 2 } else { 1 },
                ),
                ("paths", pixels * 4),
                ("counts", 80),
                ("empty", 8),
                (
                    "changes",
                    u64::from(post) * u64::from(pass.material_capacity + 1) * 4,
                ),
            ] {
                pass.buffer(name, length);
            }
            for (name, layers) in [("display", post), ("blurTemp", 1), ("blurred", post)] {
                pass.texture(name, layers, size, Rgba16Float);
            }
            for (level, scale) in [2, 4, 8].into_iter().enumerate() {
                pass.texture(
                    PYRAMID[level],
                    post,
                    size.map(|v| v.div_ceil(scale)),
                    Rgba16Float,
                );
            }
            for (level, scale) in [2, 4, 8, 2].into_iter().enumerate() {
                let [w, h] = size.map(|v| u64::from(v.div_ceil(3 * scale)));
                for name in [FORWARD[level], BACKWARD[level]] {
                    pass.buffer(name, w * h * 8);
                }
            }
            names.extend([
                "blur",
                "pyramid",
                "match",
                "reproject",
                "combine",
                "accumulate",
            ]);
            if sparkle {
                names.push("sparkle");
            }
        }
        if pass.scan.is_some() {
            let variants = names
                .iter()
                .filter_map(|name| scan_kernel(name))
                .collect::<Vec<_>>();
            names.extend(variants);
        }
        for name in names {
            let source = if name == "resolve" {
                include_str!("resolve.wgsl")
            } else {
                shaders
                    .get(name)
                    .ok_or_else(|| format!("Missing shared temporal kernel {name}"))?
                    .as_str()
            };
            let device = &pass.gpu.device;
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(name),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            });
            // Several shared post kernels keep optional statistics bindings even when
            // the entry point does not read them. Match the explicit browser layouts.
            let explicit = post_layout(device, name);
            let constants: &[(&str, f64)] = if planar_reflections && name == "captureReflections" {
                &[("EXPERIMENTAL_PLANAR_REFLECTIONS", 1.0)]
            } else {
                &[]
            };
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: explicit.as_ref(),
                module: &module,
                entry_point: Some("main"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants,
                    ..Default::default()
                },
                cache: None,
            });
            pass.pipelines.insert(name.into(), pipeline);
        }
        Ok(pass)
    }
    fn texture(
        &mut self,
        name: &'static str,
        layers: u32,
        [width, height]: [u32; 2],
        format: wgpu::TextureFormat,
    ) {
        let texture = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(name),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: layers,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        self.resources.insert(name, Resource::Texture(view));
    }
    fn buffer(&mut self, name: &'static str, bytes: u64) {
        self.resources.insert(name, self.alloc(name, bytes));
    }
    pub fn alloc(&self, name: &str, bytes: u64) -> Resource {
        Resource::Buffer(self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(name),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }))
    }
    pub fn copy(&self, from: &Resource, to: &Resource) {
        let mut e = self.gpu.device.create_command_encoder(&Default::default());
        e.copy_buffer_to_buffer(from.buffer(), 0, to.buffer(), 0, self.bytes);
        self.gpu.queue.submit([e.finish()]);
    }
    pub fn clear(&self, name: &str, start: u64, bytes: u64) {
        let mut e = self.gpu.device.create_command_encoder(&Default::default());
        e.clear_buffer(self[name].buffer(), start, Some(bytes));
        self.gpu.queue.submit([e.finish()]);
    }
    pub fn write<T: bytemuck::Pod>(&self, name: &str, offset: u64, data: &[T]) {
        if !data.is_empty() {
            self.gpu
                .queue
                .write_buffer(self[name].buffer(), offset, bytemuck::cast_slice(data));
        }
    }
    pub fn read<T: bytemuck::Pod>(&self, b: &Resource) -> Result<Vec<T>> {
        Ok(bytemuck::pod_collect_to_vec(
            &self
                .gpu
                .queue
                .read_buffer(&self.gpu.device, b.buffer().slice(..))?,
        ))
    }
    fn dispatch(&self, name: &str, params: &[u32], resources: &[&Resource], groups: [u32; 2]) {
        let mut words = [0; 12];
        words[..params.len()].copy_from_slice(params);
        let uniform = self
            .gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(name),
                contents: bytemuck::cast_slice(&words),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bindings = (!params.is_empty())
            .then(|| uniform.as_entire_binding())
            .into_iter()
            .chain(resources.iter().map(|r| r.binding()))
            .enumerate()
            .map(|(i, resource)| wgpu::BindGroupEntry {
                binding: i as u32,
                resource,
            })
            .collect::<Vec<_>>();
        let pipeline = &self.pipelines[name];
        let group = self
            .gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(name),
                layout: &pipeline.get_bind_group_layout(0),
                entries: &bindings,
            });
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(groups[0], groups[1], 1);
        }
        self.gpu.queue.submit([encoder.finish()]);
    }
    pub fn image_pass(&self, name: &str, params: &[u32], resources: &[&Resource]) {
        self.dispatch(name, params, resources, self.size.map(|v| v.div_ceil(8)));
    }
    pub fn capture(
        &self,
        i: u32,
        guides: &[Resource; 9],
        meta: &[f32; 20],
        revisions: &[[u32; 2]],
        center_records: bool,
    ) {
        let [w, h] = self.size;
        let s = i % self.plan.slots();
        let g = self.guide_slot(i);
        let [
            depth,
            normal,
            rough,
            albedo,
            color,
            motion,
            id,
            guide_normal,
            _,
        ] = guides;
        self.clear("overflow", u64::from(s) * 131072, 131072);
        self.image_pass(
            "capture",
            &[w, h, s, u32::from(center_records)],
            &[
                depth,
                normal,
                rough,
                albedo,
                color,
                motion,
                &self["surface"],
                &self["raw"],
                &self["motion"],
                &self["overflow"],
                &self["material"],
            ],
        );
        self.write("revision", 0, revisions);
        self.image_pass(
            "idSnapshot",
            &[w, h, s, 0, 0, 0, 0, revisions.len() as u32],
            &[id, &self["revision"], &self["id"]],
        );
        for (layer, input) in [(2 * g, albedo), (2 * g + 1, guide_normal)] {
            self.image_pass("snapshot", &[w, h, layer], &[input, &self["guides"]]);
        }
        self.write("meta", u64::from(s) * 80, meta);
    }
    pub fn capture_reflections(
        &self,
        index: u32,
        samples: u32,
        radiance: wgpu::Buffer,
        records: wgpu::Buffer,
        albedo: &Resource,
        hdr: &Resource,
    ) {
        let [w, h] = self.size;
        self.image_pass(
            "captureReflections",
            &[w, h, index % self.plan.slots(), samples],
            &[
                &Resource::Buffer(radiance),
                albedo,
                &Resource::Buffer(records),
                hdr,
                &self["reflected"],
                &self["endpoints"],
                &self["meta"],
            ],
        );
    }
    fn scan_frame(&self, frame: u32) -> Option<&std::path::Path> {
        let path = self.scan.as_deref()?;
        let range = std::env::var("MUTRACER_TEMPORAL_SCAN_FRAMES").ok();
        let included = range
            .as_deref()
            .and_then(|value| value.split_once('-'))
            .and_then(|(first, last)| Some(first.parse::<u32>().ok()?..=last.parse::<u32>().ok()?))
            .is_none_or(|range| range.contains(&frame));
        included.then_some(path)
    }

    fn scan_dump(&self, frame: u32, field: &str, resource: &str, offset: u64) -> Result<()> {
        if let Some(path) = self.scan_frame(frame) {
            let bytes = self
                .gpu
                .queue
                .read_buffer(&self.gpu.device, self[resource].buffer().slice(offset..))?;
            std::fs::write(path.join(format!("frame-{frame:04}.{field}")), &bytes)?;
        }
        Ok(())
    }

    pub fn dump_window(&self, frame: u32) -> Result<()> {
        self.scan_dump(frame, "window.bin", "rejects", 64)?;
        let Some(path) = &self.diagnostic else {
            return Ok(());
        };
        let frames = std::env::var("MUTRACER_TEMPORAL_WINDOW_DUMP_FRAMES").unwrap_or_default();
        if !frames.is_empty() && !frames.split(',').any(|s| s.parse() == Ok(frame)) {
            return Ok(());
        }
        std::fs::create_dir_all(path)?;
        let mut fields = vec!["window", "sum"];
        if self.reflection_motion {
            fields.push("reflectedTotal");
        }
        for name in fields {
            let data = self.read::<f32>(&self[name])?;
            std::fs::write(
                path.join(format!("{frame:04}-{name}.f32")),
                bytemuck::cast_slice(&data),
            )?;
        }
        Ok(())
    }
    pub fn resize_materials(&mut self, count: u32) {
        if count <= self.material_capacity {
            return;
        }
        self.material_capacity = count;
        self.buffer("revision", u64::from(count) * 8);
        if self.plan.post_radius > 0 {
            self.buffer(
                "changes",
                u64::from(count + 1) * u64::from(self.plan.post_slots()) * 4,
            );
        }
    }
    fn guide_slot(&self, index: u32) -> u32 {
        index % self.plan.guide_slots(self.accumulate_guides)
    }
    pub fn store_sample_tiles(&self, index: u32, base: u32, tiles: &[u32]) {
        let offset = u64::from(index % self.plan.slots()) * (tiles.len() as u64 + 1) * 4;
        self.write("sampleTiles", offset, &[base]);
        self.write("sampleTiles", offset + 4, tiles);
    }

    pub fn window(&self, i: u32, j: u32, stage: u32, revisions: bool, check_lighting: bool) {
        self.window_pass(i, j, stage, revisions, check_lighting, false);
    }
    /// One tap of the supplement's past-half estimate, optionally on every
    /// second pixel in each direction.
    pub fn window_estimate(&self, i: u32, j: u32, stage: u32, check_lighting: bool, sparse: bool) {
        self.window_pass(i, j, stage, true, check_lighting, sparse);
    }
    fn window_pass(
        &self,
        i: u32,
        j: u32,
        stage: u32,
        revisions: bool,
        check_lighting: bool,
        sparse: bool,
    ) {
        let [w, h] = self.size;
        let p = self.plan;
        // Camera-cut validation skips material revisions and guide accumulation.
        let mode = u32::from(p.min != p.max)
            | 2
            | u32::from(revisions) << 2
            | u32::from(self.accumulate_guides && revisions) << 3
            | u32::from(check_lighting) << 4
            | u32::from(self.diagnostic.is_some()) << 5
            | u32::from(!revisions) << 7;
        let mut bindings = Vec::with_capacity(16);
        bindings.extend([
            &self["surface"],
            &self["id"],
            &self["raw"],
            &self["meta"],
            &self["sum"],
            &self["window"],
            &self["overflow"],
            &self["rejects"],
            &self["motion"],
            &self["material"],
        ]);
        if self.accumulate_guides {
            bindings.extend([&self["guides"], &self["albedoSum"], &self["normalSum"]]);
        }
        let reflections = self.reflection_motion && revisions;
        if reflections {
            bindings.extend([
                &self["reflected"],
                &self["endpoints"],
                &self["reflectedTotal"],
            ]);
        }
        let kernel = if self.sample_tile > 0 {
            bindings.push(&self["sampleTiles"]);
            let (surface, reflected) = tile_kernels(self.sample_tile);
            if reflections {
                reflected
            } else {
                surface
            }
        } else {
            match (self.accumulate_guides, reflections) {
                (true, true) => "windowGuidesReflections",
                (false, true) => "windowReflections",
                (true, false) => "windowGuides",
                (false, false) => "window",
            }
        };
        let kernel = if sparse {
            sparse_kernel(kernel)
        } else if self.scan.is_some() && revisions {
            scan_kernel(kernel).unwrap_or(kernel)
        } else {
            kernel
        };
        let groups = if sparse {
            self.size.map(|v| v.div_ceil(16))
        } else {
            self.size.map(|v| v.div_ceil(8))
        };
        self.dispatch(
            kernel,
            &[
                w,
                h,
                i % p.slots(),
                j % p.slots(),
                j.wrapping_sub(i),
                1,
                stage,
                mode,
                p.min,
                p.max,
            ],
            &bindings,
            groups,
        );
    }
    pub fn pack(&self, index: u32, samples: u32, accumulated: &Resource, output: &[Resource; 3]) {
        let [w, h] = self.size;
        let [color, albedo, normal] = output;
        let params = [w, h, samples, self.guide_slot(index)];
        if self.accumulate_guides {
            self.image_pass(
                "packGuides",
                &params,
                &[
                    accumulated,
                    &self["guides"],
                    color,
                    albedo,
                    normal,
                    &self["albedoSum"],
                    &self["normalSum"],
                ],
            );
        } else {
            self.image_pass(
                "pack",
                &params,
                &[accumulated, &self["guides"], color, albedo, normal],
            );
        }
    }
    pub fn camera_cut(&self, i: u32, positions: &Resource) -> Result<bool> {
        let [w, h] = self.size;
        let groups = (w * h).div_ceil(64);
        self.clear("coverage", 0, u64::from(groups) * 4);
        self.dispatch(
            "coverage",
            &[],
            &[positions, &self["coverage"]],
            [groups, 1],
        );
        let surfaces: u32 = self.read::<u32>(&self["coverage"])?.into_iter().sum();
        if surfaces == 0 {
            return Ok(true);
        }
        self.clear("rejects", 0, 64);
        self.window(i, i - 1, 1, false, false);
        Ok(u64::from(self.read::<u32>(&self["rejects"])?[0]) * 10 < u64::from(surfaces))
    }
    fn post_params(&self, i: u32, j: u32, stage: u32, axis: u32) -> [u32; 8] {
        let [w, h] = self.size;
        let n = self.plan.post_slots();
        [w, h, i % n, j % n, j.wrapping_sub(i), stage, axis, n]
    }
    pub fn store_display(&self, i: u32, image: &Resource) {
        self.image_pass(
            "snapshot",
            &self.post_params(i, i, 4, 0),
            &[image, &self["display"]],
        );
        for (from, to, axis) in [("display", "blurTemp", 0), ("blurTemp", "blurred", 1)] {
            self.image_pass(
                "blur",
                &self.post_params(i, i, 0, axis),
                &[&self[from], &self[to]],
            );
        }
        let mut src = "display";
        for (dst, scale) in PYRAMID.into_iter().zip([2, 4, 8]) {
            self.dispatch(
                "pyramid",
                &self.post_params(i, i, 0, 0),
                &[&self[src], &self[dst]],
                self.size.map(|n| n.div_ceil(scale * 8)),
            );
            src = dst;
        }
    }
    fn map_match(&self, i: u32, j: u32, map: &str, flow: [&str; 4]) {
        let [w, h] = self.size;
        let n = self.plan.slots();
        self.image_pass(
            "reproject",
            &[w, h, i % n, j % n, j.wrapping_sub(i), 4, 0, n],
            &[
                &self["surface"],
                &self["id"],
                &self["meta"],
                &self[map],
                &self["counts"],
                &self["motion"],
            ],
        );
        for (level, scale, src, dst, stage) in [
            (2, 8, "empty", flow[2], 4),
            (1, 4, flow[2], flow[1], 4),
            (0, 2, flow[1], flow[0], 4),
            (0, 2, flow[0], flow[3], 5),
        ] {
            self.dispatch(
                "match",
                &self.post_params(i, j, stage, scale),
                &[&self[PYRAMID[level]], &self[src], &self[map], &self[dst]],
                self.size.map(|v| v.div_ceil(scale * 3 * 8)),
            );
        }
    }
    pub fn post(
        &self,
        i: u32,
        neighbors: &[(u32, Vec<u32>)],
        sparkle: bool,
        frame: u32,
    ) -> Result<Resource> {
        let [w, h] = self.size;
        let n = self.plan.post_slots();
        let stride = self.material_capacity + 1;
        let mut changes = vec![0; n as usize * stride as usize];
        for slot in changes.chunks_exact_mut(stride as usize) {
            slot[0] = u32::MAX;
        }
        for (j, changed) in neighbors {
            let offset = (j % n * stride) as usize;
            changes[offset] = changed.len() as u32;
            changes[offset + 1..offset + 1 + changed.len()].copy_from_slice(changed);
        }
        self.write("changes", 0, &changes);
        let sum = [&self["display"], &self["postSum"], &self["postOutput"]];
        self.image_pass("accumulate", &self.post_params(i, i, 0, 0), &sum);
        let mut past = 0;
        let mut future = 0;
        for (j, _) in neighbors {
            let j = *j;
            past = past.max(i.saturating_sub(j));
            future = future.max(j.saturating_sub(i));
            self.map_match(i, j, "map", FORWARD);
            self.map_match(j, i, "reverse", BACKWARD);
            let mut params = self.post_params(i, j, 4, i % self.plan.slots());
            params[7] = stride;
            self.image_pass(
                "combine",
                &params,
                &[
                    &self["display"],
                    &self["blurred"],
                    &self["map"],
                    &self[FORWARD[3]],
                    &self[BACKWARD[3]],
                    &self["postSum"],
                    &self["paths"],
                    &self["reverse"],
                    &self["id"],
                    &self["changes"],
                ],
            );
        }
        self.image_pass("accumulate", &self.post_params(i, i, 2, 0), &sum);
        if sparkle {
            self.image_pass(
                if self.scan.is_some() {
                    "sparkleScan"
                } else {
                    "sparkle"
                },
                &[w, h, i % n, n, past, future, stride, i % self.plan.slots()],
                &[
                    &self["surface"],
                    &self["id"],
                    &self["display"],
                    &self["blurred"],
                    &self["meta"],
                    &self["postOutput"],
                    &self["motion"],
                    &self["changes"],
                ],
            );
            self.scan_dump(frame, "sparkle.f32", "postOutput", self.bytes)?;
        }
        let output = self.alloc("Finished temporal frame", self.bytes);
        self.copy(&self["postOutput"], &output);
        Ok(output)
    }
}
impl Passes {
    fn read_range<T: bytemuck::Pod>(&self, name: &str, bytes: std::ops::Range<u64>) -> Result<Vec<T>> {
        Ok(bytemuck::pod_collect_to_vec(
            &self
                .gpu
                .queue
                .read_buffer(&self.gpu.device, self[name].buffer().slice(bytes))?,
        ))
    }
    fn linear_groups(count: u32) -> [u32; 2] {
        let groups = count.div_ceil(64).max(1);
        [groups.min(65535), groups.div_ceil(65535)]
    }
    /// Converts the current weight sums of slot `i` into a compact list of
    /// pixels with extra sample counts. `mirror` extrapolates past-only sums to
    /// a whole window; zero scores the sums as a complete window. With `hold`
    /// set to `(fraction, previous)`, pixels keep `floor(fraction · n)` of the
    /// counts that frame `i − 1` gave the surface they show when `previous`
    /// is true, and the counts of `i` are stored for frame `i + 1`.
    #[allow(clippy::too_many_arguments)]
    pub fn supplement_need(
        &self,
        i: u32,
        base: u32,
        cap: u32,
        goal: f32,
        mirror: f32,
        radius: u32,
        hold: Option<(f32, bool)>,
        sparse: bool,
        info: bool,
    ) -> Result<(Vec<u32>, Option<Vec<f32>>)> {
        let [w, h] = self.size;
        self.clear("supplementList", 0, 4);
        let reflected = if self.reflection_motion {
            "reflectedTotal"
        } else {
            "sum"
        };
        let (fraction, mut flags) = match hold {
            Some((fraction, previous)) => (fraction, u32::from(previous) | 2),
            None => (0., 0),
        };
        if sparse {
            flags |= 4;
        }
        let (previous, next) = if i % 2 == 0 {
            ("supplementHold1", "supplementHold0")
        } else {
            ("supplementHold0", "supplementHold1")
        };
        let tiles = if self.sample_tile > 0 {
            "sampleTiles"
        } else {
            "supplementUnused"
        };
        self.image_pass(
            "supplementNeed",
            &[
                w,
                h,
                i % self.plan.slots(),
                u32::from(self.reflection_motion),
                base,
                cap,
                goal.to_bits(),
                mirror.to_bits(),
                radius,
                fraction.to_bits(),
                flags,
                self.sample_tile,
            ],
            &[
                &self["sum"],
                &self[reflected],
                &self["surface"],
                &self["material"],
                &self["supplementList"],
                &self["supplementInfo"],
                &self["motion"],
                &self[previous],
                &self[next],
                &self[tiles],
            ],
        );
        let count = self.read_range::<u32>("supplementList", 0..4)?[0];
        let list = if count == 0 {
            Vec::new()
        } else {
            self.read_range("supplementList", 4..4 + u64::from(count) * 4)?
        };
        let info = if info {
            Some(self.read(&self["supplementInfo"])?)
        } else {
            None
        };
        Ok((list, info))
    }
    pub fn reflection_motion(&self) -> bool {
        self.reflection_motion
    }
    pub fn supplement_dump(&self) -> Option<&std::path::Path> {
        self.supplement_dump.as_deref()
    }
    /// Writes the requested extra samples as one byte per top-first pixel.
    /// With `MUTRACER_SUPPLEMENT_DUMP_INFO`, also writes four floats per pixel:
    /// surface and reflected weight sums, reflected share and extra samples.
    pub fn write_supplement_dump(&self, frame: u32, kind: &str, info: &[f32]) -> Result<()> {
        if let Some(path) = &self.supplement_dump {
            std::fs::create_dir_all(path)?;
            let need: Vec<u8> = info.chunks_exact(4).map(|v| v[3].clamp(0., 255.) as u8).collect();
            std::fs::write(path.join(format!("frame-{frame:04}.{kind}.u8")), need)?;
            if std::env::var_os("MUTRACER_SUPPLEMENT_DUMP_INFO").is_some() {
                std::fs::write(
                    path.join(format!("frame-{frame:04}.{kind}.f32")),
                    bytemuck::cast_slice(info),
                )?;
            }
        }
        Ok(())
    }
    /// Records the whole base-only window of slot `i` for selection diagnostics.
    pub fn dump_supplement(
        &self,
        frame: u32,
        i: u32,
        base: u32,
        cap: u32,
        goal: f32,
        radius: u32,
    ) -> Result<()> {
        if self.supplement_dump.is_some() {
            let (_, info) = self.supplement_need(i, base, cap, goal, 0., radius, None, false, true)?;
            self.write_supplement_dump(frame, "full", &info.unwrap())?;
        }
        Ok(())
    }
    /// Reads a separate supplement accumulation at the listed pixels.
    pub fn supplement_gather(
        &self,
        list: &[u32],
        base: u32,
        raw: &[wgpu::Buffer; 3],
        radiance: Option<&wgpu::Buffer>,
    ) -> Resource {
        let count = list.len() as u32;
        let mut words = Vec::with_capacity(list.len() + 1);
        words.push(count);
        words.extend_from_slice(list);
        let upload = Resource::Buffer(self.gpu.device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("Supplement list"),
                contents: bytemuck::cast_slice(&words),
                usage: wgpu::BufferUsages::STORAGE,
            },
        ));
        let entries = self.alloc("Supplement entries", u64::from(count.max(1)) * 32);
        let [color, albedo, normal] = raw.clone().map(Resource::Buffer);
        let reflected = Resource::Buffer(
            radiance
                .cloned()
                .unwrap_or_else(|| self["supplementUnused"].buffer().clone()),
        );
        self.dispatch(
            "supplementGather",
            &[self.size[0], self.size[1], base, u32::from(radiance.is_some())],
            &[&upload, &color, &albedo, &normal, &reflected, &entries],
            Self::linear_groups(count),
        );
        entries
    }
    /// Adds gathered supplement samples to the current center before normalization.
    pub fn supplement_blend(&self, entries: &Resource, count: u32) {
        let reflected = if self.reflection_motion {
            "reflectedTotal"
        } else {
            "supplementUnused"
        };
        self.dispatch(
            "supplementBlend",
            &[count, u32::from(self.reflection_motion)],
            &[entries, &self["sum"], &self[reflected]],
            Self::linear_groups(count),
        );
    }
}
impl std::ops::Index<&str> for Passes {
    type Output = Resource;
    fn index(&self, key: &str) -> &Resource {
        &self.resources[key]
    }
}

fn tile_kernels(tile: u32) -> (&'static str, &'static str) {
    if tile == 1 {
        ("windowTiles1", "windowReflectionsTiles1")
    } else {
        ("windowTiles", "windowReflectionsTiles")
    }
}

fn sparse_kernel(name: &str) -> &'static str {
    match name {
        "window" => "windowSparse",
        "windowReflections" => "windowReflectionsSparse",
        "windowTiles" => "windowTilesSparse",
        "windowReflectionsTiles" => "windowReflectionsTilesSparse",
        _ => unreachable!("no sparse estimate for {name}"),
    }
}

fn scan_kernel(name: &str) -> Option<&'static str> {
    Some(match name {
        "window" => "windowScan",
        "windowGuides" => "windowGuidesScan",
        "windowReflections" => "windowReflectionsScan",
        "windowGuidesReflections" => "windowGuidesReflectionsScan",
        "windowTiles" => "windowTilesScan",
        "windowReflectionsTiles" => "windowReflectionsTilesScan",
        "sparkle" => "sparkleScan",
        _ => return None,
    })
}

fn post_layout(device: &wgpu::Device, name: &str) -> Option<wgpu::PipelineLayout> {
    use wgpu::BufferBindingType::{Storage, Uniform};
    let buffer = |ty| wgpu::BindingType::Buffer {
        ty,
        has_dynamic_offset: false,
        min_binding_size: None,
    };
    let tex = |sample_type| wgpu::BindingType::Texture {
        sample_type,
        view_dimension: wgpu::TextureViewDimension::D2Array,
        multisampled: false,
    };
    let uniform = buffer(Uniform);
    let read = buffer(Storage { read_only: true });
    let write = buffer(Storage { read_only: false });
    let float = tex(wgpu::TextureSampleType::Float { filterable: false });
    let ids = tex(wgpu::TextureSampleType::Uint);
    let types = match name {
        "reproject" => vec![uniform, float, ids, read, write, write, float],
        "match" => vec![uniform, float, read, read, write],
        "combine" => vec![
            uniform, float, float, read, read, read, write, write, read, ids, read,
        ],
        _ => return None,
    };
    let entries = types
        .into_iter()
        .enumerate()
        .map(|(i, ty)| wgpu::BindGroupLayoutEntry {
            binding: i as u32,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty,
            count: None,
        })
        .collect::<Vec<_>>();
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(name),
        entries: &entries,
    });
    Some(
        device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(name),
            bind_group_layouts: &[Some(&layout)],
            ..Default::default()
        }),
    )
}
