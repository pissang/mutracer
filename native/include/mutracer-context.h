#ifndef MUTRACER_CONTEXT_H
#define MUTRACER_CONTEXT_H
#include <stddef.h>
#include <stdint.h>
#include "mutracer-log.h"
#include "mutracer-status.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Experimental persistent C API; see native/README.md#platforms for supported
 * platforms.
 * Return MT_OK (0) on success or a nonzero mt_status from mutracer-status.h.
 * If error is non-NULL and capacity > 0, it receives a truncated
 * NUL-terminated UTF-8 message (complete characters only).
 * All pointers must remain valid for the call; input is copied, no pointers are
 * retained. Pixel storage belongs to the caller. This ABI is not stable yet.
 *
 * Calls may come from any thread. Short context operations serialize; an
 * overlapping operation may return MT_ERROR_BUSY and can be retried. Scene preparation
 * runs on a dedicated library thread; poll/render of the old scene remain usable
 * during a full commit. The committing caller waits; use another calling thread
 * for UI responsiveness. No fixed context count limit; device memory limits apply.
 * Handles are unique until process exit; destroyed/unknown handles return
 * MT_ERROR_INVALID_HANDLE. Descriptor or record validation failures return
 * MT_ERROR_INVALID_ARGUMENT.
 * Contexts retain GPU resources between renders; commit replaces the complete
 * scene. A failed commit preserves the previous scene,
 * samples and outputs. Successful commit resets samples to zero, including a
 * camera/material edit submitted through the same raw descriptor. Commit can
 * temporarily hold both scenes' resources. Descriptors are documented in
 * native/docs/scene-format.md; mutracer-scene-builder.h assembles them.
 *
 * render adds samples to the current accumulation, total 1..16384. The default
 * commit uses seed 12345, bounces 6 and Sobol, matching the raw probe. A commit
 * with settings retains those settings for blocking and job renders. reset clears
 * accumulation, keeping the committed scene. Independent contexts keep
 * independent accumulation. Caught Rust panics mark the touched context failed
 * and return MT_ERROR_CONTEXT_FAILED.
 * Fatal runtime errors, including out-of-memory and abort, terminate the process;
 * use process isolation if recovery is required. Diagnostics use mutracer-log.h
 * and are silent by default; the process-wide Rust panic hook may still print.
 * Render/read/reset and incremental commit GPU failures mark the scene failed and return
 * MT_ERROR_CONTEXT_FAILED; later calls return MT_ERROR_INVALID_STATE until a
 * successful commit. Device-loss recovery is unavailable.
 *
 * read_pixels kind (mt_image_kind) MT_IMAGE_HDR, MT_IMAGE_NORMAL or
 * MT_IMAGE_ALBEDO: linear little-endian f32 RGBA,
 * bottom row first, width*height*16 bytes, divided by completed sample count.
 * Normals are not renormalized. Requires at least one completed sample.
 * pixels=NULL,size=0 queries required size without reading GPU data. written is
 * required; a short destination returns MT_ERROR_BUFFER_TOO_SMALL and the
 * required size without changing destination or scene. Reading before the first
 * completed sample returns MT_ERROR_INVALID_STATE. A successful read copies the whole image.
 * No file output or Node/JS process is involved. Use mutracer-denoise.h for
 * optional independent native denoising.
 */
typedef uint64_t mt_context;
typedef struct mt_context_snapshot {
  uint32_t struct_size; /* Set to sizeof(mt_context_snapshot). */
  uint32_t width, height, samples;
  uint32_t state; /* mt_context_state. */
  uint32_t last_commit; /* mt_commit_kind of the last successful commit. */
} mt_context_snapshot;
/* backend (mt_backend): MT_BACKEND_SOFTWARE, or MT_BACKEND_HWRT (also the
 * mt_context_create default). Other values return MT_ERROR_INVALID_ARGUMENT; no
 * usable GPU device returns MT_ERROR_UNAVAILABLE.
 * HWRT supports alpha, affine instances, bevel and displacement. Unsupported
 * devices or acceleration-structure allocation/limit failures fall back to
 * software and report the reason after commit. Coplanar overlapping surfaces
 * may differ from software. Metal HWRT has an unresolved intermittent
 * whole-scene miss for one sample; choose software if this risk is unacceptable.
 */
int32_t mt_context_create_with_backend(uint32_t backend, mt_context *output, char *error, size_t capacity);
/* active (mt_backend): the path actually used. Call after commit to verify the actual path.
 * reason is caller-owned UTF-8 storage (capacity>=1), always NUL terminated.
 * For HWRT it reports the number of geometries using a software BVH (currently
 * zero). For fallback it explains the cause.
 */
int32_t mt_context_backend(mt_context handle, uint32_t *active, char *reason, size_t reason_capacity, char *error, size_t capacity);
int32_t mt_context_create(mt_context *output, char *error, size_t capacity);
/* Destroy rejects active render jobs: cancel/poll them first. It cancels a
 * pending commit and waits for it to release its resources. */
int32_t mt_context_destroy(mt_context handle, char *error, size_t capacity);
/* Cancellation is idempotent. The committing call returns MT_ERROR_CANCELLED
 * after its current preparation step finishes. It preserves the old scene. Already
 * submitted GPU work cannot be interrupted. */
int32_t mt_context_cancel_commit(mt_context handle, char *error, size_t capacity);
/* Commit the complete scene descriptor; the input is copied. Submit the edited
 * descriptor again to update a scene. Supported edits reuse prepared resources;
 * other edits prepare the scene again. See native/docs/scene.md "Edit a scene"
 * for the incremental scope and limits. Both paths render the same scene;
 * mt_context_snapshot.last_commit reports which ran. Every successful commit
 * restarts accumulation. Comparison cost grows with descriptor size. */
