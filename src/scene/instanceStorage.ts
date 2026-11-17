// Shared by InstancedMesh (browser API) and InstanceState (native updates). Both
// keep these fields as own properties because committed scene snapshots copy
// own keys, so they share helpers rather than a delegated state object.

/** Options for a batch sharing geometry and materials. */
export interface InstancedMeshOptions {
  /** Required active instance count; a nonnegative integer. */
  count: number;
  /** Column-major local matrices, at least 16 * count floats. Default: count identity matrices. The array is retained. */
  transforms?: Float32Array;
  /** Linear RGB multipliers, at least 3 * count floats. Default undefined (white). The array is retained. */
  colors?: Float32Array;
}

/** Writes identity matrices for the first `count` column-major transforms. */
export function fillIdentityTransforms(transforms: Float32Array, count: number) {
  for (let i = 0; i < count; i++) {
    const offset = i * 16;
    transforms[offset] = transforms[offset + 5] = transforms[offset + 10] = transforms[offset + 15] = 1;
  }
}

export function validateInstances(count: number, transforms: Float32Array, colors: Float32Array | undefined) {
  if (!Number.isInteger(count) || count < 0 || !(transforms instanceof Float32Array) || transforms.length < count * 16) {
    throw new RangeError('InstancedMesh requires a nonnegative count and at least 16 * count Float32 transforms.');
  }
  if (colors !== undefined && (!(colors instanceof Float32Array) || colors.length < count * 3)) {
    throw new RangeError('InstancedMesh colors must contain at least 3 * count Float32 values.');
  }
}

export function checkInstanceRange(start: number, count: number, active: number, property: 'transform' | 'color') {
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > active) {
    throw new RangeError(property === 'transform' ? 'Instance transform range must fit the active count.'
      : 'Instance color range must fit the active count.');
  }
}
