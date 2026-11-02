// Spectral tables: PBRT-v4@b0bdf461, src/pbrt/util/spectrum.cpp,
// Copyright (c) 1998-2020 Matt Pharr, Wenzel Jakob, Greg Humphreys.
// Apache-2.0; see LICENSES/pbrt-v4-Apache-2.0.txt.
import tables from './spectra-data.json';
const data = tables as Record<string, number[]>;
export const sample = (curve: number[], wavelength: number): number => {
  if (wavelength <= curve[0]) return curve[1];
  for (let i = 2; i < curve.length; i += 2) if (wavelength <= curve[i]) return curve[i - 1] + (curve[i + 1] - curve[i - 1]) * (wavelength - curve[i - 2]) / (curve[i] - curve[i - 2]);
  return curve[curve.length - 1];
};
export function spectralRGB(value: (wavelength: number) => number, reflectance = false): number[] {
  const xyz = [0, 0, 0]; let normalization = 0;
  for (let i = 0; i < data.CIE_lambda.length; i++) {
    const w = data.CIE_lambda[i], illuminant = reflectance ? sample(data.CIE_Illum_D6500, w) : 1;
    const v = value(w) * illuminant;
    xyz[0] += v * data.CIE_X[i]; xyz[1] += v * data.CIE_Y[i]; xyz[2] += v * data.CIE_Z[i];
    normalization += illuminant * data.CIE_Y[i];
  }
  const [x, y, z] = xyz.map(v => v / normalization);
  return [3.2404542 * x - 1.5371385 * y - .4985314 * z, -.969266 * x + 1.8760108 * y + .041556 * z, .0556434 * x - .2040259 * y + 1.0572252 * z].map(v => Math.max(0, v));
}
export function namedSpectrum(name: string): number[] | undefined { return data[name]; }
export function blackbody(temperature: number): number[] {
  const evaluate = (w: number) => 1 / (Math.pow(w * 1e-9, 5) * Math.expm1(.01438776877 / (w * 1e-9 * temperature)));
  const rgb = spectralRGB(evaluate); const max = Math.max(...rgb);
  return rgb.map(v => v / max);
}
export function glass(curve: number[]): { ior: number; abbe: number } {
  const ior = sample(curve, 587.56), dispersion = sample(curve, 486.13) - sample(curve, 656.27);
  return { ior, abbe: dispersion > 0 ? (ior - 1) / dispersion : Infinity };
}
export function conductorFresnel(e: number, extinction: number, cosine: number): number {
  const c2 = cosine * cosine, s2 = 1 - c2, t0 = e * e - extinction * extinction - s2;
  const a2b2 = Math.sqrt(t0 * t0 + 4 * e * e * extinction * extinction), a = Math.sqrt((a2b2 + t0) / 2), t1 = a2b2 + c2, t2 = 2 * cosine * a;
  const rs = (t1 - t2) / (t1 + t2), t3 = c2 * a2b2 + s2 * s2, t4 = t2 * s2;
  return .5 * rs * (1 + (t3 - t4) / (t3 + t4));
}
export function metalTint(base: number[], edge: number[]): number[] {
  const schlick = Math.pow(6 / 7, 5);
  return edge.map((v, i) => Math.max(0, Math.min(1, v / (base[i] + (1 - base[i]) * schlick))));
}
export function conductor(eta: number[], k: number[]): { base: number[]; edge: number[] } {
  return { base: spectralRGB(w => conductorFresnel(sample(eta, w), sample(k, w), 1), true), edge: spectralRGB(w => conductorFresnel(sample(eta, w), sample(k, w), 1 / 7), true) };
}
/** PBRT-v4 alpha=sqrt(r) when remapped; OpenPBR alpha=r². */
export function roughness(value: number, remap = true): number { return Math.pow(Math.max(0, value), remap ? .25 : .5); }
export function verticalFov(fov: number, aspect: number): number { return aspect >= 1 ? fov : 2 * Math.atan(Math.tan(fov * Math.PI / 360) / aspect) * 180 / Math.PI; }
