import type {ColorRGB} from '../types.js';

const dark: ColorRGB = [0, 0, 0];

function changed(before: ColorRGB, after: ColorRGB): boolean {
  const scale = Math.max(.01, ...before, ...after);
  return Math.max(Math.abs(before[0] - after[0]), Math.abs(before[1] - after[1]),
    Math.abs(before[2] - after[2])) >= scale / 3;
}

// Keep this in sync with the native offline emission comparison.
export function hasEmissionStep(previous: ReadonlyMap<number, ColorRGB>, current: ReadonlyMap<number, ColorRGB>): boolean {
  for (const [id, color] of current) if (changed(previous.get(id) ?? dark, color)) return true;
  for (const [id, color] of previous) if (!current.has(id) && changed(color, dark)) return true;
  return false;
}
