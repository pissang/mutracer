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

Capture marks source pixels next to substantially nearer geometry. The offline
window reduces a matched tap's weight when nearby pixels on that foreground
can account for its brightness and the current surface cannot. Two nearby
samples with the current surface identity can support a bright value, so one
noisy neighbor is insufficient. The check fades out as the circle of confusion
approaches one pixel, where a 3×3 neighborhood is less reliable. The current
frame and independently matched virtual reflections keep their weights.
Capture stores the marker in the existing motion flags.

## Experimental geometry-guided sampling

The WebGPU stress capture and the native Node capture command share
[the TypeScript planner](../../src/temporal/offlineSamplePlan.ts). The pilot
traces one center ray per 4×4 output tile. Surface motion and optional
virtual reflection matches predict how much history each 4×4 tile can use.
The planner keeps the base beauty samples everywhere and assigns extra
samples to tiles with weak support. For each signal, the window estimates radiance as
`Σ(aⱼ nⱼ X̄ⱼ) / Σ(aⱼ nⱼ)`. Here `aⱼ` is the existing temporal and confidence
weight, `X̄ⱼ` is the mean radiance of a tap, and `nⱼ` is its effective count
for weighting. Fully covered surface and virtual taps use the actual
sample count. A recovered or partially covered tap uses its frame's base
count because its coverage and correspondence make extra samples an
unreliable measure of confidence. Both sums use the same count. Scaling
all counts by the current base count leaves the ratio unchanged. When
all taps have the same base count and no extra samples, the usual window
weights are recovered. A constant signal is also preserved when coverage
changes the effective count.

This normalization preserves a common mean for fixed, signal-independent
weights and counts. Reprojection, confidence tests, and allocation based
on observations can change the estimate when tap means differ.

[The Node capture driver](../../cli/src/offline-sampling.mjs) runs the native
pilot over the shot context, then replays it for beauty. `setup()` and
`frame({t, frame})` must produce the same descriptors for the same ordered
sequence. Declare hard cuts in the shot so the pilot breaks correspondence
at those boundaries. The native render target uses the existing adaptive
sample-count texture. [The native window](../../native/host/src/api/offline/gpu.rs)
keeps the tile counts with their history slots.

The experiment defaults to uniform sampling. The native capture uses hardware
traversal, current-frame OIDN guides and caustic estimators disabled. The
supplemental ceiling is 8 spp per tile. A base at or above that ceiling
uses its requested count everywhere. Tune supplemental sampling and
offline temporal quality on native before synchronizing stable results to
WebGPU.

### Status and rejected allocators

Development is paused with the geometry predictor, a 4×4 pilot and 4×4
allocation. On smooth reflective metals it clearly lowers error at the same
total budget. Elsewhere it moves samples away from surfaces with adequate
predicted history. Their error then follows their reduced local sample count.
Its ghosting scores stay close to those of uniform sampling at the same local
sample count. Compare allocators at equal total budget, and judge each
region against uniform sampling at that region's actual sample count.

These variants were tested on native and not adopted. Their branches were
removed, so each entry records enough to rebuild it.

- **Two-stage sampling.** The variants below share this setup. Each frame first
  renders its base count while a reduction keeps per-tile luminance mean and
  variance. After the CPU allocation, rendering resumes on the same
  accumulation up to each tile's target. No base sample is discarded.
- **Measured variance.** Let `s` be the geometric support of a tile, `μ` and
  `σ²` its base-pass luminance moments, and `n` its current count. The
  display-scaled variance is `v = min(4, σ² / (0.04 + μ)^1.25)`. Each
  increment from `n` to `n+1` gets the benefit
  `p / (n(n+1))`, with `p = (prior + v) / s^1.3`. The prior is 0.25 where
  the geometry plan found weak history (`s < 1.5` and at least three extra
  samples), and 0.04 elsewhere. Once `s·n` meets the floor, a tile stops if
  `v < 0.12`. Otherwise its benefit is scaled by 0.3. Tiles that meet the
  floor at the base count may receive their first extra sample on at most
  1.5% of such pixels. Gains on lighting noise were small, and the second
  sampling stage added a noticeable per-frame cost. Reprojecting the previous
  frame's variance instead of pooling within the frame did not help.
