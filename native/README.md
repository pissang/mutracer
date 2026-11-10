# MuTracer native SDK

An experimental Rust and C SDK for the MuTracer path tracer, plus a standalone
glTF viewer. It renders with wgpu and needs no JavaScript engine or Node at
runtime. It covers a subset of the browser library's features. The APIs and the
C ABI can change between versions.

## Platforms

| Platform | GPU API | Status |
| --- | --- | --- |
| macOS arm64 (14.0+) | Metal | Supported; GPU rendering verified |
| Linux x64 | Vulkan | Supported; hardware-specific behavior and performance unverified |
| Windows x64 | DX12 or Vulkan | MSVC SDK, Software/HWRT rendering and packaged viewer verified on RTX 4060; strict image-parity issues remain |

[Built-in denoising](docs/denoising.md) supports oidn-webgpu on the rendering GPU
and optional OIDN with a caller-supplied runtime.

## Native viewer

`npm run native:viewer` builds and opens a standalone glTF/GLB viewer. See
[viewer downloads, controls and limits](viewer/README.md).

## APIs

| Task | Rust (`mutracer_native`) | C header | Guide |
| --- | --- | --- | --- |
| Build, edit or import a scene | `scene_api::Scene` | `mutracer-scene-api.h` | [Scenes](docs/scene.md), [glTF](docs/gltf.md) |
| Render offline or interactively | `api::{Engine, Render, RenderLoop}` | `mutracer-engine.h` | [Engine](docs/engine.md) |
| Tone map, export, add effects, present to a window | `api::Display` | `mutracer-engine.h` | [Display](docs/display.md) |
| Denoise renders or your own images | `Render::set_denoiser`, `CustomDenoiser` | `mutracer-engine.h`, `mutracer-denoise.h` | [Denoising](docs/denoising.md) |
| One low-level accumulation with polling jobs | — | `mutracer-context.h` | [Context](docs/context.md) |
| Read or write binary scene descriptors | `Scene::descriptor` | `mutracer-scene.h`, `mutracer-scene-builder.h` | [Scene format](docs/scene-format.md) |

Most applications build a Scene and render it with an Engine. The API reference
is on the declarations: the headers in [`include/`](include) and the Rust doc
comments in [`host/src/api/`](host/src/api) and
[`host/src/scene_api/`](host/src/scene_api) give every option, default, error
and lifetime. The guides cover workflows and behavior across calls.

## Build and link

The crate is now `mutracer-native` (Rust `mutracer_native`), replacing
`mutracer-native-probe` (`mutracer_native_probe`); C consumers link `mutracer`
instead of `mutracer_native_probe`. The CMake target names are unchanged.

### Precompiled C SDK

Extract the SDK archive for your OS and CPU architecture, then set
`CMAKE_PREFIX_PATH` to its root. You need CMake 3.20+ and a C compiler; Node,
npm, scriptc and Rust are not required.

```cmake
cmake_minimum_required(VERSION 3.20)
project(my_renderer LANGUAGES C)
find_package(MuTracer CONFIG REQUIRED)
add_executable(my_renderer main.c)
target_link_libraries(my_renderer PRIVATE MuTracer::mutracer)
```

```sh
cmake -S . -B build -DCMAKE_PREFIX_PATH=/path/to/MuTracer-SDK-VERSION-PLATFORM
cmake --build build --config Release
```

Use `MuTracer::mutracer_static` for static linking, including its system library
dependencies. The extracted SDK can be moved without regenerating its CMake
files. For shared linking, distribute the shared library with your application.
On Windows, compile with `/MD` and place the package's `lib/*.dll` beside your
executable or add that directory to `PATH`.

### Build from source

