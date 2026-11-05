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
