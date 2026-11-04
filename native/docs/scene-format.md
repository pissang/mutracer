# Native scene descriptor format (v4)

`mt_context_commit` and `mt_engine_set_scene` take a scene as one byte buffer:
the raw scene descriptor. This page is the reference for its layout, values and
validation rules. The record structs are in
[`mutracer-scene.h`](../include/mutracer-scene.h), the word offsets in
[`mutracer-layout.h`](../include/mutracer-layout.h), and material property IDs
in [`mutracer-material-properties.h`](../include/mutracer-material-properties.h).

Most applications should build scenes with the [Scene API](scene.md) instead,
which needs no offsets and can export descriptors.

## Usage

Fill the record structs and assemble them with the header-only builder in
[`mutracer-scene-builder.h`](../include/mutracer-scene-builder.h).
[`examples/minimal-host.c`](../examples/minimal-host.c) is a complete program
that builds, commits, renders and reads one scene.

```c
#include "mutracer-context.h"
#include "mutracer-scene-builder.h"

mt_scene_builder b;
mt_scene_builder_init(&b);
mt_geometry_v4 geometry = {0};
geometry.vertex_count = 4;
geometry.index_count = 6;
geometry.position_offset = mt_scene_builder_append(&b, positions, sizeof positions);
geometry.index_offset = mt_scene_builder_append(&b, indices, sizeof indices);
mt_material_v4 material = mt_material_v4_default();
/* ... mesh, light, camera ... */
mt_scene_header_v4 header = {0};
header.width = 640;
header.height = 480;
header.geometry_count = 1;
header.geometry_offset = mt_scene_builder_append(&b, &geometry, sizeof geometry);
/* ... remaining tables ... */
size_t bytes = mt_scene_builder_finish(&b, &header);
mt_context_commit(context, mt_scene_builder_bytes(&b), bytes, error, sizeof error);
mt_scene_builder_free(&b);
```

- Append arrays first, store the returned word offsets in the records that
  reference them, then append each record table as one contiguous array.
- `mt_scene_builder_append` returns 0 after an allocation failure, and
  `mt_scene_builder_finish` then returns 0. Check the byte count before committing.
- Start materials, textures and cameras from `mt_material_v4_default()`,
  `mt_texture_v4_default()` and `mt_camera_v4_default()`. A zeroed record is
  not a neutral default: opacity 0 is transparent and texture index 0 is a real
  texture.
- `mt_scene_look_at` writes a camera-to-world (or light-to-world) matrix whose
  -Z axis points from `eye` to `target`, with +Y up. It cannot look straight up
  or down.
- Commit copies the descriptor, so the builder can be freed right after it.
- A rejected descriptor returns `MT_ERROR_INVALID_ARGUMENT` with a message
  naming the problem, and the previous scene stays committed.

Without the builder, write records into a `uint32_t` buffer with `memcpy` and
fill the header last. The structs have no padding and compile-time checks keep
them in agreement with `mutracer-layout.h`.

## Layout

The descriptor is a sequence of little-endian 32-bit words. `uint32_t` fields
are integers and `float` fields are IEEE binary32 bits. Every offset is a word
offset from the start of the descriptor; the header occupies words 0..31.

- Table offsets in the header must lie inside the descriptor, at word 32 or
  later, even when the table is empty. The builder handles empty light and
  texture tables.
- Optional arrays use offset 0 to mean "absent".
- Reserved fields and padding words must be 0.
- All floats must be finite.
- Matrices are 16 floats, column-major, invertible and affine.

Each record's fields are listed in `mutracer-scene.h`. The sections below give
the rules the validator enforces.

### Header

- `version` must be `MT_VERSION_SCENE` (4); `total_words` is the descriptor
  length. `quality_flags` accepts only the `MT_QUALITY_*` bits.
- Environment and background maps (`*_texture_plus_one`, 0 for none) must be
  linear RGBA32F equirectangular textures; their flip, wrap and UV transform
  fields are ignored. Lighting and the visible background are independent, but
  `MT_QUALITY_HIDE_BACKGROUND` cannot be combined with a background map.
- `environment_settings_offset` is 0 for default controls, or points to four
  finite floats: lighting intensity, lighting yaw, background intensity,
  background yaw. Intensities are nonnegative, default 1; yaw is local-to-world
  rotation about +Y in radians, default 0. The background controls apply only
  to its map; lighting and background can use the same source texture.
- `grounded_background_offset` is 0 for an ordinary background map, or points
  to six floats: capture height, dome radius, floor Y, capture center X/Z and 0.
  All values are finite, height is positive and radius exceeds height. Projection
  changes camera-ray backgrounds without changing the environment lighting.
- `mesh_aov_ids_offset` and `material_aov_ids_offset` optionally point to one
  uint32 ID per mesh or material. IDs in each table must be unique and must
  exclude `UINT32_MAX` (the background ID). Omitted tables use descriptor indices.

