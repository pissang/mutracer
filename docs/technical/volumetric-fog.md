# Bounded participating media

This contributor note describes the WebGPU and WebGL 2 fog integrators.
User-facing configuration, costs and limits live in [the fog guide](../fog.md).

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
vertices clear triangle and instance exclusions before NEE. Shadow candidates
include `exp(-sum(tau))` before the RIS target is formed. WebGL uses the same
transmittance in its single-candidate direct-light estimator.

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
deterministic segment transmittance, and scale the surface normal by that
transmittance. Fog paths do not change display composition or denoising order.
