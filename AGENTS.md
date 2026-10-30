# MuTracer contributor and agent guide

MuTracer is a browser path tracer published to npm as `@meimu/mutracer`. This file is for
people and coding agents changing the library. For using it, read
[`llms.txt`](./llms.txt) and [`docs/`](./docs).

## Layout

- `src/main.ts`: public API. `src/oidn.ts`: the `@meimu/mutracer/oidn` entry point.
- `src/Engine.ts`: device, committed scene/camera and shared resources.
- `src/Display.ts`: canvas, display settings and image export.
- `src/Render.ts`: independent accumulation, denoising and convergence.
- `src/scene/`: scene description classes (`Mesh`, `Geometry`,
  `OpenPBRMaterial`, lights, `Camera`, `Texture`).
- `src/renderer/`: backends. `WGPU*` files and `wgsl/` are WebGPU; `WebGL*`
  files and `glsl/` are WebGL 2. Both backends share the CPU-side packing
  (`MaterialTable`, `lightSampling`, `bvhAccel`, `prepareMeshBVH`).
  `bvh.worker.ts` and `staticBvhPreparation.ts` prepare static BLASes.
- `src/tinybvh/`: TinyBVH WebAssembly adapter and its checked-in `.wasm`.
- `src/util/`: loaders, Three.js conversion, geometry helpers.
- `examples/`: Vite examples (`npm run dev`). `tests/`: Vitest.
- `viewer/`: React test-drive app (`npm run viewer`). Its dependencies are
  devDependencies and never ship in the npm package.
- `site/`: home page of the deployed site (`npm run site`). `npm run build:site`
  builds it with the viewer and the examples into `dist-site/` for Cloudflare.
- `native/`: experimental Rust/C SDK (shared TypeScript AOT core, Rust/wgpu host)
  and standalone egui-wgpu viewer; usage starts at `native/llms.txt`, checks are
  in `native/CONTRIBUTING.md`.
- `LICENSES/`, `THIRD_PARTY_NOTICES.md`: third-party attributions.

## Checks

While iterating, run the affected test files and the typecheck for the area being
changed. `npm run test:related -- src/path.ts` selects library tests through static
imports; `npm run test:viewer:related -- viewer/src/path.ts` does the same for the
viewer. See [test selection and its limits](tests/README.md). Use explicit test
files for generators, file-based fixtures and other dependencies outside that graph.

Run the full checks below once the change is ready to commit. After a passing
check, rerun it only if its code, tests, dependencies or configuration change;
documentation-only edits do not require repeating code checks.

```bash
npm run typecheck
npm run typecheck:examples
npm run typecheck:viewer
npm run typecheck:site
npm test
```

`npm test` runs only library tests. For viewer changes, also run
`npm run test:viewer` (the independent suite in `viewer/tests/`, using source aliases
without requiring a prior library build).

