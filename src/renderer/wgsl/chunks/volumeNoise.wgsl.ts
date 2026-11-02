import {VOLUME_WARP_OCTAVES} from '../../volumeNoise.js';
// PCG3D uses the LCG and integer mixing operations of our rand.wgsl chunk.
// The gradient and interpolation below are local, texture-free definitions.
export const volumeNoiseWgsl = /* wgsl */ `
fn volumeHash(cell: vec3i) -> u32 {
  var v = bitcast<vec3u>(cell) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x;
}
fn volumeGradient(cell: vec3i, p: vec3f) -> f32 {
  let h = volumeHash(cell) & 15u;
  let a = select(p.y, p.x, h < 8u);
  var b = p.z;
  if (h < 4u) { b = p.y; }
  else if (h == 12u || h == 14u) { b = p.x; }
  return select(-a, a, (h & 1u) == 0u) + select(-b, b, (h & 2u) == 0u);
}
fn volumeGradientNoise(p: vec3f) -> f32 {
  let cell = vec3i(floor(p)); let f = fract(p);
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var value = 0.0;
  for (var z = 0; z < 2; z++) {
    for (var y = 0; y < 2; y++) {
      for (var x = 0; x < 2; x++) {
        let corner = vec3i(x, y, z);
        let weight = select(vec3f(1.0) - w, w, corner == vec3i(1));
        value += weight.x * weight.y * weight.z * volumeGradient(cell + corner, f - vec3f(corner));
      }
    }
  }
  return value;
}
fn volumeFbm(position: vec3f, octaves: i32) -> f32 {
  var p = position; var amplitude = 1.0; var sum = 0.0; var weight = 0.0;
  for (var octave = 0; octave < 6; octave++) {
    if (octave >= octaves) { break; }
    sum += amplitude * volumeGradientNoise(p); weight += amplitude;
    p *= 2.0; amplitude *= 0.5;
  }
  return clamp(0.5 + 0.5 * sum / weight, 0.0, 1.0);
}
fn volumeWarpPosition(q: vec3f, warp: f32) -> vec3f {
  let w = 2.0 * vec3f(
    volumeFbm(q + vec3f(17.25, 3.5, 29.75), ${VOLUME_WARP_OCTAVES}),
    volumeFbm(q + vec3f(41.5, 59.25, 7.125), ${VOLUME_WARP_OCTAVES}),
    volumeFbm(q + vec3f(73.75, 11.125, 97.5), ${VOLUME_WARP_OCTAVES})) - vec3f(1.0);
  return q + warp * w;
}
fn volumeNoiseThreshold(f: f32, coverage: f32, softness: f32) -> f32 {
  let center = 1.0 - coverage;
  let low = center - softness * 0.5;
  let high = center + softness * 0.5;
  // Small widths can round both bounds to the same float32 value.
  if (low >= high) { return select(0.0, 1.0, f >= center); }
  return smoothstep(low, high, f);
}
fn volumeNoiseMask(p: vec3f, sizeOctaves: vec4f, offsetCoverage: vec4f, softness: f32, warp: f32) -> f32 {
  if (warp > 0.0) {
    let q = volumeWarpPosition((p + offsetCoverage.xyz) / sizeOctaves.xyz, warp);
    return volumeNoiseThreshold(volumeFbm(q, i32(sizeOctaves.w)), offsetCoverage.w, softness);
  }
  let f = volumeFbm((p + offsetCoverage.xyz) / sizeOctaves.xyz, i32(sizeOctaves.w));
  return volumeNoiseThreshold(f, offsetCoverage.w, softness);
}
`;
