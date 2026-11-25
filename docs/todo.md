# TODO

Follow-ups deferred during earlier work, and options evaluated and rejected.
None of them changes the current public API; the ones marked additive would
only add to it.

## Rendering and denoising

- **HDR-stage post-process hooks.** `display.addPostProcess` runs after display
  composition only. The built-in JNLM and OIDN filters denoise the composed
  display-linear image and cache the result, so an HDR-stage hook would feed
  the denoiser input and leave stale results whenever the hook changes. This
  needs an invalidation rule first, for example restarting denoising when the
  hook list or a hook revision changes.
- **Shadow-catcher shadows with custom denoisers.** `DenoiseInput` provides only
  color, albedo and normal. Catcher shadow masks are composited after filtering
  and keep their noise. The built-in filters do filter these shadows. One option
  is an optional mask buffer on `DenoiseInput` (additive).
- **`readPixels('denoised')` depends on the filter.** Built-in filters return
  display-linear values because they filter after tone mapping. Custom filters
  return linear HDR. This is documented in TSDoc; consider a single contract.
- **Unused alpha post-filter.** `WGPURenderingPipeline` keeps an OIDN alpha
  post-filter (the `alphaDenoiser` parameter), but `Render` always passes
  `undefined`. Expose it or remove it; removing an image-quality mechanism is
  a maintainer decision.

## Performance and memory

- **Dirty ranges for `InstancedMesh`.** `markTransformsUpdated(start, count)` / `markColorsUpdated(start, count)`
  validates its range, but a commit still copies the whole changed `transforms`
  or `colors` array. Transform edits refit the whole TLAS; color edits only
  upload instance records. Unchanged updates are already cheap (100,000
  instances: about 10.6 ms down to 0.0025 ms per `engine.update()`); frames
  that change transforms are not optimized.
- **Camera allocation in `THREESync`.** Every `update()` creates a temporary
  `Camera` with `fromTHREECamera` and copies it into the retained camera
  (`src/util/fromTHREE.ts`). Update the retained camera in place instead.
- **Render target memory.** A WebGPU render target uses about 110 bytes per
  pixel. Check which buffers can be shared between renders or use narrower
  formats.
- **Stall after a material graph install.** In loaded scenes the first frame
  after any graph install waits 0.7–1.5 s (Sponza) to 5–6 s (Bistro), although
  the install itself takes about 5 ms. The same wait delays some later edits by
  about 2 s without a compile. The cause is not located.
- **Edits that add a pipeline feature recompile.** A graph edit that adds an
  opacity, normal, coat, emission, frame, UV1, transmission or metalness
  terminal changes pipeline constants and compiles once. Its cost is not
  measured.

## Additive capabilities

- **Multiple canvases.** `engine.createDisplay(canvas)` on WebGPU. WebGL
  contexts cannot share resources, so WebGL keeps a single display.
- **Several resident scenes.** `new Render(engine, {scene, camera})` would
  override the engine's scene and camera per render. Today one scene is
  resident on the GPU, and `engine.prepare(otherScene)` prepares CPU data only.

## Viewer

- **Device loss status.** Show device loss and recovery in the status bar,
  using the engine's `devicelost` event. The library already recovers.

## Decided against

- **A scene graph.** Path tracing consumes a flat instance list. Hierarchy stays
  in Three.js or the application, which computes each world `transform`.
- **Open material or light type extension.** Every new type needs shader support
  in both backends. Keep a closed set and maintain it through the internal
  field tables.
- **Loading the WebGPU core in `init()`.** It shrinks the static first chunk
  from 644 KB to 202 KB and starts the import 37–46% earlier, but the first
  frame does not change. The remaining code is needed by the synchronous
  `update()` (material packing, BVH preparation, change detection).
- **Further shader text compression.** After whitespace removal, renaming WGSL
  identifiers saves about 8 KB gzip and mangling `_` properties about 4.7 KB.
  Brotli is a deployment setting. Static asset size, such as OIDN weights, is
  not a target.
- **Automatic material graph baking.** Graphs are evaluated at runtime.
  Reconsider baking only if runtime evaluation cannot meet performance.