For native iteration, use the [focused native checks](native/CONTRIBUTING.md#iteration)
before the final native validation.

`npm run build` checks the bundled distribution; `npm run build:lib` builds
`lib/` (the npm entry points) and copies the WebAssembly module.

Unit tests do not cover GPU output. For changes to shaders, sampling or
post-processing, render the examples (or a fixed-seed scene with a fixed
sample count) on a real GPU before and after, and compare
`render.readPixels('hdr')` pixels. Test both WebGPU and WebGL 2 (`?webgl`).

Run browser GPU tests, captures and benchmarks in headless Chrome
(`--headless=new`) with a temporary profile, so results do not depend on a
visible window, focus or an unlocked screen. Use a visible window only for checks
that need real presentation, such as native window and HDR surface tests.

Scale verification to the change. While iterating on display, denoising or
scheduling, run `npm run test:parity` and the affected tests only; run the complete
native gate once, before merging. Record performance measurements, but do not let
them block a change: sub-millisecond CPU frame timings are noisy, so treat a
regression as real only when it reproduces and the diff explains it. Classify
measurement noise and known flaky tests yourself and report the evidence instead
of stopping for confirmation.

## Site deployment

- `main`: `npm run deploy` publishes `mutracer` at `mutracer.meimu-studio.com`.
- `dev`: `npm run deploy:dev` publishes `mutracer-dev` at `mutracer-dev.meimu-studio.com`.
- The `mutracer-dev` Workers Builds connection watches only `dev` and runs
  `npm run deploy:dev`; leave its separate build command empty because Wrangler
  already runs the type checks and site build.

## Rules

- Exports from `src/main.ts` and `src/oidn.ts` are public contracts. Keep
  TSDoc with defaults on every public option. Treat renames or removals as
  breaking changes.
- Keep the two backends in sync: a material, light or sampling change usually
  needs both the WGSL and the GLSL implementation. WebGPU-only features must
  fail soft on WebGL.
- Uniform and storage layouts are shared between TypeScript packing and shader
  structs; update both and run the contract tests.
- Write tests for behavior and public contracts (packing, parsing, lifecycle,
  generated shader validity). Do not add tests that only restate source text.
- Prefer existing APIs from the standard library, the platform, wgpu or crates
  and packages already in the dependency tree over hand-written helpers. Do not
  add a new dependency only to replace a few lines.
- Use Three.js `GLTFLoader` with `THREESync` in examples and comparisons.
- Keep examples small: procedural or CC0 assets only, no large models.
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- Code adapted from another project needs a compatible license, a source
  comment, an entry in `THIRD_PARTY_NOTICES.md` and the license text in
  `LICENSES/`. Do not copy code from sources whose license does not allow
  redistribution under MIT.

## Rendering changes

- Keep correctness fixes even when the visual change is small.
- For an algorithm that both web and native implement, develop and evaluate it
  on web first. Port it to native only after the web version passes review and
  is merged, then validate native once against the merged web behavior. Do not
  port, test or run native gates while the algorithm is still being tuned.
- When matching a reference renderer or paper, treat the reference as the
  behavior contract: align data semantics, pass order, random streams,
  candidate counts, and scene and display settings before judging image
  quality. Diagnose the remaining mismatches instead of withdrawing a
  mechanism the reference uses.
- Removing a rendering algorithm or image-quality mechanism is a maintainer
  decision. Keep the implementation and the A/B evidence, report regressions,
  and leave the decision to the maintainer.

- Display composition, denoising order and scheduling changes must update
  `tests/fixtures/display-order.json` or `display-schedule.json`, both independent
  implementations and their execution/event tests. Run the real-GPU cross-backend
  image comparison with `npm run test:parity`. Set
  `MUTRACER_OIDN_DISPLAY_INPUT` to include the frozen highlight comparison; the
  command explicitly reports that check as skipped when unset. Do not introduce a shared runtime frame plan or decision layer.

## Documentation

- `README.md` is the overview, `docs/` holds the guides and `llms.txt` is the
  compact usage guide for coding agents. Keep `llms.txt` to one or two lines
  per topic with links into `docs/`.
- Document each behavior in one place and link to it elsewhere: scene update
  rules in `docs/updates.md`, BVH preparation in `docs/bvh.md`, options and
  defaults in TSDoc and `docs/api.md`.
- Order each guide as usage, options, then caveats.
- Native API reference lives on the declarations: the C headers in
  `native/include/` and the Rust `///` comments in `native/host/src/` give each
  call's and field's options, defaults, ranges, errors, ownership and thread
  rules. `native/docs/` covers only workflows, behavior that spans several calls,
  and costs and limits; it names the symbols instead of restating their details.
  `native/docs/scene-format.md` stays the descriptor layout and validation
  reference.
- User-facing documentation (READMEs, `docs/`, `llms.txt` and public API comments)
  covers only behavior, usage, costs and limits that affect user decisions. Put
  internal implementation, maintenance and release details in code comments,
  commit bodies or contributor guides.
- Review edited documentation passages separately, including retained text;
  remove details that do not affect usage and briefly report the review.
- Keep reusable documentation in `docs/`. Do not commit dated experiment logs
  or scene-specific evidence there.

## Multi-session tasks

- Keep multi-stage tasks moving. When an item stalls, record what was tried
  and the evidence, then continue with the next item. Collect unresolved items
  and report them together at the end, so the maintainer can decide how to
  proceed.
- A task split across several sessions keeps one progress file beside its plan
  in `plans/`. It is a snapshot of the current state, not a log. It holds only:
  the status of each task with its commit, the remaining work in order, open
  problems and known limitations with their evidence locations, the
  maintainer's current decisions, fixed references (worktree, branch,
  hardware, reference commits), and the handoff the next session needs, each
  written once. Keep it within 150 lines and 15,000 characters.
- When a session ends, rewrite the affected entries in place. Do not append
  per-session narratives, restate rules or authorizations, or keep superseded
  state or withdrawn decisions.
- Put process details, failed attempts, command output, per-image numbers,
  checksums and the reasoning behind each result in that session's evidence
  directory outside the repository, as named by the plan, and link to it from
  the progress file. Durable conclusions belong in `docs/` or the plan.
- A new session reads this file, the plan and the progress file, then starts.
  It looks up evidence directories or archived records only for the specific
  item it needs.

## Commit messages

- Keep the subject concise. Use the body when needed to explain the problem,
  resulting behavior, implementation decisions and reasons for the change.
- For viewer changes, include the `viewer` scope in the commit subject, for
  example `fix(viewer): correct camera controls` or `feat(viewer): add model search`.
- Do not include validation sections, check commands, test counts, pass/fail
  summaries or documentation-review notes in commit messages. Report verification
  in the task reply or evidence files instead.
