<div align="center">

<img src="site/src/assets/mutracer-logo.png" alt="" width="72" />

# MuTracer

**Physically based path tracing in the browser.**

WebGPU first with a WebGL 2 fallback · OpenPBR 1.1 materials · MaterialX node graphs · OIDN denoising

[![npm version](https://img.shields.io/npm/v/@meimu/mutracer)](https://www.npmjs.com/package/@meimu/mutracer)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**[Open the viewer](https://mutracer.meimu-studio.com/viewer/)** ·
[Website](https://mutracer.meimu-studio.com/) ·
[Docs](./docs) ·
[Examples](https://mutracer.meimu-studio.com/examples/) ·
[Changelog](./CHANGELOG.md)

<a href="https://mutracer.meimu-studio.com/viewer/#model=crystal-lens"><img src="https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/crystal-lens/thumbnail.webp" alt="Crystal Lens path traced in MuTracer with dispersion and caustics" width="100%" /></a>

<sub>Crystal Lens, path traced with dispersion and caustics in a browser tab · <a href="https://github.com/pissang/mutracer-assets">Yi Shen</a>, CC0</sub>

</div>

## Quick start

```bash
npm install @meimu/mutracer three
```

Keep building your scene with Three.js; `THREESync` converts it once and follows
transform, material and light edits on every frame.

```ts
import { Engine, RenderLoop } from '@meimu/mutracer';
import { THREESync } from '@meimu/mutracer/three';

const engine = new Engine({ canvas });
const sync = new THREESync(engine, { scene, camera, controls });
const loop = new RenderLoop(engine, { sync });
loop.start();

loop.final.setDenoiser({ type: 'oidn' }); // denoise the converged frame (WebGPU)
```

More starting points are [below](#more-ways-to-start), and the
[getting started guide](./docs/getting-started.md) covers the scene model,
render loop, lights and export.

## Highlights

| | |
| --- | --- |
| **Light transport** | Progressive unidirectional path tracing with next-event estimation and MIS over rect, disk, cylinder, sphere, IES spot, directional and HDR environment lights. Continuous-wavelength dispersion. [Caustics](./docs/caustics.md) on WebGPU. |
| **Materials** | The [OpenPBR 1.1](./docs/materials.md) surface: F82 metals, anisotropic specular and coat, fuzz, thin film, dispersive transmission with volume scattering, subsurface scattering and displacement. Drive any input from [material graphs](./docs/material-graphs.md) or [MaterialX documents](./docs/materialx.md). |
| **Large scenes** | Two-level BVH with binned-SAH BLASes built in parallel Workers (JavaScript or TinyBVH WebAssembly). Moving instances only refits the TLAS; new meshes upload only their geometry. See [performance](#performance). |
| **Clean images** | Owen-scrambled Sobol or blue-noise ZSobol samples, variance-driven adaptive sampling, and albedo- and normal-guided [denoising](./docs/denoising.md) with Intel OIDN (WebGPU) or JNLM (both backends). |
| **Output** | Deterministic `converge()`, AgX, ACES and other tone mappers, bloom, thin-lens depth of field, shadow catchers, transparent backgrounds, AOVs, HDR output and PNG export. |
| **Integration** | Incremental [Three.js sync](./docs/threejs.md), your own `GPUDevice`, OffscreenCanvas workers and display [post-processing passes](./docs/post-processing.md). Without WebGPU, the same code renders on WebGL 2. |

## New in 0.4

- **Material graphs**: drive OpenPBR inputs from a [`MaterialGraph`](./docs/material-graphs.md)
  of MaterialX nodes. WebGPU compiles procedural graphs; both backends render image graphs.
- **MaterialX import**: [`parseMaterialX`](./docs/materialx.md) from `@meimu/mutracer/materialx`.
  The viewer ships 55 procedural samples and browses the GPUOpen MaterialX Library.
- **Instant material edits** with [`shaderPrefetch: 'editing'`](./docs/updates.md#editing-prefetch).
- [`UdimTexture`](./docs/materials.md#udim-textures), [`DiskLight` and `CylinderLight`](./docs/getting-started.md#lights),
  pixel-center [AOVs](./docs/api.md#surface-outputs), [`mesh.visible`](./docs/updates.md#visibility)
  and incremental geometry uploads.
- **Breaking:** import the Three.js adapter from `@meimu/mutracer/three`.

See the [changelog](./CHANGELOG.md) for the full list.

## Gallery

Rendered live in the browser. Click an image to open the scene in the viewer.

<table>
  <tr>
    <td width="33%"><a href="https://mutracer.meimu-studio.com/viewer/#model=yamaha-mt-09"><img src="https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/yamaha-mt-09/thumbnail.webp" alt="2025 Yamaha MT-09 SP V4" /></a><br /><sub>Yamaha MT-09 · metal and coat · <a href="https://sketchfab.com/3d-models/2025-yamaha-mt-09-sp-v4-cb5878baf5974167806eb8524d57f0b0">VTX</a>, CC-BY-NC-SA 4.0</sub></td>
    <td width="33%"><a href="https://mutracer.meimu-studio.com/viewer/#model=super-human"><img src="https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/super-human/thumbnail.webp" alt="Super Human" /></a><br /><sub>Super Human · subsurface skin · <a href="https://sketchfab.com/3d-models/super-human-7aa58e978b9f4357b8e73d8e0440c896">Davyd Vidiger</a>, CC-BY 4.0</sub></td>
    <td width="33%"><a href="https://mutracer.meimu-studio.com/viewer/#model=gelatinous-cube"><img src="https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/gelatinous-cube/thumbnail.webp" alt="Gelatinous Cube" /></a><br /><sub>Gelatinous Cube · transmission · <a href="https://sketchfab.com/3d-models/gelatinous-cube-e08385238f4d4b59b012233a9fbdca21">glenatron</a>, CC-BY-NC 4.0</sub></td>
  </tr>
  <tr>
    <td width="33%"><a href="https://mutracer.meimu-studio.com/viewer/#model=crystal-lens"><img src="https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/crystal-lens/thumbnail.webp" alt="Crystal Lens" /></a><br /><sub>Crystal Lens · dispersion · <a href="https://github.com/pissang/mutracer-assets">Yi Shen</a>, CC0</sub></td>
    <td width="33%"><a href="https://mutracer.meimu-studio.com/viewer/#model=blender-cover-remix"><img src="https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/blender-cover-remix/thumbnail.webp" alt="Blender Cover Remix" /></a><br /><sub>Blender Cover Remix · characters · <a href="https://sketchfab.com/3d-models/blender-cover-remix-a38f11890ff141c88fcdac6b637fdaf8">bandinopla</a>, CC-BY 4.0</sub></td>
    <td width="33%"><a href="https://mutracer.meimu-studio.com/viewer/#model=spheres"><img src="https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/spheres/thumbnail.webp" alt="OpenPBR material spheres" /></a><br /><sub>Material spheres · OpenPBR layers · procedural, CC0</sub></td>
  </tr>
</table>

## Performance

<a href="https://mutracer.meimu-studio.com/viewer/#model=bugatti-chiron"><img src="https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/bugatti-chiron/thumbnail.webp" alt="LEGO Technic Bugatti Chiron rendered in MuTracer" width="480" /></a>

The [LEGO Technic Bugatti Chiron](https://mutracer.meimu-studio.com/viewer/#model=bugatti-chiron)
(<a href="https://sketchfab.com/3d-models/lego-technic-bugatti-chiron-c2a54e2e979a4905b859c1533b498221">VTX</a>, CC-BY-NC-SA 4.0)
is a heavy scene that path traces interactively in the viewer:

| | Bugatti Chiron |
| --- | --- |
| Rendered triangles | 4.6 M (2.5 M unique, 341 geometries in 560 meshes) |
| Materials | 35 |
| Download | 12.8 MB `.glb` |
| BVH build, 1 thread | 1.7 s (built-in builder) / 1.0 s (TinyBVH WebAssembly) |
| BVH build, 4 workers (default) | 0.50 s (built-in builder) / 0.28 s (TinyBVH WebAssembly) |
| 1920 × 1080, 64 spp | 12.1 s path tracing, 12.4 s with OIDN denoising |

Measured on an Apple M4 Max: rendering in Chrome with WebGPU at the viewer's
default settings (6 bounces), BVH builds on CPU threads excluding worker startup.

## More ways to start

<details>
<summary><b>Load a glTF with Three.js</b></summary>

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Engine, RenderLoop } from '@meimu/mutracer';
import { THREESync } from '@meimu/mutracer/three';

const canvas = document.querySelector('canvas')!;

const scene = new THREE.Scene();
scene.add((await new GLTFLoader().loadAsync('model.glb')).scene);

const camera = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, .1, 100);
camera.position.set(0, 2, 6);
const controls = new OrbitControls(camera, canvas);

const engine = new Engine({ canvas });
const sync = new THREESync(engine, { scene, camera, controls });
const loop = new RenderLoop(engine, { sync });
loop.start();
```

Custom Three.js materials and lights can use `convertMaterial` / `convertLight`
in the same sync options; see [Three.js integration](./docs/threejs.md).

</details>

<details>
<summary><b>Describe a scene with MuTracer classes</b></summary>

```ts
import { mat4 } from 'gl-matrix';
import {
  Camera, EnvironmentLight, Mesh, OpenPBRMaterial, RectLight, Engine, RenderLoop,
  Texture, createPlaneGeometry, createSphereGeometry, type Scene
} from '@meimu/mutracer';

const canvas = document.querySelector('canvas')!;

const red = new OpenPBRMaterial({ baseColor: [0.8, 0.1, 0.1], specularRoughness: 0.3 });

const ball = new Mesh(createSphereGeometry(64, 32), red);
mat4.fromTranslation(ball.transform, [0, 1, 0]);

const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial());
mat4.fromScaling(floor.transform, [5, 1, 5]);

// Rect lights emit along their local -Z axis.
const light = new RectLight({ size: [2, 2], color: [1, 1, 1], intensity: 5 });
mat4.fromTranslation(light.transform, [0, 4, 0]);
mat4.rotateX(light.transform, light.transform, -Math.PI / 2);

// A constant grey sky as a 1x1 float environment map.
const sky = new Texture({ data: new Float32Array([0.3, 0.3, 0.3, 1]), width: 1, height: 1 });

const scene: Scene = {
  meshes: [ball, floor],
  lights: [light, new EnvironmentLight({ map: sky })]
};

const camera = new Camera({ projection: 'perspective', fov: 40, near: .1, far: 100 });
camera.position = [0, 2, 6];
camera.lookAt([0, 1, 0]);

const engine = new Engine({ canvas });
engine.on('error', error => console.error(error));
engine.scene = scene;
engine.camera = camera;
const loop = new RenderLoop(engine);
loop.start();
```

For many copies of one geometry, use [`InstancedMesh`](./docs/updates.md#instanced-meshes)
with shared materials and a Float32 matrix array. See the [instancing example](./examples/instancing.ts).

</details>

<details>
<summary><b>Import a MaterialX material</b></summary>

```ts
import { OpenPBRMaterial } from '@meimu/mutracer';
import { parseMaterialX } from '@meimu/mutracer/materialx';

const { values, graph } = parseMaterialX(await (await fetch('marble.mtlx')).text());
mesh.material = new OpenPBRMaterial({ ...values, graph });
engine.update();
```

Image-based documents also need their textures loaded; see
[parsing MaterialX documents](./docs/materialx.md).

</details>

<details>
<summary><b>Control rendering and output</b></summary>

```ts
loop.final.setDenoiser({ type: 'jnlm' }); // both backends
Object.assign(loop.final, { bounces: 12, maxSamples: 1024 });
Object.assign(engine.display, { toneMapping: 'agx', toneMappingExposure: 1.2 });

const image = await engine.display.toBlob(loop.final); // PNG
```

Settings are typed by `RenderSettings` and `DisplaySettings`; see the
[API reference](./docs/api.md). For custom frame control, use Engine, Render and
Display directly; see [independent render results](./docs/progressive-rendering.md).

</details>

## Packages

| Import | Contents |
| --- | --- |
| `@meimu/mutracer` | Engine, renders, display, scene classes, material graphs |
| `@meimu/mutracer/three` | `THREESync` and Three.js scene conversion; needs `three` (and `@types/three` for TypeScript) |
| `@meimu/mutracer/materialx` | `parseMaterialX` |
| `@meimu/mutracer/oidn` | OIDN weight helpers |

The package is ESM with TypeScript declarations. A UMD build with a `MuTracer`
global is at `dist/mutracer.umd.js`; deploy its `dist/assets/` alongside it. See
[loading and deployment](./docs/getting-started.md#loading-and-deployment).

**Browsers:** WebGPU (current Chrome, Edge and Safari) is recommended and required
for OIDN, caustics, HDR output and options marked WebGPU in the
[API reference](./docs/api.md). The WebGL 2 fallback needs `EXT_color_buffer_float`.
The first frame compiles large shaders, which can take several seconds.

## Documentation

| Guide | Contents |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Scene model, render loop, lights, export, workers, your own `GPUDevice` |
| [Scene updates](./docs/updates.md) | Editing a rendering scene, animation, visibility, update costs |
| [API reference](./docs/api.md) | Engine, Display and Render options, methods and scene types |
| [Materials](./docs/materials.md) | OpenPBR inputs, textures, UDIM, alpha, bevel, displacement |
| [Material graphs](./docs/material-graphs.md) | Procedural and image node graphs on OpenPBR |
| [MaterialX](./docs/materialx.md) | Parsing `.mtlx` documents |
| [Three.js](./docs/threejs.md) | `THREESync`, supported materials and lights, `userData` keys |
| [Progressive rendering](./docs/progressive-rendering.md) | Independent renders, sample batching, fallbacks |
| [Caustics](./docs/caustics.md) | Light tracing and photon mapping (WebGPU) |
| [Denoising](./docs/denoising.md) | JNLM and OIDN denoisers, OIDN weights hosting |
| [Post-processing](./docs/post-processing.md) | Display passes, GPU output textures, upscaling |
| [Sampling](./docs/sampling.md) | Patterns, dimensions and progressive budgets |
| [BVH](./docs/bvh.md) | BVH builders, TinyBVH layouts, worker preparation |
| [Performance](./docs/performance.md) | Tuning checklist |
| [Viewer](./docs/viewer.md) | Using the online viewer, MaterialX import, shareable links |
| [`llms.txt`](./llms.txt) | Compact usage guide for coding agents |

Run the [examples](./examples) locally with `npm install` and `npm run dev`.

## Contributing

Pull requests are not accepted at the moment; please open an
[issue](https://github.com/pissang/mutracer/issues) instead. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, required checks
and GPU validation.

## License

MuTracer is released under the [MIT License](./LICENSE). It includes third-party
code and data under MIT, Apache-2.0 and CC0 licenses; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Gallery models keep their
own licenses, linked under each image.
