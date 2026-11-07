# MuTracer Hydra delegate

Experimental OpenUSD 26.03 renderer for macOS arm64 / Metal. Select **MuTracer**
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
usdrecord --renderer MuTracer --disableGpu --camera /Camera --imageWidth 512 \
  native/integrations/hydra/tests/rect.usda /absolute/render.png
```

For this `usdrecord` command, `--disableGpu` avoids the recorder's OpenGL context
and reads the CPU render buffer; MuTracer still renders on its own GPU. The
recorder cannot apply GPU color correction in that mode. Pixels in Hydra AOVs
are linear; choose the host's display transform for viewing.

`MUTRACER_LIBRARY_DIR` can override the SDK library directory at CMake configure
time. Its default is this checkout's
`.native-build/scene-core/cargo-target/release`. Keep the SDK and OpenUSD shared
libraries accessible at runtime. A Blender or Houdini host requires a separate
build matching its USD namespace, headers, libraries and compiler ABI; this
usdview binary is not a Blender add-on.

Mesh and instancer visibility use [whole-mesh/batch SDK visibility](../../docs/scene.md#visibility).
Individual-instance visibility is not supported.

## Supported inputs and settings

Meshes use polygon triangulation, including face-varying normals, `st` UVs and
`displayColor`. Subdivision surfaces render as control cages with a warning.
Point/native instances and nested instancers are flattened. Material subsets,
curves, points, motion blur and alternate representations are not supported.

MaterialX `ND_open_pbr_surface_surfaceshader` maps all 37 constant inputs to
OpenPBR parameters, using nodedef defaults for unassigned inputs. This preserves
the parameter contract; it does not promise pixel equality with another BSDF.
The four arbitrary geometry-vector inputs are limited to the default geometry
frame, tangent rotation and tangent-space normal-map paths.

Simple MaterialX image/texcoord/convert chains and `UsdUVTexture` are supported.
Standard Surface constants use MaterialX's
`standard_surface_to_open_pbr_surface` conversion. Connected constant
convert, arithmetic, mix, clamp, power, comparison and channel-extract nodes
are folded before conversion.
Textures use Hio, sRGB color storage or linear float storage, connected scalar
channels, repeat/clamp/mirror wrapping and UV scale/translation. `<UDIM>` image
paths load existing files numbered 1001–1100; missing tiles sample transparent
black. Tile images must be readable by Hio and are normalized to the maximum
tile width and maximum tile height. A texture uses one color-space setting for
all tiles. The 10×10 logical grid counts toward the texture and GPU budgets,
including empty cells. UV rotation,
alternate UV primvars, texture-value scale/bias, border wrapping, other color
spaces and arbitrary procedural graphs are unsupported. Other graph nodes use the
authored constant fallback or nodedef default with a warning; the delegate does
not bake procedural graphs.
Texture references remain cached for the delegate's lifetime; repeated swaps
can increase memory use. Filters use the SDK's texture filtering.
Changing a connection to an already retained texture is incremental when its
atlas placement and shader support remain compatible; otherwise the SDK prepares
the scene again. Rprim insertion and removal likewise reuse resident geometry
and materials until retained TLAS capacity is exceeded.

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
