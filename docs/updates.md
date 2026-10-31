# Scene updates and animation

This page is the reference for editing a scene that is already rendering.
Keep the same scene, arrays and resources and edit them in place. Call
`engine.update()` once per frame to detect and commit changes. Every Render
uses that committed snapshot until the next update; editing or replacing the
external scene/camera without calling update has no effect on tracing.
Changes restart each render at its next refine. See
[progressive rendering](./progressive-rendering.md) for preview selection.

## What to do after a change

`engine.update()` compares the scene with its last commit. It detects every
property assignment, membership change and small value such as matrices,
material parameters, light parameters and background fields. It does not read
the contents of large arrays or images, so in-place edits to them need a
notification first:

| Edited in place | Notification |
| --- | --- |
| Texture pixels or UV-array elements | `texture.markUpdated()` |
| Vertex attributes; indices and `materialIndex` unchanged | `geometry.markVerticesUpdated()` |
| Indices, `materialIndex` or other geometry data | `geometry.markUpdated()` |
| `instancedMesh.transforms` elements | `instancedMesh.markTransformsUpdated(start?, count?)` |
| `instancedMesh.colors` elements | `instancedMesh.markColorsUpdated(start?, count?)` |
| Both instance matrices and colors | `instancedMesh.markUpdated()` |

Everything else, including the camera, `scene.meshes`, `mesh.transform`,
replaced geometry, materials, textures or arrays, and `instancedMesh.count`,
needs only `engine.update()`. Engine BVH settings also take effect at the next
update; see [BVH](./bvh.md).

```ts
mesh.transform[12] += 0.1;           // detected
material.specularRoughness = 0.6;    // detected
// ...edit texture pixels...
texture.markUpdated();               // pixels: notify
engine.update(); final.refine(); engine.display.present(final);
```

