# Vulkan hosts

This guide explains how to connect a host Vulkan device to MuTracer and export HDR, depth,
display, or center-depth output into host-owned `VkImage` objects. Device creation, record
layouts, formats, defaults, and status codes are defined by
[`mutracer-vulkan.h`](../include/mutracer-vulkan.h) and
[`mutracer-gpu.h`](../include/mutracer-gpu.h). This page covers call order and behavior that
affects host decisions.

## Usage

### Share a device

Before creating the host instance and device, prepare the extensions and features required by
MuTracer:

1. Query `mt_vk_instance_extensions` and enable the returned instance extensions, then choose a
   `VkPhysicalDevice`.
2. Fill `mt_vk_host_desc`, including the retirement callback, and call
   `mt_vk_device_plan_create`.
3. Use the returned features, feature chain, and device extensions with `vkCreateDevice`, and
   enable the graphics and compute queue required by MuTracer.
4. Fill `mt_vk_device_desc` with the created device, queue family/index, and retirement callback,
   then call `mt_engine_create_vulkan`. The device plan may be destroyed after this call.
5. Follow the normal [scene/render workflow](engine.md#render-offline) to create scenes and
   renders. Call `mt_engine_vulkan_info` when native handles are needed.

The host retains ownership of the instance, physical device, device, queue, and driver objects.
Keep them alive until the retirement callback reports that they are no longer used. The callback
may run on any thread and must not re-enter MuTracer. Import at most one MuTracer engine per
native device; one engine may own multiple renders.

### Export host-owned images

Create storage-capable `VkImage` objects and timeline `VkSemaphore` objects on the same
`VkDevice` passed to `mt_engine_create_vulkan`, then import them with
`mt_engine_import_vulkan_image` and `mt_engine_import_vulkan_timeline`. MuTracer does not destroy
these host-owned handles. One export descriptor can contain multiple destination images, all
covered by one `done` timeline value.

The following is pseudocode. Every record must set `struct_size` to `sizeof(the_record)`, keep
reserved fields zero, and set `next` to `NULL`; omitting these fields causes `INVALID_ARGUMENT`.
The accepted formats and defaults are defined by the C headers.

```c
/* Host creates VkImage(s) and timeline semaphores on the imported VkDevice. */
mt_vk_gpu_image_desc hdr_desc = {
    .struct_size = sizeof(mt_vk_gpu_image_desc), .reserved = 0, .next = NULL,
    .image = hdr_vk_image, .format = hdr_vk_format,
    .width = width, .height = height, .initial_layout = VK_IMAGE_LAYOUT_GENERAL,
};
mt_vk_gpu_image_desc depth_desc = {
    .struct_size = sizeof(mt_vk_gpu_image_desc), .reserved = 0, .next = NULL,
    .image = depth_vk_image, .format = depth_vk_format,
    .width = width, .height = height, .initial_layout = VK_IMAGE_LAYOUT_GENERAL,
};
mt_vk_gpu_image_desc center_desc = {
    .struct_size = sizeof(mt_vk_gpu_image_desc), .reserved = 0, .next = NULL,
    .image = center_vk_image, .format = center_vk_format,
    .width = width, .height = height, .initial_layout = VK_IMAGE_LAYOUT_GENERAL,
};
mt_vk_gpu_timeline_desc ready_desc = {
    .struct_size = sizeof(mt_vk_gpu_timeline_desc), .reserved = 0, .next = NULL,
    .semaphore = ready_semaphore,
};
mt_vk_gpu_timeline_desc done_desc = {
    .struct_size = sizeof(mt_vk_gpu_timeline_desc), .reserved = 0, .next = NULL,
    .semaphore = done_semaphore,
};
mt_gpu_image hdr, depth, center;
mt_gpu_timeline ready, done;
mt_engine_import_vulkan_image(engine, &hdr_desc, &hdr, error, capacity);
mt_engine_import_vulkan_image(engine, &depth_desc, &depth, error, capacity);
mt_engine_import_vulkan_image(engine, &center_desc, &center, error, capacity);
mt_engine_import_vulkan_timeline(engine, &ready_desc, &ready, error, capacity);
mt_engine_import_vulkan_timeline(engine, &done_desc, &done, error, capacity);

mt_gpu_export_image outputs[] = {
    { .struct_size = sizeof(mt_gpu_export_image), .kind = MT_GPU_OUTPUT_HDR,
      .next = NULL, .image = hdr, .row_order = MT_GPU_TOP_FIRST, .reserved = 0 },
    { .struct_size = sizeof(mt_gpu_export_image), .kind = MT_GPU_OUTPUT_DEPTH,
      .next = NULL, .image = depth, .row_order = MT_GPU_TOP_FIRST, .reserved = 0 },
    { .struct_size = sizeof(mt_gpu_export_image), .kind = MT_GPU_OUTPUT_CENTER_DEPTH,
      .next = NULL, .image = center, .row_order = MT_GPU_TOP_FIRST, .reserved = 0 },
};
mt_gpu_export_desc export = {
    .struct_size = sizeof(mt_gpu_export_desc), .image_count = 3, .next = NULL,
    .images = outputs,
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

For each accepted export, wait for `done` before the host reads or copies any image. Restore every
image to the declared host-return layout (`GENERAL`) after consumption, then signal the next
`ready` value. Cancellation does not revoke an accepted export. A rejected call sets its sequence
output to zero and does not touch external synchronization. A device-loss or post-submit failure
has an unknown outcome; stop waiting and rebuild the affected engine/device as described by the
header.

### Use queues and display images

Host `vkQueue*` calls on the exact queue imported into MuTracer require
`mt_engine_vulkan_acquire_queue`; submit the host work and call `mt_vk_lease_release` promptly
after the CPU calls return. The lease also covers host work before the first rendered image and
must not be held while doing unrelated CPU work.

The host-owned export path is different: host work on another queue enabled on the same device
does not use the library-queue lease. It must instead obey the imported `ready`/`done` timeline
values and perform queue-family ownership transfers when the queues belong to different families.
The library queue remains serialized by the export timeline contract.

For the existing borrowed-image path, call `mt_render_vulkan_acquire_image`, use the returned
image only on the exact leased library queue, restore the declared layout, and release the lease.
The image is read-only to the host and must not be destroyed or used on another queue.

### Add a display post-process

Register a callback with `mt_display_add_vulkan_post_process` and keep its subscription handle.
The callback records into the supplied command buffer, fully writes its output, restores the
specified layouts, and returns `MT_OK`. It must not end, submit, or reset the command buffer, call
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

- All imported images, semaphores, memory, command resources, and host synchronization objects
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
  the existing device-sharing, queue-lease, and display post-process paths, but the new C
  host-owned image import functions return `UNAVAILABLE`. macOS hardware was not validated in
  this work, and Linux driver interoperability remains runtime-unverified.
