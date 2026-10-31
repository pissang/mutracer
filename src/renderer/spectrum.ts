/**
 * Continuous wavelength sampling shared by camera paths and caustic photons.
 *
 * CIE 1931 matching functions use the multi-lobe fit from Wyman, Sloan and
 * Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching
 * Functions", JCGT 2(2), 2013. Only the published formula and coefficients are
 * used. Out-of-gamut negatives clamp to zero, and each channel is normalized so
 * that a uniform wavelength keeps white light white.
 */
export const SPECTRUM_WAVELENGTH_MIN = 400;
export const SPECTRUM_WAVELENGTH_RANGE = 300;

// Amplitude, mean, sigma below the mean and sigma above it.
const XYZ_LOBES: number[][][] = [
  [[1.056, 599.8, 37.9, 31.0], [0.362, 442.0, 16.0, 26.7], [-0.065, 501.1, 20.4, 26.2]],
  [[0.821, 568.8, 46.9, 40.5], [0.286, 530.9, 16.3, 31.1]],
  [[1.217, 437.0, 11.8, 36.0], [0.681, 459.0, 26.0, 13.8]]
];
// Linear sRGB primaries, D65.
const XYZ_TO_RGB: number[][] = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.204, 1.057]
];

function unnormalizedRgb(wavelength: number): number[] {
  const xyz = XYZ_LOBES.map((lobes) => {
    let sum = 0;
    for (const lobe of lobes) {
      const t = (wavelength - lobe[1]) / (wavelength < lobe[1] ? lobe[2] : lobe[3]);
      sum += lobe[0] * Math.exp(-0.5 * t * t);
    }
    return sum;
  });
  return XYZ_TO_RGB.map((row) => Math.max(0, row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2]));
}

function channelScale(): number[] {
  const steps = 3000;
  const sum = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const rgb = unnormalizedRgb(SPECTRUM_WAVELENGTH_MIN + (SPECTRUM_WAVELENGTH_RANGE * (i + 0.5)) / steps);
    for (let c = 0; c < 3; c++) sum[c] += rgb[c] / steps;
  }
  // Rounded so JavaScript and native builds generate identical shader text.
  return sum.map((mean) => Number((1 / mean).toFixed(6)));
}
const SCALE = channelScale();

export function spectrumRgb(wavelength: number): number[] {
  return unnormalizedRgb(wavelength).map((value, c) => value * SCALE[c]);
}

// Inverse CDFs in 5 nm bins: one per RGB channel for camera paths, and r+g+b for
// photons. Narrow bins keep each sampled response close to the fit.
const SAMPLE_BINS = 60;
const SAMPLE_BIN_WIDTH = SPECTRUM_WAVELENGTH_RANGE / SAMPLE_BINS;
export const SPECTRUM_PHOTON_DISTRIBUTION = 3;
function sampleCdfs(): number[] {
  const substeps = 20;
  const cdfs: number[] = [];
  for (let distribution = 0; distribution <= SPECTRUM_PHOTON_DISTRIBUTION; distribution++) {
    const cdf = [0];
    for (let bin = 0; bin < SAMPLE_BINS; bin++) {
      let mass = 0;
      for (let i = 0; i < substeps; i++) {
        const rgb = spectrumRgb(SPECTRUM_WAVELENGTH_MIN + (bin + (i + 0.5) / substeps) * SAMPLE_BIN_WIDTH);
        mass += distribution === SPECTRUM_PHOTON_DISTRIBUTION ? rgb[0] + rgb[1] + rgb[2] : rgb[distribution];
      }
      cdf.push(cdf[bin] + mass);
    }
    for (const value of cdf) cdfs.push(Number((value / cdf[SAMPLE_BINS]).toFixed(7)));
  }
  return cdfs;
}
const SAMPLE_CDFS = sampleCdfs();

/** Maps a unit random number to a wavelength and its probability density. */
export function spectrumSample(distribution: number, u: number) {
  const first = distribution * (SAMPLE_BINS + 1);
  let low = 0;
  let high = SAMPLE_BINS;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (SAMPLE_CDFS[first + middle] <= u) low = middle;
    else high = middle;
  }
  const mass = SAMPLE_CDFS[first + low + 1] - SAMPLE_CDFS[first + low];
  return {
    wavelength: SPECTRUM_WAVELENGTH_MIN + SAMPLE_BIN_WIDTH * (low + (u - SAMPLE_CDFS[first + low]) / mass),
    pdf: mass / SAMPLE_BIN_WIDTH
  };
}

