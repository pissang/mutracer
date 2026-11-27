# Denoising

MuTracer has two built-in denoisers that use albedo and normal guides.

- **JNLM**: a built-in joint non-local means filter, on WebGPU and
  WebGL 2. It needs no weight download. WebGPU downloads the filter on first use,
  which can delay the first denoised result. JNLM filters the composed image.
- **OIDN**: [Intel Open Image Denoise](https://www.openimagedenoise.org/)
  networks, run through [`oidn-webgpu`](https://github.com/pissang/oidn-webgpu),
  WebGPU only. They take longer and need weights, but are cleaner at one or
  two samples per pixel, for example for denoising while the camera moves.
  The included models filter scene-linear HDR before exposure, tone mapping and
  bloom. This helps resolve glass detail and limits the spread of fireflies.
  Custom LDR weights filter the composed display-linear image.

```ts
const engine = new Engine({canvas});
const final = new Render(engine, {denoiser: {type: 'jnlm'}});
final.setDenoiser({type: 'oidn', model: 'standard'});
final.setDenoiser(null); // disable
```

`type` is required: use `jnlm`, `oidn`, or a [custom denoiser](#custom-denoisers).
`render.denoiser` returns a frozen copy of the configuration; call `setDenoiser`
again to change it. Unknown types,
foreign fields and invalid JNLM settings throw synchronously, preserving the
active filter and output. Equal built-in settings reuse the loaded network;
changing only `schedule` preserves active inference, and passing an identical
configuration does nothing.
Each render has its own configuration and scheduling. Converge waits for its
configured filter; intermediate progressive inference reports converging and
final inference reports denoising. Built-in networks and weights are shared
within an engine and released when no render uses them.

`setDenoiser` returns a promise that resolves when the filter is ready, which
for OIDN means its weights have loaded, and rejects when loading fails. A
configuration replaced before it finishes loading resolves without an error;
an identical configuration returns the current promise. Await it when you need
the filter before rendering:

```ts
try {
  await final.setDenoiser({type: 'oidn', model: 'standard'});
} catch (error) {
  final.setDenoiser({type: 'jnlm'}); // weights unavailable; fall back to JNLM
}
```

OIDN is loaded lazily. On WebGL its configuration warns, leaves this render
unfiltered and resolves; JNLM works on both backends. Loading failures of a
`denoiser` constructor option, and of reloads after device recovery, report
through engine error events, as do inference failures. Replaced/disposed
network prewarm results are discarded.

## Options

| `JNLMDenoiserOptions` | Description |
| --- | --- |
| `type` | Required: `'jnlm'` |
| `schedule` | `'converged'` (default), `'progressive'`, or `'every-sample'` |
| `strength` | JNLM filter strength. Default `1` |
| `searchRadius` | JNLM search radius, integer `1–16`. Default `5` (11 × 11 window) |
| `patchRadius` | JNLM color comparison patch radius, integer `0–3`. Default `1` (3 × 3 patch) |
| `albedoBandwidth` | JNLM relative albedo tolerance, `0.0001–10`. Default `0.4` |
| `normalBandwidth` | JNLM encoded normal tolerance, `0.0001–10`. Default `0.05` |
| `iterations` | JNLM filter passes, integer `1–4`. Default `2` |

| `OIDNDenoiserOptions` | Description |
| --- | --- |
| `type` | Required: `'oidn'` |
| `model` | OIDN network: `'standard'` (default), `'small'` or `'cleanAuxLarge'` |
| `weightsBaseUrl` | Directory containing the OIDN `.tza` files |
| `schedule` | `'converged'` (default), `'progressive'`, or `'every-sample'` |
| `maxTileSize` | Maximum output tile edge in pixels; default `512` |
| `signal` | `AbortSignal` for the OIDN weight download; default undefined |
| `weightsUrl` | Explicit custom network; mutually exclusive with model/base directory |
| `aux`, `hdr`, `hdrTransfer` | Custom network metadata only; defaults true, true, `'pu'` |
| `auxiliaryModelUrls` | Both prefilter URLs; defaults to packaged cleanAuxLarge filters, otherwise none |
| `engine`, `precision`, `dynamicTile` | Defaults `'auto'`, `'auto'`, true; see custom networks below |

For WebGPU animation sequences, use [temporal denoising](./temporal-denoising.md).

## OIDN models

| `model` | Weights | Use |
| --- | --- | --- |
| `'standard'` (default) | `rt_hdr_alb_nrm.tza` (1.8 MB) | Balanced quality and speed; bundled with mutracer |
| `'small'` | `rt_hdr_alb_nrm_small.tza` (0.6 MB) | Fastest; previews while converging; bundled with mutracer |
| `'cleanAuxLarge'` | `rt_hdr_calb_cnrm_large.tza` + `rt_alb_large.tza` + `rt_nrm_large.tza` (22 MB) | Highest quality; prefilters guides; from oidn-weights@2.3.0-1 |

## Hosting the weights

Standard and small load from your application's own build assets by default.
Vite and webpack 5 copy the package's static weight URLs into the output.
In Vite development add `optimizeDeps: { exclude: ['@meimu/mutracer'] }` to avoid
prebundling asset URLs; otherwise MuTracer warns once and falls back to
jsDelivr's copy for the installed MuTracer version. The standalone `dist/`
library bundles use that CDN copy directly.

The large beauty network and auxiliary prefilters default to
`https://cdn.jsdelivr.net/npm/oidn-weights@2.3.0-1/`. To self-host all networks,
install `oidn-weights@2.3.0-1` and copy `node_modules/oidn-weights/*.tza` to a
static directory. If you only use standard/small, copying the two files from
`node_modules/@meimu/mutracer/oidn/weights/` is sufficient:

```ts
final.setDenoiser({type: 'oidn', weightsBaseUrl: '/assets/oidn/weights/'});
```

Explicit URLs never fall back to the CDN. Every download is checked for the
TZA file signature. The weights use Apache-2.0 (`oidn/weights/LICENSE.txt`).

## Scheduling

```ts
final.setDenoiser({type: 'oidn', model: 'standard', schedule: 'progressive'});
preview.setDenoiser({type: 'oidn', model: 'small', schedule: 'every-sample'});
```

Converged filters the final sample budget. Progressive filters sample 1,
then the first count that is at least double the previous update (and at
least 4) and comes 500 ms or more after it, and finally the sample budget.
Updates come at least every ten seconds. With [sample batching](./progressive-rendering.md#sample-batching),
counts grow faster, so the 500 ms floor skips intermediate doublings.
Every-sample filters every complete sample of its render. Coalescing
continuous scene/camera edits is application loop policy; the engine accepts
edits only when update is called. See [progressive rendering](./progressive-rendering.md).

## Tuning JNLM

`strength` (default `1`) scales the color tolerance. Higher values remove
more noise at low sample counts and more detail at high ones.

```ts
final.setDenoiser({type: 'jnlm', strength: 1.5});    // filter more
```

JNLM settings are available through `DenoiserOptions`. Omitted settings use
the exported `DEFAULT_JNLM_OPTIONS`; `JNLMOptions` is the corresponding type.
`setDenoiser` applies a fresh configuration to the existing sample
accumulation, so include the settings you want to retain on each call.

```ts
import { DEFAULT_JNLM_OPTIONS } from '@meimu/mutracer';

final.setDenoiser({
  type: 'jnlm',
  ...DEFAULT_JNLM_OPTIONS,
  strength: 1.2,
  searchRadius: 7,
  albedoBandwidth: 0.3
});
```

Larger search windows cost more but find more matching neighbors. Smaller
patches preserve small color details. Lower albedo and normal tolerances
reject more neighbors, protecting detail while retaining more noise. Extra
passes remove broader noise patches and can soften detail. Invalid parameters
reject before replacing the active filter. These settings work on both WebGPU
and WebGL 2; OIDN rejects JNLM fields.

## Custom OIDN networks

Load an explicit network file through the same built-in OIDN path:

```ts
final.setDenoiser({
  type: 'oidn', weightsUrl: '/assets/custom.tza',
  aux: true, hdr: true, hdrTransfer: 'pu',
  engine: 'wgsl', precision: 'auto', dynamicTile: true
});
```

`weightsUrl` is mutually exclusive with `model` and `weightsBaseUrl`. The
custom network metadata defaults to `aux: true`, `hdr: true`,
`hdrTransfer: 'pu'`; those fields require `weightsUrl`. Explicit downloads
never fall back to a CDN. `auxiliaryModelUrls: {albedo, normal}` optionally
loads prefilters for either source; cleanAuxLarge supplies its packaged filters
by default. Override both auxiliary URLs together.

Execution settings are available for every OIDN configuration. `engine`
defaults to `'auto'`; `'wgsl'` selects native GPU inference and `'webnn'` the
experimental WebNN path. `precision` defaults to `'auto'` (FP16 when
shader-f16 is available), with `'fp32'` and `'fp16'` overrides. `dynamicTile`
defaults to `true`; use `false` for fixed tiles or an object with
`minTileSize` (256), `initialTileSize` (432), `targetTileTimeMs` (16) and
`adjustmentStep` (16).

All implementation settings participate in the network cache key; `schedule`
and download `signal` do not. Renders with different signals share a pending
load; its initial request's signal controls that download. Loading failures
reject the returned promise and can be retried by calling `setDenoiser(null)`
and then the configuration again. Nested tile/URL settings are copied and frozen too.

## OIDN on GPU buffers

Use the filter with images you already have on the engine's WebGPU device.

```ts
import {createOIDNFilter} from '@meimu/mutracer/oidn';

const filter = await createOIDNFilter(engine, {model: 'cleanAuxLarge'});
try {
  await filter.denoise({width, height, color, albedo, normal, output}, {signal});
} finally {
  filter.dispose();
}
```

Choose the same [model, weights and execution options](#custom-oidn-networks)
as for built-in OIDN. The default model is `standard`. Use `dynamicTile: false`
for fixed tiles. For a color-only custom network, set `aux: false` and omit both
guides. All other models require both guides.

Buffers use the [custom denoiser layout](#custom-denoisers). Use linear RGB
with HDR networks, linear albedo and encoded world-space normals. This filter
preserves the supplied color space. Use the output's RGB and retain coverage
separately.

Inside a custom denoiser pass the callback's own `context.signal` to `denoise`
so the call runs within the active filter. Omitting it or passing a derived
signal such as `AbortSignal.any([...])` queues the call behind the callback that
awaits it, which stops all denoising on the engine; the filter warns after five
seconds. Calls on one engine run serially. Keep the
buffers alive until the promise settles and discard the output if the signal
aborts. After device recovery, recreate the buffers on the new device and
reuse the filter. Creating a filter on WebGL rejects.

## Custom denoisers

Provide a caller-owned `Denoiser` on WebGPU. Built-in JNLM and OIDN retain
their specialized paths. This identity filter illustrates the buffer contract:

```ts
import type {Denoiser} from '@meimu/mutracer';

const copy: Denoiser = {
  async denoise({device, width, height, color, output}, {signal}) {
    if (signal.aborted) return;
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(color, 0, output, 0, width * height * 16);
    device.queue.submit([encoder.finish()]);
  }
};
final.setDenoiser({
  type: 'custom', denoiser: copy, schedule: 'converged',
  aovs: ['depth', 'motion']
});
```

The required `type` and `denoiser` choose this branch; `schedule` defaults to
`converged`. Optional `prepare({device, width, height})` runs before the first
inference and whenever the instance's last prepared device or dimensions
change. It can preallocate resources. A shared instance switching between
render sizes is prepared again. `DenoiseInput` contains these buffers:

| Buffer | Data |
| --- | --- |
| `color` | Native resolved linear HDR ray color; before exposure, grading, tone mapping, vignette, bloom and display background/catcher composition |
| `albedo` | Linear RGB albedo averaged over complete samples; alpha is primary-hit coverage |
| `normal` | Resolved world-space normal averaged and encoded as `normal*.5+.5`, without renormalization; alpha 1 for valid surface data, otherwise zero RGBA |
| `output` | Write all linear HDR RGB; output alpha is ignored and the input path coverage is preserved |
| `aovs` | Optional map of the requested surface-output buffers, such as `input.aovs?.depth`; absent by default |

Color, albedo, normal and output are tightly packed RGBA float32, top row first,
exactly `width * height * 16` bytes, with STORAGE, COPY_SRC and COPY_DST usages.
Dimensions describe the actual internal image (WebGPU rounds up to 16).
`CustomDenoiserOptions.aovs` defaults to `[]`. Requests enable the corresponding
passes automatically; `render.aovs` is needed only for direct pixel readback.
Each AOV buffer is top row first, exactly `width * height * 16` bytes: `id` is
RGBA uint32 and the others RGBA float32. Values, validity and sampling limits
follow [surface outputs](./api.md#surface-outputs). These are immutable snapshots
of this invocation and cost 16 additional GPU bytes per pixel per requested kind.

Input buffers are read-only. Buffers are borrowed until the promise settles;
do not retain or destroy them. Resolve after submitting every output write.

Custom `readPixels('denoised')` returns the filtered native HDR ray color,
with input path coverage. Display settings then follow the ordinary compose
path: flat backgrounds retain their display-space treatment and catcher
layers are combined after tone mapping. An identity filter preserves the
unfiltered display, including bloom and partially transparent catchers.

The resolved ray color uses native hit-count normalization; fully blank
pixels use sample-count normalization. Flat primary misses can contribute
background radiance, but this buffer has not yet undergone display background
or catcher composition. `readPixels('hdr')` separately restores a per-sample
average for mixed flat-background pixels, so do not assume it equals the
custom input at those edges.

Render and Engine never dispose the supplied instance. Its object identity
selects it; identical assignment and schedule-only edits preserve running
inference. One engine serializes preparation and denoising across all renders,
so an instance can share resources between them. Sharing across separate
engines needs caller-managed coordination.

The context signal aborts on committed input changes, restart, replacement,
Render/Engine disposal or cancellation of convergence. Results resolving after
abort are discarded. The queue still waits for that promise to settle before
lending shared buffers again, so respond promptly to abort. Current preparation
and inference failures report through `engine.on('error', ...)`; stale jobs do
not report obsolete failures. WebGL warns once per render and leaves it
unfiltered.

A recovered engine may provide a new `input.device`. Rebuild device-owned
resources when it changes; `prepare` is called again. Dispose caller-owned
resources yourself after outstanding work has settled.

## Implementation notes

### Custom HDR layers

Custom filters operate on the resolved beauty RGB. With a shadow catcher, the
filtered correction is carried over to the foreground and background layers;
coverage and shadow masks are not filtered.

### How JNLM works

The weights follow Rousselle, Manzi and Zwicker, *Robust Denoising using
Feature and Color Information* (2013). Each pixel starts with a weighted mean of
its 11 × 11 neighborhood. A neighbor's weight is the smaller of:

- a color weight: the distance between the two pixels' 3 × 3 patches,
  normalized by their estimated variance, so differences explained by noise
  are ignored;
- a feature weight: the albedo, coverage and normal differences, which keep
  texture and geometric edges.

Albedo differences are measured relative to each channel's local brightness,
with a small floor near black. This protects low-contrast dark textures as
well as brighter ones. Coverage and encoded normals use absolute differences.

The mean is corrected by a local linear fit between each RGB channel and its
albedo channel, using the same weights. This preserves subtle texture while
averaging lighting noise. A small regularizer stabilizes nearly constant
guides, and the fitted response is bounded between zero and multiplicative
albedo modulation. Constant albedo keeps the weighted mean; unrelated albedo
does not automatically get transferred into the image. Alpha and the
luminance matching guide retain their weighted-mean estimates.

A second pass filters the result again with every other pixel (à-trous),
which removes the blotches a single pass leaves at the scale of its window.

The variance comes from per-pixel luminance moments that the path tracer
accumulates alongside the color. Weights are computed in linear radiance and
applied to the composed image, including its alpha, so shadow catchers and
transparent backgrounds are filtered too. Pixels that show the background
directly are left as rendered.

While-converging intermediate denoise batches report `'converging'`. Only denoising the final image at `maxSamples` reports `'denoising'`; `'finished'` means that final image is ready.
