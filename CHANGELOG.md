# Changelog

All notable changes to MuTracer will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.3.1 - 2026-11-05

Display upscaling with texture detail recovery, faster tiled rendering and faster dispersion.

### Added

- `createEasuPass()` is an edge-adaptive display upscale pass. With `albedoDetail: true` it restores surface texture detail from display-resolution color and depth AOVs, so beauty can render at a reduced `resolutionScale`. See [post-processing](docs/post-processing.md).
- `display.addPostProcess(pass, {outputSize})` lets a pass output a different size than its input, for example the canvas size. `PostProcessOptions` is exported.
- The `aovResolution: 'display'` render option traces AOVs at canvas size on WebGPU, capped at 4 samples, while beauty keeps the render resolution. WebGL 2 falls back to render resolution and warns once. See [surface outputs](docs/api.md#surface-outputs).
- `diffuseColor` and `specularColor` AOVs output resolved material colors without BSDF integration, on both backends.
- `render.getAovTexture('diffuseColor' | 'specularColor' | 'depth')` borrows raw AOV textures on WebGPU.

### Changed

- Missing tangents are generated only for materials that use anisotropy or a coat normal map. Base normal maps use triangle UV derivatives.
- WebGPU stores vertex normals and tangents in compact form, and vertex colors in [0, 1] with at most 1/510 error per channel. Positions, UVs, HDR or negative vertex colors and displaced normals keep full precision. See [performance](docs/performance.md).
- Exports of fixed-size renders are cropped to the requested size before post-process passes run.

### Performance

- Large scenes load faster and use less GPU memory on WebGPU with compact vertices.
- Dispersion traces the shared camera path once before the first wavelength-dependent interaction, and direct-light resampling balances its candidates across RGB channels.
- TLAS builds cull leaf instances by world bounds and use more SAH bins on the web.
- Tiled rendering stops subdividing when the time budget cannot be reached or smaller tiles bring little speedup.
- Russian roulette is deferred only for paths inside scattering media, so absorbing materials no longer lengthen every path in the scene.

### Fixed

- Multiple-scattering compensation for low-roughness metals no longer adds too much energy; they can look slightly darker under broad lighting.
- Paths inside a subsurface medium intersect its boundary correctly; materials with short scattering radii can look darker.
- Dispersive scenes no longer overcount emissive meshes, and WebGL 2 spectral direct lighting follows the same random streams as WebGPU.
- Camera rays stay stable with very small near planes or extreme clip ranges.
- An engine created on a canvas right after another engine on it was disposed no longer fails with "context is not configured".
- WebGL 2 scenes that combine vertex colors, tangents, texture maps, emissive meshes and an environment no longer exceed 16 texture units and fail to link.
- WebGL 2 scenes mixing analytic lights and emissive meshes compile again, and sphere and spot lights seen through transmissive surfaces keep their own radiance instead of the background.

## 0.3.0 - 2026-11-02

Experimental WebGPU caustics, continuous-wavelength dispersion and more responsive progressive rendering.

### Added

- Experimental WebGPU caustics with `render.caustics`, off by default and ignored on WebGL 2: `lightTracing` for directly visible receivers, `photonMapping` for receivers seen through glass or water. See the [caustics guide](docs/caustics.md).
- `render.refineUntil(deadline, {signal})` refines once, then keeps sampling until the deadline or cancellation. Use it for custom frame loops; see [sample batching](docs/progressive-rendering.md#sample-batching).
- `RenderLoop.lastError` holds the exception from the latest failed tick; `status` is `error` while it is set.

### Changed

- Dispersion samples continuous wavelengths, on camera paths and caustic photons, so rainbows and dispersive glass form smooth gradients instead of separate red, green and blue images. Scenes with dispersion render differently. `dispersionWavelengths` now counts paths per sample, each carrying one RGB channel.
- `whenReadyToRefine()` returns `Promise<boolean>`: `true` when sampling was queued. Code typed against `Promise<void>` needs updating.
- `gpuSampleTimeMs` also reports tiled samples, extrapolated from tile GPU time.

### Deprecated

Use `render.refineUntil()` instead of these. They keep working and will be removed in a later release.

- `render.whenReadyToRefine()`
- `render.gpuSampleTimeMs`
- The `targetBatchTimeMs` and `deferResolve` options of `render.refine()`

### Performance

- RenderLoop keeps sampling expensive tiled renders between display frames instead of waiting for the next frame.

### Fixed

- Fixed-size renders, `readPixels()` and image exports return exactly the requested dimensions and keep their framing.
- Renders with different caustic or shader settings no longer stall each other at 0 samples. Shader compilation keeps accumulated samples, and returning to a compiled configuration no longer waits for an obsolete compilation.
- RenderLoop applies scene edits after a stalled preview denoiser, and resumes after caustic settings change on a finished render.
- A cancelled denoiser that does not settle within 10 seconds no longer blocks later denoising, and new meshes no longer wait for obsolete BVH preparation.
- Caustics stay visible in high-resolution renders and across clear interfaces.
- Small spot lights no longer show precision banding.
- One-sided emitters no longer emit from their back faces on secondary hits.
- WebGL 2 samples emissive meshes as lights, so small emitters no longer produce heavy noise.
- WebGL 2 keeps accumulated lighting when a path escapes to a flat or texture background.
- WebGL 2 renders a selected AOV channel when it is the first thing drawn after a scene change, instead of staying at 0 samples.

## 0.2.0 - 2026-10-28

Faster WebGPU rendering, surface AOVs and procedural skies.

### Performance

Compared with v0.1.5, WebGPU shader compilation and rendering are faster across a 10-scene glTF benchmark (geometric means across scenes):

| GPU | Shader compilation | Render time |
| --- | ---: | ---: |
| Apple M4 Max | -53.8% | -25.6% |
| NVIDIA RTX 4060 Laptop GPU (Windows 11) | -74.5% | -40.9% |

Results vary by scene, hardware, GPU load and shader cache.

<details>
<summary>Per-scene results</summary>

Chrome 156, WebGPU, 1280×720, full-frame rendering without tiling, 3 bounces, denoising off. Render time is 32 samples after warmup, excluding loading, preparation and shader compilation, and waits for GPU completion. Each run uses the median of three measurements; results are medians of three runs. M4 Max shader compilation times are from the previous measurements. Values are v0.1.5 → v0.2.0 in seconds.

Windows uses driver 617.42, comparing `a646620` → `08d6c63`, with `maxTiles=1`, Sobol sampling, atlas textures and 8 samples per batch. Each process warms up for 8 samples before three 32-sample renders; timings include scheduling and post-processing but exclude pixel readback. Fresh profiles, disabled shader disk caching and unique shader function names do not guarantee an empty driver cache. Across the three Windows rounds, compilation reductions ranged from 74.5% to 74.7%, and render-time reductions from 40.6% to 40.9%.

| Scene | M4 Max compile | M4 Max render | RTX 4060 compile | RTX 4060 render |
| --- | ---: | ---: | ---: | ---: |
| Classroom 2 | 2.32 → 1.15 | 3.49 → 2.52 | 8.082 → 2.154 | 7.181 → 5.153 |
| Bathroom | 2.34 → 1.01 | 3.20 → 2.49 | 8.043 → 1.913 | 5.343 → 3.801 |
| BMW M6 | 2.13 → 0.88 | 1.55 → 0.97 | 7.210 → 1.490 | 2.870 → 1.524 |
| House | 2.15 → 0.93 | 1.63 → 1.30 | 7.238 → 1.603 | 4.468 → 2.167 |
| Kitchen | 2.12 → 0.92 | 2.69 → 1.98 | 7.247 → 1.750 | 5.832 → 3.065 |
| Blender Cover Remix | 2.35 → 1.15 | 1.34 → 0.91 | 8.193 → 2.422 | 2.078 → 1.437 |
| LEGO Technic Bugatti Chiron | 2.13 → 1.01 | 1.46 → 1.15 | 7.109 → 1.807 | 4.142 → 2.026 |
| 2025 Yamaha MT-09 SP V4 | 2.34 → 1.16 | 1.97 → 1.62 | 8.176 → 2.401 | 4.446 → 3.005 |
| Gelatinous Cube | 2.31 → 1.15 | 2.60 → 2.02 | 8.104 → 2.403 | 5.025 → 3.390 |
| Dragon | 2.16 → 1.03 | 1.76 → 1.32 | 7.574 → 1.886 | 3.896 → 1.904 |

Earlier Windows 360p timings included excessive tile submissions in Classroom 2 and Kitchen. This rerun disables tiling in both versions to exclude that scheduling issue from the comparison.

</details>

### Added

- Surface AOVs (`render.aovs`, `aovSamples`): depth, position, ID, motion and directional reflectance, on WebGPU and WebGL 2. View them with `display.channel`, read them back, or pass them to a custom denoiser.
- `render.refine(kind)` traces a single AOV without adding beauty samples.
- `batchSamples` lets one `refine()` call submit several samples within its time budget, so still renders are no longer limited to one sample per frame. Thanks to [@cedricpinson](https://github.com/cedricpinson) for the report and prototype ([#11](https://github.com/pissang/mutracer/issues/11)).
- `ProceduralSky`: clear-sky environment textures.
- `EquirectBackground` with `intensity` and rotation, synced from Three.js `backgroundIntensity` and `backgroundRotation`. Thanks to [@cedricpinson](https://github.com/cedricpinson) for the rotation report and proposed fix ([#9](https://github.com/pissang/mutracer/issues/9)).
- Experimental WebGPU bindless material textures (`textureBinding: 'auto'`), falling back to the texture atlas.

### Changed

- SDR display and denoising use exact sRGB encoding on all backends instead of the browser's gamma 2.2 approximation. Dark and midtone pixels may look slightly different.
- Progressive denoising updates are at least 500 ms apart.

### Deprecated

- `allowMultipleSamplesPerFrame`; use `batchSamples`.

### Fixed

- Public TypeScript declarations resolve under NodeNext module resolution with `skipLibCheck` off.
- Shadow catcher contact shadows no longer weaken under environment light from below the receiver, or near emissive meshes on WebGPU. Thanks to [@cedricpinson](https://github.com/cedricpinson) for the emissive-mesh report and proposed fix ([#10](https://github.com/pissang/mutracer/issues/10)).
- WebGL 2 waits for asynchronously compiled shaders before drawing.
- Diagnostic channels show their original images without color denoising; native albedo display now matches the browser.
- Native HDR presentation applies JNLM to extended-range output and can show completed display-linear denoising results.

## 0.1.5 - 2026-10-22

### Fixed

- Coat normals no longer inherit the base normal map. Assign the same texture to both maps to perturb both layers. Thanks to [@BruceCherniak](https://github.com/BruceCherniak) ([#8](https://github.com/pissang/mutracer/issues/8)).

## 0.1.4 - 2026-10-21

### Added

- Environment and grounded skybox intensity and rotation, synchronized from Three.js scenes.
- Per-axis texture wrapping (repeat, clamp-to-edge, mirrored-repeat).
- Explicit sRGB or linear decoding for color textures, preserved from Three.js.

### Fixed

- Three.js conversion keeps vertex colors. Thanks to [@zz85](https://github.com/zz85) ([#7](https://github.com/pissang/mutracer/issues/7)).
- Three.js conversion keeps back-side materials and half-float or R/RG/RGB/RGBA data textures.
- Converted equirectangular environments match Three.js orientation. Thanks to [@zz85](https://github.com/zz85) ([#6](https://github.com/pissang/mutracer/issues/6)).
- Fully metallic glTF materials without a metalness map ignore specular settings, as in glTF. Thanks to [@BruceCherniak](https://github.com/BruceCherniak) ([#4](https://github.com/pissang/mutracer/issues/4)).
- Spot light falloff between the inner and outer cones. Thanks to [@zz85](https://github.com/zz85) ([#5](https://github.com/pissang/mutracer/issues/5)).

## 0.1.3 - 2026-10-19

### Changed

- `webgpu-utils` is no longer a dependency.

### Fixed

- Adding untextured lights after a scene update. Thanks to [@ertugrulerkan](https://github.com/ertugrulerkan) ([#1](https://github.com/pissang/mutracer/issues/1)).
- WebGPU shadow catcher edges over opaque flat backgrounds, and OIDN artifacts around silhouettes over shadow catchers.

## 0.1.2 - 2026-10-16

### Added

- `displacementBias` (default `0`) for signed displacement offsets on WebGPU.

### Changed

- `displacementStepSize` defaults to `0` (1/32 of the displacement height). Set `0.01` for the previous behavior.
- Three.js materials without a displacement map convert with MuTracer's default height `0.1` instead of `1`.

### Fixed

- Displacement updates after map, image or height edits, including shared geometry, and stays consistent under scaled transforms.
- WebGL 2 renders the undisplaced surface when displacement settings are present.
- Stationary clicks with Three.js controls keep accumulated samples.

## 0.1.1 - 2026-10-14

### Changed

- Interactive previews adapt resolution to frame latency.

### Fixed

- Denoised previews stay responsive during interaction and transition smoothly to the final render.
- Three.js camera damping settles reliably.
- Animation and incremental geometry updates keep prepared BVHs.
- Shadow catcher denoising uses albedo and normal guides.

## 0.1.0 - 2026-10-14

### Added

- Progressive path tracing on WebGPU with a WebGL 2 fallback.
- Area, sphere, spot/IES, directional and environment lights with MIS.
- OpenPBR 1.1 materials.
- Worker-built static BVHs (TypeScript SAH or TinyBVH WebAssembly) with instance refits.
- OIDN denoising for previews and final images.
- Three.js scene conversion and synchronization with `THREESceneSync`.
- Sobol, ZSobol and random sampling, deterministic offline rendering and adaptive sampling.
- Tone mapping, color grading, bloom, shadow catchers, transparent backgrounds and depth of field.
