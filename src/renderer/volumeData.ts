import {create, invert} from '../math/mat4.js';
import {MAX_VOLUMES, type SceneVolume} from '../scene/SceneVolume.js';

export const VOLUME_FLOATS = 36;
export interface PackedVolumes {count: number; hasNoise: boolean; data: Float32Array;}

/** Resolve and validate once, before committing any external scene edits. */
export function packVolumes(volumes: readonly SceneVolume[] = []): PackedVolumes {
  if (!Array.isArray(volumes) || volumes.length > MAX_VOLUMES) throw new RangeError('Scene.volumes supports at most 8 volumes.');
  const data = new Float32Array(MAX_VOLUMES * VOLUME_FLOATS);
  const finite = (x: number) => typeof x === 'number' && Number.isFinite(x);
  for (let i = 0; i < volumes.length; i++) {
    const f: SceneVolume = volumes[i];
    if (!f || !finite(f.density) || f.density < 0) throw new RangeError('Volume density must be finite and nonnegative.');
    const min = f.bounds?.min, max = f.bounds?.max;
    if (!min || !max || min.length !== 3 || max.length !== 3 ||
        !Array.from(min).every((x, j) => finite(x) && finite(max[j]) && x < max[j])) throw new RangeError('Volume bounds require finite min < max on each axis.');
    if (f.shape !== undefined && f.shape !== 'box' && f.shape !== 'ellipsoid') throw new RangeError('Invalid volumes shape.');
    const color = f.color === undefined ? [1, 1, 1] : f.color, g = f.anisotropy === undefined ? 0 : f.anisotropy, k = f.heightFalloff === undefined ? 0 : f.heightFalloff;
    if (!color || color.length !== 3 || !Array.from(color).every(x => finite(x) && x >= 0 && x <= 1) ||
        !finite(g) || Math.abs(g) > .999 || !finite(k) || k < 0 ||
        f.baseHeight !== undefined && !finite(f.baseHeight)) throw new RangeError('Invalid volumes color, anisotropy or height parameters.');
    const noise = f.noise;
    const edgeFade = f.edgeFade === undefined ? 0 : f.edgeFade;
    const unit = (x: number) => finite(x) && x >= 0 && x <= 1;
    if (!unit(edgeFade)) throw new RangeError('Volume edgeFade must be in [0, 1].');
    if (noise !== undefined) {
      if (!noise || !noise.size || noise.size.length !== 3 ||
          !Array.from(noise.size).every(x => finite(x) && Math.fround(x) > 0) ||
          !Number.isInteger(noise.octaves === undefined ? 4 : noise.octaves) || (noise.octaves === undefined ? 4 : noise.octaves) < 1 || (noise.octaves === undefined ? 4 : noise.octaves) > 6 ||
          !unit(noise.coverage === undefined ? .5 : noise.coverage) ||
          !unit(noise.softness === undefined ? .3 : noise.softness) ||
          (noise.warp !== undefined && (!finite(noise.warp) || noise.warp < 0)) ||
          (noise.offset !== undefined && (!noise.offset || noise.offset.length !== 3 || !Array.from(noise.offset).every(finite)))) {
        throw new RangeError('Invalid volume noise size, octaves, coverage, softness, warp or offset.');
      }
    }
    const m = f.transform === undefined ? create() : f.transform;
    if (!m || m.length !== 16 || !Array.from(m).every(finite) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) throw new RangeError('Volume transform must be finite and affine.');
    // Normalize the local shape to [-1,1]^3 / unit sphere. Do not normalize
    // transformed ray directions: the intersection parameter stays in world units.
    const normalized = Array.from(m), center = [0, 0, 0], radius = [0, 0, 0];
    for (let j = 0; j < 3; j++) {center[j] = (min[j] + max[j]) / 2; radius[j] = (max[j] - min[j]) / 2;}
    for (let row = 0; row < 3; row++) {
      normalized[12 + row] = m[12 + row] + m[row] * center[0] + m[4 + row] * center[1] + m[8 + row] * center[2];
      for (let col = 0; col < 3; col++) normalized[col * 4 + row] *= radius[col];
    }
    const inverse = new Array<number>(16).fill(0);
    if (!invert(inverse, normalized)) throw new RangeError('Volume transform must be invertible.');
    const axesY = [normalized[1], normalized[5], normalized[9]];
    const extentY = f.shape === 'ellipsoid' ? Math.hypot(...axesY) : axesY.reduce((sum, x) => sum + Math.abs(x), 0);
    const offset = i * VOLUME_FLOATS;
    data.set(inverse, offset); data.set([...color, g], offset + 16);
    data.set([f.density, k, f.baseHeight ?? normalized[13] - extentY, +(f.shape === 'ellipsoid')], offset + 20);
    data.set([...(noise?.size ?? [1, 1, 1]), noise?.octaves ?? 4], offset + 24);
    data.set([...(noise?.offset ?? [0, 0, 0]), noise?.coverage ?? .5], offset + 28);
    data.set([noise?.softness ?? .3, edgeFade, +(noise !== undefined), noise?.warp ?? 0], offset + 32);
    if (!Array.from(data.subarray(offset, offset + VOLUME_FLOATS)).every(Number.isFinite)) throw new RangeError('Volume values exceed GPU float32 range.');
  }
  return {count: volumes.length, hasNoise: volumes.some(v => v.noise !== undefined || (v.edgeFade ?? 0) > 0), data};
}
