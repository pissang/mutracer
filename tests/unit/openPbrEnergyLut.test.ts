import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  getOpenPbrEnergyLutData,
  OPENPBR_ENERGY_LUT_AVERAGE_ROW,
  OPENPBR_ENERGY_LUT_HEIGHT,
  OPENPBR_ENERGY_LUT_WIDTH,
  OPENPBR_METAL_ENERGY_LUT_ROW,
  OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW,
  OPENPBR_DIELECTRIC_ENERGY_LUT_ROW,
  OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW,
  OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW
} from '../../src/renderer/openPbrEnergyLut';

describe('OpenPBR opaque dielectric energy LUT', () => {
  it('preserves directional decoding with interpolation-normalized metal averages', () => {
    const compact = getOpenPbrEnergyLutData();
    const data = new Float32Array(1120 * 32);
    data.set(compact.subarray(0, OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW * 32));
    for (let r = 0; r < 32; r++) {
      data.fill(compact[OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW * 32 + r]!,
        (1088 + r) * 32, (1089 + r) * 32);
    }
    const bytes = new Uint8Array(data.length * 4);
    const view = new DataView(bytes.buffer);
    data.forEach((value, index) => view.setFloat32(index * 4, value, true));
    // Pre-delta reference in little-endian Float32, covering every sample and
    // the joins between dielectric, metal and average-energy rows.
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '2030bf2adefb6fa94edcaf4ecdbd7d3b3b3f1b2d5b7babe450c57b9c05f43ebe'
    );
  });

  it('reuses the decoded table on subsequent calls', () => {
    expect(getOpenPbrEnergyLutData()).toBe(getOpenPbrEnergyLutData());
  });

  it('decodes the complete Adobe 32^3 and 32^2 tables', () => {
    const data = getOpenPbrEnergyLutData();
    expect(data).toHaveLength(
      OPENPBR_ENERGY_LUT_WIDTH * OPENPBR_ENERGY_LUT_HEIGHT
    );
    expect(OPENPBR_ENERGY_LUT_AVERAGE_ROW).toBe(32 * 32);
    expect(Math.min(...data)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...data)).toBeLessThanOrEqual(1);
  });

  it('stays within 0.002 of representative Uint16 UNORM source values', () => {
    const data = getOpenPbrEnergyLutData();
    const averageOffset = OPENPBR_ENERGY_LUT_AVERAGE_ROW
      * OPENPBR_ENERGY_LUT_WIDTH;
    expect(Math.abs(data[29]! - 50582 / 65535)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(data[32 * 32 * 32 - 1]! - 61816 / 65535)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(data[averageOffset]! - 8159 / 65535)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(data[OPENPBR_METAL_ENERGY_LUT_ROW * 32 - 1]! - 60821 / 65535)).toBeLessThanOrEqual(0.002);
  });
});

// Integrate the analytic unit-Fresnel GGX BRDF independently of table encoding.
// This checks the complement's semantics and axis order, not just source anchors.
function idealMetalEnergy(roughness: number, viewCosine: number): number {
  const alpha = roughness * roughness;
  const viewX = Math.sqrt(1 - viewCosine * viewCosine);
  const g1 = (mu: number) => 2 / (1 + Math.sqrt(1 + alpha * alpha * (1 - mu * mu) / (mu * mu)));
  const steps = 512;
  let integral = 0;
  for (let y = 0; y < steps; y++) {
    const mu = (y + .5) / steps;
    const radial = Math.sqrt(1 - mu * mu);
    const masking = g1(viewCosine) * g1(mu);
    for (let x = 0; x < steps; x++) {
      const phi = (x + .5) * 2 * Math.PI / steps;
      const dotVL = viewX * radial * Math.cos(phi) + viewCosine * mu;
      const halfZ = (viewCosine + mu) / Math.sqrt(2 + 2 * dotVL);
      const denom = 1 + halfZ * halfZ * (alpha * alpha - 1);
      const ndf = alpha * alpha / (Math.PI * denom * denom);
      integral += ndf * masking / (4 * viewCosine);
    }
  }
  return integral * 2 * Math.PI / (steps * steps);
}

function metalLoss(roughness: number, cosine: number): number {
  const data = getOpenPbrEnergyLutData();
  const r = roughness * 31, c = cosine * 31;
  const r0 = Math.floor(r), r1 = Math.min(31, r0 + 1);
  const c0 = Math.floor(c), c1 = Math.min(31, c0 + 1);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const row = (i: number) => mix(data[(OPENPBR_METAL_ENERGY_LUT_ROW + i) * 32 + c0]!, data[(OPENPBR_METAL_ENERGY_LUT_ROW + i) * 32 + c1]!, c - c0);
  return mix(row(r0), row(r1), r - r0);
}

describe('ideal-metal multiple-scattering table contract', () => {
  it.each([[.3, .9], [.6, .3], [.6, .9], [.9, .3]])('accounts for analytic GGX loss (roughness=%s, cosine=%s)', (roughness, cosine) => {
    expect(Math.abs(idealMetalEnergy(roughness!, cosine!) + metalLoss(roughness!, cosine!) - 1)).toBeLessThan(.0025);
  });

  it('normalizes the actual interpolated directional loss, including tiny grazing losses', () => {
    const data = getOpenPbrEnergyLutData();
    for (const alpha of [.01, .05, .1, .25, .5, 1]) {
      const roughness = Math.sqrt(alpha);
      let average = 0;
      const n = 65536;
      for (let i = 0; i < n; i++) {
        const cosine = (i + .5) / n;
        average += 2 * cosine * metalLoss(roughness, cosine) / n;
      }
      const index = roughness * 31, i0 = Math.floor(index), i1 = Math.min(31, i0 + 1);
      const a = data[OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW * 32 + i0]!;
      const b = data[OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW * 32 + i1]!;
      const stored = a + (b - a) * (index - i0);
      expect(stored).toBeGreaterThan(0);
      expect(Math.abs(average / stored - 1)).toBeLessThan(1e-6);
    }
  });
});

