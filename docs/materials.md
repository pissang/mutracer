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
| `normalMap`, `normalScale` | RGB | Tangent space from triangle UV derivatives |
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

Normal textures use triangle UV derivatives. Graph `normalmap` nodes default to
normalized world-space primary tangents and the vertex normal; with this frame,
black texels keep the vertex normal. The primary frame is independent of the
UV set used to sample the image.

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

### UDIM textures

Use `new UdimTexture([{udim: 1001, image}, ...])` in any material texture slot.
The tile containing `(u, v)` is numbered `1001 + floor(u) + 10 * floor(v)`.
Tiles use loaded RGBA pixel data; Three.js and glTF conversion do not discover
`<UDIM>` paths, so an application or asset loader must load the files and create
the `UdimTexture` directly.

Missing tiles, negative UVs, and UVs with either coordinate at least 10 sample
transparent black. `uvScale` and `uvOffset` apply before tile selection;
`uvChannel` selects the source UV set. `wrapS` and `wrapT` do not wrap the UDIM
domain. All tiles share the logical texture's `colorSpace` and `flipY`. Differing
tile sizes are resampled to the largest width and height, and mixing byte and
float/integer tiles promotes the set to float storage.

Each tile is filtered only within its own boundary, so missing or adjacent tiles
do not bleed into it. Material textures currently sample LOD 0 on both backends;
UDIM follows the same filtering rule and does not create a mip chain. The set
uses a sparse 10×10 logical image, including storage for missing cells, and is
scaled with other material textures when `textureAtlasBudgetBytes` is exceeded.
If even the minimum allocation cannot fit, scene preparation reports the same
budget error as an ordinary texture. Call `markUpdated()` after changing tile
pixels in place; replace the `UdimTexture` to change its tile set.

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

## Material graphs

Attach a `MaterialGraph` to an `OpenPBRMaterial`. Terminal names use the material's
camelCase inputs; inputs without a terminal connection retain the material's
constants and maps. Use `setNode`, `removeNode`, `setInput` and `setTerminal` to
edit a graph, then call `engine.update()`. With RenderLoop running, await the
committed request when an operation needs to know whether installation succeeded:

```ts
import {MaterialGraph, OpenPBRMaterial} from '@meimu/mutracer';

const graph = new MaterialGraph({
  nodes: [{
    id: 'roughness', category: 'constant', type: 'float',
    inputs: {value: {type: 'float', value: 0.4}}
  }],
  terminal: {specularRoughness: {node: 'roughness'}}
});
const material = new OpenPBRMaterial({graph, baseColor: [0.8, 0.2, 0.1]});

graph.setInput('roughness', 'value', {type: 'float', value: 0.6});
engine.update();
const result = await engine.waitForMaterialGraphs();
if (result.outcome === 'settled' && result.state.status === 'failed') {
  console.warn(result.state.diagnostics);
}
```

