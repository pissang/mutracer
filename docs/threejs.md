# Three.js integration

Build or load a Three.js scene, then bind it and its camera with THREESync.
RenderLoop calls the sync automatically. Install `three` and import the adapter
from `@meimu/mutracer/three`. For TypeScript, also install `@types/three`
matching your Three.js version.

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Engine, RenderLoop } from '@meimu/mutracer';
import { THREESync } from '@meimu/mutracer/three';
const scene = new THREE.Scene();
scene.add((await new GLTFLoader().loadAsync('model.glb')).scene);
const camera = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, .1, 100);
camera.position.set(0, 2, 6);
const controls = new OrbitControls(camera, canvas);
const engine = new Engine({canvas});
const sync = new THREESync(engine, {scene, camera, controls});
const loop = new RenderLoop(engine, {sync});
loop.start();
```

## Keeping scenes in sync

Edit Three.js transforms, membership, lights, backgrounds and materials directly.
Material edits are converted automatically; color and roughness
edits do not require `material.needsUpdate`. Buffer and pixel edits need the
usual flags:

| Edit | Flag |
| --- | --- |
| Attribute or index array elements | `attribute.needsUpdate = true` (`attribute.data.needsUpdate` for interleaved) |
| Texture pixels or canvas | `texture.needsUpdate = true` |
| Instance matrices / colors | `instanceMatrix.needsUpdate` / `instanceColor.needsUpdate = true` |

```ts
threeMesh.rotation.y += .01;
threeMaterial.roughness = .6;
geometry.attributes.position.setX(0, .5);
geometry.attributes.position.needsUpdate = true;
// The next loop tick synchronizes and commits these edits.
```

For an application-owned animation frame, update the animation mixer first,
then call `loop.tick()`. With first-layer frame control, call `sync.update()`,
`engine.update()`, `render.refine()` and `engine.display.present(render)` in order.

For a library-generated sky, pass `environment: new ProceduralSky()` in the
conversion or sync options. See [ProceduralSky](./api.md#proceduralsky) for
configuration and backend limits.

## What is converted

| Three.js | MuTracer |
| --- | --- |
| `Mesh` with `MeshStandardMaterial` / `MeshPhysicalMaterial` | `Mesh` + `OpenPBRMaterial` (color, metalness, roughness, maps, normal map, emissive, transmission, attenuation, IOR, clearcoat, sheen, iridescence, anisotropy, alpha) |
| `Mesh` with `MeshBasicMaterial` (glTF `KHR_materials_unlit`) | Unlit emissive material |
| `MeshPhysicalMaterial.clearcoat`, `.clearcoatRoughness` (glTF `KHR_materials_clearcoat`) | `coatWeight`, `coatRoughness`, with `coatIor = 1.5` and `coatDarkening = 0` for Three.js compatibility; explicit `userData.mutracerOpenPBR.coatDarkening` overrides the imported value |
| `MeshPhysicalMaterial.sheen`, `.sheenColor`, `.sheenRoughness` | `fuzzWeight`, `fuzzColor`, `fuzzRoughness`; explicit `userData.mutracerOpenPBR.fuzzRoughness` overrides imported roughness |
| `MeshPhysicalMaterial.iridescenceThicknessMap`, `.iridescenceThicknessRange` | `thinFilmMap` with `thinFilmMapChannel = 'g'`; both nm endpoints are divided by 1000 into `thinFilmThicknessMinimum` / `thinFilmThickness`; without a map only the maximum is used |
| `MeshPhysicalMaterial.clearcoatMap`, `.clearcoatRoughnessMap` | `coatWeightMap` (linear R), `coatRoughnessMap` (linear G) |
| `MeshPhysicalMaterial.clearcoatNormalMap`, `.clearcoatNormalScale` | `coatNormalMap` (linear RGB), independent `coatNormalScale`; see [coat normals](./materials.md#coat-normals) |
| `MeshPhysicalMaterial.sheenColorMap`, `.sheenRoughnessMap` | `fuzzColorMap` (sRGB RGB), `fuzzRoughnessMap` (linear A) |
| `MeshPhysicalMaterial.specularIntensityMap`, `.specularColorMap` | `specularWeightMap` (linear A), `specularColorMap` (sRGB RGB) |
| `MeshPhysicalMaterial.anisotropy`, `.anisotropyRotation`, `.anisotropyMap` | Source strength, rotation and direction texture; see [anisotropy source conversion](#anisotropy-source-conversion) |
| `SkinnedMesh` / mesh with morph targets | CPU-deformed dynamic geometry |
| `InstancedMesh` | One InstancedMesh per material group, with native colors, sharing geometry and BLAS |
| Multi-material groups | One MuTracer mesh per group |
| Geometry `color` with `material.vertexColors = true` | Linear RGB colors modulate base color and unlit output, including base-color textures and instance colors; RGBA inputs use RGB only (vertex alpha is unsupported) |
| `DirectionalLight` | `DirectionalLight` |
| `PointLight` | `SphereLight` (radius `userData.mutracerRadius`, default 0.25) |
| `SpotLight` | `SpotLight` (radius `userData.mutracerRadius`, default 0.01; `penumbra` sets the inner angle, with the same smooth falloff as Three.js) |
| `RectAreaLight` | `RectLight` |
| `AmbientLight` | `AmbientLight` |
| `scene.environment` (equirectangular float `DataTexture`, e.g. from `HDRLoader`/`RGBELoader`) | `EnvironmentLight`; orientation follows Three.js, so a `DataTexture` with `flipY = false` has its first row at the bottom |
| `scene.background` color / texture | Explicit background, independent of environment lighting |

Three.js `opacity` maps to `geometryOpacity`; thin-shell choices map to
`geometryThinWalled`. Metadata accepts the five [canonical and compatibility
names](./materials.md#compatibility-names), using the constructor's equal-value
or conflict rule. These overrides apply after standard conversion; alpha mode
still follows the source material flags and resolved coverage. Naming does not
change transmission, volume or anisotropy conversion semantics.

Material `DataTexture` inputs support Red, RG, RGB and RGBA layouts, including
half-float data. Missing color channels become zero and missing alpha becomes
one. Decoded images use additional CPU memory and are reused until the source
texture is updated; set `texture.needsUpdate = true` after pixel edits.

`FrontSide`, `BackSide` and `DoubleSide` preserve the rendered face and normal
orientation. Later `material.side` edits synchronize automatically. Using both
front and back sides of shared geometry requires additional geometry memory.

Material color textures honor `LinearSRGBColorSpace` and `SRGBColorSpace`;
`NoColorSpace` reads color channels as linear. Data-map channels are always
linear. Color-space edits synchronize automatically.

Material textures preserve independent `wrapS` and `wrapT`: repeat,
clamp-to-edge and mirrored repeat. UV repeat and offset apply before wrapping;
later wrap edits synchronize automatically. Displacement uses the same modes.

`scene.environmentIntensity` scales environment lighting (`0` disables it);
ambient lights and explicit backgrounds keep their own brightness.
`scene.backgroundIntensity` scales an explicit texture background; colors are
unaffected. `scene.environmentRotation` and `scene.backgroundRotation`
independently rotate environment lighting and explicit texture backgrounds. All
of these synchronize automatically; rotations preserve Euler order. An unset
background follows the environment. `mutracerGroundedSkybox` uses only its own
`rotation` (default `0`) and `intensity` (default `1`), ignoring
`scene.backgroundRotation` and `scene.backgroundIntensity`.

Thin-film ranges keep their endpoint order, including minimum greater than
maximum, and retain the converter's 0–20 µm endpoint clamp. The converter uses
Three.js's actual range defaults. `mutracerOpenPBR` may explicitly override the
range, channel and map after conversion; its map accepts a MuTracer `Texture`
or a source `THREE.Texture`. `THREESync` converts parameter edits without
rewriting texture pixels. The iridescence strength texture is not supported;
`thinFilmMap` represents thickness only.

The six layer maps preserve the source UV channel, scale, offset and `flipY`.
`mutracerOpenPBR` can override them with a MuTracer
`Texture` or `THREE.Texture`; explicit `null` clears an imported map, while
unknown JSON objects are ignored. `THREESync` follows texture edits.
General `KHR_texture_transform` rotation remains unsupported.
See [coat normal conversion](#coat-normal-conversion) for clearcoat normal maps.
Anisotropy direction and source-model mapping are described [below](#anisotropy-source-conversion). The conversion preserves OpenPBR layering: glTF sheen
layer order differs, and specular weight/color also affect metals in OpenPBR;
these imports do not imply identical glTF BRDFs. A fully metallic material
(`metalness` 1 without `metalnessMap`) ignores `specularIntensity`,
`specularColor` and their maps, as in glTF. Partially metallic or
metalness-mapped materials keep them, so their metal lobe is scaled too.

Invisible objects are skipped. Other material types are skipped with a console
warning unless `convertMaterial` supplies an OpenPBR material. `BatchedMesh`, instanced morph targets (`morphTexture`) and skinned
instancing are unsupported: each source object warns once per converter and is
converted as an ordinary mesh, without per-instance matrices or colors.

Meshes without UVs get automatic triplanar texture and displacement
projection; explicit
`mutracerUvProjection` settings take precedence.

Three.js `displacementScale` and `displacementBias` retain their local-unit
semantics. Without a displacement map, Three.js's inactive default height of `1`
is replaced by MuTracer's default `0.1`; other explicitly configured heights
are preserved. `userData.mutracerOpenPBR.displacementScale` can explicitly set
any height, including `1`, before a map is assigned; `displacementBias` in the
same metadata overrides the Three.js bias. The same metadata object's
`displacementStepSize` overrides marching quality: `0` uses automatic steps,
and a positive value is a fixed local-unit step. See
[displacement](materials.md#displacement) for scaling and cost.

## Skinning and morph targets

The initial conversion and each `sync.update()` evaluate morph targets and
skinning on the CPU. The sync calls `skeleton.update()` itself, so a preceding
Three.js render is unnecessary. Relative and absolute morph targets affect
positions and normals; skinning transforms positions, normals and supplied
tangents in local space. Missing tangents are generated from the deformed
positions, normals and UVs. The mesh's world transform remains an instance
transform.

Each deforming source mesh owns its MuTracer geometry, even when several
SkinnedMesh objects share a Three.js BufferGeometry; deformation is computed
once per source mesh and copied to each material group. These geometries are
[dynamic](./updates.md#dynamic-geometry).

An unchanged pose (bones, binding matrices, morph weights and attribute
versions) skips deformation. A changed pose updates the arrays in place, and
rendering refits only that geometry's BLAS and instances. CPU cost grows with
vertices, bone influences and material groups. Displaced deforming meshes need
a full mesh update on every pose change.

Try the procedural [animation example](../examples/animation.html). Pause the
animation to accumulate samples; changing a pose restarts accumulation.

## Instanced meshes

`THREE.InstancedMesh.count` converts to a MuTracer `InstancedMesh` per material
group. Local Float32 matrices and colors are copied in source
index order within each batch; the retained double-precision `source.matrixWorld`
is the batch transform. Each world matrix remains `source.matrixWorld * instanceMatrix[i]`.

- **Matrices**: set `instanceMatrix.needsUpdate = true` after edits. The converter
  checks values and notifies changed batches; unchanged batches retain their
  matrix arrays and versions. Both backends refit the instance hierarchy.
- **Count**: the surviving source prefix retains its transforms and batch
  identities. Shrinking removes the tail; increasing reads it again from the
  source buffer. Membership changes rebuild the top-level BVH and reuse vertices
  and BLASes where packing permits ([scene updates](./updates.md#adding-removing-and-reassigning-meshes)).
- **Colors**: `instanceColor` is copied into the batch's native `colors` array in
  source order; removing it restores undefined (white). Set
  `instanceColor.needsUpdate = true` after edits. Only changed values notify the
  batch, and colors do not create material variants or extra batches. See
  [color semantics and updates](./updates.md#instanced-meshes).
- **Callbacks**: `onMeshConverted` runs once per visible group on each update.
  It receives `Mesh | InstancedMesh`; edit shared materials as usual, or notify
  batch array element edits as described in [scene updates](./updates.md).

Unsupported instanced deformation keeps the ordinary-mesh fallback described
above. [Native instancing](./updates.md#instanced-meshes) uses the same primitive
without Three.js.

## `userData` keys

Renderer-specific settings without a Three.js equivalent:

| Key | On | Description |
| --- | --- | --- |
| `mutracerShadowCatcher: true` | material | Shadow-catcher ground |
| `mutracerOpenPBR: { ... }` | material | OpenPBR inputs without a Three.js equivalent: `baseWeight`, `baseDiffuseRoughness`, `specularWeight`, `specularColor`, `coat*`, `fuzz*`, `thinFilm*`, `thinWalled`, `subsurface*`, `transmissionScatter*`, `transmissionDispersion*` |
| `mutracerBevelSize` | material | Shader bevel radius |
| `mutracerUvProjection`, `mutracerUvProjectionScale`, `mutracerUvReferenceLength` | material | Procedural UV projection |
| `mutracerDisplacement*` | material | Displacement settings, same names as the `OpenPBRMaterial` fields; projection scale is `mutracerDisplacementUvProjectionScale` |
| `mutracerThinFilmMap` | material | Native R thickness texture with minimum 0; takes precedence over `iridescenceThicknessMap` |
| `mutracerRadius` | point / spot light | Emitter radius |
| `mutracerIesProfile`, `mutracerIesRotation` | spot light | `IESProfile` instance; rotation becomes local-Z transform rotation |
| `mutracerGroundedSkybox: { texture, height, radius, groundHeight?, center?, rotation?, intensity? }` | scene | Grounded skybox background; rotation/intensity options follow [SceneBackground](./api.md#scene-types) |
| `mutracerHiddenBackground: true` | scene | Transparent background while keeping environment lighting |

Directional and spot lights use their world position and target to build a
MuTracer transform; source rotation alone does not specify their direction.

## Options

`new THREESync(engine, options?)` accepts these optional sources and settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `scene` | undefined | Three.js scene; omitted leaves engine.scene untouched |
| `camera` | undefined | Perspective or orthographic camera; omitted leaves engine.camera untouched |
| `controls` | undefined | Controls with update and start/end events, such as OrbitControls |
| `updateControls` | true | Calls controls.update; false leaves updating to the application |
| `convertMaterial` | undefined | `(sourceMaterial)` → OpenPBRMaterial, null to skip every mesh using it, undefined for built-in conversion |
| `convertLight` | undefined | `(sourceLight)` → SceneLight, null to skip the light, undefined for built-in conversion |
| `onMeshConverted` | undefined | `(mesh, source, group, groupIndex)` on every visible mesh/group during update |

Construction subscribes to control events. The first update converts and writes
sources to the engine. `scene` exposes the retained converted scene, or undefined
when no source was supplied. A camera-only sync preserves a MuTracer-built scene.
`active` covers gestures once the camera moves, damping and changing
skinned/morph poses. Clicking or holding a stationary view preserves accumulated
samples. OrbitControls damping stays consistent across render frame
rates, and final refinement resumes when motion settles. Use
`updateControls: false` when your application already updates the controls.

`fromTHREEScene(scene, options?)` and `fromTHREECamera(camera, options?)` remain
available for one-shot conversions. Each call reruns conversion hooks and creates fresh default objects; custom
objects are kept by identity.
Call `camera.updateProjectionMatrix()` after changing aspect or fov. A perspective
camera's focus and film height become MuTracer focus distance and sensor height;
pass `{fStop: 2.8}` to `fromTHREECamera` to enable depth of field.

### Custom conversion

Both `fromTHREEScene` and `THREESync` accept the conversion hooks:

```ts
import { OpenPBRMaterial, SphereLight } from '@meimu/mutracer';
const customMaterial = new OpenPBRMaterial({baseColor: [0.2, 0.4, 0.8]});
const customLight = new SphereLight({radius: 0.1, intensity: 3});
const sync = new THREESync(engine, {
  scene,
  convertMaterial(source) {
    if (source.type === 'ShaderMaterial') return customMaterial;
    if (source.userData.skipPathTracing) return null;
    return undefined;
  },
  convertLight(source) {
    if (source.userData.customEmitter) return customLight;
    return undefined;
  },
});
// Edit the returned MuTracer material directly after initial conversion.
customMaterial.baseColor = [0.8, 0.4, 0.2];
```

The sync caches each hook result (including null and undefined) by source
identity and `version`. The material hook receives only the source material,
so a shared material converts once for every mesh using it; use distinct
source materials for per-mesh conversion. Set `threeMaterial.needsUpdate = true` to advance its version and
rerun the hook. Returned objects are used by identity and are caller-owned;
`engine.update()` detects edits to them. Automatic UV
projection derives retained variants from the returned material; these refresh
when its identity or parameters change.

Three.js lights have no built-in `version`, so the light hook runs once. To
rerun it, set a numeric `light.userData.mutracerVersion` and increment it. An undefined hook result keeps normal built-in material/light
synchronization, including parameter edits that do not change the source
version. A null material result skips every group/instance of its mesh.
The environment texture follows the built-in conversion and is not a
`THREE.Light` hook source.

## Coat normal conversion

`clearcoatNormalMap` uses the shared texture conversion cache and preserves its UV channel, scale, offset and `flipY`; `clearcoatNormalScale` is copied separately from `normalScale`. Explicit `mutracerOpenPBR.coatNormalMap` accepts a MuTracer Texture or Three.js Texture, and `null` clears the imported map. `coatNormalScale` metadata overrides the imported pair; unrelated metadata retains the imported anisotropy source convention. Arbitrary JSON objects are not interpreted as texture images. `THREESync` propagates map and scale edits.

## Caveats

THREESync updates world/bone matrices and retains unchanged meshes, materials,
textures, lights, backgrounds and membership arrays. MuTracer transforms use
Three.js matrixWorld, preserving double precision. Skinning and morphs run on the
CPU, updating retained geometry in place. Other changed buffers replace geometry
and require a [full mesh update](./updates.md#full-mesh-updates).

`sync.dispose()` removes control subscriptions and conversion caches; it leaves
the last converted scene usable. Updating a disposed sync throws. RenderLoop does
not dispose supplied syncs or renders; see [ownership](./progressive-rendering.md#options-and-ownership).


Native `mutracerOpenPBR` metadata can set `anisotropyMap` (a MuTracer or Three.js Texture, or null to clear), `specularAnisotropyRotation` and `coatAnisotropyRotation` (radians, default zero). Imported geometry preserves a tangent's optional W handedness.

## Anisotropy source conversion

`MeshPhysicalMaterial.anisotropy`, `anisotropyRotation` and `anisotropyMap` import as source strength, base rotation (radians) and the linear RG/B direction map, with `specularAnisotropyModel = 'gltf'`. Roughness and its maps retain source values. `GLTFLoader` supplies the extension defaults and texture coordinates; `THREESync` propagates later strength, rotation, texture and metadata edits without rewriting pixels. Nonphysical materials retain native semantics.

For sampled source roughness r and strength a, u = r², A = u + (1 - u)a² and B = u. The native anisotropy is 1 - B/A (clamped to [0, 1] against Float32 roundoff) and native roughness is ((A² + B²)/2)^(1/4). A = B = 0 resolves to zero. Strength zero returns the original roughness directly. Conversion occurs after roughness/metallic-roughness sampling and the anisotropy blue multiplier, followed by the existing OpenPBR coat roughening. CPU conversion before multiplying maps would give different alpha axes and is not used. The coat's anisotropy is independent.

Metadata overriding `specularAnisotropy` or `specularRoughnessAnisotropy` defaults back to `'openpbr'` and clears the automatically imported direction map/rotation to undefined/zero. Explicit metadata direction values can replace or restore them; explicit `specularAnisotropyModel: 'gltf'` retains source semantics and the imported directions. An unrelated override such as baseColor preserves the imported model. Texture overrides accept MuTracer/Three.js textures, and null clears a texture. Invalid model names throw.

This is an alpha-parameter match, with approximation differences from the renderer's Fresnel, masking, energy compensation and layer model. Zero roughness with nonzero strength reaches the existing alpha minimum; this numerical endpoint does not reproduce a singular zero-width distribution. General KHR texture-transform rotation remains the adapter limitation documented above.
