# Native contributor guide

This guide covers building, validating and maintaining the native SDK and viewer.
Per-call and per-field API details belong on the declarations (C headers and
Rust doc comments); workflows, behavior across calls, costs and limits belong in
[README.md](README.md) and [docs/](docs). License notices are separate for the
[native library](THIRD_PARTY_NOTICES.md) and the
[viewer](viewer/THIRD_PARTY_NOTICES.md).

## Layout

- `src/`: TypeScript AOT entry points, runtime adapters and shader generators.
- `host/src/`: Rust library; `host/diagnostics/`: CI probe executables and
  shaders.
- `include/`: public C headers; `schemas/`: frozen wire-property IDs and error
  codes.
- `docs/`: user guides and the scene format reference.
- `scripts/`: compiler lowering, contract generators, CI and viewer packaging.
- `examples/`: C consumers and validation hosts; `tests/`: AOT fixtures and the
  C module test harness.
- `validation/`: render and contract checks and browser reference tools;
  `validation/compiler/` holds whole-browser-API and async compilation probes.
- `viewer/`: standalone app; `toolchain/`: pinned compiler; `LICENSES/`:
  license texts.

## Setup

```bash
npm ci
npm ci --prefix native/toolchain --include=optional
export MUTRACER_SCRIPTC="$(node native/toolchain/compiler.mjs)"
export MUTRACER_NATIVE_OUTPUT=/absolute/evidence/directory
```

- Use scriptc 0.4.4, Rust with locked dependencies and a C++20 compiler. Root
  Web dependencies do not include the compiler; `toolchain/compiler.mjs`
  resolves the platform package and restores its executable permissions.
