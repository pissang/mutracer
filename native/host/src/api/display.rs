//! Display settings, presentation and export over the shared display composition.
use super::engine::{Engine, State};
use super::render::{Readiness, Render, readiness};
use super::{Result, Status, error};
use crate::GpuDevice;

/// Tone mapping transform.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ToneMapping {
    #[default]
    Agx,
    Aces,
    Cineon,
    Reinhard,
    Linear,
}
/// Displayed image channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Channel {
    #[default]
    Final,
    Normal,
    Albedo,
    /// Compatibility channel: same image as Final, matching the WebGPU pipeline.
    Shadow,
    /// Raw catcher coverage, background alpha/hits and shadow opacity.
    ShadowCatcher,
    /// Camera-forward depth as clamped grayscale using aov.depth_range.
    /// All AOV channels require their bit in the selected render's aovs mask.
    Depth,
    /// World xyz as RGB: origin 0.5, ±aov.position_scale maps to 0/1, clamped.
    Position,
    /// RGB = roughness, metalness, unsupported-reflectance fraction.
    Roughness,
    /// Supported diffuse reflectance clamped to [0,1], then sRGB encoded.
    DiffuseAlbedo,
    /// Supported specular reflectance clamped to [0,1], then sRGB encoded.
    SpecularAlbedo,
    /// Stable pseudocolor of aov.id_component; palette colors can collide.
    Id,
    /// Direction as hue (+x red, +y yellow-green), displacement/scale as brightness.
    /// Invalid history is transparent; valid zero motion is opaque black.
    Motion,
}
impl Channel {
    pub(super) fn aov_kind(self) -> Option<super::PixelKind> {
        let value = self as u32;
        (value >= 5).then(|| super::PixelKind::from_aov_index(value - 5))
    }
}
/// Stable ID lane used by the display palette. Default Object.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AovIdComponent {
    #[default]
    Object,
    Instance,
    Material,
    Primitive,
}
/// Display-only AOV visualization; raw AOV values are unchanged.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AovDisplayOptions {
    /// Scene-unit depths mapped to black/white, 0 <= near < far. Default [0,10].
    pub depth_range: [f32; 2],
    /// Positive scene-unit half-range around the origin for position RGB. Default 1.
    pub position_scale: f32,
    /// Positive input-pixel displacement mapped to full motion brightness. Default 16.
    pub motion_scale: f32,
    /// Stable ID lane to colorize. Default Object.
    pub id_component: AovIdComponent,
}
impl Default for AovDisplayOptions {
    fn default() -> Self {
        Self {
            depth_range: [0., 10.],
            position_scale: 1.,
            motion_scale: 16.,
            id_component: AovIdComponent::Object,
        }
    }
}
impl AovDisplayOptions {
    pub(super) fn validate(&self) -> Result<()> {
        if self.depth_range.iter().any(|v| !v.is_finite())
            || self.depth_range[0] < 0.
            || self.depth_range[1] <= self.depth_range[0]
            || !self.position_scale.is_finite()
            || self.position_scale <= 0.
            || !self.motion_scale.is_finite()
            || self.motion_scale <= 0.
        {
            return Err(error(
                Status::InvalidArgument,
                "Invalid AOV display range or scale",
            ));
        }
        Ok(())
    }
}
/// Display-only settings shared by every render presented on the engine display.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplaySettings {
    /// Default [`ToneMapping::Agx`].
    pub tone_mapping: ToneMapping,
    /// Linear exposure multiplier. Default 1.
    pub tone_mapping_exposure: f32,
    /// Contrast multiplier. Default 1.
    pub contrast: f32,
    /// Saturation multiplier. Default 1.
    pub saturation: f32,
    /// White balance temperature shift in -1–1. Default 0.
    pub temperature: f32,
    /// Green/magenta tint in -1–1. Default 0.
    pub tint: f32,
    /// Default [`Channel::Final`].
    pub channel: Channel,
    /// AOV visualization options. Default AovDisplayOptions::default().
    pub aov: AovDisplayOptions,
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
    /// Shadow-catcher opacity in 0..1. Default 1. Lower values subtract from the
    /// estimated shadow opacity, so faint shadows disappear first.
    pub shadow_catcher_alpha: f32,
    /// Request extended-range window presentation. Default false. Unsupported
    /// surfaces fall back to SDR; pixel/PNG export remains SDR.
    pub hdr_output_enabled: bool,
}
impl Default for DisplaySettings {
    fn default() -> Self {
        Self {
            tone_mapping: ToneMapping::Agx,
            tone_mapping_exposure: 1.,
            contrast: 1.,
            saturation: 1.,
            temperature: 0.,
            tint: 0.,
            channel: Channel::Final,
            aov: AovDisplayOptions::default(),
            vignette: 0.,
            bloom_intensity: 0.,
            bloom_threshold: 1.,
            bloom_radius: 0.6,
            shadow_catcher_color: [0.; 3],
            shadow_catcher_alpha: 1.,
            hdr_output_enabled: false,
        }
    }
}
impl DisplaySettings {
    fn validate(&self) -> Result<()> {
        self.aov.validate()?;
        let values = [
            self.tone_mapping_exposure,
            self.contrast,
            self.saturation,
            self.temperature,
            self.tint,
            self.vignette,
            self.bloom_intensity,
            self.bloom_threshold,
            self.bloom_radius,
            self.shadow_catcher_color[0],
            self.shadow_catcher_color[1],
            self.shadow_catcher_color[2],
            self.shadow_catcher_alpha,
        ];
        if values.iter().any(|v| !v.is_finite()) {
            return Err(error(
                Status::InvalidArgument,
                "Display settings must be finite",
            ));
        }
        if !(0.0..=1.0).contains(&self.vignette)
            || !(0.0..=1.0).contains(&self.bloom_radius)
            || !(0.0..=1.0).contains(&self.shadow_catcher_alpha)
            || self.bloom_intensity < 0.
            || self.bloom_threshold < 0.
            || self.shadow_catcher_color.iter().any(|v| *v < 0.)
        {
            return Err(error(
                Status::InvalidArgument,
                "Invalid display effect settings",
            ));
        }
        Ok(())
    }
    pub(super) fn composition(&self) -> crate::display::Settings {
        crate::display::Settings {
            tone_mapping: self.tone_mapping as u32,
            exposure: self.tone_mapping_exposure,
            contrast: self.contrast,
            saturation: self.saturation,
            temperature: self.temperature,
            tint: self.tint,
            output: self.channel as u32,
            preserve_alpha: true,
            vignette: self.vignette,
            bloom_intensity: self.bloom_intensity,
            bloom_threshold: self.bloom_threshold,
            bloom_radius: self.bloom_radius,
            shadow_catcher_color: self.shadow_catcher_color,
            shadow_catcher_alpha: self.shadow_catcher_alpha,
        }
    }
}
/// The image shown by a successful [`Display::present`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Presented {
    /// Whether the render's fallback was shown instead of the render.
    pub fallback: bool,
    /// Size of the presented render image before scaling to the display.
    pub width: u32,
    pub height: u32,
    pub samples: u32,
}

