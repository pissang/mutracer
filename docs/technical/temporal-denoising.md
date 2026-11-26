# Temporal denoising design

[Usage and limits](../temporal-denoising.md)

[Reflection motion in the offline window](./temporal-reflection-motion.md)

## Pipeline

1. Accumulate a finite window of resolved linear HDR frames. Each tap uses the
   original radiance from that frame, with tent weight
   `(R + 1 − |s − t|) / (R + 1)`. This bounds the lifetime of transient errors.
   The offline default increases radius from 8 to 16 as the circle of confusion
   grows above 2 pixels. The interactive default uses 17 past frames.
2. Run one spatial filter on the accumulation with the current frame's albedo
   and normal guides. OIDN receives composed display-linear color, matching
   per-frame OIDN. A custom denoiser receives accumulated native HDR.
3. Stabilize the denoised display image with radius-3 image matching. A motion
   prior initializes the search. The three-level match and low-frequency
   difference test determine the blend.
4. Remove isolated bright impulses using the temporal spread and a glint
   veto. Post and sparkle operate in display codes stored as floats.

At silhouettes, the mixed window weights bilinear coverage, searches for a
checked same-surface tap within 3×3 on nearby frames, and corrects mixed sky
contribution where the local background is consistent.

For current-frame metalness above 0.10, the surface window scales the tent
span `R + 1` by `smoothstep(0.05, 0.24, roughness)` using current-frame
roughness, then subtracts one to recover the radius. At roughness 0.05 and
below only the center sample contributes. At roughness 0.24 and above the full
window applies. The material history stores roughness and metalness in a
separate four-byte texel per pixel per slot. Virtual-image taps use the
original radius when reflection motion is enabled.

## Bright foreground silhouettes

A jittered beauty sample can hit a nearby foreground object when the pixel's
center ray hits the background. The background correspondence can be valid
while some of its radiance belongs to the foreground. This can leave a bright
trail after the foreground moves.

The offline window marks source pixels next to substantially nearer geometry.
If a matched tap is much brighter than the current center and nearby samples
with the same surface identity, the window reduces its weight. Two nearby
samples can support a bright value, so one noisy neighbor is insufficient.
The current frame and independently matched virtual reflections keep their
weights. Capture stores the foreground marker in the existing motion flags.

## Experimental geometry-guided sampling

The WebGPU stress capture and the native Node capture command share
[the TypeScript planner](../../src/temporal/offlineSamplePlan.ts). The pilot
traces one center ray per 4×4 output tile. Surface motion and optional
virtual reflection matches predict how much history each 4×4 tile can use.
The planner keeps the base beauty samples everywhere and assigns extra
samples to tiles with weak support. The shared window weights fully covered
matches by their sample counts. Recovered and partially covered taps retain
the regular weight.

[The Node capture driver](../../cli/src/offline-sampling.mjs) runs the native
pilot over the shot context, then replays it for beauty. `setup()` and
`frame({t, frame})` must produce the same descriptors for the same ordered
sequence. Declare hard cuts in the shot so the pilot breaks correspondence
at those boundaries. The native render target uses the existing adaptive
sample-count texture. [The native window](../../native/host/src/api/offline/gpu.rs)
keeps the tile counts with their history slots.

The experiment defaults to uniform sampling. The native capture uses hardware
traversal, a base of 3 spp, a cap of 8 spp per tile, and current-frame OIDN
guides with caustic estimators disabled. Tune supplemental sampling and
offline temporal quality on native before synchronizing stable results to
WebGPU.

## Why this design

The target is offline animation at a low fixed sample count (32 spp in the
reference work), with quality first and cost informational. On the 720p
dining-table close-up, per-frame OIDN drifts visibly from frame to frame. The
direct window followed by one OIDN pass and the post stage cut low-frequency
drift on the sideboard from 0.854 to 0.127. Against 1024 spp, it reached
39.5–40.0 dB full PSNR.

- **Direct window, not recursive history.**
  - A finite window reads each frame's own radiance, so a bad sample expires
    after `R + P` frames. With an exponential history, its lifetime is
    unbounded.
  - It also avoids feeding filtered output back into the history.
  - A symmetric window centers the temporal support on the output frame. The
    only lag left is the causal mode's one-sided support.
- **Accumulate before denoising.**
  - OIDN on the windowed mean sees much less noise than OIDN on one frame. It
    then keeps detail it would otherwise smooth, and stops inventing different
    structure in every frame, which is the source of per-frame drift.
  - Filtering each frame first and averaging the results afterwards keeps that
    drift.
