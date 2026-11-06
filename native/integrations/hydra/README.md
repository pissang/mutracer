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
Textures use Hio, sRGB color storage or linear float storage, connected scalar
channels, repeat/clamp/mirror wrapping and UV scale/translation. Other graph
nodes use constant defaults with a warning. UDIM, UV rotation, alternate UV
primvars, texture-value scale/bias, border wrapping, other color spaces and
arbitrary procedural graphs are unsupported.
Texture references remain cached for the delegate's lifetime; repeated swaps
can increase memory use. Filters use the SDK's texture filtering.

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
skipped with warnings. USD light normalization, color temperature, IES shaping,
distant angular size and arbitrary dome tilt are not supported; intensities use
SDK radiance units. There is one environment dome. Light textures are currently
supported only through the environment, not rectangular emitters.

Perspective, orthographic and depth-of-field cameras are supported. Off-axis
perspective frusta use a symmetric approximation with a warning. A zero focus
distance disables depth of field. Camera edits update the engine camera directly.

| Hydra render setting | Default | Values |
| --- | --- | --- |
| convergedSamplesPerPixel | 64 | 1–16384 |
| backend | 1 | 0 software BVH; 1 hardware ray queries with SDK fallback |
| resolutionScale | 1 | 0.1–1; nearest-neighbor enlargement |
| displayRefreshRate | 30 | 1–1000 Hz CPU readback cap; 0 reads each changed sample count |

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

Output currently uses CPU buffers. Only changed sample counts trigger SDK
readback, limited by `displayRefreshRate`, with a final read at convergence.
Hydra can still upload the same CPU color/depth buffer on intervening host frames.
At 4K, one RGBA32F image is about 127 MiB; color/depth/ID reads and CPU conversion
add bandwidth and synchronization costs. See the
[SDK's memory and output limits](../../docs/engine.md#costs), including the
64 analytic-light limit and the absence of tiled output.
