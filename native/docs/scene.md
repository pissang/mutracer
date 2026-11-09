# Scenes

Build scenes with Rust `scene_api::Scene` or the C `mt_scene` handle in
[mutracer-scene-api.h](../include/mutracer-scene-api.h), submit them with
`set_scene_object` / `mt_engine_set_scene_object`, and commit with `update` /
`mt_engine_update`. The header and Rust types document each descriptor field,
default and handle rule. To load a model, use [glTF import](gltf.md).

## Build a scene

Add geometry, materials, textures and lights, then meshes that reference them.
Meshes hold world matrices without a parent hierarchy; instancing gives one mesh
many local matrices (`Mesh::instances` / `mt_scene_add_instances`). Materials are
OpenPBR: the descriptor holds the common fields, and the property setters
(`set_float`, `set_uint`, `set_texture` / `mt_scene_material_set_*`) reach every
other property through the
[material property IDs](../include/mutracer-material-properties.h).

Defaults to know:

- The environment is black and materials emit no light. Add a light, an
  environment map or emission to see anything.
- Without a camera, renders use a 45° perspective camera at the origin looking
  along -Z. An engine camera (`set_camera`) overrides the scene's default camera.
- Output size and quality belong to each render, not to the scene.

Engines keep submitted snapshots, so a scene can be edited or destroyed after
`set_scene_object` returns. Rust geometry, image and instance arrays are `Arc`s
that scenes can share (`Arc::make_mut` edits one); C copies every input.

## Environment lighting and background

Set RGBA32F maps with `set_environment` / `mt_scene_set_environment`. Adjust
lighting and background independently with `set_environment_settings` /
`mt_scene_set_environment_settings`, then submit the scene and call `update`.
The controls persist when a map is replaced; the source texture can be shared
with materials without changing their appearance. Solid background colors are
unaffected by the background-map controls.

Updating these controls can process the full environment image, so larger HDRIs
cost more to update. The background rotation is independent: change both
rotations together when the visible background should follow the lighting.

## Edit a scene

Edit the scene through its `*_mut` accessors (Rust) or `mt_scene_set_*` and
`mt_scene_remove_*` calls (C), then call `set_scene_object` and `update` again.
Several edits can share one update. The engine reuses prepared resources when it
can. Every commit restarts accumulation.

These edits commit incrementally:

- Camera changes; mesh matrices; any number of a batch's instance matrices;
  existing instance colors. Commit multiple matrix edits together to reduce
  update cost.
