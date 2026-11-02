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
automatically. The viewer's Cornell caustic preset enables both estimators.

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

More emitted photons can reduce noise but cost more time and memory. Photon-map
storage adds 28 bytes per emitted photon plus up to 13 MiB of overhead. Requests
above the device limits or the 128 MiB batch budget use fewer photons. Photon
batches cover the full image even when path tracing uses tiles or adaptive
sampling. Their time counts toward the frame budget, but adaptive variance measures
only the path-traced component.

## Limits

Light tracing follows surfaces with no diffuse, subsurface, fuzz or coat
contribution and specular roughness at most 0.1. It supports emissive triangles,
rectangles, spheres, spotlights, directional lights and environment lighting,
perspective and orthographic cameras, depth of field and dispersion. Photon
mapping adds caustics throughout the allowed camera path. Volume scattering
events and shadow catchers remain with ordinary path tracing.

Complete caustic light-to-camera paths can be longer than `bounces`. Align total
path-length limits when comparing radiance with another renderer.

Photon mapping starts blurred and shrinks its radius as samples accumulate. A
small initial radius can be noisy; a large one can blur nearby surfaces and details.
Distant smooth casters enlarge the automatic radius, so set `initialRadius` if deep
caustics look too blurred. At the first diffuse surface, the gather radius is capped
to about two projected pixels to reduce patches after denoising; reflections and
refractions use an approximate footprint. More photons can help, but not every
batch improves the image, and more samples do not remove the precision loss in
stored photon data.

With photon mapping alone, directly visible receivers can show fewer cloud-like
OIDN blotches but grainier raw images. Receivers seen through reflection or
refraction can still show blotches. Enable light tracing as well for the cleanest
directly visible receivers.

A denoiser can soften narrow caustic lines, so compare raw HDR with denoised output
when judging detail. Use raw HDR for energy comparisons: displayed or denoised
brightness can differ even when regional HDR energy agrees.

Both estimators fall back to path tracing for the whole scene when a smooth caster
uses stochastic blend coverage. Cutout coverage remains supported. Environment
caustics follow path tracing's visible-background behavior through the first smooth
transmission; an explicit black background suppresses that contribution.
Quantitative energy agreement with other renderers is not guaranteed.
