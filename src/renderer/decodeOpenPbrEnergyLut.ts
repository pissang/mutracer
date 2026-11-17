/**
 * OpenPBR opaque-dielectric, ideal-metal and ideal-dielectric energy compensation tables.
 *
 * Copyright 2026 Adobe
 * Licensed under the Apache License, Version 2.0.
 * Derived from adobe/openpbr-bsdf commit
 * 9edf806740d2140846d9bef76e4342fc458e2ef5.
 * This repository re-quantized the Adobe data to 8-bit row-normalized values.
 * Directional rows store Uint16 min/max followed by 32 Uint8 samples.
 * Metal and ideal-dielectric averages store exact little-endian Uint16 values.
 * Dielectric averages decode directly to Float32. Metal averages are normalized
 * to the decoded piecewise-linear directional rows (see below).
 * Storage uses differences from the previous row: little-endian min/max
 * modulo 65536 and samples modulo 256. The first row is relative to zero;
 * differences continue across all concatenated energy tables.
 * Decoded UNORM value: (min + (max - min) * sample / 255) / 65535.
 * https://github.com/adobe/openpbr-bsdf
 */

export const OPENPBR_ENERGY_LUT_SIZE = 32;
export const OPENPBR_ENERGY_LUT_AVERAGE_ROW = 1024;
export const OPENPBR_ENERGY_LUT_WIDTH = OPENPBR_ENERGY_LUT_SIZE;
/** Ideal-metal complement: roughness rows, cosine columns. */
export const OPENPBR_METAL_ENERGY_LUT_ROW = 1056;
/** Ideal-metal cosine-weighted average: roughness columns, one row. */
export const OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW = 1088;
/** Ideal-dielectric loss: IOR-major, roughness rows, cosine columns. */
export const OPENPBR_DIELECTRIC_ENERGY_LUT_ROW = 1089;
/** Exact u16 averages: IOR rows, roughness columns. */
export const OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW = 2113;
/** Multiple-scattering reflection ratio: IOR rows, roughness columns. */
export const OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW = 2145;
export const OPENPBR_ENERGY_LUT_HEIGHT = 2177;

export function decodeOpenPbrEnergyLut(encoded: string, averages: string): Float32Array {
  const data = new Float32Array(
    OPENPBR_ENERGY_LUT_WIDTH * OPENPBR_ENERGY_LUT_HEIGHT
  );
  let min = 0, max = 0;
  const samples = new Uint8Array(OPENPBR_ENERGY_LUT_WIDTH);
  let encodedRow = 0;
  for (let row = 0; row < OPENPBR_ENERGY_LUT_HEIGHT; row++) {
    if (row === OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW
      || (row >= OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW
        && row < OPENPBR_DIELECTRIC_REFLECTION_RATIO_LUT_ROW)) continue;
    const byteOffset = encodedRow++ * (OPENPBR_ENERGY_LUT_WIDTH + 4);
    min = (min + (encoded.charCodeAt(byteOffset)
      | (encoded.charCodeAt(byteOffset + 1) << 8))) & 65535;
    max = (max + (encoded.charCodeAt(byteOffset + 2)
      | (encoded.charCodeAt(byteOffset + 3) << 8))) & 65535;
    for (let column = 0; column < OPENPBR_ENERGY_LUT_WIDTH; column++) {
      const sample = (samples[column]! + encoded.charCodeAt(byteOffset + 4 + column)) & 255;
      samples[column] = sample;
      data[row * OPENPBR_ENERGY_LUT_WIDTH + column] = (
        min + (max - min) * sample / 255
      ) / 65535;
    }
  }
  // Keep division in Number precision before the final Float32 assignment,
  // exactly as the previous min=max rows were decoded.
  for (let index = 0; index < 32 + 32 * 32; index++) {
    const value = (averages.charCodeAt(index * 2)
      | (averages.charCodeAt(index * 2 + 1) << 8)) / 65535;
    const offset = index < 32
      ? OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW * 32 + index
      : OPENPBR_DIELECTRIC_ENERGY_LUT_AVERAGE_ROW * 32 + index - 32;
    data[offset] = value;
  }
  // Integrating before interpolation in roughness commutes with that linear
  // interpolation. Use the exact integral of 2*mu times each linear segment,
  // rather than the separately tabulated u16 average: low-roughness rows have
  // narrow grazing features that the 32 cosine samples cannot resolve exactly.
  // This makes the compensation lobe integrate to its directional loss for any
  // roughness without changing the directional table or the Fresnel model.
  for (let row = 0; row < OPENPBR_ENERGY_LUT_SIZE; row++) {
    const offset = (OPENPBR_METAL_ENERGY_LUT_ROW + row) * OPENPBR_ENERGY_LUT_WIDTH;
    const h = 1 / (OPENPBR_ENERGY_LUT_SIZE - 1);
    let average = 0;
    for (let i = 0; i < OPENPBR_ENERGY_LUT_SIZE - 1; i++) {
      const a = data[offset + i]!, b = data[offset + i + 1]!;
      average += h * (i * h * (a + b) + h * (a + 2 * b) / 3);
    }
    data[OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW * OPENPBR_ENERGY_LUT_WIDTH + row] = average;
  }
  return data;
}
