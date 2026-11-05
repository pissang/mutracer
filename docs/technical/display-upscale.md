# Display upscale

`createEasuPass` enlarges a reduced-resolution render to the canvas, and with
`albedoDetail` it restores surface texture detail from full-resolution color AOVs.
Usage, costs and limits are in [post-processing](../post-processing.md); the AOV
side is in [surface color AOVs](./aovs.md). This note explains the algorithm. The
code is `src/renderer/easu.ts` with `wgsl/easu.wgsl.ts` and
`wgsl/easuDetail.wgsl.ts`.

## Pipeline position

The pass is a display post-process: it runs after composition, tone mapping and
denoising, on display-encoded RGB. A pass can change the image size through
`outputSize`, so the upscale is ordinary chain state and needs no special case in
composition, export or denoising. Beauty, its denoising and the AOVs keep their own
resolutions; only the displayed image is enlarged.

An input at the output size is copied, and a larger input is area-averaged, so one
registration serves both a reduced preview and a full-resolution final render.

## EASU

The enlargement is AMD FidelityFX FSR 1 EASU, without RCAS sharpening. It estimates
a local edge direction and filters along it with a 12-tap lobe. FSR expects inputs
in [0, 1], so extended-range output normalizes the neighborhood only for the
direction estimate and filters the original values. EASU cannot invent detail that
the reduced render does not contain.

## Detail compensation

Texture detail lost at render resolution is still present in the display-resolution
`diffuseColor` and `specularColor` AOVs. Compensation transfers it:

1. **Low guides.** The full-resolution colors are area-averaged over each render
   pixel's exact footprint, including noninteger scales, so the low guides match
   what beauty integrated. No second AOV allocation is needed.
2. **Local model.** For each render pixel, a guided-filter regression over a 3×3
   window fits scene-linear radiance as `slope × color + intercept` per channel.
   Diffuse shading follows color (slope), while highlights and reflections do not
   (intercept). Flat colors give a slope near zero, so they are left alone.
3. **Upsampling.** The low guides are enlarged with exactly the same EASU taps and
   weights as beauty, so beauty and guides share one footprint.
4. **Ratio.** At each output pixel, the full-resolution color replaces the
   upsampled one inside the model: `(slope × hi + intercept) / (slope × low +
   intercept)`, clamped per channel to [0.7, 1.43]. Without a valid model it falls
   back to the plain color ratio `hi / low`.
5. **Display transform.** The ratio is scene-linear, but the image is tone-mapped.
   A lookup table built from the current tone mapping and grading maps displayed
   RGB back to scene-linear per channel, applies the ratio and maps it forward, so
   curve shoulders and toes respond as the tone mapper would. Only the change is
   added to the displayed value, which keeps it exact where the ratio is 1.

Compensation is skipped, leaving EASU alone, where it would be wrong:

- AOV validity or coverage below 0.95 (transmission, cutouts, background,
  unsupported materials);
- silhouettes, detected from a change in hit coverage or a break in the planarity
  of inverse depth (which is linear in screen space on any plane, so sloped
  surfaces are not silhouettes);
- color below 10⁻³, treated as black.

Clipped highlights cannot be recovered: the inverse tone mapping has no
information above the display maximum.

## Retained alternatives

`createEasuPassImpl` keeps three internal variants for comparisons:

- **Plain color ratio.** Scaling all displayed radiance by `hi / low` also scaled
  highlights and other light that does not follow color, which limited the usable
  ratio range. The guided model widened it to the current default.
- **Separate lobes.** Diffuse and specular ratios weighted by lobe shares estimated
  from the low colors; beauty has no separate lobes to weight them exactly.
- **Silhouette reconstruction.** Front and back colors from depth-matched
  low-resolution neighbors, mixed by full-resolution coverage. It sharpens
  backgrounds but loses detail on thin structures, glass and reflections
  compared with EASU alone.

Ratios were first applied to encoded display RGB, which over-darkened dark decals;
applying them in linear and then through the display transform let the clamp range
grow. The public tuning options were removed; `EASU_DETAIL` holds the shared
defaults, which native also uses.
