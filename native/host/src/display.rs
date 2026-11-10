//! GPU-only stable preview. Copy before the next trace or scene publication.
use crate::{GpuDevice, Result};
mod bloom;
mod effects;
#[cfg(test)]
mod effects_tests;
pub(crate) mod jnlm;
mod oidn;
#[derive(Clone, Copy, Default)]
pub(crate) struct Metadata {
    has_catcher: bool,
    flat_background: [f32; 4],
}
impl Metadata {
    pub(crate) fn opaque_background(self) -> bool {
        self.flat_background[3] > 0.5
    }

    pub(crate) fn from_trace(trace: &[u8]) -> Self {
        use crate::layout::ray_uniform as u;
        if trace.len() < u::SCENE_FEATURE_FLAGS + 4 {
            return Self::default();
        }
        let word = |at| u32::from_le_bytes(trace[at..at + 4].try_into().unwrap());
        // WGPU_SCENE_FEATURE_BITS.HAS_SHADOW_CATCHER (WGPUSceneFeatures.ts).
        let has_catcher = word(u::SCENE_FEATURE_FLAGS) & (1 << 14) != 0;
        let mut flat_background = [0.; 4];
        if word(u::BACKGROUND_FLAGS) & 3 == 1 {
            for (i, v) in flat_background.iter_mut().enumerate() {
                *v = f32::from_bits(word(u::BACKGROUND_COLOR + i * 4));
            }
            if flat_background[3] >= 0.99999 {
                flat_background[3] = 1.;
            } else {
                flat_background = [0.; 4];
            }
        }
        Self {
            has_catcher,
            flat_background,
        }
    }
}

