# Material graphs

Attach a `MaterialGraph` to an `OpenPBRMaterial` to drive its inputs from a node
network. Terminal names are the material's camelCase inputs; inputs without a
terminal connection keep the material's constants and maps. Inspect a node
definition, build the graph, validate it, then commit with `engine.update()`:

```ts
import {MaterialGraph, OpenPBRMaterial, describeMaterialGraphNode} from '@meimu/mutracer';

const constant = describeMaterialGraphNode('constant')!;
console.log(constant.signatures); // Supported types, inputs, defaults and outputs.
const graph = new MaterialGraph({
  nodes: [{
    id: 'roughness', category: 'constant', type: 'float',
    inputs: {value: {value: 0.4}}
  }]
});
graph.setTerminalInput('specularRoughness', {node: 'roughness'});
const material = new OpenPBRMaterial({graph, baseColor: [0.8, 0.2, 0.1]});
// Include material in the engine's scene before committing.
graph.setInput('roughness', 'value', {value: 0.6});
const diagnostics = graph.validate();
if (diagnostics.length) throw new Error(diagnostics.map(d => d.message).join('\n'));
engine.update();
const result = await engine.waitForMaterialGraphs();
if (result.outcome === 'settled' && result.state.status === 'failed') {
  console.warn(result.state.diagnostics);
}
```

