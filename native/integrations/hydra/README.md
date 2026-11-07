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
channels, repeat/clamp/mirror wrapping and UV scale/translation. Other graph
nodes use the authored constant fallback or nodedef default with a warning;
the delegate does not bake procedural graphs. UDIM, UV rotation, alternate UV
primvars, texture-value scale/bias, border wrapping, other color spaces and
arbitrary procedural graphs are unsupported.
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

Rect, sphere and distant lights are supported. Shaping cones become SDK spots;
dome maps provide environment lighting. Disk, cylinder and linked lights are
skipped with warnings. Distant light intensity follows UsdLux, including
`angle` and `normalize`, and renders as a sharp directional light. Other lights
use SDK radiance units and ignore `normalize`. Equal diffuse and specular
multipliers scale the light; unequal ones are ignored. Color temperature, IES
shaping and arbitrary dome tilt are not supported. There is one environment
dome. Light textures are currently supported only through the environment, not
rectangular emitters.

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
`depth` is SDK camera-forward distance converted to [0,1] clip depth; misses clear to 1. SDK depth first averages jitter
and lens samples, then the delegate projects the mean. It can disagree with the
pixel-center ID at edges and with depth of field, and is not a per-fragment
center-ray depth resolve.

`primId` uses Hydra rprim IDs, `instanceId` uses prototype-local flattened
selection indices, and `elementId` identifies the original polygon face.
Background and non-instanced instance IDs are -1. `normal` and `Neye` are not
provided; the SDK's denoising guide is unsuitable for these surface outputs.

With a host HgiMetal device, color and depth use GPU textures together. Missing
or incompatible Hgi, engine creation failure, unsupported AOV pairs or GPU
conversion setup failure select CPU buffers and print the reason once. Hosts
must provide matching color/depth dimensions, float32 or float16 RGBA color and
float32 depth to use GPU output. `usdrecord --disableGpu` continues to use CPU
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

GPU output avoids per-frame CPU image transfers but adds texture memory: at 4K
and full resolution, the default float32 color output uses about 1.30 GiB for
the three texture sets, in addition to rendering storage. In CPU mode, one 4K
RGBA32F read is about 127 MiB. CPU Map buffers remain allocated in GPU mode.
See the
[SDK's memory and output limits](../../docs/engine.md#costs), including the
64 analytic-light limit and the absence of tiled output.
