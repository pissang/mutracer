// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import cameraRayGlsl from './chunks/cameraRay.glsl.js';
import common from './chunks/common.glsl.js';
import rayTraceCore from './chunks/rayTraceCore.glsl.js';
import textureLinear from './chunks/textureLinear.glsl.js';
import materialBufferGlsl from './chunks/materialBuffer.glsl.js';
import intersect from './chunks/intersect.glsl.js';
import randGlsl from './chunks/rand.glsl.js';
import random from './chunks/random.glsl.js';
import envMap from './chunks/envMap.glsl.js';
import sampleShadowCatcher from './chunks/sampleShadowCatcher.glsl.js';
import sampleLight from './chunks/sampleLight.glsl.js';
import { FragmentShader, glsl, Shader } from '../shader.js';
import samplingGlsl from './chunks/sampling.glsl.js';
import uvProjectionGlsl from './chunks/uvProjection.glsl.js';

export default new FragmentShader({
  name: 'shadowCatcher',
  outputs: ['shadowCatcher', 'catcherBackground', 'catcherMoments'],
  defines: {
    BOUNCES: 2
  },
  uniforms: {
    dispersionWavelengths: Shader.uniform('int', 3),
    spectralChannel: Shader.uniform('int', 0),
    viewportSize: Shader.uniform('vec2'),
    viewProjectionInv: Shader.uniform('mat4'),
    viewInv: Shader.uniform('mat4'),
    cameraApertureRadius: Shader.uniform('float', 0),
    cameraFocusDistance: Shader.uniform('float', 10)
  },
  includes: [rayTraceCore, materialBufferGlsl, intersect, random, envMap],
  main: glsl`
${common}
${randGlsl}
${random.main}

${textureLinear}

${rayTraceCore.main}
${uvProjectionGlsl}

${materialBufferGlsl.main}
${intersect.main}
${envMap.main}

${samplingGlsl}
${sampleLight}
${sampleShadowCatcher}
${cameraRayGlsl}

// Path tracing integrator as described in
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Path_Tracing.html#
vec4 integrator(inout Ray ray, out vec4 background, out vec2 shadowCounts) {
  background = vec4(0.0);
  shadowCounts = vec2(0.0);
  Path path;
  path.ray = ray;
  path.li = vec3(0);
  path.alpha = 1.0;
  path.beta = vec3(1.0);
  path.fromEye = true;
  path.scatteringPdf = 0.0;
  path.abort = false;

  SurfaceInteraction si;

  intersectScene(path.ray, si, false);
  if (!si.hit) {
    // Red stores catcher coverage. Keep it zero for pixels where the primary
    // ray did not hit the catcher so denoised shadows cannot bleed onto the
    // model silhouette during composition.
    return vec4(0.0, 0.0, 0.0, 1.0);
  }

  OpenPbrResolvedMaterial mat;
  getMaterial(mat, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
  if (mat.materialType != SHADOW_CATCHER) {
    // The main path tracer already renders regular geometry. Only evaluate
    // shadow opacity when the primary ray actually hits the catcher.
    return vec4(0.0, 0.0, 0.0, 1.0);
  }

  vec4 bg = sampleBackgroundFromRay(ray.o, ray.d);
  background = vec4(bg.rgb * bg.a, bg.a);
  if (!path.abort) {
    shadowCounts = sampleShadowCatcher(si, 0, path);
  }
  return vec4(1.0, bg.a, bg.a >= 0.01 ? 1.0 : 0.0, 0.0);
}

void main() {
  initRandom();
  rng_initialize(v_Texcoord * viewportSize, int(uint(sampleCount) ^ sampleHash(uint(sequenceSeed))));
  // Match the beauty pass's random stream in spectral renders.
  if (spectralChannel > 0) { sample1D(CAMERA_WAVELENGTH); }
  Ray cam = primaryCameraRay();
  vec4 background;
  vec2 shadowCounts;
  vec4 liAndAlpha = integrator(cam, background, shadowCounts);

  if (!(liAndAlpha.x < INF && liAndAlpha.x > -EPS)) {
    liAndAlpha = vec4(0.0);
    shadowCounts = vec2(0.0);
  }

  // Alpha and the moments' w sum the occluded and total light sample counts;
  // the output pass resolves their ratio into shadow visibility.
  out_shadowCatcher = vec4(liAndAlpha.rgb, shadowCounts.x);
  out_catcherBackground = background;
  // The composed catcher is the background darkened by the shadow. Over a
  // transparent background the shadow is only its opacity.
  float visibility = 1.0 - (shadowCounts.y > 0.0 ? shadowCounts.x / shadowCounts.y : 0.0);
  float guideValue = visibility * (background.a >= 0.01
    ? dot(background.rgb / background.a, vec3(0.2126, 0.7152, 0.0722))
    : 1.0);
  out_catcherMoments = liAndAlpha.r > 0.0
    ? vec4(guideValue, guideValue * guideValue, 1.0, shadowCounts.y)
    : vec4(0.0);

}`
});
