# Native third-party notices

The native library is part of MuTracer under the repository [MIT License](../LICENSE).
Shared renderer attributions are in the [repository notices](../THIRD_PARTY_NOTICES.md).
The native viewer has [separate notices](./viewer/THIRD_PARTY_NOTICES.md).
Native-specific license texts are in [LICENSES/](./LICENSES).

## Windows toolchain runtime

Windows native builds use the Microsoft UCRT and MSVC C++ runtime. MuTracer's
original UCRT/Win32 compatibility bridge provides the interfaces imported by the
scriptc 0.4.4 runtime pack; it does not link MinGW CRT or GCC's C++ runtime.
The separately licensed scriptc runtime remains covered by its upstream notices.

## wgpu native ray-query probe

The experimental `native/host/diagnostics/ray-query-probe.wgsl` follows ray-query API usage
from the [wgpu v30.0.1 ray-traced triangle example](https://github.com/gfx-rs/wgpu/blob/v30.0.1/examples/features/src/ray_traced_triangle/shader.wgsl),
modified into analytic hit/miss, mask, distance and instance checks.
Copyright (c) 2025 The gfx-rs developers. MIT License
([`LICENSES/Wgpu-MIT.txt`](./LICENSES/Wgpu-MIT.txt)).


## TinyBVH native builder

The native builder uses the official
[jbikker/tinybvh](https://github.com/jbikker/tinybvh/tree/c9be3103cc9693b456b0a0353927c11cac7d710f)
1.9.1 headers at commit `c9be3103cc9693b456b0a0353927c11cac7d710f`, shared with the
browser Wasm builder. File hashes are in
[`src/tinybvh/upstream.json`](../src/tinybvh/upstream.json).
Copyright (c) 2024-2026 Jacco Bikker / Breda University of Applied Sciences.
MIT License ([`LICENSES/TinyBVH-MIT.txt`](./LICENSES/TinyBVH-MIT.txt)).
`host/tinybvh.cpp` reuses `src/tinybvh/tinybvh_wrapper.cpp` for native builds
and adds the AABB-input bridge used for instances.
Windows builds adapt the process-exit hook in a generated header copy to avoid
joining worker threads during DLL process termination. The verified cached
headers remain unmodified.

## Native OIDN loader

The shared native library/viewer adapter loads Open Image Denoise through
[libloading 0.8.9](https://github.com/nagisa/rust_libloading/tree/0.8.9),
Copyright © 2015 Simonas Kazlauskas, ISC License
([text](./LICENSES/Libloading-ISC.txt)). The library caller supplies the OIDN
runtime. The viewer uses the oidn-webgpu Rust runtime described below.

## Vulkan host interop

The Vulkan C bridge uses [ash 0.38.0](https://github.com/ash-rs/ash/tree/0.38.0%2B1.3.281),
Copyright (c) 2016 ASH, under the MIT License
([text](./LICENSES/Ash-MIT.txt)).

## Native glTF codecs

The native SDK glTF feature uses [meshopt-rs 0.6.2](https://github.com/gwihlidal/meshopt-rs)
(MIT, Copyright 2018 Graham Wihlidal;
[license](./LICENSES/Meshopt-rs-MIT.txt)) and its bundled
[meshoptimizer 0.25](https://github.com/zeux/meshoptimizer/tree/v0.25)
(MIT, Copyright 2016-2025 Arseny Kapoulkine;
[license](./LICENSES/Meshoptimizer-MIT.txt)) for Meshopt decoding.
WebP decoding uses [image-webp 0.2.4](https://github.com/image-rs/image-webp)
under MIT ([license](./LICENSES/Image-webp-MIT.txt)). These codecs do not ship in
the npm library. The licenses accompany the native SDK and app.


The importer and scene API also use these MIT-licensed Rust libraries:

- gltf 1.4.1: MIT ([license](./LICENSES/gltf-1.4.1-MIT.txt)).
- image 0.25.8: MIT ([license](./LICENSES/image-0.25.8-MIT.txt)).
- base64 0.22.1: MIT ([license](./LICENSES/base64-0.22.1-MIT.txt)).
- percent-encoding 2.3.2: MIT ([license](./LICENSES/percent-encoding-2.3.2-MIT.txt)).
- glam 0.30.9: MIT ([license](./LICENSES/glam-0.30.9-MIT.txt)).

## oidn-webgpu native runtime

The native host links
[oidn-webgpu-native 0.2.0](https://github.com/pissang/oidn-webgpu/tree/native-v0.2.0/native)
Rust crate. Project-owned code is MIT, Copyright (c) 2024 pissang
([text](./LICENSES/OIDNWeb-MIT.txt)). Its bundled core also contains the scriptc
runtime (Apache-2.0), V8-derived radix conversion (BSD-3-Clause), and Ryū object
code (BSL-1.0). The [upstream notice](./LICENSES/OIDNWebGPU-NOTICE.txt),
[scriptc license](./LICENSES/OIDNWebGPU-scriptc-Apache-2.0.txt), and
[V8 conversion license](./LICENSES/OIDNWebGPU-v8-BSD-3-Clause.txt) accompany the SDK
and viewer. Ryū's license exempts object code from reproducing its text.
The embedded `rt_hdr_alb_nrm` model is from
[OIDN weights](../oidn/weights/README.md), Apache License 2.0
([text](./LICENSES/OIDN-weights-Apache-2.0.txt)).

## Native WebView viewer

The independent `webview-viewer` application uses [wry 0.57.2](https://github.com/tauri-apps/wry)
(MIT OR Apache-2.0) with winit and the operating system's WebView. It does not
embed a browser engine. WKWebView is supplied by macOS; Windows needs the
Microsoft WebView2 runtime; Linux needs WebKitGTK 4.1 and GTK 3.

The additional cross-platform Rust dependency licenses, including the WebView
bindings and their transitive dependencies, are reproduced in
[WebView-dependencies.txt](./LICENSES/WebView-dependencies.txt). The MPL-2.0
components retain their original license; their versioned upstream sources are
linked in that file. Shared native SDK and renderer licenses still apply.
The embedded React frontend is the repository's web viewer and retains the
[repository notices](../THIRD_PARTY_NOTICES.md). Its offline chess model is the
repository's generated CC0 example (`examples/assets/chess.glb`).

Wayland support additionally activates the platform crates listed with their
license texts in [WebView-additional-dependencies.txt](LICENSES/WebView-additional-dependencies.txt).
The optional Windows NGX adapter and runtime remain subject to the NVIDIA DLSS
SDK license; optional packages include its supplied text in `licenses/NVIDIA-DLSS/`.
Windows packages include the DirectX Shader Compiler and MSVC runtime notices
under `licenses/DXC/` and `licenses/MSVC/`.

The native GPUOpen catalog gateway uses ureq 3.4.2 with rustls. Its selected
license texts and copyright notices are in
[WebView-HTTP-TLS.txt](LICENSES/WebView-HTTP-TLS.txt).