Connect a node input with `{connection: {node: 'roughness'}}`. Use the catalog to
choose output ports and overloads; the [API reference](./api.md#materialgraph)
covers type inference, validation, editing methods and defaults. Textures stay
editable resources with [the usual update notifications](./updates.md#materials-textures-and-lights);
graph edit costs are in [material graph edits](./updates.md#material-graph-edits).
To import a `.mtlx` document, see [parsing MaterialX documents](./materialx.md).

## Exchanging graphs

Exchange authored graphs with `graph.toJSON()` and `MaterialGraph.fromJSON(json)`.
JSON holds texture IDs, not pixels: supply ID and lookup callbacks, and load the
textures first:

```ts
const json = graph.toJSON({textureId: texture => textureIds.get(texture)!});
const restored = MaterialGraph.fromJSON(json, {
  resolveTexture: id => texturesById.get(id)
});
```

Missing callbacks or unresolved IDs throw. See [JSON options](./api.md#materialgraph).

## Waiting for graphs

`engine.waitForMaterialGraphs({signal})` waits until the whole committed scene's
graphs are loaded and compiled. It always resolves, with a detached `state`
snapshot:

| `outcome` | Meaning |
| --- | --- |
| `settled` | The request reached `idle`, `ready` or `failed`; check `state.status` and `state.diagnostics` to tell success from fallback |
| `superseded` | A newer committed scene edit started another request; call again to wait for it. Camera-only edits do not supersede |
| `aborted` | The signal cancelled this wait; compilation continues |
| `unavailable` | Disposal, device loss or initialization failure, with an `engine-unavailable` diagnostic |

A scene without pending graph work settles immediately. The wait neither commits
edits nor drives rendering: keep calling `refine()` or running RenderLoop until
it resolves.

The compiler module downloads when the committed scene first uses a graph, or
earlier with `shaderPrefetch: 'editing'`. While graph preparation is pending or
after it fails, interactive rendering uses each material's previous successful
graph, or its constants and maps. Node and port errors affect just their
materials. For offline rendering, see [`converge()`](./api.md#convergeoptions).

Read `engine.getDiagnostics()?.materialGraphs` for `status` (`idle`, `compiling`,
`ready`, `failed`), revisions, topology count, compilation timings and located
diagnostics (`code`, `message`, `materialId`, `node`, `port`); see
[fields](./api.md#materialgraph). A scene with only texture-slot graphs reports
`idle` with topology count zero.

## Backends and texture slots

Both backends render compatible image graphs through ordinary texture slots,
without compiling a graph shader: base color, roughness, metalness, transmission
weight, coat weight, specular weight and color, fuzz color and roughness, and
tangent-space normal images, using fixed UV0/UV1 selection, wrapping, channel
selection, UV scale/offset and gain. Results can differ slightly from graph
evaluation in floating-point rounding.

The graph path is kept for nonlinear color operations, nonzero output bias,
scalar sRGB decoding, incompatible shading frames, alpha images that reorder
channels, transmission-medium and glTF anisotropy contexts where slot evaluation
would change behavior, and float or integer sources for coat, specular and fuzz.

Graphs that need graph evaluation require WebGPU. WebGL 2 renders the
material's constants and maps and reports `unsupported-backend` in
`engine.getDiagnostics()?.materialGraphs`.

## Supported nodes

WebGPU supports these MaterialX 1.39 categories:

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

Types are `float`, `integer`, `boolean`, `color3/4` and `vector2/3/4`; not every
node supports every type. Integer parameters are limited to ±16,777,216.
Undefined domains, such as division by zero or normalizing a zero vector, can
produce non-finite pixels. Use `extract` and `combine` instead of the deprecated
`swizzle`.

Images:

- `file` inputs hold a loaded `Texture` or `UdimTexture`, which supplies the
  color space, UV transform and wrapping. Filter and address inputs accept only
  `linear` and `periodic`; set other wrapping on the texture.
- An image input without a texture uses the node's default value.
- `texcoord.index` selects UV0 or UV1, overriding `Texture.uvChannel`; missing
  UV sets read zero.
- `tiledimage` applies tiling, subtracts its offset, then applies its real-world
  size ratio. `place2d.operationorder` defaults to `0` (SRT); `1` selects TRS.
- `gltf_colorimage` has type `color4` and outputs `outcolor` and `outa`.
- UDIM tiles follow [UDIM textures](./materials.md#udim-textures).

Geometry and transforms:

- Geometry nodes accept `space: {type: 'string', value: 'object' | 'world'}`,
  default `object`. Only the primary tangent frame is supported.
- `normalmap` uses the world-space vertex normal and normalized primary
  tangents, whichever UV set samples the image; black texels keep the vertex normal.
- Transform nodes convert between object and world space; specify both spaces.
  Without spaces, points and vectors pass through, and normals are still normalized.
- `rotate2d/3d.amount` and `place2d.rotate` are in degrees.

Color and patterns:

- `luminance` returns gray with ACEScg coefficients by default and keeps `color4` alpha.
- `range` keeps the sign when applying gamma, then optionally clamps.
- `rgbtohsv`, `hsvtorgb` and `hsvadjust` accept `color3/4` and keep alpha;
  `hsvadjust` adds hue and multiplies saturation and value.
- Extract indices must lie within the input's components.
- Split nodes use point samples, so thin boundaries can alias. More fractal
  octaves cost more per hit.

## Terminals

Graphs can drive base weight, color, diffuse roughness and metalness; specular
weight, color, roughness, IOR and anisotropy (including the material's anisotropy
aliases); transmission weight and color; fuzz and coat inputs; thin-film weight,
thickness and IOR; emission; `normal` (alias `geometryNormal`); and `opacity`
(alias `geometryOpacity`). Displacement, volume, subsurface and tangent are not
supported.

**Opacity** replaces scalar coverage before alpha texture factors and
[alpha-mode resolution](./materials.md#alpha), on surface and shadow rays. In `auto`, graph
coverage selects blend unless a positive cutoff selects mask; `opaque` ignores
it. Opacity can use UVs and position, but not the shading normal or tangent
frame. UV-dependent opacity requires `uvProjection: 'none'`. Complex networks
add shadow-ray cost.

**Emission** color and luminance graphs on lit materials light nearby surfaces
on WebGPU. Lit emission and its coat absorption can use UVs and object or world
position, but not the shading frame; UV-dependent lit emission requires
`uvProjection: 'none'`. Unlit emission has no such limits and does not light
other surfaces. Light sampling uses the constant emission: a representative
value helps, while a black one still works but small bright features need more
samples. Complex networks add direct-lighting cost.

Dependencies outside these limits fall back to the constant value with a
located diagnostic.

With WebGPU [caustics](./caustics.md#limits), graphs work on receivers, but
graph-driven specular surfaces do not cast caustics. Lit emission and its coat
absorption use the constant emission when they need graph evaluation and report
`unsupported-transport`.

How graphs compile and which tier evaluates them is described in
[material graph specialization](./technical/material-graph-codegen.md).
