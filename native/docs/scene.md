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
Several edits can share one update. The engine compares the new snapshot with
the committed scene and reuses prepared resources when it can. Every commit
restarts accumulation, and both paths render the same image.

These edits commit incrementally:

- Camera changes; mesh and instance matrices; existing instance colors.
- Vertex positions, normals and tangents when the topology and the presence of
  normal and tangent arrays stay the same.
- Material base color, roughness, metalness, transmission and IOR, unless the
  edit needs a new shader variant.
- Texture sampling parameters and pixels, including environment and background
  map pixels and sizes, while the texture atlas still fits.
- Adding, removing and changing lights; background color; environment/background
  strength and rotation.

These edits need full preparation, which runs on a library thread while the
previous image stays visible ([engine updates](engine.md#updates)):

- Other material properties, including emission color and strength, coat,
  opacity, thin walls and other OpenPBR layers, and adding, removing or changing
  a material's texture references.
- Changes to a texture used as a displacement map.
- Changed triangle indices, vertex or index counts, or UVs.
- Adding, removing or reordering mesh references; changed instance counts or
  presence of instance colors.
- Changed texture counts; adding or removing environment or background maps.
- Edits that need a new shader variant or a larger texture atlas.

`pending_commit_kind` / `mt_scene_pending_commit_kind` predicts the next commit
but cannot see shader-variant and atlas requirements; `mt_render_info` reports
the actual one. Comparison scans the scene, so edit cost grows with scene size.
Keep one Scene and edit it in place to reuse its encoding storage.

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
    mutracer_native_probe::scene_api::Ray {
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
