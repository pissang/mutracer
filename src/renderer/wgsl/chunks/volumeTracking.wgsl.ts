import {MAX_VOLUME_TRACKING_STEPS} from '../../volumeTracking.js';
export const volumeTrackingWgsl = /* wgsl */ `
fn volumeModulated(volume: VolumeRecord) -> bool {
  return volume.noiseParams.z > 0.5 || volume.noiseParams.y > 0.0;
}
fn volumeDensityMask(p: vec3f, volume: VolumeRecord) -> f32 {
  var mask = 1.0;
  if (volume.noiseParams.z > 0.5) {
    mask = volumeNoiseMask(p, volume.noiseSizeOctaves, volume.noiseOffsetCoverage, volume.noiseParams.x, volume.noiseParams.w);
  }
  if (volume.noiseParams.y > 0.0) {
    let local = (volume.worldToLocal * vec4f(p, 1.0)).xyz;
    let edge = select(max(max(abs(local.x), abs(local.y)), abs(local.z)), length(local), volume.params.w > 0.5);
    mask *= smoothstep(0.0, volume.noiseParams.y, 1.0 - edge);
  }
  // This clamp is the majorant contract, independent of the noise's range.
  return clamp(mask, 0.0, 1.0);
}
fn volumeRandom(tag: u32) -> f32 {
  return clamp((hashedSample(tag) - EPS) / (1.0 - 2.0 * EPS), 0.0, 1.0 - 1.0 / 16777216.0);
}
fn volumeDeltaDistance(ray: Ray, volume: VolumeRecord, interval: vec2f, firstU: f32, tag: u32) -> f32 {
  var t = interval.x; var u = firstU;
  for (var step = 0; step < ${MAX_VOLUME_TRACKING_STEPS}; step++) {
    t = volumeDistance(ray, volume, vec2f(t, interval.y), -log(max(1.0 - u, 1e-7)));
    if (t >= interval.y) { return INF; }
    if (volumeRandom(tag + u32(step) * 2u) < volumeDensityMask(ray.o + t * ray.d, volume)) { return t; }
    u = volumeRandom(tag + u32(step) * 2u + 1u);
  }
  // The finite GPU bound has a measurable bias only when this limit is reached.
  return INF;
}
fn volumeRecordTransmittance(ray: Ray, volume: VolumeRecord, maximum: f32, tag: u32) -> f32 {
  let interval = volumeInterval(ray, volume, maximum);
  if (interval.y <= interval.x || volume.params.x <= 0.0) { return 1.0; }
  if (!volumeModulated(volume)) { return exp(-volumeOpticalDepth(ray, volume, interval)); }
  var t = interval.x; var tr = 1.0;
  for (var step = 0; step < ${MAX_VOLUME_TRACKING_STEPS}; step++) {
    let u = volumeRandom(tag + u32(step) * 2u);
    t = volumeDistance(ray, volume, vec2f(t, interval.y), -log(max(1.0 - u, 1e-7)));
    if (t >= interval.y) { return tr; }
    tr *= 1.0 - volumeDensityMask(ray.o + t * ray.d, volume);
    if (tr < 0.05) {
      let q = min(1.0, tr / 0.05);
      if (volumeRandom(tag + u32(step) * 2u + 1u) >= q) { return 0.0; }
      tr /= q;
    }
  }
  return tr;
}
fn volumeShadowTransmittance(ray: Ray, maximum: f32) -> f32 {
  var tr = 1.0;
  for (var i = 0; i < rtUniform.volumeCount; i++) {
    tr *= volumeRecordTransmittance(ray, rtUniform.volumeRecords[i], maximum, 0xa710u + u32(i) * 256u);
  }
  return tr;
}
fn volumeHasDensity(ray: Ray, maximum: f32) -> bool {
  for (var i = 0; i < rtUniform.volumeCount; i++) {
    let volume = rtUniform.volumeRecords[i];
    let interval = volumeInterval(ray, volume, maximum);
    if (volume.params.x > 0.0 && interval.y > interval.x) { return true; }
  }
  return false;
}
fn volumeNoiseGuides(ray: Ray, maximum: f32, outAux: ptr<function, RayTraceAuxiliary>) {
  var tr = 1.0; var weight = 0.0; var albedo = vec3f(0.0);
  for (var i = 0; i < rtUniform.volumeCount; i++) {
    let volume = rtUniform.volumeRecords[i];
    let ti = volumeRecordTransmittance(ray, volume, maximum, 0xb810u + u32(i) * 256u);
    let w = 1.0 - ti;
    tr *= ti; weight += w; albedo += w * volume.colorAnisotropy.rgb;
  }
  if (weight > 0.0) {
    (*outAux).albedo = tr * (*outAux).albedo + (1.0 - tr) * albedo / weight;
    (*outAux).normal *= tr;
  }
  // Geometric and deterministic, even when a stochastic estimate returns one.
  if (volumeHasDensity(ray, maximum)) { (*outAux).isBlank = false; }
}
`;
