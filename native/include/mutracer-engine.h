#ifndef MUTRACER_ENGINE_H
#define MUTRACER_ENGINE_H
#include <stddef.h>
#include <stdint.h>
#include "mutracer-scene.h"
#include "mutracer-status.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Experimental engine API, the same object model as the browser library: an
 * engine owns the device and the committed scene and camera, each render is an
 * independently configured accumulation, the display composes, presents and
 * exports images, and a render loop implements the interactive policy. See
 * native/docs/engine.md for usage and the differences from the browser library.
 * mt_context (mutracer-context.h) stays available as the lower-level API.
 *
 * Return MT_OK (0) or a nonzero mt_status. If error is non-NULL and
 * capacity > 0, it receives a truncated NUL-terminated UTF-8 message. Records
 * start with struct_size (see mutracer-status.h); initialize them with the
 * matching mt_*_default function when provided. Inputs are copied; no caller pointer is
 * retained except callback user pointers.
 *
 * Threads: an engine and everything created from it may be called from any
 * thread, one thread at a time. Only mt_render_cancel may be called concurrently,
 * from any thread. Full scene preparation and denoising run on library threads.
 * Event/progress callbacks run synchronously on the calling thread inside
 * mt_engine_update,
 * mt_engine_read_depth_samples,
 * mt_render_refine, mt_render_refine_until, mt_render_converge and the render loop calls, and may call
 * back into this API, except into the render loop that is running them
 * (MT_ERROR_INVALID_STATE).
 *
 * Handles are unique until process exit. mt_engine_destroy releases the
 * engine's display, renders and loops; their handles then return
 * MT_ERROR_INVALID_HANDLE.
 *
 * Images are top row first (mt_context images are bottom row first).
 */
