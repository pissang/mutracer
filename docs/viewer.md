# Using the viewer

Open **Examples → MuTracer collection** for models curated for this viewer, or
**Examples → glTF Research Scenes** for the independently maintained
[glTF Research Scenes](https://github.com/ErfanMo77/gltf-research-scenes) collection.
Scenes download on demand from GitHub; cards show approximate download sizes
and link to each scene's source and license. Large scenes need more memory.
glTF Research Scenes load with **Ground shadow** off; you can enable it in Lighting.

On desktop, choose **Pin to right panel** in Examples to keep the collection
open while loading models. **Unpin examples** returns it to the popover.
The pinned layout is saved in this browser.

glTF/GLB imports include directional, point and spot lights and emissive meshes.
Benchmark scenes also load their sunlight and available environment maps.
Under **Lighting → Environment**, **Scene lighting** is available only when the
model provides lights or environment lighting. Choose it to use the imported
lighting alone, or select an HDRI or Studio to add lighting. Emissive materials
still work with HDRI and Studio. Environment maps add download time and are
resampled to at most 2K width. If a source map is missing, the model still opens
and the Lighting panel explains which map is unavailable; choose an environment
there to replace it.

MuTracer collection examples open with a curated view, under the procedural
sky or a Poly Haven HDRI. A few also set their own tone mapping and bloom, which
return to the defaults when you leave them. Other models with cameras open in their
first camera. You can select any
imported camera in the separate camera toolbar at the bottom right; it appears
only for models with cameras. Drag, pan or zoom after selecting a camera to
continue in **Orbit** from that view.
Hover over a camera in the scene tree and click its camera action to apply it
directly. **Fit to model** in the bottom toolbar (or **F**) returns to Orbit
and frames the model.
Reloading the current model restores your saved camera selection.

Picking an object in the viewport reveals it in the scene tree and scrolls it
into view. Selection follows the rendered geometry, including
[displacement on WebGPU](materials.md#displacement) and alpha-cutout holes;
it becomes available once the scene is ready to render.
Material rows start collapsed; expand a mesh to see its materials.

The viewer caches prepared BVHs to speed up reopening unchanged models.
Models still need to be loaded and decoded. The cache has a 4 GiB browser-storage
budget; entries are removed as space is needed. Cached data is reused only when
geometry, displacement and BVH settings match. Loading still works if storage
is unavailable or full.
Clear the site's browser storage to remove the cache.

## Sharing viewer settings

Add settings to a viewer link to override the recipient's saved preferences.
For example, open the viewer with HDR output enabled:

```text
https://mutracer.meimu-studio.com/viewer/?hdrOutputEnabled=true
```

Combine settings with `&`, and use `#model=…` to choose an example:

```text
https://mutracer.meimu-studio.com/viewer/?hdrOutputEnabled=true&maxSamples=128#model=dragon
```

The viewer updates the URL as lighting, render and display settings change.
Copy the address bar to share those settings and the selected example model.
Settings also work in the hash, such as `#model=dragon&hdrOutputEnabled=true`.
A link with only `#model=…` opens the example with its own render settings, as
the Examples menu does. Settings in a link win over the example's.

### Options

Parameter names match the viewer settings and are case-sensitive:

| Group | Parameters |
| --- | --- |
| Lighting | `lighting`, `studioPreset`, `studioIntensity`, `studioRotation`, `studioSize`, `studioAmbient`, `studioAmbientColor`, `envId`, `envIntensity`, `envRotation`, `envResolution` |
| Background and ground | `background`, `backgroundColor`, `groundedHeight`, `groundedRadius`, `groundShadow`, `groundOpacity` |
| Quality | `maxSamples`, `bounces`, `resolutionScale`, `samplingPattern`, `bvhBuilder`, `clamping`, `previewEnabled`, `previewMaxResolutionScale` |
| Denoising | `denoise`, `denoiseModel`, `denoiseWhileConverging`, `jnlmStrength`, `jnlmSearchRadius`, `jnlmPatchRadius`, `jnlmAlbedoBandwidth`, `jnlmNormalBandwidth`, `jnlmIterations`, `oidnModel`, `oidnMaxTileSize` |
| Display | `hdrOutputEnabled`, `toneMapping`, `exposure`, `contrast`, `saturation`, `temperature`, `tint`, `bloomIntensity`, `bloomThreshold`, `bloomRadius`, `vignette`, `output` |

Booleans accept `true`/`false` or `1`/`0`. Numbers must be finite and within
the setting's supported range. Colors use URL-encoded hex, for example
`backgroundColor=%232a2b30`. Use `null` for automatic `groundedHeight` or
`groundedRadius`. Choices use the setting's value, for example
`toneMapping=agx`, `envResolution=2k` or `denoiseModel=jnlm`.

Valid query parameters take priority over hash parameters, then saved local
preferences, then defaults. Unknown parameters and invalid values are ignored.
Explicit defaults such as `hdrOutputEnabled=false` remain in the link so they
can override a recipient's different preference. When the viewer updates the
address, settings move into the hash; unrelated query parameters, including
`?webgl`, are preserved.

### Caveats

HDR output requires WebGPU, an HDR display and a compatible browser. Unsupported
devices fall back to SDR. `?webgl` forces WebGL 2, which does not support HDR output.

Links do not include uploaded models or environments, camera state, material
edits, object visibility or panel layout. Camera state continues to follow the
locally saved view for the current model. URL settings are applied on page load;
reload after editing parameters in the address bar.
