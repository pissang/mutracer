//! Display-pass recording without holding the engine or context registry locks.
use super::display::{Display, DisplaySettings, Presented, Selection, select};
use super::engine::{Engine, Inner};
use super::render::{Render, display_readiness};
use super::{Result, Status, error};
use std::sync::{Arc, Mutex, Weak};

/// Borrowed GPU image to inspect. There is no default; select a kind explicitly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputKind {
    /// Resolved linear ray color and coverage before denoising/display composition.
    /// RGBA32Float, top row first; RGB uses hit normalization as on WebGPU.
    Hdr,
    /// Latest composition including display passes, at the final pass size
    /// (default the actual render size).
    /// RGBA8Unorm, sRGB-encoded straight alpha, top row first.
    Display,
}
/// Images and encoder borrowed for one synchronous display pass. Do not retain,
/// destroy or write the input. Record into `encoder`; the library submits it.
pub struct PostProcessContext<'a> {
    /// Engine device for creating pass resources.
    pub device: &'a wgpu::Device,
    /// Record commands here; the library finishes and submits this encoder.
    pub encoder: &'a mut wgpu::CommandEncoder,
    // Native passes split recording into ordered wgpu/raw command buffers. They
    // stay unsubmitted until the entire display chain succeeds.
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop")),
        allow(dead_code)
    )]
    pub(crate) commands: &'a mut Vec<wgpu::CommandBuffer>,
    /// Straight-alpha RGBA8Unorm for SDR registrations; linear RGBA16Float
    /// for add_hdr_post_process. Check input.format() when sharing pass code.
    pub input: &'a wgpu::Texture,
    /// Fully write this image. Same format as input; its size is the registration's
    /// output size (default the input size). Storage, render and copy writes supported.
    pub output: &'a wgpu::Texture,
    /// Actual selected render width, before display scaling.
    pub width: u32,
    /// Actual selected render height, before display scaling.
    pub height: u32,
    /// Selected complete render, including a selected fallback. May be inspected.
    pub render: &'a Render,
}
type Pass = Arc<Mutex<Box<dyn FnMut(PostProcessContext<'_>) -> Result<()> + Send>>>;
type OutputSize = Arc<dyn Fn([u32; 2], [u32; 2]) -> [u32; 2] + Send + Sync>;
pub(super) type Entry = (u64, Pass, Option<OutputSize>);

/// Registration options for [`Display::add_post_process_with`].
#[derive(Clone, Default)]
pub struct PostProcessOptions {
    /// Output `[width, height]` from the previous pass's output size and the
    /// current display size (also during export). Default `None` keeps the input
    /// size. Called on every composition; return positive dimensions within
    /// `max_texture_dimension_2d`, or the whole chain is discarded as when a
    /// pass fails. Use [`PostProcessOptions::display_size`] to output at display
    /// resolution.
    pub output_size: Option<OutputSize>,
}
impl PostProcessOptions {
    /// Outputs at the current display size, for upscalers.
    pub fn display_size() -> Self {
        Self {
            output_size: Some(Arc::new(|_, display| display)),
        }
    }
}
impl std::fmt::Debug for PostProcessOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostProcessOptions")
            .field("output_size", &self.output_size.is_some())
            .finish()
    }
}