With RenderLoop, edit sources before the next tick; the loop calls sync.update
and engine.update. THREESync sends resource notifications for you. See
[Three.js](./threejs.md#keeping-scenes-in-sync).

## Transforms

Edit `mesh.transform` in place while retaining the mesh objects and the
`scene.meshes` array. Both WebGPU and WebGL 2 refit the top-level BVH over the
changed instances and upload only the affected ranges.

## Instanced meshes

Use `InstancedMesh` for many copies of the same geometry and materials:

```ts
const batch = new InstancedMesh(geometry, material, {count: 1000});
// Omitted transforms initialize every local matrix to identity.
for (let i = 0; i < batch.count; i++) batch.transforms[i * 16 + 12] = i * 2;
batch.markTransformsUpdated();
scene.meshes.push(batch);
engine.update();

batch.transforms[16 + 12] += 1;
batch.markTransformsUpdated(1, 1); // start/count are in instances, not floats
engine.update();
```

`transforms` contains column-major Float32 matrices; the constructor retains a
supplied array. Each world matrix is `batch.transform * transforms[i]`, so the
inherited `position` and `lookAt` move the whole batch. Every instance uses the
same material list, selected by the geometry's `materialIndex` exactly as for Mesh.

`count` selects an active prefix and must be a nonnegative integer within the
transforms and colors array capacity. Shrinking it retains the stored matrices; increase it again to
reactivate that prefix. To grow beyond capacity, assign a larger Float32Array
with the previous prefix copied. The default count and capacity come from the
constructor. Empty batches are supported.

Optional `colors` contains linear RGB multipliers, three Float32 values per
instance; omitted colors are white. The array is retained and must hold at least
`3 * count` values. All materials of an instance share its color. Colors multiply
baseColor after texture sampling, and emissionColor only for unlit materials.
They do not affect alpha, other layer colors, non-unlit emission or light sampling.
Values are not clamped; results for nonfinite colors are undefined.

```ts
batch.colors = new Float32Array(batch.count * 3).fill(1); // replacement: detected
batch.colors.set([0.2, 0.6, 1], 3);
batch.markColorsUpdated(1, 1);
engine.update();
```

After editing both matrices and colors, call `batch.markUpdated()` to notify
both for all active instances. This does not notify geometry or material edits.
For edits to just one array, use the dedicated notification (default range: all
active instances):

| Notification | Work avoided compared with `markUpdated()` |
| --- | --- |
| `markTransformsUpdated(start?, count?)` | Copying unchanged instance colors |
| `markColorsUpdated(start?, count?)` | Copying instance matrices and refitting or rebuilding BVHs; only instance colors are uploaded |

Each notification advances the read-only `version` once, initially zero.
Replacing either array, removing colors, and changing count are detected automatically.
Arrays are copied into the engine snapshot on their own version or storage change;
unnotified edits remain uncommitted even when another scene resource changes. Call
`engine.update()` before refining or converging.

Caveats: individual instances have no names, transforms or materials as JS
objects. Use separate batches for distinct material sets. Nonfinite world
matrices are excluded, as with Mesh.
The notification range is validated.

## Materials, textures and lights

Material parameter edits repack material parameters without touching geometry
or BVHs. Emission edits also refresh light-sampling state. With atlas bindings,
texture edits rebuild the texture atlas. With [bindless bindings](./api.md#texture-bindings),
UV assignments, wrap and color-space edits update sampling metadata, while pixel edits
upload the changed images. Dimension, budget or shared storage-precision changes
can require more images to be uploaded. `Texture.markUpdated()` invalidates image
pixels as well as in-place UV edits. Displacement settings that move geometry require a
[full mesh update](#full-mesh-updates).

WebGPU can compile a new path-tracing shader for the following changes. Feature
presence is scene-wide: adding another material or light that uses an already
supported feature does not by itself need another variant.

Within compatible transport settings and data layouts, WebGPU retains prepared
material, texture and lighting support for later edits. Turning a feature off
and back on can reuse that support. The base shader supports diffuse, dielectric
and metal materials: changing `baseMetalness` between 0 and 1 does not itself
require another shader. Coat and fuzz are prepared together on the first use of
either: switching between them or combining them does not itself require another
shader. Transmission, thin film and subsurface are prepared as needed; dispersion
and other transport/layout changes below can still require compilation.

| Change | When a different shader variant is needed |
| --- | --- |
| Material, texture or lighting features | Newly required support is not covered by a prepared shader: coat/fuzz, thin film, subsurface, transmission, shadow catchers, a texture type, an analytic-light type, sampled emissive triangles or environment illumination |
| Transport and transparency | Enabling/disabling medium or dispersion support, changing whether any non-opaque material exists, or changing whether deterministic primary BLEND splitting is needed |
| Shading and geometry structure | Changing required UV/tangent/coat-normal frames, displacement or material-bevel support, vertex/BVH layouts or required traversal capacity |
| Render settings | Changing `samplingPattern`, `bevelSamples`, or `alphaBlendStrategy` while BLEND materials exist |
| Texture capacity | Atlas: increasing the texture count beyond the current capacity. Both modes: first use or last removal of UV1 texture sampling also changes the shader |

With `alphaMode: 'auto'`, opacity, cutoff or alpha-map edits can change the
resolved transparency mode. Texture edits can also enable independent coat-normal
or anisotropy frames. These count as structural changes above.

Within an unchanged feature/structure combination, colors, roughness, metalness,
existing layer weights, light transforms/intensity, texture pixels and camera/output size
do not recompile the path tracer. Neither do changes to `bounces`,
`directLightCandidates`, clamping, `dispersionWavelengths` (1 or 3), the render's
bevel switch, sample count or seed. Data uploads, atlas/BVH work and accumulation
restarts may still be needed.

A render waiting for a shader keeps its samples and image, and other renders keep
sampling. Returning to a cached compatible combination reuses its pipeline, even
while another combination is still compiling. Prepared
combinations may be discarded after many different edits; recreating the Engine
or recovering a lost device also requires preparing shaders again. Compilation time depends
on the feature combination, BVH layout, browser and GPU driver. Denoising and
post-processing passes have their own shaders and initialization costs.

Analytic-light edits keep the environment map. Ambient and environment edits
rebuild it. Rect-light texture edits require a full mesh update, because those
textures live in the material atlas.

## Geometry

Choose the notification that matches the edit:

| Edit | Notification | Effect |
| --- | --- | --- |
| Vertex attributes only; indices and `materialIndex` unchanged | `geometry.markVerticesUpdated()` | Advances `version`; keeps `topologyVersion`. Allows vertex updates and BLAS refits |
| Indices, `materialIndex`, or any other geometry change | `geometry.markUpdated()` | Advances `version` and `topologyVersion`. Rebuilds the affected BLAS |

```ts
geometry.dynamic = true;               // for frequent deformation
geometry.position.array[0] += 0.1;
geometry.markVerticesUpdated();
// The next engine.update commits this geometry and every mesh that uses it.
```

- Neither method recalculates normals or tangents. Update them before
  notifying the renderer.
- `markUpdated()` is valid for vertex edits too, but it can rebuild the BLAS
  unnecessarily.
- Keep the attribute arrays, their lengths and item sizes. Then both backends
  update only the edited geometry's ranges and BLAS, and refit every instance
  that shares it. Vertex, transform and material edits can be combined in one
  frame.
- Replaced arrays, changed lengths or item sizes, and displaced geometry
  require a [full mesh update](#full-mesh-updates), whichever method you call.

### Dynamic geometry

Set `geometry.dynamic = true` (default `false`) for geometry that deforms
every frame. Dynamic geometry always uses the built-in builder and the binary
`'bvh2'` layout, whatever `engine.bvhBuilder` and `engine.bvhLayout` say,
so its BLAS can be refitted. A refitted BLAS is rebuilt once its total node
surface area exceeds twice the total of its last build, which limits quality
loss during long deformations. Non-dynamic geometry refits layouts that
support it and rebuilds the others.

Refits and rebuilds run synchronously during committed GPU uploads. Three.js skinning
and morph targets set `dynamic` automatically; try the
[animation example](../examples/animation.html).

## Adding, removing and reassigning meshes

Adding, removing or reordering meshes, or replacing a mesh's material, is
cheap when every mesh uses a single material and geometry that is already on
the GPU: the renderer rebuilds the top-level BVH and instance data and reuses
vertex data and BLASes. Otherwise, for example with new geometry, displacement
or a `materialIndex` attribute, it needs a full mesh update.

## Full mesh updates

A full mesh update repacks and uploads all mesh data, and its cost grows with
the whole scene rather than with the edit. It happens when:

- attribute or index arrays are replaced, or their lengths or item sizes change;
- displaced geometry or its displacement settings change;
- a rect-light texture changes;
- a mesh gets geometry that is not yet on the GPU, or meshes with displaced
  or multi-material geometry are added, removed or reassigned.

Avoid these in per-frame animation.

## Preview and animation

Create a cheaper preview Render and use it during motion. Give the final render
`fallback: preview`; it transitions when its first complete sample is ready.
Selection and coalescing of continuous animation changes belong to the
application. Render.refine only executes the chosen settings, and samples
always count that render's complete samples. For fixed-quality animation, use
converge on each frame with disjoint sequence offsets.


## Implementation notes

Material detection compares each distinct material once per engine.update,
however many meshes share it; cost grows with the number of distinct materials.

On a version or storage change, the engine copies the full transforms or colors
array; start/count validation does not limit the copied elements. In scenes
containing batches, a transform update regenerates all instance records and
refits the top-level BVH. World matrices keep double precision until GPU
packing, matching Three.js world-matrix and inverse calculations. Instances
share BLAS and vertices unless explicit materialIndex packing or displacement
requires a distinct vertex region.
