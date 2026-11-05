//! Display-space upscale: the shared Web FSR 1 EASU pass and its albedo detail
//! compensation, recorded through the display pass API.
use super::post_process::{PostProcessContext, PostProcessOptions, PostProcessSubscription};
use super::render::PixelKind;
use super::{Display, Result, Status, error};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;

/// Albedo detail compensation of [`EasuPass`]. Defaults match the browser's
/// `createEasuPass`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EasuOptions {
    /// Recover texture detail from the selected render's display-resolution
    /// [`PixelKind::DiffuseAlbedo`], [`PixelKind::SpecularAlbedo`] and
    /// [`PixelKind::Depth`] AOVs ([`super::AovResolution::Display`]). Default
    /// false. Missing or differently sized AOVs and HDR-window inputs use EASU
    /// alone; unsupported surfaces and silhouettes receive no compensation.
    pub albedo_detail: bool,
    /// Per-channel linear compensation bounds, positive finite min <= max.
    /// Wider bounds recover more texture contrast but can alter silhouettes and
    /// highlights. Default [0.7, 1.43].
    pub ratio_range: [f32; 2],
    /// Relative departure of neighboring inverse depth from a plane that marks
    /// a silhouette and rejects compensation there, positive finite; sloped
    /// planes are not silhouettes. Default 0.02.
    pub depth_threshold: f32,
    /// Minimum valid AOV coverage in (0, 1]. Default 0.95.
    pub coverage_threshold: f32,
}
impl Default for EasuOptions {
    fn default() -> Self {
        Self {
            albedo_detail: false,
            ratio_range: [0.7, 1.43],
            depth_threshold: 0.02,
            coverage_threshold: 0.95,
        }
    }
}
impl EasuOptions {
    fn validate(&self) -> Result<()> {
        let [min, max] = self.ratio_range;
        if ![min, max, self.depth_threshold, self.coverage_threshold]
            .iter()
            .all(|v| v.is_finite())
            || min <= 0.
            || max < min
            || self.depth_threshold <= 0.
            || self.coverage_threshold <= 0.
            || self.coverage_threshold > 1.
        {
            return Err(error(
                Status::InvalidArgument,
                "Invalid EASU detail compensation options",
            ));
        }
        Ok(())
    }
}

