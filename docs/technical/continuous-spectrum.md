# Continuous-wavelength dispersion

MuTracer renders dispersion with continuous wavelengths inside an RGB renderer.
Wavelength decides how light refracts and how its energy divides between RGB
channels. Lights, materials and media stay RGB, so this is not spectral rendering.
The implementation is in `src/renderer/spectrum.ts`, and it runs only when a material
has `transmissionDispersionScale > 0`.

## Spectral response

`spectrumRgb` converts a wavelength in 400–700 nm to linear sRGB weights:

1. Evaluate the CIE 1931 matching functions with the multi-lobe fit from Wyman, Sloan
   and Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching
   Functions", JCGT 2(2), 2013.
2. Convert XYZ to linear sRGB and clamp negative values to zero.
3. Scale each channel so its mean over a uniform wavelength is 1.

The scale keeps white light white on average. The clamp keeps out-of-gamut colors
saturated instead of colorimetrically exact, and it leaves red with a small violet
lobe, which is why the short end of a rainbow looks violet instead of blue.

## Sampling

Both integrators sample from 5 nm inverse CDF tables. They use different estimators
because they carry different quantities.

| | Camera paths | Caustic photons |
|---|---|---|
| Distribution | The response of the path's RGB channel | The sum of the RGB responses |
| Carries | One RGB channel | RGB flux |
| Energy weight | None; the distribution is the response | `spectrumRgb(λ) / (pdf(λ) · 300)` |
| Random number | `CAMERA_WAVELENGTH`, shared by a sample's three paths | Photon emission dimension 69 |

Camera paths evaluate no response, so their effective response is a 5 nm histogram of
the fit. Photons apply the weight exactly. Sharing one random number across a camera
sample's channels keeps their error correlated with the other common random numbers.

`dispersionWavelengths: 3` traces one path per channel in each sample. With
`dispersionWavelengths: 1`, a dispersive primary hit selects one channel at random
and multiplies the result by 3; other primary hits trace full RGB. This is not hero
wavelength sampling, which carries several wavelengths along one path and combines
them with MIS.

## Channels and gathering

A path stores its channel and its refracting wavelength separately:
`spectralChannel` selects the radiance it keeps, and `wavelength` only drives
`sampling_cauchy_ior`. A channel of 0 keeps full RGB. Red paths can sample violet, so
the channel cannot be derived from the wavelength.

Photon gathering filters photon flux by the camera path's channel. This splits RGB
across the camera paths and applies no second spectral weight, so energy is shared
between path tracing and caustics the same way as without dispersion.

## Short-wavelength IOR limit

Cauchy IOR rises quickly at short wavelengths. At strong dispersion scales, violet
light reaches IORs that reflect or trap much of it, and wide caustics turn yellow.
`spectrumIorWavelength` therefore eases the refracting wavelength below 500 nm toward
475 nm, while color keeps the sampled wavelength. The mapping is monotonic and
continuous, so the gradient has no hard edge.

This limit is an artistic choice and not physically based. It narrows the violet end
of the spectrum, and strong dispersion scales still lose some blue.

## Differences from spectral rendering

| Area | Spectral rendering | MuTracer |
|---|---|---|
| Lights | Emission varies with wavelength | RGB, with an implicit broad spectrum; a sodium lamp still disperses into a full rainbow |
| Materials and textures | Reflectance varies with wavelength, often upsampled from RGB | RGB, so metamerism cannot appear |
| Media | Absorption and scattering vary with wavelength | Three RGB coefficients |
| Thin film | Interference is integrated over wavelength | Evaluated at 620, 540 and 450 nm |
| Refractive index | Often measured curves or Sellmeier equations | Cauchy from IOR and Abbe number, with the short-wavelength limit |
| Wavelengths per path | Often several, combined with MIS | One per path or photon |
| Output color | Integrated from the spectrum into the output color space | Fixed clamped sRGB weights, normalized per channel |

These differences matter most for narrow-band lights, colored absorption over long
paths, metamerism and predictive color. Clear glass and crystal under broad lights are
closer to the spectral result, because their color comes mainly from refraction.

Full spectral rendering would change the light, material, texture and medium data
models, and requires RGB-to-spectrum upsampling in both shader backends and native.

## Changing this code

- Update WGSL and GLSL together. Both are generated from `spectrum.ts`; caustics are
  WGSL only.
- `spectralChannel` must be set wherever a path's wavelength is set.
- `tests/unit/spectrum.test.ts` covers white balance, weight bounds, channel
  distributions and the IOR limit. Check the image result on a real GPU in both
  backends, as described in `AGENTS.md`.
