#ifndef MUTRACER_SCENE_H
#define MUTRACER_SCENE_H
#include <stddef.h>
#include <stdint.h>
#include "mutracer-material-properties.h"
#include "mutracer-layout.h"
/* Raw scene descriptor v4 records. The format, validation rules and limits are
 * in native/docs/scene-format.md; mt_context_commit (mutracer-context.h)
 * consumes the descriptor. Every record is a run of little-endian 32-bit words:
 * uint32_t fields, float fields as IEEE binary32. Offsets are word offsets from
 * the start of the descriptor, and offset 0 omits an optional array. Reserved
 * fields must be zero. The descriptor defaults to an 8192 MiB admission budget
 * (MUTRACER_NATIVE_MEMORY_BUDGET_MIB, positive integer MiB) and must fit uint32_t
 * word offsets. Prepared resources must also fit the selected GPU's buffers.
 * The structs below have no padding and match the MT_*
 * word offsets in mutracer-layout.h; copy them into the descriptor with memcpy
 * (mutracer-scene-builder.h does this) rather than casting the word buffer.
 */

/* Named field values. */
#define MT_NO_TEXTURE UINT32_MAX /* Material texture slots and extension textures. */
#define MT_BATCH_ORDINARY_MESH UINT32_MAX /* mt_batch_v4.count for a non-instanced mesh. */
enum { MT_LIGHT_TYPE_RECT = 0, MT_LIGHT_TYPE_SPHERE = 1, MT_LIGHT_TYPE_DIRECTIONAL = 2,
  MT_LIGHT_TYPE_SPOT = 3 };
enum { MT_TEXTURE_STORAGE_RGBA8_SRGB = 0, MT_TEXTURE_STORAGE_RGBA32F = 1 };
enum { MT_TEXTURE_WRAP_REPEAT = 0, MT_TEXTURE_WRAP_CLAMP_TO_EDGE = 1, MT_TEXTURE_WRAP_MIRRORED_REPEAT = 2 };
enum { MT_CAMERA_PROJECTION_PERSPECTIVE = 0, MT_CAMERA_PROJECTION_ORTHOGRAPHIC = 1 };
enum { MT_QUALITY_BEVEL = 1, MT_QUALITY_DISPERSION = 2, MT_QUALITY_HIDE_BACKGROUND = 4 };

typedef struct mt_scene_header_v4 {
  uint32_t version; /* MT_VERSION_SCENE */
  uint32_t total_words; /* Descriptor length in words. */
  uint32_t width, height; /* Output pixels. */
  uint32_t geometry_count, mesh_count, material_count, light_count, texture_count;
  uint32_t geometry_offset, mesh_offset, material_offset, light_offset, texture_offset;
  uint32_t camera_offset; /* One mt_camera_v4. */
  uint32_t reserved0;
  float background_color[4]; /* Linear RGBA when no background map is visible. */
  uint32_t environment_texture_plus_one, background_texture_plus_one; /* 0 = none. */
  uint32_t quality_flags; /* MT_QUALITY_* bits. */
  uint32_t batch_offset; /* 0, or mesh_count mt_batch_v4 records. */
  uint32_t mesh_aov_ids_offset; /* Optional mesh_count stable uint32_t object IDs; 0 uses descriptor indices. */
  uint32_t material_aov_ids_offset; /* Optional material_count stable uint32_t material IDs; 0 uses descriptor indices. */
  uint32_t environment_settings_offset; /* 0 = defaults, or four floats: lighting intensity,
    * lighting yaw, background intensity, background yaw. Yaw is radians about +Y;
    * intensities are finite and nonnegative. Defaults 1,0,1,0. */
  uint32_t grounded_background_offset; /* 0 disables projection, or six floats: height, radius, floor Y, center X/Z, 0. Height > 0, radius > height; all finite. */
  uint32_t reserved_end[4];
} mt_scene_header_v4;

typedef struct mt_geometry_v4 {
  uint32_t vertex_count, index_count;
  uint32_t position_offset; /* float XYZ per vertex. */
  uint32_t index_offset; /* uint32_t, three per triangle. */
  uint32_t normal_offset; /* Optional float XYZ; generated when 0. */
  uint32_t uv_offset, uv1_offset; /* Optional float XY. */
  uint32_t color_offset; /* Optional float RGB. */
  uint32_t tangent_offset; /* Optional float XYZW; generated when 0. */
  uint32_t material_index_offset; /* Optional uint32_t per vertex into the mesh table. */
  uint32_t reserved[2];
} mt_geometry_v4;

typedef struct mt_mesh_v4 {
  uint32_t geometry_index, material_index;
  uint32_t material_table_offset, material_table_count; /* 0 count uses material_index. */
  float world_matrix[16]; /* Column-major affine local-to-world. */
} mt_mesh_v4;

typedef struct mt_material_v4 {
  float base_color[3], roughness, metalness, transmission, ior;
  float emission_color[3], emission_luminance;
  float coat_weight, coat_roughness, opacity;
  uint32_t thin_walled; /* 0 or 1. */
  uint32_t base_texture, normal_texture, metallic_roughness_texture, emissive_texture;
  uint32_t extension_count, extension_offset; /* mt_material_extension_v4 array. */
  uint32_t reserved[3];
} mt_material_v4;

typedef struct mt_material_extension_v4 {
  uint32_t id; /* enum mt_material_property */
  union { float f[3]; uint32_t u[3]; } value; /* Unused components zero. */
} mt_material_extension_v4;

