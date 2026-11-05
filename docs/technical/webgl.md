# WebGL 2 backend

The WebGL 2 backend runs the same path tracer as fragment shaders. It is the
fallback where WebGPU is unavailable, so it favors working everywhere over speed.
This note lists the constraints that shape it and the open issues known to
contributors. Feature differences visible to users are documented with each
feature.

## Constraints

- **Texture units.** WebGL 2 guarantees 16 fragment texture units. Per-vertex
  attributes (normals, UVs, tangents, colors, material indices) share one
  interleaved RGBA32F texture, positions keep their own for triangle tests, and
  instance records follow the BVH in its texture. `webglSamplerBudget.test.ts`
  keeps every trace pass at or below 14 referenced samplers, leaving two for new
  features. Add a sampler only after checking that budget.
- **Uniforms.** Large scenes can exceed `MAX_FRAGMENT_UNIFORM_VECTORS` (1024 on
  common devices) and fail to render. The renderer does not yet fail soft there.
- **Path length.** `bounces` and path events stop at 20 on WebGL, and Intel Macs use
  a shorter event limit. WebGPU allows 50.
- **Compilation.** ANGLE defers native compilation, so a first draw can block for
  seconds, much longer than WebGPU. Trace programs request parallel compilation
  and are polled before use. Per-program timings do not measure that program's
  compile time.
- **Timing.** Timer queries can report totals longer than the wall-clock time and
  cannot drive scheduling or performance claims. Tiles are sized from wall-clock
  feedback; see [tile scheduling](./tiling.md). Measure WebGL performance by wall
  time until the HDR readback completes.
- **WebGPU-only features.** Caustic estimators, display post-processing,
  display-resolution AOVs and custom denoisers fail soft on WebGL. Caustic paths
  fall back to path tracing, so the expected image is unchanged.

## Open issues

- **Background in some scenes.** On at least one scene, WebGL terminates many
  paths at depth 0 or on a miss where WebGPU continues, and part of the background
  renders black. Primary-miss and environment behavior should be aligned before
  WebGL is used as a cross-backend reference for such scenes.
- **Long single draws.** With dispersion, one fragment invocation traces all three
  channel suffixes ([shared prefixes](./continuous-spectrum.md#shared-prefixes)).
  Large renders with a single tile have lost the context, likely from a GPU
  timeout. Options are to size tiles for three times the work or to fall back to
  three draws on large images.
- **Context loss.** Some driver failures lose the context and later reads return
  zeros. Treat an all-black WebGL capture as a failed run, not a result.

## Changing this code

- Implement material, light and sampling changes in both WGSL and GLSL; see
  `AGENTS.md`.
- Run GPU comparisons headless, one context at a time. When a WebGL capture fails
  with context loss, rerun it before drawing conclusions, and do not compare its
  output.
