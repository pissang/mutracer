# Vulkan hosts

The C API in [mutracer-vulkan.h](../include/mutracer-vulkan.h) can share a host's
Vulkan device, borrow rendered images and record custom display passes. It is
available on Linux and Windows. macOS builds need the `vulkan-interop` Cargo
feature and a Vulkan portability driver.

## Share a device

Arrange the required extensions and features **before** creating the host's
instance and device:

1. Call `mt_vk_instance_extensions` with the driver's `vkGetInstanceProcAddr`.
   Enable the returned extensions when creating the instance, then choose a
   physical device.
2. Fill `mt_vk_host_desc`, including its retirement callback, and call
   `mt_vk_device_plan_create` with ordinary `mt_engine_options`.
3. Use the returned feature values, feature chain and device extensions in
   `vkCreateDevice`. Create a graphics-and-compute queue.
4. Pass the device, queue family/index and device retirement callback through
   `mt_vk_device_desc` to `mt_engine_create_vulkan`. The plan can now be destroyed.
5. Use the usual [scene and render workflow](engine.md#render-offline). Query
   `mt_engine_vulkan_info` once to get the shared native device and queue.

For example, after choosing queue priorities and obtaining `requirements`:

```c
VkDeviceCreateInfo create = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO };
create.pEnabledFeatures = requirements.features;
create.pNext = requirements.features_next;
create.enabledExtensionCount = (uint32_t)requirements.extension_count;
create.ppEnabledExtensionNames = requirements.extensions;
create.queueCreateInfoCount = 1;
create.pQueueCreateInfos = &queue_info;
/* vkCreateDevice, then mt_engine_create_vulkan with that device and queue. */
```

An existing device works only if it was created with the required features and
extensions. They cannot be added afterward. Each native device belongs to one
MuTracer engine; use multiple renders on that engine.

The host retains ownership of the native instance, device, queue and driver.
Keep them alive until their retirement callbacks arrive, which can happen after
engine or plan destruction. These callbacks can run on any thread; record the
notification and destroy native devices before their instance. Do not call
MuTracer from a retirement callback.

## Use the queue and images

Host `vkQueue*` calls on the shared queue need a lease. Call
`mt_engine_vulkan_acquire_queue`, submit host work, then call
`mt_vk_lease_release` as soon as those calls return on the CPU. This also works
before the first image exists, for example while MuTracer prepares a scene.
Creating host resources does not require a queue lease.

To consume an image:

1. Complete a render. For a display image, also compose with
   `mt_display_present`.
2. Call `mt_render_vulkan_acquire_image`. It returns a native `VkImage` and a
   lease, with the image ready for sampled reads.
3. Record and submit read-only use on the shared queue. If temporarily changing
   its layout for a copy, restore the returned layout before ending the commands.
4. Release the lease. The host need not wait for GPU completion to return it.

A lease pauses library submissions, so keep it only while recording/submitting
host work. Other calls on this engine must wait until release, except render
cancellation. Do not write or destroy the image, or record/submit new uses after
release. Host command pools, views, descriptors and pipelines remain the host's responsibility;
keep them alive until its fences complete.

## Add a display pass

Register a C callback with `mt_display_add_vulkan_post_process` and keep its
subscription handle. The callback records Vulkan commands into the supplied
command buffer. Input is read-only; fully write the output and restore the
specified layouts. Return `MT_OK` to accept the pass. The callback must not end,
submit or reset the command buffer, or call MuTracer.

Passes run in registration order with other display passes. A failed callback
discards the entire chain for that composition and reports an engine error.
Remove future calls with `mt_vk_post_process_remove`. Callback resources must
belong to the shared device and survive GPU execution. The header specifies
SDR and HDR-window formats and the exact layouts.

## Costs and limits

- Image borrowing does not read pixels to the CPU. HDR resolution and display
  composition still allocate the [usual GPU images](display.md#gpu-images-rust).
- Queue/image leases synchronize CPU submission access without waiting for GPU
  completion; long leases stall rendering and background uploads. Display passes
  add intermediate images and GPU work.
- Sharing requires the same device and exact queue. Cross-device external memory,
  other queues, queue-family transfers and external semaphore handoffs are not
  exposed. Metal hosts with an already-created device can use the independent
  [texture export path](metal.md); already-created Vulkan devices still need a
  separate external-memory integration.
- Native handles and Vulkan feature declarations are trusted caller inputs;
  invalid handles or queue/layout/lifetime violations cannot be made safe by
  argument validation.
- Linux driver interoperability remains runtime-unverified.
