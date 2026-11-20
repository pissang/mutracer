# Temporal denoising for animation

Design note for turning the experimental temporal pipeline on
`codex/temporal-denoise-gpu` (`79e96694`, `scripts/temporal-denoise/`) into a
library feature. It covers the algorithm being kept, the public API, the
inputs it needs for dynamic scenes, memory, validation and the implementation
order. Usage documentation belongs in `docs/temporal-denoising.md` once the
feature exists; this note keeps the design reasons.

## Status and goal

The target is offline animation quality at a fixed, low sample count per frame
(32 spp in the reference work). GPU time and memory are reported but do not
decide quality questions.

On the 720p dining-table camera move, the accepted pipeline reduces sideboard
drift from 0.854 (per-frame OIDN) to 0.127 and reaches 39.52 dB full-image PSNR
against 1024 spp references. Recursive history and NRD-style diffuse/specular
split denoising were tested and rejected (Stage 3 and 3b): both lost edge PSNR
and steel-cutlery quality. The split AOVs stay unmerged on
`codex/temporal-split-outputs`; this feature does not use them.

The prototype assumes a static scene. It reprojects by world position and
camera matrices only. Dynamic scenes are a requirement of the library feature.
The library reprojects by chaining the `motion` AOV (see
[dynamic scenes](#dynamic-scenes)).

## Algorithm kept from the prototype

Per output frame *t*:

1. **Direct window in linear HDR.** Every neighbor frame *s* in the window is
   reprojected once, nearest texel, into *t*. No recursive history.
   - Validation of a tap in the prototype: same object, instance and material
     ID; normals within `dot ≥ 0.95`; tangent-plane distance ≤ 1.5% of depth;
     circle-of-confusion difference ≤ 0.5 px; on screen and in front of the
     camera. The library moves the ID and normal tests onto every chain step
     and keeps depth and CoC at the landing texel.
   - Tent weights `(R + 1 − |s − t|) / (R + 1)`.
   - Offline (symmetric) radius adapts to defocus:
     `R = clamp(8 + 8·max(CoC − 2, 0), 8, 16)` px of CoC. Interactive (causal)
     radius is 17 past frames.
   - Smooth metals (`roughness.x < 0.25` and metalness `roughness.y > 0.10`) use
     the current frame only. An explicit per-material cap map was tested and
     hurt glaze and marble; it stays out of the default.
   - At silhouettes and thin geometry, a bilinear coverage weight and a 3×3
     same-surface search within ±3 frames recover history (the "mixed window"),
     with a sky-correction term for partially covered pixels.
2. **One spatial denoise.** OIDN `cleanAuxLarge` on the accumulated image, with
   albedo and normal guides of frame *t*.
3. **Post stabilisation, radius 3.** On the denoised display image: geometric
   alignment plus three-level image matching (`flow.mjs`), blended with a
   low-frequency difference test.
4. **Sparkle filter.** Suppresses one-frame bright impulses that exceed the
   temporal spread, with a veto that preserves genuine glints
   (`stabilizeSparkle: true`, `sparkleVariant: 'veto'`).

Offline latency is therefore `Rmax + postRadius = 19` frames; interactive
latency is zero.

## Public API

### Entry point

A new sub-path, `@meimu/mutracer/temporal`, like `/oidn` and `/materialx`. The
window, flow and post shaders are large and only animation users need them.
Core classes recognise temporal frames through an internal protocol, so the main
entry does not import the sub-path.

### Usage

```ts
import {Engine, Render} from '@meimu/mutracer';
import {TemporalDenoiser} from '@meimu/mutracer/temporal';

const engine = new Engine({canvas});
const render = new Render(engine, {width: 1280, height: 720, maxSamples: 32});
const temporal = new TemporalDenoiser(engine); // offline, cleanAuxLarge
temporal.attach(render);

for (let frame = 0; frame < frameCount; frame++) {
  animate(frame);
  engine.update();
  await render.converge({samples: 32, sampleSequenceOffset: frame * 32});
  await temporal.push(render);
  for await (const result of temporal.drain()) await save(result);
}
for await (const result of temporal.flush()) await save(result);
temporal.dispose();

async function save(result) {
  const blob = await engine.display.toBlob(result);
  // or: await result.readPixels('denoised')
}
```

### `TemporalDenoiser`

`new TemporalDenoiser(engine, options?)`. Allocation is lazy: it happens on the
first `push`, when the dimensions are known. Options are fixed for the lifetime
of the object; create a new one to change them.

| Member | Meaning |
| --- | --- |
| `attach(render)` | Prepare one render for capture; returns a detach function. One attached render at a time |
| `push(render)` | Capture the render's converged frame; may process frames that became ready. Resolves when the capture is on the GPU queue |
| `drain()` | Async iterable of finished frames, in order. Each frame is borrowed until the iterator advances |
| `flush()` | Async iterable that ends the shot: finishes every pending frame with a truncated future window, then resets history |
| `cut()` | History boundary before the next push (camera cut, scene switch). Pending frames still finish |
| `latency` | Frames between `push` and the frame becoming drainable: `Rmax + postRadius` offline, 0 interactive |
| `plan` | After the first push: effective `{historyRadius, postRadius, bytes}` after the memory budget |
| `dispose()` | Release GPU resources and the OIDN lease. Safe to repeat |

`attach(render)`:

- Registers an internal AOV request on the render, in the same way as custom
  denoiser `aovs`: the passes run, but `render.aovs` is unchanged.
- Warns once if the render has its own denoiser: its result is ignored and the
  inference is wasted.

`push(render)` rejects when:

- the engine runs on WebGL (see [WebGL](#webgl));
- the render is not attached or not converged;
- its dimensions differ from earlier pushes in this shot;
- the device was lost (the history is gone; create a new denoiser).

It captures, entirely on the GPU, the following, plus the scene revisions
needed for invalidation:

- the resolved HDR color, albedo and normal;
- the requested AOVs;
- the camera of the last `converge` (including its override);
- the display composition settings.

It warns once if two pushes use the same `sampleSequenceOffset`, because
correlated noise does not average out.

Undrained output is bounded: `push` rejects with a clear error when more than
four finished frames wait in the queue.

### `TemporalFrame`

| Member | Meaning |
| --- | --- |
| `index` | Push index of this frame within the denoiser, from 0 |
| `width`, `height` | Frame dimensions |
| `readPixels(kind = 'denoised')` | `'denoised'`: final result after post and sparkle filters, in the same color space as `Render.readPixels('denoised')` for the chosen spatial denoiser. `'accumulated'`: windowed linear HDR before the spatial denoiser |

`Display.present(frame)` and `Display.toBlob(frame)` accept a frame wherever
they accept a render. Composition before the denoiser slot in
`tests/fixtures/display-order.json` uses the settings captured at push. Stages
after it (bloom, vignette, presentation encoding) use the display passed to
`present`/`toBlob`. AOV display channels reject temporal frames.

### Options (`TemporalDenoiserOptions`)

Every option gets TSDoc with its default.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `'offline'` | `'offline'`: symmetric window, uses future frames. `'interactive'`: causal window, past frames only, zero latency |
| `historyRadius` | offline `{min: 8, max: 16}`, interactive `17` | Integer 0–32, or `{min, max}` for the CoC-adaptive symmetric radius (offline only). 0 disables history accumulation |
| `postRadius` | `3` | Post stabilisation frames each side (offline) or past (interactive), integer 0–3; 0 disables the post filter and the sparkle filter |
| `stabilizeSparkle` | `true` | Glint-preserving impulse filter after post stabilisation; requires `postRadius > 0` |
| `denoiser` | `{type: 'oidn', model: 'cleanAuxLarge'}` | Spatial denoiser applied once to the accumulated image. Accepts `OIDNDenoiserOptions` without `schedule`, `CustomDenoiserOptions` without `schedule`, or `null`. JNLM is rejected: its variance estimate does not describe a windowed mean |
| `historyInvalidation` | `'auto'` | `'auto'` cuts history when light, environment, material or visibility revisions change; `'manual'` cuts only on `cut()` |
| `memoryBudget` | `undefined` | GPU bytes for temporal history and scratch; undefined allocates the full plan. See [memory](#memory) |

The following stay internal constants in v1:

- the smooth-metal thresholds;
- validation tolerances;
- the material cap map;
- the auto-cut acceptance threshold.

These are tuning values with evidence behind them, not user decisions.

### Composition with existing features

- **Render.** The user owns the render and its scene/camera updates. The
  temporal denoiser reads only resolved buffers through an internal hook.
  `converge` with a fixed sample count is the intended producer.
  `adaptiveSampling` is allowed. Progressive `refine` frames can be pushed only
  once the render is converged.
- **Custom denoisers.** As the `denoiser` option, a caller-owned `Denoiser`
  receives the accumulated native HDR as `color` under the existing
  [custom denoiser contract](../denoising.md#custom-denoisers), once per frame.
  Its `aovs` request is honoured from the frame's snapshot.
- **`createOIDNFilter`.** Built-in OIDN runs through the same buffer filter
  (merged with this feature). It shares the engine inference lease, so it
  serializes with renders' own OIDN. Users who want their own pipeline keep
  `createOIDNFilter` and custom denoisers.
- **OIDN input color space.** The prototype gives OIDN the composed
  display-linear image, exactly as built-in Render OIDN does. It did this
  through private diagnostics (`_displayParity().loadGPU`). The library adds an
  internal "compose external HDR for denoising" path in
  `WGPURenderingPipeline`. With the window and post disabled, its output must
  equal the render's built-in OIDN input.
- **Export.** PNG export goes through `Display.toBlob(frame)`. The post and
  sparkle stages work on display-encoded values, so an HDR export of the final
  stabilised image does not exist in v1. `readPixels('accumulated')` is the HDR
  output.

## Dynamic scenes

### Reprojection by chained `motion`

The window reprojects through the `motion` AOV, as other temporal denoisers do.
It does not compute its own correspondence. Every kind of movement that
`motion` handles is therefore supported, with no extra work in the temporal
module:

- camera motion;
- rigid object and instance transforms;
- deformation, once `motion` supports it.

Where `motion` is invalid, the chain stops and the pixel uses fewer frames.

Each ring slot stores the frame's `motion` (previous minus current position,
in pixels). For pixel *x* of frame *t*:

- **Past neighbors** (*s < t*). Start at `p_t = x` and step back one frame at a
  time: `p_{k−1} = p_k + motion_k(p_k)`.
  - `motion_k` is sampled bilinearly from only those texels whose `id`
    matches the chain's surface. Nearest sampling would add up to half a pixel
    of motion-gradient error per step. Unrestricted bilinear sampling would mix
    in another object's motion at a silhouette.
- **Future neighbors** (*s > t*). `motion` points backwards, so each forward
  step inverts it by fixed-point iteration:
  - Find *y* in frame *k + 1* with `y + motion_{k+1}(y) = p_k`, starting from
    `y₀ = p_k − motion_{k+1}(p_k)`, for at most four iterations.
  - Accept the step only when the residual is below 0.05 px and the `id`
    matches. Otherwise the chain ends.
- **Chain validity.** Every step needs:
  - valid `motion` (alpha 3), which includes the renderer's grazing-angle
    plane visibility test;
  - the same object, instance and material ID;
  - adjacent-step normals with `dot ≥ 0.95`.

  A chain that breaks at step *k* stops there, and frames beyond it are not
  used for that pixel. The tests are per step, so a rotating or deforming
  surface keeps its history even after its normal has turned far over the
  window.
- **Landing validation.** At the final texel in *s*, two tests stay from the
  prototype: the depth test (1.5%) and the CoC test (≤ 0.5 px). Bilinear
  coverage and the mixed-window 3×3 search also stay. The depth they compare
  against is the chained previous depth (see the `motion.z` request below),
  not a world position. A moving object has a different world position in
  every frame.

The prototype's world-position reprojection is not shipped. Phase 1 keeps it
only to reproduce the archived static results. Phase 3 replaces it, and the
GPU tests keep it as an oracle for static scenes.

**Accuracy gate.** On the static dining-table archive the exact projection is
known. Gate on the chained landing positions against that projection: p99
error ≤ 0.05 px at |Δ| = 16 in both directions, and chain acceptance at least
that of the prototype's validation. If the gate fails, record the error
distribution and report to the maintainer before tuning further. Replacing
the chain is the maintainer's decision.

### What the temporal feature needs from `motion`

- **Previous depth in `motion.z`.** Today the `z` lane is documented as 0. The
  request: the camera-forward depth of the same surface point in the previous
  frame, which the visibility test already computes. Chaining it gives the
  landing depth for the depth and CoC tests. This is a public contract change
  to the `motion` row in `docs/api.md`.
- **Float32 precision.** Sub-pixel accuracy matters, because errors add up
  over 16 steps. The output is already rgba32f.
- **Projection changes keep history.** Focal-length animation and dolly-zoom
  must not invalidate `motion` (remaining item 2 below). Until then, a zooming
  camera ends every chain and the window falls back to the current frame.
- **One AOV frame per push.** `motion` history advances per AOV frame. Push
  checks that the render's AOV history advanced by exactly one frame since the
  previous push. Otherwise, for example after previews were rendered in
  between, it treats the push as a cut.
- **Deformation.** Needed for vertex animation (remaining item 1). The
  temporal feature does not need the barycentric lane. Until deformation lands,
  deformed pixels have invalid `motion`, so their chains end immediately and
  they use only the current frame: noisier, but without ghosting.

### `motion` AOV work

`motion` already handles camera motion and rigid object transforms. Each
instance stores a current-to-previous world matrix in the AOV scene table, read
in `aovTraceCenter` (`src/renderer/wgsl/aovTrace.wgsl.ts`) and in
`aovTrace.frag.ts`.

**Done: grazing-angle visibility.** Commit `6300996d` on `codex/motion-aov`,
from `dev`.
- The visibility test compared the reprojected depth with the depth at the
  nearest previous pixel centre, at a fixed 0.1% tolerance. It rejected most
  tilted surfaces; 68% of the dining-table marble was invalid.
- It now compares against the depth of the current tangent plane at that pixel
  centre. Two tangent offsets are projected, and `1/w` and `depth/w` are
  interpolated affinely, which is exact for planes under any projective camera.
- A GPU regression in `tests/gpu/aov.ts` covers a grazing ground plane:
  912/912 valid on both backends, against 0/912 before; error ≤ 0.002 px.
- Native imports the same WGSL. Native checks have not been run.

**Remaining.** In order, each on `codex/motion-aov` with both backends:

1. **Deformed geometry.**
   - When a mesh's vertex positions change with unchanged topology
     (`Geometry.markVerticesUpdated()`, skinning, morph targets), keep the
     previous frame's object-space positions for that mesh. Store them as a
     snapshot buffer referenced from the AOV scene table, only for meshes that
     changed.
   - In the centre pass, interpolate the previous positions at the hit's
     `si.barycentrics` on `si.triangleIndex`, apply the instance's previous
     world matrix, and project.
   - Keep the plane visibility test. Use the previous triangle's plane, from
     the three snapshot vertices, for the depth check.
   - Topology changes still invalidate.
   - Respect the storage-binding budget. The shader comment states four scene
     plus three AOV storage buffers; if a new binding does not fit, pack the
     snapshot into the existing AOV scene buffer. On WebGL, use a texture like
     `aovScene`.
2. **Previous depth.**
   - **Today.** Internally, `AovCenter.motion.z` holds the current
     camera-forward depth. It is history for the next frame's visibility test,
     which reads `previous.motion.z`. Every public reader writes 0:
     - `WGPUAov.ts` readback;
     - `aovResolve.wgsl.ts`, which feeds custom-denoiser snapshots;
     - `WebGLAov.ts` readback;
     - the native borrow shaders.
   - **Change.** Public `motion.z` becomes the camera-forward depth of the same
     surface point in the previous frame, in `centerDepth` units. Valid pixels
     carry that depth; invalid pixels are 0. Take the point at its previous
     position (the current-to-previous transform, and later the deformation
     snapshot) and measure it with the previous camera's position and forward
     axis, so that orthographic cameras are also correct.
   - **Storage.** Keep the current depth available as history. Prefer storing
     the previous depth without growing `AovCenter`, which the native host
     mirrors. If a new lane is cleaner, extend the struct together with its
     mirrors and contract tests.
   - **Readers.** Display mapping ignores `z`. Update the `motion` row in
     `docs/api.md`.
3. **Projection changes.**
   - Focal-length animation and dolly-zoom must not invalidate `motion`. The
     previous view-projection already projects the point, so invalidate only
     when the dimensions change.
   - Check that the orthographic-to-perspective switch still behaves: the
     current GPU test expects that a projection change invalidates. Change the
     contract and the docs together.
4. **Accuracy test.** For adjacent frames, `motion.xy` equals the analytic
   projection of the surface point within 1e-3 px wherever `motion` is valid,
   and `motion.z` equals its previous depth within 1e-4 relative. Cover rigid,
   deformed and zooming cases in a GPU test on both backends. The temporal
   chain relies on this contract.
5. **Docs.** Update the `motion` row and the "Motion history" paragraph in
   `docs/api.md`: deformation supported, projection changes keep history,
   the remaining invalidations.
6. **Native.** After web review: run the focused native checks
   (`native/CONTRIBUTING.md`), and port any host-side snapshot plumbing in
   `native/host/src/aov.rs`.

Gate: the existing `tests/gpu/aov.ts` contract plus the new cases pass on WebGPU
and WebGL; four typechecks; `npm test`. Beauty must be unchanged when `motion`
is requested; the GPU test already asserts this.

### History invalidation

Geometric validation handles visibility. It cannot see radiance changes on a
surface that did not move. With `historyInvalidation: 'auto'`, every push
records a revision vector, and the window only uses neighbors in the same epoch
as *t*. Epoch boundaries come from:

| Change between frames | Effect |
| --- | --- |
| Any light, environment or background revision | Global boundary |
| Mesh visibility toggled, mesh added or removed | Global boundary (shadows and indirect light change) |
| Material parameters or graph | Boundary for pixels whose center material ID changed revision; others keep history |
| Camera cut detected: under 10% of valid pixels accept frame *t − 1* | Global boundary |
| `cut()` | Global boundary |

Continuous light animation (a moving sun, a pulsing emitter) would set a
boundary every frame and disable history. v1 documents this: use
`historyInvalidation: 'manual'` and accept temporal blur of moving shadows, or
render more samples.

A radiance-consistency test, described below, is a separate later phase
(phase 5) with its own gate. It must not change the static-scene results.

- Compare albedo-demodulated low-pass neighbor radiance with the current frame.
- Set the tolerance from the per-pixel luminance moments the path tracer
  already accumulates.

## WebGL

Temporal denoising is WebGPU only, and WebGL has no fallback.

- `push` rejects with an error that names the requirement, so a missing
  feature never looks like a stream of unfiltered frames.
- `attach` and the constructor do not throw, so an application can construct
  the denoiser before the backend is known.
- Applications check `engine.backend === 'webgpu'` after `await engine.init()`,
  and on WebGL use a per-frame denoiser on the render.

This is a deliberate exception to the `AGENTS.md` rule that WebGPU-only
features fail soft on WebGL. The maintainer chose an explicit error over a
silent per-frame fallback.

## Memory

The prototype allocates two rings per mode (a pre ring plus the window ring),
and its post ring keeps its own surfaces. It holds 16-bit IDs, f16 world
positions and 8-bit post history. The library merges these into one ring. The
post stage reads `motion`, IDs and normals for *t ± 3* from the window ring,
which still holds them when post runs. Estimated bytes per pixel per slot:

| Data | Format | Bytes/px | Slots (offline default) |
| --- | --- | ---: | --- |
| HDR radiance | rgba16f + overflow table | 8 | `2·Rmax + 1` = 33 |
| `motion` (xy, previous depth, validity) | rgba32f | 16 | 33 |
| Surface: octahedral normal, depth, cap lane | rgba16f | 8 | 33 |
| IDs + packed coverage/albedo guide | rgba32uint | 16 | 33 |
| OIDN guides (albedo, normal) | rgba16f ×2 | 16 | `Rmax + 1` = 17 |
| Post history: display, blurred, pyramid | rgba16f | ≈ 40 | `2·postRadius + 1` = 7 |
| Scratch: sums, outputs, OIDN buffers, flow grids | f32 | ≈ 100 | 1 |

That is about 2,240 B/px for the default offline plan:
`33·48 + 17·16 + 7·40 + 100`.

The interactive plan is about 1,140 B/px:

- 18 history slots;
- current-frame guides only;
- 4 post slots.

| Resolution | Offline default | Interactive (17 past + 3 post) |
| --- | ---: | ---: |
| 1280×720 | ≈ 2.1 GB | ≈ 1.1 GB |
| 1920×1080 | ≈ 4.6 GB | ≈ 2.4 GB |
| 3840×2160 | ≈ 18.5 GB | ≈ 9.5 GB |

The prototype measured 1.70 GiB at 720p for its A2 replay buffers. The
estimate is higher mainly because of the f32 `motion` and the 32-bit IDs.
World positions are no longer stored.

The renderer, the AOV passes and the OIDN network come on top of this.
Deformation costs the temporal feature nothing extra: `motion` keeps one
previous vertex snapshot inside the renderer.

`memoryBudget` covers the temporal allocations. When the full plan does not fit,
the plan degrades in this order:

1. Adaptive maximum radius 16 → 8. Measured cost: about 4% more defocus drift.
2. Symmetric radius 8 → 4, then 2.
3. Post radius 3 → 2 → 1. Post stabilisation halves drift, so it goes last.
4. If radius 1 with post 0 does not fit, the constructor's first `push` rejects
   with a `RangeError` that states the minimum bytes.

`plan` reports the result, and one warning names the reduction. An
`out-of-memory` error scope around the allocation applies the next reduction
once before rejecting. WebGPU cannot report free memory, so there is no
automatic budget.

## Robustness fixes over the prototype

These are required before the feature ships. Each lands as its own change with
an A/B on the dining-table archive.

- **HDR overflow.** The prototype keeps an f16 overflow table that throws when
  full. A full table should make the excess pixels of that frame current-frame
  only, not fail.
- **Object IDs.** The prototype truncates them to 16 bits. Use full 32-bit IDs.
- **World positions.** The prototype stores them in f16 (0.5-unit steps at
  1000 units). The chained-`motion` reprojection no longer stores them; depth
  tests are relative and use f16 depth.
- **Post-history quantization.** The prototype rounds post history to 8-bit
  sRGB codes. Its thresholds are in code units, so keep the code scale but
  store floats. A/B this change separately.
- **Hard-coded material IDs.** `materialOK` in `kernels.mjs` contains
  scene-specific IDs. Remove them; only the roughness rule remains.
- **CPU readback.** The window upload goes through a CPU readback and repack.
  All capture moves to the GPU.
- **Private hooks.** `display._configure`, `_output` and `_displayParity` are
  replaced by internal APIs that keep the existing display order.

## Validation

### Test scenes

Procedural, in `examples/temporal/` and the GPU tests, rendered at 640×360 so
references stay affordable:

1. **Moving objects.** A closed room lit by a rect light and an HDR-free
   procedural sky through a window.
   - Contents: a checker floor, a rotating and translating diffuse sculpture, a
     smooth metal sphere, a glass sphere and thin bars (a fence) in front of a
     textured wall.
   - Camera: a dolly with depth of field.
   - Exercises: disocclusion behind moving objects, smooth-metal exclusion,
     thin geometry, defocus.
2. **Deforming mesh.** A procedural cloth plane with a travelling sine wave
   (`markVerticesUpdated`), plus a sphere morphing into a cube by vertex lerp,
   over a textured floor. Run it with `motion` deformation support. Before that
   support lands, run it to check that deformed pixels fall back to the
   current frame without ghosting.
3. **Lighting changes.** The scene 1 room with a light switched on at a known
   frame, an emissive material colour change, a mesh visibility toggle and a
   slowly moving spot light. Exercises auto-invalidation and documents the
   `'manual'` behavior.

The dining-table archive remains the regression reference. It runs from the
evidence directory, not from the repository.

Ground-truth correspondence is known analytically in the procedural scenes. The
metrics use it instead of estimated optical flow. References are 1024 spp per
frame at five frames per scene plus 256 spp on a 26-frame stretch for
stability.

### Gates, in order

1. **Ghosting.**
   - Error masks: moving silhouettes dilated by 4 px, plus pixels disoccluded
     within the window. MAE must not exceed per-frame OIDN on the same mask by
     more than 0.5 display codes.
   - Trail test: the signed trailing-minus-leading error along true motion must
     have a 95% bootstrap interval that includes zero or lies below it, with a
     one-pixel delayed reference as the positive control.
   - Transient expiry: a ×20 RGB injection over 32×32 px at frame *k* is
     identical to the clean run from `k + Rmax + postRadius + 1`.
   - Scene 3: no pixel uses history across a boundary (verified through the
     window's accepted-tap counters).
2. **Stability.** Low-frequency drift (σ = 6) and flicker on static and rigidly
   moving surfaces: at most 0.5× per-frame OIDN drift on scenes 1 and 2. The
   dining-table drift stays within run-to-run spread of 0.127.
3. **Sharpness.**
   - Full and edge PSNR against 1024 spp: not below per-frame OIDN on full,
     edge loss at most 0.3 dB.
   - Dining table: 39.52 dB full PSNR within 0.05 dB.
   - Glints: the reference-confirmed highlights at f150 retained within one
     code.

Thresholds are proposals. Phase 1 calibrates them against the dining-table
reproduction and the per-frame OIDN baseline before they become pass/fail.

### Tests to add

Unit tests (Vitest, no GPU):

- options: defaults, validation, freezing;
- scheduling: readiness, latency, drain order, flush with a truncated future,
  `cut` and epochs, the bounded output queue;
- memory plan and degradation order;
- revision-vector invalidation;
- uniform and struct layout contracts between TypeScript packing and WGSL;
- generated shader validity;
- forward-inversion convergence on synthetic motion fields (a CPU reference of
  the WGSL iteration);
- the WebGL rejection.

GPU tests (`tests/gpu/temporalDenoise.{html,ts}`, headless Chrome, WebGPU, plus
a `?webgl` rejection case):

- **Identity.** Window radius 0 and post 0 equal the render's built-in
  `cleanAuxLarge` output.
- **Chain accuracy.**
  - Static scene with a camera move: chained landing positions in both
    directions, up to |Δ| = 16, match the exact camera projection (oracle)
    within 0.05 px p99.
  - Moving and deformed scenes at low resolution: the same check against
    analytic positions.
- **Chain breaks.** Disocclusion, an ID change and invalid `motion` end the
  chain. No tap is accepted beyond the break.
- **AOV frame skip.** A preview rendered between two pushes acts as a cut.
- **Epoch cuts.** No accepted taps across a light change.
- **Forced small budget.** The plan and output size follow the degradation
  order.
- **Device loss.** `push` rejects.

If any display composition code moves, run `npm run test:parity` as well.

## Code layout

| Path | Content |
| --- | --- |
| `src/temporal.ts` | Sub-path entry: `TemporalDenoiser`, `TemporalFrame`, option types (TSDoc with defaults) |
| `src/temporal/schedule.ts` | Pure window/epoch/readiness logic |
| `src/temporal/memoryPlan.ts` | Pure budget planner |
| `src/temporal/invalidation.ts` | Revision vectors |
| `src/renderer/WGPUTemporalHistory.ts` | Ring allocation, GPU capture |
| `src/renderer/WGPUTemporalWindow.ts` | Motion chains and direct window dispatch |
| `src/renderer/WGPUTemporalPost.ts` | Post stabilisation, flow and sparkle filter |
| `src/renderer/wgsl/temporal*.wgsl.ts` | Chain, window, post, flow, sparkle shaders |
| `src/Render.ts`, `src/Display.ts`, `src/renderer/WGPURenderingPipeline.ts` | Internal capture hook, external-HDR composition for denoising, `TemporalFrame` presentation |
| `package.json` `exports["./temporal"]`, library build entries | Sub-path |
| `docs/temporal-denoising.md`, `docs/api.md`, `docs/denoising.md`, `llms.txt`, `README.md` | Usage guide, API table, links, one `llms.txt` line |

There is no GLSL counterpart: WebGL is not supported. Native ports follow
only after the web feature is merged and reviewed.

## Implementation phases

| Phase | Work | Gate |
| --- | --- | --- |
| 0. Base | Branch from `dev`; bring in `62f94409` and `0ceab9eb` (`createOIDNFilter`); merge the reviewed `codex/motion-aov` work, including `motion.z` | Their unit and GPU tests pass on the branch |
| 1. Static port | Sub-path, API, scheduling, GPU-only capture, merged rings, internal composition path, window, OIDN, post, sparkle, WebGL rejection. Prototype world-position reprojection and storage formats | The dining-table archive, replayed through the library API, matches the archived adopted frames on ≥ 99.9% of pixels within one code (differences explained); unit tests; identity GPU test; four typechecks, `npm test` |
| 2. Robustness | The fixes above, each as a separate A/B | No dining-table regression beyond spread; many-ID GPU test |
| 3. Dynamic scenes | Replace the reprojection with chained `motion` in the window and the post stage; auto-invalidation, `cut`, auto cut detection; scenes 1 and 2 | Chain accuracy gate on the dining table (p99 ≤ 0.05 px at \|Δ\| = 16), then ghosting, stability and sharpness gates on scenes 1, 2 and the dining table |
| 4. Memory | Budget planner, degradation, OOM retry, `plan` | Unit plan tests; forced-budget GPU test; peak measured with renderer and OIDN live at 720p and 1080p |
| 5. Lighting | Scene 3; optional radiance-consistency test behind an internal switch | Scene 3 gates; unchanged results on static scenes |
| 6. Docs and examples | Guide, API, `llms.txt`, a small example; trim this note to algorithm and reasons | Doc review; full checks; `test:parity` if display code moved |

## Maintainer decisions

- **Reprojection.** Chained `motion`. The temporal module computes no
  correspondence of its own, and deformation support comes from `motion`.
- **Entry point.** The sub-path `@meimu/mutracer/temporal`.
- **WebGL.** Not supported. `push` rejects, with no per-frame fallback.
- **`stabilizeSparkle`.** Defaults to `true`, the adopted final.
- **HDR export.** v1 has no stabilised HDR export;
  `readPixels('accumulated')` is the HDR output.
- **Continuous light animation.** Documented with
  `historyInvalidation: 'manual'`. The radiance-consistency test waits for
  phase 5.
