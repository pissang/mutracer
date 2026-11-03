# MuTracer Viewer

A browser app for trying MuTracer: drop a glTF/GLB (or a folder with a .gltf,
its .bin and textures) or a Radiance .hdr, browse the scene tree, edit OpenPBR
materials, lighting, camera and render settings, play glTF animations and
export PNGs.

PBRT scenes can be opened from a `.pbrt` URL, by dropping a folder, or by
selecting the scene together with its assets. Relative paths follow the main
scene's directory. Scene cameras and lighting load with the
model; aspect ratio, bounce limit and sample target start from the scene and remain
editable. The Lighting panel expands import warnings. Downloads of 1 GB or more
require confirmation, and scenes above the browser import memory budget are
rejected before binary downloads. See [supported features and limits](../tools/pbrt/README.md).

Drag a numeric input left or right to adjust its value, or click it to type.
Enter or clicking elsewhere commits typed edits; Escape cancels them. While
editing text, dragging selects text instead of changing the value.

In the material panel, upload or drop a height image into the Displacement
texture slot, then adjust Scale (`displacementScale`) in the Displacement
section, which is expanded by default. Bias shifts the surface along its normal:
`offset = texture × Scale + Bias`. Both use mesh-local units; Bias defaults to
`0`. Set Bias to `-Scale / 2` for centered displacement. Scale's slider covers
0–10% of the selected mesh's longest local side, and Bias covers the same
distance in both directions, with precision adjusted to mesh size. Use the
separate numeric inputs to enter values outside those ranges. Selecting another
mesh changes the range without changing the material's values. A map is required
even when Scale is `0` and Bias is nonzero. Meshes without UVs automatically use
triplanar coordinates when a height map is applied.
Displacement requires WebGPU; its controls are disabled on WebGL 2.

In the Poly Haven texture browser, enable Download displacement map before
choosing a set to include its height map when available. This option is off by
default and adds download and rendering time. Applying a set replaces the
previous displacement map; leaving the option off clears it. Height maps and
their settings support undo, redo and restoration when reloading the cached
model, like other material edits.

Under Material → Textures, expand a loaded texture's Wrap & repeat controls.
Choose Repeat, Clamp to edge or Mirrored repeat independently for S/T, and use
the Repeat S/T numeric inputs to set each axis's repeat count. Negative values
flip an axis; zero samples a constant coordinate. Edits support undo/redo and
are restored with the cached model.
Uploaded images keep the UV transform and wrapping of the texture they replace.

The Export dialog can download the current viewport PNG immediately, preserving
its displayed appearance and pixel size without restarting the render. Render PNG
instead renders a new image at Viewport, 1080p, 2K (2560 × 1440), 4K, or Square
resolution using the selected sample count and background settings.

The Code button next to Export shows the least `@meimu/mutracer` + Three.js
code that renders the current view: model, lighting, background, ground,
camera, and the render, denoiser and display settings that differ from the
library defaults. Material edits and hidden objects are not included. A header
comment states the library version, backend, omissions and placeholders, so
the code can be handed to a coding agent as is. Scripts and agents driving the
viewer in a browser can read the same code with `window.mutracerViewer.code()`.
Copy for agent (or `window.mutracerViewer.agentMarkdown()`) wraps the code in
Markdown with the model, a viewer link, the changed viewer settings and links
to the usage guide.

```bash
npm run viewer          # http://localhost:3012
npm run build:viewer    # static site in dist-viewer/
npm run typecheck:viewer
npm run test:viewer       # source aliases; no prior build:lib needed
```

Add `?webgl` to force the WebGL 2 backend. The URL keeps the example model,
lighting, render and display settings so a view can be shared. URL parameters
override saved preferences; for example, `?hdrOutputEnabled=true` opens with
HDR output enabled. See [sharing viewer settings](../docs/viewer.md) for options
and precedence.

## Deployment

The viewer is deployed under `/viewer/` of the MuTracer site, together with
the home page and the examples. See [`site/README.md`](../site/README.md).

## Structure

