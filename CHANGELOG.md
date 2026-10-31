# Changelog

All notable changes to MuTracer will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Experimental caustics on WebGPU with `render.caustics`, off by default and ignored on WebGL 2: `lightTracing` for directly visible receivers and `photonMapping` for receivers seen through glass or water. See the [caustics guide](docs/caustics.md).
- `render.refineUntil(deadline, {signal})` refines once, then keeps the GPU busy until the deadline or cancellation, replacing the hand-written refill loop in custom frame loops. See [sample batching](docs/progressive-rendering.md#sample-batching).

### Changed

- Dispersion samples continuous wavelengths on camera paths and caustic photons, so rainbows and dispersive glass form smooth gradients instead of separate red, green and blue images. Scenes with dispersion render differently; `dispersionWavelengths` now counts paths per sample, each carrying one RGB channel.
- `whenReadyToRefine()` resolves to `true` when sampling was queued and `false` otherwise.
- `gpuSampleTimeMs` also reports tiled samples, extrapolated from tile GPU time.

### Performance

- RenderLoop keeps refilling expensive tiled samples between display frames instead of waiting for the next frame.

### Fixed

- WebGL 2 renders a selected AOV channel when it is the first thing drawn after a scene change, instead of staying at 0 samples.
- Renders with different caustic or shader settings no longer stall each other at 0 samples, including a default RenderLoop preview with caustics on `final`. Shader compilation no longer discards accumulated samples, and returning to an already compiled configuration no longer waits for an obsolete compilation.
- RenderLoop reports a failed tick through `status` and the new `lastError`, and commits edits after a stalled preview denoiser. A cancelled denoiser that does not settle within 10 seconds no longer blocks later denoising, and new meshes cancel obsolete BVH preparation.
- WebGL 2 samples emissive meshes as lights, so small emitters illuminate scenes without heavy noise, as on WebGPU.
- One-sided emitters no longer emit from their back faces when hit by secondary rays.
- WebGL 2 keeps accumulated lighting when a path escapes to a flat or texture background.

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
