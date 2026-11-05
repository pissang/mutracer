# Caustic estimators

Path tracing finds caustics only when a BSDF sample happens to hit the light
through a smooth surface, because shadow rays treat glass as an occluder. MuTracer
adds two WebGPU estimators for those paths: light tracing and progressive photon
mapping. Usage, costs and limits are in the [caustics guide](../caustics.md); this
note explains how the paths are divided and how the estimators work.

## Path partition

A surface is *smooth* when `isCausticSpecular` holds: no diffuse, subsurface, fuzz
or coat weight, and specular roughness at most `CAUSTIC_ROUGHNESS_MAX` (0.1). The
test depends only on the material, never on the lobe a sample chose, so every
estimator classifies a vertex the same way (`src/renderer/caustics.ts`).

Counting from the light, the *receiver* is the first non-smooth surface vertex, k is
the number of smooth vertices between the light and the receiver, and the *camera
prefix* is the path from the camera to the receiver. Surfaces skipped through alpha
are not vertices.

| Paths | Estimator |
| --- | --- |
| k = 0 | Path tracing, unchanged |
| k ≥ 1, empty camera prefix (the camera sees the receiver directly), light tracing on | Light tracing |
| Other k ≥ 1, photon mapping on | Photon mapping |
| Anything else | Path tracing's BSDF hits |

Path tracing tracks the smooth chain length and whether the receiver is the first
visible surface. When it hits a light on a path that an enabled estimator owns, the
contribution is zero. Each path is therefore counted by exactly one estimator.
When an estimator is off or unsupported (WebGL 2), its rows fall back to path
tracing, so every configuration has the same expected image and differs only in
noise. Scenes whose smooth casters use stochastic blend coverage turn both
estimators off, because their photon transport does not yet match path-tracing
energy.

## Casters and emission

The renderer collects caster meshes and instances automatically from smooth
materials, with one conservative world-space sphere per instance. Photons are
emitted only toward caster spheres: a path whose first surface from the light is
not smooth belongs to path tracing, so restricting emission loses no estimator's
paths. Emission samples the full light surface, then accepts directions toward
the caster mixture; the direction PDF accounts for overlapping cones
(`casterDirectionPdf`). Lights are chosen by a separate power PMF, not the NEE
selection table (`causticEmission.ts`). Directional and environment light emit
from a mixture of projected caster disks.

## Light tracing

Light tracing is BDPT's t = 1 strategy. Photons follow smooth vertices with adjoint
BSDF corrections. At the receiver, the pass samples a lens point, connects to the
camera, tests visibility and splats into the pixel with float32 compare-and-swap
atomics. It runs once per sample batch, after the last tile, in its own pass and
bind group, because the main integrator already uses the baseline eight storage
buffers. The result accumulates separately; resolve adds it to the path-traced
radiance, so readback, denoising and display see the combined image. Adaptive
sampling measures variance only on the path-traced part.

## Photon mapping

Photon mapping uses probabilistic progressive photon mapping (Knaus and Zwicker
2011). Each sample batch emits a new photon map on the first tile, which later tiles
reuse. The gather radius shrinks as r_i = r_1 · i^((α − 1)/2) with α = 2/3
(`photonRadius`). The first radius is `initialRadius`, or 3% of the caster sphere
radius. At the first non-smooth camera vertex the radius is further limited to
about two projected pixels (`photonVisibleRadius`); mirror prefixes use an
approximate footprint, and deeper vertices use the global radius. The pixel cap
reduces blotches after denoising, at the cost of grainier raw output.

Photons are stored at the first non-smooth surface after at least one smooth
vertex, whatever camera prefix will later find them; queries at directly visible
receivers skip them when light tracing owns those paths. Camera paths query at every non-smooth vertex within `bounces`, with a
normal-consistent surface kernel.

Each photon takes 20 bytes: float32 position and RGBE8 flux, and two octahedral
directions (incident direction and normal). Two hash-grid layers with different
cell sizes, one for first visible receivers and one for deeper queries, each sort
only a 4-byte index, for 28 bytes per photon. Grids are rebuilt every batch with a
count, a two-level parallel prefix sum and a scatter; bucket counts are powers of
two up to 262144. Batches are reduced to fit device limits and a 128 MiB budget.

Quantized flux and directions limit precision. More batches shrink the radius
but do not remove that error, so photon mapping is consistent only up to storage
precision.

## Rejected and paused work

- **MNEE and SMS** (manifold next-event estimation and specular manifold sampling)
  are paused and excluded from builds. Behind a wavy refractive surface, each
  receiver can have dozens of manifold roots; Newton's method finds one, and SMS
  with its 64-trial cap covered only part of their weight, so neither converged
  to an unbiased result. The code remains in
  `src/research/mnee/`, registered explicitly by tests and research scripts. A
  restart should address multiple roots, for example with manifold path guiding
  (Fan et al. 2023).
- **Separate photon denoising**, filtering photon contributions apart from path
  tracing, increased error in comparisons and is not used.
- **Photon-count radius scaling**, per-caster radii and larger shrinking screen
  radii remain internal diagnostics (`causticDiagnostics.ts`). None improved
  equal-error time on every test scene.

## Changing this code

- The partition runs in WGSL. WebGL traces plain paths and needs no zeroing; its
  GLSL chain state exists only for the paused MNEE research path.
- Native shares the WGSL and exposes the same two estimators.
- Compare raw HDR, not denoised output, when judging energy; see the guide's
  limits for denoiser artifacts.
