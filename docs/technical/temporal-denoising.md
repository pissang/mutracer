# Temporal denoising design

[Usage and limits](../temporal-denoising.md)

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

The window gives smooth metals with roughness below 0.25 and metalness above
0.10 the current frame. At silhouettes, the mixed window weights bilinear
coverage, searches for a checked same-surface tap within 3×3 on nearby frames,
and corrects mixed sky contribution where the local background is consistent.

## Chained correspondence

The renderer's `motion` AOV returns the displacement to the preceding frame
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
surface. Refraction and a liquid surface in a wine glass account for a known
localized quality difference in the reference archive.

## History invalidation

Each output window and its post neighbors stay within the same shot epoch.
Explicit cuts and skipped AOV frame sequences separate shots. Auto mode also
recognizes light, environment, background, visibility and scene membership
changes. A geometric camera cut measures one-step acceptance and cuts below
10% of covered pixels. Material parameter and graph changes separate history
for pixels whose center material revision changed. A moving shadow or
reflection can change without corresponding center-surface motion. Manual mode
lets continuously lit sequences retain history at the cost of potential
temporal blur.

## Memory and latency

The planner accounts for the physical renderer extent, history and scratch
resources, and the bounded four-frame finished queue. Renderer and OIDN
allocations add to the temporal estimate. Separate capture, window and post
rings make the current footprint larger than the original merged-ring
estimate. Offline latency is the effective maximum history radius plus the
post radius. Interactive latency is zero.

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
  PSNR may fall by 0.1 dB from B2. For drift, use the one-sided paired sign
  test on 35 sideboard pairs and 23 defocus pairs. A regression requires both
  a positive mean paired difference and p < 0.05. Deterministic repeats alone
  give no noise estimate. Compare f150 glints with a same-input post-only run
  and retain confirmed highlights within one code.
- For the moving and deforming procedural fixtures, compare with per-frame
  OIDN in this order. Ghosting MAE on moving silhouettes and disocclusions may
  rise by 0.5 display codes. The signed trail bootstrap interval must include
  or fall below zero, with a one-pixel delay as the positive control. A ×20
  impulse in a 32×32 patch expires after the maximum history plus post radius.
  Low-frequency drift and flicker on stable surfaces target at most half the
  per-frame baseline. Full PSNR must match or improve on the baseline against
  1024 spp, with edge loss at most 0.3 dB.
- The lighting fixture checks accepted taps at light, visibility and material
  boundaries and compares auto to manual history.
