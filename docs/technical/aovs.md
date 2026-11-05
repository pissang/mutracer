# Surface color AOVs

MuTracer has two pairs of surface color outputs. `diffuseAlbedo` and
`specularAlbedo` report how much light a surface reflects. `diffuseColor` and
`specularColor` report the material colors that produce it. Usage and the exact
definitions are in [surface outputs](../api.md#surface-outputs); this note explains
why both pairs exist, how they are named and how they are stored.

## Reflectance and color

The albedo kinds are directional-hemispherical reflectance: the fraction of
uniform incident light that the prepared OpenPBR BSDF reflects toward the view
direction. They integrate the BSDF by quadrature (`aovReflectance*.wgsl.ts` and
`.glsl.ts`), so they cost more than the other outputs and support only materials
the quadrature models. Coat, fuzz, anisotropy and similar hits are marked
unsupported.

The color kinds read resolved material inputs without integration:

- diffuse: base weight × base color × (1 − metalness)
- specular: metalness × base weight × base color + (1 − metalness) ×
  specular weight × specular color × F0, with F0 from the specular IOR

Both are multiplied by the coat color, weighted by the coat weight. Transmission,
partial alpha, media and nonstandard materials have zero validity.

EASU detail recovery needs the color kinds, not reflectance. It compares
display-resolution colors with their average over each render pixel and scales
the part of the upscaled radiance that follows color by that ratio. Layer factors
that are uniform across a surface, such as coat or fuzz, cancel in the ratio, so
the cheap estimate covers more surfaces than the quadrature does. Reflectance
remains the right input for compositing and other uses that need reflected energy.

## Names

Renderers use "albedo" for both quantities:

| Renderer | Integrated reflectance | Material color |
| --- | --- | --- |
| [MoonRay](https://docs.openmoonray.org/user-reference/how-to-guides/render-outputs/material-aovs/) | `albedo`: response to unoccluded white light from all directions | `color` |
| [Mitsuba 3](https://mitsuba.readthedocs.io/en/stable/src/generated/plugins_integrators.html) | `albedo`: diffuse reflectance, approximate for some materials | none |
| [Arnold](https://help.autodesk.com/cloudhelp/ENU/AR-Core/files/ac-output-aovs/arnold_user_guide_ac_output_aovs_ac_aovs_html.html) | none | `diffuse_albedo`, `specular_albedo`: colors without lighting |
| [Cycles](https://docs.blender.org/manual/en/latest/render/layers/passes.html) | none | `Diffuse Color`, `Glossy Color`: BSDF color weights |
| V-Ray, Redshift | none | `Diffuse Filter` |

MuTracer's names match MoonRay: albedo for integrated reflectance, color for
material inputs. Albedo for reflectance also matches Mitsuba and the
"directional albedo" of energy compensation work. Arnold uses albedo for colors,
so documentation always states the definition next to the name. No surveyed
renderer names an AOV "reflectance"; the viewer uses it only in labels.

These outputs are separate from the OIDN `albedo` guide, which follows its own
path rules for denoising.

## Storage

The WebGPU accumulation has four `vec4f` lanes per pixel (`AOV_LAYOUT`):
depth with roughness, position with hit count, diffuse and specular. A lobe's
albedo and color share its lane, selected per kind by mask bits 3–4 and 7–8, so a
render may request only one of them per lobe. Resolve, display and snapshot shaders
see a color kind as the albedo kind of its lane (`aovLaneKind`), so they need no
color-specific code. Separate lanes would add 32 bytes per pixel to every AOV
render. If both are ever needed together, adding lanes lifts the restriction
without changing the API.

Display-resolution renders requesting only `depth`, `diffuseColor` and
`specularColor` use a compact 24-byte layout: float depth and hit count, plus two
colors in half precision. It skips the center pass, so it has no ID or motion.
Half-precision sums lose precision as the sample count grows, which is acceptable
only because display resolution stops at 4 samples (`DISPLAY_AOV_SAMPLE_CAP`).
For detail recovery, 4 jittered samples matched 16 within measurement noise.
Render resolution keeps the full layout for any request.

## Native

Native shares `aovTraceDisplay.wgsl.ts` but still requests display-resolution
colors through the albedo bits with the `AOV_DISPLAY` override. The web build never
sets that override. Native should adopt the color kinds when it is next aligned
with web AOVs.
