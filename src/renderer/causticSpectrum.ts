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

// Inverse CDF of r+g+b in 5 nm bins. Photons spend fewer samples on dim spectrum
// tails, and narrow bins keep the flux of every wavelength near-constant in total.
const SAMPLE_BINS = 60;
const SAMPLE_BIN_WIDTH = CAUSTIC_WAVELENGTH_RANGE / SAMPLE_BINS;
const SAMPLE_CDF: readonly number[] = (() => {
  const substeps = 20;
  const cdf = [0];
  for (let bin = 0; bin < SAMPLE_BINS; bin++) {
    let mass = 0;
    for (let i = 0; i < substeps; i++) {
      const [r, g, b] = causticSpectrumRgb(CAUSTIC_WAVELENGTH_MIN + (bin + (i + 0.5) / substeps) * SAMPLE_BIN_WIDTH);
      mass += r + g + b;
    }
    cdf.push(cdf[bin] + mass);
  }
  return cdf.map((value) => value / cdf[SAMPLE_BINS]);
})();

/** Maps a unit random number to a wavelength and its probability density. */
export function causticSpectrumSample(u: number) {
  let low = 0;
  let high = SAMPLE_BINS;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (SAMPLE_CDF[middle] <= u) low = middle;
    else high = middle;
  }
  const mass = SAMPLE_CDF[low + 1] - SAMPLE_CDF[low];
  return {
    wavelength: CAUSTIC_WAVELENGTH_MIN + SAMPLE_BIN_WIDTH * (low + (u - SAMPLE_CDF[low]) / mass),
    pdf: mass / SAMPLE_BIN_WIDTH
  };
}

// Cauchy IOR grows quickly at short wavelengths and strong dispersion scales turn
// violet light into total internal reflection. Below 500 nm the refracting
// wavelength eases toward 475 nm, the shortest one camera paths use, while color
// weights keep the sampled wavelength.
const IOR_KNEE = 500;
const IOR_KNEE_WIDTH = 25;

export function causticSpectrumIorWavelength(wavelength: number) {
  if (wavelength >= IOR_KNEE) return wavelength;
  return IOR_KNEE - IOR_KNEE_WIDTH * (1 - Math.exp((wavelength - IOR_KNEE) / IOR_KNEE_WIDTH));
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
fn causticSpectrumIorWavelength(wavelength:f32)->f32 {
  if(wavelength>=${IOR_KNEE}.0) { return wavelength; }
  return ${IOR_KNEE}.0-${IOR_KNEE_WIDTH}.0*(1.0-exp((wavelength-${IOR_KNEE}.0)/${IOR_KNEE_WIDTH}.0));
}
fn causticSpectrumSample(u:f32,pdf:ptr<function,f32>)->f32 {
  let cdf=array<f32,${SAMPLE_BINS + 1}>(${SAMPLE_CDF.map((value) => `${value}f`).join(',')});
  var low=0u;
  var high=${SAMPLE_BINS}u;
  while(high-low>1u) {
    let middle=(low+high)/2u;
    if(cdf[middle]<=u) { low=middle; } else { high=middle; }
  }
  let mass=cdf[low+1u]-cdf[low];
  *pdf=mass/${SAMPLE_BIN_WIDTH}.0;
  return ${CAUSTIC_WAVELENGTH_MIN}.0+${SAMPLE_BIN_WIDTH}.0*(f32(low)+(u-cdf[low])/mass);
}
`;