/// Edge-adaptive display-space upscale (AMD FidelityFX FSR 1 EASU) without
/// sharpening, shared with the browser library. Register it with an output at
/// display size ([`Display::add_upscale`] does this). Inputs of the output size
/// are copied and larger inputs are area averaged. Accepts SDR (`Rgba8Unorm`)
/// and HDR-window (`Rgba16Float`) chains, including alpha.
pub struct EasuPass {
    options: EasuOptions,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    /// Pipelines compiled on a worker after the first registration or run.
    compiled: Option<Arc<Mutex<HashMap<String, wgpu::RenderPipeline>>>>,
    /// Low-resolution diffuse and specular albedo at the input size.
    guides: Option<[wgpu::Texture; 2]>,
    guide_key: Option<(Vec<wgpu::Texture>, [u64; 3])>,
    tone: Option<wgpu::Texture>,
    tone_key: Option<[u32; 8]>,
    /// Slope and intercept of the local albedo-radiance fit at the input size.
    fit: Option<[wgpu::Texture; 2]>,
}
impl EasuPass {
    /// Validates the options; InvalidArgument when they are out of range.
    pub fn new(options: EasuOptions) -> Result<Self> {
        options.validate()?;
        Ok(Self {
            options,
            pipelines: HashMap::new(),
            compiled: None,
            guides: None,
            guide_key: None,
            tone: None,
            tone_key: None,
            fit: None,
        })
    }
    /// Records the pass. Call from a display pass registered with an output
    /// size; the output size selects copy, area average or EASU.
    pub fn run(&mut self, ctx: PostProcessContext<'_>) -> Result<()> {
        self.prepare(ctx.device);
        use Resource::Buffer as B;
        let sources =
            crate::postprocess::sources().map_err(|e| error(Status::Error, e.to_string()))?;
        let device = ctx.device;
        let (input, output) = (ctx.input, ctx.output);
        let [iw, ih] = [input.width(), input.height()];
        let [ow, oh] = [output.width(), output.height()];
        // Nothing to upscale, for example a full-resolution render beside a reduced preview.
        if [iw, ih] == [ow, oh] {
            ctx.encoder.copy_texture_to_texture(
                input.as_image_copy(),
                output.as_image_copy(),
                input.size(),
            );
            return Ok(());
        }
        let uniform = |values: [f32; 4]| {
            B(
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("EASU parameters"),
                    contents: bytemuck::cast_slice(&values),
                    usage: wgpu::BufferUsages::UNIFORM,
                }),
            )
        };
        let format = output.format();
        if iw >= ow && ih >= oh {
            // EASU is an enlargement filter; larger renders are area averaged instead.
            let pipeline = self.pipeline(device, "area", &sources.easu[1], &[format]);
            let group = bind(
                device,
                &pipeline,
                &[
                    (0, view(input)),
                    (1, uniform([ow as f32, oh as f32, 0., 0.])),
                ],
            );
            draw(ctx.encoder, "Area downsample", &pipeline, &group, &[output]);
            return Ok(());
        }
        let [min, max] = self.options.ratio_range;
        let detail = sources.easu_detail;
        // HDR-window inputs are linear scRGB rather than the composed sRGB image
        // that the compensation's display transform assumes.
        let mut aovs = Vec::new();
        if self.options.albedo_detail && format == wgpu::TextureFormat::Rgba8Unorm {
            for kind in [
                PixelKind::DiffuseAlbedo,
                PixelKind::SpecularAlbedo,
                PixelKind::Depth,
            ] {
                // A disabled or unready AOV is not an error: use EASU alone.
                if let Ok(Some(aov)) = ctx.render.aov_texture(kind) {
                    aovs.push(aov);
                }
            }
        }
        // Detail waits for its worker-compiled pipelines; until then use EASU alone.
        let detailed = aovs.len() == 3
            && aovs
                .iter()
                .all(|(image, _)| [image.width(), image.height()] == [ow, oh])
            && detail_pipelines(&sources.easu)
                .iter()
                .all(|(name, _, formats)| self.ready(name, formats));
        let mut entries = vec![
            (0, view(input)),
            (1, uniform([ow as f32, oh as f32, min, max])),
        ];
        if detailed {
            // Cached images are recorded on their own submission so a failed
            // chain cannot leave them stale.
            let mut cache: Option<wgpu::CommandEncoder> = None;
            if self
                .guides
                .as_ref()
                .is_none_or(|g| [g[0].width(), g[0].height()] != [iw, ih])
            {
                self.guides = Some(["EASU low diffuse", "EASU low specular"].map(|label| {
                    texture(device, [iw, ih], wgpu::TextureFormat::Rgba16Float, label)
                }));
                self.guide_key = None;
            }
            let guides = self.guides.clone().unwrap();
            // Low albedo depends only on the AOV contents and beauty size; reuse it across presents.
            let key = (
                std::iter::once(guides[0].clone())
                    .chain(aovs.iter().map(|(image, _)| image.clone()))
                    .collect::<Vec<_>>(),
                [aovs[0].1, aovs[1].1, aovs[2].1],
            );
            if self.guide_key.as_ref() != Some(&key) {
                let pipeline = self.pipeline(
                    device,
                    "albedo",
                    &sources.easu[3],
                    &[wgpu::TextureFormat::Rgba16Float; 2],
                );
                let group = bind(
                    device,
                    &pipeline,
                    &[
                        (0, view(&aovs[0].0)),
                        (1, view(&aovs[1].0)),
                        (2, uniform([iw as f32, ih as f32, 0., 0.])),
                        (3, view(&aovs[2].0)),
                    ],
                );
                let encoder =
                    cache.get_or_insert_with(|| device.create_command_encoder(&Default::default()));
                draw(
                    encoder,
                    "Albedo area downsample",
                    &pipeline,
                    &group,
                    &[&guides[0], &guides[1]],
                );
                self.guide_key = Some(key);
            }
            // The ratio is applied through the same grading and tone mapping as
            // the composed image, tabulated once per display setting.
            let settings = ctx.render.engine().display().settings();
            let tone = [
                settings.tone_mapping as u32 as f32,
                1.,
                settings.tone_mapping_exposure,
                0.,
            ];
            let grading = [
                settings.contrast,
                settings.saturation,
                settings.temperature,
                settings.tint,
            ];
            let tone_key: [u32; 8] =
                std::array::from_fn(|i| if i < 4 { tone[i] } else { grading[i - 4] }.to_bits());
            let table = self
                .tone
                .get_or_insert_with(|| {
                    texture(
                        device,
                        [sources.tone_lut_size, 2],
                        wgpu::TextureFormat::Rgba32Float,
                        "EASU tone table",
                    )
                })
                .clone();
            if self.tone_key != Some(tone_key) {
                let pipeline = self.pipeline(
                    device,
                    "tone",
                    &sources.easu[4],
                    &[wgpu::TextureFormat::Rgba32Float],
                );
                let group = bind(
                    device,
                    &pipeline,
                    &[(0, uniform(tone)), (1, uniform(grading))],
                );
                let encoder =
                    cache.get_or_insert_with(|| device.create_command_encoder(&Default::default()));
                draw(encoder, "EASU tone table", &pipeline, &group, &[&table]);
                self.tone_key = Some(tone_key);
            }
            if let Some(cache) = cache {
                ctx.render.engine().inner.gpu.queue.submit([cache.finish()]);
            }
            let tone_entries = [
                (8, view(&table)),
                (9, uniform([tone[1], detail[6], 0., 0.])),
            ];
            // The local albedo-radiance fit depends on this frame's image, so it runs on every present.
            if self
                .fit
                .as_ref()
                .is_none_or(|f| [f[0].width(), f[0].height()] != [iw, ih])
            {
                self.fit = Some(["EASU albedo slope", "EASU albedo offset"].map(|label| {
                    texture(device, [iw, ih], wgpu::TextureFormat::Rgba16Float, label)
                }));
            }
            let fit = self.fit.clone().unwrap();
            let pipeline = self.pipeline(
                device,
                "fit",
                &sources.easu[5],
                &[wgpu::TextureFormat::Rgba16Float; 2],
            );
            let mut fit_entries = vec![
                (0, view(input)),
                (1, view(&guides[0])),
                (2, view(&guides[1])),
            ];
            fit_entries.extend(tone_entries.iter().cloned());
            let group = bind(device, &pipeline, &fit_entries);
            draw(
                ctx.encoder,
                "EASU albedo fit",
                &pipeline,
                &group,
                &[&fit[0], &fit[1]],
            );
            entries.extend([
                (2, view(&aovs[0].0)),
                (3, view(&aovs[1].0)),
                (4, view(&aovs[2].0)),
                (5, view(&guides[0])),
                (6, view(&guides[1])),
                (
                    7,
                    uniform([
                        detail[4],
                        self.options.coverage_threshold,
                        self.options.depth_threshold,
                        detail[5],
                    ]),
                ),
                (11, view(&fit[0])),
                (12, view(&fit[1])),
            ]);
            entries.extend(tone_entries);
        }
        let (key, source) = if detailed {
            ("detail", &sources.easu[2])
        } else {
            ("color", &sources.easu[0])
        };
        let pipeline = self.pipeline(device, key, source, &[format]);
        let group = bind(device, &pipeline, &entries);
        draw(ctx.encoder, "FSR 1 EASU", &pipeline, &group, &[output]);
        Ok(())
    }
    /// Starts compiling the pass's pipelines on a worker thread, so the first
    /// presents do not wait for shader compilation on the calling thread.
    fn prepare(&mut self, device: &wgpu::Device) {
        if self.compiled.is_some() {
            return;
        }
        let compiled = Arc::new(Mutex::new(HashMap::new()));
        self.compiled = Some(compiled.clone());
        let (device, detail) = (device.clone(), self.options.albedo_detail);
        let _ = std::thread::Builder::new()
            .name("MuTracer EASU pipelines".into())
            .spawn(move || {
                let Ok(sources) = crate::postprocess::sources() else {
                    return;
                };
                let format = wgpu::TextureFormat::Rgba8Unorm;
                let mut list = vec![
                    ("color", sources.easu[0].clone(), vec![format]),
                    ("area", sources.easu[1].clone(), vec![format]),
                ];
                if detail {
                    list.extend(detail_pipelines(&sources.easu));
                }
                for (name, source, formats) in list {
                    // Error scopes belong to this thread; a failure leaves the
                    // pipeline to the synchronous path, which reports it.
                    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
                    let pipeline = create_pipeline(&device, name, &source, &formats);
                    if pollster::block_on(scope.pop()).is_none() {
                        compiled
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(pipeline_key(name, &formats), pipeline);
                    }
                }
            });
    }
    fn ready(&mut self, name: &str, formats: &[wgpu::TextureFormat]) -> bool {
        let key = pipeline_key(name, formats);
        if self.pipelines.contains_key(&key) {
            return true;
        }
        let compiled = self.compiled.as_ref().and_then(|c| {
            c.lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
                .cloned()
        });
        compiled.is_some_and(|pipeline| self.pipelines.insert(key, pipeline).is_none())
    }
    fn pipeline(
        &mut self,
        device: &wgpu::Device,
        name: &str,
        source: &str,
        formats: &[wgpu::TextureFormat],
    ) -> wgpu::RenderPipeline {
        if !self.ready(name, formats) {
            self.pipelines.insert(
                pipeline_key(name, formats),
                create_pipeline(device, name, source, formats),
            );
        }
        self.pipelines[&pipeline_key(name, formats)].clone()
    }
}
/// Albedo guides, tone table, albedo fit and the detail EASU, as compiled for SDR.
fn detail_pipelines(easu: &[String; 6]) -> Vec<(&'static str, String, Vec<wgpu::TextureFormat>)> {
    use wgpu::TextureFormat::{Rgba8Unorm, Rgba16Float, Rgba32Float};
    vec![
        ("albedo", easu[3].clone(), vec![Rgba16Float; 2]),
        ("tone", easu[4].clone(), vec![Rgba32Float]),
        ("fit", easu[5].clone(), vec![Rgba16Float; 2]),
        ("detail", easu[2].clone(), vec![Rgba8Unorm]),
    ]
}
fn pipeline_key(name: &str, formats: &[wgpu::TextureFormat]) -> String {
    format!("{name} {formats:?}")
}
fn create_pipeline(
    device: &wgpu::Device,
    name: &str,
    source: &str,
    formats: &[wgpu::TextureFormat],
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(name),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    let targets: Vec<_> = formats.iter().map(|f| Some((*f).into())).collect();
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(name),
        layout: None,
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vertex"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fragment"),
            compilation_options: Default::default(),
            targets: &targets,
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl Display {
    /// Registers an [`EasuPass`] that outputs at the display size, after the
    /// passes already registered. Keep the subscription until removal. Its
    /// scratch images, with albedo detail about 32 bytes per input pixel plus a
    /// 32 KiB tone table, are released with the registration.
    pub fn add_upscale(&self, options: EasuOptions) -> Result<PostProcessSubscription> {
        let mut pass = EasuPass::new(options)?;
        pass.prepare(&self.engine.inner.gpu.device);
        self.add_post_process_with(PostProcessOptions::display_size(), move |ctx| pass.run(ctx))
    }
}