Requirements: Node with the project's npm dependencies, stable Rust, a C++20
compiler and scriptc 0.4.4 from `native/toolchain`. Windows also needs the
[MSVC toolchain setup](CONTRIBUTING.md#windows). Linux shared SDK builds also
require patchelf.

```bash
npm ci
npm ci --prefix native/toolchain --include=optional
export MUTRACER_SCRIPTC="$(node native/toolchain/compiler.mjs)"
npm run native:scene:static
```

The build writes the core archive to `.native-build/scene-core/render-core.lib.a`
(`render-core.lib` on Windows) and native libraries to
`.native-build/scene-core/cargo-target/release/`, and runs CPU-only checks.
Set `MUTRACER_NATIVE_OUTPUT` to use another directory.

- **Rust**: depend on the `mutracer-native` crate in `native/host` by path,
  and set `MUTRACER_AOT_ARCHIVE` to the archive's absolute path when building.
  The default `gltf` feature provides [glTF import](docs/gltf.md). With the
  same variable set, `cargo doc --no-deps --manifest-path native/host/Cargo.toml --open`
  builds and opens the Rust API reference.
- **C**: add `native/include` to the include path and link the shared library
  `mutracer`:

```bash
LIB="$PWD/.native-build/scene-core/cargo-target/release"
cc -I native/include native/examples/minimal-host.c -L "$LIB" \
  -lmutracer -Wl,-rpath,"$LIB" -lm -pthread -o minimal-host
```

## Quick start

Build a scene, render 8 samples and read linear HDR pixels:

```rust
use mutracer_native::{api, scene_api::{Geometry, Mesh, OpenPbrMaterial, Scene}};

let mut scene = Scene::new();
let geometry = scene.add_geometry(Geometry::new(
    vec![-1., -1., -3., 1., -1., -3., 0., 1., -3.], vec![0, 1, 2],
))?;
let mut material = OpenPbrMaterial::default();
material.values.emission_strength = 1.; // The default scene has no light.
let material = scene.add_material(material)?;
scene.add_mesh(Mesh::new(geometry, material))?;

let engine = api::Engine::new(Default::default())?;
let render = api::Render::new(&engine, api::RenderSettings {
    max_samples: 8,
    size: api::RenderSize::Fixed { width: 64, height: 48 },
    ..Default::default()
})?;
engine.set_scene_object(&scene)?;
engine.update()?;
render.converge(api::ConvergeOptions::new(8))?;
let hdr = render.read_pixels(api::PixelKind::Hdr)?;

// Edit the scene and commit again.
scene.material_mut(material)?.values.roughness = 0.6;
engine.set_scene_object(&scene)?;
engine.update()?;
```

The same in C:

```c
#include "mutracer-scene-api.h"
#include <stdio.h>
#include <stdlib.h>
#define CHECK(call) do { if ((call) != MT_OK) { fprintf(stderr, "%s\n", error); exit(1); } } while (0)

int main(void) {
  char error[1024];
  const float positions[] = {-1, -1, -3, 1, -1, -3, 0, 1, -3};
  const uint32_t indices[] = {0, 1, 2};

  mt_engine_options engine_options;
  mt_engine_options_default(&engine_options);
  mt_engine engine;
  CHECK(mt_engine_create(&engine_options, &engine, error, sizeof error));
  mt_render_options options;
  mt_render_options_default(&options);
  options.width = 64; options.height = 48; options.max_samples = 8;
  mt_render render;
  CHECK(mt_render_create(engine, &options, &render, error, sizeof error));

  mt_scene scene;
  CHECK(mt_scene_create(&scene, error, sizeof error));
  mt_scene_geometry_desc geometry;
  mt_scene_geometry_desc_default(&geometry);
  geometry.positions = positions; geometry.vertex_count = 3;
  geometry.indices = indices; geometry.index_count = 3;
  mt_scene_geometry_id g;
  CHECK(mt_scene_add_geometry(scene, &geometry, &g, error, sizeof error));
  mt_scene_material_desc material;
  mt_scene_material_desc_default(&material);
  material.emission_strength = 1;
  mt_scene_material_id m;
  CHECK(mt_scene_add_material(scene, &material, &m, error, sizeof error));
  mt_scene_mesh_desc mesh;
  mt_scene_mesh_desc_default(&mesh);
  mesh.geometry = g; mesh.material = m;
  mt_scene_mesh_id object;
  CHECK(mt_scene_add_mesh(scene, &mesh, &object, error, sizeof error));

  CHECK(mt_engine_set_scene_object(engine, scene, error, sizeof error));
  CHECK(mt_engine_update(engine, NULL, error, sizeof error));
  mt_converge_options converge;
  mt_converge_options_default(8, &converge);
  CHECK(mt_render_converge(render, &converge, NULL, error, sizeof error));
  size_t bytes;
  CHECK(mt_render_read_pixels(render, MT_IMAGE_HDR, NULL, 0, &bytes, error, sizeof error));
  float *hdr = malloc(bytes);
  CHECK(mt_render_read_pixels(render, MT_IMAGE_HDR, hdr, bytes, &bytes, error, sizeof error));

  free(hdr);
  CHECK(mt_scene_destroy(scene, error, sizeof error));
  CHECK(mt_engine_destroy(engine, error, sizeof error));
  return 0;
}
```

## Examples

| File | Shows |
| --- | --- |
| [examples/scene-api-host.c](examples/scene-api-host.c) | Scene handles, glTF import and engine rendering |
| [examples/engine-host.c](examples/engine-host.c) | Engine, render and render loop |
| [examples/minimal-host.c](examples/minimal-host.c) | Descriptor builder with the context API |
| [examples/job-host.c](examples/job-host.c) | Polling jobs and cancellation |
| [examples/denoise-host.c](examples/denoise-host.c) | Standalone OIDN denoiser |
| [examples/window-host.c](examples/window-host.c) | C window presentation (macOS glue in `window-appkit.m`) |
| [viewer/examples/surface.rs](viewer/examples/surface.rs) | Rust window and HDR presentation |

`npm run native:engine`, `native:context` and `native:jobs` build the C hosts and
check them on the validation scenes; they need a GPU and are described in the
[contributor guide](CONTRIBUTING.md#commands).

## C API conventions

- Every call returns `MT_OK` (0) or a nonzero `mt_status` from
  [mutracer-status.h](include/mutracer-status.h). Branch on the code, not the
  message, and treat unknown nonzero codes as failures. Retry `MT_ERROR_BUSY`;
  after `MT_ERROR_BUFFER_TOO_SMALL`, allocate the reported size. Rust returns
  `api::Error` with the matching `api::Status`.
- The optional `error`/`capacity` buffer receives a truncated, NUL-terminated
  UTF-8 message.
- Records start with `struct_size`. Initialize them with their `*_default()`
  function before editing fields; other sizes are rejected and reserved fields
  must be 0.
- Pass a NULL destination with size 0 to query a required size.
- Inputs are copied during the call. The library keeps only callback user data.
- Pixel readback is linear RGBA32F. Engine images are top row first; context
  images and custom denoiser inputs are bottom row first.
- Thread rules differ by API: see [engine](docs/engine.md#threads-and-callbacks)
  and [context](docs/context.md#threads).
- Validation and preparation errors keep the current scene.
  `MT_ERROR_CONTEXT_FAILED`, including a caught Rust panic, marks a context
  failed until a successful commit or destruction; a failed scene object must be
  destroyed and recreated. Allocation failure and aborts terminate the process;
  use process isolation if you need to recover. Rust's panic hook can still
  print diagnostics.
- Library logs are silent by default. `mt_set_log_callback`
  ([mutracer-log.h](include/mutracer-log.h)) receives diagnostics and optional
  profiling messages serially on the emitting thread, including library
  threads. Messages are valid only during the callback, which must not call the
  library. Unregistering waits for a running callback.

## C ABI versions

The C ABI is experimental and can change between versions. `MT_ABI_VERSION`
increases whenever a C declaration or record layout changes incompatibly.
When loading a library dynamically, resolve and call `mt_abi_version()` first;
reject the library if it differs from the `MT_ABI_VERSION` you compiled against.

The archive name, `MT_SDK_VERSION` in `mutracer-version.h` and the CMake package
version follow the native Rust crate version, independently of the ABI number
and the browser library's version. A package version alone
does not establish ABI compatibility. Versioned `find_package` requests accept
only the exact package version. After `find_package(MuTracer CONFIG REQUIRED)`,
read `MuTracer_ABI_VERSION` to check the package's ABI at configure time; the
runtime check is still needed when dynamically loading a library.

## Ray tracing backends

Engines (`backend` engine option) and contexts (`mt_context_create_with_backend`)
default to hardware ray tracing (HWRT); software BVH traversal is the
alternative. Unsupported devices and acceleration-structure limits or
allocation failures fall back to software. `Render::backend` /
`mt_render_info` and `mt_context_backend` report the path actually used and
the fallback reason. Metal HWRT requires macOS 15.0+ and a compatible GPU;
macOS 14 uses software traversal.

HWRT supports alpha materials, bevel, displacement and affine instances.
Acceleration structures add build time and memory; any speedup depends on the
scene and hardware. Coplanar or overlapping surfaces can resolve to different
triangles in the two backends.

Known issue: with Metal HWRT, a sample can occasionally see an empty scene or
fail to accumulate without reporting an error. It has been observed at small
render sizes while other applications use the GPU. It can cause an abnormal
preview frame, a small bias in offline images and byte-level differences between
runs; it is not detected or retried. For reproducible output, render twice and
compare. Software rendering can also lose samples during GPU recovery.

## Limitations

- [Differences from the browser library](docs/engine.md#differences-from-the-browser-library).
- Device loss is terminal; there is no automatic recovery.
- Display and denoising output can differ from the browser library.
- Displacement color and normal output can differ between the two backends.
- [Scene size, count and texture limits](docs/scene-format.md#limits).
