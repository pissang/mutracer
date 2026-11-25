# OpenPBR implementation

`OpenPBRMaterial` follows the OpenPBR Surface specification with a compact GPU
BSDF. Parameters, units and user-facing limits are in the
[materials guide](../materials.md); this note describes how the implementation
is organized and the rules for changing it.

## Data flow

- **Layout table.** `materialLayoutSchema.ts` lists every material buffer row
  (one `vec4` each) with its source field and type. The same table generates the
  TypeScript packing, the WGSL struct (`materialBufferWgsl`) and the GLSL row
  constants (`materialRowsGlsl`), so the three cannot drift. Reserved rows keep
  their legacy contents; reusing one is an intentional migration.
- **Texture slots.** `materialTextureSlots.ts` lists every map with its target
  parameters, channels, color space, shader define and feature bit. Slot order is
  the atlas index contract. Public map names live in the scene layer
  (`materialTextureNames.ts`).
- **Feature specialization.** Features that a scene does not use, such as
  anisotropy directions or coat normals, are compiled out by generating different
  WGSL source, not by patching strings after generation.

## BSDF

The BSDF (`openPbrBsdf.wgsl.ts` and its GLSL counterpart) follows the
prepare/eval/sample/pdf organization of Adobe's
[openpbr-bsdf](https://github.com/adobe/openpbr-bsdf) and the
[OpenPBR viewer](https://github.com/portsmouth/OpenPBR-viewer):

- `openpbr_prepare` resolves the layered material once per path vertex. NEE, BSDF
  sampling and MIS reuse the result, which made WebGPU samples about 11–15% faster
  than preparing per evaluation.
- The lobes are fuzz, coat, metal, dielectric specular, transmission, diffuse and
  subsurface. Their weights and probabilities are stored as arrays indexed by lobe,
  rather than one variable per lobe.
- Metal uses the F82-tint Fresnel; specular anisotropy uses the specification's
  roughness mapping. The coat roughens the base, changes the IOR ratio below it,
  absorbs, and darkens through internal reflection (`coatDarkening`, default 1).
- Fuzz uses an analytic approximation. The specification's LTC fuzz (Zeltner et al.
  2022) is not implemented.

## Energy compensation

GGX loses energy to single scattering as roughness grows. The renderer uses Adobe's
tables for opaque dielectric base coupling, ideal-metal multiple scattering and
solid ideal-dielectric reflection and transmission (`openPbrEnergyLut.ts`). Before
these tables, rough glass lost 5–36% and rough metal 1.5–20% of its energy in white
furnace tests.

The tables are stored as 8-bit samples normalized per row, with 16-bit row bounds,
differences between consecutive rows and exact 16-bit averages. This keeps the
module about 44 KB gzipped while adding the multiple-scattering tables. It is a
separate chunk that `engine.init()` imports alongside device initialization
(`openPbrEnergyLut.browser.ts`), so it stays out of the main bundle. On the GPU
they occupy about 280 KB.

Thin-walled rough transmission has no compensation, as in the reference.

## Medium boundaries

A path carries at most one interior medium. It records the material that owns
it (`mediumType` stores the material index plus one) rather than only the
medium's coefficients. A refraction into a dielectric makes that material the
owner; a refraction out of a material clears the medium only if that material
owns it. Touching entry and exit hits, such as wine against the inner glass
wall, can arrive in either order, and an exit from the glass must not end the
liquid's absorption. Caustic photons track the owner the same way
(`causticLight.compute.ts`).

A fixed forward step after refraction can jump past a liquid surface lying
within that step of the glass, leaving the whole liquid segment in air.
Refraction continuations therefore use the coincident-surface origin described
in [acceleration structures](./acceleration.md#coincident-hits).

One medium per path means overlapping volumes are not nested: leaving an inner
volume ends absorption in the enclosing one. The
[materials guide](../materials.md#inputs) tells users to model separate volumes.

## Import decisions

- Three.js and glTF clearcoat import with `coatDarkening = 0`, because glTF's
  clearcoat does not darken the base. `userData.mutracerOpenPBR` overrides it.
- Specification names (`specularRoughnessAnisotropy`, `coatRoughnessAnisotropy`,
  `subsurfaceScatterAnisotropy`, `geometryOpacity`, `geometryThinWalled`) are the
  primary names; older names remain deprecated aliases.
- glTF anisotropy is converted after texture sampling, selected by
  `specularAnisotropyModel: 'gltf'`.

## Not implemented

- Statistical mixing of two materials.
- LTC fuzz.
- Resampled direct lighting on WebGL. It waits for the cause of a small diffuse
  residual with 8 or 16 WebGPU light candidates; the default of 4 is unaffected.

## Known accuracy limits

- Rough solid glass remains slightly dark in white furnace tests, under 1% without
  a coat and under 1.5% with one at roughness 0.3. With compensation off it is
  about 2 percentage points darker than the reference, so the remaining loss is in
  the transmission integration, not the tables.
- Strongly tilted coat normals lose about 5% of their energy, because lobes are
  clipped to the geometric hemisphere. The materials guide documents this.
- Strong anisotropic metal can retain a small energy error, because the tables use
  isotropic roughness.
- A coat with a higher IOR than the base can produce spurious total internal
  reflection in the thin film, as in the reference.

## Acceptance rules

These maintainer rules apply to material and BSDF changes:

- A white furnace may deviate from 1 by at most 0.5%, and a coated material from
  its uncoated control by at most 0.5%.
- Re-encoding the tables may change any material on either backend by at most 0.1%.
- Measure cold shader compilation with caches invalidated; increases above 10% need
  a maintainer decision.
- Sparse pixel differences of at most one half-float step from compiler
  reassociation are acceptable.
- Refactors keep default materials (base weight 1, no coat, isotropic, specular
  color 1) pixel-identical on both backends.
