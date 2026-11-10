# Native WebView prototype

Run from the repository root after the [native setup](../CONTRIBUTING.md#setup):

```sh
node native/scripts/webview-viewer-build.mjs
node native/scripts/webview-viewer-build.mjs /absolute/path/model.glb
```

The app opens the bundled CC0 chess scene without a server. **Open** accepts a
GLB or a glTF with embedded resources; dropped GLBs work too. Select a mesh in
**Scene**, edit material numbers/colors in **Material**, drag the viewport to
orbit, right-drag to pan and scroll to zoom. Progress and spp appear in the
viewport. The original egui viewer remains available. **Reset all** reloads the bundled chess scene.

The build needs Node and Rust; the resulting executable embeds the compressed
frontend and uses the system WebView. macOS uses WKWebView; Windows requires
WebView2; Linux requires GTK 3/WebKitGTK 4.1 and an X11 session. Windows and Linux
presentation have not been verified. Wayland is not supported by this prototype.

## Options

- `--build-only` builds without opening a window.
- A model path opens a local glTF and its local resources through the native importer.
- **Material** supports scalar, color, boolean and enum edits and reset.
- Supported settings: sample cap, bounces, clamp, sampling sequence, resolution
  scale, FOV, aperture/focus distance, exposure, tone mapping/color adjustments,
  bloom/vignette, and constant-environment intensity/rotation. Pause and fit work.
- Viewport PNG export uses a native save dialog. The export dialog's preview
  and HDR/normal/albedo readback use the native image.

## Limits

This is a UI integration prototype. HDR environment loading, studio lights,
MaterialX/graph/texture edits, animation, authored cameras, selection/focus
picking, undo for material edits, fixed-height/aspect controls, AOV selection,
HDR window output, denoising controls and independent image export are not
connected. Unsupported commands show an error. Settings shown in those panels
are not a claim of native support. In-memory model uploads are limited to
128 MiB; local command-line imports follow the SDK's import limits.

The prototype displays SDR, uses a constant environment, and initially renders
at 50% of the viewport dimensions.