function idealDielectricLoss(eta: number, roughness: number, cosine: number): number {
  const index = Math.max(0, Math.min(31, eta < 1 ? 15 - (1 / eta - 1) * 10 : 16 + (eta - 1) * 10));
  const r = roughness * 31, c = cosine * 31;
  const data = getOpenPbrEnergyLutData();
  let value = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
    const row = OPENPBR_DIELECTRIC_ENERGY_LUT_ROW + Math.min(31, Math.floor(index) + i) * 32 + Math.min(31, Math.floor(r) + j);
    value += data[row * 32 + Math.min(31, Math.floor(c) + k)]!
      * (i ? index % 1 : 1 - index % 1) * (j ? r % 1 : 1 - r % 1) * (k ? c % 1 : 1 - c % 1);
  }
  return value;
}

// Integrate visible microfacet normals. Reflection/refraction weights include
// their Smith shadowing and Fresnel partition, without a radiance eta factor:
// this is the ideal-dielectric loss table's definition in Adobe's reference.
function idealDielectricSingleEnergy(eta: number, roughness: number, mu: number): number {
  const alpha = roughness * roughness, a2 = alpha * alpha;
  const vx = Math.sqrt(1 - mu * mu), n = 256;
  const g1 = (z: number) => 2 / (1 + Math.sqrt(1 + a2 * (1 - z * z) / (z * z)));
  let sum = 0;
  for (let j = 0; j < n; j++) {
    const hz = (j + .5) / n, radial = Math.sqrt(1 - hz * hz);
    const denom = 1 + hz * hz * (a2 - 1);
    const D = a2 / (Math.PI * denom * denom);
    for (let i = 0; i < n; i++) {
      const hx = radial * Math.cos((i + .5) * 2 * Math.PI / n);
      const vh = vx * hx + mu * hz;
      if (vh <= 0) continue;
      const k = 1 - (1 - vh * vh) / (eta * eta);
      let F = 1;
      if (k > 0) {
        const ct = Math.sqrt(k);
        F = .5 * (((vh - eta * ct) / (vh + eta * ct)) ** 2 + ((eta * vh - ct) / (eta * vh + ct)) ** 2);
      }
      const rz = 2 * vh * hz - mu;
      let weight = rz > 0 ? F * g1(rz) : 0;
      if (k > 0) {
        const tz = -mu / eta + (vh / eta - Math.sqrt(k)) * hz;
        if (tz < 0) weight += (1 - F) * g1(tz);
      }
      sum += D * g1(mu) * vh / mu * weight;
    }
  }
  return sum * 2 * Math.PI / (n * n);
}

describe('ideal-dielectric multiple-scattering table contract', () => {
  it.each([[1.5, .6, .3], [1.5, .6, .9], [2 / 3, .6, .3], [2 / 3, .6, .9]])('completes single GGX reflection and transmission (%s, %s, %s)', (eta, roughness, cosine) => {
    expect(Math.abs(idealDielectricSingleEnergy(eta!, roughness!, cosine!) + idealDielectricLoss(eta!, roughness!, cosine!) - 1)).toBeLessThan(.004);
  });

  it('preserves compact u16 averages and their cosine-weighted meaning', () => {
    const data = getOpenPbrEnergyLutData();
    for (const iorIndex of [0, 5, 10, 20, 25, 31]) for (const roughnessIndex of [10, 19, 31]) {
      const offset = (OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW + iorIndex) * 32 + roughnessIndex;
      const average = data[offset]!;
      expect(Math.abs(average * 65535 - Math.round(average * 65535))).toBeLessThan(.003);
      const eta = iorIndex < 16 ? 1 / (1 + (15 - iorIndex) / 10) : 1 + (iorIndex - 16) / 10;
      let integral = 0;
      for (let j = 0; j < 1024; j++) {
        const mu = (j + .5) / 1024;
        integral += 2 * mu * idealDielectricLoss(eta, roughnessIndex / 31, mu) / 1024;
      }
      expect(Math.abs(integral - average)).toBeLessThan(.0025);
    }
  });

  it('keeps the reference hemisphere ratio bounded, including eta=1 and reciprocal IOR endpoints', () => {
    const data = getOpenPbrEnergyLutData();
    expect(OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW + 32).toBe(OPENPBR_ENERGY_LUT_HEIGHT);
    const ratios = data.subarray(OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW * 32);
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ratios)).toBeLessThanOrEqual(1);
    // Upstream even retains a small tabulation residual at exactly eta=1.
    expect(ratios[16 * 32 + 31]).toBeCloseTo(142 / 65535, 7);
  });
});

describe('decoded average Float32 contract', () => {
  it.each([
    [OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW, 32, '1c8094d267ebba1d1cbb422825e944585538160ff805630d16889cae1416e6c7'],
    [OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW, 1024, '26bb5452686e4a99d5c15c0bcf622a85bc6691d33b160bd340d4bb1124951cf3']
  ] as const)('preserves the normalized metal and original dielectric averages (row=%s)', (row, length, hash) => {
    const values = getOpenPbrEnergyLutData().subarray(row * 32, row * 32 + length);
    const bytes = new Uint8Array(length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((v, i) => view.setFloat32(i * 4, v, true));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
  });
});