typedef struct mt_texture_v4 {
  uint32_t width, height;
  uint32_t storage; /* MT_TEXTURE_STORAGE_* */
  uint32_t pixel_offset; /* RGBA8 words or RGBA32F floats, row-major. */
  uint32_t flip_y, uv_channel; /* 0 or 1. */
  float uv_scale[2], uv_offset[2];
  uint32_t wrap_s, wrap_t; /* MT_TEXTURE_WRAP_*, independently per axis; default repeat. */
} mt_texture_v4;

typedef struct mt_light_v4 {
  uint32_t type; /* MT_LIGHT_TYPE_* */
  float color[3], intensity;
  float size_or_radius; /* Rect width, sphere radius. */
  float height_or_inner_angle; /* Rect height, spot inner angle in degrees. */
  float spread_or_outer_angle; /* Rect spread, spot outer angle in degrees. */
  uint32_t texture_plus_one; /* Rect lights only; 0 = none. */
  uint32_t ies_offset, ies_bytes; /* Spot lights only; LM-63 text, byte length. */
  uint32_t reserved;
  float world_matrix[16];
} mt_light_v4;

typedef struct mt_camera_v4 {
  uint32_t projection; /* MT_CAMERA_PROJECTION_* */
  float fov; /* Vertical, degrees. */
  float near_clip, far_clip, left, right, bottom, top, zoom;
  float f_stop, focus_distance, sensor_height, meters_per_unit;
  uint32_t reserved[3];
  float world_matrix[16]; /* Camera-to-world; the camera looks down -Z. */
} mt_camera_v4;

typedef struct mt_batch_v4 {
  uint32_t count; /* MT_BATCH_ORDINARY_MESH, 0 (empty) or instance count. */
  uint32_t transforms_offset; /* count column-major float[16] local matrices. */
  uint32_t colors_offset; /* Optional count float RGB multipliers. */
  uint32_t reserved;
} mt_batch_v4;

/* Compile-time agreement between the structs and mutracer-layout.h. */
#if defined(__cplusplus) && __cplusplus >= 201103L
#define MT_SCENE_ASSERT(name, test) static_assert(test, #name)
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define MT_SCENE_ASSERT(name, test) _Static_assert(test, #name)
#else
#define MT_SCENE_ASSERT(name, test) typedef char mt_scene_assert_##name[(test) ? 1 : -1]
#endif
#define MT_SCENE_FIELD(type, field, word) (offsetof(type, field) == (word) * MT_WORD_BYTES)
MT_SCENE_ASSERT(header_size, sizeof(mt_scene_header_v4) == MT_HEADER_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(header_background, MT_SCENE_FIELD(mt_scene_header_v4, background_color, MT_HEADER_BACKGROUND_COLOR));
MT_SCENE_ASSERT(header_batch, MT_SCENE_FIELD(mt_scene_header_v4, batch_offset, MT_HEADER_BATCH_OFFSET));
MT_SCENE_ASSERT(geometry_size, sizeof(mt_geometry_v4) == MT_GEOMETRY_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(geometry_material_index, MT_SCENE_FIELD(mt_geometry_v4, material_index_offset, MT_GEOMETRY_MATERIAL_INDEX));
MT_SCENE_ASSERT(mesh_size, sizeof(mt_mesh_v4) == MT_MESH_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(mesh_transform, MT_SCENE_FIELD(mt_mesh_v4, world_matrix, MT_MESH_TRANSFORM));
MT_SCENE_ASSERT(material_size, sizeof(mt_material_v4) == MT_MATERIAL_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(material_thin_walled, MT_SCENE_FIELD(mt_material_v4, thin_walled, MT_MATERIAL_THIN_WALLED));
MT_SCENE_ASSERT(material_extensions, MT_SCENE_FIELD(mt_material_v4, extension_offset, MT_MATERIAL_EXTENSION_OFFSET));
MT_SCENE_ASSERT(extension_size, sizeof(mt_material_extension_v4) == MT_EXTENSION_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(texture_size, sizeof(mt_texture_v4) == MT_TEXTURE_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(texture_uv_offset, MT_SCENE_FIELD(mt_texture_v4, uv_offset, MT_TEXTURE_UV_OFFSET));
MT_SCENE_ASSERT(texture_wrap_s, MT_SCENE_FIELD(mt_texture_v4, wrap_s, MT_TEXTURE_WRAP_S));
MT_SCENE_ASSERT(texture_wrap_t, MT_SCENE_FIELD(mt_texture_v4, wrap_t, MT_TEXTURE_WRAP_T));
MT_SCENE_ASSERT(light_size, sizeof(mt_light_v4) == MT_LIGHT_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(light_ies, MT_SCENE_FIELD(mt_light_v4, ies_bytes, MT_LIGHT_IES_BYTES));
MT_SCENE_ASSERT(light_transform, MT_SCENE_FIELD(mt_light_v4, world_matrix, MT_LIGHT_TRANSFORM));
MT_SCENE_ASSERT(camera_size, sizeof(mt_camera_v4) == MT_CAMERA_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(camera_units, MT_SCENE_FIELD(mt_camera_v4, meters_per_unit, MT_CAMERA_METERS_PER_UNIT));
MT_SCENE_ASSERT(camera_transform, MT_SCENE_FIELD(mt_camera_v4, world_matrix, MT_CAMERA_TRANSFORM));
MT_SCENE_ASSERT(batch_size, sizeof(mt_batch_v4) == MT_BATCH_WORDS * MT_WORD_BYTES);
MT_SCENE_ASSERT(batch_colors, MT_SCENE_FIELD(mt_batch_v4, colors_offset, MT_BATCH_COLORS));
#undef MT_SCENE_FIELD
#undef MT_SCENE_ASSERT
#endif
