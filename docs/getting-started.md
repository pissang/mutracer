# Getting started

## Concepts

MuTracer renders a plain **scene description** with a **camera**:

```ts
interface Scene {
  meshes: Mesh[];          // geometry + one OpenPBRMaterial per group
  lights: SceneLight[];    // analytic lights, environment and ambient light
  background?: ColorRGBA | Texture | GroundedSkyboxBackground;
}
```

- `Mesh(geometry, material)` places a `Geometry` in the world with
  `mesh.transform` (a column-major `mat4`, compatible with `gl-matrix`).
- `Geometry` holds indexed or non-indexed triangle attributes. Use the helpers
  `createPlaneGeometry`, `createCubeGeometry`, `createSphereGeometry` or build
  one from arrays (see below).
- Materials are `OpenPBRMaterial` instances. See [materials](./materials.md).
- Units are arbitrary but consistent; light intensities are in radiometric
  units relative to them.

`Engine` commits scene and camera changes, `Render` accumulates samples, and
`Display` presents an image. See [independent render results](./progressive-rendering.md).

## A minimal render loop

```ts
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Engine, RenderLoop, THREESync } from '@meimu/mutracer';
const engine = new Engine({canvas});
engine.scene = scene;
const camera = new THREE.PerspectiveCamera(40, 1, .1, 100);
camera.position.set(0, 2, 6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 0);
const sync = new THREESync(engine, {camera, controls});
const loop = new RenderLoop(engine, {sync, final: {maxSamples: 1024, bounces: 5}});
function resize() {
  const ratio = Math.min(devicePixelRatio, 2);
  engine.display.setSize(canvas.clientWidth * ratio, canvas.clientHeight * ratio);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize(); loop.start();
```

RenderLoop synchronizes sources, commits changes and presents preview or final.
Subscribe to `loop.on('status', ...)` for UI and `engine.on('progress', ...)`
for preparation progress. Engine chooses WebGPU with WebGL 2 fallback.
Preparation is automatic; see [BVH](./bvh.md) for optional CPU preparation.

