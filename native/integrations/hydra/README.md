# MuTracer Hydra delegate

Experimental OpenUSD 26.03 renderer for macOS arm64 / Metal and Windows x64.
Select **MuTracer**
in usdview, or `HdMuTracerRendererPlugin` in a Hydra host. It needs a GPU even
when the host reads images through CPU buffers. One active view per delegate
is supported. It is not included in MuTracer's default build.

## Build and use

Build the [native SDK](../../README.md#build-and-link) in the same checkout.
Install OpenUSD 26.03 with USD imaging, Python, usdview and MaterialX enabled;
Embree is unnecessary. Use the Python environment used to build OpenUSD.
CMake 3.26 or newer and a C++17 compiler are required.

```sh
cmake -S native/integrations/hydra -B /absolute/hydra-build \
  -DCMAKE_PREFIX_PATH=/absolute/openusd-install -DCMAKE_BUILD_TYPE=Release
cmake --build /absolute/hydra-build -j 4
export PXR_PLUGINPATH_NAME=/absolute/hydra-build/plugin/hdMuTracer/resources
export PYTHONPATH=/absolute/openusd-install/lib/python
export PATH=/absolute/openusd-install/bin:$PATH
usdview --renderer MuTracer native/integrations/hydra/tests/rect.usda
usdrecord --renderer MuTracer --disableGpu --disableCameraLight --camera /Camera --imageWidth 512 \
  native/integrations/hydra/tests/rect.usda /absolute/render.png
```

For this `usdrecord` command, `--disableGpu` avoids the recorder's OpenGL context
and reads the CPU render buffer; MuTracer still renders on its own GPU. The
recorder cannot apply GPU color correction in that mode. Pixels in Hydra AOVs
are linear; choose the host's display transform for viewing.
`--disableCameraLight` uses only the scene's authored lighting; otherwise
usdrecord adds a light at the camera.

`MUTRACER_LIBRARY_DIR` can override the SDK library directory at CMake configure
time. Its default is this checkout's
`.native-build/scene-core/cargo-target/release`. Keep the SDK and OpenUSD shared
libraries accessible at runtime. A Blender or Houdini host requires a separate
build matching its USD namespace, headers, libraries and compiler ABI; this
usdview binary is not a Blender add-on. Blender 5.2 users can install the
separately packaged [Blender integration](../blender/README.md).

On Windows, build with MSVC and the dynamic CRT (`/MD`), and add the SDK's
`lib` directory and the OpenUSD `bin` and `lib` directories to `PATH`. Use
semicolon-separated paths for `CMAKE_PREFIX_PATH` and `PYTHONPATH` as needed.
The verified host is OpenUSD 26.03 with HgiGL. It reads MuTracer's CPU render
buffers; MuTracer still renders through its own GPU backend. HgiVulkan output
interop is not connected to this delegate. For linear EXR output, build OpenUSD
with its OpenImageIO image plugin and keep that plugin's runtime dependencies
on `PATH`.

Mesh and instancer visibility use [whole-mesh/batch SDK visibility](../../docs/scene.md#visibility).
Individual-instance visibility is not supported.

## Supported inputs and settings

Meshes use polygon triangulation, including face-varying normals, `st` UVs and
`displayColor`. Subdivision surfaces render as control cages with a warning.
Point/native instances and nested instancers are flattened. Material subsets,
curves, points, motion blur and alternate representations are not supported.

MaterialX OpenPBR, Standard Surface, glTF PBR and UsdPreviewSurface materials
use the [native material graph subset](../../docs/scene.md#material-graphs).
Material and NodeGraph interface inputs, connected outputs, math, procedural
noise and image nodes retain their typed connections. Uniform values are folded
into material constants. Standard Surface uses MaterialX's official OpenPBR
translation; glTF and PreviewSurface use the same boundary conversion as the
viewer. These mappings do not promise pixel equality with another renderer's
BSDF. The default shading frame is supported; arbitrary coat-normal and tangent
networks outside that subset fall back. HSV conversions and `hsvadjust` support
color3/color4 with alpha preserved. Imported MaterialX 1.38 documents upgrade
legacy normal maps and atan2 inputs to the current node semantics.

Unsupported inputs report their USD path and port and use the authored constant
or existing material conversion. Default image-frame controls, uniform zero
inputs with no effect and default world-space frame inputs do not force a
fallback. Varying subsurface inputs are ignored when the subsurface weight is
constant zero; active subsurface graphs still fall back. Lit emission, opacity
projection and light-tracing/photon-mapping restrictions follow the native graph limits. The delegate does not bake graphs.

Textures use Hio, sRGB color storage or linear float storage. MaterialX image
nodes support repeat/clamp/mirror wrapping and graph UV transforms.
`UsdUVTexture` retains its direct-map path, including connected scalar channels
and UV scale/translation; its rotation, texture-value scale/bias, border wrapping
and alternate UV primvars remain unsupported. `<UDIM>` paths load readable
files numbered 1001–1100; missing tiles sample transparent black. Tiles are
normalized to the maximum tile width and height, with one color-space setting
for all tiles. The full 10×10 logical grid counts toward texture and GPU budgets,
including empty cells.

Texture references remain cached for the delegate's lifetime; repeated swaps
can increase memory use. Filters use the SDK's texture filtering.
Time-varying numeric values and retained-texture replacements commit
incrementally when atlas placement and shader support remain compatible.
Changing a node, typed connection or terminal prepares a new graph; the installed
graph keeps sampling when camera and render settings are unchanged. The newest
request replaces it when ready, and failures retain the previous graph.

Rprim insertion reuses resident materials and can append static,
single-material geometry when the SDK's
[scene update rules](../../docs/scene.md#edit-a-scene) permit it, including after
rprim deletion. New geometry prepares in the background while the previous
image remains available; appending can grow scene buffers and increase memory
use.

UsdPreviewSurface is an approximation of the native glTF material mapping:

| Preview input | OpenPBR behavior |
| --- | --- |
| diffuseColor, metallic, roughness, ior, opacity | Base color, metalness, specular roughness, IOR, opacity |
| emissiveColor | Emission color with unit luminance |
| clearcoat, clearcoatRoughness | Coat weight/roughness; IOR 1.5 and no coat darkening |
| useSpecularWorkflow, specularColor | Peak F0 converted to IOR; normalized tint; metalness zero |

The specular workflow, coat and opacity models are not lossless conversions.
Alpha cutoff is explicitly zero unless PreviewSurface supplies `opacityThreshold`.
OpenPBR's independent layers cannot all be expressed by PreviewSurface.

Rect, sphere, disk, cylinder and distant lights are supported. Rectangular,
sphere and spot lights use SDK radiance units; their UsdLux `normalize` input is
unsupported and ignored with a warning. Disk lights use local XY and emit
toward local -Z. Cylinder lights run along local X and emit from the curved side
without end caps. Disk and cylinder `normalize` divides intensity by the area
from their authored dimensions (πr² or 2πrL); `treatAsLine` does not change area
sampling. Stage `metersPerUnit` metadata does not rescale these dimensions.
Shaping cones become SDK spots, and dome maps provide environment lighting.
Distant light intensity follows UsdLux, including `angle` and `normalize`, and
renders as a sharp directional light. Enabled color temperature multiplies the
authored light color. Linked lights are skipped. Equal diffuse and specular
multipliers scale the light; unequal ones are ignored. IES shaping and arbitrary
dome tilt are unsupported. There is one environment dome. Light textures are
supported only through the environment, not rectangular emitters.

Perspective, orthographic and depth-of-field cameras are supported. Off-axis
perspective frusta use a symmetric approximation with a warning. A zero focus
distance disables depth of field.

| Hydra render setting | Default | Values |
| --- | --- | --- |
| convergedSamplesPerPixel | 64 | 1–16384 |
| maxBounces | 3 | 1–20 scattering depth |
| backend | 1 | 0 software BVH; 1 hardware ray queries with SDK fallback |
| resolutionScale | 1 | 0.1–1; nearest-neighbor enlargement |
| displayRefreshRate | 30 | 1–1000 Hz output refresh cap; 0 publishes each changed sample count |
| forceCpuOutput | 0 | 0 automatic; 1 forces CPU buffers for A/B comparisons |

Hardware ray-query limitations are listed in the
[SDK backend guide](../../README.md#ray-tracing-backends).

## Outputs and limits

`color` is premultiplied linear RGBA, composited over the bound AOV clear color.
`depth` projects the pixel-center camera-forward distance shared with IDs to
clip depth; misses clear to 1. It therefore identifies the same selected surface as
`primId`, without jitter or depth of field. `normal` is the signed world-space
shading normal, including the base normal map; `Neye` is that normal in view
space, and `Peye` is view-space position. These surface outputs use the same
alpha and shadow-catcher filtering as IDs.

`primId` uses Hydra rprim IDs, `instanceId` uses prototype-local flattened
selection indices, and `elementId` identifies the original polygon face.
Background and non-instanced instance IDs are -1. The SDK's denoising guide is
separate from these surface outputs.

With a compatible HgiMetal host, `color` alone or `color` + `depth` uses GPU
textures without CPU pixel transfers. Color must be float32/float16 RGBA; a bound
depth must be float32 and the same size. Depth and IDs select the same center
surface in both GPU and CPU modes. Binding `normal`, `Neye` or `Peye` uses CPU
buffers and reports the requested AOVs as the fallback reason. CPU mode reads
each requested center source as RGBA32F; `normal` and `Neye` share one source.
`usdrecord --disableGpu`, non-Metal hosts and `forceCpuOutput=1` also use CPU
buffers. GPU output does not add Blender or Vulkan host support.
OpenUSD 26.03's CPU viewport depth upload fails with Metal API Validation;
`usdrecord --disableGpu` avoids that host upload path for offline CPU output.
Recreate the OpenUSD 26.03 host engine when switching between viewport and
offline multi-AOV task lists; that transition can retain stale host AOV textures.

Only changed sample counts refresh the output, capped by `displayRefreshRate`,
with a final publication at convergence. Three texture sets allow sampling to
continue while the host finishes an older frame; a busy host can skip an
intermediate publication. Resizing or changing the output backend waits for
outstanding GPU work. Device loss requires recreating the delegate and host GPU
device.

ID images are read on demand in GPU mode. Color/depth `Map()` also reads from the
SDK on demand and blocks for CPU pixels; during progressive rendering this can
be newer than the last viewport publication. CPU output reads all bound AOVs
at refresh time, and Hydra can upload unchanged buffers on intervening frames.

At 4K and full resolution, float32 color output uses about 1.30 GiB in addition
to rendering storage. In CPU mode, each 4K RGBA32F AOV read is about 127 MiB.
See the
[SDK's memory and output limits](../../docs/engine.md#costs), including the
1,024 analytic-light limit and the absence of tiled output.
