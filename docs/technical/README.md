# Technical notes

Design notes for contributors: how an algorithm works, why it was chosen and its
limits. Usage stays in the [guides](../).

- [Acceleration structures](./acceleration.md): TLAS and BLAS defaults,
  coincident hits, rejected alternatives.
- [Surface color AOVs](./aovs.md): reflectance versus color outputs, names and storage.
- [Caustic estimators](./caustics.md): path partition, light tracing and photon mapping.
- [Continuous-wavelength dispersion](./continuous-spectrum.md): spectral
  response, sampling, shared prefixes.
- [Display upscale](./display-upscale.md): EASU and albedo detail compensation.
- [Material graph specialization](./material-graph-codegen.md): IR, interpreter,
  tier planner and compile cost.
- [Megakernel value layouts](./megakernel-value-layouts.md): WGSL value
  contracts and compiler sensitivity.
- [Motion AOV](./motion-aov.md): previous-frame correspondence, visibility and
  deformation.
- [OpenPBR implementation](./openpbr.md): data flow, BSDF, energy tables, medium
  boundaries and acceptance rules.
- [PBRT import mapping](./pbrt-import.md): coordinate, material, light and
  comparison conversions.
- [Temporal denoising](./temporal-denoising.md): window, correspondence chain,
  memory and regression gates.
- [Reflection motion](./temporal-reflection-motion.md) in the offline window.
- [Tile scheduling](./tiling.md): GPU-time tile prediction and unattainable budgets.
- [WebGL 2 backend](./webgl.md): constraints and open issues.

Native notes are in [`native/docs/technical/`](../../native/docs/technical/), such as the
[Metal HWRT silent-miss guard](../../native/docs/technical/metal-silent-miss-guard.md).
