/* Same-device Vulkan foreign-image export sketch.
 *
 * Build this together with vulkan-host.c's instance/device negotiation. The
 * important lifetime rule is visible here: the host creates VkImage and two
 * timeline VkSemaphore objects on `info.device`, imports them, and only closes
 * them after the done value has been observed and both handles are destroyed.
 */
#define VK_NO_PROTOTYPES
#include "mutracer-vulkan.h"
#include <stdio.h>
#include <string.h>

static void check(int32_t status, const char *message) {
  if (status != MT_OK) { fprintf(stderr, "MuTracer Vulkan export failed: %d %s\n", status, message); }
}

int main(void) {
  mt_engine engine = 0; /* created by the host negotiation in vulkan-host.c */
  mt_vk_device_info info = { .struct_size = sizeof info };
  char error[4096] = {0};
  if (engine == 0) {
    puts("vulkan-export-host: embed after mt_engine_create_vulkan; this example is a lifetime contract");
    return 0;
  }
  check(mt_engine_vulkan_info(engine, &info, error, sizeof error), error);
  /* Host code creates a storage-capable RGBA32F VkImage and timeline semaphores
   * on info.device, then fills these records (handles are never duplicated by
   * MuTracer). */
  mt_vk_gpu_image_desc image = { .struct_size = sizeof image, .format = VK_FORMAT_R32G32B32A32_SFLOAT, .width = 8, .height = 6 };
  mt_vk_gpu_timeline_desc ready = { .struct_size = sizeof ready };
  mt_vk_gpu_timeline_desc done = { .struct_size = sizeof done };
  mt_gpu_image image_handle = 0; mt_gpu_timeline ready_handle = 0, done_handle = 0;
  check(mt_engine_import_vulkan_image(engine, &image, &image_handle, error, sizeof error), error);
  check(mt_engine_import_vulkan_timeline(engine, &ready, &ready_handle, error, sizeof error), error);
  check(mt_engine_import_vulkan_timeline(engine, &done, &done_handle, error, sizeof error), error);
  puts("vulkan-export-host: imported same-device image/timelines; submit mt_render_export_gpu after filling native handles");
  return 0;
}
