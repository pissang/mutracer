# Motion AOV

The `motion` output gives, for each pixel-center hit, where the same surface
point was in the previous AOV frame. Its format and the conditions that
invalidate it are in [surface outputs](../api.md#surface-outputs). This note
explains how the correspondence is computed and why. The temporal denoiser
chains it across frames; see [temporal denoising](./temporal-denoising.md).

## Correspondence

The center pass (`aovTraceCenter` in `aovTrace.wgsl.ts`, `aovTrace.frag.ts` on
WebGL) traces the unjittered pixel-center ray without depth of field. It finds
the hit's previous world position, projects it with the previous
view-projection, and validates it against the previous frame's center buffer.

The AOV scene buffer (`packAovScene` in `aovScene.ts`) carries the data for
this. Word offsets:

| Words | Content |
| --- | --- |
| 0–15 | Previous view-projection |
| 36, 40 | Current camera position and forward axis |
| 44, 48 | Previous camera position and forward axis |
| 52 + 24·i | Per instance: object ID, local instance, history flag, deformation snapshot offset, current-to-previous matrix |

`AovHistory` keeps the previous frame's camera and instance transforms, keyed
by stable AOV object and instance IDs.

- **Rigid motion.** The instance's current-to-previous matrix maps the hit.
- **Projection.** Changes of projection (focal length, dolly-zoom) keep history,
  because the previous view-projection projects the point directly. Only a
  change of dimensions resets it.

## Visibility

The previous frame may show a different surface at the projected pixel, so the
pass compares depths. It first requires the same object and instance at the
nearest previous pixel center.

A fixed relative tolerance on depth failed on surfaces seen at grazing angles.
Half a pixel of depth slope exceeded 0.1%, and 68% of the dining-table marble
reported invalid motion.

The test now compares the depth traced at the previous pixel center with the
depth of the current surface's tangent plane at that same center:

- Two tangent offsets are projected into the previous view.
- `1/w` and `depth/w` are interpolated affinely in screen space, which is exact
  for a plane under any projective camera.
- An edge-on plane returns no depth and fails the test.

## Previous depth

Public `motion.z` is the camera-forward depth of the same point in the
previous frame, measured with the previous camera's position and forward axis.
Measuring with the camera axes keeps orthographic cameras correct, where
`clip.w` is constant. The temporal denoiser chains this depth for its landing
depth and circle-of-confusion tests, because a moving object's world position
differs in every frame.

Inside `AovCenter`:

- `motion.z` keeps the current depth as history for the next frame's
  visibility test.
- `motion.w` stores the previous depth for a valid pixel and 0 otherwise.

Readback, resolve snapshots and display map this to the public layout: `z` is
the previous depth, `w` is 3 or 0. This keeps `AovCenter` at 32 bytes, which the
native host mirrors. A valid point whose previous depth is exactly 0 would read
as invalid; it is in front of the camera, so this occurs only on an orthographic
camera's near plane.

## Deformation

When a geometry's vertex version advances without a topology change
(`markVerticesUpdated`, skinning, morph targets), the previous frame's positions
are needed.

- **History.** A render that requests `motion` keeps a CPU copy of each
  geometry's positions (`captureDeformation`). Unchanged versions reuse the
  stored copy.
- **Packing.** For geometries that deformed since the previous AOV frame,
  `packAovScene` appends the previous object-space positions after the
  primitive tail. The instance record stores their offset and the previous
  world matrix instead of the current-to-previous one. Adding no binding keeps
  the storage-binding count unchanged. WebGL reads the same data from its scene
  texture.
- **Shader.**
  - The pass reads the three vertex indices of the hit triangle from its BVH
    record, in the stored corner order.
  - It interpolates the snapshot vertices with the hit barycentrics. The
    watertight intersector's barycentric `x` weights corner 0, matching
    `fetchAttributes`.
  - It transforms the result by the previous matrix.
  - The previous triangle's plane drives the visibility test.
- **Topology.** A topology change still invalidates.

Costs: about 12 CPU bytes per vertex for the history copy, and 12 GPU bytes per
deformed vertex in that frame's scene data. The scene buffer must fit
`maxStorageBufferBindingSize`; `setScene` throws a `RangeError` beyond it.

## Limits

- **Displaced meshes.** On a displaced mesh that also deforms, hits report
  micro-triangle barycentrics, not base-triangle ones. The previous position is
  then wrong, and most such pixels fail the visibility test and report invalid
  motion.
- **Test coverage.** The GPU regression in `tests/gpu/aov.ts` deforms by a
  uniform offset, which cannot detect a barycentric-order mistake. The temporal
  denoiser's travelling-wave fixture covers non-affine deformation (p99 error
  below 0.0001 px). A non-uniform case in `aov.ts` would make the contract
  self-contained.
- **Native.** The Metal software and hardware tracers export previous camera-forward depth in `motion.z` and track deformations with stable topology.
