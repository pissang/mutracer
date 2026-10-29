# Tests

```bash
npm test                                          # full library suite
npm test -- tests/unit/geometry.test.ts             # one file
npm run test:related -- src/scene/Geometry.ts        # static import dependents
npm run test:watch -- tests/unit/geometry.test.ts    # keep the test runner open
npm run test:viewer:related -- viewer/src/engine/fetchWithProgress.ts
```

- `unit/`: scene primitives, geometry helpers, BVH construction, light and
  material packing, sampling, shader-cache keys, WGSL validity of generated
  shaders, renderer lifecycle and denoiser setup.
- `integration/`: bundled-library behavior and standalone assets.

Use focused checks during iteration and the full suites before committing
(see [required checks](../AGENTS.md#checks)). Related-test selection follows
static imports. It cannot discover dependencies read from disk or evaluated by
custom loaders, including the shader formatting fixtures; run
`npm test -- shaderSourceFormatting shaderFormattingBuild shaderIdentifiers`
when changing shader generation or its build transforms. Changes to test
configuration or shared build tooling require the full suite. A related run
with no matching tests fails so it cannot be mistaken for validation.

Tests run in Node without a GPU. They check behavior and contracts, not image
quality. Check GPU output separately by rendering the examples, or a fixed
scene with a fixed sample count, before and after a change (see
[`AGENTS.md`](../AGENTS.md#checks)).

`npm run dev` also serves [`gpu/jnlm.html`](./gpu/jnlm.html). Open
`http://localhost:3001/tests/gpu/jnlm.html` in a browser with a real WebGPU
adapter. It runs the actual WebGPU and WebGL 2 denoising passes on deterministic
fixtures, checking noise reduction, bright and dark texture contrast, normal
detail, and coverage edges. These tests are separate from the Node test suite.

[`gpu/progressiveRendering.html`](./gpu/progressiveRendering.html) measures ten
preview/final round trips after warming both targets. It counts WebGPU
`createTexture` / `createBuffer`, or WebGL `createTexture` / `createFramebuffer`
with `?webgl`, and records `presentedTarget` / `presentedComplete` per frame.
Preview resolution is held fixed during this probe; adaptive preview rebuilding
is checked separately. The reusable `measureProgressiveSwitches` helper can also
be run against each example's scene and camera. HDR equivalence requires a
separate fixed-resolution, fixed-spp `render.converge` / `render.readPixels('hdr')`
comparison against pixels captured before a refactor.

Use small generated fixtures; do not commit models or images for tests.

[`gpu/shaderSource.html`](./gpu/shaderSource.html) exposes
`shaderSourceTests.capture(layout, postProcess)` for before/after comparisons.
It uses four OpenPBR layer materials, four background configurations, Sobol
sampling with sequence offset 17 and 8 samples. Pass `true` for `postProcess`
to include bloom/JNLM output and 48×32 → 30×20 → 48×32 scratch reuse; append
`?webgl` to select WebGL 2. Capture results include HDR pixels, denoised pixels,
depth queries and renderer compilation diagnostics. Compare each backend and
layout against its own baseline.

MNEE/SMS live in `src/research/mnee/` and never enter release artifacts.
Tests and research scripts import `registerMnee` and `mneeDiagnostics` from its `index.ts`, then call `registerMnee()` before creating renders.