- **Lighting rejection forecast.** The window's paired-patch lighting test
  compares the current base pass with up to four earlier frames and yields a
  per-tile rejected fraction `r`. Support becomes `1 + (s − 1)(1 − r)`,
  assuming the same loss on both sides, before the variance ranking. Its
  gain held only on the forecast's own mask. On masks built from the window's
  actual rejections, it raised error and diverted samples from reflections.
- **2×2 allocation.** Pilot and allocation ran on 2×2 tiles with the same
  ranking. Splitting the two grids showed the loss came from the finer
  allocation grid, not from the pilot resolution. Allocation also became
  several times slower. The sample texture accepts one-pixel tiles.
- **Ghost-risk ranking.** For each tile, compare the base-pass mean `μ` with
  the previous frame's tile `μ′` reached through the pilot links. Let
  `d = |μ − μ′|`, `e` the standard error of the difference and `j = μ + μ′`.
  Changes larger than the noise, `√(d² − e²)` beyond `0.015 j`, add risk.
  Changes whose normalized evidence `(d − 0.75e) / j` lies near the lighting
  test's 0.015–0.055 transition add a further boundary term. The risk is
  scaled by the history fraction `(s − 1) / s`. The ranking spends the geometry
  plan's extra budget. The variance benefit counts only up to the geometry
  plan's target, and tiles with risk may continue to the cap. The window also
  required stronger brightness support for same-surface taps next to nearer
  geometry. The fourth-brightest matching pixel in the 3×3 neighborhood had to
  corroborate them. Ghosting rose above both uniform and geometry allocation. In
  the segment examined, forcing every `nⱼ` to one removed more than half of the
  gap. A sampled frame is also history for its neighbors, so its extra samples
  raise `nⱼ` on taps that may be mismatched there. Revisit the count weighting
  before an allocator targets pixels that neighboring frames reuse as history.

More samples lower the ghosting scores mostly through the sampled radiance
itself, not through stricter rejection decisions.

The planner needs only `R` frames of lookahead, where `R` is the window
radius. Replaying the pilot with a rolling link buffer of `2R+1` frames gives
the same support and plans as the whole-shot pilot. A streaming `push()` path
would need pilot state separate from the beauty scene. It does not exist yet.

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

For offline auto invalidation, each capture compares the authored emission RGB
of visible mesh materials with the preceding capture. A channel change of at
least one third of the larger peak RGB value starts a new lighting revision,
with a floor of 0.01 on the peak value. This uses the emission color and
luminance controls. Texture and graph animation can require explicit cuts.
The comparison retains the preceding capture's emissive values. The window
uses paired radiance patches for taps across the revision. Display
stabilization uses neighbors within the same revision.

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
- Native live renders with Metal hardware traversal are not bit-exact. The
  same build and seed can differ at isolated raw HDR pixels, reproducible at
  one sample per pixel with two bounces. Frozen replay is the byte-for-byte
  check. Same-seed repeats measure only this build noise, not sampling noise.
  A signed ghosting projection on one fixed seed can change sign between
  sample counts. Small differences need several seeds before they can gate
  a change.
- Build evaluation masks independently of the method under test. A mask
  produced by an allocator's own forecast rewards that forecast.
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

### Offline artifact scan