- Mesh visibility, including an entire instance batch; see [visibility](#visibility).
- Adding or removing meshes that reuse resident geometry and materials while
  the retained TLAS capacity is sufficient. Removing a mesh does not evict its
  geometry; a later full preparation may reclaim it.
- Appending static, single-material geometry without displacement or triangle
  material indices when its shader and buffer layout remain compatible. This
  path prepares new geometry in the background and can grow retained buffers,
  using more memory and preparation work. Compatible appends remain incremental
  after mesh removal.
- Vertex positions, normals and tangents when the topology and the presence of
  normal and tangent arrays stay the same. Only the vertex span affected by
  attribute changes is uploaded; generated normals and tangents can
  widen that span. Shared geometry also updates the bounds of all its instances.
- OpenPBR numeric and color parameters while the prepared shader and traversal
  support remain compatible. Emission edits also refresh light sampling;
  switching emission on or off is incremental.
- Texture sampling parameters and pixels, including environment and background
  map pixels and sizes, while the texture atlas still fits.
- Changing a material texture reference when the destination is already in the
  retained atlas and the committed shader supports it.
- Adding, removing and changing lights while the scene has at most 64 analytic
  lights; background color; environment/background strength and rotation.

These edits need full preparation, which runs on a library thread while the
previous image stays visible ([engine updates](engine.md#updates)):

- Growing past 64 analytic lights, which reallocates the light array.
- Texture-reference changes that need an atlas resize or new shader support,
  including the first use of a previously unused scene texture; UV projection
  or displacement-reference changes.
- Parameter edits that require new shader support or change transparency, medium,
  dispersion or traversal requirements. For example, the first use of coat/fuzz,
  thin film or subsurface may need full preparation; later compatible weight and
  color edits are incremental.
- Changes to a texture used as a displacement map.
- Changed triangle indices, vertex or index counts, or UVs.
- Mesh additions that introduce a material, require new shader support, or add
  displaced, indexed-material or otherwise incompatible geometry; membership
  changes that exceed the retained TLAS capacity; changed instance counts or
  presence of instance colors.
- Changed texture counts; adding or removing environment or background maps.
- Edits that need a new shader variant or a larger texture atlas.

Large matrix and vertex edits can block the caller during
[synchronous incremental updates](engine.md#updates). They need temporary CPU
memory and visit affected instances, so changing one shared geometry can cost
much more than changing one mesh.
Hardware vertex edits also need temporary GPU memory proportional to the
affected geometry. An active displacement map with nonzero bias requires full
preparation for vertex edits.

Software refits stable-topology geometry and may rebuild when its BVH quality
limit is exceeded. Metal hardware tracing refits compatible BLASes; other
hardware adapters rebuild them. Large deformations can slow subsequent tracing,
especially on hardware where no automatic quality-based BLAS rebuild is applied.
Changes to emissive geometry also refresh its light sampling.

`pending_commit_kind` / `mt_scene_pending_commit_kind` predicts the next commit
but cannot see shader, traversal and atlas requirements; `mt_render_info` reports
the actual one.

Keep one Scene and edit it in place. Encoding and comparison then cost in
proportion to the edited objects, plus validation and change detection passes
over the meshes. Adding or removing resources, editing textures and layout
changes such as a new vertex attribute encode the whole scene, and the following
update compares all of it. Snapshots from `set_scene` / `set_scene_shared` are
also compared in full, as are scenes that produced more than three snapshots
since the engine's last update, for example for other engines. The first
incremental update after a full preparation builds comparison state for every
object and takes longer than later edits.

## Material graphs

Assign a normalized `MaterialGraph` with `OpenPbrMaterial::set_graph` (Rust) or
`mt_scene_material_set_graph` (C), then submit and update the scene. `None` / a
null graph restores the material's constants and maps. Graphs use the browser's
[MaterialX node and terminal subset](../../docs/materials.md#material-graphs)
on both Software and HWRT, including surface and shadow opacity. HSV conversions
and `hsvadjust` accept color3/color4 and preserve alpha. The
[C graph declarations](../include/mutracer-material-graph.h) and
[scene format](scene-format.md#material-graphs-v8) describe the normalized input; this API
does not read XML. `fold_constants` / `mt_material_graph_fold` can resolve
uniform terminal values without a GPU.

Numeric and retained-texture edits can commit incrementally. Node, connection,
type or terminal changes require full preparation. A new shader can take much
longer than a parameter edit; unchanged camera, size and render settings let the
installed graph keep sampling while it prepares. Only the latest request
installs, and installation restarts accumulation for every affected render.
Invalid graphs retain the installed graph, or use constants and maps when no
graph has installed. A compilation failure keeps the installed scene. If the
first scene's graph fails to compile, it prepares constants and maps. Removing
the graph or using an unsupported lit-emission or opacity-projection combination
selects the constant fallback directly.

Read located errors from `Engine::diagnostics().material_graphs` or
`mt_engine_material_graph_diagnostics`. Per-render diagnostics also report
transport restrictions: light tracing and photon mapping use constant material
fallbacks for graphs. These restrictions match the browser's documented graph
limits. Author IDs provide diagnostic locations; graph-wide compilation errors
have an empty node and port.

Graph parameters and generated shaders add memory and compilation cost. Graph
textures share the ordinary texture limits and budget, including the full UDIM
grid. Reusing one structure with different parameter values avoids shader
compilation. Restarting the application can require compilation again.

## Visibility

Use `Scene::set_mesh_visible` (Rust) or `mt_scene_set_mesh_visible` (C), then
submit with `set_scene_object` and `update`. Meshes are visible by default;
visibility applies to an entire instance batch.

Hidden meshes behave as removed meshes for rays, emitted light, picking and
AOVs, with the same [visibility semantics as the browser](../../docs/updates.md#visibility).
Geometry and materials remain resident, so showing the mesh
again does not prepare them again. Toggling visibility commits incrementally
unless other edits in the same update require full preparation. Every commit
restarts accumulation. Use `remove_mesh` / `mt_scene_remove_mesh` when the mesh
is no longer needed; removal keeps its geometry resident until a later full
preparation.

## Pick scene objects

Create a CPU snapshot with `Scene::picker()` / `mt_scene_picker_create`, then
query a world-space ray with `raycast` / `mt_scene_picker_raycast`. Results
identify the mesh, local instance, material and original triangle, with world
position, distance, geometric normal and barycentric coordinates. No engine or
GPU is needed. Importing a model does not create this snapshot; its CPU and
memory costs are paid only when you request a picker.

```rust
let picker = scene.picker()?;
let hit = picker.raycast(
    mutracer_native::scene_api::Ray {
        origin: [0., 0., 3.],
        direction: [0., 0., -1.],
    },
    Default::default(),
)?;
```

Snapshot construction time and additional CPU memory grow with triangle and
instance counts. Reuse a snapshot for repeated queries, including from several
threads. Recreate it after geometry, mesh, instance or material-table edits.
Snapshots outlive the source scene; returned handles describe that snapshot and
may no longer be valid in an edited or destroyed source scene.

To match object and material hits with [surface-output IDs](denoising.md#surface-outputs),
use the Rust handles' `aov_id()` values or the low 32 bits of C handles. An
ordinary mesh has AOV instance ID 0; picking reports `None` in Rust or
`UINT32_MAX` in C, so normalize that value when comparing them.

Picking intersects both faces of the original triangles. Alpha masks,
transparency, displacement, bevel and other shading do not affect the hit, so
it can differ from the visible rendered surface. For screen clicks, the host
converts its camera and viewport coordinates into a world ray. Large coordinates
and extreme scales remain limited by Float32 geometry and intersection precision.

## Supported inputs

- Indexed triangles with optional normals, tangents, two UV sets, vertex colors
  and per-vertex material indices. Missing normals and tangents are generated.
- Shared geometry, per-mesh material tables and instance batches.
- Perspective and orthographic cameras with depth of field.
- Rectangular, spherical, directional and spot lights; emissive meshes;
  textures on rectangular lights; IES profiles on spot lights.
- RGBA8 sRGB and linear RGBA32F textures; RGBA32F environment and background
  maps.
- Every OpenPBR property, including displacement.

Large coordinates are limited by Float32 inputs and GPU matrices. Displacement
color and normal output can differ between the
[ray tracing backends](../README.md#ray-tracing-backends). Size and count limits
are in the [scene format reference](scene-format.md#limits).
