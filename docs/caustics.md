# Caustics

Enable caustics on the render that needs them:

```ts
render.caustics = {lightTracing: true, photonMapping: true};
```

Choose the estimators for the visible receiver:

| Scene | Settings |
| --- | --- |
| Glass or metal casting onto a directly visible surface | `{lightTracing: true}` |
| Water or glass between the camera and the caustic receiver | `{photonMapping: true}` |
| A mixture of direct, indirect and glass-covered receivers | `{lightTracing: true, photonMapping: true}` |

Light tracing preserves narrow, directly visible caustics without a gather
radius. Photon mapping covers indirect caustics and surfaces seen through glass,
with additional memory and gather cost. Combined estimators assign path coverage
automatically. The viewer's Cornell caustic preset enables photon mapping.

Set `render.caustics = undefined` to disable every estimator. See
[API options and defaults](./api.md#caustics).

## Options and cost

```ts
render.caustics = {
  lightTracing: {photonsPerSample: 32768},
  photonMapping: {photonsPerSample: 32768, initialRadius: 0.1}
};
```

Both estimators require WebGPU; WebGL ignores those options. HDR readback,
display and denoising include the combined result. Changes to any option restart
accumulation. The native SDK provides the same choices through Rust
`CausticSettings` and the C `MT_CAUSTIC_*` flags.

More emitted photons increase time and memory costs. Photon-map storage grows
by 24 bytes per emitted photon plus a spatial index of at most 2 MiB, in
addition to image accumulation. Requests above the device limits or the 128 MiB
batch budget use fewer photons. Photon batches cover the full image even when PT
uses tiles or adaptive sampling. Their time counts toward the frame budget;
adaptive variance currently measures only the PT component.

## Limits

Light tracing follows surfaces with no diffuse, subsurface, fuzz or coat
contribution and specular roughness at most 0.1. It supports emissive triangles,
rectangles, spheres, spotlights, directional lights and environment lighting,
perspective and orthographic cameras, depth of field and dispersion. Photon
mapping adds caustics throughout the allowed camera path. Volume scattering
events and shadow catchers remain with ordinary path tracing.

Photon mapping starts with a blurred density estimate and decreases its radius
as samples accumulate. A small initial radius can be noisy; a large one can blur
nearby surfaces and details. At the first diffuse surface, the gather radius
is capped to about two projected pixels to reduce visible patches after
denoising. Reflections and refractions use an approximate footprint.
Increasing photon count can help, but does not make every additional batch
improve the image monotonically. More samples do not remove the finite precision
loss in stored photon data. Spatially correlated photon noise can remain
visible after denoising. A denoiser can soften narrow caustic lines even when it
improves average brightness; compare raw HDR and denoised output when judging
detail. Prefer light tracing when the receiver is directly visible.

Both estimators fall back to PT for the whole scene when a smooth caster uses
stochastic blend coverage. Cutout coverage remains supported. Environment
caustics follow PT's visible-background behavior through the first smooth
transmission; an explicit black background suppresses that contribution.
Use ordinary PT when quantitative energy agreement matters.
