#ifndef MUTRACER_VULKAN_H
#define MUTRACER_VULKAN_H
#include <vulkan/vulkan.h>
#include "mutracer-engine.h"
#include "mutracer-gpu.h"
#ifdef __cplusplus
extern "C" {
#endif
#if defined(__cplusplus) && __cplusplus >= 201103L
#define MT_VK_LAYOUT(type, size) static_assert(sizeof(type) == (size), #type " layout")
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#define MT_VK_LAYOUT(type, size) _Static_assert(sizeof(type) == (size), #type " layout")
#else
#define MT_VK_LAYOUT(type, size)
#endif
/* Vulkan interop for Linux/Windows; macOS requires the vulkan-interop Cargo
 * feature and a Vulkan portability driver. Other builds return UNAVAILABLE.
 * Output records need no initialization. The general engine thread rules apply.
 * Invalid native handles, a device made
 * without the required features/extensions, or violating queue/layout/lifetime
 * rules are caller errors that Vulkan cannot reliably validate here.
 * No CPU image readback or GPU idle wait is performed by these functions. */
/* Retirement callbacks may run on any thread, including inside destroy/poll.
 * They notify that this successful import has no remaining library references;
 * they never destroy a native handle. Do not reenter MuTracer. Keep callback/user
 * valid until notified. Failed imports do not call their callback. With multiple
 * imports of an instance, wait for every corresponding retirement notification. */
typedef void (*mt_vk_retired_callback)(void *user);
typedef uint64_t mt_vk_device_plan;
typedef uint64_t mt_vk_lease;
typedef uint64_t mt_vk_post_process;
/* Host-owned GPU export records. The VkImage and timeline semaphore are not
 * destroyed by MuTracer. They must have been created by mt_vk_device_desc's
 * VkDevice. The image is 2D, one mip/layer/sample and storage-capable. */
typedef struct mt_vk_gpu_image_desc {
  uint32_t struct_size, reserved;
  const void *next;
  VkImage image;
  VkFormat format;
  uint32_t width, height;
  uint32_t initial_layout;
} mt_vk_gpu_image_desc;
MT_VK_LAYOUT(mt_vk_gpu_image_desc, 40);
typedef struct mt_vk_gpu_timeline_desc {
  uint32_t struct_size, reserved;
  const void *next;
  VkSemaphore semaphore;
} mt_vk_gpu_timeline_desc;
MT_VK_LAYOUT(mt_vk_gpu_timeline_desc, 24);
/* Imports retain only a wgpu wrapper; the host owns image memory and semaphore.
 * The generic mt_render_export_gpu/mt_engine_gpu_poll functions then use the
 * imported records with Vulkan timeline waits/signals on the library queue. */
int32_t mt_engine_import_vulkan_image(mt_engine engine, const mt_vk_gpu_image_desc *desc,
  mt_gpu_image *output, char *error, size_t error_capacity);
int32_t mt_engine_import_vulkan_timeline(mt_engine engine, const mt_vk_gpu_timeline_desc *desc,
  mt_gpu_timeline *output, char *error, size_t error_capacity);
/* Query before vkCreateInstance. Enable every returned extension. NULL/0 queries
 * count; too little capacity returns BUFFER_TOO_SMALL without array writes.
 * Strings are process-lifetime, immutable. api_version must be >= Vulkan 1.1.
 * A portability instance must also set ENUMERATE_PORTABILITY_BIT_KHR. */
int32_t mt_vk_instance_extensions(PFN_vkGetInstanceProcAddr get_proc, uint32_t api_version,
  const char **output, size_t capacity, size_t *required, char *error, size_t error_capacity);
typedef struct mt_vk_host_desc {
  uint32_t struct_size, api_version;
  VkInstance instance;
  VkPhysicalDevice physical_device;
  PFN_vkGetInstanceProcAddr get_proc;
  const char *const *instance_extensions;
  size_t instance_extension_count;
  mt_vk_retired_callback retired; /* Required; native instance/driver live until notified. */
  void *retired_user;
} mt_vk_host_desc;
MT_VK_LAYOUT(mt_vk_host_desc, 64);
typedef struct mt_vk_device_requirements {
  uint32_t struct_size, queue_flags; /* Required VkQueueFlags. */
  const VkPhysicalDeviceFeatures *features;
  const void *features_next; /* VkDeviceCreateInfo.pNext chain. */
  const char *const *extensions;
  size_t extension_count;
  uint32_t hardware_ray_query, reserved;
} mt_vk_device_requirements;
MT_VK_LAYOUT(mt_vk_device_requirements, 48);
/* Copies host/options, borrows the native instance/driver. output needs no
 * initialization. Requirements pointers remain valid until plan_destroy; do not
 * edit them. Use features as pEnabledFeatures and features_next as pNext on
 * VkDeviceCreateInfo and enable every extension. The host may enable additional
 * features, avoiding duplicate feature structs in the pNext chain. Provide a
 * graphics+compute queue. backend selects HWRT when supported, else software. */
int32_t mt_vk_device_plan_create(const mt_vk_host_desc *host, const mt_engine_options *options,
  mt_vk_device_plan *plan, mt_vk_device_requirements *output, char *error, size_t capacity);
int32_t mt_vk_device_plan_destroy(mt_vk_device_plan plan, char *error, size_t capacity);
/* Imports a device created with this plan and queue family/index. The library
 * never destroys the supplied instance/device. Keep them and the driver alive
 * until their retirement callbacks run, which can be later than engine/plan
 * destruction. Destroy native devices before their instance. Import each native
 * device into only one engine (use multiple renders on that engine). No Vulkan
 * allocation callbacks are supported. Host must serialize its own queue calls
 * through queue/image acquisition below; do not submit directly at other times.
 * Plan may be destroyed after this returns; device creation failure leaves it
 * reusable. Queue family/index must have been enabled in vkCreateDevice. */
typedef struct mt_vk_device_desc {
  uint32_t struct_size, queue_family, queue_index, reserved; /* reserved=0. */
  VkDevice device;
  mt_vk_retired_callback retired; /* Required; device/queue live until notified. */
  void *retired_user;
} mt_vk_device_desc;
MT_VK_LAYOUT(mt_vk_device_desc, 40);
int32_t mt_engine_create_vulkan(mt_vk_device_plan plan, const mt_vk_device_desc *device,
  mt_engine *output, char *error, size_t capacity);
typedef struct mt_vk_device_info {
  uint32_t struct_size, api_version, queue_family, queue_index;
  VkInstance instance;
  VkPhysicalDevice physical_device;
  VkDevice device;
  VkQueue queue;
  PFN_vkGetInstanceProcAddr get_proc;
} mt_vk_device_info;
MT_VK_LAYOUT(mt_vk_device_info, 56);
/* Borrowed native handles; do not destroy them. Valid until engine destruction.
 * Resource creation is allowed; queue access requires an active image lease. */
int32_t mt_engine_vulkan_info(mt_engine engine, mt_vk_device_info *output, char *error, size_t capacity);
/* Pauses library submissions for host work on this exact queue, including before
 * the first rendered image. Query device info first. The same lease/thread rules
 * as image acquisition apply; release promptly after host vkQueue* calls return. */
int32_t mt_engine_vulkan_acquire_queue(mt_engine engine, mt_vk_lease *output, char *error, size_t capacity);
typedef struct mt_vk_image_info {
  uint32_t struct_size, format, width, height; /* format is VkFormat. Top row first. */
  VkImage image;
  mt_vk_lease lease;
  uint32_t layout, reserved; /* SHADER_READ_ONLY_OPTIMAL; reserved=0. */
} mt_vk_image_info;
MT_VK_LAYOUT(mt_vk_image_info, 40);
/* kind 0 = linear RGBA32F HDR before denoising, 1 = latest composed RGBA8 display.
 * INVALID_STATE when no completed image/composition exists. Resolves lazily,
 * then pauses library queue submissions without waiting for GPU completion.
 * Exactly one lease per engine. Until release, only mt_render_cancel and
 * mt_vk_lease_release may use this engine; other engine/render/display calls
 * return INVALID_STATE. Host may create views and record/submit read-only image
 * use on the exact queue in mt_engine_vulkan_info. It must restore the stated
 * layout, must not destroy/write this image, and must not use other queues.
 * All host vkQueue* calls must finish on the CPU before release. Own command
 * pools/views/descriptors/pipelines remain host-owned and must be retired with
 * host fences. Releasing records retirement after host submissions so the image
 * can safely be replaced on the next render. A lease must always be released,
 * including after device loss; engine destruction while borrowed is rejected. */
int32_t mt_render_vulkan_acquire_image(mt_render render, uint32_t kind,
  mt_vk_image_info *output, char *error, size_t capacity);
int32_t mt_vk_lease_release(mt_vk_lease lease, char *error, size_t capacity);
typedef struct mt_vk_pass_context {
  uint32_t struct_size, format, width, height;
  VkDevice device;
  VkCommandBuffer commands;
  VkImage input, output;
} mt_vk_pass_context;
MT_VK_LAYOUT(mt_vk_pass_context, 48);
typedef int32_t (*mt_vk_pass_callback)(const mt_vk_pass_context *context, void *user);
/* mode 0 = SDR display passes, 1 = HDR-window passes. Runs synchronously inside
 * composition on the caller thread, in registration order. context is valid only
 * during the callback. Input is SHADER_READ_ONLY_OPTIMAL; output is GENERAL and
 * cleared to zero. Fully write output and restore these layouts before return.
 * Record into commands; do not end/reset/submit it or call back into MuTracer.
 * Do not destroy/retain the borrowed handles. Callback resources must belong to
 * this device and survive GPU execution. Return MT_OK on success; other status
 * values discard the composition and report an engine error. The subscription
 * retains user until remove/engine destruction; no disposal callback is invoked. */
int32_t mt_display_add_vulkan_post_process(mt_display display, uint32_t mode,
  mt_vk_pass_callback callback, void *user, mt_vk_post_process *output, char *error, size_t capacity);
/* Removes future calls, invalidates this handle; only call on the engine's
 * permitted thread and outside its callback. Does not wait for GPU completion. */
int32_t mt_vk_post_process_remove(mt_vk_post_process pass, char *error, size_t capacity);
#undef MT_VK_LAYOUT
#ifdef __cplusplus
}
#endif
#endif
