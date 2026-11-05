# Denoising

Denoising never changes a render's accumulation: raw HDR and guide readback keep
following the samples. Output can differ from the browser library's denoisers.

## Denoise a render

Set a built-in backend with `Render::set_denoiser` / `mt_render_set_denoiser`, or a
[custom filter](#custom-denoisers). The schedule (`DenoiseSchedule` /
`mt_denoise_schedule`) is Converged (default), Progressive or EverySample.

- `converge` denoises after its last sample and waits for the result.
- With Progressive and EverySample, sampling pauses while a filter runs and the
  last filtered image stays presented until the next one. Keeping it costs 48
  bytes per render pixel of GPU memory, plus 48 for shadow catcher scenes.
  oidn-webgpu also retains 16 bytes per pixel for HDR pixel readback.
- A host that stops refining (for example when paused) calls `denoise_current`
  to filter the current samples.
- Read the result with `PixelKind::Denoised` / `MT_IMAGE_DENOISED`.
  `mt_render_info` reports the denoised sample count, time, device and
  failures.

## oidn-webgpu

Select `DENOISE_OIDN_WEBGPU` in Rust or `MT_DENOISE_OIDN_WEBGPU` in C as the
backend of `set_denoiser`. It uses the rendering device and keeps inputs and
output on the GPU. Reading `Denoised` pixels still transfers that requested
image to the CPU.

```rust
render.set_denoiser(Some(DenoiserOptions {
    backend: DENOISE_OIDN_WEBGPU,
    max_tile_size: 512,
    ..Default::default()
}))?;
```

A standard model is bundled, so no weight download is needed. For custom weights,
use `DenoiserOptions::library` / `mt_render_denoiser.library` with an HDR/PU TZA
that takes color, albedo and normal. For the standard Large clean-aux model,
keep `rt_hdr_calb_cnrm_large.tza`, `rt_alb_large.tza` and `rt_nrm_large.tza`
together and select the first file. Its albedo and normal prefilters run before
beauty filtering; they use more GPU memory and time than Standard or Small.

Rust callers can lower `max_tile_size` to reduce temporary GPU memory at the
cost of overlapping work. The C render interface uses whole-image inference.
Preparing the first image or a new size can block; later frames reuse that
preparation.

Color is normalized like `MT_IMAGE_HDR`, guides are per-sample averages, and
color alpha passes through unchanged. The filter uses HDR/PU with input scale 1;
OIDN uses its automatic exposure by default, so the results can differ.
Matrix kernels require cooperative-matrix support; Windows requires Vulkan for
these kernels. DX12 and devices without that support use implicit GEMM.
A caller-owned device uses only the features enabled by its host.

After device loss, create a new engine.

## JNLM display filtering

Use `Render::set_jnlm_display_filter` / `mt_render_set_jnlm_display_filter`
with `JnlmOptions` / `mt_jnlm_options`. Disable an OIDN or custom denoiser
first to use JNLM alone. Presents and PNG exports filter the composed image,
including its color settings, effects and background. Changing these controls
recomputes the filter without tracing more samples.

HDR windows filter the extended-range composition without clamping radiance to
one. Completed display-linear OIDN results can also be presented on HDR windows;
this does not rerun OIDN on an HDR input or recover radiance from an SDR result.
Diagnostic channels show their original images without color denoising.
JNLM leaves raw HDR and `Denoised` readback unchanged. Its scratch images and
retained guide moments increase GPU memory use; HDR presentation retains another
8 bytes per pixel. Larger
search windows, patches and more passes cost more GPU work.

## Custom denoisers

Install a Rust `CustomDenoiser` with `Render::set_custom_denoiser`, or an
`mt_custom_denoiser` callback with `mt_render_set_custom_denoiser`. A custom
filter and a built-in backend replace each other. `DenoiseInput` /
`mt_denoise_input` and the callback types document inputs, outputs, ownership and
cancellation.

- Inputs are the raw per-sample color, bottom row first. They are not
  normalized by surface hits like `MT_IMAGE_HDR` readback.
- Each call copies its inputs on the GPU, 48 bytes per render pixel, so later
  rendering cannot overwrite them. Readback and the filter run on a library
  thread. Cancellation, clearing, replacement and destruction never wait for it,
  and late results are discarded, so calls can overlap.
