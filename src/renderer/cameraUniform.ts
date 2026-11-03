/** Packs the shared WGSL camera block. Matrices are column-major. */
export function packCameraUniform(
  viewProjectionInverse: Float32Array, cameraWorld: Float32Array,
  apertureRadius: number, focusDistance: number, projectionInverse?: Float32Array
): Float32Array {
  const values = new Float32Array(projectionInverse ? 52 : 36);
  for (let i = 0; i < 16; i++) {
    values[i] = viewProjectionInverse[i];
    values[16 + i] = cameraWorld[i];
  }
  values[32] = apertureRadius;
  values[33] = focusDistance;
  // The browser appends a view-space inverse projection. Keep the legacy
  // 36-float block intact for native until its independent port is reviewed.
  if (projectionInverse) values.set(projectionInverse, 36);
  return values;
}