#[derive(Clone)]
enum Resource {
    View(wgpu::TextureView),
    Buffer(wgpu::Buffer),
}
fn view(texture: &wgpu::Texture) -> Resource {
    Resource::View(texture.create_view(&Default::default()))
}
fn bind(
    device: &wgpu::Device,
    pipeline: &wgpu::RenderPipeline,
    entries: &[(u32, Resource)],
) -> wgpu::BindGroup {
    let entries: Vec<_> = entries
        .iter()
        .map(|(binding, resource)| wgpu::BindGroupEntry {
            binding: *binding,
            resource: match resource {
                Resource::View(view) => wgpu::BindingResource::TextureView(view),
                Resource::Buffer(buffer) => buffer.as_entire_binding(),
            },
        })
        .collect();
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &entries,
    })
}
fn texture(
    device: &wgpu::Device,
    size: [u32; 2],
    format: wgpu::TextureFormat,
    label: &str,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    })
}
/// One fullscreen triangle into cleared targets.
fn draw(
    encoder: &mut wgpu::CommandEncoder,
    label: &str,
    pipeline: &wgpu::RenderPipeline,
    group: &wgpu::BindGroup,
    targets: &[&wgpu::Texture],
) {
    let views: Vec<_> = targets
        .iter()
        .map(|t| t.create_view(&Default::default()))
        .collect();
    let attachments: Vec<_> = views
        .iter()
        .map(|view| {
            Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })
        })
        .collect();
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &attachments,
        ..Default::default()
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.draw(0..3, 0..1);
}
