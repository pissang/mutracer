# API reference

Exports come from `@meimu/mutracer`; declarations carry TSDoc and defaults.
See [progressive rendering](./progressive-rendering.md) for complete examples.

## Engine

`new Engine({canvas?, backend?, device?, textureBinding?})` manages the device and one GPU
scene. `scene` and `camera` default to undefined. Assign them and call
`update()` to commit edits before rendering; see [updates](./updates.md).

| Setting | Default | Meaning |
| --- | --- | --- |
| `canvas` | new HTML canvas, or OffscreenCanvas without document | Accepts either canvas type; default `engine.display.canvas` |
| `device` | undefined | Caller-owned WebGPU device; see [requirements](#device-requirements) |
| `backend` | `'auto'` | Automatic WebGPU/WebGL selection; `'webgpu'` requires WebGPU; `'webgl'` forces WebGL 2 |
| `textureBinding` | `'atlas'` | Constructor-only; `'auto'` tries experimental WebGPU bindless textures, with atlas fallback; see [texture bindings](#texture-bindings) |
| `bvhBuilder` | `'builtin'` | JavaScript or `'tinybvh'` WebAssembly |
| `bvhWorkerCount` | `'auto'` | Hardware concurrency minus one, clamped 1–4; or positive integer |
| `bvhLayout` | `'bvh2'` | Static TinyBVH layout; see [BVH](./bvh.md) |
| `bvhSpatialSplits` | `false` | TinyBVH spatial splits |
| `textureAtlasBudgetBytes` | 384 MiB | Material texture budget |

| Method / property | Meaning |
| --- | --- |
| `update(): boolean` | Sole scene/camera edit detection point; returns whether inputs changed |
| `prepare(scene, {onProgress?, signal?})` | Optional CPU preparation for a future scene; options default undefined |
| `init()` / `info` | Shared initialization promise and `EngineInfo`; info initially undefined |
| `setDevice(device)` | Replace a caller-owned device; see [device loss](#device-loss) |
| `backend` / `device` | Actual backend; device undefined before init and on WebGL |
| `lastError` | Most recent synchronous engine/render error; initially undefined |
| `getDiagnostics()` | Device, scene, compilation, timing, resident-target diagnostics; available after init or CPU preparation |
| `readDepthSamples(area)` | Depth query using the committed engine camera; see [depth sampling](#depth-sampling) |
| `on(name, listener)` | Subscribe; returns unsubscribe |
| `dispose()` | Release renders, GPU resources, Workers and owned denoisers |

`init()` is optional: `update()` and `refine()` initialize lazily. Concurrent
calls share a promise. `EngineInfo` includes backend, adapterName, optional
webgpuFallbackReason and limits for texture layers/dimensions.
Events are `progress` (`{stage: 'device' | 'bvh' | 'shaders', progress}`),
`error` (`Error`), and `devicelost` (`{reason, recovering}`). Each error object
is reported once; console errors are deduplicated by message. Invalid light
values are clamped and reported while rendering continues.

### Texture bindings

Use `new Engine({textureBinding: 'auto'})` to try bindless material textures
on WebGPU. The default `'atlas'` uses the existing texture atlas. This option
is fixed at construction. Check `engine.getDiagnostics()?.materialTextures`
for the active mode, fallback reason, scale and estimated texture bytes.

Bindless requires a resource-table feature enabled on the device and sufficient
device limits. Chrome currently exposes an experimental implementation behind
Unsafe WebGPU Support. Devices without it, including WebGL 2, use atlas textures.
Caller-owned devices must enable `sampling-resource-table` or
`chromium-experimental-sampling-resource-table` when available;
`getRecommendedDeviceDescriptor()` does not request these experimental features.

`textureAtlasBudgetBytes` applies to both modes. Bindless keeps independent
textures and scales them together to fit the estimated pixel budget, preserving
the current LOD 0 filtering and color rules. GPU allocation overhead, resource
tables and metadata add memory beyond that estimate. Replacing textures can
temporarily retain the previous GPU resources. Benefits depend on scene texture
sizes and editing patterns; bindless does not guarantee faster rendering.
See [texture updates](./updates.md#materials-textures-and-lights).

### Device requirements

`EngineParams.device` defaults to undefined (the library's shared device). A
supplied device implies WebGPU, even with `backend: 'auto'`, and cannot be
combined with `backend: 'webgl'`. `init()` rejects unsupported limits through
`lastError` and the `error` event, listing each required and actual value. The
device is caller-owned; `dispose()` does not destroy it or share it with other
engines implicitly. Adapter name uses `device.adapterInfo` when available,
otherwise `WebGPU`.

`getRecommendedDeviceDescriptor(adapter)` requests supported optional features
and the adapter limits used by the default engine path. Core rendering needs
no optional features: timestamp-query falls back to wall-clock timing; core
shaders use f32 and manual float texture filtering. shader-f16 and subgroups
are OIDN optimizations; its automatic precision falls back to FP32 and its
non-subgroup kernels remain available. Texture-format tier features and
bgra8unorm-storage are not prerequisites for the core render-attachment path.
Explicit OIDN FP16 or WebNN options can require shader-f16.

The core floor is 8 storage buffers, 8 sampled textures, 1 storage texture,
4 bind groups, workgroup X 64 / Y 16 / 256 invocations, and 12288 bytes for
buffer size and storage-buffer binding size (one aligned 16×16 target block).
Core kernels need 0 bytes of workgroup shared memory. Actual scene, image and
texture sizes impose larger buffer and texture limits. OIDN shares this same
device and can require more buffer capacity and workgroup shared memory for
its convolution tiles; the recommended descriptor requests adapter maxima.
Use smaller OIDN tiles or automatic precision when appropriate; network
initialization reports incompatible configurations.

### Device loss

`engine.on('devicelost', ({reason, recovering}) => ...)` reports loss, including
an externally destroyed shared device. Shared devices recover on the next
`update()` or `refine()`; renders report `preparing`, discard their samples,
and upload the committed scene again. CPU BVHs, decoded textures and downloaded
OIDN weights remain cached. Device-bound networks reload. Multiple engines
share the new device. Active `converge()` rejects with a device-loss error.
RenderLoop keeps ticking during recovery.

For caller-owned devices, `recovering` is false, renders report `error`, and
`lastError` explains the loss. Call `await engine.setDevice(replacement)` and
then `engine.update()` to resume. It uses the same limit validation as init;
only engines originally constructed with `device` accept setDevice. The
replacement is also caller-owned. Custom denoisers detect changes in
`input.device` / `prepare({device})` and rebuild their own resources.

WebGL context loss also reports `devicelost` with reason `webglcontextlost` and
`recovering: true`. Rendering waits in `preparing` until the browser dispatches
`webglcontextrestored`, then rebuilds resources and restarts all renders.

## Render

`new Render(engine, options?)` creates one independent accumulation. All renders
use the engine's committed scene/camera. Options are mutable except fixed
constructor dimensions. Image-quality changes restart only this render;
budget and display changes retain samples. Batch assignments use
`Object.assign(render, settings)` with `RenderSettings`, or constructor options.
`maxSamples` changes restart accumulation only with `samplingPattern: 'zsobol'`;
other sequences retain their completed samples.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxSamples` | `2048` | Complete sample budget |
| `aovs` / `aovSamples` | `[]` / `16` | Optional [surface outputs](#surface-outputs) / independent positive integer sample cap |
| `bounces` / `clamping` | `3` / `0` | Scattering depth / per-sample radiance clamp; 0 disables clamping |
| `samplingPattern` | `'sobol'` | Sobol, ZSobol or random; see [sampling](./sampling.md) |
| `caustics` | `undefined` | Optional caustics; all estimators default to off. See [caustics](#caustics) |
| `directLightCandidates` | `4` | WebGPU light candidates, clamped 1–16; ignored on WebGL |
| `bevel` / `bevelSamples` | `true` / `8` | Bevel shading / probes, clamped 1–32 |
| `dispersionWavelengths` | `3` | 3 wavelengths, or one randomly chosen wavelength |
| `alphaBlendStrategy` | `'stochastic'` | WebGPU primary BLEND policy; ignored on WebGL |
| `transmissiveOutputAlphaMin` | `1` | Path-depth alpha rule over transparent backgrounds; changes restart this render |
| `resolutionScale` | `1` | Relative to display canvas; exclusive with fixed width/height |
| `width` / `height` | undefined | Paired fixed constructor dimensions; getters report actual output dimensions |
| `adaptiveResolution` | `false` | `{targetFrameMs, minScale}` for scale-based renders; both required, positive, minScale ≤ resolutionScale |
| `timeBudgetMs` / `maxTiles` | `21` / `Infinity` | Target tile time / maximum tile grid size per sample (rounded up to a rectangular grid); fewer tiles make larger tiles, without limiting work per frame or call |
| `batchSamples` | `false` | Let one refine submit several samples within an estimated timeBudgetMs; one sample or tile can exceed it; see [sample batching](./progressive-rendering.md#sample-batching). `allowMultipleSamplesPerFrame` is a deprecated alias |
| `fallback` | `null` | Single-level Render on the same engine |
| `denoiser` | `null` | Per-render configuration; read back through the frozen `denoiser` getter and change with `setDenoiser()`; see [denoising](./denoising.md) |

`bounces` is rounded and clamped to [1, 20] in both backends; NaN becomes 1.
Paths allow at most `min(bounces * 3, 20)` events, including transmission,
alpha skips and escape checks. Opaque paths also terminate at their scattering
limit. The event budget can truncate deep transparent paths before the requested
scattering depth. On Intel Mac WebGL, the event limit is `min(bounces, 3)`, doubled
for scenes with transmission or alpha, with earlier scattering termination.
See [caustic path-length limits](./caustics.md#limits) when comparing renderers.

| Method / property | Meaning |
| --- | --- |
| `refine(channel?, options?)` | Trace beauty or an enabled AOV within this render's budget; returns status |
| `refineUntil(deadline, {signal}?)` | Prefer for custom beauty frame loops: synchronously refine once, then refill until the `performance.now()` deadline or cancellation; returns `Promise<void>`; see [sample batching](progressive-rendering.md#sample-batching) |
| `converge(options)` | Deterministic offline image; see below |
| `readPixels(kind = 'hdr')` | Read this render; see [pixel outputs](#pixel-outputs) |
| `engine` | Owning engine |
| `denoising` | Queued/running inference, including intermediate updates; default false |
| `on('sample', listener)` | Complete samples: `{samples, isFirstFrame, frameTimeMs}`; returns unsubscribe |
| `samples` | Complete samples since restart; stale engine inputs report 0 |
| `gpuSampleTimeMs` | Latest WebGPU full beauty sample estimate in ms, extrapolated from tile GPU time when tiled; undefined without timestamps, for stale inputs or during converge; custom frame loops should prefer `refineUntil` |
| `whenReadyToRefine()` | Wait for WebGPU sampling capacity and return `true` if sampling was queued; return `false` immediately with no sampling, on WebGL, or for only denoising, display or offline convergence work; submits no work; throws after disposal; custom frame loops should prefer `refineUntil` |
| `converged` | `samples >= maxSamples`, independently of filtering |
| `status` | Preparing, compiling, converging, denoising, finished or error |
| `setDenoiser(options)` | Replace the denoiser configuration; resolves when the filter is ready |
| `restart()` | Discard this accumulation |
| `dispose()` | Release this render and its denoiser lease |

`refine()` returns `'preparing'` during device/BVH setup and `'compiling'`
during shader compilation. Intermediate progressive denoising stays
`'converging'`; final denoising reports `'denoising'`. `'finished'` includes
completed filtering. Synchronous execution failures return `'error'` and set
engine.lastError. Invalid lifecycle operations (disposed render or refine during
converge) throw.

`refine(undefined, {batchSamples, targetBatchTimeMs, deferResolve})`
provides lower-level per-call control; custom frame loops should prefer
`refineUntil`. It overrides batching without changing render settings or discarding
samples. The first two options default to the render's execution settings.
`targetBatchTimeMs` must be positive and finite, defaults to `timeBudgetMs`, is
capped by that budget and is ignored on WebGL. `deferResolve` (default false,
WebGPU only) leaves the displayed image unchanged for calls between display
frames; the next presentation or pixel read updates it once with every new sample.

A fallback gets one sample when the requested render cannot finish its first
sample within budget and the fallback has no current complete image. A ready
fallback is not traced again. Fallback chains and cycles are rejected.

### converge(options)

| Option | Default | Meaning |
| --- | --- | --- |
| `samples` | required | Fixed spp, or adaptive cap |
| `camera` | committed camera | Copied override for this call; does not change engine.camera |
| `samplesPerBatch` | `8` | Samples per submission |
| `targetBatchTimeMs` | undefined | Adapt batch sizes on WebGPU |
| `adaptiveSampling` | undefined | Two-stage variance allocation on WebGPU; WebGL falls back to fixed spp |
| `sampleSequenceOffset` | `0` | Sequence base; disjoint ranges for independent frames |
| `previewIntervalMs` | undefined | Minimum delay between intermediate resolved images; never implicitly presents |
| `onProgress` | undefined | `{stage: 'pilot' | 'final' | 'denoising', samples, targetSamples}` |
| `signal` | undefined | Cancellation signal |
| `timeoutMs` | `600000` | Timeout per stage |

Resolves `{samples, averageSamplesPerPixel, pilotSamples, adaptiveSampling,
varianceHistory?}` after filtering. It rejects if engine input revisions change.
The same render cannot refine concurrently; other renders remain usable.

### Caustics

```ts
render.caustics = {lightTracing: {photonsPerSample: 32768}};
render.caustics = undefined; // Disable every estimator.
```

Changing any caustic option restarts accumulation. All estimators are experimental;
see the [caustics guide](./caustics.md) for choosing estimators, supported paths,
rendering cost and image-quality limitations.

| Option | Default | Meaning |
| --- | --- | --- |
| `lightTracing` | `false` | `true` or an object enables directly visible caustic light paths on WebGPU; ignored on WebGL 2 |
| `lightTracing.photonsPerSample` | pixel count / 4 | Emitted photons per sample, rounded to a positive integer and capped by the device dispatch limit |
| `photonMapping` | `false` | `true` or an object enables progressive caustic photon mapping on WebGPU; ignored on WebGL 2. See [PM-only denoising limits](./caustics.md#limits) |
| `photonMapping.photonsPerSample` | pixel count / 4, at most 262144 | Emitted photons per batch; 28 bytes each plus up to 13 MiB of overhead. Positive finite values are rounded to at least 1 and reduced to fit device limits and a 128 MiB batch budget; other values use the default |
| `photonMapping.initialRadius` | 3% of the caster bounding sphere radius | Positive first-batch gather radius in scene units, independent of `photonsPerSample`; shrinks as batches accumulate. Smaller radii preserve detail but require more photons |

## RenderLoop and Sync

`start()` uses requestAnimationFrame when available and a 16 ms setTimeout
otherwise. Worker visibility and control forwarding are described in
[worker integration](./getting-started.md#running-in-a-worker).

`new RenderLoop(engine, options?)` provides the interactive policy described in
[progressive rendering](./progressive-rendering.md#loop-policy).

| Option | Default | Meaning |
| --- | --- | --- |
| `display` | engine.display | Display used for presentation |
| `preview` | half-resolution adaptive Render | Render, RenderOptions or false; default quality in [ownership](./progressive-rendering.md#options-and-ownership) |
| `final` | new Render with preview fallback | Render or RenderOptions |
| `sync` | none | Sync or ordered Sync array on this engine |
| `idleMs` | 150 | Consecutive-edit idle deadline in milliseconds |
| `coalesceSceneUpdates` | false | Defer commits during preview inference, then commit latest camera/scene |

`engine`, `display`, `preview` (possibly undefined) and `final` are read-only.
`changing` defaults false; `samples` counts final beauty samples and reports 0 during preview; `status` starts preparing.
`select({changing})` defaults to changing ? preview : final. `addSync`/`removeSync`
manage integrations without disposing them. `tick` executes a manual frame;
`start`/`stop` manage animation frames. `converge` accepts the same options as
Render.converge and resumes a started loop. `dispose` releases owned renders.

Events: `status` carries `{status, previous}` only on transitions; `sample`
carries `{samples, preview: false, isFirstFrame, frameTimeMs}` for final only.
`on` returns unsubscribe and supports multiple listeners.

Extend `Sync` with `constructor(engine)` and `update(): void`. `engine` is readonly;
`active` defaults false. Integrations can use protected `setActive(boolean)` or
`activateFor(ms)`; `dispose()` clears base activity. Construction must not write
to the engine. Three.js integration uses [THREESync](./threejs.md#options).

## Display

`Display.canvas` is `HTMLCanvasElement | OffscreenCanvas`. `toBlob()` uses
OffscreenCanvas.convertToBlob in a worker or for an offscreen display. See
[worker integration](./getting-started.md#running-in-a-worker).

Use `engine.display`; creation of additional displays is outside this API.
`setSize(width, height)` changes canvas pixels. Scale-based renders resize on
their next refine; fixed renders retain their dimensions.
`present(render)` only presents: it returns the render or its ready fallback,
or undefined without changing the canvas when neither is ready.
`toBlob(render, {type?, quality?})` composes that render at its actual dimensions,
without resizing or changing the current canvas. MIME defaults to image/png;
quality defaults to the browser encoder value.

| Setting | Default |
| --- | --- |
| `toneMapping` | `'agx'` (`aces`, `cineon`, `reinhard`, `linear` also supported) |
| `toneMappingExposure`, `contrast`, `saturation` | `1` |
| `temperature`, `tint`, `vignette` | `0` |
| `bloomIntensity`, `bloomThreshold`, `bloomRadius` | `0`, `1`, `0.6` |
| `hdrOutputEnabled` | `false`; WebGPU only |
| `channel: DisplayChannel` | `'final'`; also albedo, normal, shadow, shadowCatcher and the seven [AOV kinds](#aov-visualization) |
| `aovDepthRange` | `[0, 10]`; finite scene-unit black/white depths, `0 <= near < far` |
| `aovPositionScale` | `1`; finite positive scene-unit half-range around the origin |
| `aovMotionScale` | `16`; finite positive pixel displacement for full brightness |
| `aovIdComponent: AovIdComponent` | `'object'`; also instance, material, primitive |
| `shadowCatcherColor`, `shadowCatcherAlpha` | `[0, 0, 0]`, `1` |

All display settings apply at composition and retain accumulated samples.
AOV mapping numbers must remain finite in float32; depth endpoints must remain
distinct after conversion.
Use the exported `DisplaySettings` type for a partial batch:

```ts
const settings: DisplaySettings = {toneMappingExposure: 2, bloomIntensity: 0.2};
Object.assign(engine.display, settings);
engine.display.present(render);
```

Ordinary setting fields remain enumerable and read back the assigned value.
For example, `bevelSamples` and `directLightCandidates` are clamped when
submitted, without rewriting the assigned field. Existing accessors for
resolution, fallback and worker count retain their validation rules.

`DenoiserOptions` is a union of `JNLMDenoiserOptions`, `OIDNDenoiserOptions`
and `CustomDenoiserOptions`,
with required `type`. The getter is frozen; reassign to edit. Invalid types,
foreign fields and invalid JNLM settings preserve the previous filter and
result. Schedule-only edits keep inference running. See [denoising](./denoising.md).

`Denoiser` is the caller-owned third-party WebGPU interface. Its optional
`prepare` receives device/dimensions, and `denoise` receives `DenoiseInput`
plus abort signal/schedule.
The packed buffer formats, ownership, cancellation, device changes and display
semantics are documented in [Custom denoisers](./denoising.md#custom-denoisers).

### Pixel outputs

`readPixels(kind = 'hdr')` returns `{ width, height, data }`. `data` is a
`Uint32Array` for `id` and a `Float32Array` for every other kind.
Pixels are RGBA with the top row first. Dimensions describe the internal render
texture, which WebGPU rounds up to multiples of 16. Before a pipeline exists,
beauty and OIDN-guide reads return an empty image; AOV reads reject.

| Kind | Values |
| --- | --- |
| `hdr` | Original linear HDR samples, unchanged by denoising |
| `denoised` | Completed output: custom WebGPU filters return native resolved HDR ray color before display background/catcher composition; built-in WebGPU filters normally return display-linear after composition/tone mapping; WebGL JNLM returns tone mapped, display encoded colors |
| `albedo` | Native linear albedo guide and coverage alpha |
| `normal` | Native normal guide: RGB encoded as `normal * 0.5 + 0.5`, alpha indicates valid surface data |

On WebGPU, the optional OIDN alpha postfilter operates on display colors;
its final native output is also display encoded. Readback preserves these
existing pipeline semantics. If no denoiser is attached or denoising has not
completed, `denoised` returns `hdr` and warns once per render. The method
makes a CPU copy and can be costly; avoid calling it every animation frame.

### Surface outputs

Request only the surface outputs you need on each render:

```ts
const render = new Render(engine, {
  aovs: ['depth', 'position', 'id', 'motion'], aovSamples: 16
});
await render.converge({samples: 64});
const depth = await render.readPixels('depth'); // Float32Array, RGBA
const ids = await render.readPixels('id');      // Uint32Array, RGBA
```

You can change `render.aovs` or `render.aovSamples` after sampling. Continue
calling `refine()` to regenerate AOVs for the current view; beauty samples and
completed denoising are preserved. AOV accumulation restarts when either changes.

| Kind | RGBA contents |
| --- | --- |
| `depth` | Camera-forward distance in scene units, 0, 0, coverage |
| `position` | World position xyz, coverage |
| `roughness` | Specular roughness, metalness, unsupported-reflectance fraction, coverage |
| `diffuseAlbedo` | Directional-hemispherical diffuse reflectance RGB, valid coverage |
| `specularAlbedo` | Directional-hemispherical specular reflectance RGB, valid coverage |
| `id` | Object, local instance (0 for ordinary meshes), material, source triangle index; background is `0xFFFFFFFF` in all channels |
| `motion` | Previous position minus current position in pixels, x right and y down; z = 0, alpha = 3 for valid history or 0 otherwise |

Depth, position, roughness and reflectance average independent jittered primary
rays, including depth of field, up to `min(samples, aovSamples)`. RGB values use
hit-count normalization; alpha is hit coverage over all AOV samples. Reflectance
uses only supported hits for both normalization and valid coverage. A blank pixel
is zero. These passes preserve beauty samples but do not sample the same paths.
Alpha holes use the first surface with alpha ≥ 0.5, skipping shadow catchers,
with at most 32 layers.

ID and motion use the unjittered pixel center without depth of field. `Mesh.aovId`
and `OpenPBRMaterial.aovId` default to process-unique integers. Explicit values
must be integers from 0 through `0xFFFFFFFE`, unique among the scene's objects
or materials respectively. Commit changes with `engine.update()`. Keep identities
stable and avoid reusing an ID for a different object while history is live.
Instance IDs are local indices; primitive IDs refer to the geometry's original
triangle order. A ray exactly on a shared edge can select either adjacent
triangle; host/GPU rounding can choose different IDs at that boundary.

Motion history belongs to each render and advances when it produces an AOV
frame. Camera pose and rigid object transforms can reproject across updates.
The first frame, changed dimensions or projection, missing identities, changed
topology or vertex positions, and failed visibility correspondence invalidate
motion. Device recovery also clears history. Deformed vertices have no motion
estimate; validity 0 must not be treated as a stationary surface.

Reflectance outputs are separate from the existing OIDN `albedo` guide.
Coat, fuzz, anisotropy, subsurface/volume scattering, bevel, thin film,
dispersion, partial alpha and nonstandard materials are unsupported by this
reflectance estimate. Such hits contribute to `roughness.b` and have zero
reflectance validity. Reflectance uses expensive BSDF quadrature; request it
only when needed.

Reading a kind absent from `render.aovs` rejects. A custom denoiser can request
its own [AOV inputs](./denoising.md#custom-denoisers). With neither request there
are no AOV allocations or passes. Enabling any kind costs about 128 GPU bytes
per pixel on WebGPU or 192 on WebGL, plus scene identity/history data; each
custom denoiser AOV snapshot adds 16 bytes per pixel. A render may retain one
reusable snapshot per kind between denoising calls. Readback adds a CPU copy.
WebGPU dimensions remain subject to device buffer limits. A full-frame AOV
sample runs independently of tile/adaptive sampling and may exceed the render's
time budget at large resolutions. WebGL requires `EXT_color_buffer_float`.

### AOV visualization

Select an enabled surface output on Display to present or export it:

```ts
engine.display.channel = 'depth'; // render.aovs must include 'depth'
engine.display.aovDepthRange = [0, 20];
engine.display.present(render);
const png = await engine.display.toBlob(render);
```

| Channel | Display mapping |
| --- | --- |
| `depth` | Black at the near depth, white at the far depth, clamped outside the range |
| `position` | World xyz mapped to RGB; origin is 0.5 and ±position scale maps to 0/1 |
| `roughness` | RGB = roughness, metalness, unsupported-reflectance fraction |
| `diffuseAlbedo`, `specularAlbedo` | Linear reflectance RGB clamped to [0, 1], then sRGB encoded |
| `id` | Stable pseudocolor for the selected uint32 ID component; colors can collide |
| `motion` | Direction as hue (+x is red, +y is yellow-green), displacement/scale as brightness |

AOV channels bypass tone mapping, grading, bloom, vignette and denoising;
registered display passes still run. Background and invalid reflectance or
motion are transparent; accumulated outputs use their coverage as alpha. Zero valid motion
is opaque black. The first frame's invalid motion is transparent.
Selecting a kind absent from `render.aovs` rejects, even if a custom denoiser
requests it. An enabled output awaiting sampling keeps the current canvas;
export rejects until that output is ready. Display selection alone does not enable tracing.
Changing the channel or mapping preserves beauty samples, raw AOV values and completed denoising.
With `RenderLoop`, selecting an enabled AOV traces surface outputs without
advancing beauty or running a denoiser, including after camera or scene edits.
When viewing motion, the loop refreshes once inputs settle so stationary surfaces
return to black. Switching between preview and final first displays zero motion;
subsequent camera or object changes show motion from that view.
ID and motion need one center sample; other AOVs stop at the smaller of
`maxSamples` and `aovSamples`. Loop status can be `finished` while beauty
`samples` remains zero. Switching back to Final resumes beauty for the current
view. Direct `render.refine()` and `converge()` still trace beauty and requested
AOVs together. Use `render.refine(kind)` for a surface-only step and
`render.aovSamplesRendered` for its progress. The existing `normal` and `albedo` channels keep their OIDN-guide meaning.

These mappings also apply to PNG export. Raw `render.readPixels(kind)` retains
the [surface formats](#surface-outputs) above. WebGPU HDR presentation decodes
the mapped colors to linear light; the visualization stays within SDR white.
Visualization retains an extra 8 GPU bytes per render pixel on WebGPU or 4 on
WebGL until the AOV resources are resized or disposed.

### Depth sampling

After rendering the current scene and camera, call
`await engine.readDepthSamples({ x: 0.5, y: 0.5, size: 0.07 })`.
The result is a `Float32Array` of 49 depths, in row order from the top left,
including the area's edges. It can be used for area autofocus without CPU
mesh traversal or reading a full-frame image.

`x` and `y` specify the center in viewport coordinates (0..1 from the top
left). `size` is the square's half height as a fraction of viewport height;
`0` samples a single point. All three fields are required. Depth is measured
along the camera's forward axis in scene units, independent of pixel jitter
and depth of field. Invisible shadow catchers and zero-opacity surfaces are
skipped; glass and partially transparent surfaces use their front surface.

Missed and out-of-viewport samples are `0`. Before GPU scene preparation
completes, or while another depth query is in flight, the result is
`undefined`; retry after a later rendered frame. Queries are asynchronous on
WebGPU and WebGL 2 and do not change accumulated rendering samples. Callers
should discard results when their scene, camera or sampling area changes
while a query is pending. GPU failures reject the promise.


## Scene types

Public spatial values use `Vec2` (`[number, number] | Float32Array`), `Vec3` (`[number, number, number] | Float32Array`) and `Mat4` (`Float32Array | number[]`, column-major, 16 elements), exported from the main entry.

| Export | Description |
| --- | --- |
| `Scene` | `{ meshes: (Mesh \| InstancedMesh)[], lights, background? }`; see below |
| `Mesh` | `new Mesh(geometry, material \| material[])`, `transform` |
| `InstancedMesh`, `InstancedMeshOptions` | `new InstancedMesh(geometry, material \| material[], {count, transforms?, colors?})`; local Float32 column-major matrices default to identity, multiplied by inherited transform; count selects the active prefix; `colors` defaults to undefined (white linear RGB); `markUpdated(): this` notifies both matrices and colors; `markTransformsUpdated(start = 0, count = this.count - start): this` and `markColorsUpdated(start = 0, count = this.count - start): this` notify each separately. Each advances version once, initially 0. See [updates and costs](./updates.md#instanced-meshes) |
| `Geometry`, `GeometryAttribute` | Triangle data: required `position`; optional `normal` and `indices` are generated at construction; `vertexCount` / `triangleCount` getters; optional `uv`, `uv1`, `tangent`, `color`, `materialIndex` (raw per-vertex indices, itemSize 1; all three corners of each triangle must match; invalid indices fall back to material 0 with one warning); `dynamic` (default `false`) for [deforming geometry](./updates.md#dynamic-geometry) |
| `OpenPBRMaterial` | `new OpenPBRMaterial(params?)`; see [materials](./materials.md) |
| `Texture` | HTMLImageElement, HTMLCanvasElement, ImageBitmap, OffscreenCanvas or `{ data, width, height }`; `colorSpace`: `'srgb'` or `'linear'`; default undefined uses sRGB for images/bytes and linear for `Float32Array`/`Int32Array`; independent `wrapS` / `wrapT`: `'repeat'` (default), `'clamp-to-edge'`, `'mirrored-repeat'`, applied after UV scale/offset for material textures |
| `ProceduralSky`, `ProceduralSkyOptions` | Clear-sky environment texture; [usage and options](#proceduralsky) |
| `Camera` | `new Camera({ projection: 'perspective', ... })` or orthographic; `position`, `lookAt()`, `copy(source)`, `clone()`; aspect defaults to automatic; depth of field with `fStop`, `focusDistance`, `sensorHeight`, `metersPerUnit` ([details](./getting-started.md#depth-of-field)) |
| `RectLight`, `SphereLight`, `SpotLight`, `DirectionalLight`, `EnvironmentLight`, `AmbientLight` | Parameter-object constructors; analytic lights use `transform`, `position`, `lookAt()` and rigid axes. See [lights](./getting-started.md#lights) |
| `EnvironmentLight` | `new EnvironmentLight({map, intensity?})`; `intensity` defaults to `1`, scales environment radiance, and accepts `0` to disable lighting. Ambient lights and explicit background textures retain their own brightness. `transform` rotates the environment from local to world space (identity by default); translation and positive axis scale are ignored. An explicit background texture keeps its own orientation |
| `IESProfile`, `parseIESProfile(text)` | Photometric profiles for `SpotLight` |
| `SceneBackground` | `[r, g, b, a]`, `Texture`, `EquirectBackground` (`{type: 'Equirect', map, transform?, intensity?}`) or `GroundedSkyboxBackground`. Equirect `transform`: column-major map-to-world rotation (default identity); translation and positive axis scale are ignored. Grounded `rotation`: radians around +Y (default `0`). `intensity` on either: nonnegative RGB multiplier, default `1`. These affect only the background; ground stays level and alpha is preserved |

`OpenPBRMaterial` accepts canonical `specularRoughnessAnisotropy` (default `0`),
`coatRoughnessAnisotropy` (`0`), `subsurfaceScatterAnisotropy` (`0`),
`geometryOpacity` (`1`) and `geometryThinWalled` (`false`). The old names are
deprecated aliases sharing storage; conflicting constructor values throw.
See [compatibility names](./materials.md#compatibility-names).

`OpenPBRMaterial` also accepts `thinFilmThicknessMinimum` (default `0` µm)
and `thinFilmMapChannel` (default `r`, one of `r/g/b/a`). `thinFilmThickness`
(default `0.5` µm) is the maximum endpoint with a map and the constant without
one. See [thin-film textures](./materials.md#textures) for range behavior.

`coatWeightMap`, `coatRoughnessMap`, `fuzzColorMap`, `fuzzRoughnessMap`,
`specularWeightMap` and `specularColorMap` accept `Texture` and each default to
`undefined`. Channels and color decoding are listed in [material textures](./materials.md#textures).
They follow the existing material/texture update mechanism.

`coatNormalMap` defaults to `undefined`; `coatNormalScale` defaults to `[1, 1]`.
See [coat normals](./materials.md#coat-normals) for independent base and coat normal mapping.

Raw texture sources contain exactly `width * height * 4` RGBA values, with
rows ordered from top to bottom. `Uint8Array` and `Uint8ClampedArray` store
8-bit values; color slots decode RGB from sRGB by default. `Float32Array`
(and `Int32Array` with integer HDR values) defaults to linear color, including
values above 1. Set `texture.colorSpace` to `'srgb'` or `'linear'` to override
color decoding. Data slots (roughness, normal, coat weight, etc.) always read
channels directly, normalizing bytes to [0, 1]. These sources can share a material
texture array with Canvas images and other image sources on both backends.

Material arrays containing float/integer HDR sources use half-float storage (finite
range up to 65504, rounded to half-float precision) and twice the bytes per
pixel of an 8-bit array. Raw sources retain straight alpha and their original
RGB even at zero alpha; Canvas composition can discard transparent RGB and
round partially transparent colors. When the atlas budget requires resizing,
raw sources use nearest-neighbor downsampling; image sources use Canvas
resampling. Equal dimensions and opaque pixels allow exact byte/image
comparisons. Linear color samples interpolate in linear space, while sRGB color
samples interpolate before decoding; gradients can therefore differ even
when their endpoint colors agree. Half-float and 8-bit filtering also have
different precision.

`Geometry` and `Texture` expose `version` (initially `0`)
and `markUpdated(): this`. `Geometry` also has the read-only `topologyVersion`
(initially `0`) and `markVerticesUpdated(): this`, which advances only
`version`. See [scene updates](./updates.md) for when to call each.

### ProceduralSky

Use the sky as an environment map, an explicit background, or the map of a
`GroundedSkyboxBackground`:

```ts
import { ProceduralSky, EnvironmentLight } from '@meimu/mutracer';

const sky = new ProceduralSky({ resolution: [2048, 1024], time: 15 });
scene.lights.push(new EnvironmentLight({ map: sky }));
// With no explicit scene.background, the environment is also the background.
sky.time = 9;
engine.update();
```

| Option / property | Default | Behavior |
| --- | --- | --- |
| `resolution` | `[2048, 1024]` | Positive integer equirectangular width and height; assign a new pair to resize |
| `time` | `15` | Local solar time in hours, from `0` to `24`, for an equinox at latitude 40° |

Time and resolution assignments follow the normal [scene update rules](./updates.md).
Use `EnvironmentLight.intensity` and `transform` for brightness and rotation.
With Three.js, pass the sky as the `environment` option to `THREESync` or
`fromTHREEScene`; the Three.js scene still supplies intensity and rotation.

Higher resolutions use more memory and can exceed device limits. Frequent
time edits can be slower with WebGL 2. Dispose the engine when finished;
`ProceduralSky` needs no separate disposal.

This is a clear atmosphere without clouds, stars, moonlight or artificial
light. Very low resolutions can blur or miss the small sun disk. Use the sky
for environments and backgrounds, not material texture slots.

## Helpers

| Export | Description |
| --- | --- |
| `createPlaneGeometry`, `createCubeGeometry`, `createSphereGeometry`, `createCurvePlaneGeometry` | Procedural geometry (plane is 2×2 in XZ, cube and sphere span −1..1) |
| `generateVertexNormals`, `generateVertexTangents` | Attribute generation |
| `computeMeshesBoundingBox(meshes)` | World-space bounds |
| `loadRGBE(url)`, `parseRGBE(buffer)` | Radiance `.hdr` → float `Texture` |
| `THREESync` | Keeps a `THREE.Scene` in sync: `new THREESync(engine, {scene?, camera?, controls?, updateControls?})`; RenderLoop calls update; dispose when done; conversion hooks `convertMaterial` / `convertLight`; see [Three.js](./threejs.md#custom-conversion) |
| `fromTHREECamera(camera, options?)` | Converts a Three.js camera; one-shot conversion; THREESync retains and updates cameras. Reads `focus` and the film height; `FromTHREECameraOptions` sets `fStop` (default `0`), `focusDistance` and `metersPerUnit` (default `1`) |
| `fromTHREEScene` | One-shot Three.js scene conversion with FromTHREESceneOptions conversion hooks; every call reruns hooks and creates fresh default objects |
| `FromTHREESceneOptions` | Optional `environment` overrides the Three.js environment with a MuTracer `Texture` or `ProceduralSky` (default undefined); optional `onMeshConverted(mesh, source, group, groupIndex)` callback; default: none |
| `VERSION` | Library version |

`@meimu/mutracer/oidn` exports weight constants (`OIDN_MODEL_FILENAMES`,
`OIDN_AUXILIARY_MODEL_FILENAMES`, `OIDN_WEIGHTS_PACKAGE`,
`OIDN_WEIGHTS_PACKAGE_VERSION`, `DEFAULT_OIDN_WEIGHTS_BASE_URL`,
`DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL`) and `resolveOIDNModelUrl` /
`resolveOIDNAuxiliaryModelUrls`. Configure packaged/custom OIDN networks,
execution engines, precision and dynamic tiles through `render.setDenoiser()`;
see [denoising](./denoising.md#custom-oidn-networks). The main entry exports
`OIDNEngine`, `OIDNPrecision`, `OIDNHDRTransfer`, `OIDNDynamicTileOptions`,
`OIDNDynamicTileSetting` and `OIDNAuxiliaryModelUrls` as types.

## GPU output and display passes

`render.getOutputTexture(kind)` borrows native HDR or the latest display image;
`display.addPostProcess(pass)` returns unregister and runs on every present/export.
Both are WebGPU-only. See [formats, lifecycle and overlay example](./post-processing.md).

Anisotropy direction options: `anisotropyMap` (default `undefined`) reads linear RG as a tangent direction and B as a multiplier for base specular strength. `specularAnisotropyRotation` (default `0`) rotates that direction counter-clockwise in radians; `coatAnisotropyRotation` (default `0`) rotates the coat relative to the geometry tangent. See [materials](./materials.md#anisotropy-directions) for frame and fallback conventions.

`specularAnisotropyModel` defaults to `'openpbr'`. Selecting `'gltf'` keeps `specularRoughness` as source perceptual roughness and `specularRoughnessAnisotropy` (or its compatibility name) as source strength. The renderer converts both after their texture factors and before coat roughening. See [source conversion](./threejs.md#anisotropy-source-conversion) for the equations and metadata precedence.
