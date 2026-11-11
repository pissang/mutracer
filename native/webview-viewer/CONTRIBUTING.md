# Native viewer contributor checks

The app shares WebEngine and the React UI with the web viewer. The
private NativeRenderHost subclasses the library data/settings containers but
replaces device initialization, commits, target execution, readback and display
export. No browser GPU is created. NativeSceneEncoder uses the generated v8
layout, material IDs and existing graph normalization. SceneChangeDetector
accepts its pending state only after host acknowledgement. Custom-protocol POST
and one-shot GET mailboxes carry scene deltas, pixels and large glTF manifests;
commands, settings and events use JSON. Wry requires its `linux-body` feature for uploads.

Local glTF imports retain geometry and decoded images in `model_import::Pool`.
The manifest carries the node tree, compact material/mesh records, bounds and
small texture previews. `nativeResources.ts` associates editable UI objects with
host identities; commits hydrate those references before entering the SDK.
Animation, browser-only codecs and remote resources keep the GLTFLoader path.
Import workers are serialized; superseded imports cannot replace a newer model
or reply into a recovered WebView document.

To compare the two glTF import paths without a window, set
`MUTRACER_NATIVE_GLTF_MODEL` to a local model and
`MUTRACER_NATIVE_GLTF_REFERENCE` to an external evidence directory. Run the ignored
`export_native_gltf_reference` Cargo test, then
`node native/validation/native-gltf-reference.mjs`, then the ignored
`native_gltf_matches_browser_import` test. Both descriptors render on the same
native backend at seed 0 and 64 spp. The fixture uses the authored camera and
lighting when present, otherwise a common fitted view and environment. It does
not time imports or exercise the window. Set
`MUTRACER_NATIVE_GLTF_NATIVE_ONLY=1` for a native-only smoke when the
JS reference cannot load the source; that result does not establish image parity.
Keep this GPU work sequential.

Build with `npm run native:viewer:build`. Direct Cargo iteration needs
`MUTRACER_AOT_ARCHIVE`, a separate `CARGO_TARGET_DIR` and
`MUTRACER_WEBVIEW_ASSETS` pointing at the build's `ui/` directory. Run
`cargo test --locked --manifest-path native/webview-viewer/Cargo.toml`.

For real-GPU scene comparisons, first run
`node native/validation/webview-scene-reference.mjs /absolute/evidence`, then
set `MUTRACER_WEBVIEW_REFERENCE` to that directory and run the ignored
`shared_web_scenes_render_with_native_engine` test. It uses GLTFLoader,
THREESync, MaterialX parsing, seed 0 and 16 spp on both native backends. The
browser uses seed 0; the SDK's ordinary default is 12345. Normal guide encodings
and accumulation precision differ; compare raw HDR and inspect residuals.
Keep GPU work sequential. `--evidence DIR` uses an ephemeral WebView session,
16 spp, saves the converged image/HDR and exits after two minutes. Use a real,
unlocked desktop for compositing and input; never unlock or change power settings.

## Manual platform validation

Record OS, WebView runtime, GPU/driver, backend, scale factors and package hash.
Keep evidence outside the checkout.