/// Removes a display pass when dropped. Removal is idempotent and takes effect
/// on the next composition; the current chain uses its registration snapshot.
#[must_use = "dropping this handle removes the display pass"]
pub struct PostProcessSubscription {
    inner: Weak<Inner>,
    id: u64,
}
impl PostProcessSubscription {
    /// Removes the pass from the next composition. Repeated calls do nothing.
    pub fn remove(&self) {
        if let Some(inner) = self.inner.upgrade() {
            let engine = Engine { inner };
            let mut state = engine.lock();
            let display = &mut state.display;
            let count = display.passes.len() + display.hdr_passes.len();
            display.passes.retain(|(id, ..)| *id != self.id);
            display.hdr_passes.retain(|(id, ..)| *id != self.id);
            if display.passes.len() + display.hdr_passes.len() != count {
                display.pass_revision += 1;
            }
        }
    }
}
impl Drop for PostProcessSubscription {
    fn drop(&mut self) {
        self.remove();
    }
}
#[derive(Default)]
pub(super) struct OutputState {
    pub(super) epoch: u64,
    pub(super) latest: Option<(DisplaySettings, Option<wgpu::Texture>)>,
    // Per output size, the second image exists only when consecutive passes
    // of that size need to ping-pong.
    targets: Targets,
    hdr_targets: Targets,
}
type Targets = std::collections::HashMap<[u32; 2], [Option<wgpu::Texture>; 2]>;
impl OutputState {
    pub(super) fn invalidate(&mut self) {
        self.epoch += 1;
        self.latest = None;
    }
}
pub(super) struct Composed {
    pub(super) id: u64,
    pub(super) texture: wgpu::Texture,
    pub(super) premultiplied: bool,
    pub(super) settings: DisplaySettings,
    pub(super) presented: Presented,
    pub(super) pass_revision: u64,
}
struct Processing(Engine);
impl Drop for Processing {
    fn drop(&mut self) {
        self.0.lock().display.processing = false;
    }
}
impl Display {
    /// Registers a pass in order. Default no passes. Runs after composition,
    /// before scaling, on every present/export without tracing or restarting denoising.
    /// A returned error or callback panic discards all recorded passes, uses the
    /// original image and emits an engine error. Nested composition is rejected; render inspection
    /// and pass registration/removal are allowed. Changing the image during a pass
    /// rejects that composition. Keep the returned subscription until removal.
    /// Equivalent to [`Display::add_post_process_with`] with default options.
    pub fn add_post_process(
        &self,
        pass: impl FnMut(PostProcessContext<'_>) -> Result<()> + Send + 'static,
    ) -> Result<PostProcessSubscription> {
        self.add_post_process_with(PostProcessOptions::default(), pass)
    }
    /// [`Display::add_post_process`] with an output size. The presented image,
    /// [`Display::read_rgba8`], PNG export and the borrowed display output use the
    /// final chain size, which can differ from the render size.
    pub fn add_post_process_with(
        &self,
        options: PostProcessOptions,
        pass: impl FnMut(PostProcessContext<'_>) -> Result<()> + Send + 'static,
    ) -> Result<PostProcessSubscription> {
        let mut state = self.engine.live()?;
        let display = &mut state.display;
        let id = display.next_pass;
        display.next_pass += 1;
        display.passes.push((
            id,
            Arc::new(Mutex::new(Box::new(pass))),
            options.output_size,
        ));
        display.pass_revision += 1;
        Ok(PostProcessSubscription {
            inner: Arc::downgrade(&self.engine.inner),
            id,
        })
    }
    /// Registers a separate HDR-window pass. Input/output are straight-alpha
    /// linear scRGB RGBA16Float, including values above 1. Runs only for active
    /// HDR window presentation, after HDR composition and before scaling.
    /// Failure/reentry/removal follow add_post_process. SDR export and SDR passes
    /// remain independent. Keep the subscription until removal.
    pub fn add_hdr_post_process(
        &self,
        pass: impl FnMut(PostProcessContext<'_>) -> Result<()> + Send + 'static,
    ) -> Result<PostProcessSubscription> {
        self.add_hdr_post_process_with(PostProcessOptions::default(), pass)
    }
    /// [`Display::add_hdr_post_process`] with an output size, as in
    /// [`Display::add_post_process_with`].
    pub fn add_hdr_post_process_with(
        &self,
        options: PostProcessOptions,
        pass: impl FnMut(PostProcessContext<'_>) -> Result<()> + Send + 'static,
    ) -> Result<PostProcessSubscription> {
        let mut state = self.engine.live()?;
        let display = &mut state.display;
        let id = display.next_pass;
        display.next_pass += 1;
        display.hdr_passes.push((
            id,
            Arc::new(Mutex::new(Box::new(pass))),
            options.output_size,
        ));
        display.pass_revision += 1;
        Ok(PostProcessSubscription {
            inner: Arc::downgrade(&self.engine.inner),
            id,
        })
    }
    pub(super) fn compose(&self, render: &Render, fallback: bool) -> Result<Option<Composed>> {
        self.compose_mode(render, fallback, false)
    }
    pub(super) fn compose_mode(
        &self,
        render: &Render,
        fallback: bool,
        hdr: bool,
    ) -> Result<Option<Composed>> {
        self.check(render)?;
        let mut state = self.engine.live()?;
        if state.display.processing {
            return Err(error(
                Status::InvalidState,
                "Display composition is already running",
            ));
        }
        let id = render.id();
        let primary = state
            .renders
            .get(&id)
            .ok_or_else(|| error(Status::InvalidHandle, "Render is disposed"))?;
        let selected = if fallback {
            match select(
                state.display.settings.channel == super::Channel::Final,
                display_readiness(&state, id),
                primary.fallback.map(|f| display_readiness(&state, f)),
            ) {
                None => return Ok(None),
                Some(Selection::Render) => id,
                Some(Selection::Fallback) => primary.fallback.unwrap(),
            }
        } else {
            if !display_readiness(&state, id).complete {
                return Err(error(Status::InvalidState, "Render has no complete image"));
            }
            id
        };
        let settings = state.display.settings;
        let passes = if hdr {
            state.display.hdr_passes.clone()
        } else {
            state.display.passes.clone()
        };
        let pass_revision = state.display.pass_revision;
        let r = state.renders.get_mut(&selected).unwrap();
        let aov_kind = settings.channel.aov_kind();
        let samples = if aov_kind.is_some() {
            r.aov_samples_for_display()
        } else {
            r.presented_samples()
        };
        let size = if aov_kind.is_some() {
            r.published_size()
        } else {
            r.capture.as_ref().unwrap().size
        };
        let original = if let Some(kind) = aov_kind {
            match r.visualize_aov(kind, &settings.aov, hdr) {
                Ok(image) => image,
                Err(e)
                    if fallback
                        && e.status == Status::InvalidState
                        && r.settings.aovs & kind.aov_mask() != 0 =>
                {
                    return Ok(None);
                }
                Err(e) => return Err(e),
            }
        } else {
            let capture = r.capture.as_mut().unwrap();
            if hdr {
                capture.compose_hdr(&settings.composition())
            } else if passes.is_empty() {
                capture.compose_with(&settings.composition());
                capture.texture.clone()
            } else {
                capture.compose_straight(&settings.composition())
            }
        };
        let format = if hdr {
            wgpu::TextureFormat::Rgba16Float
        } else {
            wgpu::TextureFormat::Rgba8Unorm
        };
        let epoch = r.output.epoch;
        let display_size = state.display.size;
        let limit = self
            .engine
            .inner
            .gpu
            .device
            .limits()
            .max_texture_dimension_2d;
        state.display.processing = true;
        drop(state);
        let _processing = Processing(self.engine.clone());
        let gpu = &self.engine.inner.gpu;
        let mut image = original.clone();
        let mut failure = None;
        if !passes.is_empty() {
            // Evaluate the whole size chain before recording any pass.
            let mut current = size;
            let mut sizes = Vec::with_capacity(passes.len());
            for (_, _, output_size) in &passes {
                if let Some(output_size) = output_size {
                    let input = current;
                    current = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        output_size(input, display_size)
                    })) {
                        Ok(value) => value,
                        Err(_) => {
                            failure = Some("Display pass output size panicked".to_string());
                            break;
                        }
                    };
                    if current.iter().any(|v| *v == 0 || *v > limit) {
                        failure = Some(
                            "Post-process output dimensions must be positive and within max_texture_dimension_2d"
                                .to_string(),
                        );
                        break;
                    }
                }
                sizes.push(current);
            }
            let targets = if failure.is_none() {
                let mut state = self.engine.live()?;
                let r = state
                    .renders
                    .get_mut(&selected)
                    .ok_or_else(|| error(Status::InvalidHandle, "Render is disposed"))?;
                let cache = if hdr {
                    &mut r.output.hdr_targets
                } else {
                    &mut r.output.targets
                };
                cache.retain(|key, _| sizes.contains(key));
                let mut previous = original.clone();
                let mut outputs = Vec::with_capacity(sizes.len());
                for size in &sizes {
                    let pair = cache.entry(*size).or_default();
                    let index = usize::from(pair[0].as_ref() == Some(&previous));
                    let output = pair[index]
                        .get_or_insert_with(|| crate::display::image(&gpu.device, *size, format))
                        .clone();
                    previous = output.clone();
                    outputs.push(output);
                }
                outputs
            } else {
                Vec::new()
            };
            let view = Render::view(&self.engine, selected);
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            let mut commands = Vec::new();
            for ((_, pass, _), output) in passes.iter().zip(&targets) {
                let mut pass = pass.lock().unwrap_or_else(|e| e.into_inner());
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    pass(PostProcessContext {
                        device: &gpu.device,
                        encoder: &mut encoder,
                        commands: &mut commands,
                        input: &image,
                        output,
                        width: size[0],
                        height: size[1],
                        render: &view,
                    })
                }));
                failure = match outcome {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(e.message),
                    Err(_) => Some("Display pass panicked".into()),
                };
                if failure.is_some() {
                    break;
                }
                image = output.clone();
            }
            // API reentry may dispose, restart or refine the selected render.
            let state = self.engine.live()?;
            if !display_readiness(&state, selected).complete
                || state.renders[&selected].output.epoch != epoch
            {
                return Err(error(
                    Status::InvalidState,
                    "Render changed during a display pass",
                ));
            }
            drop(state);
            if failure.is_none() {
                commands.push(encoder.finish());
                gpu.queue.submit(commands);
            } else {
                image = original;
            }
        }
        let mut state = self.engine.live()?;
        let r = state
            .renders
            .get_mut(&selected)
            .ok_or_else(|| error(Status::InvalidHandle, "Render is disposed"))?;
        let premultiplied = !hdr && aov_kind.is_none() && (passes.is_empty() || failure.is_some());
        if failure.is_some() && !hdr && aov_kind.is_none() {
            // Keep native presentation bit-identical to the unfiltered path,
            // including premultiplication before RGBA8 quantization.
            let capture = r.capture.as_mut().unwrap();
            capture.compose_with(&settings.composition());
            image = capture.texture.clone();
        }
        if !hdr {
            r.output.latest = Some((settings, (!premultiplied).then(|| image.clone())));
        }
        if let Some(message) = failure {
            state.report(format!("Display post-process: {message}"));
        }
        Ok(Some(Composed {
            id: selected,
            texture: image,
            premultiplied,
            settings,
            pass_revision,
            presented: Presented {
                fallback: selected != id,
                width: size[0],
                height: size[1],
                samples,
            },
        }))
    }
}
