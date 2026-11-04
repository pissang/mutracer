# Materials

`OpenPBRMaterial` implements the
[OpenPBR 1.1](https://academysoftwarefoundation.github.io/OpenPBR/) surface.
Property names use camelCase OpenPBR inputs plus compatibility names. Colors are
linear RGB. Pass optional properties to `new OpenPBRMaterial(params)`; omitted
properties use the defaults below and in TSDoc.

```ts
import { OpenPBRMaterial } from '@meimu/mutracer';

const glass = new OpenPBRMaterial();
glass.transmissionWeight = 1;
glass.specularRoughness = 0;
glass.transmissionColor = [0.72, 0.9, 1];
glass.transmissionDepth = 0.5;

const gold = new OpenPBRMaterial({
  baseColor: [1.0, 0.78, 0.34],
  baseMetalness: 1,
  specularRoughness: 0.2
});
```

Edit a material that is already rendering in place; the next `engine.update()`
detects the change (see [scene updates](./updates.md#materials-textures-and-lights)
for costs):

```ts
gold.specularRoughness = 0.4;
gold.baseColor[1] = 0.7;
```

Materials occupy GPU slots by object identity: share one material object to
share its slot. Separate objects with equal values take separate slots, but
the textures they reference still share atlas space.

## Inputs

| Layer | Inputs (default) |
| --- | --- |
| Base | `baseWeight` (1), `baseColor` (0.8), `baseDiffuseRoughness` (0), `baseMetalness` (0) |
| Specular | `specularWeight` (1), `specularColor` (1), `specularRoughness` (0.3), `specularIor` (1.5), `specularRoughnessAnisotropy` (0) |
| Transmission | `transmissionWeight` (0), `transmissionColor` (1), `transmissionDepth` (0), `transmissionScatter` (0), `transmissionScatterAnisotropy` (0), `transmissionDispersionScale` (0), `transmissionDispersionAbbeNumber` (20) |
| Subsurface | `subsurfaceWeight` (0), `subsurfaceColor` (0.8), `subsurfaceRadius` (1), `subsurfaceRadiusScale` ([1, 0.5, 0.25]), `subsurfaceScatterAnisotropy` (0) |
| Fuzz | `fuzzWeight` (0), `fuzzColor` (1), `fuzzRoughness` (0.5) |
| Coat | `coatWeight` (0), `coatColor` (1), `coatRoughness` (0), `coatRoughnessAnisotropy` (0), `coatIor` (1.6), `coatDarkening` (1) |
| Thin film | `thinFilmWeight` (0), `thinFilmThickness` (0.5 µm), `thinFilmIor` (1.4), `thinFilmThicknessMinimum` (0 µm), `thinFilmMapChannel` (`r`) |
| Emission | `emissionColor` (1), `emissionLuminance` (0) |
| Geometry | `geometryOpacity` (1), `geometryThinWalled` (false), `doubleSided` (false) |

Units: `transmissionDepth` and `subsurfaceRadius` are in scene units;
`thinFilmThickness` is in micrometres (`0.45` = 450 nm).
Subsurface materials with short scattering radii may appear darker than in earlier releases.

`baseWeight` scales diffuse reflection and the metallic normal-incidence color
(`baseWeight * baseColor`). Dielectric specular, transmission and subsurface
retain their own strengths. For metals, `specularColor` tints the F82 Fresnel
curve near grazing angles and `specularWeight` scales the entire reflection,
including thin-film reflection. At their default values, F82 reduces to Schlick.
Low-roughness metals may appear slightly darker under broad lighting than in earlier releases.

Native `specularRoughnessAnisotropy` and `coatRoughnessAnisotropy` use the OpenPBR GGX mapping:
`alphaT = roughness² * sqrt(2 / (1 + (1 - anisotropy)²))` and
`alphaB = (1 - anisotropy) * alphaT`, with the renderer's minimum alpha.
Both layers use the geometry tangent; a separate coat tangent is not available.
A rough coat broadens the underlying metal, dielectric reflection and transmission
using `mix(rB, min(1, rB^4 + 2*rC^4)^0.25, coatWeight)` before the GGX mapping.

`coatColor` is the squared transmittance at normal incidence. Each passage
through the coat applies `sqrt(coatColor)` raised to the inverse refracted
cosine. Coat reflection stays uncolored; reflection from the base crosses the
coat twice, and transmission crosses it once. `coatDarkening` controls the
extra darkening from internal reflections, while absorption remains active at
zero. The base is attenuated by the coat directional albedo on the view side
and by an internal-reflection factor estimated from the base slab albedos.
Partial coat coverage is mixed independently for each passage.
Thin film lies below the coat: its exterior IOR is `mix(1, coatIor, coatWeight)`
and its dielectric substrate uses the adjusted absolute base IOR. A solid
inside hit exchanges these media; uncoated films retain their existing behavior.
Emission uses a normal-incidence single passage: it is multiplied by
`mix(1, sqrt(coatColor), coatWeight)`. Without `coatWeightMap`, the same attenuated emission determines
emissive-light selection and hit MIS weights. This approximation has no angular
dependence and does not apply coat darkening or fuzz attenuation to emission.
Unlit and shadow-catching materials keep their existing emission behavior.

The base reflection beneath a coat uses the surrounding IOR
`mix(1, coatIor, coatWeight)`. `specularWeight` adjusts the base IOR relative
to that medium; refraction uses the resulting absolute base IOR relative to air.
Solid back-face exits ignore the coat IOR; thin walls use the exterior rule
on either side. Reflection inverts a coat-to-base ratio below one when the
base IOR is at least one, avoiding false total internal reflection caused by
the approximate coat model. Dispersion adjusts the base IOR before these rules.

`fuzzColor` colors the fuzz reflection only. Fuzz attenuates the underlying
material using its white directional albedo, so colored fuzz does not tint
the substrate through the attenuation term.

**Interior media.** Transmission describes a homogeneous volume:
`transmissionColor` is the color that survives one `transmissionDepth`, and
`transmissionScatter` is the scattering albedo. With `transmissionDepth = 0`
the tint is applied at the surface. Subsurface has its own color and per-channel
radius. A positive `transmissionDispersionScale` enables
wavelength-dependent refraction; values above `1` increase color separation,
and `0` disables it. Lower `transmissionDispersionAbbeNumber` values also
increase color separation.

## Compatibility names

The canonical names below share storage with the deprecated names. Both work in
constructor parameters, property reads/writes and Three.js metadata. If both
are supplied together, equal values are accepted and conflicting values throw.
Edits through either spelling are detected by the next `engine.update()`; see [scene updates](./updates.md).

| Canonical name | Deprecated compatibility name | Default |
| --- | --- | --- |
| `specularRoughnessAnisotropy` | `specularAnisotropy` | `0` |
| `coatRoughnessAnisotropy` | `coatAnisotropy` | `0` |
| `subsurfaceScatterAnisotropy` | `subsurfaceAnisotropy` | `0` |
| `geometryOpacity` | `opacity` | `1` |
| `geometryThinWalled` | `thinWalled` | `false` |

`materialKeys`, `materialParamKeys`, hashes and snapshots keep the compatibility
storage names and order; aliases add no GPU fields. `Object.keys()` and JSON
include the stored compatibility names only. The canonical accessors are not
an alternate serialization format.

## Textures

| Property | Channel | Notes |
| --- | --- | --- |
| `map` | RGB (sRGB), A | Multiplies `baseColor`; alpha use set by `mapAlphaUsage` |
| `alphaMap` | G | Opacity, as in Three.js |
| `normalMap`, `normalScale` | RGB | Tangent space; uses triangle UV derivatives |
| `metallicRoughnessMap` | G = roughness, B = metalness | glTF convention |
| `roughnessMap` | G | |
| `metalnessMap` | B | |
| `emissiveMap` | RGB | Multiplies `emissionColor` |
| `transmissionMap` | R | Multiplies `transmissionWeight` |
| `thinFilmMap` | R by default; selectable R/G/B/A | Linear thickness range |
| `displacementMap` | R | See [displacement](#displacement) |
| `coatWeightMap` | Linear R | Multiplies `coatWeight`, including emission absorption |
| `coatRoughnessMap` | Linear G | Multiplies `coatRoughness` before base roughening |
| `coatNormalMap`, `coatNormalScale` | Linear RGB | Independent tangent-space coat normal; see [coat normals](#coat-normals) |
| `fuzzColorMap` | sRGB RGB | Decoded color multiplies `fuzzColor` |
| `fuzzRoughnessMap` | Linear A | Multiplies `fuzzRoughness` |
| `specularWeightMap` | Linear A | Multiplies `specularWeight`, for dielectric and metal |
| `specularColorMap` | sRGB RGB | Decoded color multiplies `specularColor`, for dielectric and metal |

All six layer maps default to `undefined`. They resolve before coat roughening
and BSDF preparation. Images may be shared between color and data slots;
sRGB decoding happens only at color sample sites. See [anisotropy directions](#anisotropy-directions)
for the RG/B slot and [coat normals](#coat-normals) for the independent normal input.

With `coatWeightMap`, emission absorption uses the sampled coverage at each
surface/mesh-light point. Light selection and emissive-hit MIS use raw constant
emission luminance as a conservative proposal; absorption is applied once to
the contribution. Black texture points can retain a positive sampling PDF.
Removing the map restores the constant-coat packing path.

`Texture.uvScale`, `uvOffset` and `uvChannel` (0 or 1) transform UVs per
texture. For geometry without usable UVs, set `uvProjection` to
`'triplanar'`, `'spherical'` or `'cylindrical'` with `uvProjectionScale` (default `[1, 1]`).

With `thinFilmMap`, thickness interpolates from `thinFilmThicknessMinimum` to
`thinFilmThickness` using the linear `thinFilmMapChannel`. The default minimum
0 and channel `r` keep the original R-times-thickness behavior. Without a map,
only `thinFilmThickness` is used. Endpoints are nonnegative and may be reversed,
including a positive minimum and zero maximum. Nonfinite endpoints use their
defaults; invalid channels throw during construction or packing.

Call `texture.markUpdated()` after editing pixels or UV-array elements;
assigning a new texture, image or UV array is detected automatically.

## Alpha

`alphaMode` is `'auto'` (default; derived from the alpha inputs), `'opaque'`,
`'mask'` (alpha test against `alphaCutoff`) or `'blend'`. `mapAlphaUsage`
selects how `map`'s alpha channel is used:
`'opaque'` (default), `'alpha'` or `'transmission'`. Blended primary rays follow
`render.alphaBlendStrategy`. Both WebGPU and WebGL 2 apply these modes to
surface hits and shadow rays: `opaque` ignores opacity and alpha textures;
`mask` resolves coverage to 0 below `alphaCutoff` and 1 at or above it;
`blend` retains fractional coverage. In `auto`, a positive cutoff selects
`mask`; otherwise opacity below 1, alpha use of `map`, or an `alphaMap`
selects `blend`. With none of these inputs, `auto` selects `opaque`.

## Renderer extensions

| Property | Description |
| --- | --- |
| `shadowCatcher` | Invisible ground that only receives shadows of the environment and analytic lights, not of emissive meshes; composite over a transparent background |
| `unlit` | Shows emission without scattering or lighting other surfaces |
| `bevelSize` | Rounded-edge shading radius in scene units; `0` disables (see below) |

**Shader bevel.** `bevelSize > 0` rounds hard edges in shading only, without
changing geometry or silhouettes. It samples nearby surface normals of the same
instance, similar to Blender Cycles' Bevel node. `render.bevelSamples`
trades noise for speed. A radius of 0.5–2% of the model size is a reasonable
start.

## Displacement

Assign a `displacementMap` and adjust `displacementScale` (height) and
`displacementBias`. The red channel supplies linear height; the offset along
the normal is `red × displacementScale + displacementBias`. Bias defaults to
`0`, so black leaves the surface in place and white uses the full height.
For centered displacement, use a bias of `-displacementScale / 2`. Displacement
requires WebGPU; WebGL 2 renders the original surface. No extra triangles are
generated.

`displacementScale` defaults to `0.1`; both height and bias use mesh-local
units. Height `0` removes map variation while bias still offsets the surface;
set both to `0` or remove the map to disable displacement. The offset follows
the mesh transform, like Three.js displacement or Blender's Object Space mode:
scaling an object also scales its displacement.
Baking a scale into vertex positions requires scaling both `displacementScale`
and `displacementBias` by the same amount to preserve the result.

`displacementStepSize` defaults to `0`, which automatically uses 1/32 of the
absolute displacement height. A positive value sets a fixed step in mesh-local
units. Smaller steps capture finer detail at a higher rendering cost; set
`0.01` explicitly to retain the previous fixed-step default. When baking an
object scale into vertices, scale an explicit step by the same amount; an
automatic step follows the height. `displacementUvProjection` (default `'none'`)
and `displacementUvProjectionScale` (default `1`) control height-map coordinates.

Choose the height for your model's local dimensions. The library does not infer
physical units or resize the model. Changing displacement settings can trigger
an expensive [full mesh update](updates.md#full-mesh-updates).

## Known limitations

Data-backed material atlases require RGBA8 `Uint8Array` sources. WebGL 2 can
currently resolve zero for data-backed material maps; use DOM image or canvas
sources on that backend. Float data remains supported for environments.

Rough thin-wall glass can appear too dark because its reflection/transmission
model includes only single microfacet scattering. Adobe's reference has no
thin-wall transmission multiple-scattering compensation; this approximation
is exact for smooth windows but loses energy as roughness increases.

## Implementation notes

The BSDF evaluates fuzz, coat, metal, dielectric specular, transmission,
diffuse and subsurface as separate lobes, with energy compensation tables and
thin-film interference adapted from
[Adobe's OpenPBR BSDF](https://github.com/adobe/openpbr-bsdf). Small
differences from offline references remain, from finite path depth, RGB
thin-film evaluation and texture filtering.

Metal reflection includes the reference's additional microfacet multiple
scattering, scaled by the square of the average F82 reflectance. Its energy
tables use the original isotropic roughness, also for anisotropic materials,
so strong anisotropy can retain a small energy error. Solid transmission also
includes the reference dielectric multiple-scattering lobe, using its
refraction IOR for both reflected and transmitted compensation. It uses the
original isotropic alpha and turns off below roughness 0.04. Its transmission
scale follows the reference; single refraction retains the renderer's existing
radiance IOR scaling. The combined model can retain an energy error, including
with coat, and the finite path-event budget can truncate deep glass paths.

## Coat normals

Set `coatNormalMap` to give the coat a tangent-space normal independently of
`normalMap`. Without a coat map (the default), the coat uses the interpolated
surface normal before base normal mapping. A bumpy base can therefore have a
smooth coat. Assign the same texture to both maps to perturb both layers.

The map decodes linear RGB as `2 * RGB - 1`, multiplies XY by
`coatNormalScale`, then normalizes. The scale defaults to `[1, 1]` and can be
negative or zero. UV0/UV1 selection, scale, offset and `flipY` follow the
ordinary texture rules. Zero coat weight or zero sampled coat coverage
disables the coat without changing the base normal.

Replacing the map or editing its scale is detected by `engine.update()`. Call
`texture.markUpdated()` after pixel or UV-array element edits; see [scene updates](./updates.md).

Coat reflections can remain visible where the base normal points away from
the light. Solid interior hits omit coat reflection; thin surfaces are
treated as exterior hits.

Strongly tilted shading normals lose some lobe support when clipped to the
geometric hemisphere. A unit white environment can therefore render below
unit radiance; the renderer does not renormalize the clipped lobes.

## Anisotropy directions

Set `specularAnisotropyRotation` or provide `anisotropyMap` to orient the base specular lobe. The map reads linear `2 * RG - 1`, normalizes the direction, multiplies strength by B, and then applies the rotation. A decoded squared length at or below `1e-4` falls back to `(1, 0)` before rotation (including the two central RGBA8 codes). Without a map the direction is `(1, 0)` and the strength multiplier is one. The rotation defaults to zero; the map defaults to undefined.

`coatAnisotropyRotation` defaults to zero and uses the geometry tangent independently of the base map. Base and coat use their respective directions and [normals](#coat-normals). Zero anisotropy strength ignores the direction.

Provided tangent XYZ and optional W handedness are preserved. Missing tangents are generated from primary UVs only when a material using the geometry needs anisotropy or an active coat normal map; adding such a material prepares them automatically. For XYZ tangents the sign comes from triangle UV derivatives. Missing UVs or degenerate tangents use UV derivatives where available and then a stable orthonormal fallback. The direction texture's selected UV set is used for derivative fallback, including UV1. A provided XYZW tangent remains authoritative. Directions are reorthogonalized against the final shading normal, including normal maps and back faces, and instance transforms preserve mirrored handedness. UV scale, offset and flipY affect texel lookup; they do not rotate the encoded direction.

The direction and strength inputs use native OpenPBR semantics by default. For imported glTF/Three.js strength, select `specularAnisotropyModel: 'gltf'`; the same roughness and strength properties then retain source values. Source scalar inputs are clamped to [0, 1] before texture factors; non-finite source roughness/strength fall back to 0.3/0. Native scalar handling is unchanged. Zero source strength preserves the original roughness path. The conversion matches the GGX alpha axes before existing minimum-alpha clamping; Fresnel, masking, multiple scattering and OpenPBR coating remain the library's model. See [the conversion rules](./threejs.md#anisotropy-source-conversion).
