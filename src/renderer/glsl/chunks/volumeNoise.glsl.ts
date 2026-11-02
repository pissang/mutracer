import {VOLUME_WARP_OCTAVES} from '../../volumeNoise.js';
// PCG3D uses the LCG and integer mixing operations of our rand.glsl chunk.
// Keep the gradient/interpolation contract aligned with volumeNoise.wgsl.ts.
export const volumeNoiseGlsl = /* glsl */ `
uint volumeHash(ivec3 cell) {
  uvec3 v = uvec3(cell) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x;
}
float volumeGradient(ivec3 cell, vec3 p) {
  uint h = volumeHash(cell) & 15u;
  float a = h < 8u ? p.x : p.y;
  float b = p.z;
  if (h < 4u) b = p.y;
  else if (h == 12u || h == 14u) b = p.x;
  return ((h & 1u) == 0u ? a : -a) + ((h & 2u) == 0u ? b : -b);
}
float volumeGradientNoise(vec3 p) {
  ivec3 cell = ivec3(floor(p)); vec3 f = fract(p);
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float value = 0.0;
  for (int z = 0; z < 2; z++) {
    for (int y = 0; y < 2; y++) {
      for (int x = 0; x < 2; x++) {
        ivec3 corner = ivec3(x, y, z);
        vec3 weight = mix(vec3(1.0) - w, w, equal(corner, ivec3(1)));
        value += weight.x * weight.y * weight.z * volumeGradient(cell + corner, f - vec3(corner));
      }
    }
  }
  return value;
}
float volumeFbm(vec3 position, int octaves) {
  vec3 p = position; float amplitude = 1.0, sum = 0.0, weight = 0.0;
  for (int octave = 0; octave < 6; octave++) {
    if (octave >= octaves) break;
    sum += amplitude * volumeGradientNoise(p); weight += amplitude;
    p *= 2.0; amplitude *= 0.5;
  }
  return clamp(0.5 + 0.5 * sum / weight, 0.0, 1.0);
}
vec3 volumeWarpPosition(vec3 q, float warp) {
  vec3 w = 2.0 * vec3(
    volumeFbm(q + vec3(17.25, 3.5, 29.75), ${VOLUME_WARP_OCTAVES}),
    volumeFbm(q + vec3(41.5, 59.25, 7.125), ${VOLUME_WARP_OCTAVES}),
    volumeFbm(q + vec3(73.75, 11.125, 97.5), ${VOLUME_WARP_OCTAVES})) - vec3(1.0);
  return q + warp * w;
}
float volumeNoiseThreshold(float f, float coverage, float softness) {
  float center = 1.0 - coverage;
  float low = center - softness * 0.5;
  float high = center + softness * 0.5;
  // Small widths can round both bounds to the same float32 value.
  if (low >= high) return f >= center ? 1.0 : 0.0;
  return smoothstep(low, high, f);
}
float volumeNoiseMask(vec3 p, vec4 sizeOctaves, vec4 offsetCoverage, float softness, float warp) {
  if (warp > 0.0) {
    vec3 q = volumeWarpPosition((p + offsetCoverage.xyz) / sizeOctaves.xyz, warp);
    return volumeNoiseThreshold(volumeFbm(q, int(sizeOctaves.w)), offsetCoverage.w, softness);
  }
  float f = volumeFbm((p + offsetCoverage.xyz) / sizeOctaves.xyz, int(sizeOctaves.w));
  return volumeNoiseThreshold(f, offsetCoverage.w, softness);
}
`;
