# Sampling patterns

`render.samplingPattern` selects the sample sequence. Changing it restarts
accumulation. The denoiser never changes it.

| Pattern | Use |
| --- | --- |
| `'sobol'` (default) | General use, and with any denoiser. Owen-scrambled Sobol; converges well per pixel with spatially decorrelated error |
| `'zsobol'` | Low sample counts **without** a denoiser. Morton-ordered Sobol with blue-noise error |
| `'random'` | PCG white noise; an independent Monte Carlo reference |

```ts
render.samplingPattern = 'zsobol';
```

## Caveats

- **ZSobol budget**: ZSobol sizes its pattern from `maxSamples`, rounded up to
  a power of two and capped at 65536 (unlimited rendering uses the cap).
  Changing the rounded budget restarts accumulation. The first sample always
  has blue-noise error; later prefixes of a large budget cannot all keep it.
- **Determinism**: offline sequences are deterministic, including
  `sampleSequenceOffset`. Use disjoint offset ranges for animation frames.
- **Backends**: WebGPU and WebGL 2 can differ in floating-point rounding even
  with identical sequence points.
- **Dispersion**: on WebGPU, `dispersionWavelengths: 3` with
  `directLightCandidates > 1` can need more samples in individual RGB channels
  under strongly colored lighting and materials. Lower overall noise does not
  guarantee lower noise in every channel.
- **Fireflies**: very narrow specular lobes under directional lights can
  produce rare, large contributions with any pattern. Sampling does not clamp
  them; use `render.clamping` if needed.

## Implementation notes

- `sobol` uses Burley's Owen-scrambled 2D Sobol sequences, scrambled
  independently per pixel and domain.
- ZSobol is blue-noise-first: sample zero uses a one-sample ZSobol pattern,
  and later samples use an independent scramble for the remaining budget.
- On WebGPU each pixel follows its own sequence, so adaptive sampling and
  preview tiles do not skip sequence points.
- Camera, aperture, light, BSDF and phase sampling use separate dimensions;
  spectral wavelengths reuse them to reduce colored noise. Interactive resets
  keep seed zero for stable screen-relative noise.
