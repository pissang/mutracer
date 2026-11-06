# Hydra integration checks

This independent project uses the public C SDK and does not change its renderer.
Sync collects snapshots under `Param::mutex`; only render-pass Execute calls the
SDK. Stop uses the concurrent cancellation API. The CPU and future host-Hgi
color/depth resources share buffer convergence and resolve state. GPU resources
must be installed together after host/SDK synchronization completes; the caller
owns their lifetime. P0-6 supplies that synchronization and SDK import path.

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
submit/update/refine/readback durations. Prediction remains attached to the last
scene edit while asynchronous preparation completes. A camera-only update has
no Scene submission. Set `MUTRACER_HYDRA_TIMELINE=1` for OpenUSD Chrome Trace output;
`HdxAovInputTask::_UpdateTexture` events measure CPU upload submission, not GPU
completion. Trace collection has overhead and should stay identical across
measurement variants.

Pass `edits` as the last argument with `tests/edits.usda` for transform, OpenPBR,
PreviewSurface, visibility, texture, membership, light and camera edits. Hydra can
coalesce remove/re-add into a topology resync; topology resyncs retire the SDK
mesh identity, while ordinary transforms and material edits retain it.

`MUTRACER_HYDRA_BENCH=1` runs a four-sample warmup followed by a camera edit and
the requested sample count, without binary dumps. `MUTRACER_HYDRA_FPS=0` reads
all changed sample counts; `30` caps reads at 30 Hz. Hydra can automatically add
picking AOVs to color outputs, so the trace records HDR, depth and ID read costs
separately. Compare steady-state frames, excluding warmup and first publication.

`MUTRACER_HYDRA_SESSION` selects an external session layer. Kitchen Set must stay
outside the repository and be loaded from its licensed local copy; add test
lights/materials/camera through that layer. The Blender fixtures here are small
exports of procedural test cubes and a 2×2 project-authored color texture.