typedef uint64_t mt_engine;
typedef uint64_t mt_display;
/* Record sizes; no record has implicit padding. Reserved fields must be 0. */
#if defined(__cplusplus) && __cplusplus >= 201103L
#define MT_ENGINE_LAYOUT(type, size) static_assert(sizeof(type) == (size), #type " layout")
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define MT_ENGINE_LAYOUT(type, size) _Static_assert(sizeof(type) == (size), #type " layout")
#else
#define MT_ENGINE_LAYOUT(type, size)
#endif
typedef uint64_t mt_render;
typedef uint64_t mt_render_loop;

/* ---- Engine ---- */

typedef struct mt_engine_options {
  uint32_t struct_size;
  uint32_t backend; /* mt_backend. Default MT_BACKEND_HWRT. */
} mt_engine_options;
MT_ENGINE_LAYOUT(mt_engine_options, 8);
int32_t mt_engine_options_default(mt_engine_options *output);
/* Creates a device of its own. No usable GPU returns MT_ERROR_UNAVAILABLE. */
int32_t mt_engine_create(const mt_engine_options *options, mt_engine *output, char *error, size_t capacity);
int32_t mt_engine_destroy(mt_engine engine, char *error, size_t capacity);
/* Enumeration creates no devices. NULL/0 queries required count; enough capacity
 * writes all records (no initialization required). BUFFER_TOO_SMALL writes only
 * required. Order: backend, vendor, device, name. Indices refer to this machine's
 * current adapter list; re-enumerate after GPU hotplug. Empty list is valid. */
typedef struct mt_gpu_adapter_info {
  uint32_t struct_size, index;
  uint32_t backend; /* 0 other, 1 Metal, 2 Vulkan, 3 DX12. */
  uint32_t vendor, device; /* Native PCI identifiers when available; otherwise 0. */
  uint32_t device_type; /* 0 other, 1 discrete, 2 integrated, 3 CPU, 4 virtual. */
  uint32_t hardware_ray_query, reserved; /* Capability boolean; reserved=0. */
  char name[256]; /* NUL-terminated UTF-8 adapter name, possibly truncated. */
} mt_gpu_adapter_info;
MT_ENGINE_LAYOUT(mt_gpu_adapter_info, 288);
int32_t mt_gpu_adapters(mt_gpu_adapter_info *output, size_t capacity, size_t *required, char *error, size_t error_capacity);
/* Creates on this enumerated adapter. Unavailable index/device returns UNAVAILABLE;
 * never falls back to another adapter. options.backend still selects traversal. */
int32_t mt_engine_create_on_adapter(const mt_engine_options *options, uint32_t adapter_index,
  mt_engine *output, char *error, size_t capacity);
/* Window engines own their adapter/device. External Vulkan device/image access
 * is available separately through mutracer-vulkan.h; Rust supports Engine::on_device.
 * All engine/display/render/loop calls (including destroy) stay on the creating
 * window thread for this engine's lifetime; mt_render_cancel may cross threads.
 * macOS: kind 1, window=NSView*, call on main thread. Windows: kind 2,
 * window=HWND. Linux: kind 3, display=Display*, window_id=Xlib Window (screen 0);
 * kind 4, display=wl_display*, window=wl_surface*. Other kinds return UNAVAILABLE.
 * Host owns handles and keeps them valid until detach/replacement/destroy returns.
 * No window event loop is created: pump native events and call present/tick.
 * Width/height are physical pixels; zero suspends presentation. Default vsync,
 * automatic alpha, SDR; Display settings can request HDR with SDR fallback.
 * create selects a surface-compatible adapter. Reattach uses that same device;
 * incompatible windows fail without replacing the old attachment. */
typedef enum mt_window_kind { MT_WINDOW_APPKIT=1, MT_WINDOW_WIN32=2, MT_WINDOW_XLIB=3, MT_WINDOW_WAYLAND=4 } mt_window_kind;
typedef struct mt_native_window {
  uint32_t struct_size, kind, width, height;
  void *display, *window;
  uint64_t window_id;
} mt_native_window;
MT_ENGINE_LAYOUT(mt_native_window, 24 + 2 * sizeof(void *));
int32_t mt_engine_create_for_window(const mt_engine_options *options, const mt_native_window *window,
  mt_engine *output, char *error, size_t capacity);
/* Same window/thread/lifetime rules; selected adapter must support the surface,
 * otherwise UNAVAILABLE. No fallback to another adapter. */
int32_t mt_engine_create_for_window_on_adapter(const mt_engine_options *options, const mt_native_window *window,
  uint32_t adapter_index, mt_engine *output, char *error, size_t capacity);
int32_t mt_display_attach_window(mt_display display, const mt_native_window *window, char *error, size_t capacity);
int32_t mt_display_detach_window(mt_display display, char *error, size_t capacity);
int32_t mt_display_resize_window(mt_display display, uint32_t width, uint32_t height, char *error, size_t capacity);
typedef enum mt_surface_status {
  MT_SURFACE_READY=0, MT_SURFACE_PRESENTED=1, MT_SURFACE_TIMEOUT=2,
  MT_SURFACE_OCCLUDED=3, MT_SURFACE_OUTDATED=4, MT_SURFACE_LOST=5,
  MT_SURFACE_SUSPENDED=6, MT_SURFACE_ERROR=7
} mt_surface_status;
/* status describes the last acquisition, separate from offscreen mt_presented.
 * Timeout/outdated retry later; occluded waits for expose/restore; lost needs
 * reattach. Validation errors also return an error. Device loss is terminal.
 * Surface info queries CPU state without acquiring a frame. */
typedef struct mt_surface_info {
  uint32_t struct_size, attached, width, height, status, hdr_requested, hdr_active, reserved;
  char format[64], hdr_unavailable_reason[256];
} mt_surface_info;
MT_ENGINE_LAYOUT(mt_surface_info, 352);
int32_t mt_display_surface_info(mt_display display, mt_surface_info *output, char *error, size_t capacity);

/* Records a scene descriptor (native/docs/scene-format.md), copied; it takes
 * effect at the next mt_engine_update. Width, height, the bevel and dispersion
 * quality bits and (after mt_engine_set_camera) the camera record are replaced
 * per render; the other fields are used as given. */
int32_t mt_engine_set_scene(mt_engine engine, const uint8_t *descriptor, size_t length, char *error, size_t capacity);
/* Records an empty scene for update: cancels work, releases scene and images,
 * keeps reusable render handles/settings. Update may wait for preparation/GPU
 * retirement; it never waits for a custom denoiser callback. Attached windows
 * present transparent black (opaque windows show black); skipped frames follow
 * the normal surface retry contract. */
int32_t mt_engine_clear_scene(mt_engine engine, char *error, size_t capacity);
/* CPU snapshot, O(render count), no GPU polling/readback. Engine-lifetime path-tracing
 * cache counters exclude display/depth pipelines. completed counts exited compile
 * attempts, including failures; hits reuse an existing variant. Cache max 32.
 * sampling/denoising count renders with pending work, refreshed by API collection.
 * Device/capability details are in mt_engine_info. Errors use call buffers/events.
 * Logging is an optional stream; this query works with logging disabled. */
typedef struct mt_engine_diagnostics_info {
  uint32_t struct_size, has_scene, preparing, compiling;
  uint64_t scene_revision, compilations_started, compilations_completed, pipeline_cache_hits;
  uint32_t cached_pipelines, renders, sampling, denoising;
} mt_engine_diagnostics_info;
MT_ENGINE_LAYOUT(mt_engine_diagnostics_info, 64);
int32_t mt_engine_diagnostics(mt_engine engine, mt_engine_diagnostics_info *output, char *error, size_t capacity);
/* Records the camera for every render; NULL uses the scene's camera record.
 * Takes effect at the next mt_engine_update. Default NULL. */
int32_t mt_engine_set_camera(mt_engine engine, const mt_camera_v4 *camera, char *error, size_t capacity);
/* The sole commit point. changed (optional) receives 1 when the scene or camera
 * changed. Incremental edits are applied to every render on this thread; a render
 * that needs full preparation starts it on a library thread and reports
 * MT_RENDER_PREPARING or MT_RENDER_COMPILING until it is published. A failing
 * render reports an error event and does not stop the others. */
int32_t mt_engine_update(mt_engine engine, uint32_t *changed, char *error, size_t capacity);

enum { MT_DEPTH_SAMPLE_GRID = 7, MT_DEPTH_SAMPLE_COUNT = 49 };
typedef struct mt_depth_sample_area {
  uint32_t struct_size; /* sizeof(mt_depth_sample_area). */
  float x; /* Required: 0..1 from the left. */
  float y; /* Required: 0..1 from the top. */
  float size; /* Required: nonnegative half height / viewport height; 0 = one point. */
} mt_depth_sample_area;
MT_ENGINE_LAYOUT(mt_depth_sample_area, 16);
/* Blocking pinhole query from the committed engine camera, using display aspect.
 * No render or completed beauty sample is required. Top-row-first camera-forward
 * depths in scene units; misses/out-of-viewport rays = 0. Skips alpha holes and
 * invisible catchers through at most 32 layers. No jitter/DOF or accumulation.
 * count/written are numbers of floats, not bytes. written is required: 0 while
 * the committed scene is unready/preparing (retry later), 49 on success.
 * NULL samples + count 0 queries readiness/size; otherwise count must be >=49.
 * A short destination returns BUFFER_TOO_SMALL with written=49, without a copy.
 * Queries can compile a GPU pipeline and wait for readback; no automatic update. */
int32_t mt_engine_read_depth_samples(mt_engine engine, const mt_depth_sample_area *area,
  float *samples, size_t count, size_t *written, char *error, size_t capacity);

typedef struct mt_engine_snapshot {
  uint32_t struct_size;
  uint32_t backend; /* mt_backend requested at creation. */
  uint32_t hardware_ray_query; /* 1 when the device supports ray queries. */
  char adapter_name[256]; /* NUL terminated, truncated UTF-8. */
} mt_engine_snapshot;
MT_ENGINE_LAYOUT(mt_engine_snapshot, 268);
int32_t mt_engine_info(mt_engine engine, mt_engine_snapshot *output, char *error, size_t capacity);

typedef enum mt_engine_event_kind {
  /* Scene preparation: progress 0 when it starts, 1 when it is published. */
  MT_ENGINE_EVENT_PROGRESS = 0,
  MT_ENGINE_EVENT_ERROR = 1,
  /* Terminal device loss; recovering is always 0. See native/docs/engine.md#device-loss. */
  MT_ENGINE_EVENT_DEVICE_LOST = 2,
  MT_ENGINE_EVENT_COMPILATION = 3 /* Cache miss: 0 before compile, 1 after exit. */
} mt_engine_event_kind;
typedef struct mt_engine_event {
  uint32_t struct_size;
  uint32_t kind; /* mt_engine_event_kind. */
  float progress;
  uint32_t recovering;
  const char *message; /* Errors and device loss; valid during the callback only. */
} mt_engine_event;
MT_ENGINE_LAYOUT(mt_engine_event, 16 + sizeof(void *));
typedef void (*mt_engine_callback)(const mt_engine_event *event, void *user);
/* Replaces the engine's event callback; NULL removes it. Default none. */
int32_t mt_engine_set_callback(mt_engine engine, mt_engine_callback callback, void *user, char *error, size_t capacity);

/* ---- Display ---- */

/* The engine's display, created with the engine and released with it. Repeated
 * calls return the same handle. */
int32_t mt_engine_display(mt_engine engine, mt_display *output, char *error, size_t capacity);

typedef enum mt_tone_mapping {
  MT_TONE_MAPPING_AGX = 0, MT_TONE_MAPPING_ACES = 1, MT_TONE_MAPPING_CINEON = 2,
  MT_TONE_MAPPING_REINHARD = 3, MT_TONE_MAPPING_LINEAR = 4
} mt_tone_mapping;
typedef enum mt_display_channel {
  MT_CHANNEL_FINAL = 0, MT_CHANNEL_NORMAL = 1, MT_CHANNEL_ALBEDO = 2,
  MT_CHANNEL_SHADOW = 3, /* Compatibility alias for the final image, as on WebGPU. */
  MT_CHANNEL_SHADOW_CATCHER = 4,
  /* AOV visualization; requires corresponding MT_AOV_* bit on the selected render. */
  MT_CHANNEL_DEPTH = 5, /* Camera-forward depth as clamped grayscale using depth_range. */
  MT_CHANNEL_POSITION = 6, /* World xyz as RGB: origin 0.5; ±position_scale maps to 0/1, clamped. */
  MT_CHANNEL_ROUGHNESS = 7, /* RGB = roughness, metalness, unsupported-reflectance fraction. */
  MT_CHANNEL_DIFFUSE_ALBEDO = 8, /* Supported reflectance clamped to [0,1], then sRGB encoded. */
  MT_CHANNEL_SPECULAR_ALBEDO = 9, /* Same mapping for specular reflectance. */
  MT_CHANNEL_ID = 10, /* Stable pseudocolor of id_component; palette colors can collide. */
  MT_CHANNEL_MOTION = 11 /* Direction as hue (+x red, +y yellow-green), displacement/scale
    as brightness. Invalid history transparent; valid zero motion opaque black. */
} mt_display_channel;
typedef struct mt_display_settings {
  uint32_t struct_size;
  uint32_t tone_mapping; /* mt_tone_mapping. Default MT_TONE_MAPPING_AGX. */
  uint32_t channel; /* mt_display_channel. Default MT_CHANNEL_FINAL. */
  float tone_mapping_exposure; /* Linear multiplier. Default 1. */
  float contrast; /* Default 1. */
  float saturation; /* Default 1. */
  float temperature; /* White balance shift, -1..1. Default 0. */
  float tint; /* Green/magenta, -1..1. Default 0. */
  float vignette; /* 0..1. Default 0. */
  float bloom_intensity; /* Nonnegative; 0 disables bloom. Default 0. */
  float bloom_threshold; /* Nonnegative luminance threshold. Default 1. */
  float bloom_radius; /* 0..1. Default 0.6. */
  float shadow_catcher_color[3]; /* Nonnegative linear RGB. Default black. */
  float shadow_catcher_alpha; /* 0..1. Default 1. Lower values subtract from the
    estimated shadow opacity, so faint shadows disappear first. */
  uint32_t hdr_output_enabled; /* 0 or 1; default 0. Request Rust HDR window output.
    Unsupported surfaces fall back to SDR; C pixel/PNG export remains SDR. */
} mt_display_settings;
MT_ENGINE_LAYOUT(mt_display_settings, 68);
/* Display-only AOV mapping. Does not enable AOVs or change raw pixels/samples.
 * Initialize with mt_display_aov_options_default. Missing AOVs report
 * MT_ERROR_INVALID_STATE on present/export. All floats must be finite. */
typedef struct mt_display_aov_options {
  uint32_t struct_size;
  float depth_range[2]; /* Scene-unit depths mapped to black/white; 0 <= near < far. Default {0,10}. */
  float position_scale; /* Positive scene-unit half-range around origin, mapped to RGB. Default 1. */
  float motion_scale; /* Positive input-pixel displacement mapped to full brightness. Default 16. */
  uint32_t id_component; /* 0 object (default), 1 local instance, 2 material, 3 primitive. */
} mt_display_aov_options;
MT_ENGINE_LAYOUT(mt_display_aov_options, 24);
/* Initializes the full record, including struct_size. Null output is invalid. */
int32_t mt_display_aov_options_default(mt_display_aov_options *output);
/* Uses the mapping from the next present/export; borrows the record during the
 * call. Invalid values/size report MT_ERROR_INVALID_ARGUMENT, preserving settings.
 * mt_display_set_settings preserves this separate mapping configuration. */
int32_t mt_display_set_aov_options(mt_display display, const mt_display_aov_options *options, char *error, size_t capacity);
/* Writes the current mapping; output.struct_size must equal sizeof(*output).
 * Output is borrowed only for this call. Invalid size preserves the output. */
int32_t mt_display_get_aov_options(mt_display display, mt_display_aov_options *output, char *error, size_t capacity);
/* Initializes the full current record, including struct_size. Set/get require
 * struct_size == sizeof(mt_display_settings). */
int32_t mt_display_settings_default(mt_display_settings *output);
/* Display size in pixels; scale-sized renders follow it at their next refine.
 * Default 300x150 (the browser canvas default). */
int32_t mt_display_set_size(mt_display display, uint32_t width, uint32_t height, char *error, size_t capacity);
int32_t mt_display_set_settings(mt_display display, const mt_display_settings *settings, char *error, size_t capacity);
int32_t mt_display_get_settings(mt_display display, mt_display_settings *output, char *error, size_t capacity);

typedef struct mt_presented {
  uint32_t struct_size;
  uint32_t fallback; /* 1 when the render's fallback was shown. */
  uint32_t width, height; /* Render image size before scaling to the display. */
  uint32_t samples;
} mt_presented;
MT_ENGINE_LAYOUT(mt_presented, 20);
/* Composes the render's complete image, or its fallback's, into the display
 * image; smaller images are scaled linearly. shown receives 0 and the previous
 * image stays when neither is ready, for example during preparation. presented
 * is optional. An empty committed scene clears an attached window to transparent
 * black and returns shown=0. Does not trace. */
int32_t mt_display_present(mt_display display, mt_render render, uint32_t *shown, mt_presented *presented,
  char *error, size_t capacity);

typedef enum mt_display_format {
  /* Straight-alpha RGBA8 at the render's size, top row first. */
  MT_DISPLAY_RGBA8 = 0,
  /* The same image encoded as PNG. */
  MT_DISPLAY_PNG = 1
} mt_display_format;
/* The render's complete image composed with the current display settings.
 * pixels=NULL, size=0 queries the required size (which composes the image).
 * written is required; a short destination returns MT_ERROR_BUFFER_TOO_SMALL
 * with the required size. width and height are optional. A render without a
 * complete image returns MT_ERROR_INVALID_STATE. */
int32_t mt_display_read_pixels(mt_display display, mt_render render, uint32_t format,
  void *pixels, size_t size, size_t *written, uint32_t *width, uint32_t *height, char *error, size_t capacity);

/* ---- Render ---- */

typedef enum mt_render_status {
  MT_RENDER_PREPARING = 0,
  MT_RENDER_COMPILING = 1, /* Actual path-tracing cache-miss compilation. */
  MT_RENDER_CONVERGING = 2,
  MT_RENDER_DENOISING = 3,
  MT_RENDER_FINISHED = 4,
  MT_RENDER_ERROR = 5,
  MT_RENDER_IDLE = 6
} mt_render_status;

/* Defaults match the browser library (they differ from mt_render_settings). */
typedef enum mt_alpha_blend_strategy {
  MT_ALPHA_BLEND_STOCHASTIC = 0,
  MT_ALPHA_BLEND_DETERMINISTIC_SOURCE_OVER = 1
} mt_alpha_blend_strategy;
typedef struct mt_render_options {
  uint32_t struct_size;
  uint32_t max_samples; /* 1..16384. Default 2048. */
  uint32_t bounces; /* Clamped to 1..20. Default 3. */
  uint32_t sampling_pattern; /* mt_sampling_pattern. Default MT_SAMPLING_SOBOL. */
  uint32_t direct_light_candidates; /* Clamped to 1..16. Default 4. */
  uint32_t bevel; /* Rounded material edges. Default 1. */
  uint32_t bevel_samples; /* Clamped to 1..32. Default 8. */
  uint32_t dispersion_wavelengths; /* 1 or 3. Default 3. */
  /* Let one refine trace several samples when the measured sample time fits
   * time_budget_ms. Default 0 (one sample per refine). */
  union { uint32_t batch_samples; uint32_t allow_multiple_samples_per_frame; }; /* Alias shares the same flag. */
  /* Fixed size; 0x0 uses resolution_scale of the display size. Default 0x0. */
  uint32_t width, height;
  uint32_t seed; /* Default 12345. */
  uint32_t aovs; /* MT_AOV_* mask; default 0 (no AOV resources or passes). */
  uint32_t aov_samples; /* Independent positive AOV sample cap; 0 selects default 16. */
  double resolution_scale; /* Positive. Default 1. */
  double clamping; /* Per-sample radiance clamp, finite, 0 disables. Default 0. */
  double transmissive_output_alpha_min; /* Finite. Default 1. */
  double time_budget_ms; /* Positive. Default 21. */
  /* Adapt the scale of a scale-based render to frame timing (the browser's
   * adaptiveResolution): between adaptive_min_scale (positive, at most
   * resolution_scale) and resolution_scale, aiming at adaptive_target_frame_ms.
   * Both 0 turn it off. Default 0. */
  double adaptive_target_frame_ms;
  double adaptive_min_scale;
  /* Primary-ray blend policy, both native backends. Default STOCHASTIC.
   * Deterministic source-over blends front/back branches every sample at extra
   * GPU cost; secondary coverage remains stochastic. */
  uint32_t alpha_blend_strategy; /* mt_alpha_blend_strategy. */
  uint32_t reserved_tail; /* Must be 0. */
  uint32_t caustic_flags; /* MT_CAUSTIC_* mask. Default 0 (all disabled). */
  uint32_t light_photons; /* 0 selects pixel count / 4. Default 0. */
  /* 0 selects pixel count / 4, at most 262144. Default 0. 28 bytes per photon plus up to 13 MiB
     overhead; reduced to fit device limits and the 128 MiB batch budget. */
  uint32_t photon_map_photons;
  /* Nonnegative first-batch radius in scene units, independent of photon_map_photons;
     shrinks with accumulated batches. 0 selects 3% of caster sphere radius. Default 0. */
  float photon_map_radius;
} mt_render_options;
MT_ENGINE_LAYOUT(mt_render_options, 128);
/* Initializes the full current record, including struct_size. Other render
 * option calls require struct_size == sizeof(mt_render_options). */
int32_t mt_render_options_default(mt_render_options *output);
/* The renders of an engine share one prepared scene. Changing a render's size or
 * settings restarts only its accumulation. */
int32_t mt_render_create(mt_engine engine, const mt_render_options *options, mt_render *output,
  char *error, size_t capacity);
/* Renders owned by a render loop return MT_ERROR_INVALID_STATE. */
int32_t mt_render_destroy(mt_render render, char *error, size_t capacity);
int32_t mt_render_set_options(mt_render render, const mt_render_options *options, char *error, size_t capacity);
int32_t mt_render_get_options(mt_render render, mt_render_options *output, char *error, size_t capacity);
/* Presents fallback (0 for none) until this render has a complete image. One
 * level only, on the same engine. Default none. */
int32_t mt_render_set_fallback(mt_render render, mt_render fallback, char *error, size_t capacity);

typedef enum mt_denoise_schedule {
  /* Once, when the render reaches max_samples. */
  MT_DENOISE_CONVERGED = 0,
  /* At 1 sample, then at twice the last denoised count (at least 4) up to
   * max_samples; after 10 s without a result, at the next sample. Sampling pauses
   * while a filter runs; the last denoised image stays presented. */
  MT_DENOISE_PROGRESSIVE = 1,
  /* After every complete batch; sampling pauses while a filter runs. */
  MT_DENOISE_EVERY_SAMPLE = 2
} mt_denoise_schedule;
/* Render-only backend using the included oidn-webgpu Rust runtime.
 * mt_denoiser_* continues to accept only mt_denoise_backend. */
enum { MT_DENOISE_OIDN_WEBGPU = 5 };
/* OIDN on a library thread, or oidn-webgpu on the rendering device. */
typedef struct mt_render_denoiser {
  uint32_t struct_size;
  uint32_t backend; /* mt_denoise_backend or MT_DENOISE_OIDN_WEBGPU. Default MT_DENOISE_AUTO. */
  uint32_t schedule; /* mt_denoise_schedule. Default MT_DENOISE_CONVERGED. */
  uint32_t reserved; /* Must be 0. */
  const char *library; /* OIDN library path; NULL uses the mutracer-denoise.h search.
    * For MT_DENOISE_OIDN_WEBGPU, a TZA weights path; NULL uses rt_hdr_alb_nrm.
    * Default NULL. */
} mt_render_denoiser;
MT_ENGINE_LAYOUT(mt_render_denoiser, 16 + sizeof(void *));
int32_t mt_render_denoiser_default(mt_render_denoiser *output);
/* Replaces the denoiser; NULL disables denoising. Default none. */
int32_t mt_render_set_denoiser(mt_render render, const mt_render_denoiser *denoiser, char *error, size_t capacity);

/* Custom filters replace built-in denoisers. Worker inputs/output are linear RGBA32F,
 * bottom row first, raw per-sample color (including background) + path coverage
 * alpha; normal/albedo are L0 guides. count is floats (width*height*4).
 * Fill every output float; return 0, or a nonzero error and a bounded UTF-8
 * message. Input, output, error and cancel pointers expire on callback return.
 * Inputs are copied on the GPU and read back on the worker. C callbacks receive CPU memory;
 * GPU filtering requires the host's own upload/readback. No C wgpu handles.
 * Cancellation is cooperative. Cancel/destroy/replacement do not wait for the
 * callback; stale outputs are discarded. Callbacks may overlap, may reenter
 * the API, and must not unwind. Own user data until release, called once after
 * the last worker retires, on a library thread. Keep callback code loaded until
 * release returns; omit release only for process-lifetime code and user data. Registration transfers user ownership, even if a live
 * render fails during registration; invalid records/handles do not transfer it.
 * NULL disables filtering. Default none. */
typedef struct mt_denoise_input {
  uint32_t struct_size, width, height, aovs; /* Supplied MT_AOV_* mask. */
  size_t count;
  const float *color, *normal, *albedo;
  const void *cancel;
  /* Seven optional width*height*4 arrays, ordered by MT_AOV_* bit. ID is
   * uint32_t RGBA, all other slots float RGBA. Null for unrequested slots. */
  const void *aov_data[7];
} mt_denoise_input;
uint32_t mt_denoise_cancelled(const void *cancel);
typedef int32_t (*mt_custom_denoise_callback)(const mt_denoise_input *input, float *output, char *error, size_t capacity, void *user);
typedef void (*mt_custom_denoise_release)(void *user);
typedef struct mt_custom_denoiser {
  uint32_t struct_size, schedule; /* mt_denoise_schedule. Default MT_DENOISE_CONVERGED. */
  mt_custom_denoise_callback callback;
  mt_custom_denoise_release release;
  void *user;
  uint32_t aovs; /* Requested MT_AOV_* mask; default 0. Unknown bits are invalid. */
  uint32_t reserved; /* Must be 0. */
} mt_custom_denoiser;
MT_ENGINE_LAYOUT(mt_custom_denoiser, 16 + 3 * sizeof(void *));
MT_ENGINE_LAYOUT(mt_denoise_input, 16 + 12 * sizeof(void *));
int32_t mt_render_set_custom_denoiser(mt_render render, const mt_custom_denoiser *denoiser, char *error, size_t capacity);

/* Collects a finished batch without waiting for it, submits the next one and
 * starts a due filter. Preparation, shader compilation, target changes and
 * denoising input readback may block; the frame budget is not a hard deadline.
 * status (optional) receives mt_render_status. A render failure returns MT_OK
 * with MT_RENDER_ERROR and an error event. */
int32_t mt_render_refine(mt_render render, uint32_t *status, char *error, size_t capacity);
/* Runs one ordinary refine, then blocks collecting/refilling queued samples until
 * a monotonic deadline budget_ms milliseconds after entry. budget_ms must be finite and >=0;
 * 0 runs only the initial refine. Invalid input returns MT_ERROR_INVALID_ARGUMENT
 * before scheduling. Preparation, compilation and initial sampling may exceed
 * the budget; deadlines/cancellation do not interrupt a refine or callback already
 * in progress. status is optional and receives mt_render_status, as in refine.
 * Present this render first to enable refills, then present again after return.
 * Refills require the Final display channel, batching, a completed sample, GPU
 * timing within time_budget_ms, queued sampling, and no pending inputs/filter or
 * convergence. No inputs are committed and no image is presented by this call.
 * mt_render_cancel may interrupt from another thread; cancellation retains work
 * already submitted and returns MT_OK with the current status. No cancellation
 * is retained from an earlier call. Other same-engine calls follow the ordinary
 * calling-thread rules; callbacks run as for refine. No pointers are retained. */
int32_t mt_render_refine_until(mt_render render, double budget_ms, uint32_t *status,
  char *error, size_t capacity);
/* JNLM filters the composed SDR image, including PNG export, without
 * changing raw HDR, HDR window output or sample counts. Initialize with mt_jnlm_options_default. */
typedef struct mt_jnlm_options {
  uint32_t struct_size;
  float strength; /* Positive finite multiplier. Default 1. */
  uint32_t search_radius; /* 1..16. Default 5. */
  uint32_t patch_radius; /* 0..3. Default 1. */
  float albedo_bandwidth; /* 0.0001..10. Default 0.4. */
  float normal_bandwidth; /* 0.0001..10. Default 0.05. */
  uint32_t iterations; /* 1..4. Default 2. */
  uint32_t reserved; /* Must be 0. */
} mt_jnlm_options;
MT_ENGINE_LAYOUT(mt_jnlm_options, 32);
int32_t mt_jnlm_options_default(mt_jnlm_options *output);
/* NULL disables the filter (default). Disable OIDN/custom filtering first to
 * use JNLM alone. Invalid options preserve the previous filter. */
int32_t mt_render_set_jnlm_display_filter(mt_render render, const mt_jnlm_options *options, char *error, size_t capacity);
/* Per-call refine overrides. Initialize with mt_refine_options_default. */
typedef struct mt_refine_options {
  uint32_t struct_size;
  uint32_t batch_samples; /* UINT32_MAX inherits render flags (default), 0 off, 1 on. */
  uint32_t defer_resolve; /* 1 defers display capture until a normal refine/read. Default 0. */
  uint32_t reserved; /* Must be 0. */
  double target_batch_time_ms; /* 0 uses time_budget_ms (default); otherwise positive finite, capped by it. */
} mt_refine_options;
MT_ENGINE_LAYOUT(mt_refine_options, 24);
int32_t mt_refine_options_default(mt_refine_options *output);
/* Same as refine with per-call overrides; invalid options preserve the render. */
int32_t mt_render_refine_with_options(mt_render render, const mt_refine_options *options,
  uint32_t *status, char *error, size_t capacity);
/* Last valid GPU trace time per beauty sample. available=0 before measurement,
 * after an input restart, or without timestamps; milliseconds=0 then. Outputs optional. */
int32_t mt_render_gpu_sample_time(mt_render render, double *milliseconds, uint32_t *available,
  char *error, size_t capacity);
/* Filters the current complete samples now without tracing, like the end of
 * converge; for hosts that stop refining (for example when paused). Call again
 * to collect the result; done (optional) receives 1 when the denoised image is
 * of the current samples. Requires a denoiser. CPU input readback or first-use
 * GPU filter preparation may block; the call does not wait for filtering
 * to complete. */
int32_t mt_render_denoise_current(mt_render render, uint32_t *done, char *error, size_t capacity);
/* Collects and captures a finished batch without submitting another, so a host
 * can present the last frame before committing new input. idle (optional)
 * receives 1 when no batch is in flight. */
int32_t mt_render_collect(mt_render render, uint32_t *idle, char *error, size_t capacity);
/* Discards this render's accumulation and denoised image. */
int32_t mt_render_restart(mt_render render, char *error, size_t capacity);

typedef enum mt_converge_stage { MT_CONVERGE_FINAL = 0, MT_CONVERGE_DENOISING = 1 } mt_converge_stage;
typedef void (*mt_converge_callback)(uint32_t stage, uint32_t samples, uint32_t target_samples, void *user);
typedef struct mt_converge_options {
  uint32_t struct_size;
  uint32_t samples; /* Final complete samples, 1..16384. Required. */
  uint32_t sample_sequence_offset; /* Default 0. */
  uint32_t samples_per_batch; /* Clamped to 1..64. Default 8. */
  uint32_t use_camera; /* 1 renders this output with camera. Default 0 (engine camera). */
  uint32_t reserved; /* Must be 0. */
  uint64_t timeout_ms; /* Preparation and rendering. Default 600000. */
  mt_camera_v4 camera;
  mt_converge_callback progress; /* After every complete batch. Default NULL. */
  void *user;
} mt_converge_options;
MT_ENGINE_LAYOUT(mt_converge_options, 160 + 2 * sizeof(void *));
int32_t mt_converge_options_default(uint32_t samples, mt_converge_options *output);
/* Renders exactly options->samples samples, blocking until they complete, then
 * denoises when a denoiser is set. samples (optional) receives the count.
 * mt_render_cancel from another thread returns MT_ERROR_CANCELLED. refine on the
 * same render returns MT_ERROR_INVALID_STATE meanwhile. */
int32_t mt_render_converge(mt_render render, const mt_converge_options *options, uint32_t *samples,
  char *error, size_t capacity);
/* Cancels a running converge or refine_until of this render (or converge on
 * the loop owning it as final render). The only call allowed from another thread.
 * Idempotent; refine_until retains submitted work and returns its current status. */
int32_t mt_render_cancel(mt_render render, char *error, size_t capacity);

typedef struct mt_render_snapshot {
  uint32_t struct_size;
  uint32_t status; /* mt_render_status. */
  uint32_t samples; /* Complete samples of the current inputs; 0 while preparing. */
  uint32_t width, height;
  uint32_t converged; /* samples reached max_samples. */
  uint32_t denoising; /* A filter is queued or running. */
  uint32_t last_commit; /* mt_commit_kind of the engine's shared scene. */
  uint32_t backend; /* mt_backend actually used after preparation. */
  uint32_t denoised_samples; /* Samples of the last denoising run, 0 for none. */
  float denoise_ms; /* Its filter time. */
  char denoise_device[64]; /* For example "OIDN CPU"; empty for none. */
  char message[256]; /* Fallback or denoising failure reason; empty for none. */
} mt_render_snapshot;
MT_ENGINE_LAYOUT(mt_render_snapshot, 364);
int32_t mt_render_info(mt_render render, mt_render_snapshot *output, char *error, size_t capacity);

/* kind: any mt_image_kind. DENOISED returns HDR when no filtered image exists.
 * Little-endian RGBA, top row first, width*height*16 bytes: uint32_t for ID,
 * float for all other kinds. AOV formats/validity are in mutracer-status.h;
 * reads require the corresponding render aovs bit or return MT_ERROR_INVALID_STATE.
 * Waits for the batch in flight. During preparation it reads the previous image. HDR matches TS WebGPU readback: RGB is normalized
 * by surface hits, restoring per-sample RGB for an opaque visible flat
 * background; alpha stays path coverage. Display settings do not affect HDR.
 * L0 mt_context_read_pixels keeps raw per-sample averages. HDR temporarily copies
 * up to 48 GPU bytes per pixel. Size queries and short destinations follow
 * mt_display_read_pixels. */
int32_t mt_render_read_pixels(mt_render render, uint32_t kind, void *pixels, size_t size, size_t *written,
  char *error, size_t capacity);

typedef void (*mt_sample_callback)(uint32_t samples, uint32_t first_frame, double frame_time_ms, void *user);
/* Called for complete beauty batches; auxiliary sampling is excluded. NULL removes it. Default none. */
int32_t mt_render_set_callback(mt_render render, mt_sample_callback callback, void *user, char *error, size_t capacity);

/* Optional offline timing controls; initialize with mt_converge_timing_default. */
typedef struct mt_converge_timing {
  uint32_t struct_size;
  uint32_t reserved; /* Must be 0. */
  double target_batch_time_ms; /* 0 fixed batches (default), otherwise positive finite. */
  double preview_interval_ms; /* -1 end-only capture (default), otherwise finite >=0. */
} mt_converge_timing;
MT_ENGINE_LAYOUT(mt_converge_timing, 24);
int32_t mt_converge_timing_default(mt_converge_timing *output);
/* Same convergence/cancellation semantics, with GPU-paced batches and optional
 * intermediate resolved images readable/presentable from the progress callback. */
int32_t mt_render_converge_with_timing(mt_render render, const mt_converge_options *options,
  const mt_converge_timing *timing, uint32_t *samples, char *error, size_t capacity);

/* ---- Render loop ---- */

typedef enum mt_render_loop_status {
  MT_LOOP_PREPARING = 0, MT_LOOP_COMPILING = 1, MT_LOOP_CONVERGING = 2, MT_LOOP_DENOISING = 3,
  MT_LOOP_FINISHED = 4, MT_LOOP_ERROR = 5,
  /* The display shows a preview image. */
  MT_LOOP_PREVIEWING = 6,
  MT_LOOP_IDLE = 7
} mt_render_loop_status;
typedef enum mt_loop_selection { MT_LOOP_SELECT_PREVIEW = 0, MT_LOOP_SELECT_FINAL = 1 } mt_loop_selection;
/* Returns mt_loop_selection; changing is 1 while the scene or a sync is changing. */
typedef uint32_t (*mt_loop_select_callback)(uint32_t changing, void *user);
typedef struct mt_render_loop_options {
  uint32_t struct_size;
  /* 1 creates a preview render (preview_options, or the browser preview
   * defaults when NULL); 0 none. Default 1. */
  uint32_t preview;
  /* Hold preview inference before committing the latest camera/scene. Default 0. */
  uint32_t coalesce_scene_updates;
  uint32_t reserved; /* Must be 0. */
  /* Idle delay for consecutive edits without sync activity. Default 150. */
  double idle_ms;
  const mt_render_options *preview_options; /* Default NULL. */
  const mt_render_options *final_options; /* Default NULL: mt_render_options_default. */
  mt_loop_select_callback select; /* Default NULL: preview while changing. */
  void *select_user;
} mt_render_loop_options;
MT_ENGINE_LAYOUT(mt_render_loop_options, 24 + 4 * sizeof(void *));
int32_t mt_render_loop_options_default(mt_render_loop_options *output);
/* The loop presents on the engine display and creates its renders; the final
 * render presents the preview as fallback. */
int32_t mt_render_loop_create(mt_engine engine, const mt_render_loop_options *options, mt_render_loop *output,
  char *error, size_t capacity);
int32_t mt_render_loop_destroy(mt_render_loop loop, char *error, size_t capacity);
/* which (mt_loop_selection): the loop's final or preview render, owned by the
 * loop and usable with the mt_render calls except destroy. No preview returns
 * MT_ERROR_INVALID_STATE. */
int32_t mt_render_loop_render(mt_render_loop loop, uint32_t which, mt_render *output, char *error, size_t capacity);
/* One frame: syncs, mt_engine_update, selection, refine and present. Call each
 * frame while mt_render_loop_needs_tick reports 1. status (optional) receives
 * mt_render_loop_status. */
int32_t mt_render_loop_tick(mt_render_loop loop, uint32_t *status, char *error, size_t capacity);
int32_t mt_render_loop_needs_tick(mt_render_loop loop, uint32_t *needs, char *error, size_t capacity);
/* Between display frames, call on GPU completion on the tick thread. Collects
 * and refills stationary beauty work without sync updates, commits or presents.
 * Each tick grants at most 16 ms; interaction, AOVs, filtering and changed input
 * stop refilling. active (optional) receives whether more refill calls may run. */
int32_t mt_render_loop_refill(mt_render_loop loop, uint32_t *active, char *error, size_t capacity);
int32_t mt_render_loop_needs_refill(mt_render_loop loop, uint32_t *active, char *error, size_t capacity);
/* Call when pausing/hiding the host or suspending its frame loop. No samples lost. */
int32_t mt_render_loop_cancel_refill(mt_render_loop loop, char *error, size_t capacity);
/* Blocking final render, as mt_render_converge on the final render, then
 * presented. Cancel with mt_render_cancel on the final render. */
int32_t mt_render_loop_converge(mt_render_loop loop, const mt_converge_options *options, uint32_t *samples,
  char *error, size_t capacity);

/* Blocking final convergence with the same timing controls as Render. */
int32_t mt_render_loop_converge_with_timing(mt_render_loop loop, const mt_converge_options *options,
  const mt_converge_timing *timing, uint32_t *samples, char *error, size_t capacity);
typedef struct mt_render_loop_snapshot {
  uint32_t struct_size;
  uint32_t status; /* mt_render_loop_status. */
  uint32_t samples; /* Final beauty samples; excludes previews and auxiliary sampling. */
  uint32_t changing;
  uint64_t presentations; /* Successful presentations so far. */
  mt_presented last_presented; /* samples 0 before the first presentation. */
  uint32_t reserved; /* 0. */
} mt_render_loop_snapshot;
MT_ENGINE_LAYOUT(mt_render_loop_snapshot, 48);
int32_t mt_render_loop_info(mt_render_loop loop, mt_render_loop_snapshot *output, char *error, size_t capacity);

typedef enum mt_loop_event_kind { MT_LOOP_EVENT_STATUS = 0, MT_LOOP_EVENT_SAMPLE = 1 } mt_loop_event_kind;
/* value is the new mt_render_loop_status or the final beauty sample count. */
typedef void (*mt_loop_callback)(uint32_t kind, uint32_t value, void *user);
/* Called on status changes and final beauty samples;
 * NULL removes it. Default none. */
int32_t mt_render_loop_set_callback(mt_render_loop loop, mt_loop_callback callback, void *user,
  char *error, size_t capacity);

/* An external scene, camera or interaction source. Before each tick's commit the
 * loop calls update, which writes the latest state to the engine; active returns
 * 1 while further changes are expected (for example during a drag). */
typedef struct mt_loop_sync {
  uint32_t struct_size;
  uint32_t reserved; /* Must be 0. */
  void (*update)(void *user);
  uint32_t (*active)(void *user); /* NULL: never active. */
  void *user;
} mt_loop_sync;
MT_ENGINE_LAYOUT(mt_loop_sync, 8 + 3 * sizeof(void *));
/* Syncs update in the order added. id receives a handle for remove_sync. */
int32_t mt_render_loop_add_sync(mt_render_loop loop, const mt_loop_sync *sync, uint64_t *id,
  char *error, size_t capacity);
int32_t mt_render_loop_remove_sync(mt_render_loop loop, uint64_t id, char *error, size_t capacity);
#undef MT_ENGINE_LAYOUT
#ifdef __cplusplus
}
#endif
#endif
