# Import glTF

The default `gltf` Cargo feature, also enabled in C builds, imports glTF and
GLB files into a [Scene](scene.md).

```rust
let imported = mutracer_native_probe::scene_api::Scene::import_gltf("model.glb")?;
engine.set_scene_object(&imported.scene)?;
engine.update()?;
```

- Rust `Scene::import_gltf(path)` and `Scene::import_gltf_bytes(bytes,
  base_directory)` return `ImportedScene { scene, names, warnings }`. `names`
  maps case-sensitive node, mesh, geometry and material names to handles;
  duplicates list every handle in traversal order.
- C `mt_scene_import_gltf` and `mt_scene_import_gltf_bytes` create a scene
  handle. `mt_scene_find` resolves a name and zero-based occurrence to a handle;
  a node name returns its mesh handle. Without the `gltf` feature these calls
  return `MT_ERROR_UNAVAILABLE`.
- The import uses the default scene (or the first scene) at the first animation
  clip's initial pose. Imported meshes have world matrices, so moving one does
  not move other meshes from the same node. The
  [viewer](../viewer/README.md) also plays animations.

## Resources

Path import loads external files beside the model. Byte import resolves
external URIs under `base_directory`; omit it only when every resource is
embedded. Base64 data URIs work; network URLs are rejected. Resources must stay
available until the import returns.

## Supported inputs

- Geometry: triangles, strips and fans; node transforms; shared geometry; RGB
  vertex colors; two UV sets; mesh instancing; skins with up to four joint
  influences; morph targets. Missing normals and tangents are generated.
- Compression: Meshopt, quantized attributes and WebP textures. Draco and
  Basis/KTX2 assets must be converted first. Sparse quantized attributes are
  unsupported.
- Animation: node translation, rotation and scale, skeletal motion and morph
  weights, with STEP, LINEAR and CUBICSPLINE interpolation.
- Materials: core metallic/roughness PBR, IOR, transmission, emissive strength,
  unlit, clearcoat, sheen, specular, volume, iridescence, anisotropy and dispersion.
  Layer textures include clearcoat weight/roughness/normal, sheen color/roughness,
  specular weight/color, transmission, iridescence thickness and anisotropy.
- Textures: repeat, clamp-to-edge and mirrored-repeat per axis, and offset/scale
  UV transforms.

Volume uses the geometry's actual thickness; `thicknessFactor` selects solid
or thin-walled surfaces, and the baked `thicknessTexture` is unused. Iridescence
IOR is limited to 2.5, film thickness to 20 μm, and dispersion to 1. Specular
controls are exact for fully dielectric materials; mixed metal/dielectric
surfaces use the same approximation as the browser conversion.

Ignored: model cameras and lights; camera, light and material animation; vertex
alpha; occlusion textures; texture rotation; iridescence strength textures (the
scalar factor still applies). Normal maps support offset, scale and UV-set
selection. Unsupported optional extensions produce Rust warnings (C ignores
them); unsupported required extensions fail the import.

## Errors and limits

Failures, including missing files, invalid glTF/GLB, unsupported required
extensions and exceeded limits, return Rust `api::Status::InvalidArgument` or C
`MT_ERROR_INVALID_ARGUMENT`. The message holds the complete cause chain, so give
C a large error buffer.

- Model files and combined source/decoded buffers each default to an 8 GiB budget.
  Set `MUTRACER_NATIVE_MEMORY_BUDGET_MIB` to a positive integer to change it.
  This is an admission limit; peak process memory can be several times larger.
  Each source image is limited to 64M pixels.
- Material images keep their original dimensions when they fit the
  [scene texture limits](scene-format.md#limits), including the configured
  material budget. Repeated references to the same embedded image span or image
  URI share decoding and image memory, including across different samplers or UV
  transforms. Import warnings report any reduction.
- Node hierarchies up to 512 levels.
- Large scenes usually need HWRT and substantial free memory. Auto selects HWRT
  when the device supports it; Software can reach its BVH budget earlier.
- The [scene limits](scene-format.md#limits) also apply.