- **One combined signal, not split lighting.** An NRD-style split was tested in
  two rounds: diffuse and specular radiance with separate radii, specular
  virtual-surface reprojection, and silhouette limits.
  - It improved brass, the sideboard and defocus drift.
  - It lost edge PSNR, and lost 0.6–1.8 dB on smooth steel cutlery. There,
    virtual landings pass every geometric test but carry a different
    reflection.
  - The split AOVs therefore stayed unmerged.
- **Smooth metals use a shorter window.** Reflected features move independently
  of the surface. Applying the full surface window to mirror-like hits left
  displaced copies of the checkerboard and emissive rods in the constructed
  scene and trails around the blinds and shelves in Bathroom. At 16 spp with
  a pinhole camera, removing the limit raised mirror-panel RGB RMSE from
  3.01 to 27.79 on the constructed scene. The shorter window limits the
  lifetime of mismatched samples and lets rougher metals average more history.
- **Post stabilisation.** The window removes most of the noise, but OIDN still
  adds small, frame-specific structure. Matching neighbouring denoised frames
  removes that structure, which halves the remaining drift. Image matching
  decides the blend; the motion prior only seeds the search.
- **Sparkle veto.** Fireflies that survive the window would flash for one
  frame. The filter clamps a bright residual only beyond the temporal spread,
  and a veto keeps glints that neighbouring frames confirm.

## Chained correspondence

The renderer's [`motion` AOV](./motion-aov.md) returns the displacement to the
preceding frame
and the preceding camera-forward depth. It supports rigid transforms, camera
projection changes and same-topology deformation. The window accumulates on
the capture grid, including any padding used by the renderer.

Past motion is bilinearly sampled among matching object, instance and material
IDs. Future positions use up to four fixed-point iterations to invert the
same backward field. The symmetric window can retry from a prior-frame motion
estimate and a local same-ID seed. Each inverse must converge below 0.05 px.

Every edge requires valid motion and adjacent normal agreement of at least 0.95.
The chain ends at a failed edge. At the landing, the window checks relative
depth within 1.5% and circle-of-confusion difference within 0.5 px. The symmetric
window samples the landing normal from the same-ID footprint as the motion.
The post and sparkle passes also trace consecutive motion.

Intermediate visibility can reduce sample count even when both endpoints are
visible. The earlier prototype projected stored world positions straight to
the endpoint. The chain preserves correspondence with moving and deforming
surfaces. Smooth, transparent contents can still change behind the center
surface.

Why the window chains `motion` instead of computing its own correspondence:

- **Reuse.** Every movement the renderer supports reaches the temporal window
  with no extra state in it: rigid transforms, projection changes, and
  deformation through the renderer's previous-vertex snapshot. The alternative
  (per-frame transform tables, barycentric coordinates and vertex snapshots
  kept by the denoiser) duplicated the renderer's work. It would also have
  kept geometry for the whole window.
- **Accuracy.** The prototype stored f16 world positions. That rounding alone
  gives landing errors of 0.22–0.45 px p99 at ±16 frames on the dining pairs.
  The chain measures p50 ≈ 0.0004 px and p99 ≤ 0.071 px on the same pairs.
  The ID-restricted bilinear sampling keeps the per-step error small enough
  that it does not compound visibly over 16 steps.
- **Per-step tests.** A rotating or deforming surface keeps history after its
  normal has turned far from the current frame, as long as each step agrees.
- **Cost.** Chaining rejects a surface hidden in any intermediate frame. At
  ±16 frames the chain accepted 94–96% of the prototype's taps. Those taps
  carry the smallest tent weight, and the image gates showed no loss.

## History invalidation

Each output window and its post neighbors stay within the same shot epoch.
Explicit cuts and skipped AOV frame sequences separate shots. Auto mode also
recognizes light, environment, background, visibility and scene membership
changes. A geometric camera cut measures one-step acceptance and cuts below
10% of covered pixels. Material parameter and graph changes separate history
for pixels whose center material revision changed. Manual mode retains
history across lighting changes. Geometric checks can accept taps from a
surface whose lighting has changed while it stays visible. Averaging those
taps can soften moving shadows and leave trails, including on self-shadowed
deforming geometry.

The current window uses geometric and revision checks. An experimental
per-tap radiance weight reduced ghosting on the deforming fixture but still
missed its ghosting and sharpness targets. A second experiment used
albedo-normalized radiance over two neighborhood scales to select a shorter
radius. It met the ghosting target (+0.194 display codes versus per-frame
OIDN) and nearly met the full-image PSNR target (−0.157 dB), with a larger
edge loss (−1.926 dB). Both experiments regressed paired drift on the
statically lit dining archive. The adaptive radius shortened history too
often and reduced full-image PSNR to 38.884 dB. Each pixel can incur up to
20 tests (five radii, two sides and two scales). At a roughly 5% false
rejection rate per test, independent tests would give about a 64% chance
of at least one false rejection. The tests share samples, and the spatial
standard error may be underestimated when pixels have correlated samples
or albedo guides. Future calibration can adjust for the number of tests
(for example, a 3.5 z-score limit or Holm correction) and estimate noise
from the renderer's per-pixel luminance moments. The first acceptance
condition is preserving paired drift on the static archive.

