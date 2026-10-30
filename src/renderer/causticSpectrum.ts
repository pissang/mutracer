/**
 * Continuous wavelength to linear RGB weights for caustic photons.
 *
 * CIE 1931 matching functions use the multi-lobe fit from Wyman, Sloan and
 * Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching
 * Functions", JCGT 2(2), 2013. Only the published formula and coefficients are
 * used. Out-of-gamut negatives clamp to zero, and each channel is normalized so
 * that a uniform wavelength keeps white light white.
 */
export const CAUSTIC_WAVELENGTH_MIN = 400;
export const CAUSTIC_WAVELENGTH_RANGE = 300;

type Lobe = readonly [amplitude: number, mean: number, sigmaBelow: number, sigmaAbove: number];
type Rgb = [number, number, number];

const XYZ_LOBES: readonly (readonly Lobe[])[] = [
  [[1.056, 599.8, 37.9, 31.0], [0.362, 442.0, 16.0, 26.7], [-0.065, 501.1, 20.4, 26.2]],
  [[0.821, 568.8, 46.9, 40.5], [0.286, 530.9, 16.3, 31.1]],
  [[1.217, 437.0, 11.8, 36.0], [0.681, 459.0, 26.0, 13.8]]
];
// Linear sRGB primaries, D65.
const XYZ_TO_RGB = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.204, 1.057]
];

function unnormalizedRgb(wavelength: number): Rgb {
  const xyz = XYZ_LOBES.map((lobes) =>
    lobes.reduce((sum, [amplitude, mean, below, above]) => {
      const t = (wavelength - mean) / (wavelength < mean ? below : above);
      return sum + amplitude * Math.exp(-0.5 * t * t);
    }, 0)
  );
  return XYZ_TO_RGB.map((row) => Math.max(0, row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2])) as Rgb;
}

const SCALE: Rgb = (() => {
  const steps = 3000;
  const sum: Rgb = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const rgb = unnormalizedRgb(CAUSTIC_WAVELENGTH_MIN + (CAUSTIC_WAVELENGTH_RANGE * (i + 0.5)) / steps);
    for (let c = 0; c < 3; c++) sum[c] += rgb[c] / steps;
  }
  return sum.map((mean) => 1 / mean) as Rgb;
})();

export function causticSpectrumRgb(wavelength: number): Rgb {
  return unnormalizedRgb(wavelength).map((value, c) => value * SCALE[c]) as Rgb;
}

const lobeSum = (lobes: readonly Lobe[]) =>
  lobes.map(([a, mean, below, above]) => `${a}f*causticSpectrumLobe(wavelength,${mean}f,${below}f,${above}f)`).join('+');

export const causticSpectrumWgsl = /* wgsl */ `
fn causticSpectrumLobe(wavelength:f32,mean:f32,below:f32,above:f32)->f32 {
  let t=(wavelength-mean)/select(above,below,wavelength<mean);
  return exp(-0.5*t*t);
}
fn causticSpectrumRgb(wavelength:f32)->vec3f {
  let xyz=vec3f(${XYZ_LOBES.map(lobeSum).join(',')});
  let rgb=mat3x3f(${[0, 1, 2].map((c) => XYZ_TO_RGB.map((row) => `${row[c]}f`).join(',')).join(',')})*xyz;
  return max(rgb,vec3f(0.0))*vec3f(${SCALE.map((s) => `${s}f`).join(',')});
}
`;