For custom frame control, use `loop.tick()` in your own animation frame instead
of `start()`. For explicit rendering without the built-in policy, use
[Engine / Render / Display directly](./progressive-rendering.md#explicit-frame-control).

## Geometry from arrays

```ts
import { Geometry, GeometryAttribute } from '@meimu/mutracer';

const geometry = new Geometry({
  position: new GeometryAttribute(new Float32Array(positions), 3),
  indices: new GeometryAttribute(new Uint32Array(indices), 1),
  uv: new GeometryAttribute(new Float32Array(uvs), 2) // optional
});
```

Only `position` is required. Omitting `indices` generates sequential indices; omitting `normal` generates smooth area-weighted normals. Read `geometry.vertexCount` and `geometry.triangleCount` for counts.

For several materials on one geometry, pass an array of materials to `Mesh`
and set `geometry.materialIndex` to an `Int32Array` attribute with `itemSize: 1` and one raw index
into `mesh.materials` per vertex.

Place nodes by assigning `node.position = [x, y, z]` and calling `node.lookAt(target, up?)`. `position` reads a copy; assign it back to move the node.

## Cameras

```ts
const camera = new Camera({ projection: 'perspective', fov: 45, near: 0.1, far: 100 });
camera.position = [0, 2, 6]; camera.lookAt([0, 0, 0]);
```

`camera.aspect` defaults to undefined, so rendering uses the canvas width/height.
Explicitly set it to lock a perspective aspect ratio. `copy(source)` and `clone()`
copy camera settings; `getProjectionMatrix(targetAspect = 1)` includes zoom.

For orbit/pan/zoom, use Three.js OrbitControls with THREESync as above.
`fromTHREECamera` remains available for one-shot camera conversion.

### Depth of field

Depth of field uses a thin lens described in photographic terms:

```ts
camera.fStop = 2.8;          // f-number; 0 (default) disables depth of field
camera.focusDistance = 6;    // lens to focus plane, along the view direction
camera.sensorHeight = 24;    // mm; with fov it sets the focal length
camera.metersPerUnit = 1;    // scene unit length in metres (glTF: 1)
```

The focal length is `0.5 * sensorHeight * zoom / tan(fov / 2)` in millimetres
(convert `fov` from degrees to radians). The aperture radius is
`focalLength / (2 * fStop)` in millimetres, then divided by
`1000 * metersPerUnit` to obtain scene units. A narrower field of view or a
lower f-number blurs more, as on a real camera.

`metersPerUnit` converts the lens size to scene units. When a scene is modelled
in centimetres set it to `0.01`. For a miniature look, treat the scene as
smaller than it is (`0.1` turns a 2 m object into a 20 cm one). Orthographic
cameras have no depth of field.

## Lights

| Class | Constructor | Notes |
| --- | --- | --- |
| `RectLight` | `{ size?, color?, intensity?, texture?, spread? }` | One-sided, emits along local -Z |
| `DiskLight` | `{ radius?, color?, intensity?, normalize? }` | One-sided local-XY disk, emits along local -Z |
| `CylinderLight` | `{ length?, radius?, color?, intensity?, normalize?, treatAsLine? }` | Lateral surface around local X; end caps do not emit |
| `SphereLight` | `{ radius?, color?, intensity? }` | Spherical emitter; radius 0 is a point |
| `SpotLight` | `{ color?, intensity?, radius?, innerAngle?, outerAngle?, iesProfile? }` | Cone, optional IES emission |
| `DirectionalLight` | `{ color?, intensity? }` | Emits along local -Z |
| `AmbientLight` | `{ color?, intensity? }` | Uniform environment radiance |
| `EnvironmentLight` | `{ map }` | Equirectangular HDR illumination |

Place analytic lights with `light.position = [x, y, z]` and `light.lookAt(target)`.
Their transform scale is ignored; `size` and `radius` set emitter dimensions.
Disk and cylinder defaults match UsdLux (`radius: 0.5`, cylinder `length: 1`).
When `normalize` is true, radiance is divided by disk or cylinder lateral area,
keeping power constant as dimensions change. `CylinderLight.treatAsLine` is an
interchange hint; MuTracer always samples the finite-radius area light. These
lights do not accept `RectLight` textures or `spread`.
Local +X is the IES azimuth reference; rotate the transform around local Z to
orient a profile. Invalid mutable values are clamped and reported once without
failing the render (through `error` events when attached).

Load `.hdr` environments with `await loadRGBE(url)`, which resolves to a
float `Texture`. Emissive materials (`emissionLuminance > 0`) also act as
lights. A scene supports at most 1,024 analytic lights. Storage and scene-update
upload cost grow with the count. WebGPU uses constant-time power-weighted
selection; WebGL recompiles when the count changes and searches its light CDF.

## Backgrounds

- omitted: camera rays show the environment light;
- `[r, g, b, a]`: a linear color. `[0, 0, 0, 0]` gives a transparent canvas;
  combine with `shadowCatcher` materials to composite over a web page;
- a `Texture`: an equirectangular background independent of the lighting;
- `{ type: 'GroundedSkybox', map, height, radius }`: projects the environment
  onto a ground plane.

## Updating the scene

Keep the same scene and edit it in place. `engine.update()` detects property
assignments, scene membership, transforms, materials, lights and backgrounds.
In-place edits to array or image contents need a notification:

```ts
texture.markUpdated();                // texture pixels or UV-array elements

geometry.markVerticesUpdated();       // vertex attributes only
geometry.markUpdated();               // indices, materialIndex or other geometry data
instancedMesh.markTransformsUpdated(); // instance matrix elements
instancedMesh.markColorsUpdated();     // instance color elements
instancedMesh.markUpdated();           // both instance matrices and colors
```

See [scene updates](./updates.md) for vertex animation and update costs. RenderLoop calls its syncs automatically. With explicit frame control, call `sync.update()` before engine.update;
see [Three.js](./threejs.md).

## Exporting an image

For a final-quality still, use a render's deterministic convergence:

```ts
await loop.converge({samples: 1024, sampleSequenceOffset: 0});
const blob = await engine.display.toBlob(loop.final);
const hdr = await loop.final.readPixels('hdr');
```

Readback returns RGBA Float32Array values, top row first. A separate fixed-size
Render can export another resolution or a copied camera override without
changing the canvas. See [exporting](./progressive-rendering.md#reading-and-exporting).

Call `loop.dispose()`, `sync.dispose()`, `controls.dispose()` and `engine.dispose()`
when finished. See [ownership](./progressive-rendering.md#options-and-ownership).

## Using your own GPUDevice

```ts
import { Engine, getRecommendedDeviceDescriptor } from '@meimu/mutracer';
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error('WebGPU unavailable');
const device = await adapter.requestDevice(getRecommendedDeviceDescriptor(adapter));
const engine = new Engine({ canvas, device });
await engine.init();
```

The caller owns the device and releases it after all engines using it have been
disposed. Supplying a device selects WebGPU; `backend: 'webgl'` is rejected.
See [device requirements](./api.md#device-requirements) for limits and OIDN.

## Running in a worker

Transfer the display canvas once from the main thread:

```ts
const worker = new Worker(new URL('./render.worker.ts', import.meta.url), {type: 'module'});
const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({canvas: offscreen, width: 800, height: 600}, [offscreen]);
```

In `render.worker.ts`, construct the scene and camera in the worker:

```ts
import {Engine, RenderLoop, Camera, Mesh, OpenPBRMaterial,
  AmbientLight, createSphereGeometry} from '@meimu/mutracer';
self.onmessage = ({data}) => {
  const engine = new Engine({canvas: data.canvas});
  engine.display.setSize(data.width, data.height);
  engine.scene = {
    meshes: [new Mesh(createSphereGeometry(), new OpenPBRMaterial())],
    lights: [new AmbientLight({intensity: 1})],
  };
  engine.camera = new Camera({projection: 'perspective'});
  engine.camera.position = [0, 0, 4]; engine.camera.lookAt([0, 0, 0]);
  const loop = new RenderLoop(engine);
  loop.start();
  self.onmessage = ({data}) => {
    if (data.type === 'stop') loop.stop();
    if (data.type === 'start') loop.start();
    if (data.type === 'resize') engine.display.setSize(data.width, data.height);
    if (data.type === 'dispose') {loop.dispose(); engine.dispose();}
  };
};
```

Engine accepts HTMLCanvasElement or OffscreenCanvas. Without `document`, the
omitted canvas defaults to a new OffscreenCanvas. Texture accepts ImageBitmap
and OffscreenCanvas as well as HTML images/canvases and raw pixels. Export with
`await engine.display.toBlob(render)` as on the main thread; offscreen displays
use `convertToBlob`. Worker-created caller-owned GPUDevice instances use the
same [host integration](#using-your-own-gpudevice) options.

Workers have no page visibility event, so the loop keeps running until stopped.
Forward visibility decisions from the main thread using stop/start messages.
Without requestAnimationFrame, the loop uses a 16 ms timer. THREESync can
synchronize a Three.js scene and camera in the worker; DOM-based controls
remain on the main thread and their interaction/camera changes must be forwarded.

BVH preparation creates nested workers when Worker is available. If startup or
transport fails, it falls back to building in the calling thread (the render
worker here). Asset URLs stay relative to the library/module, as on the main
thread. Browser support for OffscreenCanvas and each GPU backend is required.

## Loading and deployment

With npm, import the public API as usual:

```ts
import { Engine, Render } from '@meimu/mutracer';

const engine = new Engine({canvas});
const render = new Render(engine);
render.setDenoiser({type: 'oidn'});
```

MuTracer initializes OIDN and loads its model weights automatically when a
render first prepares its OIDN denoiser on WebGPU. With code splitting enabled,
its runtime code is also fetched only at that point; importing the package,
initializing an engine, or using JNLM does not fetch it. Selecting
`engine.bvhBuilder = 'tinybvh'` loads its WASM when a BVH is first built; the
calling thread and BVH workers use the same asset URL. No separate runtime
imports or asset-loading calls are needed. See [denoising](./denoising.md#hosting-the-weights)
for model hosting.

For the standalone UMD build, copy the entire `dist/` directory to your hosting
location, keeping this layout:

```text
mutracer.umd.js
assets/
  bvh.worker.js
```

For example, after copying it to `/vendor/mutracer/`, load
`/vendor/mutracer/mutracer.umd.js` in a script tag to use the `MuTracer` global.
The BVH worker URL resolves relative to the library script.

Standalone asset names are stable. Deploy the script and assets together; use
a versioned directory or package-version URL when caching them for a long time.
Application bundlers may give their own output assets hashed names.

## Bundler notes

The npm ESM entry preserves the dynamic import of the OIDN module. Vite and
webpack builds with code splitting enabled emit it and its dependencies as an
async chunk, fetched on first use. Configuring a single-file build or inlining
dynamic imports can include that code in the main bundle instead; initialization
is still deferred, but its download is no longer deferred.

Vite development prebundles dependencies and can relocate asset URLs. Exclude
MuTracer so the bundled OIDN standard/small weights and the optional TinyBVH
wasm load from the package:

```ts
export default defineConfig({
  optimizeDeps: { exclude: ['@meimu/mutracer'] }
});
```

Vite production builds and webpack 5 copy these assets without extra
configuration. With bundlers that do not support asset URLs, self-host the
OIDN weights with `weightsBaseUrl` (see [denoising](./denoising.md#hosting-the-weights)).
