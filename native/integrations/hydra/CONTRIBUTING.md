# Hydra integration checks

This independent project uses the public C SDK and does not change its renderer.
Sync collects snapshots under `Param::mutex`; render-pass Execute and on-demand
Buffer Map serialize SDK access under that mutex. Stop uses concurrent cancellation.
CPU and host-Hgi color/depth
resources share buffer convergence and resolve state; both handles are installed
together (color-only bindings export HDR and clear the internal depth). The host owns its Hgi and must outlive the delegate and render index.

The Metal adapter imports the host device into an independent SDK queue.
An SDK done wait is submitted to the actual Hgi queue before Hgi compute. Compute
converts row order, scale, premultiplication/clear and center camera-forward depth;
a depth-only Hgi graphics pass writes the clip result to a depth attachment for
presentation and selection. The adapter then signals ready on the GPU. On the
next publication, a marker after the preceding frame's Hgi commands retires its
readers. The current slot is never reused; the other two slots are reused only
after their markers complete. If neither is free, skip publication and keep
refining. No unsignalled host readiness is submitted to the SDK. Resize, output
changes and destruction drain SDK exports with `mt_engine_gpu_poll`, then drain
the host queue before releasing imports and Hgi resources. Hosts must finish
encoding a frame's texture readers before the next Hydra Execute.

Hgi 26.03 has no external timeline API, so waits/signals and queue boundaries
live in `gpuMetal.mm`. Conversion uses Hgi shader/compute/graphics interfaces.
HgiMetal fixes fast-math on and Metal lacks double; integer IEEE arithmetic
preserves the CPU float FMA and double depth projection. Its shader requires
64-bit integer support. `hydraGpuContracts` compares randomized HDR/coverage and
depth inputs, float32/float16, perspective/orthographic and scaling against CPU
operations, including the final depth attachment.

Generate fixtures using the Python environment used for the OpenUSD build:

```sh
python native/integrations/hydra/tests/generate.py
ctest --test-dir /absolute/hydra-build --output-on-failure
/absolute/hydra-build/hydraTrace native/integrations/hydra/tests/rect.usda \
  /absolute/evidence/rect HdMuTracerRendererPlugin 256 256 16
```

`hydraTrace` uses UsdImagingGLEngine without presentation or a visible window.
It writes linear bottom-row-first AOV binaries and frame timings. MuTracer color
is float32 RGBA; Storm color is float16 RGBA; depth is float32, IDs int32. AOV
format/dimensions are printed. Storm comparisons request color/depth only because
integer AOV blending can fail Metal validation in this USD build. MuTracer ID
checks use the recorded Hydra path/primId table, never Storm's uninitialized IDs.

Set `MUTRACER_HYDRA_TRACE` to a JSONL output path to record Sync dirty bits,
dirty-prim counts, object identity mappings, predicted/actual commits and CPU
submit/update/refine/readback durations, actual backend, GPU export calls,
Hgi conversion submission time and skipped publications. Prediction remains attached
to the last scene edit while asynchronous preparation completes. A camera-only
update has no Scene submission. Set `MUTRACER_HYDRA_TIMELINE=1` for OpenUSD Chrome Trace output;
`HdxAovInputTask::Execute` measures the AOV task; its `_UpdateTexture` events
measure CPU upload submission, not GPU completion. Trace collection has overhead
and should stay identical across measurement variants.

Pass `edits` as the last argument with `tests/edits.usda` for transform, OpenPBR,
PreviewSurface, visibility, texture, membership, light and camera edits. Hydra can
coalesce remove/re-add into a topology resync; topology resyncs retire the SDK
mesh identity, while ordinary transforms and material edits retain it.

`MUTRACER_HYDRA_BENCH=1` runs a four-sample warmup followed by a camera edit and
the requested sample count, without binary dumps. `MUTRACER_HYDRA_FPS=0` publishes
all changed sample counts; `30` caps output at 30 Hz. `MUTRACER_HYDRA_CPU=1`
forces CPU output; zero uses automatic GPU selection. Switching output keeps
the SDK engine and accumulated samples, and drains/releases GPU output textures.
The default color viewport exercises `HdxAovInputTask`;
`MUTRACER_HYDRA_ALL_AOVS=1` instead requests the offline multi-AOV task list.
`MUTRACER_HYDRA_COLOR_ONLY=1` requests an explicit color-only task list;
`MUTRACER_HYDRA_VECTOR_AOV=normal` (or `Neye` / `Peye`) with `MUTRACER_HYDRA_ALL_AOVS=1`
checks individual CPU fallback. `MUTRACER_HYDRA_EXPECT_GPU=1` asserts nonempty
Hgi resources for every bound color/depth buffer (0 asserts CPU buffers).
Viewport GPU runs dump both the final Hdx textures
(`*-hgi.bin`) and independent CPU `Map()` results. The phase summaries contain
frame P50/P95 and samples per wall second, including the harness's 1 ms polling
sleeps. Export and conversion measurements are CPU submission durations.

Run the same HWRT rect benchmark at 720p, 1080p and 4K with:

```sh
python native/integrations/hydra/tests/measure.py /absolute/hydra-build /absolute/evidence
```

It runs CPU/GPU variants at 0/30 Hz, records raw traces and writes `summary.json`.
Measure without concurrent builds, tests or visible viewport rendering. For
fixed-sample parity in one host process, set `MUTRACER_HYDRA_COMPARE=1`: initial
GPU, forced CPU and repeated GPU outputs retain the same Hydra identities and
prototype ordering. Separate processes can renumber native-instance prototypes.
`tests/center-depth.usda` has overlapping planes at camera-forward distances 4
and 5 for checking depth/primId at their boundary and the silhouette.

The `edits` sequence also exercises resize, resolution scale, Software/HWRT and
CPU/GPU switching, and cancellation followed by restart.
`MUTRACER_HYDRA_CANCEL_EXIT=1` exits while cancelled work is still retiring.
`MUTRACER_HYDRA_SLOW_HOST=1` adds GPU timeline waits to simulate
a reader 50 ms behind; `MUTRACER_HYDRA_SKIP_SWITCH=1` keeps this sequence entirely
on GPU for Metal Validation. OpenUSD 26.03's CPU depth-upload path blits R32Float
to Depth32Float and fails Metal Validation; keep that host failure separate from
the GPU validation results rather than disabling validation for GPU tests.

`MUTRACER_HYDRA_AOV_SWITCH=1` additionally switches between viewport and offline
multi-AOV task lists. OpenUSD 26.03 can leave stale task-context textures when
the AOV input task is disabled; this can fail in its visualization task or return
an old-sized image. The harness rejects mismatched dimensions before readback.
Use separate host engines for these task lists until the host issue is resolved.

`MUTRACER_HYDRA_SESSION` selects an external session layer. Kitchen Set must stay
outside the repository and be loaded from its licensed local copy; add test
lights/materials/camera through that layer. The Blender fixtures here are small
exports of procedural test cubes and a 2×2 project-authored color texture.
