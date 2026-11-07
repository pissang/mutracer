#ifndef MUTRACER_METAL_H
#define MUTRACER_METAL_H
#include "mutracer-gpu.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Metal pointer imports (use __bridge void * under ARC). No Objective-C headers
 * required. Non-macOS builds export these functions and return UNAVAILABLE.
 * All pointers are trusted native objects; invalid/dangling objects are unsafe.
 * Same per-engine serialization as mutracer-engine.h; only cancel concurrent.
 */
typedef struct mt_metal_device_desc {
  uint32_t struct_size;
  uint32_t reserved; /* 0. */
  const void *next; /* NULL. */
  void *device; /* Required id<MTLDevice>. */
  void *queue; /* Optional id<MTLCommandQueue>; NULL creates a library queue. */
} mt_metal_device_desc;
typedef struct mt_metal_image_desc {
  uint32_t struct_size;
  uint32_t reserved; /* 0. */
  const void *next; /* NULL. */
  void *texture; /* Required id<MTLTexture>. */
} mt_metal_image_desc;
typedef struct mt_metal_timeline_desc {
  uint32_t struct_size;
  uint32_t reserved; /* 0. */
  const void *next; /* NULL. */
  void *event; /* Required id<MTLSharedEvent>. */
} mt_metal_timeline_desc;
/* Import and retain the host device/queue, host ownership unchanged. options is
 * NULL for defaults (HWRT with Software fallback); imported HWRT requests the
 * required ray-query capability if supported. Both backends work on this device.
 * Host objects must stay usable through GPU completion and engine disposal.
 * Prefer a separate library queue. If queue is provided, it must belong to device;
 * host submissions must be serialized with SDK calls/background preparation.
 * Its command-buffer capacity must cover queued SDK plus host work; the example
 * uses newCommandQueueWithMaxCommandBufferCount:4096 for the 32-batch stress case.
 * Outputs are 0 on failure; invalid records/options INVALID_ARGUMENT, unavailable
 * adapter/features/allocations UNAVAILABLE. */
mt_status mt_engine_create_metal(const mt_metal_device_desc *desc,
  const mt_engine_options *options, mt_engine *engine, char *error, size_t capacity);
/* Import and retain an ordinary 2D single-sample/layer/mip texture on this engine's
 * device. Requires MTLTextureUsageShaderWrite, tracked hazards and private/shared
 * storage. No memoryless/managed textures. Host may add ShaderRead for consumption.
 * HDR: MTLPixelFormatRGBA32Float matches MT_IMAGE_HDR exactly; RGBA16Float uses
 * nearest-even float-to-half rounding, including overflow. Depth: R32Float
 * (distance) or RGBA32Float (distance,0,0,coverage). CENTER_DEPTH uses the same
 * formats, with center-hit validity in place of coverage.
 * Display: RGBA8Unorm. No conversion of color space, scaling or clip-depth mapping.
 * Exact source dimensions checked on each export, including after render resize.
 * Imported rows default top first; use MT_GPU_BOTTOM_FIRST for a GL-style consumer.
 * Do not import aliasing textures or make storage purgeable while imports/work exist.
 * The import retains native texture; pending GPU work retains it after destroy.
 * Wrong device/type/usage/storage/format INVALID_ARGUMENT; an engine created
 * without mt_engine_create_metal returns UNAVAILABLE.
 */
mt_status mt_engine_import_metal_image(mt_engine engine, const mt_metal_image_desc *desc,
  mt_gpu_image *image, char *error, size_t capacity);
/* Retains a compatible shared event. Reimports share one signal history until
 * engine destruction; releasing/reimporting does not reset monotonicity.
 * Use separate ready/done timelines when producers can overlap. UINT64_MAX reserved.
 * A timeline remains retained by the engine until disposal, and by in-flight work.
 */
mt_status mt_engine_import_metal_timeline(mt_engine engine, const mt_metal_timeline_desc *desc,
  mt_gpu_timeline *timeline, char *error, size_t capacity);
#if defined(__cplusplus) && __cplusplus >= 201103L
#define MT_GPU_LAYOUT(type, size) static_assert(sizeof(type) == (size), #type " layout")
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define MT_GPU_LAYOUT(type, size) _Static_assert(sizeof(type) == (size), #type " layout")
#else
#define MT_GPU_LAYOUT(type, size)
#endif
MT_GPU_LAYOUT(mt_metal_device_desc, 32);
MT_GPU_LAYOUT(mt_metal_image_desc, 24);
MT_GPU_LAYOUT(mt_metal_timeline_desc, 24);
#undef MT_GPU_LAYOUT
#ifdef __cplusplus
}
#endif
#endif