- Keep `MUTRACER_NATIVE_OUTPUT` outside the checkout.
- For direct Cargo builds, run `npm run fetch:tinybvh` to
  [prepare the headers](../src/tinybvh/CONTRIBUTING.md#preparing-headers) and
  set `MUTRACER_AOT_ARCHIVE` to the built archive.
- **Use separate `CARGO_TARGET_DIR` values for the `host` and `viewer`
  manifests.** Their different wgpu feature graphs can otherwise overwrite the
  host's unhashed multi-crate-type rlib and produce incompatible wgpu crates.
- Run rustfmt before committing Rust.

### Windows

Windows builds use the x64 MSVC Developer environment, Windows SDK, Rust's
`stable-x86_64-pc-windows-msvc` toolchain and Zig 0.15.2 for scriptc's archiver.
C/C++ consumers compile with `/MD`; no MinGW CRT or GCC C++ runtime is linked.

The scriptc 0.4.4 runtime pack still imports several GNU-compatible interfaces.
`windows-msvc-archive.mjs` edits only MuTracer's generated COFF archives: it
maps constructor sections to `.CRT$XCU`, uses MSVC's stack probe, and prefixes
runtime compatibility imports to avoid collisions with the independently linked
OIDN core. An appended, MSVC-compiled `windows-msvc-compat.c` object implements
those imports with UCRT and Win32. The installed runtime pack remains unchanged.

### Linux

Linux builds need a C++20 compiler, patchelf for the shared SDK, and the X11/Wayland
development libraries installed by the CI workflow. GPU package checks also
need `xvfb-run`.

### Optional DLSS viewer

The Windows viewer's `dlss-rr` Cargo feature compiles an application adapter over
the native SDK's public `CustomDenoiser` and `TemporalGpu` APIs. Default builds
do not load NGX or require NVIDIA files. Use SDK/runtime 310.9.16 from the
[official DLSS repository](https://github.com/NVIDIA/DLSS); headers, loader and
runtime must belong to the same SDK version. NVIDIA's SDK license applies to
the optional binary components separately from MuTracer's MIT source.

In the x64 MSVC developer environment, set the ordinary native build variables
above, then run:

```powershell
$env:MUTRACER_DLSS_SDK = 'C:/SDK/DLSS'
$env:MUTRACER_DLSS_RUNTIME = 'C:/SDK/DLSS/lib/Windows_x86_64/rel'
$env:MUTRACER_VULKAN_INCLUDE = 'C:/VulkanSDK/Include'
$env:MUTRACER_NATIVE_OUTPUT = 'C:/build/mutracer-dlss'
node native/scripts/dlss-build.mjs
```

`MUTRACER_NGX_LIBRARY` optionally overrides the default
`lib/Windows_x86_64/x64/nvsdk_ngx_s.lib` loader path. The script builds a separate
MSVC shim DLL, the feature-enabled viewer and the local app directory, including
the NVIDIA runtime and its license. It does not download SDK files. The regular
viewer packaging command does not create DLSS packages.

The build checks the pinned loader/runtime SHA-256 values and writes
`dlss-build.json` with binary and adapter-source hashes.

Run `mutracer-viewer.exe --dlss-smoke C:/evidence/rr` from the produced app for a
headless GPU check through the same custom filter, result publication and Display
path. Add `--dlss-preset D` to test the older model. Set `MUTRACER_DLSS_LOG=1` for
verbose NGX diagnostics. This check does not establish glass or animation quality;
inspect fixed-sample images separately.

## Commands

| Command | GPU | Checks |
| --- | --- | --- |
| `npm run native:ci` | No | Rust CPU suites, C picking consumer, AOT module/storage contracts and `native:scene:static` |
| `npm run native:ci:gpu` | Yes, with ray queries | `native:ci` plus GPU tests and packaged-app checks; run before a native release |
| `npm run native:ci:hosts` | Yes, with ray queries | `native:ci:gpu` plus the C hosts at 8 samples |
| `npm run native:scene` | Yes | Builds the AOT archive and library; verifies preparation and rendering on 33 fixtures |
| `npm run native:scene:static` | No | The same build with descriptor, packet, resource and WGSL contracts, without rendering |
| `npm run native:context`, `native:jobs`, `native:camera`, `native:settings`, `native:engine` | Yes | One C host each: retained scenes, polling and cancellation, camera updates, render settings, engine API |
| `node native/validation/scene-api-render.mjs` | Yes | C ABI, selected adapter, scene handles, exact AOV readback and custom-filter snapshots |
| `node native/validation/vulkan-render.mjs` | Yes | C Vulkan device negotiation/import, queue/image leases, host copies, post-processing and retirement, on Software and HWRT |
| `npm run native:modules:verify`, `native:storage:verify` | No | AOT module and storage contracts |
| `node native/validation/matrix-verify.mjs`, `vector-verify.mjs` | No | Precision checks |
| `npm run native:viewer:build` | No | Full AOT graph and platform app |
| `npm run native:viewer:dev` | Yes | Interactive viewer with Subsecond UI hot reload |
| `npm run native:viewer:package` | No | Archives the app, extracts it elsewhere and checks the sample and linked denoising runtime |
| `npm run native:viewer:package -- --gpu` | Yes | Also checks rendering, all AOVs and real-window startup |
| `npm run native:sdk:package` | No | Packages the SDK and checks C linking |
| `npm run native:check` | No | Compiler capability probe; reports the incomplete browser API port and exits with status 1 |

- The host commands build on `native:scene`, and `native:engine` chains the
  other four. Each rebuilds and rerenders its whole chain; prefer the focused
  checks below during local iteration.
- Before final native review, run the root typechecks, library and viewer tests,
  `npm run build` and the applicable native CI gate below. `native:ci` already
  runs both Rust CPU suites, `native:modules:verify` and `native:storage:verify`;
  do not repeat those separately on unchanged inputs. Compilation does not
  validate GPU output.

### Iteration

With `MUTRACER_AOT_ARCHIVE` set to a current built archive and separate persistent
host/viewer Cargo targets, run the affected Rust tests directly:

```sh
cargo test --locked --manifest-path native/host/Cargo.toml --lib TEST_FILTER
cargo test --locked --manifest-path native/viewer/Cargo.toml TEST_FILTER
```

Set `CARGO_TARGET_DIR` to the appropriate target before each command. Reuse it
across edits instead of creating a fresh target for each check. A changed AOT
input requires rebuilding the archive before testing its consumers. For a
compile-only check use `cargo check`; a subsequent `cargo test` already checks
compilation, so running both on unchanged inputs is unnecessary.

Run an affected GPU test directly with `-- --ignored --nocapture` while iterating
on rendering. Keep GPU work sequential. Run the applicable full `native:ci`,
`native:ci:gpu` or `native:ci:hosts` gate for the completed change; repeat it after
changes to inputs it validates, rather than after every intermediate edit.
Filtered Rust tests do not replace the final AOT, C consumer or GPU validation.

### Focused regression runs

Run `npm run test:parity` for browser WebGPU/WebGL and native display images,
execution traces and schedule events. Set `MUTRACER_PARITY_OUTPUT` outside the
checkout and `MUTRACER_OIDN_DISPLAY_INPUT` to the frozen HDR/guide directory to
include the frozen highlight comparison; without it, the command explicitly
reports that item as skipped. The command builds the native archive; it accepts
the ordinary host `CARGO_TARGET_DIR` for reuse.

Use `node native/scripts/ci.mjs --only host-tests --gpu-tests 'display|jnlm'
--batch-gpu-tests` with an existing `MUTRACER_AOT_ARCHIVE` and host
`CARGO_TARGET_DIR` during iteration. `--only` and `--skip` select comma-separated
step names; `--gpu-tests` selects ignored host tests by regular expression.
Batch mode shares a process and is intended for focused tests. Subset reports
always leave `validated` false. Run the complete gate once at final review.

`node scripts/reference-capture.mjs capture COMMIT` caches fixed inputs and
browser/native outputs by commit; `compare COMMIT` captures the current checkout
and reports byte and float differences. Set `MUTRACER_REFERENCE_CACHE` outside the
checkout and `MUTRACER_OIDN_DISPLAY_INPUT` to the frozen HDR/guide directory.
`node scripts/reference-performance.mjs COMMIT` measures active CPU frames and
live JS heap after forced GC. It expands from one to three rounds when active
CPU frame time increases by both more than 3% and more than 0.05 ms/frame, or
when live JS heap increases by more than 3%. Submillisecond CPU frame times are
sensitive to timer precision, so a relative threshold alone can report false
regressions.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `MUTRACER_SCRIPTC` | scriptc 0.4.4 executable |
| `MUTRACER_DX` | dx 0.7.10 executable for [UI hot reload](#ui-hot-reload) |
| `MUTRACER_NATIVE_OUTPUT` | Output and evidence directory |
| `MUTRACER_AOT_ARCHIVE` | Archive for direct Cargo builds |
| `MUTRACER_NATIVE_SAMPLES` | Fixture sample count; byte comparisons across stages need the same count and seed |
| `MT_LOOP_ITERATIONS`, `MT_LOOP_BATCHED`, `MT_LOOP_L0`, `MT_LOOP_REAL_CAP` | [HWRT loop test](#metal-hwrt-sample-miss) |
| `MUTRACER_TEST_CAPTURE` | Saves mismatching AOVs, descriptors and per-pixel audits |
| `MUTRACER_TEST_ADAPTER` | Explicit adapter index for `scene-api-render.mjs` and Rust AOV GPU tests; enumerate with the `adapter-validation` host example |
| `MUTRACER_VULKAN_INCLUDE` | Vulkan SDK include directory for `vulkan-render.mjs`; otherwise uses `VULKAN_SDK/Include` |
| `MUTRACER_OIDN_LIBRARY` | Optional external OIDN for Rust SDK tests |
| `MUTRACER_TEST_OIDN_CUDA`, `_HIP`, `_NO_GPU` | [OIDN backend requirements](#oidn) |
| `MUTRACER_KERNEL_FIXTURES` | [Native kernel](#shared-source-and-typed-resources) byte comparisons |
| `MUTRACER_NATIVE_PROFILE=1` | [Preparation profile](#performance) on stderr |
| `MUTRACER_GLTF_EVIDENCE` | glTF material fixture and native values for `validation/gltf-material-reference.mjs` |
| `MUTRACER_ANIMATION_EVIDENCE` | Animation test fixtures, poses, images and report |
| `MUTRACER_TEST_VULKAN_LIBRARY` | Optional Vulkan driver/loader library for the interop GPU test |
| `MUTRACER_VIEWER_METRICS` | [Real-window viewer metrics](#viewer) |
| `MUTRACER_NATIVE_GUI_SMOKE=1` | Same as `native:viewer:package -- --gpu` |

## CI and releases

`native:ci` validates CPU behavior and static shader contracts without creating
a GPU device. Rust's default suites ignore device-dependent tests; the CPU suite
still parses, validates and emits SPIR-V/HLSL with Naga for the generated
software and hardware WGSL. Reports mark GPU rendering and windows as
**not validated**. Finding a software adapter cannot turn CPU checks into a
rendering gate.

`native:ci:gpu` adds the ignored host GPU tests, animated-pose rendering, all 33
rendered fixtures, ray-query execution, the `viewer/examples/surface.rs` window,
HDR negotiation and lifecycle smoke, and the packaged render/AOV and
window-startup checks. Software or unknown adapters and missing ray-query
support are errors. GitHub-hosted CI does not run it.

- Each ignored host test runs in its own process. Other failures stop CI after
  all ignored tests finish.
- On hardware Metal, the known image mismatches in
  `hardware_renders_match_fresh_l0_contexts`,
  `hardware_shared_scene_renders_match_fresh_l0_contexts` and
  `hardware_loop_against_fresh_l0_contexts` are reported without stopping CI
  and leave `gpu.validated` false.
- The incremental oracle reports full-reference render errors as skipped cases;
  any skip leaves `gpu.validated` false. Review those records before a release.
- `native:ci:hosts` reuses the GPU run's fixtures, archive and Cargo target. C
  engine HWRT differences are counted in `gpu.cHosts.hardwareDifferences`, leave
  `gpu.validated` false, and keep per-fixture records and logs in `hosts/`.
- The engine host compares every image with a fresh context in the same
  process: Software must match byte for byte; HWRT differences are counted in
  `engine-verification.json`.
- CPU-only module and viewer builds run beside the GPU steps; step durations are
  recorded in `checks.json`.

The GitHub Actions `CI` workflow runs on pull requests, pushes to `main` and
`dev`, and manual dispatch. It validates CPU and static contracts and builds the
SDK and viewer for macOS arm64, Linux x64 and Windows x64, including oidn-webgpu
and licenses.

- Artifacts `native-macos-arm64`, `native-linux-x64` and `native-windows-x64`
  hold the app and SDK archives and SHA-256 checksums for 14 days;
  `native-PLATFORM-symbols` holds the separate SDK debug material for 14 days;
  `native-PLATFORM-diagnostics` keeps logs and check summaries for 7 days,
  including failed runs.
- Manual dispatch builds all three platforms by default (`release`);
  `native_platform` selects one for diagnosis and never publishes a release.
- Pushing a `native-v*` tag (for example `native-v0.1.0`) runs the same checks
  and, after the Web and native jobs pass, publishes the macOS and Linux
  app, SDK and separate symbol archives and checksums to that tag's GitHub
  Release. Tags with a suffix such as `-rc.1` create prereleases. Native
  releases never become the repository's latest release, and rerunning a tag
  replaces matching assets. Publishing uses
  `GITHUB_TOKEN` with `contents: write`.
- The macOS app is ad-hoc signed and not notarized.

### SDK release artifacts

After `native:ci`, run `native:sdk:package` with the same
`MUTRACER_NATIVE_OUTPUT` and its `CARGO_TARGET_DIR=.../host-target`.
For `native:scene:static` outputs, the default `.../cargo-target` applies.
`MUTRACER_NATIVE_DIST` selects the archive destination. Packages contain C headers
and shared/static libraries; debug symbols are archived separately in
`sdk-symbols/`. Packaging checks API availability and C linking without a GPU;
rendering still requires `native:ci:gpu` validation.

## Architecture

### Runtime, ownership and errors

- C context and job calls may come from any thread. Short registry operations
  serialize, and overlapping calls may return busy. A full commit builds its
  candidate outside the registry lock, so the old scene keeps rendering and
  polling.
- A process-wide dedicated worker owns the AOT runtime and its preparation
  roots. Copy AOT results before reset or collection, and initialize the module
  once. There is no dynamic-unload shutdown for that worker.
- A commit token identifies cancellation and publication. Cancel drains the
  current preparation step; destroy waits until the candidate's roots and
  resources retire. A candidate keeps its GPU resources until publication, and
  rejection preserves the old scene, settings and samples. Publication cancels
  and drains old render work. Incremental updates reject active jobs and pending
  full commits.
- Handles are monotonic, with no fixed context cap. Two resource generations
  and at most 32 pipeline variants coexist; keep commits transactional when
  changing that retention.
- TS errors carry an operation code and message in a bounded UTF-8 packet that
  Rust validates. Caught Rust panics mark the touched context failed while
  guards stay alive, avoiding poisoned locks; a successful full commit recovers.
  AOT OOM and abort traps terminate the process.
- Logs go through `mutracer-log.h` and are silent by default; standalone Rust
  tools enable stderr logging explicitly.

### Public headers and layouts

`include/` is the supported C API, except `mutracer-debug.h`, which holds
validation-only entry points. The layout generator writes caller-facing
descriptor offsets to `include/mutracer-layout.h`, and host records, resource IDs
and shader layouts to the uninstalled `src/mutracer-internal-layout.h`. The
hand-written structs in `include/mutracer-scene.h` assert their offsets against
the generated header, so a schema change that resizes a record or moves a
checked field fails to compile until the structs and `docs/scene-format.md` are
updated.

### Shared source and typed resources

Production rendering accepts only version-4 raw descriptors. The
validation-only Web oracle records writes through
`validation/resource-recorder.mjs`; production never reads those captures.

Shared TypeScript owns scene decoding and assembly, material, light and
environment packing, render settings, layouts, shader generation and
incremental preparation. The host uses typed resource IDs, texture formats,
layout entries and pipeline keys.

- JNLM shaders and pass uniforms share `../src/renderer/wgsl/jnlm.compute.ts`.
  `src/jnlm-core.ts` exposes them through AOT; Rust binds resources and dispatches
  the passes. Native CI runs `validation/jnlm-shaders.mjs` to compare complete
  JS/AOT packets and defaults.
- After schema edits, update `scripts/generate-layout-schema.mjs`; its `--check`
  runs with typecheck.
- Material wire IDs in `schemas/material-properties.json` are frozen. Regenerate
  with `scripts/generate-material-properties.mjs` without renumbering.
- `scripts/storage-lowering.mjs` instantiates numeric generics and nested
  closures without changing arithmetic or control flow;
  `scripts/attribute-lowering.mjs` lowers proven concrete accesses;
  `scripts/vector-lowering.mjs` specializes shared math storage. The
  numeric-access report traces the production graph and rejects loop storage
  dispatch. Open unions, ordinary arrays and callbacks keep fallback
  implementations. Keep emitted compiler inputs separate from browser source.
- Bounds, generated tangents and compact vertex packing have Rust kernels.
  TS owns layouts and the triangle-material plane; compact packing uses the
  validated Rust descriptor and writes the final Rust attribute resource.
  Geometries that need generated normals or tangents, and incremental writes, retain the
  shared TS packer. Workers only access Rust-owned slices and join before
  publication. Tangent normalization uses compiled TS `Math.hypot` to keep
  rounding; compact encoding preserves f64 arithmetic and JS half-tie rounding.
  `MUTRACER_NATIVE_COMPACT=ts|serial|parallel` selects the preparation diagnostic
  path (default `parallel`, up to 12 available CPU threads for large inputs).
  With `MUTRACER_KERNEL_FIXTURES=/absolute/manifest.json`, host tests compare
  kernel packets and production resources with compiled TS byte for byte. The
  `compact_large_scene_production_assets_match_ts` test accepts a local
  GLB in `MUTRACER_COMPACT_MODEL` and reports a skip when unset. Qualify kernels
  on complex scenes and the same concrete specialization, not only procedural
  fixtures.
- The optional MaterialTable whole-module probe has known compiler blockers;
  all 14 required modules must build and verify.

### Engine API

The Rust `api` module commits each engine's scene once to a scene-only L0
context through the crate-internal `CommitPath`: incremental on the calling
thread, full preparation on a library thread. Each render's context owns a
`Target` linked to that scene (`context::set_target`), with camera and trace
uniforms from `sceneTargetParameters`, its own accumulation and, for another
sampling pattern or bevel sample count, its own shader variant. Standalone L0
contexts use the same `Target` execution and readback paths. Every scene
publication drains linked targets and sets them again.

Rust context operations and C wrappers share `with_registry`: `try_lock` reports
Busy and platform-scoped panic handling keeps the guard alive. An unclassified
execution error that newly fails a touched context reports ContextFailed;
explicit error statuses remain unchanged. Only C wrappers encode
statuses and bounded error strings. Full commit publication retains its blocking
lock after preparation, so publication and cancellation keep their ordering.

Tests compare every render's HDR, normal and albedo with a fresh L0 context
given the same overridden descriptor, settings and sample count, byte for byte
on Software. The HWRT variant is `--ignored` while the
[Metal sample miss](#metal-hwrt-sample-miss) is open. With
`MUTRACER_OIDN_LIBRARY` set, converged OIDN is compared with direct CPU
filtering of the same inputs.

### Incremental preparation

The staged TS adapters reuse the original camera math, material repacking,
environment distributions, light PMFs and emissive caches. Acknowledge candidate
state only after layout validation and GPU upload or reset. Transform and vertex
edits must use the latest accepted source state; reject unsupported shape or
shader-stack changes with a full-commit requirement. Keep shared tuple storage
when scriptc copies Map-indexed records.

### HWRT

HWRT uses authoritative hardware hits. Assert the actual backend after every
commit; a software fallback never counts as hardware success. All
acceleration-structure build paths submit BLASes and wait for completion
**before encoding TLAS construction**, because Metal's indirect instance
descriptors and empty HAL barriers make one encoder insufficient. This wait has
not fixed the [sample miss](#metal-hwrt-sample-miss). `PreferUpdate` is not a
refit; HAL refit stays opt-in and must keep its thread and resource lifetime
assumptions.

### TinyBVH

Raw scene commits and transform/vertex TLAS updates use the official TinyBVH
headers pinned in `src/tinybvh/upstream.json` (1.9.1, the same revision as Web;
all six cached headers are unmodified). The host compiles the browser's C++
wrapper directly. Keep pointer-width-safe result addresses and
`-ffp-contract=off` for conservative float bounds. See the
[adapter contributor guide](../src/tinybvh/CONTRIBUTING.md) for Wasm rebuilds
and CWBVH conversion.

- Native builds enable ARM NEON/Bonsai construction and upstream workers, with
  aligned float4 vertices kept through serialization. Web uses its scalar Wasm
  build and browser worker pool. Spatial splits are off natively, matching the
  browser default. Small BVHs stay on the calling thread.
- Stable-topology BLAS refits still use the TS `updatePreparedGeometries`; the
  TS SAH builder remains for browser fixtures and legacy stateless AOT
  comparison exports.
- The synchronous AOT steps return geometry, displacement and AABB jobs, keep
  source state across arena resets, and consume the host's BVH2 results.
- The 1.9 process-wide worker pool survives host threads and joins at shutdown.
  On Windows, a generated header copy skips pool cleanup after DLL process
  termination has stopped the other threads; static-executable teardown and
  explicit shutdown still join. Native CI checks DLL exit without a GPU.
- The license belongs in `native/LICENSES/` and is copied into the app bundle.

Check host exit, explicit shutdown, restart and process exit with
ThreadSanitizer:

```sh
c++ -std=c++20 -O1 -g -fsanitize=thread -ffp-contract=off \
  -I "$(node scripts/fetch-tinybvh.mjs)" native/host/tinybvh.cpp \
  native/tests/tinybvh-thread-exit.cpp -o /tmp/mutracer-tinybvh-thread-exit
TSAN_OPTIONS=halt_on_error=1 /tmp/mutracer-tinybvh-thread-exit
```

Compare native and Wasm builds on identical inputs, including degenerate
triangles and every displacement projection. SIMD/Bonsai and scalar builds can
choose different trees: validate primitive identity, conservative bounds and GPU
output, and compare bytes only between matching builder configurations. Full
and incremental results must agree on HDR, normal and albedo, survive failed
candidates and other contexts, and keep the HWRT identity mapping after TLAS leaf
reordering. Switching builders can change leaf order, packed displacement
heights and output; archive those differences rather than claiming pixel parity.

### Viewer

#### UI hot reload

After the [native setup](#setup), install the matching Dioxus CLI and start the
development viewer from the repository root:

```sh
cargo install dioxus-cli --version 0.7.10 --locked
npm run native:viewer:dev
```

Save UI function or layout edits to update the open window. Successful UI patches
keep the loaded model, camera, accumulated samples and GPU resources. The command
also wakes a converged viewer when a patch arrives. Compilation errors leave the
previous code running; fix the error and save again.

Pass a model path to open it at launch, including paths with spaces:
`npm run native:viewer:dev -- "/absolute/path/my model.glb"`. Add `--port 9012`
to choose the devserver port; otherwise dx chooses an available local port.
`MUTRACER_DX` selects an existing dx executable. Its version must be 0.7.10,
matching the pinned Subsecond and devtools crates.

The command prepares the AOT core once at startup and uses a separate development
build in `.native-build/viewer-dev/`. `MUTRACER_NATIVE_OUTPUT` changes that directory;
`CARGO_TARGET_DIR` overrides its Cargo cache. It finds the bundled scriptc unless
`MUTRACER_SCRIPTC` is set. `MUTRACER_AOT_PREBUILT` reuses an archive you have already
built from the current AOT inputs.

Subsecond is experimental. Patching covers the viewer binary's UI call chain
rooted at `Viewer::panels`; startup code and dependency crates are outside it.
Stop the command before changing state struct layouts, then relaunch: existing
state is not migrated to a new layout. Relaunch for SDK, TS/AOT or GPU setup
changes as well. Development-only hot reload is disabled in release builds.

#### Implementation

`npm run native:viewer:build` builds the full AOT graph and app with locked
dependencies. eframe/egui-wgpu and tracing share one adapter, device and queue.
`src/display-shader.ts` generates the display WGSL through the Web generator;
`scripts/generate-display.mjs --check` detects stale output.
Bloom and OIDN preparation use the shared TS shader generators through AOT,
like JNLM; `native/validation/postprocess-shaders.mjs` compares the complete JS
and AOT packets. Native stores no independent Bloom/OIDN WGSL copies.
The primary-surface fields live in `src/renderer/sceneLayoutSchema.ts`; the existing
layout generator emits the Rust record and all field-offset/type assertions.
The trace hook and AOT resolve generator use that same schema. Solar position
and studio placement/ambient math also use TS through the existing AOT runtime;
host clock and callback scheduling remain local Rust adapters.
The examples catalog is `viewer/src/engine/model-presets.json`, shared by both
viewers. `scripts/generate-sky.mjs` emits the shared sky WGSL and
`scripts/generate-viewer-spheres.mjs` converts the web procedural example; both
support `--check` and run in the root typecheck and native app build.

- Preview capture, tone mapping, denoising and presentation stay on the GPU;
  export reads pixels back.
- The viewer renders through `api::Engine::on_device`, a `RenderLoop` with its
  default preview, and the engine `Display`. Descriptor assembly and full
  preparation run off the UI thread.
- New input waits until the selected channel's batch in flight is collected and
  shown (`Render::collect`) and while a full preparation runs, so held edits
  keep updating without cancelling preparations.
- Native queue submissions pause outside the UI callback so eframe can
  reconfigure the shared surface; CPU preparation continues.
- The immutable picking BVH is built on a worker while a model loads. Autofocus
  uses it, with no GPU readback or alpha-texture inspection.
- The viewer uses the published `oidn-webgpu-native = 0.2.0` Rust crate on the
  rendering device. Cargo verifies and links its bundled platform core; no
  upstream checkout, planner build or private FFI is needed. The adapter follows
  `native/README.md` upstream: load a Model, create a checked Denoiser, prepare
  host buffers, then encode into the host's command encoder. `denoise.rs` and
  `mt_denoiser_*` retain the optional caller-supplied OIDN SDK path.

## Validation

Keep raw images, failure samples, hashes, logs and experiment reports outside
the repository.

### GPU output

Compare fixed-seed HDR, normal and albedo on real GPUs for both browser backends.
Use the independent high-sample Software reference for image statistics. When
statistics exceed the gate, find the first differing hit and path event; report
edge and tie cases and reject unexplained differences. Displacement random
streams depend on traversal order.

### Context, jobs and incremental commits

- `native:camera` compares six camera records on every fixture.
- `native:jobs` checks queued, running, cancelling, cancelled and completed
  states, completed-sample accounting, stale handles and accumulation
  equivalence. Poll submits at most one bounded batch and never waits for the
  GPU; callbacks only update owned completion flags.
- Test arbitrary calling threads, cancel and destroy during preparation, failed
  commit rollback and continued rendering of the previous scene.
- Use ThreadSanitizer and state which Rust/C++ dependencies it instruments; AOT,
  Metal and OIDN are outside that coverage.

### Viewer

The ignored `all_shared_examples_download_and_import` test downloads and imports
both catalogs. Set `MUTRACER_VIEWER_CACHE` outside the checkout; optionally filter
with comma-separated `MUTRACER_EXAMPLE_IDS` and write results to
`MUTRACER_EXAMPLE_EVIDENCE`. The ignored
`catalog_views_and_authored_lighting_render_on_both_backends` test writes images
and a report to `MUTRACER_EXAMPLE_RENDER_EVIDENCE`.

`viewer_panels_examples_and_debug_use_the_shared_gpu_image` renders the actual
egui panels offscreen and checks loading, camera selection, output switching,
preview disabling and overlay gestures. Set `MUTRACER_VIEWER_UI_EVIDENCE` for its
screenshots. This test does not establish OS-window input or presentation;
`--startup-smoke` and the surface example still require an unlocked desktop.

The packaged executable accepts these smoke modes. GPU modes require actual
HWRT where noted and compare against fresh contexts on Software and HWRT.

| Flag | Checks |
| --- | --- |
| `[MODEL] --package-smoke DIR` | Portable CPU package |
| `--startup-smoke REPORT.json` | Opens a window, resizes it and presents frames; the report must confirm success |
| `[MODEL] --smoke-out DIR` | Load and render, editing, cancellation, HDR environments, backend assertions and native denoising (actual HWRT) |
| `--interaction-smoke DIR` | Continuous camera and held edits, retained previews, resize, stale-denoise rejection |
| `--material-smoke`, `--environment-smoke`, `--light-smoke`, `--transform-smoke`, `--geometry-smoke DIR` | Incremental commits against full preparation |
| `--parity-smoke DIR` | Camera and render settings against fresh contexts, retention after edits and backend replacement, display controls, transparent PNG, denoising alpha and guide channels |
| `--texture-smoke DIR` | All nine S/T wrap combinations and negative, zero and large repeats (needs an imported texture) |
| `--texture-editor-smoke DIR` | Shared material presets; upload, replacement, removal and sampling of all nine slots, including displacement scale and bias |
| `--studio-smoke DIR` | Rect lights against `node native/validation/viewer-studio-reference.mjs DIR` output; preset and parameter edits |
| `--focus-smoke DIR` | Autofocus against `node native/validation/viewer-focus-reference.mjs DIR` output: depth clusters, focus pulls, opaque geometry, stale queries, misses, manual overrides, orthographic views, all three AOVs, invalid input, rollback |
| `[MODEL] --edit-bench DIR` | Descriptor build and commit times of material, transform, camera, light and environment edits at 1280×720 on both backends, through a bare L0 context (`"path": "l0"`) and the engine (`"path": "l1"`), in `edit-bench.jsonl` |

The packaging script sets `MUTRACER_NATIVE_GPU_VALIDATION=1` only in its GPU
mode. Run the ignored `live_polyhaven_catalog_and_texture_download` test to
check the live Poly Haven service, and the ignored animation test with the
archive and viewer Cargo target configured:

```sh
cargo test --release --locked --manifest-path native/viewer/Cargo.toml \
  gpu_animated_poses -- --ignored --nocapture
```

It compares animated HDR, normal and albedo with fresh scenes on Software and
actual HWRT, then exercises playback, pause, seeking and clip switching.

Headless smokes do not cover file dialogs, panel changes, orbit/pan/zoom/fit,
pause/restart, resolution/exposure and PNG export; check those in the real
window. `MUTRACER_VIEWER_METRICS=/absolute/result.json` runs a 1280×720
real-window interaction and three-full-commit sequence, reports UI, picking and
frame intervals, and closes. Use the LEGO model, keep the Mac unlocked and
thermally nominal, and keep outliers.

To validate a package, copy the app to a new location and run all demo models
and Sponza without Node or build paths; inspect dependencies, licenses and the
signature.

### OIDN

Check CPU, Metal, CUDA, HIP and Auto; malformed inputs; rollback; in-place
output; and arbitrary calling threads. Set `MUTRACER_OIDN_LIBRARY` for the Rust
SDK tests.

- `MUTRACER_TEST_OIDN_HIP=1` (or `_CUDA=1`) on a supported machine requires that
  backend to run and asserts it.
- To require CPU fallback and explicit GPU rejection, set
  `MUTRACER_TEST_OIDN_NO_GPU=1` with `OIDN_DEVICE_METAL=0`,
  `OIDN_DEVICE_CUDA=0` and `OIDN_DEVICE_HIP=0`, and leave the GPU requirement
  flags unset.

### Robustness

Caught TypeScript exceptions must keep their operation code and message across
the packet boundary; test with the actual AOT archive, not JavaScript alone.

### C window consumer

On macOS, build the host cdylib with the current archive and run the C consumer
(AppKit glue is in `examples/window-appkit.m`):

```sh
node native/scripts/window-host.mjs /absolute/libmutracer_native_probe.dylib \
  /absolute/scene-input.bin /absolute/evidence/c-window
```

It opens a real window, presents through the C SDK and checks suspension,
resize, detach and reattach, clear and reload, diagnostics, callbacks and final
callback release. It needs an unlocked desktop and does not cover the Windows
and Linux handle paths; keep its report separate from the Rust surface gate.

## Performance

`MUTRACER_NATIVE_PROFILE=1` reports validation, source preparation, BLAS/TLAS,
composition, GPU setup and pipeline time (a subset of setup). Full-commit wall
time also includes flush, publication and retirement. Timestamp profiling is
separate from formal timing:

- Metal pass timestamps measure kernels. Acceleration-structure
  `completedWallMs` is wall time after earlier uploads drain, not a GPU
  timestamp. Invalid or missing timestamps produce a diagnostic and a missing
  measurement; rendering continues.
- Upload payload counts come from the write calls, separate from buffer
  capacity and acceleration-structure storage.
- Native peak RSS and the browser JS heap are different metrics.
- `nativeGeometryKernelProfile` separates kernel bodies; its time is already
  part of preparation.

Full scene preparation uses up to 12 CPU threads for independent geometry checks
and bounds scans. Validation switches at 131,072 vertices plus indices to scan;
bounds switches at 131,072 vertices. Single-geometry inputs remain serial.
Validation reports the first error in descriptor order, and each bounds reduction
retains its vertex order. `MUTRACER_NATIVE_GEOMETRY_SCANS=serial` selects the serial
path for same-binary performance comparisons.

Run the viewer with `MODEL_OR_FOLDER --load-profile-out /absolute/evidence/load`
to measure a real async drop over an already rendered scene, then replacement
with the bundled model. `MUTRACER_SCENE_BACKEND=0|1` selects Software or HWRT
(default 1). At 96×64 and 8 samples, the headless probe writes receive/tick
durations, loading states, first-image time, replacement/destruction time and
HDR/normal/albedo captures.
It measures the viewer's loading path; window event delivery and presentation
need a separate real-window check. `MUTRACER_NATIVE_PROFILE=1` also splits viewer
scene assembly from descriptor encoding.

### glTF import profiling

`MUTRACER_NATIVE_PROFILE=1` reports attribute reads, local/world bounds, index
validation and initial deformation separately, with bulk-copy byte counts and
bounds worker counts. `MUTRACER_NATIVE_GLTF_ATTRIBUTES=reader` selects the gltf-rs
reference reads; the default copies aligned contiguous F32 Vec2/3/4 accessors
directly into Arc slices and retains Reader for other layouts. Local bounds run
on up to 12 available CPU threads for large imports; each geometry retains its
vertex reduction order. `MUTRACER_NATIVE_GLTF_BOUNDS=serial` selects the original
in-visit scan. World bounds retain the tight per-vertex transform scan.

`nativeDecodeProfile` separates buffer loading, meshopt, source-buffer retirement,
quantized attribute expansion, document validation and image decoding. Meshopt
writes independent, aligned views directly into their final buffers and uses up
to 12 available CPU threads above 1 MiB decoded data. Layouts with overlapping
targets, source/target dependencies or unaligned destinations retain the scratch
reference path. `MUTRACER_NATIVE_MESHOPT=legacy` selects that reference;
`serial` selects direct writes on one thread; the default enables parallelism.
Run `optional_large_asset_decoded_buffer_oracle` with `cargo test --release` and
`MUTRACER_MESHOPT_ORACLE=/absolute/model.glb` to compare complete decoded buffers
against the reference; unset means skip. Compare these modes in the same binary
and measure CPU-only import peaks separately from GPU upload/setup peaks.

Run `large_local_import_matches_reader_when_requested` with `cargo test --release`
and `MUTRACER_GLTF_IMPORT_ORACLE=/absolute/model.glb` for a local-asset bit/bounds
comparison; it reports a skip when unset. Keep large assets out of the debug
suite, and run performance comparisons separately from builds and other checks.

## Metal HWRT sample miss

A Metal HWRT sample can occasionally see an empty scene or fail to accumulate
without an error. On an Apple M4 Max with macOS 27.0.1 it has been seen at 8×8
and 96×64 while other GPU users, including ordinary background apps, are
active; about 620,000 dispatches at 1920×1080 over three hours, mostly under
extra GPU load, showed none, which does not rule it out elsewhere. It predates
incremental commits and also reproduces in a standalone wgpu program with two
live BLAS/TLAS pairs and alternating bindings. A persistent residency set and
the BLAS wait before TLAS construction have not fixed it. Keep such probes
outside the repository and distinguish resource lifetime changes from
residency.

Run the interleaved geometry and full-commit diagnostic with the linked archive:

```sh
cargo test --manifest-path native/host/Cargo.toml --lib \
  changed_blas_and_tlas_are_ready_after_interleaved_retained_edits -- --nocapture
```

It prints AOV and primary-hit coverage classifications and reports a mismatch
separately from the other checks.

To reproduce repeated full-preparation failures, run the ignored loop with the
archive and a separate host Cargo target:

```sh
MT_LOOP_ITERATIONS=2000 MT_LOOP_BATCHED=1 cargo test \
  --manifest-path native/host/Cargo.toml --lib \
  hardware_loop_against_fresh_l0_contexts -- --ignored --nocapture
```

- It fails on HDR, normal or albedo mismatches and records each sample's primary
  hits, missing writes and sequence counts on both sides, reading the history
  after each render without changing the batch's GPU submissions.
- `MT_LOOP_ITERATIONS` must be a positive safe integer (CI uses 200).
  `MT_LOOP_L0=1 MT_LOOP_REAL_CAP=1` selects a direct L0 control with one sample
  per job poll and the real Sobol cap.
- `MUTRACER_TEST_CAPTURE` saves mismatching AOVs, descriptors and per-pixel
  audit records to a directory outside the checkout.
- Use independent processes and keep hit classifications and per-sample query
  parameters. A stop-at-first-failure count is not a failure rate, and a
  zero-failure run does not establish a fix. Revisions from before incremental
  commits reject the later padded transform packet; record any adaptation.

### oidn-webgpu release integration

The Rust adapter uses only the crate's documented Model, Denoiser,
PreparedDenoise and wgpu APIs. Build with the ordinary host/viewer Cargo locks;
Cargo handles the bundled core. To exercise the native GPU path with the linked
AOT archive and host Cargo target configured:

```sh
cargo test --release --locked --manifest-path native/host/Cargo.toml --lib \
  oidn_webgpu -- --include-ignored --nocapture
```

These checks compare accumulated GPU inputs with CPU HDR normalization followed
by a direct Rust API call, preserve alpha and retained output, and exercise
progressive/every-sample schedules, resizing, target replacement and device loss.
The viewer's relocated `native:viewer:package -- --gpu` gate also runs denoising
and real-window startup. Windows uses the same Rust runtime through its MSVC core. Hosted Windows CI
checks compilation and CPU contracts; it does not establish GPU correctness.
CPU CI excludes the optional image oracles even when WARP/llvmpipe is available;
`native:ci:gpu` runs them and requires a hardware adapter.

For the browser release, serve `tests/gpu/oidnNativeIntegration.html` and run
`captureOIDNRelease()` in its console, then repeat with `?webgl`. It exercises
Small, Standard and Clean Aux Large with local weights, checks GPU errors and
confirms that filtering leaves fixed-seed raw HDR unchanged. It does not replace
same-input output comparisons between runtimes.

The 0.1.1 dependency propagated its install name or ELF SONAME into downstream
cdylibs; 0.2.0 scopes those linker arguments to its own cdylib.
`finalize-host-library.mjs` still verifies and sets MuTracer's identity after
the host build in the scene/CI drivers, using
install_name_tool plus ad-hoc signing on macOS and patchelf on Linux.
After a direct Cargo shared-library build, call
`finalizeHostLibrary(CARGO_TARGET_DIR)` from that module before linking C
consumers. Rust rlib consumers and the statically linked viewer do not need it.


## Vulkan C interop validation

Linux/Windows include the Vulkan bridge in ordinary builds; the ignored interop
GPU test is part of `native:ci:gpu`. On macOS, compile that same bridge explicitly
with `--features vulkan-interop` and set `MUTRACER_TEST_VULKAN_LIBRARY` to a Vulkan
portability driver's library, for example a local MoltenVK dylib. With the AOT
archive and separate host Cargo target configured:

```sh
cargo test --locked --manifest-path native/host/Cargo.toml --features vulkan-interop \
  --lib external_vulkan_device_images_and_native_post_process -- --ignored --nocapture
```

The test creates the host instance/device from the C requirements, imports them,
checks queue/image leases, copies an image with host Vulkan commands across a
render resize, and exercises native plus Rust display passes, failure rollback
and retirement notifications. A portability-driver pass does not validate
Linux/Windows drivers or Vulkan HWRT. C callers also need their Vulkan SDK headers
when including `mutracer-vulkan.h`; the ordinary headers do not require them.

## glTF material comparison

Set `MUTRACER_GLTF_EVIDENCE` outside the checkout and run the host CPU test
`gltf_browser_reference_fixture`. After `npm run build:lib`, run
`node native/validation/gltf-material-reference.mjs EVIDENCE_DIRECTORY` to compare
24 scalar/color fields and ten texture bindings with GLTFLoader/THREESync.
Node substitutes decoded pixels for the two known 1×1 PNGs; it still uses the
actual loader extension handlers and browser material conversion. The comparison
records the deliberate volume thin-wall difference separately. Run the ignored
`gltf_layers_render_and_retained_texture_edit_match_full` test on a real GPU to
compare HDR, normal and albedo after extension texture edits with full preparation.

## Scene picking consumer

`native:ci` builds and runs `native/examples/scene-picking.c` without a GPU. For a
direct rerun, set `CARGO_TARGET_DIR` to the built host target and
`MUTRACER_NATIVE_OUTPUT` outside the checkout, then run
`node native/validation/scene-picking.mjs [PATH_TO_LAYERS_GLTF]`. The optional path
uses the fixture from `gltf_browser_reference_fixture` to check glTF C import and
picking together. Rust picking tests additionally compare 500 rays with an
independent double-precision brute-force oracle over transformed triangles.

## AOV integration checks

The scene API C host in `native:ci:hosts` compares explicit descriptor IDs with
scene-handle IDs, verifies AOV readback, and compares each C custom-filter depth
and uint32 ID snapshot with vertically flipped engine readback. It asserts the
actual render backend on both Software and HWRT. A direct rerun uses
`node native/validation/scene-api-render.mjs` with the release host target and an
external output directory configured.

The ignored `gltf_layers_render_and_retained_texture_edit_match_full` test also
checks AOV beauty preservation, stable imported IDs and reflectance invalidity
for unsupported glTF layers. The Vulkan interop test enables depth/ID outputs,
checks readback exclusion during an image lease, and reads them after release.