| Check | Windows / WebView2 | Linux / Wayland and X11 |
| --- | --- | --- |
| Startup | Run packaged app after relocation; no developer PATH or source files. Check WebView2 installation/missing-runtime message. Test DX12 and the optional Vulkan/DLSS build. | Install GTK 3 and WebKitGTK 4.1 >= 2.40. Test fresh Wayland and X11 sessions independently. Run the relocated package. |
| Composition | Confirm the native image is visible beneath the transparent UI, including floating controls, panel resize and window minimize/restore. | Confirm both the GTK controls and native wgpu viewport appear. Place side by side; resizing either window must not resize the other. Closing either must exit the app. |
| DPI | Test 100/150/200%, move between monitors, resize/maximize; check viewport bounds and picker coordinates. | Test fractional Wayland scaling and X11 scale changes; check viewport physical dimensions and mouse coordinates. |
| Input | Orbit, right-pan, wheel, orthographic zoom, click selection, focus picking, keyboard shortcuts and text editing. UI overlays must capture their own input. | Repeat directly in the native viewport. Confirm GTK keyboard/text/file dialogs and native pointer input remain responsive while rendering. |
| Features | GLB, external-resource glTF, MaterialX graph and heights, HDR+studio, animation, visibility/material undo, AOVs, OIDN/JNLM, export and export cancellation. | Same; also check binary POST uploads through WebKitGTK and large scenes above 128 MiB. |
| HDR | Enable HDR on an HDR-capable surface, then test an SDR display and moving the window between displays. Check reported capability/fallback and unchanged SDR PNG. | Check extended-linear-sRGB capability and SDR fallback under each compositor; record unsupported driver/compositor paths. |
| GPU | Change GPU/traversal; app restarts and scene cache restores. Optional DLSS: use matching SDK/runtime, check pinhole and animated scenes, history reset and OIDN fallback. | Change GPU/traversal where multiple adapters exist. Confirm software fallback and idle rendering after convergence. |
| Packaging | Verify MSVC CRT, DXC, all OIDN weights and notices; package should run without Node/Rust. Test offline startup. | Check system WebKitGTK dependencies, OIDN weights and notices, executable permissions and offline startup. |

The Windows cross-check on macOS needs Windows SDK headers and an MSVC-compatible
C++ environment; a missing `windows.h` is an environment block. Linux checks need
a Linux Rust target, system development libraries and a desktop to validate UI.

`--workflow-evidence DIR MODEL.glb` runs the real-window import, MaterialX, HDR,
studio, OIDN and independent-export workflow through WebEngine's public actions.
It writes `workflow.json` and per-stage captures, then exits. It is opt-in and
uses an ephemeral WebView session; it does not alter the normal app cache.

The internal `MUTRACER_VIEWER_BENCHMARK` JSON workflow supports `editOnly` for
material-edit first-sample timing and `captureScene` for compact scene, resource
reference and camera/settings replay artifacts. Rehydrate native references and
apply the captured host camera before SDK replay. Captures and RSS sampling can
perturb timings; use separate runs for acceptance benchmarks.

## Metal HWRT hang regression

`native/validation/hwrt-hang-regression.mjs` runs the captured chess scene at
4096 spp three times and the SanMiguel window replay at 724×744/256 spp five
times, each in a separate process. It also renders each input with Software,
rejects nonfinite/black images and traversal fallback, and compares successful
Hardware images against Software (relative RGB L1 below 0.1). It records wall
time per sample, errors and HDR/PNG outputs. This is a manual regression, not
part of hosted CI; successful runs alone do not establish a hang fix.

Build the current AOT archive and embedded UI first, then set the ordinary
`MUTRACER_AOT_ARCHIVE`, `MUTRACER_WEBVIEW_ASSETS` and viewer `CARGO_TARGET_DIR`.
Provide external captures and assets:

```sh
MUTRACER_HWRT_CHESS=/absolute/chess/gltf.bin \
MUTRACER_HWRT_SANMIGUEL=/absolute/sdk-window-replay/run1 \
MUTRACER_HWRT_MODEL=/absolute/sanmiguel.glb \
MUTRACER_HWRT_OUTPUT=/absolute/evidence/hwrt \
node native/validation/hwrt-hang-regression.mjs
```

Pass `chess` or `sanmiguel` as the script's optional argument to run one scene.
The SanMiguel directory contains `native-ui.bin` and `refs.json`; its descriptor
must already include the captured host camera. Keep other GPU tests stopped.
Metal execution-error checks are always active on these SDK-created devices;
`MUTRACER_NATIVE_COMMAND_STATUS=1` adds per-buffer logs and can change timing.
For focused isolation, run the ignored `hwrt_hang_replay` test directly with
`MUTRACER_HWRT_SCENE`, optional `MUTRACER_HWRT_MODEL`/`MUTRACER_HWRT_REFS`,
`MUTRACER_HWRT_OUTPUT`, `WIDTH`, `HEIGHT`, `SPP`, `BOUNCES`, `BATCH`, `CANDIDATES`,
`BEVEL`, `WAVELENGTHS` and `BACKEND=Hardware|Software`. Unset values use the chess
settings above, with eight samples per batch and Hardware traversal.