- Rust filters that return `DenoiseInputMode::ResidentGpu` from `input_mode`
  receive the copies as GPU buffers and return a GPU result, with no CPU
  transfer; the result keeps 16 more bytes per pixel. See
  [custom-gpu-denoiser.rs](../host/examples/custom-gpu-denoiser.rs).
  `gpu_inputs` instead uploads the CPU arrays again. C callbacks receive CPU
  arrays.
- Request additional surface guides through `CustomDenoiser::aovs()` or
  `mt_custom_denoiser.aovs`. They are supplied even when not requested for direct
  render readback. `DenoiseInput::aovs`, `GpuDenoiseInput::aovs` and
  `mt_denoise_input.aov_data` specify their layouts. Each requested snapshot adds
  16 GPU bytes per render pixel, plus CPU memory for CPU callbacks.
- An error, invalid output or panic produces an engine error event and stops
  scheduled filtering until a filter is set again; `converge` returns an error.
  The unfiltered accumulation stays available.

## Surface outputs

Set `RenderSettings::aovs` / `mt_render_options.aovs` before sampling, then read
with `PixelKind` / `mt_image_kind`. `aov_samples` caps their independent sample
count; beauty stays unchanged. The declarations specify formats and validity.
Readback requires explicit enablement even if a custom filter requests the same
kind. Disabled AOVs allocate nothing. Enabling any kind adds about 128 GPU bytes
per pixel plus scene identity/history data; readback adds temporary GPU and CPU
copies. Reflectance quadrature costs considerably more than geometric guides.

`aov_resolution` / `mt_render_options.aov_resolution` traces AOVs at the display
size instead, at most 4 samples, as guides for the
[display upscale](display.md#display-upscale). It requires a scale-based render
and no custom denoiser AOV inputs, follows display resizes, and restarts AOV
accumulation when changed. Readback and visualization use the AOV size. A mask
of only depth and diffuse/specular reflectance costs 24 bytes per display pixel,
keeps no ID or motion history and reports the texture albedo of standard
opaque, nontransmissive surfaces in half precision.

Stable object/material IDs come from Scene handles, or the descriptor's optional
ID tables. Preserve these identities across publications when reprojecting;
reusing an ID for another object can associate the wrong history.

## Temporal GPU filters (Rust)

Return `DenoiseInputMode::TemporalGpu` from `CustomDenoiser::input_mode`. The
resident input then includes a separate `TemporalFrame`, independent of the
progressively averaged color and AOV snapshots. Use `guide`, `stable_ids`,
`pixel_records`, `metadata` and `reset_reasons` to feed your temporal filter,
then submit its output through `GpuDenoiseInput::submit`. This mode is available
only in the Rust GPU interface; C callbacks receive CPU images.

History advances only after a result is accepted for presentation. Failed,
cancelled or replaced results do not become previous frames. Check
`GpuDenoiseInput::status` if maintaining consumer history, and discard history
when the next frame reports a reset. Use `Render::reset_temporal_history` for an
application camera cut; it preserves beauty samples.

The producer currently requires a pinhole camera, one sample per input frame
and equal input/output dimensions. It supports camera and rigid-object motion;
vertex deformation invalidates correspondence. Capability fields identify
unverified optical and specular-distance inputs; this is not a complete DLSS-RR
or NRD integration. Guides use top-row-first textures; raw records and stable
IDs use bottom-row-first buffers.

Each retained frame uses about 432 GPU bytes per pixel plus scene metadata,
in addition to resident snapshots and output. The previous accepted frame and
in-flight consumers also retain resources. The 240-byte pixel-record binding
can limit resolution before the SDK's ordinary pixel limit; unsupported sizes
return an error according to device storage limits.

## Denoise your own images

[mutracer-denoise.h](../include/mutracer-denoise.h) runs OIDN on caller-owned
color, normal and albedo images, such as `mt_context_read_pixels` output,
independently of any render. Calls block; run them on a worker if needed.
[examples/denoise-host.c](../examples/denoise-host.c) is a complete program.

## OIDN runtime

The optional SDK backends require OIDN 2.5.1 and matching device modules,
separately from the native library. Pass a library path, set
`MUTRACER_OIDN_LIBRARY`, or ship the library beside the executable as described
in `mutracer-denoise.h`.

The Auto backend tries Metal, CUDA, HIP, then CPU; explicit backends never fall
back. GPU backends need supported hardware and drivers, and HIP also needs the
matching AMD HIP runtime; see
[OIDN's system requirements](https://github.com/RenderKit/oidn/blob/v2.5.1/README.md#system-requirements).
