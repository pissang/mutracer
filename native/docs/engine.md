# Engine API

Rust `mutracer_native_probe::api` and C
[mutracer-engine.h](../include/mutracer-engine.h) follow the browser library's
object model:

- **Engine**: the GPU device and the committed scene and camera.
- **Render**: an independent accumulation with its own size and settings.
- **Display**: tone mapping, presentation and image export; see
  [Display](display.md).
- **RenderLoop**: the interactive preview/final policy.

Options, defaults, errors and lifetimes are documented on each type and
function in the header and the Rust source.

## Render offline

1. Create an engine and a render.
2. Set the scene (`set_scene_object`, or `set_scene` with a
   [descriptor](scene-format.md)) and call `update`.
3. Call `converge` / `mt_render_converge`. It blocks until the samples
   complete, then runs the render's [denoiser](denoising.md) if one is set.
4. Read linear pixels with `read_pixels` / `mt_render_read_pixels`, or display
   RGBA8/PNG with `mt_display_read_pixels`.

The [quick start](../README.md#quick-start) shows the complete sequence.

## Select a GPU

C hosts enumerate with `mt_gpu_adapters` and pass the chosen index to
`mt_engine_create_on_adapter` or `mt_engine_create_for_window_on_adapter`.
Enumerate again after GPU hotplug; indices are local to the current machine and
adapter list. Creation fails if the selected device is unavailable or cannot
present to the window.

Rust hosts retain an adapter from `Engine::adapters` and use
`Engine::on_adapter`, or share their own wgpu device with `Engine::on_device`.
The existing engine constructors continue to select a device automatically.
C hosts can also [share a Vulkan device and queue](vulkan.md).

## Render interactively

Create an engine, set the scene and create a render loop. Each frame, call
`tick` / `mt_render_loop_tick` while `needs_tick` reports work. A tick runs
syncs, commits with `update`, selects the preview or final render, refines it
and presents it.

- The loop owns a final render and, by default, a lower-resolution preview
  (`RenderLoop::preview_settings`) that the final render presents as its
  fallback.
- Syncs (`add_sync` / `mt_render_loop_add_sync`) write the latest application
  state to the engine before each commit and report whether more changes are
  expected, for example during a drag.
- Enable `RenderSettings::batch_samples` (C `mt_render_options.batch_samples`)
  for GPU-timed stationary batches. Interaction uses one sample per submission.
  Without GPU timestamps, refinement keeps single-sample batches.
- Between display frames, a host may call `refill` / `mt_render_loop_refill`
  on GPU completion, on the tick thread. It advances final sampling without
  updating syncs or presenting. Call `cancel_refill` when pausing or hiding;
  each tick's refill window also expires automatically.
- Loop sample counts and sample events include final beauty samples only.
  Preview and auxiliary-output progress stay independent.
- Hosts that schedule renders themselves call `refine` and `Display::present`;
  `refine_with_options` can override batching for one call. `refine_until`
  (`mt_render_refine_until`) can fill the time between presentations; see its
  declaration for deadlines and cancellation.

## Updates

`set_scene_object`, `set_scene`, `set_camera` and `clear_scene` only record
inputs; `update` commits them once for all renders.

- Incremental edits ([which ones](scene.md#edit-a-scene)) finish during
  `update`.
- Full preparation runs on a library thread. Previous images stay readable and
  presentable, and renders report `Preparing` or `Compiling` until the new
  scene is published. A converge interrupted by a scene change returns an
  error.
- Each render uses its own size, bevel and dispersion settings, and the engine
  camera when one is set. Changing one render's options restarts only that
  render.
- After `clear_scene` and `update`, renders are `Idle` with no image, the loop
  stops requesting ticks, and an attached window shows transparent black.
  Render handles, options and denoisers stay usable for the next scene.

Render options default to the browser library's values; the
[context API](context.md) has different defaults.

## Costs

- Output size is bounded by the [scene limits](scene-format.md#limits) and the
  selected GPU. Accumulation needs about 96 bytes per pixel (about 760 MiB at
  3840×2160), before display, denoising, readback and scene resources. There is
  no offline tiled output yet; lower the size if the device cannot allocate it.
- The first use of a shader variant compiles a pipeline. Full scene compilation
  runs on the preparation thread; a variant needed by one render (another
  sampling pattern, bevel sample count or alpha blend strategy) compiles on the
  calling thread and blocks it. Up to 32 path-tracing variants are cached.
- `MT_ALPHA_BLEND_DETERMINISTIC_SOURCE_OVER` reduces coverage noise on primary
  rays at extra GPU cost.
- Depth queries (`read_depth_samples`, for example for autofocus) block for GPU
  readback; query on demand rather than every frame.
- `diagnostics` returns CPU-side counters without waiting for the GPU. Sample
  counts update only when refine, collect or converge collects a batch.

## Threads and callbacks

- Call an engine and its objects from any thread, one thread at a time. Only
  `mt_render_cancel` may run concurrently.
- [Window engines](display.md#window-presentation) must be used on their window
  thread.
- Event and progress callbacks run synchronously inside `update`,
  `read_depth_samples`, `refine`, `refine_until`, `converge` and render-loop calls. They may call
  the API, except the render loop that is running them.
- [Custom denoiser](denoising.md#custom-denoisers) callbacks run on library
  threads.

## Device loss

Device loss is terminal for an engine; dispose it and create a new one.

- Its renders and loops enter `Error`, and rendering, updates, presentation and
  readback return `Unavailable` / `MT_ERROR_UNAVAILABLE`.
- The next `update`, `refine`, `converge` or `tick` delivers one `DeviceLost`
  event and one `Error` event on the calling thread; `needs_tick` requests one
  final tick for them.
- A pending converge returns without waiting for running preparation or
  denoising, whose results are discarded.

Engines created by `Engine::new` or the C API receive the device notification
themselves. Rust hosts using `Engine::on_device` must forward their wgpu
device-loss callback to every engine sharing the device:

```rust
let loss = engine.device_loss_notifier();
device.set_device_lost_callback(move |reason, message| {
    loss.notify(format!("{reason:?}: {message}"));
    // Keep the application's other device-loss handling here.
});
```

## Differences from the browser library

| Native | Browser | Difference |
| --- | --- | --- |
| `converge` | `render.converge()` | Blocks the calling thread |
| `mt_render_loop_tick` | `RenderLoop.start()` | The host calls tick each frame |
| Adaptive resolution | `adaptiveResolution` | Evaluated when each batch completes, not one frame later |
| Denoising | OIDN, JNLM, custom | [Native filter workflows](denoising.md); offline variance-adaptive sampling is not available |
| Custom denoisers | `{type: 'custom'}` | Run on library threads with CPU arrays or resident GPU frames |
| `diagnostics` | `Engine.getDiagnostics()` | Backend-specific counters differ |
| Clear scene + update | `engine.scene = undefined; engine.update()` | Empty renders report Idle |
| `Compiling` and compilation events | `status === 'compiling'`, progress stage `shaders` | — |
| Window + Display | Canvas + Display | The host owns window events and thread affinity |
