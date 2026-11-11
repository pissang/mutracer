/* Real same-device Vulkan export consumer.  MuTracer owns the Vulkan device;
 * this host creates storage images and timeline semaphores on the borrowed
 * device, imports them, submits HDR/depth exports, then copies each image to a
 * host-visible buffer under a queue lease and compares exact bytes with the C
 * readback API.  Native objects stay alive until imported handles are retired.
 */
#include "mutracer-engine.h"
#include "mutracer-gpu.h"
#include "mutracer-scene-api.h"
#include "mutracer-vulkan.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>
#include <windows.h>
static char error_text[4096];
static double clock_ms(void) {
  LARGE_INTEGER frequency, counter;
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&counter);
  return (double)counter.QuadPart * 1000.0 / (double)frequency.QuadPart;
}
#define FAIL(msg)                                                              \
  do {                                                                         \
    fprintf(stderr, "FAIL %s:%d: %s (%s)\n", __FILE__, __LINE__, (msg),        \
            error_text);                                                       \
    return 1;                                                                  \
  } while (0)
#define OK(call)                                                               \
  do {                                                                         \
    if ((call) != MT_OK)                                                       \
      FAIL(#call);                                                             \
  } while (0)
#define VK(call)                                                               \
  do {                                                                         \
    VkResult _r = (call);                                                      \
    if (_r != VK_SUCCESS) {                                                    \
      fprintf(stderr, "FAIL %s:%d: %s VkResult=%d\n", __FILE__, __LINE__,      \
              #call, (int)_r);                                                 \
      return 1;                                                                \
    }                                                                          \
  } while (0)
static int make_scene(mt_scene *out, void **encoded, size_t *encoded_size) {
  mt_scene s = 0;
  OK(mt_scene_create(&s, error_text, sizeof error_text));
  float bg[4] = {.18f, .31f, .52f, 1};
  mt_scene_texture_desc td;
  OK(mt_scene_texture_desc_default(&td));
  td.storage = 1;
  td.width = td.height = 1;
  td.pixels = bg;
  td.pixel_bytes = sizeof bg;
  mt_scene_texture_id t = 0;
  OK(mt_scene_add_texture(s, &td, &t, error_text, sizeof error_text));
  mt_scene_environment_desc e;
  OK(mt_scene_environment_desc_default(&e));
  e.environment = t;
  e.background = t;
  OK(mt_scene_set_environment(s, &e, error_text, sizeof error_text));
  float p[] = {-1, -1, -2, 1, -1, -2, 0, 1, -2};
  uint32_t ix[] = {0, 1, 2};
  mt_scene_geometry_desc gd;
  OK(mt_scene_geometry_desc_default(&gd));
  gd.positions = p;
  gd.vertex_count = 3;
  gd.indices = ix;
  gd.index_count = 3;
  mt_scene_geometry_id g = 0;
  OK(mt_scene_add_geometry(s, &gd, &g, error_text, sizeof error_text));
  mt_scene_material_desc md;
  OK(mt_scene_material_desc_default(&md));
  mt_scene_material_id m = 0;
  OK(mt_scene_add_material(s, &md, &m, error_text, sizeof error_text));
  mt_scene_mesh_desc me;
  OK(mt_scene_mesh_desc_default(&me));
  me.geometry = g;
  me.material = m;
  mt_scene_mesh_id mi = 0;
  OK(mt_scene_add_mesh(s, &me, &mi, error_text, sizeof error_text));
  size_t n = 0;
  OK(mt_scene_encode(s, NULL, 0, &n, error_text, sizeof error_text));
  void *d = malloc(n);
  if (!d)
    FAIL("scene allocation");
  OK(mt_scene_encode(s, d, n, &n, error_text, sizeof error_text));
  *out = s;
  *encoded = d;
  *encoded_size = n;
  return 0;
}
static uint32_t memory_type(VkPhysicalDevice physical, uint32_t bits,
                            VkMemoryPropertyFlags wanted) {
  VkPhysicalDeviceMemoryProperties p;
  vkGetPhysicalDeviceMemoryProperties(physical, &p);
  for (uint32_t i = 0; i < p.memoryTypeCount; i++)
    if ((bits & (1u << i)) &&
        (p.memoryTypes[i].propertyFlags & wanted) == wanted)
      return i;
  return UINT32_MAX;
}
static int depth_matches(const float *rgba, const float *r32, uint32_t pixels) {
  for (uint32_t i = 0; i < pixels; i++)
    if (memcmp(&rgba[i * 4], &r32[i], sizeof(float)) != 0)
      return 0;
  return 1;
}
static int poll_export(mt_engine engine, uint64_t sequence) {
  for (unsigned wait = 0; wait < 30000; wait++) {
    uint32_t complete = 0;
    OK(mt_engine_gpu_poll(engine, sequence, &complete, error_text, sizeof error_text));
    if (complete)
      return 0;
    Sleep(1);
  }
  FAIL("GPU export timeout");
}
static int host_copy(VkDevice d, VkPhysicalDevice physical, VkQueue q,
                     uint32_t family, VkImage image, VkFormat format,
                     uint32_t w, uint32_t h, float *out, size_t bytes) {
  VkImageCreateInfo ci = {VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
  ci.imageType = VK_IMAGE_TYPE_2D;
  ci.format = format;
  ci.extent.width = w;
  ci.extent.height = h;
  ci.extent.depth = 1;
  ci.mipLevels = 1;
  ci.arrayLayers = 1;
  ci.samples = VK_SAMPLE_COUNT_1_BIT;
  ci.tiling = VK_IMAGE_TILING_OPTIMAL;
  ci.usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
  ci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
  VkBufferCreateInfo bi = {VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
  bi.size = bytes;
  bi.usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT;
  bi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
  VkBuffer b;
  VK(vkCreateBuffer(d, &bi, NULL, &b));
  VkMemoryRequirements br;
  vkGetBufferMemoryRequirements(d, b, &br);
  uint32_t mt = memory_type(physical, br.memoryTypeBits,
                            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                                VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  if (mt == UINT32_MAX)
    FAIL("readback memory");
  VkMemoryAllocateInfo ba = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
  ba.allocationSize = br.size;
  ba.memoryTypeIndex = mt;
  VkDeviceMemory bm;
  VK(vkAllocateMemory(d, &ba, NULL, &bm));
  VK(vkBindBufferMemory(d, b, bm, 0));
  VkCommandPoolCreateInfo pi = {VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
  pi.queueFamilyIndex = family;
  VkCommandPool pool;
  VK(vkCreateCommandPool(d, &pi, NULL, &pool));
  VkCommandBufferAllocateInfo ai = {
      VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
  ai.commandPool = pool;
  ai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
  ai.commandBufferCount = 1;
  VkCommandBuffer cmd;
  VK(vkAllocateCommandBuffers(d, &ai, &cmd));
  VkCommandBufferBeginInfo begin = {
      VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  VK(vkBeginCommandBuffer(cmd, &begin));
  VkImageSubresourceRange range = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
  VkImageMemoryBarrier ib = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
  ib.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
  ib.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
  ib.oldLayout = VK_IMAGE_LAYOUT_GENERAL;
  ib.newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  ib.image = image;
  ib.subresourceRange = range;
  vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                       VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1,
                       &ib);
  VkBufferImageCopy c = {};
  c.imageSubresource.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
  c.imageSubresource.layerCount = 1;
  c.imageExtent.width = w;
  c.imageExtent.height = h;
  c.imageExtent.depth = 1;
  vkCmdCopyImageToBuffer(cmd, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, b, 1,
                         &c);
  ib.srcAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
  ib.dstAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
  ib.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  ib.newLayout = VK_IMAGE_LAYOUT_GENERAL;
  vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT,
                       VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 0, NULL, 0,
                       NULL, 1, &ib);
  VK(vkEndCommandBuffer(cmd));
  VkSubmitInfo si = {VK_STRUCTURE_TYPE_SUBMIT_INFO};
  si.commandBufferCount = 1;
  si.pCommandBuffers = &cmd;
  VkFenceCreateInfo fi = {VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
  VkFence fence = VK_NULL_HANDLE;
  VkResult submit = vkCreateFence(d, &fi, NULL, &fence);
  if (submit != VK_SUCCESS) {
    fprintf(stderr, "Vulkan host-copy fence creation failed: %d\n", submit);
    vkDestroyCommandPool(d, pool, NULL);
    vkDestroyBuffer(d, b, NULL);
    vkFreeMemory(d, bm, NULL);
    return 1;
  }
  submit = vkQueueSubmit(q, 1, &si, fence);
  if (submit != VK_SUCCESS) {
    fprintf(stderr, "Vulkan host-copy submit failed: %d\n", submit);
    vkDestroyFence(d, fence, NULL);
    vkDestroyCommandPool(d, pool, NULL);
    vkDestroyBuffer(d, b, NULL);
    vkFreeMemory(d, bm, NULL);
    return 1;
  }
  VkResult wait_result =
      vkWaitForFences(d, 1, &fence, VK_TRUE, 30ULL * 1000ULL * 1000ULL * 1000ULL);
  if (wait_result != VK_SUCCESS) {
    fprintf(stderr, "Vulkan host-copy fence wait failed: %d\n", wait_result);
    vkDestroyFence(d, fence, NULL);
    vkDestroyCommandPool(d, pool, NULL);
    vkDestroyBuffer(d, b, NULL);
    vkFreeMemory(d, bm, NULL);
    return 1;
  }
  vkDestroyFence(d, fence, NULL);
  void *mapped = NULL;
  VkDeviceSize offset = 0;
  VK(vkMapMemory(d, bm, offset, bytes, 0, &mapped));
  memcpy(out, mapped, bytes);
  vkUnmapMemory(d, bm);
  vkDestroyCommandPool(d, pool, NULL);
  vkDestroyBuffer(d, b, NULL);
  vkFreeMemory(d, bm, NULL);
  (void)ci;
  return 0;
}
int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  size_t adapter_count = 0;
  OK(mt_gpu_adapters(NULL, 0, &adapter_count, error_text, sizeof error_text));
  mt_gpu_adapter_info *adapters =
      (mt_gpu_adapter_info *)calloc(adapter_count, sizeof *adapters);
  if (!adapters)
    FAIL("adapter allocation");
  OK(mt_gpu_adapters(adapters, adapter_count, &adapter_count, error_text,
                     sizeof error_text));
  uint32_t vulkan_adapter = UINT32_MAX;
  for (size_t i = 0; i < adapter_count; i++)
    if (adapters[i].backend == 2) {
      vulkan_adapter = adapters[i].index;
      break;
    }
  if (vulkan_adapter == UINT32_MAX)
    FAIL("no Vulkan adapter");
  printf("Vulkan C host adapter: %s\n", adapters[vulkan_adapter].name);
  free(adapters);
  mt_engine_options eo;
  OK(mt_engine_options_default(&eo));
  eo.backend = MT_BACKEND_HWRT;
  mt_engine engine = 0;
  OK(mt_engine_create_on_adapter(&eo, vulkan_adapter, &engine, error_text,
                                 sizeof error_text));
  mt_vk_device_info vi = {sizeof vi};
  OK(mt_engine_vulkan_info(engine, &vi, error_text, sizeof error_text));
  uint32_t queue_family_count = 0;
  vkGetPhysicalDeviceQueueFamilyProperties(vi.physical_device,
                                           &queue_family_count, NULL);
  VkQueueFamilyProperties *queue_families =
      (VkQueueFamilyProperties *)calloc(queue_family_count,
                                        sizeof *queue_families);
  if (!queue_families)
    FAIL("queue-family allocation");
  vkGetPhysicalDeviceQueueFamilyProperties(vi.physical_device,
                                           &queue_family_count, queue_families);
  uint32_t physical_queue_count =
      vi.queue_family < queue_family_count
          ? queue_families[vi.queue_family].queueCount
          : 0;
  printf("Vulkan C host device=%p family=%u\n", (void *)vi.device,
         vi.queue_family);
  printf("Vulkan queue family %u exposes %u queue(s); imported library queue "
         "index=%u (host-created device enables one queue)\n",
         vi.queue_family, physical_queue_count, vi.queue_index);
  free(queue_families);
#ifdef MT_PERF_720P
  const uint32_t w = 1280, h = 720, perf_samples = 4;
#else
  const uint32_t w = 8, h = 6, perf_samples = 1;
#endif
  VkDevice d = vi.device;
  VkImage images[3];
  VkDeviceMemory image_memory[3];
  VkFormat formats[3] = {VK_FORMAT_R32G32B32A32_SFLOAT, VK_FORMAT_R32_SFLOAT,
                         VK_FORMAT_R32G32B32A32_SFLOAT};
  const uint32_t kinds[3] = {MT_GPU_OUTPUT_HDR, MT_GPU_OUTPUT_DEPTH,
                             MT_GPU_OUTPUT_CENTER_DEPTH};
  mt_gpu_image imports[3] = {0};
  for (int k = 0; k < 3; k++) {
    VkImageCreateInfo ci = {VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
    ci.imageType = VK_IMAGE_TYPE_2D;
    ci.format = formats[k];
    ci.extent.width = w;
    ci.extent.height = h;
    ci.extent.depth = 1;
    ci.mipLevels = 1;
    ci.arrayLayers = 1;
    ci.samples = VK_SAMPLE_COUNT_1_BIT;
    ci.tiling = VK_IMAGE_TILING_OPTIMAL;
    ci.usage = VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
    ci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    ci.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    VK(vkCreateImage(d, &ci, NULL, &images[k]));
    VkMemoryRequirements mr;
    vkGetImageMemoryRequirements(d, images[k], &mr);
    uint32_t mt = memory_type(vi.physical_device, mr.memoryTypeBits,
                              VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    if (mt == UINT32_MAX)
      FAIL("image memory");
    VkMemoryAllocateInfo ma = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    ma.allocationSize = mr.size;
    ma.memoryTypeIndex = mt;
    VK(vkAllocateMemory(d, &ma, NULL, &image_memory[k]));
    VK(vkBindImageMemory(d, images[k], image_memory[k], 0));
    mt_vk_gpu_image_desc id = {sizeof id,  0, NULL, images[k],
                               formats[k], w, h,    VK_IMAGE_LAYOUT_UNDEFINED};
    OK(mt_engine_import_vulkan_image(engine, &id, &imports[k], error_text,
                                     sizeof error_text));
  }
  VkSemaphore sem, ready_sem;
  VkSemaphoreTypeCreateInfo ti = {VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO};
  ti.semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE;
  VkSemaphoreCreateInfo sci = {VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
  sci.pNext = &ti;
  VK(vkCreateSemaphore(d, &sci, NULL, &sem));
  VK(vkCreateSemaphore(d, &sci, NULL, &ready_sem));
  mt_vk_gpu_timeline_desc td = {sizeof td, 0, NULL, sem};
  mt_vk_gpu_timeline_desc ready_desc = {sizeof ready_desc, 0, NULL, ready_sem};
  mt_gpu_timeline timeline = 0;
  mt_gpu_timeline timeline_duplicate = 0;
  mt_gpu_timeline ready_timeline = 0;
  OK(mt_engine_import_vulkan_timeline(engine, &td, &timeline, error_text,
                                      sizeof error_text));
  OK(mt_engine_import_vulkan_timeline(engine, &td, &timeline_duplicate,
                                      error_text, sizeof error_text));
  OK(mt_engine_import_vulkan_timeline(engine, &ready_desc, &ready_timeline,
                                      error_text, sizeof error_text));
  mt_scene scene = 0;
  void *scene_data = NULL;
  size_t scene_n = 0;
  if (make_scene(&scene, &scene_data, &scene_n))
    return 1;
  OK(mt_engine_set_scene(engine, (const uint8_t *)scene_data, scene_n,
                         error_text, sizeof error_text));
  mt_render_options ro;
  OK(mt_render_options_default(&ro));
  ro.width = w;
  ro.height = h;
  ro.max_samples = perf_samples;
  ro.aovs = MT_AOV_DEPTH | MT_AOV_CENTER_DEPTH;
  mt_render render = 0;
  OK(mt_render_create(engine, &ro, &render, error_text, sizeof error_text));
  OK(mt_engine_update(engine, NULL, error_text, sizeof error_text));
  mt_converge_options co;
  OK(mt_converge_options_default(perf_samples, &co));
  OK(mt_render_converge(render, &co, NULL, error_text, sizeof error_text));
  size_t hb = (size_t)w * h * 16, db = (size_t)w * h * 4,
         depth_cpu_bytes = (size_t)w * h * 16, written = 0;
  float *ch = (float *)malloc(hb), *cd = (float *)malloc(depth_cpu_bytes),
        *cc = (float *)malloc(hb), *gh = (float *)malloc(hb),
        *gd = (float *)malloc(db), *gc = (float *)malloc(hb);
  if (!ch || !cd || !cc || !gh || !gd || !gc)
    FAIL("pixel allocation");
  OK(mt_render_read_pixels(render, MT_IMAGE_HDR, ch, hb, &written, error_text,
                           sizeof error_text));
  OK(mt_render_read_pixels(render, MT_IMAGE_DEPTH, cd, depth_cpu_bytes,
                           &written, error_text, sizeof error_text));
  OK(mt_render_read_pixels(render, MT_IMAGE_CENTER_DEPTH, cc, hb, &written,
                           error_text, sizeof error_text));
  int depth_hit = 0, center_hit = 0;
  for (uint32_t pixel = 0; pixel < w * h; pixel++) {
    depth_hit |= cd[pixel * 4] > 0 && cd[pixel * 4 + 3] > 0;
    center_hit |= cc[pixel * 4] > 0 && cc[pixel * 4 + 3] > 0;
  }
  if (!depth_hit || !center_hit)
    FAIL("depth fixtures must contain visible geometry");
  mt_gpu_export_image batch[3];
  for (int k = 0; k < 3; k++)
    batch[k] = {sizeof batch[k], kinds[k], NULL, imports[k], MT_GPU_TOP_FIRST, 0};
  mt_gpu_export_desc ex = {sizeof ex, 3, NULL, batch, ready_timeline, 1, timeline, 1};
  uint64_t seq = 0;
  OK(mt_render_export_gpu(render, &ex, &seq, error_text, sizeof error_text));
  if (mt_engine_destroy(engine, error_text, sizeof error_text) != MT_ERROR_BUSY)
    FAIL("unsignaled ready must keep engine destruction BUSY");
  mt_gpu_export_desc rejected = ex;
  rejected.done = timeline_duplicate;
  uint64_t rejected_sequence = 99;
  if (mt_render_export_gpu(render, &rejected, &rejected_sequence,
                           error_text, sizeof error_text) != MT_ERROR_INVALID_ARGUMENT ||
      rejected_sequence != 0)
    FAIL("duplicate native timeline must reject done=1");
  rejected = ex;
  rejected.ready = timeline;
  rejected.ready_value = rejected.done_value = 2;
  rejected_sequence = 99;
  if (mt_render_export_gpu(render, &rejected, &rejected_sequence,
                           error_text, sizeof error_text) != MT_ERROR_INVALID_ARGUMENT ||
      rejected_sequence != 0)
    FAIL("same-event ready>=done must be rejected");
  PFN_vkGetSemaphoreCounterValue get_counter =
      (PFN_vkGetSemaphoreCounterValue)vkGetDeviceProcAddr(d, "vkGetSemaphoreCounterValue");
  PFN_vkSignalSemaphore signal_timeline =
      (PFN_vkSignalSemaphore)vkGetDeviceProcAddr(d, "vkSignalSemaphore");
  if (!get_counter || !signal_timeline)
    FAIL("Vulkan timeline functions unavailable");
  uint64_t native_value = UINT64_MAX;
  VK(get_counter(d, sem, &native_value));
  if (native_value != 0)
    FAIL("rejected exports touched the external timeline");
  OK(mt_render_cancel(render, error_text, sizeof error_text));
  mt_render_options resized = ro;
  resized.width = w + 1;
  resized.height = h + 1;
  OK(mt_render_set_options(render, &resized, error_text, sizeof error_text));
  for (int k = 0; k < 3; k++)
    OK(mt_gpu_image_destroy(imports[k], error_text, sizeof error_text));
  OK(mt_gpu_timeline_destroy(timeline, error_text, sizeof error_text));
  OK(mt_gpu_timeline_destroy(timeline_duplicate, error_text, sizeof error_text));
  OK(mt_gpu_timeline_destroy(ready_timeline, error_text, sizeof error_text));
  VkSemaphoreSignalInfo ready_signal = {VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO};
  ready_signal.semaphore = ready_sem;
  ready_signal.value = 1;
  VK(signal_timeline(d, &ready_signal));
  if (poll_export(engine, seq))
    return 1;
  for (int k = 0; k < 3; k++) {
    mt_vk_lease lease = 0;
    OK(mt_engine_vulkan_acquire_queue(engine, &lease, error_text,
                                      sizeof error_text));
    float *dst = k == 0 ? gh : (k == 1 ? gd : gc);
    size_t dst_bytes = k == 1 ? db : hb;
    if (host_copy(d, vi.physical_device, vi.queue, vi.queue_family, images[k],
                  formats[k], w, h, dst, dst_bytes))
      return 1;
    OK(mt_vk_lease_release(lease, error_text, sizeof error_text));
  }
  if (memcmp(ch, gh, hb) || memcmp(cc, gc, hb) ||
      !depth_matches(cd, gd, w * h))
    FAIL("CPU/export pixel mismatch");
  printf("PASS pending export survives cancel/resize/import destruction\n");
  for (int k = 0; k < 3; k++) {
    mt_vk_gpu_image_desc id = {sizeof id, 0, NULL, images[k], formats[k], w, h,
                               VK_IMAGE_LAYOUT_GENERAL};
    OK(mt_engine_import_vulkan_image(engine, &id, &imports[k], error_text,
                                     sizeof error_text));
    batch[k].image = imports[k];
  }
  OK(mt_engine_import_vulkan_timeline(engine, &td, &timeline, error_text, sizeof error_text));
  OK(mt_engine_import_vulkan_timeline(engine, &ready_desc, &ready_timeline,
                                      error_text, sizeof error_text));
  ex.ready = ready_timeline; ex.done = timeline; ex.done_value = 2;
  OK(mt_render_set_options(render, &ro, error_text, sizeof error_text));
  OK(mt_render_converge(render, &co, NULL, error_text, sizeof error_text));
  OK(mt_render_read_pixels(render, MT_IMAGE_HDR, ch, hb, &written, error_text, sizeof error_text));
  OK(mt_render_read_pixels(render, MT_IMAGE_DEPTH, cd, depth_cpu_bytes, &written, error_text, sizeof error_text));
  OK(mt_render_read_pixels(render, MT_IMAGE_CENTER_DEPTH, cc, hb, &written, error_text, sizeof error_text));
  OK(mt_render_export_gpu(render, &ex, &seq, error_text, sizeof error_text));
  if (poll_export(engine, seq))
    return 1;
  for (int k = 0; k < 3; k++) {
    mt_vk_lease lease = 0;
    OK(mt_engine_vulkan_acquire_queue(engine, &lease, error_text, sizeof error_text));
    if (host_copy(d, vi.physical_device, vi.queue, vi.queue_family, images[k],
                  formats[k], w, h, k == 0 ? gh : (k == 1 ? gd : gc), k == 1 ? db : hb))
      return 1;
    OK(mt_vk_lease_release(lease, error_text, sizeof error_text));
  }
  if (memcmp(ch, gh, hb) || memcmp(cc, gc, hb) || !depth_matches(cd, gd, w * h))
    FAIL("reimported CPU/export pixel mismatch");
#ifdef MT_PERF_720P
  const unsigned warm_frames = 5;
  double warm_cpu_begin = clock_ms();
  for (unsigned frame = 0; frame < warm_frames; frame++) {
    OK(mt_render_restart(render, error_text, sizeof error_text));
    OK(mt_render_converge(render, &co, NULL, error_text, sizeof error_text));
    OK(mt_render_read_pixels(render, MT_IMAGE_HDR, ch, hb, &written, error_text,
                             sizeof error_text));
    OK(mt_render_read_pixels(render, MT_IMAGE_DEPTH, cd, depth_cpu_bytes,
                             &written, error_text, sizeof error_text));
    OK(mt_render_read_pixels(render, MT_IMAGE_CENTER_DEPTH, cc, hb, &written,
                             error_text, sizeof error_text));
  }
  double warm_cpu_ms = (clock_ms() - warm_cpu_begin) /
                       (double)warm_frames;
  double warm_gpu_begin = clock_ms();
  for (unsigned frame = 0; frame < warm_frames; frame++) {
    OK(mt_render_restart(render, error_text, sizeof error_text));
    OK(mt_render_converge(render, &co, NULL, error_text, sizeof error_text));
    ex.done_value = 3 + frame;
    OK(mt_render_export_gpu(render, &ex, &seq, error_text, sizeof error_text));
    if (poll_export(engine, seq))
      return 1;
  }
  double warm_gpu_ms = (clock_ms() - warm_gpu_begin) /
                       (double)warm_frames;
  printf("Vulkan warm metrics: frames=%u samples=%u CPU frame=%.3fms (%.2f spp/s) "
         "GPU export frame=%.3fms (%.2f spp/s)\n",
         warm_frames, perf_samples, warm_cpu_ms,
         1000.0 * perf_samples / warm_cpu_ms, warm_gpu_ms,
         1000.0 * perf_samples / warm_gpu_ms);
#endif
  FILE *f = fopen("vulkan-export-output.bin", "wb");
  if (!f)
    FAIL("output file");
  fwrite(gh, 1, hb, f);
  fwrite(gd, 1, db, f);
  fwrite(gc, 1, hb, f);
  fclose(f);
  printf("PASS Vulkan C host: HDR/depth/center-depth byte-identical; wrote "
         "vulkan-export-output.bin\n");
  OK(mt_render_destroy(render, error_text, sizeof error_text));
  OK(mt_gpu_image_destroy(imports[0], error_text, sizeof error_text));
  OK(mt_gpu_image_destroy(imports[1], error_text, sizeof error_text));
  OK(mt_gpu_image_destroy(imports[2], error_text, sizeof error_text));
  OK(mt_gpu_timeline_destroy(timeline, error_text, sizeof error_text));
  OK(mt_gpu_timeline_destroy(ready_timeline, error_text, sizeof error_text));
  OK(mt_scene_destroy(scene, error_text, sizeof error_text));
  for (int k = 0; k < 3; k++) {
    vkDestroyImage(d, images[k], NULL);
    vkFreeMemory(d, image_memory[k], NULL);
  }
  vkDestroySemaphore(d, sem, NULL);
  vkDestroySemaphore(d, ready_sem, NULL);
  OK(mt_engine_destroy(engine, error_text, sizeof error_text));
  free(scene_data);
  free(ch);
  free(cd);
  free(cc);
  free(gh);
  free(gd);
  free(gc);
  return 0;
}
