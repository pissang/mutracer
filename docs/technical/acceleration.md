# Acceleration structures

The renderer traces a two-level hierarchy: one bottom-level BVH (BLAS) per geometry
and a top-level BVH (TLAS) over mesh instances. Builders, layouts and preparation
are documented in the [BVH guide](../bvh.md); this note records the choices behind
the defaults and the alternatives that were measured. The code is
`src/renderer/bvhAccel.ts` and `binnedSahBvh.ts`.

## TLAS

- **Builder.** The TLAS always uses the built-in binned SAH builder, a JavaScript
  port of TinyBVH's `BVH::Build`, built and refitted on the calling thread.
- **Bins.** The web TLAS uses 64 SAH bins (`WEB_TLAS_BINS`); native keeps 8. More
  bins separate overlapping static instances in scenes with many instances.
  Higher instance costs, exact SAH and forced fallbacks were compared and not
  adopted. The rebuilt tree can pick a different object at coincident faces, which
  changes `id` AOVs there; other AOVs matched, and HDR differed only by rounding.
- **Instance bounds.** Each instance's world bounds, padded by displacement, are
  stored after the TLAS. Leaf traversal tests them before transforming the ray
  into the BLAS's space, so a ray that misses an instance skips the transform and
  the BLAS root test. Both web backends and the caustic kernel use them.

## BLAS

- **Defaults.** The BVH2 layout with spatial splits off stays the default after a
  matrix of builder, layout and split settings. CWBVH was slower on the measured
  scenes despite its smaller nodes. Spatial splits help some scenes at three to
  five times the build time, so they stay opt-in.
- **Traversal tweaks.** Changes to box tests and stack handling showed no reliable
  gain and were not adopted.

## Coincident hits

Coplanar faces, such as a shadow catcher under the ground or two meshes sharing
a face, intersect a ray at the same distance within floating-point precision.
Without a rule, the BVH's traversal order chooses the surface, so the result
changes with builder, layout or instance order. Closest-hit queries that set
`resolveCoincident` choose deterministically (`intersect.wgsl.ts`,
`intersect.glsl.ts`):

- **Detection.** A candidate within `rayRoundoff` (about 4.8e-7 relative to the
  larger of the ray origin and the distance) of the nearest hit marks the query
  as tied, and the limit is widened by that interval.
- **Replay.** Only a tied query traverses again, with the first pass's limits
  and random stream so displacement marching repeats exactly. Among the
  candidates up to that limit, `closestHitPreferred` keeps a regular surface
  over a shadow catcher, then the lowest instance index, then the lowest
  triangle index.
- **Scope.** The camera's primary hit, the first AOV hit, and depth and picking
  queries resolve ties, so beauty, guides, AOVs and picking agree. Continued
  paths, shadow rays and caustic photons do not, because the replay would cost
  every bounce. In reflections and refractions either surface can appear.
- **Continuations.** A continued ray excludes its source instance and
  primitive instead of relying on a forward offset alone. Refraction and
  alpha pass-through continuations, including depth and AOV layers and caustic
  photons, use `transmissionRayOrigin`: it starts the ray slightly behind the
  surface so a second surface touching it is still found, then steps through
  once that second face is reached so the pair does not cycle.

Native shares the rule. Hardware ray queries report one closest hit, so a tied
query inspects the candidates inside the rounding interval and rejects
lower-priority indexed candidates before loading their triangles
(`native/src/intersections.wgsl.ts`). Native shadow rays also accept positive
hits closer than the former fixed minimum distance, since the source primitive
is already excluded.

An earlier version packed per-instance tie eligibility and refreshed it on
geometry and transform changes. Limiting resolution to camera and depth queries
removed that state and its update cost.

## Static merge prototype

A prototype merged static instances into one world-space BLAS, with world-space
triangle bounds and vertex tests in local space. It was faster on a heavy
many-instance scene, but:

- coincident geometry needs the old tree as a fallback to keep object identity,
  which costs memory and cold build time;
- HDR and legacy guides differ by rare rounding, and subsurface scattering, alpha
  random streams, instance colors and picking were not verified;
- incremental updates and the choice of which instances count as static are
  undesigned.

It is not in production. Pursuing it needs both web layouts, an update strategy and
those verifications, then a native port and comparison.

## Changing this code

- TLAS and BLAS changes affect `id` AOVs and picking at ties; compare those as well
  as HDR.
- Keep native's TLAS parameters unless native is aligned in a separate change.
