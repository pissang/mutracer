#ifndef MUTRACER_GPU_H
#define MUTRACER_GPU_H
#include "mutracer-engine.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Platform-neutral output imports and timeline submission. The zero-copy import
 * implementation currently exists for Metal; Vulkan/D3D12 foreign-resource
 * imports are unavailable until their HAL ownership layer is implemented.
 * Same engine/thread rules as mutracer-engine.h; only mt_render_cancel concurrent.
 * Every next must be NULL, reserved field 0, struct_size sizeof(current record).
 */
typedef uint64_t mt_gpu_image;
typedef uint64_t mt_gpu_timeline;
enum { MT_GPU_OUTPUT_HDR = 0, MT_GPU_OUTPUT_DEPTH = 1, MT_GPU_OUTPUT_DISPLAY = 2,
  MT_GPU_OUTPUT_CENTER_DEPTH = 3 };
enum { MT_GPU_TOP_FIRST = 0, MT_GPU_BOTTOM_FIRST = 1 };
typedef struct mt_gpu_export_image {
  uint32_t struct_size;
  uint32_t kind; /* MT_GPU_OUTPUT_*; HDR by default. */
  const void *next;
  mt_gpu_image image;
  uint32_t row_order; /* MT_GPU_TOP_FIRST by default; bottom-first flips Y. */
  uint32_t reserved;
} mt_gpu_export_image;
typedef struct mt_gpu_export_desc {
  uint32_t struct_size;
  uint32_t image_count; /* 1..8, distinct destination textures. */
  const void *next;
  const mt_gpu_export_image *images; /* Borrowed only during this call. */
  mt_gpu_timeline ready; /* 0 skips the GPU wait; ready_value must then be 0. */
  uint64_t ready_value; /* 0..UINT64_MAX-1; host must eventually signal it. */
  mt_gpu_timeline done; /* Required. One producer per done timeline. */
  uint64_t done_value; /* 1..UINT64_MAX-1, greater than all previous/observed signals. */
} mt_gpu_export_desc;
/* Export latest published images without CPU pixel transfer or waiting for a new
 * sample. HDR is linear raw RGBA; depth is camera-forward scene-unit distance
 * (not clip depth). CENTER_DEPTH matches MT_IMAGE_CENTER_DEPTH: the unjittered
 * pinhole center hit shared with IDs, with binary validity instead of averaged
 * coverage. Display requires mt_display_present first. Exact dimensions
 * are required; formats/usage are specified by the platform import declaration.
 * DEPTH requires MT_AOV_DEPTH; CENTER_DEPTH requires MT_AOV_CENTER_DEPTH.
 * A disabled or not-yet-ready source returns MT_ERROR_INVALID_STATE.
 * Refinement/sample counts are unchanged.
 *
 * All validation and encoding finish before acceptance. *sequence is initially
 * set to 0; rejected calls touch no external wait/signal. MT_OK gives a nonzero
 * engine-local sequence, and done covers every image. No encoding can fail after
 * acceptance. Device loss or unexpected submission failure returns UNAVAILABLE
 * with unknown outcome; external signals may never arrive. Stop waiting/rebuild
 * the engine and host device on loss. Output is invalid on any failure.
 *
 * Both waits/signals execute on GPU. A same-event wait must be less than done.
 * Host reuse must wait for done, then signal ready after its own readers finish.
 * Signal ready independently of CPU submit return; avoid cyclic dependencies.
 * An unsignalled ready can stall subsequent library GPU work. Cancellation does
 * not revoke accepted exports. Native queue saturation may backpressure the CPU;
 * first use of a format/row order can block for pipeline compilation.
 *
 * At most 32 batches pending (BUSY before acceptance); poll to retire them.
 * Images/timelines may be destroyed immediately after submit; work retains native
 * objects. mt_engine_destroy returns BUSY without removing handles until exports
 * finish (polls once, does not wait for ready). Drain before releasing the host's
 * backing storage. Device loss is terminal and permits destruction, without
 * promising done signals. Invalid handles/arguments/state use ordinary statuses.
 */
mt_status mt_render_export_gpu(mt_render render, const mt_gpu_export_desc *desc,
  uint64_t *sequence, char *error, size_t capacity);
/* Nonblocking completion query. sequence 0 queries all accepted exports; a future
 * sequence is INVALID_ARGUMENT. complete is 0 on failure. Completion includes
 * external signals; device loss reports UNAVAILABLE, never success. */
mt_status mt_engine_gpu_poll(mt_engine engine, uint64_t sequence,
  uint32_t *complete, char *error, size_t capacity);
/* Release an import; no CPU wait. Unknown/destroyed handles INVALID_HANDLE.
 * Engine destruction releases all imports and invalidates their handles. */
mt_status mt_gpu_image_destroy(mt_gpu_image image, char *error, size_t capacity);
mt_status mt_gpu_timeline_destroy(mt_gpu_timeline timeline, char *error, size_t capacity);
#if defined(__cplusplus) && __cplusplus >= 201103L
#define MT_GPU_LAYOUT(type, size) static_assert(sizeof(type) == (size), #type " layout")
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define MT_GPU_LAYOUT(type, size) _Static_assert(sizeof(type) == (size), #type " layout")
#else
#define MT_GPU_LAYOUT(type, size)
#endif
MT_GPU_LAYOUT(mt_gpu_export_image, 32);
MT_GPU_LAYOUT(mt_gpu_export_desc, 56);
#undef MT_GPU_LAYOUT
#ifdef __cplusplus
}
#endif
#endif