/// Display-only settings. Tone modes: AgX/ACES/Cineon/Reinhard/Linear (0–4).
/// Output modes: final/normal/albedo/shadow/shadow-catcher (0–4). Shadow aliases
/// final; shadow-catcher shows the raw mask. Exposure is a linear multiplier.
#[derive(Clone, Copy, PartialEq)]
pub struct Settings {
    pub tone_mapping: u32,
    pub exposure: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub temperature: f32,
    pub tint: f32,
    pub output: u32,
    pub preserve_alpha: bool,
    /// Vignette strength in 0..1. Default 0.
    pub vignette: f32,
    /// Nonnegative bloom intensity; 0 disables it. Default 0.
    pub bloom_intensity: f32,
    /// Nonnegative bloom luminance threshold. Default 1.
    pub bloom_threshold: f32,
    /// Bloom radius in 0..1. Default 0.6.
    pub bloom_radius: f32,
    /// Nonnegative linear RGB shadow-catcher color. Default black.
    pub shadow_catcher_color: [f32; 3],
    /// Shadow-catcher opacity in 0..1. Default 1.
    pub shadow_catcher_alpha: f32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            tone_mapping: 0,
            exposure: 1.,
            contrast: 1.,
            saturation: 1.,
            temperature: 0.,
            tint: 0.,
            output: 0,
            preserve_alpha: true,
            vignette: 0.,
            bloom_intensity: 0.,
            bloom_threshold: 1.,
            bloom_radius: 0.6,
            shadow_catcher_color: [0.; 3],
            shadow_catcher_alpha: 1.,
        }
    }
}
// Composition depends on coverage and catcher layers as well as filtered color.
// Freeze them together so later captures cannot change a retained result.
struct Denoised {
    color: wgpu::Buffer,
    raw: wgpu::Buffer,
    albedo: wgpu::Buffer,
    shadow: Option<wgpu::Buffer>,
    samples: u32,
    metadata: Metadata,
    revision: u64,
}
pub struct Display {
    gpu: GpuDevice,
    pub(super) owner: u64,
    pub texture: wgpu::Texture,
    pub size: [u32; 2],
    linear: wgpu::Buffer,
    raw: wgpu::Buffer,
    normal: wgpu::Buffer,
    albedo: wgpu::Buffer,
    original_samples: u32,
    pub using_denoised: bool,
    /// The last uploaded denoised image, kept on the GPU until `original`.
    denoised: Option<Denoised>,
    /// Uploads from CPU pixels, for tests.
    pub(crate) uploads: u32,
    params: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    group: wgpu::BindGroup,
    samples: u32,
    hdr: Option<(wgpu::Texture, wgpu::ComputePipeline, wgpu::BindGroup)>,
    composed: Option<(wgpu::Texture, wgpu::BindGroup)>,
    composed_hdr: Option<wgpu::Texture>,
    metadata: Metadata,
    shadow: Option<wgpu::Buffer>,
    effects: std::sync::Mutex<Option<effects::Effects>>,
    image_revision: u64,
    denoise_revision: u64,
    oidn: Option<oidn::Filter>,
    jnlm_options: Option<jnlm::Options>,
    jnlm: std::sync::Mutex<Option<jnlm::Jnlm>>,
}
impl Display {
    pub(super) fn new(gpu: GpuDevice, size: [u32; 2]) -> Self {
        let device = &gpu.device;
        let linear = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Stable preview accumulation"),
            size: size[0] as u64 * size[1] as u64 * 16,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let raw = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Unfiltered preview"),
            size: linear.size(),
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let auxiliary = |label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: linear.size(),
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let normal = auxiliary("Stable normal output");
        let albedo = auxiliary("Stable albedo output");
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Native display"),
            size: wgpu::Extent3d {
                width: size[0],
                height: size[1],
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared Web display functions"),
            source: wgpu::ShaderSource::Wgsl(include_str!("display.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 48,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let view = texture.create_view(&Default::default());
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: linear.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: normal.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: albedo.as_entire_binding(),
                },
            ],
        });
        Self {
            gpu,
            owner: 0,
            texture,
            size,
            linear,
            raw,
            normal,
            albedo,
            original_samples: 0,
            using_denoised: false,
            denoised: None,
            uploads: 0,
            params,
            pipeline,
            group,
            samples: 0,
            hdr: None,
            composed: None,
            composed_hdr: None,
            metadata: Metadata::default(),
            shadow: None,
            effects: Default::default(),
            image_revision: 0,
            denoise_revision: 0,
            oidn: None,
            jnlm_options: None,
            jnlm: Default::default(),
        }
    }
    pub(super) fn capture(
        &mut self,
        source: &wgpu::Buffer,
        normal: &wgpu::Buffer,
        albedo: &wgpu::Buffer,
        shadow: &wgpu::Buffer,
        metadata: Metadata,
        samples: u32,
    ) {
        self.metadata = metadata;
        self.image_revision += 1;
        if samples < self.original_samples {
            self.reset_effects();
        }
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        if metadata.has_catcher || self.jnlm_options.is_some() {
            let target = self.shadow.get_or_insert_with(|| {
                self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("Stable catcher accumulation"),
                    size: shadow.size(),
                    usage: wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::COPY_DST
                        | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                })
            });
            encoder.copy_buffer_to_buffer(shadow, 0, target, 0, target.size());
        }
        encoder.copy_buffer_to_buffer(source, 0, &self.raw, 0, self.raw.size());
        encoder.copy_buffer_to_buffer(normal, 0, &self.normal, 0, self.normal.size());
        encoder.copy_buffer_to_buffer(albedo, 0, &self.albedo, 0, self.albedo.size());
        encoder.copy_buffer_to_buffer(&self.raw, 0, &self.linear, 0, self.linear.size());
        self.gpu.queue.submit([encoder.finish()]);
        self.samples = samples;
        self.original_samples = samples;
        self.using_denoised = false;
    }
    pub(crate) fn set_jnlm(&mut self, options: Option<jnlm::Options>) {
        if self.jnlm_options != options {
            self.jnlm_options = options;
            *self.jnlm.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }
    /// Replace the preview with a caller-owned linear denoised result. The image
    /// stays on the GPU, so [`Display::show_denoised`] can show it again after a capture.
    pub fn upload(&mut self, pixels: &[f32]) -> Result<()> {
        if pixels.len() != self.size[0] as usize * self.size[1] as usize * 4
            || pixels.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid display image".into());
        }
        let bytes: Vec<_> = bytemuck::cast_slice(pixels).to_vec();
        let queue = self.gpu.queue.clone();
        self.retain_denoised(|_, target| queue.write_buffer(target, 0, &bytes));
        self.uploads += 1;
        Ok(())
    }
    pub(crate) fn denoise_buffers(&mut self) -> Result<crate::api::DenoiseBuffers> {
        if self.original_samples == 0 {
            return Err("No completed denoiser input".into());
        }
        let copy = |source: &wgpu::Buffer, encoder: &mut wgpu::CommandEncoder| {
            let buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Custom immutable raw guide snapshot"),
                size: source.size(),
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            encoder.copy_buffer_to_buffer(source, 0, &buffer, 0, source.size());
            buffer
        };
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        let buffers = crate::api::DenoiseBuffers {
            color: copy(&self.raw, &mut encoder),
            normal: copy(&self.normal, &mut encoder),
            albedo: copy(&self.albedo, &mut encoder),
        };
        self.gpu.queue.submit([encoder.finish()]);
        Ok(buffers)
    }
    /// A same-device GPU result follows the identical composition path as CPU
    /// filtering. Raw accumulation and HDR exports continue using `raw`.
    pub(crate) fn upload_gpu(&mut self, source: &wgpu::Buffer) -> Result<()> {
        self.gpu.loss.check()?;
        if source.size() < self.linear.size()
            || !source.usage().contains(wgpu::BufferUsages::COPY_SRC)
        {
            return Err("Invalid display GPU image".into());
        }
        let size = self.linear.size();
        self.retain_denoised(|encoder, target| {
            encoder.copy_buffer_to_buffer(source, 0, target, 0, size)
        });
        Ok(())
    }
    fn retain_denoised(&mut self, write: impl FnOnce(&mut wgpu::CommandEncoder, &wgpu::Buffer)) {
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        let allocate = |size| {
            self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Denoised composition snapshot"),
                size,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        if let Some(oidn) = &mut self.oidn {
            oidn.result = None;
        }
        let previous = self.denoised.take();
        let snapshot = |source: &wgpu::Buffer,
                        previous: Option<&wgpu::Buffer>,
                        encoder: &mut wgpu::CommandEncoder| {
            let buffer = previous
                .filter(|b| b.size() == source.size())
                .cloned()
                .unwrap_or_else(|| allocate(source.size()));
            encoder.copy_buffer_to_buffer(source, 0, &buffer, 0, source.size());
            buffer
        };
        let frozen = Denoised {
            color: previous
                .as_ref()
                .map(|d| d.color.clone())
                .unwrap_or_else(|| allocate(self.linear.size())),
            raw: snapshot(&self.raw, previous.as_ref().map(|d| &d.raw), &mut encoder),
            albedo: snapshot(
                &self.albedo,
                previous.as_ref().map(|d| &d.albedo),
                &mut encoder,
            ),
            shadow: self
                .shadow
                .as_ref()
                .filter(|_| self.metadata.has_catcher)
                .map(|s| {
                    snapshot(
                        s,
                        previous.as_ref().and_then(|d| d.shadow.as_ref()),
                        &mut encoder,
                    )
                }),
            samples: self.original_samples,
            metadata: self.metadata,
            revision: self.image_revision + 1,
        };
        write(&mut encoder, &frozen.color);
        self.gpu.queue.submit([encoder.finish()]);
        self.denoised = Some(frozen);
        self.denoise_revision += 1;
        self.image_revision += 1;
        self.show_denoised();
    }
    /// Shows the last uploaded denoised image again, for example after a capture
    /// replaced it with newer samples. Returns false when there is none.
    pub fn show_denoised(&mut self) -> bool {
        if self.oidn.as_ref().is_some_and(|o| o.result.is_some()) {
            self.using_denoised = true;
            return true;
        }
        let Some(denoised) = &self.denoised else {
            return false;
        };
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&denoised.color, 0, &self.linear, 0, self.linear.size());
        self.gpu.queue.submit([encoder.finish()]);
        self.samples = 1;
        self.using_denoised = true;
        true
    }
    /// Shows the captured samples and forgets the denoised image.
    pub fn original(&mut self) {
        self.reset_effects();
        self.denoised = None;
        if let Some(oidn) = &mut self.oidn {
            oidn.result = None;
        }
        if !self.using_denoised {
            return;
        }
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&self.raw, 0, &self.linear, 0, self.linear.size());
        self.gpu.queue.submit([encoder.finish()]);
        self.samples = self.original_samples;
        self.using_denoised = false;
    }
    /// Compatibility helper for the original opaque Reinhard preview in EV.
    pub fn compose(&self, exposure: f32) {
        self.compose_with(&Settings {
            tone_mapping: 3,
            exposure: 2f32.powf(exposure),
            preserve_alpha: false,
            ..Settings::default()
        });
    }
    pub fn compose_with(&self, settings: &Settings) {
        self.compose_inner(settings, true);
    }
    // Metal exports match L1 CPU HDR readback exactly, including its f32 mean
    // and opaque-background rules. These are immutable captured GPU buffers.
    #[cfg(target_os = "macos")]
    pub(crate) fn metal_hdr_inputs(&self) -> ([wgpu::Buffer; 3], [u32; 4]) {
        (
            [self.raw.clone(), self.normal.clone(), self.albedo.clone()],
            [
                self.size[0],
                self.size[1],
                self.original_samples,
                self.metadata.opaque_background() as u32,
            ],
        )
    }
    /// Resolved raw ray color, without denoising or display transforms. Match
    /// WebGPU's hit normalization and per-pixel coverage, including blank pixels.
    pub(crate) fn hdr_texture(&mut self) -> wgpu::Texture {
        if self.hdr.is_none() {
            let texture = image(
                &self.gpu.device,
                self.size,
                wgpu::TextureFormat::Rgba32Float,
            );
            let pipeline =
                self.gpu
                    .device
                    .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                        label: Some("MuTracer HDR resolve"),
                        layout: None,
                        module: &self.gpu.device.create_shader_module(
                            wgpu::ShaderModuleDescriptor {
                                label: Some("MuTracer HDR resolve"),
                                source: wgpu::ShaderSource::Wgsl(
                                    include_str!("hdr-output.wgsl").into(),
                                ),
                            },
                        ),
                        entry_point: Some("main"),
                        compilation_options: Default::default(),
                        cache: None,
                    });
            let group = self
                .gpu
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &pipeline.get_bind_group_layout(0),
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: self.raw.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: self.normal.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: self.albedo.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: wgpu::BindingResource::TextureView(
                                &texture.create_view(&Default::default()),
                            ),
                        },
                    ],
                });
            self.hdr = Some((texture, pipeline, group));
        }
        let (texture, pipeline, group) = self.hdr.as_ref().unwrap();
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        }
        self.gpu.queue.submit([encoder.finish()]);
        texture.clone()
    }
    pub(crate) fn compose_straight(&mut self, settings: &Settings) -> wgpu::Texture {
        if self.composed.is_none() {
            let texture = image(&self.gpu.device, self.size, wgpu::TextureFormat::Rgba8Unorm);
            let group = self
                .gpu
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.pipeline.get_bind_group_layout(0),
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: self.linear.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(
                                &texture.create_view(&Default::default()),
                            ),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: self.params.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: self.normal.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 4,
                            resource: self.albedo.as_entire_binding(),
                        },
                    ],
                });
            self.composed = Some((texture, group));
        }
        let (texture, group) = self.composed.as_ref().unwrap();
        self.compose_into(settings, false, group, texture);
        texture.clone()
    }
    pub(crate) fn compose_hdr(&mut self, settings: &Settings) -> wgpu::Texture {
        if self.composed_hdr.is_none() {
            self.composed_hdr = Some(image(
                &self.gpu.device,
                self.size,
                wgpu::TextureFormat::Rgba16Float,
            ));
        }
        let target = self.composed_hdr.as_ref().unwrap();
        let mut slot = self.effects.lock().unwrap_or_else(|e| e.into_inner());
        let effects = slot.get_or_insert_with(|| effects::Effects::new(&self.gpu.device));
        if !self
            .oidn
            .as_ref()
            .is_some_and(|o| o.present(self, settings, false, target))
        {
            if let Some(options) = self
                .jnlm_options
                .filter(|_| matches!(settings.output, 0 | 3) && self.shadow.is_some())
            {
                let mut slot = self.jnlm.lock().unwrap_or_else(|e| e.into_inner());
                if slot.as_ref().is_none_or(|j| !j.matches(self.size, options)) {
                    *slot = Some(jnlm::Jnlm::new(&self.gpu, self.size, options));
                }
                slot.as_mut()
                    .unwrap()
                    .compose(self, settings, false, effects, target)
                    .expect("HDR JNLM guide capture");
            } else {
                effects.compose(self, settings, false, target);
            }
        }
        target.clone()
    }
    fn shown(&self, settings: &Settings) -> Option<&Denoised> {
        self.denoised
            .as_ref()
            .filter(|_| self.using_denoised && matches!(settings.output, 0 | 3))
    }
    fn shown_samples(&self, settings: &Settings) -> u32 {
        self.shown(settings)
            .map_or(self.original_samples, |d| d.samples)
    }
    fn shown_metadata(&self, settings: &Settings) -> Metadata {
        self.shown(settings).map_or(self.metadata, |d| d.metadata)
    }
    fn shown_raw(&self, settings: &Settings) -> &wgpu::Buffer {
        self.shown(settings).map_or(&self.raw, |d| &d.raw)
    }
    fn shown_albedo(&self, settings: &Settings) -> &wgpu::Buffer {
        self.shown(settings).map_or(&self.albedo, |d| &d.albedo)
    }
    fn shown_shadow(&self, settings: &Settings) -> Option<&wgpu::Buffer> {
        self.shown(settings)
            .map_or(self.shadow.as_ref(), |d| d.shadow.as_ref())
    }
    fn shown_revision(&self, settings: &Settings) -> u64 {
        self.shown(settings)
            .map_or(self.image_revision, |d| d.revision)
    }
    fn shown_group(&self, target: &wgpu::Texture, settings: &Settings) -> wgpu::BindGroup {
        self.gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Retained denoised composition"),
                layout: &self.pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.linear.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(
                            &target.create_view(&Default::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: self.params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: self.normal.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: self.shown_albedo(settings).as_entire_binding(),
                    },
                ],
            })
    }
    fn compose_inner(&self, settings: &Settings, premultiply: bool) {
        self.compose_into(settings, premultiply, &self.group, &self.texture);
    }
    fn reset_effects(&mut self) {
        if let Some(effects) = self
            .effects
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            effects.reset();
        }
    }
    fn compose_into(
        &self,
        settings: &Settings,
        premultiply: bool,
        group: &wgpu::BindGroup,
        target: &wgpu::Texture,
    ) {
        if self.samples == 0 {
            return;
        }
        if self
            .oidn
            .as_ref()
            .is_some_and(|o| o.present(self, settings, premultiply, target))
        {
            return;
        }
        if let Some(options) = self
            .jnlm_options
            .filter(|_| matches!(settings.output, 0 | 3) && self.shadow.is_some())
        {
            let mut slot = self.jnlm.lock().unwrap_or_else(|e| e.into_inner());
            if slot
                .as_ref()
                .is_none_or(|filter| !filter.matches(self.size, options))
            {
                *slot = Some(jnlm::Jnlm::new(&self.gpu, self.size, options));
            }
            let mut effects = self.effects.lock().unwrap_or_else(|e| e.into_inner());
            let effects = effects.get_or_insert_with(|| effects::Effects::new(&self.gpu.device));
            slot.as_mut()
                .unwrap()
                .compose(self, settings, premultiply, effects, target)
                .expect("JNLM stable guide capture");
            return;
        }
        if settings.vignette != 0.
            || settings.bloom_intensity > 0.
            || self.shown_metadata(settings).has_catcher
            || self.shown_metadata(settings).flat_background[3] > 0.
            || settings.output >= 3
        {
            let mut slot = self.effects.lock().unwrap_or_else(|e| e.into_inner());
            let effects = slot.get_or_insert_with(|| effects::Effects::new(&self.gpu.device));
            effects.compose(self, settings, premultiply, target);
            return;
        }
        #[cfg(test)]
        effects_tests::record_order(if settings.output == 0 || settings.output == 3 {
            "Compose:DisplayEncoded"
        } else {
            "AOV:Raw"
        });
        let retained_group = self
            .shown(settings)
            .map(|_| self.shown_group(target, settings));
        let group = retained_group.as_ref().unwrap_or(group);
        let bytes: Vec<_> = bytemuck::cast_slice(&[
            self.size[0],
            self.size[1],
            (self.samples as f32).to_bits(),
            settings.exposure.to_bits(),
            settings.tone_mapping,
            settings.output,
            u32::from(settings.preserve_alpha) | (u32::from(premultiply) << 1),
            (self.shown_samples(settings).max(1) as f32).to_bits(),
            settings.contrast.to_bits(),
            settings.saturation.to_bits(),
            settings.temperature.to_bits(),
            settings.tint.to_bits(),
        ])
        .to_vec();
        self.gpu.queue.write_buffer(&self.params, 0, &bytes);
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        }
        self.gpu.queue.submit([encoder.finish()]);
    }
    /// Export the same composition with straight PNG alpha, then restore the
    /// premultiplied texture expected by egui. Call between presentation frames.
    pub fn read_rgba(&self, settings: &Settings) -> Result<Vec<u8>> {
        self.compose_inner(settings, false);
        let result = self.read_texture();
        self.compose_with(settings);
        result
    }
    fn read_texture(&self) -> Result<Vec<u8>> {
        self.read_image(&self.texture)
    }
    pub(crate) fn read_image(&self, texture: &wgpu::Texture) -> Result<Vec<u8>> {
        read_image(&self.gpu, texture)
    }

    /// Explicit export/diagnostic readback; presentation never calls this.
    pub fn read_linear(&self) -> Result<Vec<f32>> {
        Ok(bytemuck::pod_collect_to_vec(&crate::read_average(
            &self.gpu.device,
            &self.gpu.queue,
            &self.linear,
            self.size[0],
            self.size[1],
            self.samples,
        )?))
    }
}