/// Which render to present: the browser `Display.present` rule. With the final
/// channel and a fallback, the render must be presentable (denoising does not hide
/// its first image); otherwise complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Selection {
    Render,
    Fallback,
}
pub(super) fn select(
    final_channel: bool,
    render: Readiness,
    fallback: Option<Readiness>,
) -> Option<Selection> {
    let ready = |r: Readiness| {
        if final_channel {
            r.presentable
        } else {
            r.complete
        }
    };
    let render_ready = if final_channel && fallback.is_some() {
        render.presentable
    } else {
        render.complete
    };
    if render_ready {
        Some(Selection::Render)
    } else if fallback.is_some_and(ready) {
        Some(Selection::Fallback)
    } else {
        None
    }
}

struct Blit {
    pipeline: wgpu::ComputePipeline,
    straight: wgpu::ComputePipeline,
    sampler: wgpu::Sampler,
}
pub(super) struct DisplayState {
    pub(super) size: [u32; 2],
    pub(super) settings: DisplaySettings,
    texture: Option<wgpu::Texture>,
    pub(super) surface: Option<super::surface::SurfaceTarget>,
    blit: Option<Blit>,
    pub(super) hdr_texture: Option<wgpu::Texture>,
    hdr_blit: Option<Blit>,
    pub(super) passes: Vec<super::post_process::Entry>,
    pub(super) hdr_passes: Vec<super::post_process::Entry>,
    pub(super) next_pass: u64,
    pub(super) pass_revision: u64,
    presented_pass_revision: u64,
    pub(super) presented_render: Option<u64>,
    pub(super) processing: bool,
}
impl Default for DisplayState {
    /// The browser's default canvas size.
    fn default() -> Self {
        Self {
            size: [300, 150],
            settings: DisplaySettings::default(),
            texture: None,
            surface: None,
            blit: None,
            hdr_texture: None,
            hdr_blit: None,
            passes: Vec::new(),
            hdr_passes: Vec::new(),
            next_pass: 1,
            pass_revision: 0,
            presented_pass_revision: 0,
            presented_render: None,
            processing: false,
        }
    }
}
impl DisplayState {
    pub(super) fn clear_image(&mut self, gpu: &GpuDevice) -> Result<()> {
        self.presented_render = None;
        self.texture = None;
        self.hdr_texture = None;
        self.present_empty(gpu)
    }
    pub(super) fn present_empty(&mut self, gpu: &GpuDevice) -> Result<()> {
        self.presented_render = None;
        if let Some(surface) = &mut self.surface {
            // wgpu initializes unwritten texels to transparent black. This image
            // is transient: empty scenes still have no readable render output.
            let empty = gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("MuTracer empty window"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            surface.present(gpu, &empty)?;
        }
        Ok(())
    }
}
const BLIT: &str = r#"
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
override premultiply: bool = false;
fn premultiplied_pixel(pixel: vec2i) -> vec4f {
  let size = vec2i(textureDimensions(source));
  let rgba = textureLoad(source, clamp(pixel, vec2i(0), size - vec2i(1)), 0);
  return vec4f(rgba.rgb * rgba.a, rgba.a);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  var color = textureSampleLevel(source, source_sampler, uv, 0.0);
  if (premultiply) {
    // Interpolate premultiplied texels so transparent colors cannot create halos.
    let pixel = uv * vec2f(textureDimensions(source)) - 0.5;
    let base = vec2i(floor(pixel));
    let weight = fract(pixel);
    color = mix(mix(premultiplied_pixel(base), premultiplied_pixel(base + vec2i(1, 0)), weight.x),
      mix(premultiplied_pixel(base + vec2i(0, 1)), premultiplied_pixel(base + vec2i(1, 1)), weight.x), weight.y);
  }
  textureStore(output, id.xy, color);
}
"#;

/// Offscreen or window presentation and shared display settings; obtained from [`Engine::display`].
pub struct Display {
    pub(super) engine: Engine,
}
impl Display {
    pub(super) fn passes_pending(&self) -> bool {
        let state = self.engine.lock();
        state.display.pass_revision != state.display.presented_pass_revision
            || state
                .display
                .surface
                .as_ref()
                .is_some_and(|surface| surface.pending())
    }
    /// Default 300×150, the browser canvas default.
    pub fn size(&self) -> [u32; 2] {
        self.engine.lock().display.size
    }
    /// Resizes the presentation texture; scale-based renders resize at their next refine.
    pub fn set_size(&self, width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            return Err(error(
                Status::InvalidArgument,
                "Display dimensions must be positive",
            ));
        }
        let mut state = self.engine.live()?;
        let max = self
            .engine
            .inner
            .gpu
            .device
            .limits()
            .max_texture_dimension_2d;
        if width > max || height > max {
            return Err(error(
                Status::InvalidArgument,
                "Display size exceeds device limits",
            ));
        }
        state.display.size = [width, height];
        if let Some(surface) = &mut state.display.surface {
            surface.resize([width, height]);
        }
        Ok(())
    }
    /// Current display settings.
    pub fn settings(&self) -> DisplaySettings {
        self.engine.lock().display.settings
    }
    /// Validates the settings and uses them from the next presentation or export,
    /// without restarting accumulation. Changing HDR output inside a display pass
    /// is rejected.
    pub fn set_settings(&self, settings: DisplaySettings) -> Result<()> {
        settings.validate()?;
        let mut state = self.engine.live()?;
        if state.display.processing
            && settings.hdr_output_enabled != state.display.settings.hdr_output_enabled
        {
            return Err(error(
                Status::InvalidState,
                "Cannot switch HDR mode during a display pass",
            ));
        }
        if let Some(surface) = &mut state.display.surface {
            surface.set_hdr(settings.hdr_output_enabled, &self.engine.inner.gpu)?;
        }
        if !settings.hdr_output_enabled {
            state.display.hdr_texture = None;
        }
        if state.display.settings.composition() != settings.composition() {
            super::render::invalidate_display_denoisers(&mut state);
        }
        state.display.settings = settings;
        Ok(())
    }
    /// The presentation texture: display-sized premultiplied RGBA8 (sRGB-encoded
    /// values in an `Rgba8Unorm` texture), top row first, with TEXTURE_BINDING and
    /// COPY_SRC usage. It is replaced when the display size changes and keeps the
    /// last presented image otherwise. `None` before the first present, after
    /// device loss or after disposal.
    pub fn texture(&self) -> Option<wgpu::Texture> {
        let state = self.engine.lock();
        if state.device_failed || state.disposed {
            None
        } else {
            state.display.texture.clone()
        }
    }
    /// Latest window HDR image: display-sized, premultiplied linear scRGB
    /// RGBA16Float. None until an HDR presentation, or after HDR is disabled,
    /// detach, device loss or disposal. Borrow only until the next present/resize;
    /// do not write, destroy or retain the image. Values above 1 are preserved.
    pub fn hdr_texture(&self) -> Option<wgpu::Texture> {
        let state = self.engine.lock();
        if state.device_failed
            || state.disposed
            || !state
                .display
                .surface
                .as_ref()
                .is_some_and(|s| s.hdr_active())
        {
            None
        } else {
            state.display.hdr_texture.clone()
        }
    }
    /// Composes and shows the render's complete image, or its fallback's. Smaller
    /// images are scaled linearly to the display size. Returns `None` and keeps the
    /// previous image when neither is ready, for example during scene preparation.
    /// An empty committed scene clears an attached window to transparent black.
    /// With a window attachment, also attempts window presentation. The return
    /// value describes the offscreen image; surface_info reports skipped/lost
    /// window frames. Does not trace. Window acquisition/configuration may block.
    pub fn present(&self, render: &Render) -> Result<Option<Presented>> {
        let result = self.present_inner(render);
        self.engine.flush();
        result
    }
    fn present_inner(&self, render: &Render) -> Result<Option<Presented>> {
        let Some(composed) = self.compose(render, true)? else {
            let mut state = self.engine.live()?;
            if state.scene.is_none() {
                state.display.present_empty(&self.engine.inner.gpu)?;
            }
            return Ok(None);
        };
        let hdr_active = self
            .engine
            .live()?
            .display
            .surface
            .as_ref()
            .is_some_and(|s| s.hdr_active());
        let hdr_composed = if hdr_active {
            let selected = Render::view(&self.engine, composed.id);
            self.compose_mode(&selected, false, true)?
        } else {
            None
        };
        let mut state = self.engine.live()?;
        let state = &mut *state;
        let gpu = &self.engine.inner.gpu;
        let size = state.display.size;
        if state
            .display
            .texture
            .as_ref()
            .is_none_or(|t| [t.width(), t.height()] != size)
        {
            state.display.texture = Some(gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("MuTracer display"),
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
            }));
        }
        let blit = state.display.blit.get_or_insert_with(|| Blit {
            straight: gpu
                .device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("MuTracer straight-alpha display scale"),
                    layout: None,
                    module: &gpu
                        .device
                        .create_shader_module(wgpu::ShaderModuleDescriptor {
                            label: None,
                            source: wgpu::ShaderSource::Wgsl(BLIT.into()),
                        }),
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &[("premultiply", 1.)],
                        ..Default::default()
                    },
                    cache: None,
                }),
            pipeline: gpu
                .device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("MuTracer display scale"),
                    layout: None,
                    module: &gpu
                        .device
                        .create_shader_module(wgpu::ShaderModuleDescriptor {
                            label: Some("MuTracer display scale"),
                            source: wgpu::ShaderSource::Wgsl(BLIT.into()),
                        }),
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                }),
            sampler: gpu.device.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
        });
        let target = state.display.texture.as_ref().unwrap();
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        if composed.premultiplied && [composed.texture.width(), composed.texture.height()] == size {
            encoder.copy_texture_to_texture(
                composed.texture.as_image_copy(),
                target.as_image_copy(),
                target.size(),
            );
        } else {
            let source = composed.texture.create_view(&Default::default());
            let pipeline = if composed.premultiplied {
                &blit.pipeline
            } else {
                &blit.straight
            };
            let output = target.create_view(&Default::default());
            let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&source),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&blit.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(&output),
                    },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(size[0].div_ceil(8), size[1].div_ceil(8), 1);
        }
        gpu.queue.submit([encoder.finish()]);
        state.display.presented_pass_revision = composed.pass_revision;
        state.display.presented_render = Some(composed.id);
        if let Some(hdr) = hdr_composed {
            if state
                .display
                .hdr_texture
                .as_ref()
                .is_none_or(|t| [t.width(), t.height()] != size)
            {
                state.display.hdr_texture = Some(crate::display::image(
                    &gpu.device,
                    size,
                    wgpu::TextureFormat::Rgba16Float,
                ));
            }
            let blit = state.display.hdr_blit.get_or_insert_with(|| {
                let shader = gpu
                    .device
                    .create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some("HDR alpha-aware scale"),
                        source: wgpu::ShaderSource::Wgsl(
                            BLIT.replace("rgba8unorm", "rgba16float").into(),
                        ),
                    });
                let pipeline =
                    gpu.device
                        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                            label: Some("HDR scale"),
                            layout: None,
                            module: &shader,
                            entry_point: Some("main"),
                            compilation_options: wgpu::PipelineCompilationOptions {
                                constants: &[("premultiply", 1.)],
                                ..Default::default()
                            },
                            cache: None,
                        });
                Blit {
                    straight: pipeline.clone(),
                    pipeline,
                    sampler: gpu.device.create_sampler(&wgpu::SamplerDescriptor {
                        mag_filter: wgpu::FilterMode::Linear,
                        min_filter: wgpu::FilterMode::Linear,
                        ..Default::default()
                    }),
                }
            });
            let target = state.display.hdr_texture.as_ref().unwrap();
            let input = hdr.texture.create_view(&Default::default());
            let output = target.create_view(&Default::default());
            let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &blit.pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&input),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&blit.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(&output),
                    },
                ],
            });
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&blit.pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(size[0].div_ceil(8), size[1].div_ceil(8), 1);
            }
            gpu.queue.submit([encoder.finish()]);
            if let Some(surface) = &mut state.display.surface {
                surface.present(gpu, target)?;
            }
        } else {
            state.display.hdr_texture = None;
            if let Some(surface) = &mut state.display.surface {
                surface.present(gpu, target)?;
            }
        }
        Ok(Some(composed.presented))
    }

    /// The render's complete image composed with these settings at its own size:
    /// straight-alpha RGBA8, top row first. Leaves the presentation texture unchanged.
    pub fn read_rgba8(&self, render: &Render) -> Result<(u32, u32, Vec<u8>)> {
        let result = (|| {
            let composed = self.compose(render, false)?.unwrap();
            let state = self.engine.live()?;
            if composed.settings.channel.aov_kind().is_some() {
                let rgba = crate::display::read_image(&self.engine.inner.gpu, &composed.texture)
                    .map_err(|e| error(Status::Error, e.to_string()))?;
                return Ok((composed.presented.width, composed.presented.height, rgba));
            }
            let capture = Self::complete(&state, composed.id)?;
            let rgba = if composed.premultiplied {
                capture.read_rgba(&composed.settings.composition())
            } else {
                capture.read_image(&composed.texture)
            }
            .map_err(|e| error(Status::Error, e.to_string()))?;
            Ok((capture.size[0], capture.size[1], rgba))
        })();
        self.engine.flush();
        result
    }
    /// [`Display::read_rgba8`] encoded as PNG.
    pub fn encode_png(&self, render: &Render) -> Result<Vec<u8>> {
        let (width, height, rgba) = self.read_rgba8(render)?;
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .and_then(|mut writer| writer.write_image_data(&rgba))
            .map_err(|e| error(Status::Error, format!("PNG encoding failed: {e}")))?;
        Ok(bytes)
    }
    pub(super) fn check(&self, render: &Render) -> Result<()> {
        if !std::sync::Arc::ptr_eq(&render.engine().inner, &self.engine.inner) {
            return Err(error(
                Status::InvalidArgument,
                "Render belongs to another engine",
            ));
        }
        Ok(())
    }
    fn complete(state: &State, id: u64) -> Result<&crate::display::Display> {
        if !state.renders.contains_key(&id) {
            return Err(error(Status::InvalidHandle, "Render is disposed"));
        }
        if !readiness(state, id).complete {
            return Err(error(Status::InvalidState, "Render has no complete image"));
        }
        Ok(state.renders[&id].capture.as_ref().unwrap())
    }
}
