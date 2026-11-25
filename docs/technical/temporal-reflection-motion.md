# Reflection motion in the offline window

[Temporal denoising usage](../temporal-denoising.md)

The combined-color window tracks the visible surface. A highlight or reflected
object can move independently of that surface. The legacy cap restricts smooth
metals to the current frame and leaves dielectric reflections on surface
motion. This gives dissimilar history to materials with nearly the same
reflection lobe and leaves the capped pixels noisy.

## Earlier split window

Stage 1 compared recursive history with the finite A2 window. Repeated
resampling and accumulation introduced blur and bias, so Stage 3 and 3b used
the original captures in a finite window. Both recombined the two signals before
a single OIDN pass and ran the same display stabilization afterward. Stage 3
also tried history clamping and a small depth- and normal-weighted 3×3 spatial
fill before OIDN. These were optional replay variants.

Stage 3 demodulated diffuse and specular by separate guides and gave specular a
shorter, roughness-dependent radius. It limited both radii at silhouettes,
required a full 2×2 same-surface footprint, and sampled the nearest texel at a
single position interpolated between the two projections. It placed the
virtual sample at the first surface plus the jittered specular hit distance
along the view ray. The tap checked material, normal, depth, circle of
confusion and coarse hit-distance agreement. Different objects can reflect at
similar distances or share a material. A geometric match on the reflector
could therefore select a different reflection on a curved steel utensil.

The replay added transmission, emission and light-traced caustics from the
current frame. In the prior A2 run, the metal cap already passed most of the
dielectrics through the full combined-color window. Shortening their windows,
keeping the residual at one sample set, and rejecting silhouette taps removed
support that A2 had kept. The surviving summaries record edges darkening on
both sides, losses of 0.6–1.4 dB on glass, and 0.6–1.8 dB losses on steel cutlery
across split variants. Stage 3b restored A2 outside the cap and feathered the
transition. This isolated the capped region but retained the virtual landing
and reflected-content ambiguity there. Per-pass captures are unavailable, so
the individual contributions to the measured edge error cannot be quantified.

The new window keeps the A2 geometry and coverage checks for the surface
tap, including 2×2 coverage weighting, nearby 3×3 recovery, sky correction and
the adaptive circle-of-confusion radius. It reads an additional reflection
candidate and blends the weights of the two checked samples. The residual
stays in the surface window. OIDN runs once on the sum, followed by the
existing post stabilization and sparkle veto.

## Radiance and center-ray capture

The path-radiance AOV work in `aed9397f` and `f4c9dde3` established where to
split along the primary path and how to keep both signals on the beauty
sample sequence. The offline window needs only one extra radiance buffer.
It records reflected radiance and obtains the surface-motion signal by
subtracting that component from resolved HDR.

The reflected component includes the first-surface dielectric, conductor,
coat and fuzz lobes. Next-event estimation uses the same candidate selection,
shadow test, and MIS terms for the reflection and beauty. A sampled continuation
carries the reflected fraction of the full BSDF response evaluated at its
direction. Keeping the fraction of the response preserves the split when a
sampled direction is shared by several lobes. The remainder contains diffuse
and subsurface scattering, primary emission, camera-visible photon gathers
and the separate light-tracing accumulation. Paths that first transmit
through glass stay in the surface window, while light reflected by glass
can follow its virtual image. Thick, curved and layered glass do not fit a
parallel slab, so this experiment uses the existing transmission behavior.

Native scene target preparation calls the shared WGSL generator through the
`sceneTargetParameters` export in `native/src/render-core-profile.json`.
The same archive supplies the temporal compute shaders via
`postprocessParameters`. The enabled target writes a separate RGB sum on the
same beauty invocations and with their clamping and sample normalization.
The legacy target has its original output bindings.

The primary AOV traces through the pixel center with a pinhole ray. It traces
the first reflected segment from the resolved shading normal, with coat
influence where present. It uses the reflected hit and reflector tangent plane
to find a virtual image, following MuTracer's DLSS integration
(`ec0f0c3c`, `0d8a6fdc`, `3c88cf39`). The surface and reflected endpoint
each use their own previous rigid transform. The record keeps the reflected
instance and mesh IDs, the segment distance, roughness and view cosine, and
both planar and curvature-adjusted previous-frame displacements. A miss can
represent illumination at infinity. Reflection motion across a deformation
falls back when the rigid transforms cannot describe the two points.

For the curvature candidate, a nearby pinhole ray samples the normal along
the first-order parallax direction. The directional normal derivative
`dot(ΔN, ΔP) / dot(ΔP, ΔP)` estimates curvature. The thin-lens correction
scales the apparent distance as a function of curvature, hit distance and
view cosine. At a focal singularity the planar candidate remains available.

## Window weighting

Each neighbor uses the original captured HDR values. The surface tap uses the
A2 motion chain. The second tap follows the virtual displacement backward or
inverts the backward field for future frames. Every step checks the reflector,
reflected instance and hit-distance consistency. The landing also checks the
reflector's normal, depth, circle of confusion and 2×2 footprint. A continuous
roughness- and view-dependent weight scales the virtual candidate, with
confidence reduced by normal angle, roughness change, hit-distance change
and mixed coverage. This follows the two-history weighting in NVIDIA's
[RELAX temporal accumulation](https://github.com/NVIDIA-RTX/NRD/blob/master/Shaders/RELAX_TemporalAccumulation.cs.hlsl).
The curvature comparison follows the thin-lens behavior described in
[NRD Common.hlsli](https://github.com/NVIDIA-RTX/NRD/blob/master/Shaders/Common.hlsli).

The enabled window omits the metal cap. The surface residual and reflected
radiance each have a sum and a weight, initialized with the current frame.
The surface and virtual taps contribute separately to the reflection sum.
Reflection history loses weight when the surface tap slips relative to the
virtual field and its endpoint differs. The recombined color keeps the
current frame's alpha and enters the same spatial and display passes.

## Allocation and validation

The extra history uses 40 bytes per pixel per slot. The formats are
`rgba16float` reflected radiance, `rgba32uint` endpoint metadata and
`rgba32float` optical motion. At 1280×720 and radius 16, the 33 slots add
1,216,512,000 bytes. The reflection sum, capture tail and beauty output add
64 bytes per pixel, with another 16 bytes budgeted for a native sampling
checkpoint. The plan therefore reserves 1,290,240,000 extra bytes
(1,230.47 MiB). The existing memory-budget tiers reduce the radius as needed.

The opt-in native path is evaluated against A2 and an uncapped combined-color
control. Compare planar and curvature-corrected landings with the same seeds and
lens settings. Validate highlights, thin reflective objects and mixed edges
against higher-sample frames. Report memory and frame-time distributions
alongside the image gate.