pub(crate) fn image(
    device: &wgpu::Device,
    size: [u32; 2],
    format: wgpu::TextureFormat,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("MuTracer borrowed output"),
        size: wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST
            | if matches!(
                format,
                wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba16Float
            ) {
                wgpu::TextureUsages::RENDER_ATTACHMENT
            } else {
                wgpu::TextureUsages::empty()
            },
        view_formats: &[],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn gpu_output_hdr_matches_web_hit_normalization_and_ignores_denoising() {
        let gpu = GpuDevice::with_backend(0).unwrap();
        let mut display = Display::new(gpu.clone(), [2, 2]);
        let raw: Vec<f32> = vec![
            4., 2., 1., 1., 8., 4., 2., 4., 6., 3., 1.5, 2., 99., 99., 99., 99.,
        ];
        let normal: Vec<f32> = vec![
            0., 0., 2., 4., 0., 0., 3., 4., 0., 0., 0., 4., 0., 0., 0., 0.,
        ];
        let albedo: Vec<f32> = vec![
            0., 0., 0., 1., 0., 0., 0., 2., 0., 0., 0., 0., 0., 0., 0., 0.,
        ];
        for (target, data) in [
            (&display.raw, &raw),
            (&display.normal, &normal),
            (&display.albedo, &albedo),
        ] {
            gpu.queue.write_buffer(
                target,
                0,
                &data
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<_>>(),
            );
        }
        let expected: Vec<f32> = vec![
            1.5, 0.75, 0.375, 0.5, 0., 0., 0., 0., 4., 2., 1., 0.25, 4., 2., 1., 1.,
        ];
        // Read on this capture's own device (no cross-device texture use).
        let texture = display.hdr_texture();
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 512,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let read = |texture: &wgpu::Texture| {
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            encoder.copy_texture_to_buffer(
                texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(256),
                        rows_per_image: None,
                    },
                },
                texture.size(),
            );
            gpu.queue.submit([encoder.finish()]);
            let (send, receive) = std::sync::mpsc::channel();
            buffer.map_async(wgpu::MapMode::Read, .., move |r| {
                let _ = send.send(r);
            });
            gpu.device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(5)),
                })
                .unwrap();
            receive.recv().unwrap().unwrap();
            let data: Vec<f32> = {
                let mapped = buffer.get_mapped_range(..).unwrap();
                mapped
                    .chunks_exact(256)
                    .flat_map(|row| {
                        row[..32]
                            .chunks_exact(4)
                            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                    })
                    .collect()
            };
            buffer.unmap();
            data
        };
        assert_eq!(read(&texture), expected);
        // CPU HDR follows rawOutputPass: straight coverage for transparent/mapped
        // backgrounds, per-sample RGB for opaque flat backgrounds. Readback must
        // not overwrite the separately borrowed GPU texture or accumulation.
        let inputs = [&raw, &normal, &albedo].map(|data| {
            wgpu::util::DeviceExt::create_buffer_init(
                &gpu.device,
                &wgpu::util::BufferInitDescriptor {
                    label: Some("HDR readback fixture"),
                    contents: &data
                        .iter()
                        .flat_map(|v| v.to_le_bytes())
                        .collect::<Vec<_>>(),
                    usage: wgpu::BufferUsages::COPY_SRC,
                },
            )
        });
        let inputs = [&inputs[0], &inputs[1], &inputs[2]];
        let transparent = crate::hdr::read(&gpu, inputs, [2, 2], 4, false).unwrap();
        assert_eq!(
            transparent,
            vec![
                4., 2., 1., 0.25, 4., 2., 1., 1., 1.5, 0.75, 0.375, 0.5, 0., 0., 0., 0.
            ]
        );
        let flat = crate::hdr::read(&gpu, inputs, [2, 2], 4, true).unwrap();
        assert_eq!(
            flat,
            vec![
                1., 0.5, 0.25, 0.25, 2., 1., 0.5, 1., 1.5, 0.75, 0.375, 0.5, 0., 0., 0., 0.
            ]
        );
        assert_eq!(read(&texture), expected);
        display.upload(&[0.75; 16]).unwrap();
        assert_eq!(read(&display.hdr_texture()), expected);
    }

    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn display_settings_alpha_channels_and_export_preserve_linear_data() {
        let gpu = GpuDevice::with_backend(0).expect("GPU validation requires a working device");
        // Non-aligned width and two different rows exercise readback padding/orientation.
        let mut display = Display::new(gpu.clone(), [3, 2]);
        let pixels: Vec<f32> = vec![
            0.4, 0.2, 0.1, 1., 0.4, 0.2, 0.1, 0.5, 0., 0., 0., 0., 2., 0.3, 0.1, 1., 0.1, 0.4, 0.8,
            1., 0.9, 0.2, 0.7, 1.,
        ];
        let auxiliary: Vec<f32> = pixels
            .chunks_exact(4)
            .flat_map(|p| [0.2, 0.3, 0.4, p[3]])
            .collect();
        gpu.queue.write_buffer(
            &display.albedo,
            0,
            &auxiliary
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        );
        let normals: Vec<f32> = pixels
            .chunks_exact(4)
            .flat_map(|p| [0., 0., p[3], 1.])
            .collect();
        gpu.queue.write_buffer(
            &display.normal,
            0,
            &normals
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        );
        display.upload(&pixels).unwrap();
        let mut settings = Settings {
            tone_mapping: 3,
            ..Settings::default()
        };
        let baseline = display.read_rgba(&settings).unwrap();
        assert_eq!(&baseline[20..24], &[0, 0, 0, 0]);
        // Half-range values can quantize to either adjacent rgba8unorm code.
        assert!(baseline[19].abs_diff(128) <= 1);
        let srgb = |v: f32| {
            if v <= 0.0031308 {
                12.92 * v
            } else {
                1.055 * v.powf(1. / 2.4) - 0.055
            }
        };
        for (offset, linear) in [(12, [0.4, 0.2, 0.1]), (16, [0.8, 0.4, 0.2])] {
            for c in 0..3 {
                let v = linear[c];
                let expected = (srgb(v / (1. + v)) * 255. + 0.5) as i32;
                assert!((baseline[offset + c] as i32 - expected).abs() <= 1);
            }
        }
        let premultiplied = display.read_texture().unwrap();
        for c in 0..3 {
            assert!((premultiplied[16 + c] as f32 - baseline[16 + c] as f32 * 0.5).abs() <= 1.);
        }
        let mut modes = Vec::new();
        for mode in 0..5 {
            settings.tone_mapping = mode;
            let rgba = display.read_rgba(&settings).unwrap();
            assert!(!modes.contains(&rgba), "Tone mode {mode} had no effect");
            modes.push(rgba);
        }
        for case in 0..5 {
            settings = Settings {
                tone_mapping: 3,
                ..Settings::default()
            };
            match case {
                0 => settings.exposure = 0.5,
                1 => settings.contrast = 1.4,
                2 => settings.saturation = 0.,
                3 => settings.temperature = -0.7,
                _ => settings.tint = 0.8,
            }
            assert_ne!(display.read_rgba(&settings).unwrap(), baseline);
        }
        settings = Settings {
            tone_mapping: 3,
            ..Settings::default()
        };
        assert_eq!(display.read_rgba(&settings).unwrap(), baseline);
        assert_eq!(display.read_linear().unwrap(), pixels);
        settings.output = 1;
        let normal = display.read_rgba(&settings).unwrap();
        assert!(normal[12].abs_diff(128) <= 1);
        assert!(normal[13].abs_diff(128) <= 1);
        assert_eq!(&normal[14..16], &[255, 255]);
        settings.exposure = 0.;
        settings.saturation = 0.;
        assert_eq!(display.read_rgba(&settings).unwrap(), normal);
        settings.output = 2;
        let albedo = display.read_rgba(&settings).unwrap();
        assert_ne!(albedo, normal);
        assert!((albedo[12] as f32 - 0.2 * 255.).abs() <= 1.);
        assert!(albedo[19].abs_diff(128) <= 1);
        assert_eq!(display.read_linear().unwrap(), pixels);
    }

    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn gpu_preview_matches_reinhard_srgb_and_bottom_up_hdr() {
        let gpu = GpuDevice::with_backend(0).expect("GPU validation requires a working device");
        let size = [64, 2];
        let mut display = Display::new(gpu.clone(), size);
        let pixels: Vec<f32> = (0..128)
            .flat_map(|i| {
                [
                    i as f32 * 0.025 - 0.1,
                    (i % 9) as f32 * 0.1,
                    if i % 3 == 0 { 10000. } else { 0.002 },
                    0.3,
                ]
            })
            .collect();
        display.upload(&pixels).unwrap();
        display.compose(0.5);
        let read = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 512,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            display.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &read,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: 64,
                height: 2,
                depth_or_array_layers: 1,
            },
        );
        gpu.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        read.map_async(wgpu::MapMode::Read, .., move |r| tx.send(r).unwrap());
        gpu.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_secs(30)),
            })
            .unwrap();
        rx.recv().unwrap().unwrap();
        let rgba = read.get_mapped_range(..).unwrap();
        for y in 0..2 {
            for x in 0..64 {
                for c in 0..3 {
                    let v = (pixels[((1 - y) * 64 + x) * 4 + c] * 2f32.sqrt()).max(0.);
                    let v = v / (1. + v);
                    let s = if v <= 0.0031308 {
                        12.92 * v
                    } else {
                        1.055 * v.powf(1. / 2.4) - 0.055
                    };
                    let expected = (s.clamp(0., 1.) * 255. + 0.5) as i32;
                    assert!(
                        (rgba[(y * 64 + x) * 4 + c] as i32 - expected).abs() <= 1,
                        "x={x}, y={y}, c={c}"
                    );
                }
                assert_eq!(rgba[(y * 64 + x) * 4 + 3], 255);
            }
        }
        assert_eq!(display.read_linear().unwrap(), pixels);
    }
}