### Geometry and meshes

- Positions and indices are required; missing normals and tangents are
  generated.
- All three vertices of a triangle must select the same material. Duplicate
  shared vertices where neighboring triangles use different materials.
- A mesh with `material_table_count` 0 uses `material_index`; otherwise the
  geometry's per-vertex material indices select entries of the mesh's table.
  Several meshes may share one geometry.

### Batches

When `batch_offset` is nonzero, every mesh has one `mt_batch_v4`:

- `MT_BATCH_ORDINARY_MESH` or 0 (empty, renders nothing): both offsets must
  be 0.
- Otherwise `count` local matrices and optional RGB multipliers. The mesh world
  matrix is applied outside each local matrix.
- Expanded instances share the [scene instance budget](#limits).

### Materials

- Start from `mt_material_v4_default()`; its values match the browser
  `OpenPBRMaterial`.
- Other OpenPBR properties (thin film, participating media, anisotropy, coat,
  fuzz, alpha modes, displacement and further texture slots) go in the
  `mt_material_extension_v4` array, built with `mt_extension_float` and
  `mt_extension_uint`. Each ID appears at most once, unused components are 0,
  and extensions override the basic fields. The
  [property header](../include/mutracer-material-properties.h) gives each ID's
  type and enum values.
- Displacement: only the first material of a mesh supplies it. Active
  displacement needs a square power-of-two texture, a positive step size, and
  UVs when the projection is `none`. The offset is `height × scale + bias` in
  mesh-local units. The absolute projection scale, and each position or UV
  component multiplied by it, must not exceed 1,000,000.

### Textures

- RGBA8 sRGB storage uses one packed word per pixel; RGBA32F uses four linear
  floats. Pixels are row-major.
- Negative UV scales flip an axis; zero samples a constant coordinate.
- Textures may be scaled to fit the [GPU texture budget](#limits).

### Lights

- Rectangular lights need positive width and height. Spot angles are in degrees,
  with 0 ≤ inner ≤ outer < 90 and outer > 0.
- Rectangular, spot and directional lights emit along their local -Z axis;
  local +X is the IES reference direction.
- Only rectangular lights accept a texture. Only spot lights accept an IES
  profile: UTF-8 LM-63 Type C text with `TILT=NONE`, at most 16 KiB, without a
  terminating NUL (offset 0 and length 0 for none). Lights with the same offset
  and length share one profile.

### Camera

The camera looks down its local -Z axis, its aspect ratio follows the header's
`width` and `height`, and `f_stop` 0 disables depth of field. A commit that
changes only the camera is incremental.

## Limits

- At least one geometry, mesh and material; at most 65,536 geometries, materials
  and textures, and 64 analytic lights. Meshes and expanded instances are limited
  to 16,777,216 and the memory budget (160 bytes per instance); HWRT also checks
  the selected GPU's TLAS instance limit.
- Output edges 1–8,192 with at most 16,777,216 pixels; actual output is also
  limited by the selected GPU's storage-buffer, texture and dispatch limits.
- Input and prepared geometry each default to an 8 GiB admission budget, changed
  with `MUTRACER_NATIVE_MEMORY_BUDGET_MIB` (positive integer MiB). This does not
  cap peak process memory. Descriptors must also fit 32-bit word offsets (under
  16 GiB). A scene's combined prepared resources must stay below 4 GiB.
  Input texture pixels are limited to the configured material budget divided by
  four, plus 4,194,304 pixels for environment/background images; each edge is at
  most 16,384 pixels.
- At most 4,000,000 vertices and 12,000,000 indices per geometry. Multi-material
  and displacement scenes can need more preparation memory. The selected GPU
  must support each resident buffer; use HWRT when the software BVH exceeds its
  buffer or preparation budget.
- Material textures default to a 3 GiB budget. Set
  `MUTRACER_NATIVE_TEXTURE_BUDGET_MIB` to an integer from 1 through 4095 before
  starting the process to change it; missing or invalid values use the default.
  The budget applies to both material-image import and GPU storage. Restart the
  viewer after changing it. A larger budget permits more GPU and decoded CPU
  memory use.
  RGBA8 uses four bytes per pixel; when any material texture needs floating-point
  storage, all use RGBA16F at eight bytes per pixel. Original dimensions are
  preserved when they fit the budget and the selected device's texture limits.
  Devices with enabled texture binding arrays use separate images; other devices
  use an atlas with at most 256 layers, whose packing can require more reduction.
  With binding arrays, textures sharing pixel storage, dimensions, format and
  vertical flip use one GPU image and count once toward the budget; UV transforms
  and wrap modes remain independent. Editing one texture's pixels can create a
  separate image and increase memory use.
