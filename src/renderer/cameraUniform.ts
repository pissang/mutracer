/** Packs the shared WGSL camera block. Matrices are column-major. */
export function packCameraUniform(
  viewProjectionInverse: Float32Array, cameraWorld: Float32Array,
  apertureRadius: number, focusDistance: number
): Float32Array {
  const values = new Float32Array(36);
  for (let i = 0; i < 16; i++) {
    values[i] = viewProjectionInverse[i];
    values[16 + i] = cameraWorld[i];
  }
  values[32] = apertureRadius;
  values[33] = focusDistance;
  return values;
}
