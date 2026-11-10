# Vulkan hosts

本指南说明如何把宿主 Vulkan 设备接入 MuTracer，以及如何把宿主拥有的
`VkImage` 作为 HDR、depth、display 或 center-depth 的导出目标。设备创建、结构体布局、
格式、默认值和错误码以 [`mutracer-vulkan.h`](../include/mutracer-vulkan.h) 与
[`mutracer-gpu.h`](../include/mutracer-gpu.h) 为准；本页只描述调用顺序和会影响宿主决策的
行为。

## Usage

### Share a device

在创建宿主 instance/device 之前准备 MuTracer 所需的扩展和 features：

1. 用 `mt_vk_instance_extensions` 查询并启用 instance extensions，然后选择
   `VkPhysicalDevice`。
2. 填写 `mt_vk_host_desc`（包括 retirement callback），调用
   `mt_vk_device_plan_create`。
3. 将返回的 features、feature chain 和 device extensions 用于 `vkCreateDevice`，并启用
   MuTracer 要求的 graphics+compute queue。
4. 用创建出的 device、queue family/index 和 retirement callback 填写
   `mt_vk_device_desc`，调用 `mt_engine_create_vulkan`。此后可以销毁 device plan。
5. 按通常的 [scene/render workflow](engine.md#render-offline) 创建场景和 render；需要
   native 句柄时调用 `mt_engine_vulkan_info`。

宿主继续拥有 instance、physical device、device、queue 和驱动。它们必须一直存活到
retirement callback 通知完成；callback 可在任意线程运行，不能在 callback 中重入 MuTracer。
每个 native device 只导入一个 MuTracer engine；同一 engine 可以拥有多个 render。

### Export host-owned images

宿主可以在传给 `mt_engine_create_vulkan` 的同一 `VkDevice` 上创建 storage-capable
`VkImage` 和 timeline `VkSemaphore`，然后用 `mt_engine_import_vulkan_image` 与
`mt_engine_import_vulkan_timeline` 导入。MuTracer 不会销毁这些宿主句柄。一个 export
descriptor 可以包含多张目标图像，并由一个 `done` timeline value 覆盖整批图像。

典型流程如下（结构体初始化、格式选择和默认值请直接查 C headers）：

```c
/* Host creates VkImage(s) and timeline semaphores on the imported VkDevice. */
mt_gpu_image hdr, depth, center;
mt_gpu_timeline ready, done;
mt_engine_import_vulkan_image(engine, &hdr_desc, &hdr, error, capacity);
mt_engine_import_vulkan_image(engine, &depth_desc, &depth, error, capacity);
mt_engine_import_vulkan_image(engine, &center_desc, &center, error, capacity);
mt_engine_import_vulkan_timeline(engine, &ready_desc, &ready, error, capacity);
mt_engine_import_vulkan_timeline(engine, &done_desc, &done, error, capacity);

mt_gpu_export_image outputs[] = {
    { .image = hdr,    .kind = MT_GPU_OUTPUT_HDR },
    { .image = depth,  .kind = MT_GPU_OUTPUT_DEPTH },
    { .image = center, .kind = MT_GPU_OUTPUT_CENTER_DEPTH },
};
mt_gpu_export_desc export = {
    .images = outputs, .image_count = 3,
    .ready = ready, .ready_value = next_ready,
    .done = done, .done_value = next_done,
};
uint64_t sequence = 0;
mt_render_export_gpu(render, &export, &sequence, error, capacity);

/* Poll without blocking MuTracer's API thread. */
uint32_t complete = 0;
while (!complete)
    mt_engine_gpu_poll(engine, sequence, &complete, error, capacity);

/* Host waits/observes done, consumes every image, restores GENERAL, then
 * signals ready before requesting the next export. */
```

For each accepted export, wait for `done` before host reads or copies the images. Restore every
image to the declared host-return layout (`GENERAL`) after consumption, then signal the next
`ready` value. Cancellation does not revoke an accepted export. A rejected call sets its sequence
output to zero and does not touch external synchronization; a device-loss or post-submit failure
has unknown outcome, so stop waiting and rebuild the affected engine/device as described by the
header.

### Use queues and display images

Host `vkQueue*` calls on the exact queue imported into MuTracer require
`mt_engine_vulkan_acquire_queue`; submit the host work and call `mt_vk_lease_release` promptly
after the CPU calls return. The lease also covers host work before the first rendered image and
must not be held while doing unrelated CPU work.

The host-owned export path is different: host work on another queue that was enabled on the same
device does not use the library-queue lease. It must instead obey the imported `ready`/`done`
timeline values and perform queue-family ownership transfers when the queues belong to different
families. The library queue remains serialized by the export timeline contract.

For the existing borrowed-image path, call `mt_render_vulkan_acquire_image`, use the returned
image only on the exact leased library queue, restore the declared layout, and release the lease.
The image is read-only to the host and must not be destroyed or used on another queue.

### Add a display post-process

Register a callback with `mt_display_add_vulkan_post_process` and keep its subscription handle.
The callback records into the supplied command buffer, fully writes its output, restores the
specified layouts, and returns `MT_OK`. It must not end, submit or reset the command buffer, call
MuTracer, or destroy borrowed handles. Remove future calls with `mt_vk_post_process_remove`.
Callbacks run in registration order with other display passes; a failed callback discards that
composition and reports an engine error.

## Options

- `mt_vk_device_plan_create` selects the required device features/extensions. A host may enable
  additional features, but must not duplicate feature structures in the `pNext` chain.
- `mt_vk_instance_extensions` accepts API version 1.1 or newer for enumeration. The currently
  validated wgpu shader path requires a Vulkan 1.3 host/device; lower-version paths are not an
  unconditional promise of this interop contract.
- `mt_gpu_export_image.kind` selects HDR, depth, display, or center-depth, and `row_order`
  selects top-first or bottom-first output. `ready` is optional; `done` is required and one done
  value covers all images in the descriptor. Exact accepted formats, dimensions, usage flags,
  struct defaults, and valid ranges are declared in the C headers linked above.
- Depth and center-depth require the corresponding render AOV to be enabled. Display export
  requires a completed `mt_display_present` composition. Export does not change refinement or
  sample counts and does not perform CPU pixel readback.

## Caveats and costs

- All imported images, semaphores, memory, command resources and host synchronization objects
  remain host-owned. Keep backing objects alive until the done value has passed and all retirement
  notifications have arrived. Cross-device import is not supported.
- Same-queue leases serialize CPU submission access and can stall rendering or uploads if held too
  long. A separate host queue avoids that lease but costs explicit timeline and, where applicable,
  queue-family ownership synchronization. Exporting multiple AOVs shares one GPU completion
  signal, while each destination still needs compatible storage and transfer usage.
- `mt_engine_destroy` returns BUSY while accepted exports are pending; poll and drain before
  releasing host backing storage. Device loss is terminal and may leave done unsignaled. Do not
  retry a failed export as if it had completed.
- The Vulkan host-owned image/timeline import API is available on Linux and Windows. macOS keeps
  the existing device-sharing, queue-lease and display post-process paths, but the new C
  host-owned image import functions return `UNAVAILABLE`; this report contains no macOS hardware
  validation. Linux driver interoperability is likewise runtime-unverified here.
