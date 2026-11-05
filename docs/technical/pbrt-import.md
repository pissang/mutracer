# PBRT import mapping

This contributor note describes the viewer/tool importer. Usage and limits are
in [the tool guide](../../tools/pbrt/README.md).

## Coordinates and state

The reference is `mmp/pbrt-v4@b0bdf461ba5dd6504b70ebf0932acc0fe7aa744f`.
PBRT's camera looks along local +Z. With `M = diag(1,1,-1,1)`, geometry uses
`M * objectToWorld` and the Three camera uses `M * cameraToWorld * M`.
The world reflection is baked into geometry so emissive triangles have consistent
world-space winding and normals. The winding changes when the baked transform
changes handedness, XOR `ReverseOrientation`; explicit normals only change sign
for `ReverseOrientation`. Triangle winding is then face-forwarded to shading
normals, matching PBRT meshes with authored N. Instances retain shared geometry
and use `M * T * M`.
Loop shapes refine the control mesh and push vertices to the limit surface;
area-weighted normals approximate the reference limit-surface tangents.
A reflection is absorbed into a geometry variant for negative instance transforms.

`LookAt` sets world-to-camera, so its inverse is captured at `Camera`. `WorldBegin`
resets the object transform. Include filenames and all asset filenames resolve
against the main scene directory, as `SetSearchDirectory`/`ResolveFilename` do.
`Import` inherits graphics state but restores it afterward; definitions and scene
objects remain. Deprecated transform blocks follow PBRT-v4's attribute-block
rewrite. Only the start transform is retained for animated scenes.

## Camera and microfacets

For aspect `a = width/height`, the vertical field of view is `fov` when `a >= 1`,
otherwise `2 atan(tan(fov/2)/a)`. Lens conversion uses a 24 mm sensor height:
`focalLength = .024/(2 tan(verticalFov/2))` metres and
`fStop = focalLength/(2 lensRadius)` for metre scene units.
The focus distance stays in scene units. The linear exposure multiplier is
`ISO/100 * (shutterClose-shutterOpen)`. Film exposuretime is not a PBRT-v4
parameter and is warned and ignored, as is whitebalance. Unsupported sensors
produce a separate warning.

The pinned `TrowbridgeReitzDistribution::RoughnessToAlpha` returns `sqrt(r)`.
Since OpenPBR uses `alpha = roughness²`, the imported roughness is `r^(1/4)` with
remapping and `sqrt(r)` without it. For anisotropic alphas, the scalar roughness
is `((alphaU²+alphaV²)/2)^(1/4)` and anisotropy is
`1-min(alphaU,alphaV)/max(alphaU,alphaV)` (zero for two zero axes). This inverts
OpenPBR's RMS-preserving formula for both base and coat. The larger alpha is
assigned to the tangent axis; rotation is π/2 when v is larger, so u stays dpdu.
Anisotropic meshes also carry UV-derived tangents for the zero-rotation path.

## Colors and light units

RGB inputs are linear sRGB. RGB illumination preserves the RGB multiplier;
PBRT normalizes the illuminant separately in `SpectrumToPhotometric`. The pinned
implementation does **not** multiply this integral by 683. The Film's CIE sensor
integrates the emitted spectrum; this cancels the illuminant normalization for
white light. Consequently a point light's RGB intensity maps directly to the
zero-radius SphereLight intensity, and an area light's RGB radiance maps to mesh
emission. Spot cone angles are half angles and use cosine smoothstep on both sides.
Distant intensity is irradiance facing the light. Sphere emitters retain meshes:
MuTracer analytic sphere lights currently do not supply visible primary-ray
emission, and adding a second emissive sampler would count the source twice.

Power multiplies point intensity by `power/(4π)`. For a spot it multiplies by
`power/[2π(1-(cos(inner)+cos(outer))/2)]`. Area-light power divides by
`π * area * (twosided ? 2 : 1)`. Image emission also requires texture-average
normalization; that case remains an approximation. Constant environment
illuminance multiplies radiance by `illuminance/π`. Image illuminance follows
the pinned renderer's `2π/N * sum(Y(pixel)*max(z,0))` normalization in light space.

Named optical data and CIE/D65 tables come from the pinned Apache-2.0 source.
Conductor normal and edge reflectances integrate Fresnel at cosines 1 and 1/7
under D65, then convert XYZ to linear sRGB. OpenPBR takes an F82 **tint**,
so the edge value is divided by `F0+(1-F0)*(6/7)^5` and limited to [0,1]. Glass uses interpolated eta at
587.56 nm and Abbe `(etaD-1)/(etaF-etaC)`, at 486.13 and 656.27 nm.
Blackbody emission is normalized to unit luminance before light scaling.
An RGB renderer and PBRT's spectral renderer can retain material-dependent
biases; comparisons report them without changing either renderer's algorithms.
Coated conductor inputs keep `conductor.*` substrate parameters separate from
`interface.*` coat parameters. Both roughness layers use the same remap rule;
optical constants are read as curves from named data or SPD files before Fresnel
integration. Coat IOR and anisotropy use the existing OpenPBR metadata fields.

