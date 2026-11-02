import {create, invert} from '../math/mat4.js';
import {MAX_FOG_VOLUMES, type SceneFog} from '../scene/SceneFog.js';

export const FOG_VOLUME_FLOATS = 24;
export interface PackedFog {count: number; data: Float32Array;}

/** Resolve and validate once, before committing any external scene edits. */
export function packFog(fog: readonly SceneFog[] = []): PackedFog {
  if (!Array.isArray(fog) || fog.length > MAX_FOG_VOLUMES) throw new RangeError('Scene.fog supports at most 8 volumes.');
  const data = new Float32Array(MAX_FOG_VOLUMES * FOG_VOLUME_FLOATS);
  const finite = (x: number) => typeof x === 'number' && Number.isFinite(x);
  for (let i = 0; i < fog.length; i++) {
    const f: SceneFog = fog[i];
    if (!f || !finite(f.density) || f.density < 0) throw new RangeError('Fog density must be finite and nonnegative.');
    const min = f.bounds?.min, max = f.bounds?.max;
    if (!min || !max || min.length !== 3 || max.length !== 3 ||
        !Array.from(min).every((x, j) => finite(x) && finite(max[j]) && x < max[j])) throw new RangeError('Fog bounds require finite min < max on each axis.');
    if (f.shape !== undefined && f.shape !== 'box' && f.shape !== 'ellipsoid') throw new RangeError('Invalid fog shape.');
    const color = f.color === undefined ? [1, 1, 1] : f.color, g = f.anisotropy === undefined ? 0 : f.anisotropy, k = f.heightFalloff === undefined ? 0 : f.heightFalloff;
    if (!color || color.length !== 3 || !Array.from(color).every(x => finite(x) && x >= 0 && x <= 1) ||
        !finite(g) || Math.abs(g) > .999 || !finite(k) || k < 0 ||
        f.baseHeight !== undefined && !finite(f.baseHeight)) throw new RangeError('Invalid fog color, anisotropy or height parameters.');
    const m = f.transform === undefined ? create() : f.transform;
    if (!m || m.length !== 16 || !Array.from(m).every(finite) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) throw new RangeError('Fog transform must be finite and affine.');
    // Normalize the local shape to [-1,1]^3 / unit sphere. Do not normalize
    // transformed ray directions: the intersection parameter stays in world units.
    const normalized = Array.from(m), center = [0, 0, 0], radius = [0, 0, 0];
    for (let j = 0; j < 3; j++) {center[j] = (min[j] + max[j]) / 2; radius[j] = (max[j] - min[j]) / 2;}
    for (let row = 0; row < 3; row++) {
      normalized[12 + row] = m[12 + row] + m[row] * center[0] + m[4 + row] * center[1] + m[8 + row] * center[2];
      for (let col = 0; col < 3; col++) normalized[col * 4 + row] *= radius[col];
    }
    const inverse = new Array<number>(16).fill(0);
    if (!invert(inverse, normalized)) throw new RangeError('Fog transform must be invertible.');
    const axesY = [normalized[1], normalized[5], normalized[9]];
    const extentY = f.shape === 'ellipsoid' ? Math.hypot(...axesY) : axesY.reduce((sum, x) => sum + Math.abs(x), 0);
    const offset = i * FOG_VOLUME_FLOATS;
    data.set(inverse, offset); data.set([...color, g], offset + 16);
    data.set([f.density, k, f.baseHeight ?? normalized[13] - extentY, +(f.shape === 'ellipsoid')], offset + 20);
    if (!Array.from(data.subarray(offset, offset + FOG_VOLUME_FLOATS)).every(Number.isFinite)) throw new RangeError('Fog values exceed GPU float32 range.');
  }
  return {count: fog.length, data};
}
