# Reflection motion in the offline window

[Temporal denoising usage](../temporal-denoising.md)

The combined-color window tracks the visible surface. A highlight or reflected
object can move independently of that surface. The default surface window
shrinks with roughness on smooth metals to limit trails. Virtual-image motion
can accumulate reflections on flat and curved reflectors even when their
surface window is short.

## Signal boundary

When reflection motion is enabled, the window captures first-surface reflected
radiance from the same invocations as beauty. The reflection component includes dielectric, conductor, coat and fuzz
lobes. For next-event estimation it shares beauty's light selection, shadow
test and MIS. For continuation it uses the reflected fraction of the full BSDF
response at the sampled direction. Keeping this fraction preserves the split
when several lobes contribute at the same direction.

Subtracting reflected radiance from HDR yields the surface residual. It
includes diffuse and subsurface scattering, primary emission, camera-visible
photon gathers and light tracing. A path that first transmits through glass
stays in the residual. A path first reflected by glass can follow the virtual
image. The accumulation resolves both signals with separate weights before
running OIDN and post stabilization once.

## Capture and motion

A pinhole center ray identifies the primary surface. One more ray finds the
first reflected endpoint along the resolved shading normal, including coat
influence. The virtual image mirrors the endpoint about the reflector's
tangent plane. The construction also handles a direction at infinity.
The reflector and endpoint use their own previous rigid transforms before
projection, so a moving reflected object can have motion with a static
camera. A cut or deformation invalidates the corresponding rigid motion.

The capture also projects the corresponding surface point. The difference
between that motion and the tangent-plane image motion is optical
parallax. The curvature pass adjusts this parallax, then adds it back to
surface motion. Each capture stores one virtual displacement and its
confidence in the existing history textures.

## Visibility and weights

The surface tap follows the A2 motion chain and uses the existing depth,
normal, coverage, material revision and circle-of-confusion checks. The
reflection tap walks its backward field for past frames and inverts that field
for future frames. Inversion can try the surface-motion seed when the prior
optical motion does not find a solution. Both seeds have to pass the same
2×2 support and residual checks in the destination frame.

Each step checks reflector and endpoint identity and endpoint distance.
The landing also checks reflector depth and normal, circle of confusion,
hit coverage and 2×2 footprint. Coincident surface and virtual landings can
pass these checks, including stationary regions in a shot with a moving
reflected object. Real endpoint disocclusions and mirror boundaries can
still interrupt the optical chain.

The surface residual and the reflected surface-motion tap use the same
[roughness-dependent surface window](./temporal-denoising.md#pipeline) as
the default filter. Virtual taps use the full temporal radius and get the
most weight at low roughness and high confidence. Displacement and endpoint
checks reduce the weight of a mismatched surface fallback. For metals, the
reflected fallback fades in between roughness 0.05 and 0.20 as the image
parallax grows from 0.25 to 2 pixels. For smooth, opaque dielectrics, the center
ray records the roughness and Fresnel strength of the narrower contributing
base or coat lobe. The window compares the reflected world-space directions
at corresponding surface points. Divergence reduces the reflected
surface-motion weight. The virtual tap uses the same confidence at small
parallax and requires consistent reflector and endpoint IDs near an optical
silhouette. The diffuse and transmitted residual and auxiliary guides keep
their surface weights. With reflection motion disabled the window captures
combined color and uses the surface weights.
The roughness-dependent weight follows the approach described in
[Fast Denoising with Self-Stabilizing Recurrent Blurs, slide 58](https://developer.download.nvidia.com/video/gputechconf/gtc/2020/presentations/s22699-fast-denoising-with-self-stabilizing-recurrent-blurs.pdf).

## Curved reflectors

The curvature pass estimates signed normal derivatives from the center
positions and shading normals of neighbors on the same reflector. It projects
the normal onto the screen to find the plane of incidence, then resolves
the two screen-axis derivatives along and across that plane.

For reflection cosine `c`, eye-to-surface range `D` and endpoint distance `d`,
the two powers and denominators are

```text
reach = d D / (D + d)
u_in  = 2 reach k_in / c
u_out = 2 reach k_out c
corrected_parallax = (parallax_in / (1 + u_in), parallax_out / (1 + u_out))
```

An environment endpoint uses `reach = D`. Convex curvature reduces parallax.
Concave curvature can bring `1 + u` close to zero and invalidate the local
estimate. Insufficient same-surface support and a denominator below 0.25
reject the correction. Flat and orthographic surfaces retain the
tangent-plane candidate and its curvature-based validation.

The residual estimate combines normal rotation over the corrected displacement,
differences between one-sided derivatives, and aperture parallax. Confidence
falls from full weight at 0.10 pixels of estimated residual to zero at
0.45 pixels, with additional attenuation at grazing angles. The window
propagates confidence through the chain and checks it at the radiance tap.
Endpoint identity and all visibility checks still apply.

Nearest-texel sampling contributes a half-pixel rounding allowance to the
residual used for sample-count adaptation. The allowance and optical residual
are compared with the projected lobe width. As the pixel sample count rises
above three, the expected reduction in current-frame noise decreases with
the inverse square root of the sample count. The filter reduces confidence
in the curvature candidate and can return to the tangent-plane candidate
when the estimated alignment cost dominates. This comparison approximates
sampling noise using the sample count already stored with the render.

On a smooth curved metal the lobe width is about half a pixel, so the cost
reaches one near 12 spp even without optical residual. Every tap then
returns to the tangent-plane candidate, which a curved mirror rejects, and
the reflected history collapses to the current frame. Error at 12 spp can
exceed error at 9 spp, and confidence is already reduced at 9 spp. Pinning
the cost's sample count to three restores error that falls with the sample
count on such surfaces. For comparisons between runs whose per-pixel counts
differ, the native capture reads `MUTRACER_ALIGNMENT_SAMPLES` to pin that
count; the default uses the actual count.

## Allocation and diagnosis

Each extra history slot uses 24 bytes per pixel. Reflected RGB is stored in
`rgba16float`, with the motion model and confidence in alpha. The
`rgba32uint` record holds two full endpoint identity words,
two binary16 displacements, a 16-bit logarithmic distance code, and 8 bits
each for roughness and cosine. The distance code reserves distinct values for
invalid paths and environment endpoints.

At 720p and radius 16, the 33 slots add 729,907,200 bytes. The window sum,
center capture tail and beauty output add 64 bytes per pixel on WebGPU,
for 788,889,600 bytes total. Native accounts for a further 16 bytes per
pixel for the sampling checkpoint, for 803,635,200 bytes total.

The native window dump can record per-pixel virtual acceptance and the first
failed check. A planar mirror with camera motion should have high support in
the region visible across the window. Forward inversion and reflector
identity reject at the mirror boundary. Low acceptance on convex reflectors
can also arise from normal rotation and a changing endpoint. A reliable
curvature correction needs to improve reflected edges without widening
history across those disocclusions.