// Cauchy IOR grows quickly at short wavelengths and strong dispersion scales turn
// violet light into total internal reflection. Below 500 nm the refracting
// wavelength eases toward 475 nm, while color still follows the sampled wavelength.
const IOR_KNEE = 500;
const IOR_KNEE_WIDTH = 25;

export function spectrumIorWavelength(wavelength: number) {
  if (wavelength >= IOR_KNEE) return wavelength;
  return IOR_KNEE - IOR_KNEE_WIDTH * (1 - Math.exp((wavelength - IOR_KNEE) / IOR_KNEE_WIDTH));
}

const CDF_LITERALS = SAMPLE_CDFS.map((value) => value.toFixed(7)).join(',');
const lobeSum = (lobes: number[][]) =>
  lobes.map((lobe) => `${lobe[0]}f*spectrumLobe(wavelength,${lobe[1]}f,${lobe[2]}f,${lobe[3]}f)`).join('+');

export const spectrumWgsl = /* wgsl */ `
fn spectrumLobe(wavelength:f32,mean:f32,below:f32,above:f32)->f32 {
  let t=(wavelength-mean)/select(above,below,wavelength<mean);
  return exp(-0.5*t*t);
}
fn spectrumRgb(wavelength:f32)->vec3f {
  let xyz=vec3f(${XYZ_LOBES.map(lobeSum).join(',')});
  let rgb=mat3x3f(${[0, 1, 2].map((c) => XYZ_TO_RGB.map((row) => `${row[c]}f`).join(',')).join(',')})*xyz;
  return max(rgb,vec3f(0.0))*vec3f(${SCALE.map((s) => `${s}f`).join(',')});
}
fn spectrumIorWavelength(wavelength:f32)->f32 {
  if(wavelength>=${IOR_KNEE}.0) { return wavelength; }
  return ${IOR_KNEE}.0-${IOR_KNEE_WIDTH}.0*(1.0-exp((wavelength-${IOR_KNEE}.0)/${IOR_KNEE_WIDTH}.0));
}
const SPECTRUM_CDF=array<f32,${(SAMPLE_BINS + 1) * 4}>(${CDF_LITERALS});
fn spectrumSample(distribution:u32,u:f32,pdf:ptr<function,f32>)->f32 {
  let first=distribution*${SAMPLE_BINS + 1}u;
  var low=0u;
  var high=${SAMPLE_BINS}u;
  while(high-low>1u) {
    let middle=(low+high)/2u;
    if(SPECTRUM_CDF[first+middle]<=u) { low=middle; } else { high=middle; }
  }
  let mass=SPECTRUM_CDF[first+low+1u]-SPECTRUM_CDF[first+low];
  *pdf=mass/${SAMPLE_BIN_WIDTH}.0;
  return ${SPECTRUM_WAVELENGTH_MIN}.0+${SAMPLE_BIN_WIDTH}.0*(f32(low)+(u-SPECTRUM_CDF[first+low])/mass);
}
// Refracting wavelength of a camera path that carries one RGB channel.
fn spectrumCameraWavelength(channel:u32,u:f32)->f32 {
  var pdf=0.0;
  return spectrumIorWavelength(spectrumSample(channel,u,&pdf));
}
`;

export const spectrumGlsl = /* glsl */ `
const float SPECTRUM_CDF[${(SAMPLE_BINS + 1) * 4}]=float[${(SAMPLE_BINS + 1) * 4}](${CDF_LITERALS});
// Refracting wavelength of a camera path that carries one RGB channel.
float spectrumCameraWavelength(int channel,float u) {
  int first=channel*${SAMPLE_BINS + 1};
  int low=0;
  int high=${SAMPLE_BINS};
  while(high-low>1) {
    int middle=(low+high)/2;
    if(SPECTRUM_CDF[first+middle]<=u) { low=middle; } else { high=middle; }
  }
  float start=SPECTRUM_CDF[first+low];
  float wavelength=${SPECTRUM_WAVELENGTH_MIN}.0+${SAMPLE_BIN_WIDTH}.0*(float(low)+(u-start)/(SPECTRUM_CDF[first+low+1]-start));
  if(wavelength>=${IOR_KNEE}.0) { return wavelength; }
  return ${IOR_KNEE}.0-${IOR_KNEE_WIDTH}.0*(1.0-exp((wavelength-${IOR_KNEE}.0)/${IOR_KNEE_WIDTH}.0));
}
`;
