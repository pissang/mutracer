# Bounded participating media

This contributor note describes the WebGPU and WebGL 2 fog integrators.
User-facing configuration, costs and limits live in [the fog guide](../volumes.md).

A fog-enabled shader has up to eight uniform records: normalized world-to-local
matrix, scattering albedo/anisotropy, and density/height falloff/base height/shape.
The absent-fog variant omits these declarations and integration code. Transforming
a ray without normalizing its local direction keeps intersection distances in
world units. Boxes use slab intervals; ellipsoids use unit-sphere chords.

Each volume independently samples optical depth `-log(1-u)`. The nearest
candidate is the event of the summed extinction field; its winning volume
supplies albedo and the Henyey–Greenstein phase. Survival has unit weight, and
an event multiplies throughput by the winner's albedo. This analog estimator
supports arbitrary overlaps without sorting boundary intervals.

Events are sampled after scene intersection and before analytic-light and
environment hit completion. Analytic emitters also bound the segment. Fog
vertices clear triangle and instance exclusions before NEE. Homogeneous shadow candidates include `exp(-sum(tau))` before the RIS target is
formed. For heterogeneous records, the RIS target uses closed majorant
transmittance, floored at 1e-6 to preserve proposal support after float underflow.
The selected contribution retains its unattenuated value until visibility
succeeds, then receives the complete ratio/closed transmittance once.
`ShadowRayWork` stores suppression at proposal construction. WebGL also applies
transmittance after visibility, with its single-candidate estimator.

The camera free flight precedes deterministic alpha coverage splitting. A
surviving camera prefix is shared by the front and back branches; it is not
sampled again on the front. Alpha-null continuations use fresh hashed distances
instead of repeating the same structured dimension. Fog uses bounce domains
56–63; 16 NEE candidates occupy at most domain 53. Free flight undoes the
surface sampler's endpoint remapping to recover a uniform sample on [0, 1);
otherwise many thin volumes accumulate an extinction bias.

Height density is exponential in world Y. Its optical-depth integral and inverse
are analytic. Small exponents use a series, and large exponents evaluate the
integral from the denser endpoint in logarithmic space. Height optical depth
saturates at 80, above the largest sampled float32 optical target and below
visible float32 transmission. Zero height falloff uses the uniform arithmetic.

Solid boundary transmission updates fog suppression independently of the
material's own medium type. Material medium sampling is left unchanged. A
scattered-path flag excludes display-only backgrounds as illumination; phase
continuation PDFs still participate in emitter/environment MIS. Caustic ownership
is disabled while any fog record exists because those estimators have no volume
transport.

Camera denoising guides blend surface reflectance with weighted fog albedo using
closed transmittance for homogeneous records and one ratio estimate per record
per sample for heterogeneous records. Surface guides for mirrors and alpha paths
are replayed independently of camera scattering; the blend happens once, after
path and wavelength composition. The surface normal is scaled by the resulting
transmittance. `isBlank` is geometric: any positive-density intersected shape
makes the camera sample nonblank, irrespective of the random estimate. Volume
paths do not change display composition or denoising order.


## Procedural density tracking

Only `HAS_VOLUME_NOISE` includes PCG3D gradient fBm and the tracking loops. It
extends a Web record from 24 to 36 floats with three aligned vec4 fields. The
homogeneous shader/record layout and native no-volume ABI remain unchanged.
The CPU reserves maximum Web capacity and packs homogeneous records compactly.

The multiplier is the product of world-space noise and local-space boundary
smoothstep masks, explicitly clamped to [0,1]. The exponential height profile is
therefore an analytic majorant. Delta tracking repeatedly samples its inverse
optical depth, using the current nearest event as the interval upper bound.
The first distance retains its structured sample dimension; rejection and later
distances use hashed samples with endpoint remapping undone.

Ratio tracking multiplies one minus the mask at majorant events. A value below
0.05 survives roulette with probability `Tr / 0.05`, with reciprocal weight on
survival. Unmodulated records retain analytic transmittance. Neither RIS candidate
construction nor blank classification calls the random estimator.

Both backends use `MAX_VOLUME_TRACKING_STEPS` (64). A delta cap returns no event;
a ratio cap returns current transmittance. These truncations bias transmission
upward when reached. Expected work is controlled by majorant optical thickness,
including in regions where the actual mask is nearly empty. GPU evidence must
measure the cap rate before approving an intended scene/parameter range.


## Domain distortion

`noiseParams.w` stores `warp`; neither the record stride nor the variant key changes.
For positive warp, three signed, normalized two-octave fBm evaluations offset the
normalized coordinate `q = (p + offset) / size`. Their fixed coordinate shifts are
`[17.25, 3.5, 29.75]`, `[41.5, 59.25, 7.125]` and `[73.75, 11.125, 97.5]`.
The final lookup is `fBm(q + warp * w)`. Offset is applied before both fields, so
the entire pattern drifts together. Shape and exponential height are not warped.

The distortion layers are fixed at two independently of the main octave count.
At four main octaves this adds six fractal layers per noise lookup; the measured
whole-render throughput loss stayed below 30% in completed measurements, so the
one-layer fallback was not needed. At zero warp, execution returns through the original
mask body and performs no distortion lookup.

Thresholding, local edge fading and the final [0,1] clamp are unchanged. Distortion
only changes where the noise is evaluated, so height density remains a valid
majorant; delta/ratio tracking and their unbiasedness before finite-loop truncation
do not change. No stochastic density estimate enters RIS candidate construction.
