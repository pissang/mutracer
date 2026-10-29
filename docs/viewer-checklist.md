# Viewer feature checklist

Use this checklist with the [Web viewer](https://mutracer.meimu-studio.com/viewer/)
and [native viewer](../native/viewer/README.md). Start with material spheres,
then use a glTF with nested objects, cameras, lights and animation. A checked
item means you exercised the behavior in the version being reviewed; it does
not promise identical rendered pixels between devices or backends.

## Workflow

| Check | Action and expected result |
| --- | --- |
| [ ] Open | Open a GLB, a glTF with external buffers/images, a folder and a model URL; geometry and textures load. Drop files on the viewport. Failed or cancelled loads leave the previous scene usable. |
| [ ] Examples | Open **Examples** in the toolbar; switch between MuTracer collection and glTF Research Scenes, load a thumbnail and check its camera and authored lighting. |
| [ ] Scene | Search and expand nested groups; select an object from the tree and viewport; selection reveals the object and its material. Hide/show a mesh and a group. Select an authored camera. |
| [ ] Navigation | Drag to orbit, right-drag to pan, scroll to zoom, **F** to fit. Moving an authored camera continues in Orbit. |
| [ ] History | Undo/redo material, visibility, lighting and render edits; one continuous drag is one step. Reset all restores defaults and reframes the model. |
| [ ] Panels | **1–4** opens Lighting, Material, Camera, Render respectively. **[**, **]** toggle scene/inspector; click the active rail tab to close it. **H** hides the interface. Text input must not trigger shortcuts. |
| [ ] Playback | **Space** plays/pauses animation when present, otherwise pauses/resumes rendering. Choose another clip and seek the timeline. |
| [ ] Render dock | Change sample target, viewport resolution and denoising; pause/resume and inspect sample progress, elapsed time and completion. **D** toggles denoising. |
| [ ] Export | **E** opens a preview; save the displayed viewport PNG. Render Viewport/1080p/2K/4K/Square PNG with a separate sample budget, denoising and optional transparency. Cancel an export and continue using the original image. |
| [ ] Code/help | Open Code and copy a setup for the corresponding SDK; open keyboard help. **⌘O / Ctrl+O** opens files. |

## Lighting, materials, camera and rendering

| Check | Controls and expected result |
| --- | --- |
| [ ] Environment | Switch HDRI / Studio and model lighting where available. Load a local HDR or browse Poly Haven; change HDR resolution, intensity and rotation. Failed downloads keep the previous lighting. |
| [ ] Studio | Choose each rig; adjust intensity, rotation, size, ambient strength and color. |
| [ ] Background | Switch environment, color, transparent and grounded modes where offered. Adjust projection height/radius; verify auto values and transparency in exported PNG. |
| [ ] Ground | Enable ground shadow and change opacity; inspect contact with the model. |
| [ ] Material selection | Pick a mesh/material, check shared-material edits, apply a preset and reset to loaded values. |
| [ ] Material layers | Exercise base color/weight, metalness, roughness, diffuse roughness, IOR/specular, anisotropy, transmission/volume/thin wall, subsurface, coat, fuzz, thin film, emission, opacity/alpha and double-sided/unlit controls where offered. |
| [ ] Textures | Upload, replace and remove each exposed slot; change Wrap S/T and Repeat S/T, including negative repeats. Apply a Poly Haven set with optional displacement; cancel/replace downloads and switch materials during download. |
| [ ] Displacement | Change scale, bias, subdivision and smoothing; verify silhouettes and return to zero displacement. |
| [ ] MaterialX (Web) | Import a .zip package or .mtlx with images; check converted layers and textures. |
| [ ] Camera | Switch Perspective/Orthographic, adjust FOV, auto-rotate and Fit. Authored cameras keep their projection/FOV until Orbit resumes. |
| [ ] Depth of field | Enable DOF, adjust f-number, area autofocus and focus frame; move the frame, manually edit focus or pick a point; choose automatic or explicit scene units. Orthographic views disable DOF. |
| [ ] Quality | Change max samples, bounces, resolution, sampling pattern and clamping. Web also offers a BVH builder. |
| [ ] Caustics | Toggle light tracing and photon mapping; compare each alone and together on a glass scene. Web's master Caustics switch gates both. |
| [ ] Denoiser | Toggle JNLM/OIDN; adjust JNLM strength, search/patch radius, albedo/normal tolerance and passes; choose OIDN Standard/Small/Large and tile size. Reset selected parameters. |
| [ ] Color | Change AgX/ACES/Cineon/Reinhard/Linear, exposure, contrast, saturation, temperature and tint; verify exported colors. |
| [ ] Effects | Enable bloom, threshold/radius and vignette; turn them off and verify the image returns. |
| [ ] Debug | Expand/collapse Debug; inspect Final, Albedo, Normal, Depth, Position, Roughness, Diffuse/Specular reflectance, ID and Motion. Adjust channel ranges and ID component; toggle interactive preview and max preview scale. Overlay gestures must not orbit/select the scene. |
| [ ] Window size | Check wide and narrow windows, hidden panels and long names; controls remain readable and the viewport remains usable. Web also provides the mobile bottom sheet. |

## Platform options and limits

| Area | Web | Native |
| --- | --- | --- |
| Rendering device | WebGPU; WebGL 2 fallback reloads the page | HWRT / Software BVH; device availability is reported in the UI |
| Denoising | WebGL 2 supports JNLM; OIDN needs WebGPU | JNLM/OIDN; optional Windows DLSS RR build |
| HDR display | WebGPU plus compatible browser/display; falls back to SDR | Viewer window is SDR; HDR toggle is disabled |
| BVH builder | tinybvh / builtin | No builder selector |
| MaterialX import | .zip or .mtlx with images | No MaterialX import UI |
| Caustics controls | Master switch plus two methods; methods require WebGPU | Independent method switches; both off disables caustics |
| File access | Multi-file/folder picker; URLs need CORS | File/folder picker; folder Open selects a top-level glTF/GLB; resources resolve beside the model |
| Code | JavaScript setup | Rust SDK setup |
| Examples browser | Popover with optional pinned panel | Toolbar opens a docked panel |
| Extra native controls | — | Fixed-pixel render sizes, object transforms through Scene → Edit object transform, directional key light |
| Small screens | Mobile sheet and responsive toolbar | Desktop panels; scene list hides when space is limited |

Native and Web use different UI toolkits and fonts. Check icon meaning,
label order, alignment and control availability; file dialogs, window controls,
font rasterization and responsive behavior follow each platform.
