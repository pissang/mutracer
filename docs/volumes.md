# Volumes

Add bounded fog volumes to a WebGPU or WebGL 2 scene:

```ts
import {type SceneVolume} from '@meimu/mutracer';

const volume: SceneVolume = {
  density: 0.1,
  bounds: {min: [-10, 0, -10], max: [10, 8, 10]},
  color: [0.9, 0.95, 1],
  anisotropy: 0.3,
  heightFalloff: 0.2
};
scene.volumes = [volume];
engine.update();
```

Fog scatters lighting, casts attenuated shadows and supports multiple scattering.
`color` is the fraction of extinguished light that scatters: black absorbs,
white scatters without absorption. A background color is visible through fog but
does not illuminate it; use an ambient, environment or scene light for illumination.
See the [fog example](../examples/volumes.html).

For a local volume, set `shape: 'ellipsoid'` or keep the box and supply an affine
`transform`. Bounds describe the shape before that transform. `density` is a density
multiplier: extinction per world unit at `baseHeight`, before any density field.
Scaling the shape increases the distance traveled through fog without changing
this multiplier. Overlapping volumes add extinction and scattering.

Edit parameters, bounds and transforms in place, then call `engine.update()`;
RenderLoop does this on its next tick. See [scene updates](./updates.md).

## Options and cost

[SceneVolume options and defaults](./api.md#scenevolume) include shape, color,
anisotropy and height falloff. Positive anisotropy favors forward scattering;
negative values favor backward scattering. Height falloff reduces density
exponentially above `baseHeight`, along world +Y, even for rotated volumes.
Density increases below that height.

Cost grows with volume count; the limit is `MAX_VOLUMES` (8). Dense, bright
fog needs more samples and a larger `bounces` budget. Fog events consume that
budget; insufficient depth makes multiple scattering too dark. Glass and alpha
transparency retain their usual bounce behavior. If fog scatters the camera ray
before its first surface, the path uses the opaque bounce limit. Stable denoising
guides add rendering cost for mirrors and alpha-blended surfaces behind fog.

## Limits

- Extinction is gray: colored fog tints scattered light, but cannot produce colored transmission.
- Shapes are boxes and inscribed ellipsoids with hard edges. Mesh boundaries,
  3D textures, VDB and noise density are unsupported.
- Fog disables MNEE, light tracing and photon mapping. Removing all fog restores
  the configured estimators. Diagnostics expose the reason.
- Fog stays outside solid glass and subsurface materials. Nested solids and a
  camera starting inside a solid are approximate; shadow rays remain blocked
  by transmissive surfaces.
- Shadow-catcher masks, surface AOVs and depth queries do not include fog.
  Beauty and denoising guides do include it; fog scattering makes the output covered
  even with a transparent background.
- Three.js `Fog` and `FogExp2` are not converted. Supply `scene.volumes` explicitly.
- Native scene descriptors do not support fog.