Nodes have stable IDs and typed inputs. Connect an input with
`{type: 'float', connection: {node: 'roughness'}}`; the output defaults to `out`.
`separate2/3/4` use `outx/outy/outz/outw` for vectors and
`outr/outg/outb/outa` for colors. Node declarations, input values and terminal
connections are immutable snapshots; edit them through the graph's methods.
Textures remain editable resources with [the usual update notifications](./updates.md#materials-textures-and-lights).

Terminal keys are checked in TypeScript, including the supported compatibility
aliases. Use `MaterialGraphTerminalName` for a terminal name or
`MaterialGraphTerminal` for a connection map. `setInput(id, port, undefined)` removes
an authored value or connection and restores that input's node default.

`engine.waitForMaterialGraphs({signal})` accepts an optional `AbortSignal`
(default undefined) and waits for the whole committed scene. It always resolves:
`outcome: 'settled'` means the request reached `idle`, `ready` or `failed`;
inspect `state.status` and `state.diagnostics` to distinguish success from fallback.
A newer committed scene edit returns `superseded`; call again to wait for the new
request. Camera-only edits do not supersede a wait. `aborted` cancels only that
wait, leaving compilation running. Disposal, device loss or initialization failure
returns `unavailable` with an `engine-unavailable` diagnostic. Each result contains
a detached diagnostic snapshot. A graph-free scene with no pending graph work
settles immediately.
The wait does not commit edits or drive rendering: keep calling `refine()` or
running RenderLoop until it resolves.

The engine automatically renders compatible image graphs through ordinary
texture slots on WebGPU and WebGL 2. This includes base color, roughness,
metalness, transmission weight, coat weight, specular weight/color, fuzz
color/roughness and tangent-space normal images, with fixed
UV0/UV1 selection, wrapping, channel selection and supported UV scale/offset
and gain operations. Edits that remain compatible do not compile a graph shader.

Other graphs require WebGPU. WebGL 2 uses their material constants and maps
and reports `unsupported-backend` in `engine.getDiagnostics()?.materialGraphs`.
Missing images retain their authored defaults. Nonlinear color operations,
nonzero output bias, scalar sRGB decoding and incompatible shading frames keep
the graph path. Transmission-medium and glTF anisotropy contexts also keep
the graph when slot evaluation would change their behavior. Alpha images
needing channel reordering also keep the graph. Coat, specular and fuzz slot
conversion currently requires byte/image sources; float and integer data keep
the graph.
Compatible graph and texture-slot rendering can differ slightly in floating-point
rounding; multiple bounces may amplify sparse path differences.

WebGPU supports the following MaterialX 1.39 categories, within the type and
sampling limits below:

- `constant`, `dot`, `image`, `tiledimage`, `texcoord`, `place2d`, `convert`, `normalmap`,
  `gltf_image`, `gltf_colorimage`, `gltf_normalmap`;
- `position`, `normal`, `tangent`, `bitangent`, `normalize`, `dotproduct`, `crossproduct`;
- `add`, `subtract`, `multiply`, `divide`, `modulo`, `min`, `max`, `mix`, `clamp`, `power`;
- `abs`, `floor`, `ceil`, `round`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan2`, `sqrt`, `exp`, `ln`, `sign`;
- `extract`, `remap`, `invert`, `range`, `smoothstep`, `luminance`, `contrast`, `rotate2d/3d`,
  `transformpoint`, `transformvector`, `transformnormal`;
- `noise2d/3d`, `fractal3d`, `cellnoise2d/3d`, `worleynoise2d/3d`,
  `ramplr`, `ramptb`, `ramp4`, `splitlr`, `splittb`;
- `burn`, `dodge`, `screen`, `overlay`, `difference`, `plus`, `minus`;
- `separate2/3/4`, `combine2/3/4`, `ifgreater`, `ifequal`, `rgbtohsv`, `hsvtorgb`, `hsvadjust`.

Numeric types are `float`, `integer`, `boolean`, `color3/4` and `vector2/3/4`;
not every node supports every type. Integer parameters are limited to ±16,777,216.
Undefined arithmetic domains, such as division
by zero or normalizing a zero vector, can produce non-finite pixels. Image `file` inputs hold a loaded `Texture`
or `UdimTexture`. Images use its color space, UV transform and wrapping options.
MaterialX filter/address inputs currently accept only `linear`/`periodic`;
other values produce diagnostics. Texture options provide the other wrapping
choices. `tiledimage` applies tiling, subtracts its offset, then applies its
real-world size ratio. UDIM selection and missing tiles follow [UDIM textures](#udim-textures).
`texcoord.index` selects UV0 or UV1; missing UV sets are zero. Graph images use
this input rather than `Texture.uvChannel`. Geometry nodes
support `space: {type: 'string', value: 'object' | 'world'}`, default `object`;
normalmap's implicit normal/tangent/bitangent use the world frame. Only the
primary tangent frame is supported. Transform nodes accept object/world spaces;
omitting both spaces leaves points/vectors unchanged; normal transforms normalize
the result, including when no space conversion is needed. Specify both spaces
for a conversion. `rotate2d/3d.amount` and `place2d.rotate` are in degrees.
For `place2d`, `operationorder` defaults to `0` (SRT); `1` selects TRS.

`luminance` returns a gray color with ACEScg coefficients by default and preserves
alpha for `color4`. `range` preserves the sign when applying gamma, then optionally
clamps to its output range. Extract indices must lie within the input's components.
HSV conversions and `hsvadjust` accept `color3/4` and preserve alpha. `hsvadjust`
adds hue and multiplies saturation/value by its `amount` vector.
Increasing fractal octaves increases per-hit work. Split nodes use point samples
rather than screen-derivative filtering, so thin boundaries can alias. `gltf_colorimage` exposes `outcolor` and `outa`;
its type is `color4`. The viewer upgrades deprecated `swizzle` nodes to
`extract`/`combine` when importing; authored graphs should use those nodes directly.

Terminals support base weight/color/diffuse roughness/metalness, specular
weight/color/roughness/IOR/anisotropy, transmission weight/color, fuzz and coat
inputs, thin-film weight/thickness/IOR, `geometryNormal` (`normal` is an
alias), and `opacity` (`geometryOpacity` is an alias). The material's anisotropy
aliases also work here.
Opacity replaces the scalar coverage before ordinary alpha texture factors and
[alpha-mode resolution](#alpha), for both surface and shadow rays. In `auto`,
a graph coverage input selects blend unless a positive cutoff selects mask;
explicit `opaque` still ignores coverage. Opacity graphs can use UVs and position,
but shading-normal or tangent-frame dependencies produce a diagnostic and fallback.
UV-dependent opacity requires the material's `uvProjection: 'none'`; use graph
coordinates for procedural coverage. Complex coverage networks also increase
shadow-ray evaluation cost.

On WebGPU, emission color and luminance graphs also work on lit materials and
light nearby surfaces. Lit emission and its coat absorption can use UVs and
object/world position; shading-frame dependencies produce a located diagnostic
and use the constant fallback. UV-dependent lit emission requires
`uvProjection: 'none'`. Unlit emission graphs remain unrestricted by this
light-point context and do not light other surfaces. Choose a representative
constant emission fallback to help light sampling; a black fallback still works,
but small, bright graph features can need more samples. Complex emission
networks increase direct-light sampling cost. Displacement, volume, subsurface
and tangent terminals are not supported. With WebGPU light tracing or photon
mapping, graphs that still require graph evaluation use their constant fallback
and report `unsupported-transport`. This API takes an authored graph; it does not
load `.mtlx`/USD files or convert other surface models.

Parameter edits update without a graph compile while the installed graph program
or a compatible texture-slot plan can represent them. An edit that makes a slot
plan incompatible, or otherwise requires a new graph program, compiles after a
short debounce. Rendering keeps the previous successful result and its parameters
or texture slots during compilation; without a previous result, it uses the
material's constants and maps. A successful installation restarts accumulation. Compilation can take
hundreds of milliseconds or longer and becomes more expensive as a scene uses
more distinct structures. Texture/resource changes can also pause rendering
while the last image remains visible.
Graphs add work at each material hit; opacity graphs also run for shadow rays.
Ordinary materials in the same scene do not evaluate the graph's nodes.
Each material retains its own parameters even when it shares graph code; parameter
memory grows with its reachable inputs and folded values.

Read `engine.getDiagnostics()?.materialGraphs` for `status` (`idle`, `compiling`,
`ready`, `failed`), requested/installed revisions, topology count, compilation
measurements and located diagnostics (`code`, `message`, `materialId`, `node`, `port`).
A scene containing only compatible image graphs reports `idle` with topology
count zero; its installed revision still advances. Node and port validation errors
keep the last successful result for that material; valid graphs on other materials
can still install. The fallback is the constant
material if no successful graph exists. Shader failures do the same. Shader/program
caches consume memory as new structures are tried; disposing the engine releases them.

### MaterialX in the viewer

Import a `.mtlx` file with its textures, a ZIP containing them, or a folder.
Drop the package on an object to replace its material and select it. Over empty
space, the drop uses the selected material; without either target it shows a
prompt. Dropping on the material panel replaces the material shown there.
The drop overlay names the viewport target, and the panel highlights while a
file is over it. To replace an individual texture, drop one PNG, JPEG, WebP or
AVIF image directly on its slot, or click the slot to choose a file. Images
dropped elsewhere on the panel are not assigned to a slot.

Choose **GPUOpen** in the material panel to search the
[GPUOpen MaterialX Library](https://matlib.gpuopen.com/main/materials/all), filter
by category and select a package. The default is **1k 8b** when available.
The browser shows the material's name, author, source and license; use its
license terms when sharing downloaded content. MIT and CC0 packages download
through the site's proxy; other licenses link to GPUOpen for download. Packages
over 128 MiB cannot be applied through the browser; larger packages also cost
more download time and texture memory. Cancel, closing the browser,
or selecting another target stops the pending import and keeps the existing
material. Download or import failures also keep the existing material.

The **MaterialX** preset category imports procedural samples: flake car paint,
weathered steel, varnished wood, marble, terrazzo, leather, tartan, cobblestone
with height displacement, zellige tile, wax, hammered copper, carbon fibre,
Damascus steel, kintsugi, heat-tinted titanium, abalone, hex plating, cooling
lava with glowing cracks and a sci-fi hex panel with glowing seams. They use
only graph nodes and no images, so they need WebGPU to show their patterns;
WebGL 2 renders their constant fallback. Wood, stone, metal, leather and lava
patterns use object-space position and follow the model's size; the woven,
tiled and plated ones use UV0 and expose their repeat count.

The first material in the shallowest `.mtlx` document is used. Missing images
use the node's default and produce a warning. Imported graphs, images and
fallback maps are saved with the viewer's cached model and participate in
undo/reset.

The viewer maps `open_pbr_surface`, `standard_surface`, `gltf_pbr` and
`UsdPreviewSurface` to OpenPBR. Standard Surface uses MaterialX's official
conversion, including its coat tint, metallic specular and sheen roughness rules;
this does not make OpenPBR identical to the source renderer's BSDF. Uniform
networks become material values. Varying networks use `MaterialGraph`; the
material panel notes while a graph compiles or falls back, and the browser console
lists each unsupported part with its node and port. Inputs that have
no effect, such as unsupported controls left at zero or image frame inputs at
their defaults, are ignored. Other unsupported graph inputs use the library's
fallback behavior. When a network
can also be baked into ordinary material maps, those maps remain the
fallback during compilation, after rejection and on WebGL 2.
Disney Principled and Simple Hair surfaces are unsupported. USD Preview uses the metallic workflow; specular-workflow
inputs, occlusion controls and independent coat-normal graphs produce diagnostics.
Subsurface, tangent and lit-emission graph inputs retain the limits described
above. To load `.mtlx` files, use the viewer; the library's
graph API accepts typed nodes and loaded textures.

If the material has no displacement connection, the viewer also detects package
PNG, JPEG, WebP and AVIF images with `height`, `displacement` or `disp` as a
filename word. In **Displacement**, choose a **Package height map** and click
**Apply height map** to enable it, then adjust **Scale** and **Bias**. These maps stay
disabled until applied. The initial scale is 1% of the selected mesh's longest
dimension in local units, with zero bias. Set both values to `0`, or remove the
displacement texture, to turn displacement off. The choices and settings are
saved with the cached model and support undo/reset. When possible, the height map
uses a surface image's UV repeat and offset; otherwise it uses UV0 with one
repeat. Adjust **Wrap & repeat** in the displacement texture slot if needed.

Scalar MaterialX displacement imports as a height map and takes effect on WebGPU.
A single image with height scale/bias keeps its original pixels. Other networks
that depend only on one UV set are baked at the largest input image dimensions,
or 1024 × 1024 without images. The viewer uses WebGPU when available and a slower
CPU fallback when no device is available. Baking runs in the background; larger
images and more complex networks take more time and memory. The imported height
map is saved with the cached model and participates in the same undo/reset step
as the surface material.

Baked heights use an 8-bit PNG normalized to their minimum and maximum. Rounding
adds at most `(maximum - minimum) / 510` height units of error; UV sampling can
also lose details smaller than a texel. Baking covers one 0–1 UV tile; repeating
it can introduce seams. Networks using position, geometric normals, an implicit
shading frame or both UV sets produce a diagnostic and leave displacement disabled.
Vector displacement is unsupported. WebGL 2 keeps the surface material without
applying displacement.
