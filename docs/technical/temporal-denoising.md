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

## Algorithm kept from the prototype

Per output frame *t*:

1. **Direct window in linear HDR.** Every neighbor frame *s* in the window is
   reprojected once, nearest texel, into *t*. No recursive history.
   - Validation of a tap: same object, instance and material ID; normals within
     `dot ≥ 0.95`; tangent-plane distance ≤ 1.5% of depth; circle-of-confusion
     difference ≤ 0.5 px; on screen and in front of the camera.
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
| `temporal` | `false` when running the WebGL per-frame fallback |
| `dispose()` | Release GPU resources and the OIDN lease. Safe to repeat |

`attach(render)`:

- Registers an internal AOV request on the render, in the same way as custom
  denoiser `aovs`: the passes run, but `render.aovs` is unchanged.
- Warns once if the render has its own denoiser on WebGPU: its result is
  ignored and the inference is wasted.
- On WebGL it applies `fallbackDenoiser` with `render.setDenoiser`. Detaching
  restores the previous configuration.

`push(render)` rejects when:

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
| `fallbackDenoiser` | `{type: 'jnlm'}` | Per-frame denoiser for the WebGL fallback; `null` leaves frames unfiltered |

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

### What reprojection needs

The window needs, for each pixel *x* of frame *t* and each neighbor *s* in
`[t − R, t + R]`, where the pixel-center surface point of *x* lies in *s*. Three
properties matter:

1. **Arbitrary frame distance, both directions.** The symmetric window reaches
   16 frames into the future.
2. **No resampling drift.** The accepted result depends on exact reprojection.
3. **Sub-pixel precision.** Nearest-texel selection and bilinear coverage use
   the fractional position.

The public `motion` AOV gives previous-minus-current pixels for one step back.
Chaining it 16 times resamples the motion field at every step. It cannot give
forward correspondence without inverting a scatter. So the temporal feature
does not reproject by chaining `motion`. It uses the per-pixel surface
correspondence that a correct `motion` AOV is itself computed from.

### Surface correspondence contract

From the renderer, per pixel-center hit of frame *t* (the same unjittered ray
as `centerPosition`, `id` and `motion`):

| Field | Purpose |
| --- | --- |
| object, instance, primitive (`id`) | Find the surface in any frame |
| barycentric `(u, v)` on the source triangle | Re-evaluate the point on deformed geometry |
| world position (f32, camera-relative in storage) | Rigid fast path and plane test |

The temporal denoiser also keeps, per captured frame:

- the camera (view-projection, CoC parameters);
- a table of object and instance world transforms, keyed by AOV object ID;
- for meshes whose vertex revision changed inside the window, a snapshot of
  their deformed vertex positions.

The point in frame *s* is then:

- **Rigid** (vertex revision unchanged between *s* and *t*):
  `M_s · M_t⁻¹ · p_t`, projected with the camera of *s*. For static objects this
  is exactly the prototype's reprojection, so the static results are preserved.
- **Deformed:** interpolate the snapshotted triangle vertices of *s* at
  `(u, v)`, transform with `M_s` and project.
- **Topology changed, or deformation snapshots over budget:** current frame
  only for that object.

Validation in *s* is unchanged: ID, normal, plane distance, CoC and on-screen
tests at the projected texel. This also catches occlusion in *s*.

What the temporal feature needs from the parallel `motion` work:

- **Shared correspondence.** `motion` must be computed from this same
  correspondence (rigid transforms plus deformed vertex positions, with the
  grazing-angle visibility test), so that both outputs agree. Test: for
  adjacent frames, `project_{t−1}(point) − x` equals `motion.xy` within
  1e-3 px wherever `motion` is valid.
- **Barycentrics.** An internal center-AOV lane, not a public kind.
- **Projection changes.** A change of projection (focal-length animation,
  dolly-zoom) must not invalidate correspondence; today it invalidates
  `motion`. The temporal path uses each frame's own camera, so it does not
  depend on this, but the `motion` agreement test does.
- **Frame identity.** `motion` history advances per AOV frame. The temporal
  denoiser records which AOV frame each push captured. It treats a push whose
  AOV history did not advance by exactly one frame as a cut for the `motion`
  agreement check only.

If deformation support in the renderer is not feasible, the fallback above
(current frame only for deformed objects) ships, and the deforming test scene
checks that those pixels show no ghosting.

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

The temporal path is WebGPU only. On WebGL:

- the constructor warns once per engine;
- `temporal` is false;
- `attach` applies `fallbackDenoiser` to the render;
- `push` captures the render's final per-frame result;
- `drain` yields it immediately (`latency` 0) in both modes.

The push/drain/flush contract is identical, so application code needs no
branch.

## Memory

The prototype allocates two rings per mode (a pre ring plus the window ring)
and holds 16-bit IDs, f16 world positions and 8-bit post history. The library
merges the rings and fixes the precision issues. Estimated bytes per pixel per
slot:

| Data | Format | Bytes/px | Slots (offline default) |
| --- | --- | ---: | --- |
| HDR radiance | rgba16f + overflow table | 8 | `2·Rmax + 1` = 33 |
| Surface: camera-relative position, depth, normal, CoC/cap lane | rgba32f + rgba16f | 24 | 33 |
| IDs + packed coverage/albedo guide | rgba32uint | 16 | 33 |
| Barycentrics (dynamic scenes) | rg16unorm | 4 | 33 |
| OIDN guides (albedo, normal) | rgba16f ×2 | 16 | `Rmax + 1` = 17 |
| Post history: display, blurred, pyramid, surfaces, IDs | mixed | ≈ 60 | `2·postRadius + 1` = 7 |
| Scratch: sums, outputs, OIDN buffers, flow grids | f32 | ≈ 100 | 1 |

