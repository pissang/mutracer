# GPU output and display passes

After a render has a complete sample, borrow its WebGPU textures with
`render.getOutputTexture('hdr')` or `render.getOutputTexture('display')`.
To add an overlay or another display effect, register a synchronous pass:

```ts
const remove = engine.display.addPostProcess(ctx => {
  // Record a render or compute pass on ctx.encoder.
  // Read ctx.input and fully write ctx.output, including alpha.
  // Use ctx.output.format when creating the pipeline.
  drawOverlay(ctx);
});
engine.display.present(final);
const png = await engine.display.toBlob(final);
remove(); // Safe to call again.
```

Passes run in registration order on every `present()` and `toBlob()`, after
composition and denoising. They receive the selected complete render, including
fallbacks, at its actual dimensions. Export uses the same chain without changing
the display canvas; fixed-size renders are cropped to their requested size before
entering the chain. `readPixels()` never runs these passes.

For a complete overlay implementation, see
[`createCrosshairPass`](../examples/shared/crosshairPass.ts). It loads the input
with `textureLoad`, draws a white crosshair in display space and writes every
output pixel. The [basic example](../examples/basic.ts) enables it with `?overlay`:

```ts
import { createCrosshairPass } from './shared/crosshairPass';
const removeCrosshair = engine.display.addPostProcess(createCrosshairPass());
```

A changing overlay can read application state in its callback. `RenderLoop`
stops presenting after convergence, so explicitly call `display.present(final)`
when that state changes. This refreshes the overlay without tracing more samples.

For edge-adaptive enlargement without sharpening:

```ts
import {createEasuPass} from '@meimu/mutracer';
const pass = createEasuPass();
const removeUpscale = engine.display.addPostProcess(pass, {
  outputSize: (_, display) => display
});
```

Register the upscale before overlays that should stay at canvas resolution. An
input that already has the output size is copied unchanged and a larger one is
area-averaged, so one registration can serve a full-resolution or supersampled
final render and a reduced-resolution preview.

To recover texture detail, enable `diffuseColor`, `specularColor` and `depth`
on a scale-based render with `aovResolution: 'display'`, and create the pass with
`createEasuPass({albedoDetail: true})`. Keep beauty at the desired reduced
`resolutionScale`. Unregister the pass, then call `pass.dispose()` when finished
to release its scratch images.

EASU works on display-encoded RGB after tone mapping, including extended-range
output, and preserves alpha. EASU alone cannot recover missing texture detail.
Albedo compensation recovers supported surface texture detail but cannot recover
reflection, refraction or geometric detail. It maps the displayed image back
through the display transform, estimates locally how much radiance follows albedo,
and changes only that part, so specular highlights mostly keep their brightness.
Clipped highlights cannot be recovered. Transmission, cutouts, background, low
coverage and depth boundaries receive EASU alone. With detail, a present costs about
2.6 ms at 6 MP on an Apple M4 Max, compared with about 0.5 ms for EASU alone.

## Options and image semantics

`getOutputTexture(kind)` requires `'hdr'` or `'display'`; both return undefined
on WebGL, before a complete sample or after disposal. There are no passes by
default. `addPostProcess(pass)` returns an idempotent unregister function.
`PostProcess`, `PostProcessContext` and `PostProcessOptions` are exported types.

Use `addPostProcess(pass, {outputSize: (input, display) => display})` to output
at canvas resolution. The default preserves the input dimensions. Each callback
receives the previous pass's dimensions and the current canvas dimensions, also
for `toBlob()`. A chain can change size more than once. Return positive integer
width and height within `device.limits.maxTextureDimension2D`; invalid dimensions
discard the whole chain and emit an engine error, as callback exceptions do.

`ctx.width` and `ctx.height` remain the actual render dimensions. Read
`ctx.input.width/height` and `ctx.output.width/height` for the pass dimensions.
`toBlob()` exports the final chain dimensions; `getOutputTexture('display')`
borrows that actual-sized image, which may differ from the render size.

| Image | Meaning |
| --- | --- |
| HDR | Native resolved linear ray RGB, before denoising, exposure, grading, tone mapping, vignette, bloom or display background/catcher composition. Same normalization and raw path-coverage alpha as `DenoiseInput.color` |
| Display | Latest composed display channel, including denoising and the display pass chain; encoded display RGB and straight alpha (diagnostic channels retain their native values) |

Images have their first row at the top. HDR currently uses `rgba16float`;
ordinary display uses `rgba8unorm`, extended-range output uses `rgba16float`,
and diagnostic channels may use their native format. Inspect `texture.format`
and dimensions rather than assuming a format. Extended-range display RGB is
still encoded for presentation; it is not the original HDR ray color.

HDR RGB divides by primary hits when there are hits, otherwise by sample count.
For an opaque flat background, `readPixels('hdr')` additionally multiplies RGB
by primary-hit coverage for partially hit pixels, restoring the per-sample
average. Thus that CPU readback can differ from the borrowed native HDR texture.
See [custom denoiser image semantics](./denoising.md#custom-denoisers).

`createEasuPass()` defaults to EASU alone. `albedoDetail` defaults to `false`.
When the displayed render lacks those AOVs or display resolution, the pass warns
once and upscales without detail; frames whose AOVs are not ready yet or differ
from the output size also use EASU alone. The optional AOVs add tracing and
memory cost; see [surface outputs](./api.md#surface-outputs).

`render.getAovTexture(kind)` borrows enabled `diffuseColor`, `specularColor` or
`depth` outputs after an AOV sample completes, only on WebGPU. Colors use
`rgba8unorm-srgb`, which loads as linear values in [0, 1], with valid coverage in
alpha; depth uses `rg32float`, with
camera-forward depth in red and hit coverage in green. These raw textures follow
the same borrowing lifetime as `getOutputTexture()` and have the AOV dimensions.
Each is resolved from the accumulation when its samples change, and the first
call for a kind also creates its pipeline.

## Caveats

Textures are borrowed and read-only. Do not retain, write or destroy returned
textures. Their validity ends at the render's next `refine()`/`converge()`, or
the display's next `present()`/`setSize()`; restart, disposal and device loss
also invalidate them. Fully transparent PNG pixels have no preserved RGB
value after the browser canvas encoding/decoding round trip. Submit your reads before that boundary. Callback images
and encoder are borrowed only during the synchronous callback; record all work
there and let MuTracer finish and submit the encoder. Do not submit separate
work, mutate input or retain the output. Device recovery may replace the device,
so cache pipelines by both device and output format.

The output supports `RENDER_ATTACHMENT`, `STORAGE_BINDING`, `TEXTURE_BINDING`
and copy usage. Each pass must fully write it; previous contents are unspecified.
The input and output never alias. WebGL skips all registered passes and warns
once per display. A synchronous callback exception skips the remaining passes,
discards the chain's recorded commands, displays the original composed image
and emits the engine `error` event. GPU validation errors remain WebGPU errors;
the callback must record valid commands.