[How to run the scan](../../native/CONTRIBUTING.md#offline-temporal-artifact-scan)

The quick scan compares the temporal output with a same-settings, same-sequence
per-frame cleanAuxLarge OIDN capture. It measures the displayed sRGB codes in
luminance and two half-scale opponent channels, using the largest absolute
component and a local 3×3 RMS. Backward motion lands in the previous frame.
Require valid motion, a matching object, instance and material at the nearest
pixel and at least 60% bilinear support from the same IDs. Only those
correspondences contribute to the measurements.

**Flicker.** For each output, blend the aligned difference with half the change
in that difference, using weights of 0.65 and 0.35 wherever three frames agree
on the trajectory. Use the first difference on shorter tracks. Compare the
temporal measurement with the OIDN measurement. The initial thresholds require
two display codes and at least 80% of the per-frame OIDN change. The absolute
floor suppresses quantization-level activity. The relative threshold treats
weak improvement over independent filtering as evidence for review.

**Trails.** Subtract OIDN from the temporal result. The strongest residual
component must carry the same sign over three aligned frames. Its sign must
also agree with an older image at that screen position. Subtract signal that
the old motion-aligned OIDN image already explains. Require at least 0.35 px of
surface motion or a nearby change in screen-space identity. The initial
three-code floor and cross-frame sign test reduce isolated OIDN outliers.
Persistent spatial-filter bias and reflected features without a visible
surface trajectory can still confuse this comparison.

A bright silhouette has additional evidence when a different foreground ID
occupied the screen position within the last ten frames. Subtract a 10-pixel
Gaussian from a 1.1-pixel Gaussian of the luminance residual and seek a
positive result along the receiving surface for three frames. Bound its score by one tenth of the contrast
available from the old foreground. Require eight display codes and three
pixels per tile to record the prior foreground ID. This corroborates
contrasty trails that extend past an old silhouette. The reference threshold
sweep evaluates the general trail measure. With both history and post radii
set to zero, classify residual differences as spatial error or flicker.

**Decisions.** Compare the surface and reflected acceptance masks at the same
signed tap offsets across aligned frames. Count switches among offsets
considered in both windows. Measure the fraction of comparable pixels with
any switch and count offset reversals across three frames. Highlight regions
when at least 20% of their comparable offsets switch and the local frame
change exceeds the flicker floor. Window histograms count tap restrictions
independently, including partial confidence reductions. Where the surface
window is effectively closed and reflected history remains, prioritize
reflection checks for the main evidence. Sparkle readback measures the local
correction and glint veto after post stabilization.
These observations identify candidate causes for an A/B test. A busy check may
also be correctly rejecting an unstable signal.

Eight-pixel tiles need at least six qualifying pixels of the same center
identity. Join adjacent tiles and track them by motion-projected overlap for
at least three observations. Severity combines the strongest frame's 90th
percentile score relative to the thresholds with the logarithm of affected
pixel-frames. Authored events intersect both the frame range and spatial
selector. Explicit cuts end trajectories. Annotations cover known changes
only where the shot author describes their effect. Indirect light and
reflections can extend past those regions and times.

**Reference calibration.** Use a fixed-seed 256-spp reference with the same
OIDN weights and display path. The zero-radius, zero-post capture isolates
each reference frame. Along a valid trajectory, subtract the reference
signal from the temporal output. The five-frame trailing mean is the
low-frequency error. Subtract that mean from the current error to obtain
the high-frequency error. Five frames cover about 210 ms at 24 fps, enough
for several reversals while limiting drift across motion and local changes.
A low-frequency trail additionally needs a majority of sign-consistent
errors, past reference appearance consistent with the trail and a larger
current error than the OIDN arm. Other low-frequency errors are bias.

Use the same tile size and minimum pixel count to compare quick and reference
masks on covered frames. Precision is the fraction of quick-positive tiles
also positive with reference. Recall is the fraction of reference-positive
tiles also found by quick scan. The search varies amplitude and OIDN ratio
thresholds and reports the best F1 on those frames. These are frame-tile
measurements, so a long track can contribute many observations. Verify tuned
thresholds on held-out footage before using them as review gates. A
candidate-selected reference range can give an optimistic coverage estimate.

[ColorVideoVDP v0.5.7](https://github.com/gfxdisp/ColorVideoVDP/tree/v0.5.7) is
[MIT-licensed](https://github.com/gfxdisp/ColorVideoVDP/blob/v0.5.7/LICENSE).
It can supply display-dependent full-reference visibility estimates as an
external tool. The scan uses display codes so it can run without a calibrated
viewing model and keep distinct measurements for flicker, trails and history
decisions.