```
src/
  engine/ViewerEngine.ts   Engine/Display/RenderLoop, THREESync, picking,
                           animation, export. No React.
  engine/loadModel.ts      GLTFLoader for URLs, files and dropped folders;
                           the procedural material-sphere scene
  engine/codeSnippet.ts    Standalone program generated from the current view
  engine/studio.ts         Studio lighting presets: rect-light rigs scaled to
                           the model, and their dim ambient fill
  engine/materialParams.ts Material panel schema, presets, color conversion
  engine/materialEditor.ts Material edits, uploaded textures and their
                           persistence for the cached model
  history.ts               Shared undo/redo history for material, lighting
                           and render edits
  engine/presets.ts        Example models and HDRIs with licenses
  assets/thumbnails/       Example and material preset thumbnails
  dev/thumbnails.ts        Renders those thumbnails (development only)
  store.ts                 zustand store: settings, stats, tree, selection, UI
  components/              React UI (react-aria-components, lucide-react)
  styles/app.css           Design tokens and component styles
```

Data flows one way: controls write `store.settings`; `ViewerEngine`
subscribes, applies the change to the renderer, the Three.js source scene or
the converted `OpenPBRMaterial`s, and publishes stats, the scene tree and the
selection back to the store.

Notes:

- Material edits go to the converted MuTracer `OpenPBRMaterial`s (collected with
  `onMeshConverted`). The Three.js source material
  is not touched, so the scene sync does not overwrite the edit.
- Material edits (values, presets, texture uploads and removals, reset) and
  lighting and render settings changed through `setSettings` share one undo
  history; consecutive changes of one slider or color picker collapse into one
  step. Camera settings, which follow the view, and switches to or from an
  uploaded .hdr are not recorded. Opening a model drops its material steps and
  keeps the settings steps.
- Material edits of the cached model, including the original files of uploaded
  textures, are saved in a second OPFS archive keyed by the model and by each
  material's traversal order. Reloads reapply them as materials are converted;
  opening any model (including choosing the same example again) discards them
  and the undo history.
- Environment intensity and rotation apply to the lighting and HDRI background,
  including Grounded mode. Rotation keeps the ground level.
- Downloaded HDR files are cached by URL (including resolution and query string)
  in the browser's origin private file system (OPFS), and reused across reloads.
  Invalid cached files are downloaded again; unavailable or full storage falls
  back to normal loading. Clear the site's browser storage to remove the cache.
- The current model and its buffers/textures are saved as one OPFS archive,
  replacing the previous model after a successful load. Reloads reopen that
  model; an explicit model preset in the URL takes precedence. Orbit position,
  target and lens settings are saved locally for the current model and restored
  after loading, including the selected glTF camera. Unavailable/full storage
  does not prevent opening models.
- Denoising defaults to OIDN on WebGPU and falls back to JNLM on WebGL 2.
  Switch between OIDN and JNLM in the bottom dock or the Render tab; each keeps
  its parameters, and the selected filter is saved across reloads.
- OIDN weights are loaded from `/oidn/weights/` at the server root via an explicit
  weightsBaseUrl, sharing all five local networks. Development serves the
  repository's `oidn/weights/` there, `build:viewer` emits them at the root of
  `dist-viewer/`, and the site build shares one copy with the examples.
- Opening the viewer with `#open=files` loads files that the home page stashed
  in IndexedDB (`engine/droppedFiles.ts`).
- For sample models, rendering benchmarks, imported lighting and camera choices, see the
  [viewer guide](../docs/viewer.md).
- The visual language comes from DropMesh (same author).

## Assets

GLBs from the independent assets pipeline may provide a default orbit camera
in the active glTF scene's `extras.mutracerCamera`: `{position: [x,y,z], target:
[x,y,z], fov: 45, space: "grounded"}`. Coordinates refer to the model after the
viewer centers X/Z and grounds Y. Fresh loads apply this view; a restored saved
user view takes precedence. Invalid camera metadata falls back to automatic fit.

Example models are loaded on demand. Downloads retry temporary network or server
failures up to twice; samples hosted on jsDelivr use GitHub as the final fallback.
Material spheres are procedural; Toy Car
and Sheen Chair come from [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
(CC0). Additional model previews and credits are available in
[mutracer-assets](https://github.com/pissang/mutracer-assets).

The sample site is a free, noncommercial technical demonstration. Each Sketchfab
asset retains its own CC BY, CC BY-NC or CC BY-NC-SA 4.0 license, displayed with
author, source, license and full credits/change notes; these assets are not
covered by the library's MIT license. Yamaha and Gelatinous Cube require
noncommercial use, and Yamaha adaptations retain ShareAlike. Jaguar and the
octopus remain local previews and are excluded from the public list. HDRIs come
from [Poly Haven](https://polyhaven.com/hdris) (CC0). The material spheres and the
procedural sky work offline.
