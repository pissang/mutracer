# Performance

A tuning checklist. Each item links to the page with the details.

## Resolution and samples

- Rays per sample scale with pixel count. Cap the device pixel ratio
  (`Math.min(devicePixelRatio, 2)`, or lower on mobile).
- Set `maxSamples` for the quality you need. With a denoiser, 64–256 spp is
  usually enough; without one, 1000+ for clean results.
- Start with `bounces` 3–5. Raise it for glass, subsurface scattering or
  interiors lit indirectly, not everywhere.
- `clamping` removes fireflies at the cost of bias; use the smallest value
  that works.

## Responsiveness

- Use a preview Render with cheaper quality and optional adaptiveResolution:
  `{targetFrameMs: 20, minScale: .25}`, plus resolutionScale .5. Choose it during
  motion and configure final.fallback once; see [progressive rendering](./progressive-rendering.md).
- `timeBudgetMs` (default 21) targets each render's tile cost. Raise it for exports.
- `batchSamples` lets a still render use the whole GPU instead of one sample per
  display frame; enable it with `RenderLoop({final: {batchSamples: true}})`. In your
  own loop, a larger `timeBudgetMs` batches more per call but delays the first
  preview after an edit. See [sample batching](./progressive-rendering.md#sample-batching).
- For exports, `render.converge` with `targetBatchTimeMs` adapts batch sizes
  to the GPU; omit `previewIntervalMs` for maximum throughput.

## Scene setup

- Share `Geometry`, `OpenPBRMaterial` and `Texture` objects. Shared geometry
  shares its BLAS and GPU buffers.
- For large scenes, try `engine.bvhBuilder = 'tinybvh'` and build BVHs up
  front with optional `await engine.prepare(nextScene)`. Tune `bvhWorkerCount` for
  parallel construction across geometries; see [BVH](./bvh.md).
- With Three.js, keep one `THREESync(engine, {scene, camera, controls})` for the whole session rather than
  converting again with `fromTHREEScene`.
- Textures share an atlas bounded by `textureAtlasBudgetBytes`; larger textures
  are downscaled. Check `engine.getDiagnostics()?.textureAtlas`.

WebGPU quantizes vertex normal and tangent directions; scenes with displacement
retain full normal precision. Vertex RGB values in
`[0, 1]` have at most `1/510` absolute error per channel; scenes containing
negative or HDR vertex colors retain float32 RGB instead. Positions and UV
coordinates retain float32 precision. Large scenes still depend on the device's
buffer limits and the browser's available CPU memory.

## Animation and editing

See [scene updates](./updates.md) for the cost of each kind of edit.

- Edit `mesh.transform` in place: transform changes only refit instances.
- For vertex animation, keep the arrays, set `geometry.dynamic = true` and call
  `geometry.markVerticesUpdated()`, not `markUpdated()`.
- Avoid [full mesh updates](./updates.md#full-mesh-updates) per frame:
  replacing arrays, changing displacement, or adding new geometry.
- Three.js skinning and morph targets run on the CPU; cost grows with
  vertices, bone influences and material groups. An unchanged pose is free.
- Each `InstancedMesh` instance adds one top-level BVH instance per material
  group. Native instance colors share the same materials.

## Lighting

- Prefer `RectLight` and `SphereLight` to small emissive meshes: analytic
  lights are sampled directly and converge faster.
- Scenes with many lights benefit from more `directLightCandidates` (WebGPU).
- A bright, small sun in an environment map is importance sampled, but a
  `DirectionalLight` is cleaner when the sun is the key light.

## Shader compilation

The path-tracing shaders are large. The first frame can take several seconds
to compile on some platforms (`'compiling'`). Materials
with displacement or alpha, and some renderer options, select shader variants
that compile on first use. Show a status while compiling, as the examples do.

## Diagnostics

`engine.getDiagnostics()` reports the backend and adapter, shader
compilation times, BVH statistics, light sampling setup and GPU trace timing.
`presentedTarget` is the presented render label after the first complete image
(`undefined` beforehand); `presentedComplete` is initially `false`.
`targets` lists each resident accumulation's `label`, `width`, `height` and
allocated GPU payload `bytes`, including its retained outputs. It excludes shared scene data and temporary image passes, shader/driver overhead,
and resources queued for release. Each render retains accumulation buffers,
resolved outputs, its last complete composition and its valid denoised result.
Post-processing, readback and denoising scratch resources are shared by the engine;
their allocated capacity grows to the largest required dimensions.

Preview and final keep independent outputs. Switching uses their complete
images without reallocating them; final's first tiled sample keeps preview on
screen until it completes. Adaptive resolution may rebuild only the preview
target; its previous complete image remains available through the rebuild.
Targets are created lazily and remain resident until disposed. Resolution,
quality and interaction exceptions are explicit application choices.