That is about 2,510 B/px for the default offline plan:
`33·52 + 17·16 + 7·60 + 100`.

The interactive plan is about 1,290 B/px:

- 18 history slots;
- current-frame guides only;
- 4 post slots.

| Resolution | Offline default | Interactive (17 past + 3 post) |
| --- | ---: | ---: |
| 1280×720 | ≈ 2.3 GB | ≈ 1.2 GB |
| 1920×1080 | ≈ 5.2 GB | ≈ 2.7 GB |
| 3840×2160 | ≈ 21 GB | ≈ 10.7 GB |

The prototype measured 1.70 GiB at 720p for its A2 replay buffers. The
estimate is higher because it uses 32-bit IDs and f32 positions and adds
barycentrics. If phase 2 shows that camera-relative f16 positions are exact
enough, the surface lane drops to 16 B/px (about −0.25 GB at 720p).

The renderer, the AOV passes and the OIDN network come on top of this.
Deformed-vertex snapshots add 12 bytes per vertex per slot, for deformed meshes
only.

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
  1000 units). Store camera-relative f32 positions.
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
   over a textured floor. Run with deformation support and with the
   current-frame fallback.
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
- the WebGL fallback warning and the attach/detach denoiser restore.

GPU tests (`tests/gpu/temporalDenoise.{html,ts}`, headless Chrome, WebGPU and
`?webgl`):

- **Identity.** Window radius 0 and post 0 equal the render's built-in
  `cleanAuxLarge` output.
- **Static reprojection.** Projected positions match `centerPosition` in the
  target frame within 1e-4 relative.
- **Motion agreement.** Adjacent-frame correspondence equals `motion` where
  valid.
- **Moving and deformed correspondence.** Correspondence on scenes 1 and 2 at
  low resolution.
- **Epoch cuts.** No accepted taps across a light change.
- **Forced small budget.** The plan and output size follow the degradation
  order.
- **Device loss.** `push` rejects.
- **WebGL.** Per-frame fallback output equals the render's JNLM result.

If any display composition code moves, run `npm run test:parity` as well.

## Code layout

| Path | Content |
| --- | --- |
| `src/temporal.ts` | Sub-path entry: `TemporalDenoiser`, `TemporalFrame`, option types (TSDoc with defaults) |
| `src/temporal/schedule.ts` | Pure window/epoch/readiness logic |
| `src/temporal/memoryPlan.ts` | Pure budget planner |
| `src/temporal/invalidation.ts` | Revision vectors |
| `src/renderer/WGPUTemporalHistory.ts` | Ring allocation, GPU capture, transform/vertex tables |
| `src/renderer/WGPUTemporalWindow.ts` | Direct window dispatch |
| `src/renderer/WGPUTemporalPost.ts` | Post stabilisation, flow and sparkle filter |
| `src/renderer/wgsl/temporal*.wgsl.ts` | Window, correspondence, post, flow, sparkle shaders |
| `src/Render.ts`, `src/Display.ts`, `src/renderer/WGPURenderingPipeline.ts` | Internal capture hook, external-HDR composition for denoising, `TemporalFrame` presentation |
| `package.json` `exports["./temporal"]`, library build entries | Sub-path |
| `docs/temporal-denoising.md`, `docs/api.md`, `docs/denoising.md`, `llms.txt`, `README.md` | Usage guide, API table, links, one `llms.txt` line |

There is no GLSL counterpart: WebGL falls back by design. Native ports follow
only after the web feature is merged and reviewed.

## Implementation phases

| Phase | Work | Gate |
| --- | --- | --- |
| 0. Base | Branch from `dev`; bring in `62f94409` and `0ceab9eb` (`createOIDNFilter`); agree the correspondence contract with the `motion` work | Their unit and GPU tests pass on the branch |
| 1. Static port | Sub-path, API, scheduling, GPU-only capture, merged rings, internal composition path, window, OIDN, post, sparkle, WebGL fallback. Static reprojection, prototype storage formats | The dining-table archive, replayed through the library API, matches the archived adopted frames on ≥ 99.9% of pixels within one code (differences explained); unit tests; identity GPU test; four typechecks, `npm test` |
| 2. Robustness | The fixes above, each as a separate A/B | No dining-table regression beyond spread; large-coordinate and many-ID GPU tests |
| 3. Dynamic scenes | Transform-table rigid correspondence, deformation via barycentrics (or the current-frame fallback), auto-invalidation, `cut`, auto cut detection; scenes 1 and 2 | Ghosting, then stability, then sharpness gates on scenes 1, 2 and the dining table |
| 4. Memory | Budget planner, degradation, OOM retry, `plan` | Unit plan tests; forced-budget GPU test; peak measured with renderer and OIDN live at 720p and 1080p |
| 5. Lighting | Scene 3; optional radiance-consistency test behind an internal switch | Scene 3 gates; unchanged results on static scenes |
| 6. Docs and examples | Guide, API, `llms.txt`, a small example; trim this note to algorithm and reasons | Doc review; full checks; `test:parity` if display code moved |

## Open questions

- Reprojection source: surface correspondence plus transform tables, with
  `motion` as a cross-check, rather than chained `motion` vectors.
- Sub-path entry `@meimu/mutracer/temporal` versus the main entry.
- `stabilizeSparkle` default `true` (the adopted final) versus `false` (the
  prototype default).
- `attach` mutating the render's denoiser on WebGL.
- No stabilised HDR export in v1.
- Continuous light animation without a radiance test.
