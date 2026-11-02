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
for `ReverseOrientation`. Instances retain shared geometry and use `M * T * M`.
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
`ISO/100 * (shutterClose-shutterOpen)`, with an explicit Film exposuretime taking
precedence. Sensor and white-balance differences are warned about.

The pinned `TrowbridgeReitzDistribution::RoughnessToAlpha` returns `sqrt(r)`.
Since OpenPBR uses `alpha = roughness²`, the imported roughness is `r^(1/4)` with
remapping and `sqrt(r)` without it. For anisotropic alphas, the scalar roughness
is `(alphaU*alphaV)^(1/4)`; the anisotropy parameter follows the existing OpenPBR
aspect model. Extreme ratios are limited by that model.

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

Ordinary PBRT surfaces accept primary back-face hits. One-sided area emission
uses FrontSide because MuTracer couples primary visibility and emission sidedness;
its missing back-side surface visibility is warned about.

PBRT image textures evaluate `(s,1-t)`. Decoded images use top-down rows and
Three textures set `flipY=true`. Infinite lights use the equal-area square map,
reprojected to world-space latitude/longitude. The direct importer uses nearest
source lookup to match ImageInfiniteLight, while the existing glTF metadata
adapter retains its previous bilinear reprojection.

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
Each MuTracer run uses a fresh Chrome process to avoid retaining both scenes' caches
and allocations during memory measurement.

Text and gzip Includes are decoded by statements to avoid the single-string size
limit. The viewer parses them and PLY data in a Worker. The download preflight
uses unique encoded input sizes and an 8x expansion estimate against an 8 GiB
working budget. This estimate is deliberately conservative and cannot predict
total process/GPU memory or prevent every browser allocation failure.
