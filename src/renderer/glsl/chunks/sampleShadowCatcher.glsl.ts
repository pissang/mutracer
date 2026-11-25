// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Estimate the direct lighting integral using multiple importance sampling
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral

import { glsl } from '../../shader.js';

export default glsl`
// A one-sample binary shadow test leaves scattered fully dark pixels far
// from the occluder at low sample counts. Averaging a few light samples per
// primary hit costs only shadow rays and lets the mask settle much sooner.
// Candidate dimensions match WGSL lightDim(). sampleLight() draws only the
// environment and analytic lights, like WGSL's shadow-catcher table.
const uint SHADOW_CATCHER_LIGHT_SAMPLES = 4u;

uint shadowCatcherLightDim(uint candidate, uint slot) {
  return candidate == 0u ? bounceDim(slot) : bounceDim(9u + (candidate - 1u) * 3u + slot);
}

// Returns the occluded and the total count of light samples that reach the
// visible side of this hit; see the WGSL sampleShadowCatcher().
vec2 sampleShadowCatcher(SurfaceInteraction si, int bounce, inout Path path) {
  vec3 viewDir = -path.ray.d;
  vec2 counts = vec2(0.0);

#if defined(NUM_LIGHTS) || defined(USE_ENVMAP)
  for (uint candidate = 0u; candidate < SHADOW_CATCHER_LIGHT_SAMPLES; candidate++) {
    LightSampleRec lightSample;
    vec3 lightRnd = vec3(
      sample2D(shadowCatcherLightDim(candidate, LIGHT_POSITION)),
      sample1D(shadowCatcherLightDim(candidate, LIGHT_SELECT))
    );
    sampleLight(si.position, lightRnd, lightSample, false);

    vec3 lightDir = lightSample.direction;
    float cosThetaL = dot(si.normal, lightDir);
    float orientation = dot(si.normal, viewDir) * cosThetaL;
    if (lightSample.pdf > 0.0 && orientation >= 0.0) {
      if (dot(lightSample.emission, luminance) * abs(cosThetaL) > 0.0) {
        Ray ray;
        vec3 origin = offsetSurfaceRay(si.position, si.faceNormal, lightDir, path.ray.o);
        float distance = lightSample.dist - dot(origin - si.position, lightDir);
        initRay(ray, origin, lightDir);
        bool occluded = intersectSceneShadow(ray, distance, si.triangleIndex, si.instanceIndex);
        counts += vec2(occluded ? 1.0 : 0.0, 1.0);
      }
    }
  }
#endif
  path.fromEye = false;
  return counts;
}
`;