int32_t mt_context_commit(mt_context handle, const uint8_t *input, size_t length, char *error, size_t capacity);
/* Settings are copied by commit_with_settings. Initialize with
 * mt_render_settings_default, then change fields. Defaults: Sobol, seed 12345,
 * max_samples 64, bounces 6, direct-light candidates 2, bevel samples 8,
 * sequence offset 0, clamping 0, transmissive alpha minimum 1. These match commit.
 * sampling_pattern (mt_sampling_pattern): MT_SAMPLING_SOBOL, MT_SAMPLING_ZSOBOL
 * or MT_SAMPLING_RANDOM. max_samples configures the
 * sequence; render still allows total 1..16384 samples. seed is any u32.
 * bounces clamp to 1..20, direct-light candidates to 1..16 and bevel samples to
 * 1..32. clamping must be finite; 0 disables it. Transmissive alpha must be
 * finite. Scene quality flags still select bevel and dispersion.
 * sample_sequence_offset selects the first sequence index. struct_size must be
 * sizeof(mt_render_settings).
 * Successful commit resets accumulation and expires the previous job. Rejection
 * preserves the old scene, settings and output. Jobs can progress during
 * preparation; successful publication drains/cancels the old job before replacing
 * the scene. A second commit while a commit is preparing returns
 * MT_ERROR_INVALID_STATE.
 */
typedef struct mt_render_settings {
  uint32_t struct_size, sampling_pattern, seed, max_samples;
  uint32_t bounces, direct_light_candidates, bevel_samples, sample_sequence_offset;
  double clamping, transmissive_output_alpha_min;
  uint32_t caustic_flags; /* MT_CAUSTIC_* bit mask, default 0 (all disabled). */
  uint32_t light_photons, photon_map_photons; /* Default 0: pixel count / 4, capped by device limits;
                                                photon_map_photons also at most 262144. */
  float photon_map_radius; /* Nonnegative; default 0: 3% of the caster sphere radius. */
} mt_render_settings;
#if defined(__cplusplus) && __cplusplus >= 201103L
static_assert(sizeof(mt_render_settings) == 64, "mt_render_settings layout");
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(mt_render_settings) == 64, "mt_render_settings layout");
#endif
/* Pure initialization, no device requirement. NULL returns MT_ERROR_INVALID_ARGUMENT. */
int32_t mt_render_settings_default(mt_render_settings *output);
int32_t mt_context_commit_with_settings(mt_context handle, const uint8_t *input, size_t length,
  const mt_render_settings *settings, char *error, size_t capacity);
int32_t mt_context_render(mt_context handle, uint32_t additional_samples, char *error, size_t capacity);
int32_t mt_context_reset(mt_context handle, char *error, size_t capacity);
/* Wait up to timeout_ms milliseconds for submitted GPU work without changing
 * the scene or samples; MT_WAIT_INDEFINITELY has no deadline and 0 only checks.
 * Expiry returns MT_ERROR_TIMEOUT and the work keeps running. Requires a
 * committed, healthy scene and no active render job. Other calls on any context
 * return MT_ERROR_BUSY while it waits. */
#define MT_WAIT_INDEFINITELY UINT32_MAX
int32_t mt_context_wait(mt_context handle, uint32_t timeout_ms, char *error, size_t capacity);
int32_t mt_context_info(mt_context handle, mt_context_snapshot *info, char *error, size_t capacity);
int32_t mt_context_read_pixels(mt_context handle, uint32_t kind, void *pixels, size_t size,
  size_t *written, char *error, size_t capacity);
/* One job per context. submit records the request without GPU dispatch. Poll
 * drives progress on the calling thread, submits at most max_new_samples (0..64)
 * when no batch is in flight, and checks completion without waiting for the GPU.
 * CPU batch preparation/submission still takes time; no fixed latency guarantee.
 * A budget of 0 only checks completion. info reports the last polled snapshot;
 * it does not submit work or advance completion. No background polling thread.
 *
 * requested/submitted/completed counts are additional samples, excluding base.
 * Context info counts only completed samples. Active jobs reject (with
 * MT_ERROR_INVALID_STATE) blocking render, reset, read_pixels and destroy. Cancel is idempotent:
 * queued work stops immediately; in-flight work finishes, then poll reaches
 * cancelled or complete.
 * Submitted batches cannot be interrupted. Completed samples remain accumulated;
 * a later job continues the same sequence. Full completion takes precedence over
 * late cancellation. GPU failures mark the scene/job failed; failed contexts may
 * be destroyed or replaced by commit. Device-loss recovery remains unavailable.
 *
 * A job handle expires on the next submit, blocking render, successful reset
 * or commit, or context destruction; an expired handle returns MT_ERROR_INVALID_HANDLE.
 * Validation-rejected calls retain the job.
 * Handles are never reused. Save any terminal info before starting another job.
 */
typedef uint64_t mt_render_job;
typedef struct mt_job_snapshot {
  uint32_t struct_size; /* Set to sizeof(mt_job_snapshot). */
  uint32_t state; /* mt_job_state. */
  uint32_t requested_samples, submitted_samples, completed_samples, base_samples;
} mt_job_snapshot;
int32_t mt_context_submit(mt_context handle, uint32_t additional_samples, mt_render_job *job,
  char *error, size_t capacity);
int32_t mt_job_poll(mt_render_job job, uint32_t max_new_samples, char *error, size_t capacity);
int32_t mt_job_info(mt_render_job job, mt_job_snapshot *info, char *error, size_t capacity);
int32_t mt_job_cancel(mt_render_job job, char *error, size_t capacity);
#ifdef __cplusplus
}
#endif
#endif
