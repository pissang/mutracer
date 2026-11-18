# Parsing MaterialX documents

Import `parseMaterialX` from `@meimu/mutracer/materialx` and pass it the XML
text of a `.mtlx` file. By default it selects the first top-level
`surfacematerial`. Pass its exact name as the second argument to select another.

```ts
import { OpenPBRMaterial, Texture } from '@meimu/mutracer';
import { parseMaterialX } from '@meimu/mutracer/materialx';

async function loadMaterial(documentUrl: URL) {
  const response = await fetch(documentUrl);
  if (!response.ok) throw new Error(`Material download failed (${response.status})`);
  const parsed = parseMaterialX(await response.text());
  for (const warning of parsed.warnings) console.warn(warning);

  for (const [node, image] of parsed.images) {
    if (!parsed.graph?.nodes.some(n => n.id === node)) continue;
    const asset = await fetch(new URL(image.file, response.url));
    if (!asset.ok) throw new Error(`Texture download failed (${asset.status})`);
    const texture = new Texture(await createImageBitmap(await asset.blob()));
    texture.colorSpace = image.srgb ? 'srgb' : 'linear';
    texture.flipY = true;
    if (image.wrapS) texture.wrapS = image.wrapS;
    if (image.wrapT) texture.wrapT = image.wrapT;
    parsed.graph.setInput(node, 'file', {type: 'filename', value: texture});
  }
  return new OpenPBRMaterial({...parsed.values, graph: parsed.graph});
}
```

For materials without external textures, construct the material directly from
`values` and `graph`. Constant-only surfaces can have an undefined `graph`.
The parser reads XML synchronously. Your application resolves image filenames,
loads pixels and owns the resulting textures.

The supported surface models are `open_pbr_surface`, `standard_surface`,
`gltf_pbr` and `UsdPreviewSurface`. Check `warnings` and `coverage` for unsupported
inputs. A missing selected material or surface shader throws. Rendering support
depends on the node network and backend. See [MaterialGraph](api.md#materialgraph).

A connected scalar displacement shader produces a separate `displacement` plan.
Its mode indicates whether the height can use a texture directly, needs baking
in UV space, or falls back. The example above loads the surface material only.
The [Viewer](viewer.md) also handles texture packages and height baking.