For coefficient-based subsurface materials, each RGB extinction mean free path is
`1 / (scale * (sigma_a + sigma_s))`. The largest channel becomes the OpenPBR
radius and channel ratios become radius scales. Single-scattering albedo
`sigma_s / (sigma_a + sigma_s)` is converted to the artist-facing subsurface color
by inverting the existing material packer's mapping. Authored diffuse reflectance
is already an effective scattering color. These mappings preserve the RGB medium
coefficients but do not reproduce PBRT's spectral diffusion model.
Interior homogeneous media encode total extinction, not absorption, in
transmission color: choose depth `d=1/max(1,max(sigma_t))`, set color
`exp(-sigma_t*d)` and scatter color `sigma_s/sigma_t`, with scaled coefficients.
This preserves the existing packer's coefficients without hitting its color floor.
`MediumInterface` orders inside then outside. The geometric normal points toward
outside, after ReverseOrientation and handedness. The importer rejects scenes
with a camera medium. If only an outside medium remains, conversion flips
winding and normals together and encodes it as the material interior. Two
media cannot be represented: conversion warns and uses inside only.
Material variants include both names to avoid sharing different boundaries.

The extra medium-side reversal reciprocates thick dielectric IOR: PBRT's
DielectricBxDF exchanges eta across its final normal. ReverseOrientation and
coordinate handedness already affect both normals and do not independently
reciprocate IOR. ThinDielectricBxDF uses AbsCosTheta and keeps eta unchanged.
Base specular IOR below one survives Three conversion and material packing;
both backends use the ratio for Fresnel, total internal reflection and refraction.
Coat IOR is clamped to at least one and the coat is exterior-only, so reversed
coats and coat IOR below one receive an ior-orientation warning and are excluded
from strict comparison. Reciprocal spectral dispersion retains the original
Abbe number, but a reciprocal Cauchy curve is not itself the same Cauchy fit;
this receives an ior-dispersion approximation warning and comparison exclusion.

Ordinary PBRT surfaces accept primary back-face hits. One-sided area emission
uses FrontSide because MuTracer couples primary visibility and emission sidedness;
its missing back-side surface visibility is warned about.

PBRT image textures evaluate `(s,1-t)`. Decoded images use top-down rows and
Three textures set `flipY=true`. Infinite lights use the equal-area square map,
reprojected to world-space latitude/longitude. The direct importer uses nearest
source lookup to match ImageInfiniteLight. Each target texel averages 4×4
jittered samples uniform in azimuth and cos(theta), then per-channel spherical
integrals correct residual quadrature energy error. Source texels use area 4π/N;
target bands use exact cosine differences. This preserves small bright features'
total energy while approximating their subpixel distribution. The existing glTF
metadata adapter retains its previous bilinear reprojection.

Material displacement uses forward UV finite differences with PBRT's `.0005`
fallback step, including scalar texture scale and UV repeat. The image-row
v derivative changes sign for `(s,1-t)`. The result is a tangent normal
`normalize(-dh/du,-dh/dv,1)`, never a geometric height field. This static bake
assumes unit tangents and omits footprint-dependent steps and curvature terms;
it is warned and excluded from strict comparison. Only shape displacement uses
the height-field mapping. In the pinned `interaction.cpp`, NormalMap and BumpMap
are alternatives (`if/else`): normalmap takes precedence when both exist.

## Comparison and memory

Ordinary byte color maps retain their original data and declared color space;
unmodified linear HDR maps also share decoded pixel data. Scale graphs carry
separate multipliers. Scalar and transformed maps retain
floating-point values. Rectangular/non-power-of-two height fields are resampled
to the existing displacement layout, with a warning.

The comparison sets PBRT's pixel filter to box with radius 0.5 to match MuTracer's
uniform pixel jitter. It overrides spp and output resolution, removes Film crop
windows and pixel bounds, preserves maxdepth,
sets an opaque black background when no environment exists, removes Film sensor exposure from the reference HDR and never tone maps numerical
inputs. AOV material IDs identify approximate surface regions. This primary-hit
mask does not isolate indirect paths that touch approximate materials. PBRT uses
seeds 0/1; MuTracer uses disjoint sample blocks starting at 0/N with the same Sobol
scramble. Their difference gives a diagnostic noise estimate, not independent
Monte Carlo replicas or statistical proof of equivalence.
Whole-frame RMSE retains every comparable pixel and its noise margin. Regional
material/tile tests exclude discontinuities in object, instance or material IDs,
dilated by one pixel. Their statistic is absolute channel mean bias / standard
error, with threshold 6. Standard error is sqrt(sum of per-pixel replica-difference
variances) / pixel count; squaring a region-sum difference instead gives an
unstable single observation. Whole-frame and regional statuses are separate.
Each MuTracer run uses a fresh Chrome process to avoid retaining both scenes' caches
and allocations during memory measurement.

Text and gzip Includes are decoded by statements to avoid the single-string size
limit. The viewer parses them and PLY data in a Worker. Inline P/N/UV/index
arrays become
transferable typed views before leaving the Worker; statement locations share
the same parameter objects. Binary assets are prefetched six at a time before
conversion; progress sums completed and in-flight bytes. The download preflight
uses unique encoded input sizes and an 8x expansion estimate against an 8 GiB
working budget. This estimate is deliberately conservative and cannot predict
total process/GPU memory or prevent every browser allocation failure.
