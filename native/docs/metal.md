# Metal hosts

Use [mutracer-metal.h](../include/mutracer-metal.h) to render on a host's Metal
device and export into its textures without CPU pixel transfers. macOS supports
Software and HWRT; other platforms return `MT_ERROR_UNAVAILABLE`. Function
comments specify formats, ownership, errors and thread rules.

## Import and render

1. Pass the host's `id<MTLDevice>` to `mt_engine_create_metal`. Leave `queue` NULL
   for an independent library queue, then follow the usual
   [scene/render workflow](engine.md#render-offline).
2. Create host textures with shader-write usage and import them with
   `mt_engine_import_metal_image`. Use RGBA32Float or RGBA16Float for HDR, R32Float
   or RGBA32Float for either depth kind, and RGBA8Unorm for composed display.
3. Create two `MTLSharedEvent` timelines and import them with
   `mt_engine_import_metal_timeline`: host readiness and library completion.
4. Enable `MT_AOV_DEPTH` for averaged depth or `MT_AOV_CENTER_DEPTH` for the
   pixel-center surface shared with IDs. Refine normally; compose with
   `mt_display_present` before exporting display output.

Imports use `struct_size = sizeof(record)`, `next = NULL` and reserved fields 0.
Under ARC, pass native objects as `(__bridge void *)object`. Rust hosts use
`Engine::on_metal`, its import methods and `Render::export_metal` in
`api::metal`; those native-pointer methods are unsafe.

## Export and synchronize

Export color and the desired depth together so one done signal covers both.
For selection, use center depth:

```c
mt_gpu_export_image images[] = {
    {sizeof(mt_gpu_export_image), MT_GPU_OUTPUT_HDR, NULL, color, MT_GPU_TOP_FIRST, 0},
    {sizeof(mt_gpu_export_image), MT_GPU_OUTPUT_CENTER_DEPTH, NULL, depth, MT_GPU_TOP_FIRST, 0},
};
mt_gpu_export_desc request = {
    sizeof(request), 2, NULL, images, ready_timeline, ready_value,
    done_timeline, ++done_value,
};
uint64_t sequence = 0;
mt_status status = mt_render_export_gpu(render, &request, &sequence, error, sizeof(error));
/* Only on MT_OK: submit host commands that wait for done_value before reading.
 * After those readers, signal the next ready_value on the host GPU queue. */
```

Initially an event's value is 0, so ready value 0 requires no producer work.
Subsequent reuse waits for the host's readers to finish. Submit readiness
independently; a host waiting for done must not withhold the ready signal needed
to produce it. Signals must strictly increase; `UINT64_MAX` is reserved. Use
separate timelines for independent producers.

Rejected calls return sequence 0 and do not touch external synchronization.
Encoding finishes before acceptance. An accepted export survives render
cancellation, resizing and import-handle destruction. Device loss or an unexpected
submission failure has unknown outcome: signals may never arrive, so stop waiting
and rebuild the engine and host device.

Call `mt_engine_gpu_poll` regularly to retire work; sequence 0 queries all
accepted exports. It never waits for the GPU. Engine destruction returns `BUSY`
without removing handles while exports are pending. Finish host producers, drain
exports and host consumers, then destroy the engine and release native storage.
Device loss is terminal and allows engine destruction without guaranteeing done.

## Costs and limits

- Exports use the latest published HDR/display and ready depth AOV. They do not
  wait for another sample or restart accumulation. A disabled or unavailable
  source reports `INVALID_STATE`. Depth and beauty have independent sample counts.
- HDR follows `mt_render_read_pixels`, including its coverage and opaque solid
  background behavior. Depth is camera-forward distance in scene units; RGBA
  depth contains distance, 0, 0, coverage. `MT_GPU_OUTPUT_DEPTH` retains the
  independently sampled, jitter/DOF-averaged result. `MT_GPU_OUTPUT_CENTER_DEPTH`
  matches `MT_IMAGE_CENTER_DEPTH`: an unjittered pinhole hit shared with IDs, with
  binary validity instead of averaged coverage. Convert to clip depth in the host.
- Output is top row first by default, matching engine readback; select
  `MT_GPU_BOTTOM_FIRST` when the consumer expects lower-left image coordinates.
  Textures must exactly match source size; export does not rescale them.
- This path avoids CPU pixel copies and uploads; it still performs GPU conversion
  and writes the host image. Host textures and normal render/AOV storage remain
  necessary. Each exported depth kind retains an additional 8 bytes per AOV pixel
  on the GPU; center tracing also has the [center-AOV cost](display.md#aov-channels).
  First use can block for pipeline compilation; queue saturation can
  also backpressure submission.
- Export at presentation rate (for example 60 Hz) while continuing refinement.
  Use ring textures to avoid waiting for busy host readers. An unsignalled ready
  can stall later library GPU work. Up to 32 export batches may be pending;
  additional calls return `BUSY` until completion is polled.
- Imports require the same native device, ordinary single-layer/mip/sample 2D
  textures, shader-write usage, tracked hazards and private/shared storage.
  Cross-device textures and Metal depth-attachment formats are unsupported.
- Imports retain native objects. Pending work retains textures after their import
  handles are released; timeline events and signal history stay until engine
  disposal. Retention does not make purging or reallocating their storage safe.
- Call one engine and its objects from one thread at a time; only cancellation may
  run concurrently. A supplied shared queue also requires host submission access
  to be serialized with library calls and background preparation. Prefer the
  default independent queue. For a supplied queue, allow enough command buffers
  for pending SDK and host work; the example uses a capacity of 4096. Saturating
  a small queue while withholding ready can block the producer on the CPU.

The [Objective-C host](../examples/metal-host.m) shows GPU consumers and timeline
reuse. Existing Vulkan hosts use the separate
[negotiated same-queue API](vulkan.md). Vulkan foreign-image/timeline imports and
DX12 shared-resource/fence imports remain unavailable until their HAL ownership
and validation layers are implemented; unsupported calls must leave external
handles and synchronization untouched.
