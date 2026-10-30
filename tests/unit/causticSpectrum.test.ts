import {describe, expect, it} from 'vitest';
import {CAUSTIC_WAVELENGTH_MIN, CAUSTIC_WAVELENGTH_RANGE, causticSpectrumIorWavelength, causticSpectrumRgb, causticSpectrumSample} from '../../src/renderer/causticSpectrum';

describe('caustic spectrum weights', () => {
  it('keeps white light white under uniform wavelength sampling', () => {
    const steps = 4096;
    const mean = [0, 0, 0];
    for (let i = 0; i < steps; i++) {
      const rgb = causticSpectrumRgb(CAUSTIC_WAVELENGTH_MIN + (CAUSTIC_WAVELENGTH_RANGE * (i + 0.5)) / steps);
      rgb.forEach((value, c) => {
        expect(value).toBeGreaterThanOrEqual(0);
        mean[c] += value / steps;
      });
    }
    for (const value of mean) expect(value).toBeCloseTo(1, 3);
  });

  it('importance sampling keeps white light white with bounded flux', () => {
    const steps = 64 * 256;
    const mean = [0, 0, 0];
    let peak = 0;
    for (let i = 0; i < steps; i++) {
      const {wavelength, pdf} = causticSpectrumSample((i + 0.5) / steps);
      expect(wavelength).toBeGreaterThanOrEqual(CAUSTIC_WAVELENGTH_MIN);
      expect(wavelength).toBeLessThanOrEqual(CAUSTIC_WAVELENGTH_MIN + CAUSTIC_WAVELENGTH_RANGE);
      causticSpectrumRgb(wavelength).forEach((value, c) => {
        const weight = value / (pdf * CAUSTIC_WAVELENGTH_RANGE);
        mean[c] += weight / steps;
        peak = Math.max(peak, weight);
      });
    }
    for (const value of mean) expect(value).toBeCloseTo(1, 2);
    expect(peak).toBeLessThan(4);
  });

  it('limits refraction at short wavelengths without reordering the spectrum', () => {
    expect(causticSpectrumIorWavelength(650)).toBe(650);
    expect(causticSpectrumIorWavelength(500)).toBe(500);
    let previous = causticSpectrumIorWavelength(400);
    expect(previous).toBeGreaterThan(475);
    for (let wavelength = 401; wavelength <= 520; wavelength++) {
      const next = causticSpectrumIorWavelength(wavelength);
      expect(next).toBeGreaterThan(previous);
      expect(next - previous).toBeLessThan(1.01);
      previous = next;
    }
  });

  it('varies continuously from blue through green to red', () => {
    const dominant = (wavelength: number) => {
      const rgb = causticSpectrumRgb(wavelength);
      return rgb.indexOf(Math.max(...rgb));
    };
    expect([450, 540, 620].map(dominant)).toEqual([2, 1, 0]);
    for (let wavelength = 400; wavelength < 700; wavelength++) {
      const a = causticSpectrumRgb(wavelength);
      const b = causticSpectrumRgb(wavelength + 1);
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c])).toBeLessThan(0.25);
    }
  });
});
