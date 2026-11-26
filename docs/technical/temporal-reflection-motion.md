# Reflection motion in the offline window

[Temporal denoising usage](../temporal-denoising.md)

The combined-color window tracks the visible surface. A highlight or reflected
object can move independently of that surface. The default surface window
shrinks with roughness on smooth metals to limit trails. Virtual-image motion
can accumulate reflections in flat reflectors even when their surface
window is short.

## Signal boundary

The window uses first-surface reflected radiance from the same invocations as
beauty. The reflection component includes dielectric, conductor, coat and fuzz
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

Planar capture returns before the optional curvature estimate, including its
neighbor ray. An internal shader specialization enables the directional
normal derivative for a curvature comparison. Each capture provides one
motion hypothesis to the window.

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
reflected fallback also fades in between roughness 0.05 and 0.20. Dielectrics
retain their surface fallback even for a smooth reflection lobe. The
roughness-dependent weight follows the approach described in
[Fast Denoising with Self-Stabilizing Recurrent Blurs, slide 58](https://developer.download.nvidia.com/video/gputechconf/gtc/2020/presentations/s22699-fast-denoising-with-self-stabilizing-recurrent-blurs.pdf).

## Allocation and diagnosis

Each extra history slot uses 24 bytes per pixel. Reflected RGB is stored in
`rgba16float`. The `rgba32uint` record holds two full endpoint identity words,
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