## Memory and latency

The planner accounts for the physical renderer extent, history and scratch
resources, presentation inputs pending post stabilization, and the bounded
four-frame finished queue. Renderer and OIDN allocations add to the temporal
estimate.

The window and post stages share HDR, motion, surface and ID slots. Offline,
the ring covers at least `max(2R, R + 2P) + 1` frames for window radius `R` and
post radius `P`. The `R + 2P` span keeps the earliest post tap available while
the window waits for future frames. The window and post stages use separate
half-float conversions of depth and normal within each slot to preserve their
correspondence behavior. Spatial guides expire after the window runs, when the
denoiser packs the presentation input. The post ring keeps the display image,
its blur and the matching pyramid.

Offline latency is the effective maximum history radius plus the post radius.
Interactive latency is zero.

When the budget or device limits require a reduction, the default offline
history drops 16→8→4→2, then post drops 3→2→1, then the final tier uses history
1 and post 0. A zero-history request remains zero. Allocation retries once
with the next eligible plan after an out-of-memory error.

## Regression gates

- Across each of the ten ±16-frame archive pairs, landing p99 must be at most
  the matched f16 world-projection prototype p99. Record the fraction above
  0.25 px, accepted taps and per-frame window weight. The GPU projection
  regression uses 0.1 px.
- On the dining archive, symmetric full PSNR is at least 39.47 dB. Region
  PSNR may fall by at most 0.1 dB from the pre-chain baseline. For drift, use
  the one-sided paired sign
  test on 35 sideboard pairs and 23 defocus pairs. A regression requires both
  a positive mean paired difference and p < 0.05. Deterministic repeats alone
  give no noise estimate. Compare f150 glints with a same-input post-only run.
  A confirmed highlight is lost if its contrast drops by at least one code
  and moves farther from the reference. The localized sideboard PSNR loss
  around a wine glass is an accepted exception to the regional limit.
- For the moving and deforming procedural fixtures, measure low-frequency
  drift in offline mode on a stable-surface mask derived from 1024 spp
  reference radiance. Use same-ID neighborhood luma and analytic correspondence
  across the tested lags. A surface ID's threshold is three times its
  reference noise RMS. Drift must be at most 0.5× per-frame OIDN. Record
  flicker as telemetry.
- The signed trail bootstrap interval must include or fall below zero, with
  a one-pixel delay as the positive control. A ×20 impulse in a 32×32 patch
  expires after the maximum history plus post radius. For the moving
  fixture in offline mode, ghosting MAE on moving silhouettes and
  disocclusions may rise by 0.5 display codes, full-image PSNR against
  1024 spp must match or improve on per-frame OIDN, and edge loss may be
  at most 0.3 dB. Record the interactive-mode quality measurements.
- In the deforming fixture, ghosting and sharpness loss from lighting
  changes on visible surfaces are known limitations. For future radiance
  detection, full-image and edge PSNR may fall by at most 0.15 and 0.3 dB
  respectively, and ghosting MAE may rise by at most 0.5 display codes,
  relative to per-frame OIDN.
- The lighting fixture checks accepted taps at light, visibility and material
  boundaries and compares auto to manual history.

## Lessons for evaluation

- Derive a precision gate from the error that the accepted result already
  carried. A tighter threshold without that basis, such as 0.05 px for chain
  landings, blocked a correspondence four times more accurate than the
  prototype's.
- A deterministic renderer repeats bit-exactly, so zero run-to-run spread does
  not bound noise. Judge drift changes per frame pair with a paired sign test,
  and pair it with a regional PSNR limit.
- Localize a regression by stage before tuning: OIDN input, post-only, and the
  full output, each against the baseline. Here a sideboard drift change looked
  like a post-stage problem, but it was already present in the window's OIDN
  input.
- Check detection power before building a test. At 32 spp the noise of a 5×5
  neighbourhood is about √(1024/32) ≈ 5.7 times the 1024 spp noise. A moving
  shadow on the deforming fixture's floor stays below 1σ per tap even 16 frames
  apart, yet it biases a ±16-frame mean. Tests need temporal and spatial
  averaging to have the power to see it.
- Test scenes with static lighting cannot reveal lighting-change failures.
  Keep a deforming and a lighting-change fixture beside the camera-move
  archive.
