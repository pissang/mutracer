import {expect, test} from 'vitest';
import {hasEmissionStep} from '../../src/temporal/emission.js';
import type {ColorRGB} from '../../src/types.js';

test('offline lighting recognizes emission cuts while keeping small changes in the same window', () => {
  const before = new Map<number, ColorRGB>([[1, [.5, 2, .8]], [2, [60, 46, 25]]]);
  const gradual = new Map<number, ColorRGB>([[1, [.4, 1.9, .7]], [2, [55, 43, 22]]]);
  const slide = new Map<number, ColorRGB>([[1, [2, 1.2, .3]], [2, [60, 46, 25]]]);
  const off = new Map<number, ColorRGB>([[2, [60, 46, 25]]]);
  expect(hasEmissionStep(before, gradual)).toBe(false);
  expect(hasEmissionStep(before, slide)).toBe(true);
  expect(hasEmissionStep(before, off)).toBe(true);
  expect(hasEmissionStep(off, before)).toBe(true);
  expect(hasEmissionStep(new Map(), new Map([[1, [.001, 0, 0]]]))).toBe(false);
});
