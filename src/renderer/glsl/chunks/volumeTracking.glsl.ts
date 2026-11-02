import {MAX_VOLUME_TRACKING_STEPS} from '../../volumeTracking.js';
export const volumeTrackingGlsl = /* glsl */ `
bool volumeModulated(int index) {
  return volumeNoiseParams[index].z > 0.5 || volumeNoiseParams[index].y > 0.0;
}
float volumeDensityMask(vec3 p, int index) {
  float mask = 1.0;
  if (volumeNoiseParams[index].z > 0.5) {
    mask = volumeNoiseMask(p, volumeNoiseSizeOctaves[index], volumeNoiseOffsetCoverage[index], volumeNoiseParams[index].x, volumeNoiseParams[index].w);
  }
  if (volumeNoiseParams[index].y > 0.0) {
    vec3 local = (volumeWorldToLocal[index] * vec4(p, 1.0)).xyz;
    float edge = volumeParams[index].w > 0.5 ? length(local) : max(max(abs(local.x), abs(local.y)), abs(local.z));
    mask *= smoothstep(0.0, volumeNoiseParams[index].y, 1.0 - edge);
  }
  return clamp(mask, 0.0, 1.0);
}
float volumeRandom(uint tag) {
  return clamp((hashedSample(tag) - EPS) / (1.0 - 2.0 * EPS), 0.0, 1.0 - 1.0 / 16777216.0);
}
float volumeDeltaDistance(Ray ray, int index, vec2 interval, float firstU, uint tag) {
  float t = interval.x, u = firstU;
  for (int step = 0; step < ${MAX_VOLUME_TRACKING_STEPS}; step++) {
    t = volumeDistance(ray, index, vec2(t, interval.y), -log(max(1.0 - u, 1e-7)));
    if (t >= interval.y) return INF;
    if (volumeRandom(tag + uint(step) * 2u) < volumeDensityMask(ray.o + t * ray.d, index)) return t;
    u = volumeRandom(tag + uint(step) * 2u + 1u);
  }
  return INF;
}
float volumeRecordTransmittance(Ray ray, int index, float maximum, uint tag) {
  vec2 interval = volumeInterval(ray, index, maximum);
  if (interval.y <= interval.x || volumeParams[index].x <= 0.0) return 1.0;
  if (!volumeModulated(index)) return exp(-volumeOpticalDepth(ray, index, interval));
  float t = interval.x, tr = 1.0;
  for (int step = 0; step < ${MAX_VOLUME_TRACKING_STEPS}; step++) {
    float u = volumeRandom(tag + uint(step) * 2u);
    t = volumeDistance(ray, index, vec2(t, interval.y), -log(max(1.0 - u, 1e-7)));
    if (t >= interval.y) return tr;
    tr *= 1.0 - volumeDensityMask(ray.o + t * ray.d, index);
    if (tr < 0.05) {
      float q = min(1.0, tr / 0.05);
      if (volumeRandom(tag + uint(step) * 2u + 1u) >= q) return 0.0;
      tr /= q;
    }
  }
  return tr;
}
float volumeShadowTransmittance(Ray ray, float maximum) {
  float tr = 1.0;
  for (int i = 0; i < volumeCount; i++) tr *= volumeRecordTransmittance(ray, i, maximum, 0xa710u + uint(i) * 256u);
  return tr;
}
bool volumeHasDensity(Ray ray, float maximum) {
  for (int i = 0; i < volumeCount; i++) {
    vec2 interval = volumeInterval(ray, i, maximum);
    if (volumeParams[i].x > 0.0 && interval.y > interval.x) return true;
  }
  return false;
}
`;
export const volumeNoiseGuidesGlsl = /* glsl */ `
void volumeNoiseGuides(Ray ray, float maximum, inout RayTraceAuxiliary outAux) {
  float tr = 1.0, weight = 0.0; vec3 albedo = vec3(0.0);
  for (int i = 0; i < volumeCount; i++) {
    float ti = volumeRecordTransmittance(ray, i, maximum, 0xb810u + uint(i) * 256u);
    float w = 1.0 - ti;
    tr *= ti; weight += w; albedo += w * volumeColorAnisotropy[i].rgb;
  }
  if (weight > 0.0) {
    outAux.albedo = tr * outAux.albedo + (1.0 - tr) * albedo / weight;
    outAux.normal *= tr;
  }
  if (volumeHasDensity(ray, maximum)) outAux.isBlank = false;
}
`;
