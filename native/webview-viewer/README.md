# MuTracer native viewer

From the repository root, after the [native build setup](../README.md#build-from-source):

```sh
npm run native:viewer
npm run native:viewer -- /absolute/path/model.glb
npm run native:viewer:build
```

The app opens without a local server. Use **Open**, drop files or a folder, or
choose an example. A command-line `.gltf` also loads its referenced local buffers
and images. To restore a command-line model after restarting, keep the model and
its referenced files unchanged at their original paths. URLs need the remote
server's CORS permission.

The controls match the [web viewer](../../viewer/README.md): model and MaterialX
imports, editable material graphs and textures, Poly Haven and GPUOpen catalogs,
HDR environments, studio lighting, animation, authored cameras, picking,
undo/redo, denoising, AOVs and independent image export. Drag to orbit,
right-drag to pan, scroll to zoom and press **F** to fit. Exports use an OS save
dialog. Code export produces a JavaScript scene setup.

## Options

- The rendering backend menu offers hardware ray tracing where supported,
  software traversal and available GPUs. Changing device or traversal restarts
  the app. Unsupported HWRT scenes can fall back to software.
- HDR output is available when the window surface supports extended linear
  sRGB. Unsupported surfaces stay SDR; PNG exports stay SDR.
- JNLM and OIDN run on the native renderer. The optional Windows DLSS RR package
  exposes Ray Reconstruction when its NVIDIA runtime is active. Independent exports use OIDN when Ray Reconstruction is selected.
- `--build-only` on the build script creates the app without opening it.

## Requirements and limits

macOS uses WKWebView. Windows needs Microsoft WebView2 Runtime. Linux needs
GTK 3 and WebKitGTK 4.1 version 2.40 or later, with either Wayland or X11.
macOS and Windows place the controls over the native viewport. Linux uses a
separate control window and viewport; place them side by side.

MaterialX height baking can take longer than in the web viewer.
The BVH builder selector is unavailable. Environment and background rotations
support yaw only. Imports are limited by available memory and the
[scene and texture limits](../docs/scene-format.md#limits). Large models can
need substantially more RAM than their file size. GPUOpen
retains the web viewer's package download limit. Image and denoising output can
differ between the browser and native backends. See the
[known native rendering limits](../README.md#limitations).

If the interface crashes on macOS, the app restores the default scene and shows
an error. Unsaved edits are lost, and the interrupted file is not reopened
automatically.