/// Straight RGBA8 readback, including auxiliary images with no beauty capture.
pub(crate) fn read_image(gpu: &GpuDevice, texture: &wgpu::Texture) -> Result<Vec<u8>> {
    let size = [texture.width(), texture.height()];
    let pixel_bytes = texture
        .format()
        .block_copy_size(None)
        .ok_or("Unsupported display readback format")?;
    let stride = (size[0] * pixel_bytes).div_ceil(256) * 256;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Display export readback"),
        size: stride as u64 * size[1] as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit([encoder.finish()]);
    let (tx, rx) = std::sync::mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |r| {
        let _ = tx.send(r);
    });
    crate::GpuDevice::wait(&gpu.device)?;
    rx.recv_timeout(std::time::Duration::from_secs(5))??;
    let mapped = buffer.get_mapped_range(..)?;
    Ok(mapped
        .chunks_exact(stride as usize)
        .flat_map(|row| {
            row[..size[0] as usize * pixel_bytes as usize]
                .iter()
                .copied()
        })
        .collect())
}

// HDR surfaces consume display-linear pixels directly, preserving values above one.
fn hdr_transfer(device: &wgpu::Device) -> wgpu::ComputePipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Display-linear HDR transfer"),
        source: wgpu::ShaderSource::Wgsl(include_str!("display-linear-hdr.wgsl").into()),
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("Display-linear HDR transfer"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    })
}
