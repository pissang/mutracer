# Examples

```bash
npm install
npm run dev
```

Then open <http://localhost:3001/examples/>.

| Example | Shows |
| --- | --- |
| [`basic`](./basic.ts) | Minimal setup: `Engine`, `Render`, `Mesh`, `OpenPBRMaterial`, `RectLight`, `EnvironmentLight`, `THREESync`, `OrbitControls` and `RenderLoop`. |
| [`three`](./three.ts) | Building the scene in Three.js (`GLTFLoader`, `OrbitControls`, `MeshPhysicalMaterial`) and rendering it with `THREESync` / `RenderLoop`; rotation and a roughness slider for incremental material edits. |
| [`animation`](./animation.ts) | A procedural skinned cylinder, bone animation and a morph slider; pause animation to accumulate a clean image. Both backends support `?webgl`. |
| [`instancing`](./instancing.ts) | Native InstancedMesh with per-instance colors, shared geometry/materials and array notifications. |
| [`temporal-stress`](./temporal-stress.ts) | A deterministic noisy room for `TemporalDenoiser` at 1–3 spp: mirror, curved metals, glass, animated emitters and materials, moving props, a camera cut and a focus pull. WebGL renders without temporal denoising. `node scripts/temporal-stress-capture.mjs OUT_DIR` renders frames in headless Chrome; [`temporal-stress.shot.mjs`](./temporal-stress.shot.mjs) renders the same shot with the [Node CLI](../cli/README.md). |
| [`advanced`](./advanced.ts) | Coat, transmission with dispersion, subsurface, fuzz and thin-film materials; a shadow catcher with a transparent background; `render.setDenoiser()`; a `samplingPattern` selector (Sobol, ZSobol, random); `render.converge()` and PNG export. |

For an interactive app with drag-and-drop glTF/HDR loading, a scene tree,
material, lighting and render controls, and PNG export, run the
[viewer](../viewer/README.md) with `npm run viewer`.

The examples import `@meimu/mutracer`, which the dev server aliases to `src/`. All
assets are procedural or generated: [`assets/chess.glb`](./assets/chess.glb)
comes from [`scripts/create-example-model.mjs`](../scripts/create-example-model.mjs)
(CC0) and the sky is built in [`shared/sky.ts`](./shared/sky.ts).
