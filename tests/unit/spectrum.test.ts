import {describe, expect, it} from 'vitest';
import {
  SPECTRUM_PHOTON_DISTRIBUTION,
  SPECTRUM_WAVELENGTH_MIN,
  SPECTRUM_WAVELENGTH_RANGE,
  spectrumIorWavelength,
  spectrumRgb,
  spectrumSample
} from '../../src/renderer/spectrum';

const WAVELENGTH_MAX = SPECTRUM_WAVELENGTH_MIN + SPECTRUM_WAVELENGTH_RANGE;

describe('spectrum', () => {
  it('keeps white light white under uniform wavelength sampling', () => {
    const steps = 4096;
    const mean = [0, 0, 0];
    for (let i = 0; i < steps; i++) {
      const rgb = spectrumRgb(SPECTRUM_WAVELENGTH_MIN + (SPECTRUM_WAVELENGTH_RANGE * (i + 0.5)) / steps);
      rgb.forEach((value, c) => {
        expect(value).toBeGreaterThanOrEqual(0);
        mean[c] += value / steps;
      });
    }
    for (const value of mean) expect(value).toBeCloseTo(1, 3);
  });

  it('photon sampling keeps white light white with bounded flux', () => {
    const steps = 64 * 256;
    const mean = [0, 0, 0];
    let peak = 0;
    for (let i = 0; i < steps; i++) {
      const {wavelength, pdf} = spectrumSample(SPECTRUM_PHOTON_DISTRIBUTION, (i + 0.5) / steps);
      expect(wavelength).toBeGreaterThanOrEqual(SPECTRUM_WAVELENGTH_MIN);
      expect(wavelength).toBeLessThanOrEqual(WAVELENGTH_MAX);
      spectrumRgb(wavelength).forEach((value, c) => {
        const weight = value / (pdf * SPECTRUM_WAVELENGTH_RANGE);
        mean[c] += weight / steps;
        peak = Math.max(peak, weight);
      });
    }
    for (const value of mean) expect(value).toBeCloseTo(1, 2);
    expect(peak).toBeLessThan(4);
  });

  it('camera channels sample their own spectral response', () => {
    const steps = 4096;
    for (let channel = 0; channel < 3; channel++) {
      const weights = [0, 0, 0];
      for (let i = 0; i < steps; i++) {
        const {wavelength} = spectrumSample(channel, (i + 0.5) / steps);
        expect(wavelength).toBeGreaterThanOrEqual(SPECTRUM_WAVELENGTH_MIN);
        expect(wavelength).toBeLessThanOrEqual(WAVELENGTH_MAX);
        spectrumRgb(wavelength).forEach((value, c) => (weights[c] += value / steps));
      }
      expect(weights.indexOf(Math.max(...weights))).toBe(channel);
    }
  });

  it('limits refraction at short wavelengths without reordering the spectrum', () => {
    expect(spectrumIorWavelength(650)).toBe(650);
    expect(spectrumIorWavelength(500)).toBe(500);
    let previous = spectrumIorWavelength(400);
    expect(previous).toBeGreaterThan(475);
    for (let wavelength = 401; wavelength <= 520; wavelength++) {
      const next = spectrumIorWavelength(wavelength);
      expect(next).toBeGreaterThan(previous);
      expect(next - previous).toBeLessThan(1.01);
      previous = next;
    }
  });

  it('varies continuously from blue through green to red', () => {
    const dominant = (wavelength: number) => {
      const rgb = spectrumRgb(wavelength);
      return rgb.indexOf(Math.max(...rgb));
    };
    expect([450, 540, 620].map(dominant)).toEqual([2, 1, 0]);
    for (let wavelength = 400; wavelength < 700; wavelength++) {
      const a = spectrumRgb(wavelength);
      const b = spectrumRgb(wavelength + 1);
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c])).toBeLessThan(0.25);
    }
  });
});
