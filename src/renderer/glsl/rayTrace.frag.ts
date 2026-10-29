import { MAX_PATH_EVENTS } from '../pathLimits.js';
import cameraRayGlsl from './chunks/cameraRay.glsl.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import commonGlsl from './chunks/common.glsl.js';
import rayTraceCore from './chunks/rayTraceCore.glsl.js';
import textureLinear from './chunks/textureLinear.glsl.js';
import materialBufferGlsl from './chunks/materialBuffer.glsl.js';
import intersect from './chunks/intersect.glsl.js';
import randGlsl from './chunks/rand.glsl.js';
import random from './chunks/random.glsl.js';
import envMap from './chunks/envMap.glsl.js';
import sampleMaterialGlsl from './chunks/sampleMaterial.glsl.js';
import sampleLightGlsl from './chunks/sampleLight.glsl.js';
import { FragmentShader, glsl, Shader } from '../shader.js';
import openPbrBsdfGlsl from './chunks/openPbrBsdf.glsl.js';
import samplingGlsl from './chunks/sampling.glsl.js';
import { isIntelMac } from '../util.js';
import uvProjectionGlsl from './chunks/uvProjection.glsl.js';

const doubleTransmissionCheckCode = glsl`
#if defined(HAS_TRANSMISSION) || defined(HAS_ALPHA)
  if (!si.isTransparency && BOUNCES < 16 && depth * 2 > BOUNCES) {
    path.abort = true;
    return;
  }
#endif
`;

// bounce fix on intel mac
// The intel mac only have one bounce if the loop is not unrolled
// But windows will have extremely slow shader compilation if the loop is unrolled
// So here the code are injected separately.
const bounceCodeOnIntelMac = glsl`
// Mark loop can be unrolled
for(int _idx_ = 0; _idx_ < BOUNCES; _idx_++) {{
  if (path.abort) {
    return vec4(path.li, path.alpha);
  }
  bounce(path, depth, si, mat, outAux);
}}
`;
const bounceCodeOnOther = glsl`
bool isOpaque = !si.isTransparency;
int activeBounceLimit = min(BOUNCES, bounceLimit);
for(int idx = 0; idx < min(BOUNCES * 3, ${MAX_PATH_EVENTS}); idx++) {
  if (isOpaque && idx > activeBounceLimit) {
    path.abort = true;
  }
  if (path.abort) {
    return vec4(path.li, path.alpha);
  }
  bounce(path, depth, si, mat, outAux);
}
`;

export default function createRayTraceFragmentShader() {
  const intelMac = isIntelMac();
  return new FragmentShader({
  name: 'rayTraceFrag',
  outputs: ['color', 'albedo', 'normal', 'moments'],
  defines: {
    BOUNCES: 2
  },
  uniforms: {
    emissiveLightData: Shader.uniform('sampler2D'), emissiveLightColumns: Shader.uniform('int'),
    emissiveChoiceOffset: Shader.uniform('int'), emissiveChoiceCount: Shader.uniform('int'), emissivePmfOffset: Shader.uniform('int'),
    emissiveWeightTotal: Shader.uniform('float',0),
    cameraApertureRadius: Shader.uniform('float', 0),
    cameraFocusDistance: Shader.uniform('float', 10),

    viewProjectionInv: Shader.uniform('mat4'),
    viewInv: Shader.uniform('mat4'),
    transmissiveOutputAlphaMin: Shader.uniform('float'),
    openPbrEnergyLut: Shader.uniform('sampler2D'),

    viewportSize: Shader.uniform('vec2'),

    wavelength: Shader.uniform('float', 0),
    bevelEnabled: Shader.uniform('bool', true),
    dispersionWavelengths: Shader.uniform('int', 3),
    bounceLimit: Shader.uniform('int', 8)
  },
  includes: [rayTraceCore, materialBufferGlsl, intersect, random, envMap],
  main: glsl`
${commonGlsl}

${randGlsl}
${random.main}

${textureLinear}

${rayTraceCore.main}

${uvProjectionGlsl}

${materialBufferGlsl.main}
${intersect.main}
${envMap.main}

${samplingGlsl}
${openPbrBsdfGlsl}

float heroWavelength;
float pathWavelength;

${sampleLightGlsl}
${sampleMaterialGlsl}

${cameraRayGlsl}
struct RayTraceAuxiliary {
  // Denoising guides and auxiliary pixel classification.
  vec3 albedo;
  vec3 normal;
  bool isBlank;
  // The primary ray hit a shadow catcher, whose sample the catcher pass owns.
  bool isShadowCatcher;
};

void bounce(inout Path path, inout int depth, inout SurfaceInteraction si, inout OpenPbrResolvedMaterial mat, inout RayTraceAuxiliary outAux) {
  samplingBounce = uint(max(depth, 0));
  // The bounce will be doubled on the transmission material.
  // For other materials. We will quite early
  // TODO It is only used on Mac with AMD card. If I enabled it on windows.
  // It will cause shader compilation too slow.
${intelMac ? doubleTransmissionCheckCode : ''}

  bool isShadowCatcher = mat.materialType == SHADOW_CATCHER;
  if (isShadowCatcher) {
    if (path.fromEye) {
      // Match the composed shadow with neutral receiver guides, while keeping
      // background coverage and radiance independent of the invisible ground.
      outAux.albedo = vec3(1.0);
      outAux.normal = dot(si.normal, path.ray.d) > 0.0 ? -si.normal : si.normal;
      si.hit = false;
      outAux.isShadowCatcher = true;
    }
    else {
      // The catcher belongs only to the shadow-mask pass. Keep its default
      // white material out of glossy and transmission reflections.
#ifdef USE_ENVMAP
      if (path.isNextRefraction) {
        // The invisible catcher can sit between a transmitted camera ray and
        // the grounded skybox. Use the displayed background here instead of
        // terminating early with the raw lighting environment.
        vec4 bg = sampleBackgroundFromRay(path.ray.o, path.ray.d);
        bg.rgb = sampling_spectral_rgb_filter(bg.rgb, pathWavelength);
        float backgroundMisWeight = path.scatteringIsDelta ? 1.0
          : sampling_power_heuristic(path.scatteringPdf,
              envMapPdf(environmentUv(path.ray.d)) * envLightSelectionPmf);
        path.li += backgroundMisWeight * path.beta * bg.rgb * bg.a;
        path.alpha = max(path.alpha, bg.a);
      }
      else {
        vec2 envUv = environmentUv(path.ray.d);
        vec3 emission = textureLinear(envMap, envUv).rgb;
        emission = sampling_spectral_rgb_filter(emission, pathWavelength);
        path.li += path.beta * emission *
          sampling_power_heuristic(
            path.scatteringPdf,
            envMapPdf(envUv) * envLightSelectionPmf
          );
      }
#else
      vec4 bg = sampleBackgroundFromRay(path.ray.o, path.ray.d);
      bg.rgb = sampling_spectral_rgb_filter(bg.rgb, pathWavelength);
      path.li += path.beta * bg.rgb * bg.a;
#endif
      path.abort = true;
      return;
    }
  }

  if (!si.hit) {
    // Sample from background if first ray not hit anything.
    vec4 bg = sampleBackgroundFromRay(path.ray.o, path.ray.d);
    // Dispersion renders one additive pass per RGB wavelength. Background
    // radiance has to be split in the same way as lights and emissive
    // surfaces, otherwise the full skybox is accumulated three times.
    bg.rgb = sampling_spectral_rgb_filter(bg.rgb, pathWavelength);
    if (path.fromEye) {
      path.li = bg.rgb * bg.a;
      path.alpha = bg.a;
      // Only treat as blank pixels when the background is transparent
      outAux.isBlank = bg.a < 0.01;
    }
    else {
      Ray cam = initCameraRay(v_Texcoord + pixelJitter());
      bool towardsCam = dot(cam.d, path.ray.d) > 0.0;
      if (transmissiveOutputAlphaMin < 1.0) {
        if (towardsCam) {
          path.alpha = max(path.alpha, bg.a);
        } else {
          path.alpha = 1.0;
        }
      }
#if !defined(USE_ENVMAP)
      // TODO treat background as a light source
      if (towardsCam) {
        path.li += path.beta * sampling_power_heuristic(path.scatteringPdf, 1.0) * bg.rgb;
      }
#endif
    }
    path.abort = true;
    return;
  }

  bool sampleIgnored = false;
  if ((mat.materialType == STANDARD || mat.materialType == UNLIT)) {
    if (transmissiveOutputAlphaMin < 1.0) {
      // TODO increase the alpha when there are more bounces.
      float alpha = max(1.0 - mat.transmissionWeight, 1.0 - pow(1.0 - transmissiveOutputAlphaMin, float(depth)));
      path.alpha = max(alpha, path.alpha);
    }
    float alpha = mat.alpha;
    if (alpha < 1.0) {
      // Alpha is sampled as stochastic coverage. An accepted surface branch
      // must use full radiance weight; multiplying by alpha again is biased.
      path.alpha = max(path.alpha, alpha);
      if (hashedSample(3u) > alpha) {
        sampleIgnored = true;
      }
    }
    if (!sampleIgnored) {
      SampleMaterial(si, mat, path);
    }
    else {
      path.ray.o = si.position + path.ray.d * EPS;
    }
  }

  if (!si.albedoSampled && !sampleIgnored) {
    // Select denoising guides.
    if ((mat.materialType == STANDARD || mat.materialType == UNLIT) &&
      !(mat.transmissionWeight > 0.5 ||
        (mat.specularRoughness <= 0.02 && mat.baseMetalness > 0.98))) {
      // Alpha-blended decals can be skipped stochastically. In that case keep
      // looking for the first useful rough-surface guide behind the decal,
      // even though it is reached after depth zero.
      outAux.albedo = mat.baseColor;
      outAux.normal = dot(si.normal, si.position - vec3(viewInv[3])) > 0.0
        ? -si.normal
        : si.normal;
      si.albedoSampled = true;
    }
    if (depth > 4) {
      si.albedoSampled = true;
    }
  }


  // Russian Roulette sampling
#ifdef USE_RR
  if (depth >= RR_MAX && !sampleIgnored) {
    // Max-component survival (pbrt-v4) avoids over-amplifying saturated paths.
    float maxComponent = max(max(path.beta.x, path.beta.y), path.beta.z);
    float q = max(0.0, 1.0 - maxComponent);
    if (sample1D(bounceDim(RUSSIAN_ROULETTE)) < q) {
      // TODO we force use alpha 1.0 here.
      // To avoid the glass pixels is transparent even if it's on an opaque object.
      path.alpha = 1.0;
      path.abort = true;
    }
    else {
      path.beta /= 1.0 - q;
    }
  }
#endif

  if (path.abort) {
    return;
  }

  // Next ray hit
  intersectScene(path.ray, si, true);
  getMaterial(mat, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
  si.isTransparency = mat.transmissionWeight > 0.001 || mat.subsurfaceWeight > 0.001 || mat.alpha < 0.999;

  // Dynamic preview only becomes spectral when the primary visible surface
  // actually disperses transmitted light. Direct background and ordinary
  // opaque materials stay full RGB and therefore remain noise-free.
  if (dispersionWavelengths == 1 && si.hit && mat.transmissionWeight > 0.001 && mat.transmissionDispersionScale > 0.001) {
    pathWavelength = heroWavelength;
  }
  if (mat.transmissionWeight > 0.001 && pathWavelength > 0.0) {
    mat.specularIor = sampling_cauchy_ior(
      pathWavelength,
      mat.specularIor,
      mat.transmissionDispersionScale,
      mat.dispersionAbbeNumber
    );
  }

  if (sampleIgnored) {
    return;
  }

  bool isAlphaOccluded = hashedSample(3u) < mat.alpha;
#ifdef NUM_LIGHTS
  // Use light if hit the light
  LightSampleRec lightSample;
  for (int i = 0; i < NUM_LIGHTS; i++) {
    // Fetch light Data
    Light light = fetchLight(i);
    float d = intersectLight(path.ray, light, lightSample);
    bool occluded = si.hit && d > distance(si.position, path.ray.o);
    if (d != INF && !(occluded && isAlphaOccluded)) {
      lightSample.pdf *= light.selectionPmf;
      float misWeight = sampling_power_heuristic(path.scatteringPdf, lightSample.pdf);
      lightSample.emission = sampling_spectral_rgb_filter(lightSample.emission, pathWavelength);
      path.li += misWeight * path.beta * lightSample.emission;
      // TODO set alpha to 1.0 will cause some sharp edges
      path.alpha = 1.0;
      path.abort = true;
    }
  }
#endif

#ifdef USE_ENVMAP
  if (!(si.hit && isAlphaOccluded)) {
    if (path.isNextRefraction) {
      // Camera-visible transmission must use the displayed background. The
      // raw environment remains the lighting source for non-transmission rays.
      vec4 bg = sampleBackgroundFromRay(path.ray.o, path.ray.d);
      bg.rgb = sampling_spectral_rgb_filter(bg.rgb, pathWavelength);
      float backgroundMisWeight = path.scatteringIsDelta ? 1.0
          : sampling_power_heuristic(path.scatteringPdf,
              envMapPdf(environmentUv(path.ray.d)) * envLightSelectionPmf);
        path.li += backgroundMisWeight * path.beta * bg.rgb * bg.a;
      path.alpha = max(path.alpha, bg.a);
      path.abort = true;
      return;
    }
    vec2 uv = environmentUv(path.ray.d);
    vec3 emission = textureLinear(envMap, uv).rgb;
    float misWeight = sampling_power_heuristic(
      path.scatteringPdf,
      envMapPdf(uv) * envLightSelectionPmf
    );
    emission = sampling_spectral_rgb_filter(emission, pathWavelength);
    path.li += path.beta * emission * misWeight;

  // TODO force the min alpha to be 1 when showing envmap as background
  #if !defined(USE_BACKGROUND)
    path.alpha = 1.0;
  #endif
    path.abort = true;
    return;
  }
#endif

  depth++;
}


vec2 bevelCubicSample(float radius, float xi) {
  float x = 0.25;
  for (int iteration = 0; iteration < 10; iteration++) {
    float x2 = x * x;
    float x3 = x2 * x;
    float oneMinusX = 1.0 - x;
    float value = 10.0 * x2 - 20.0 * x3 + 15.0 * x2 * x2 -
      4.0 * x2 * x3 - xi;
    float derivative = 20.0 * x * oneMinusX * oneMinusX * oneMinusX;
    if (abs(value) < 1e-6 || derivative == 0.0) break;
    x = clamp(x - value / derivative, 0.0, 1.0);
  }
  float diskRadius = x * radius;
  return vec2(
    diskRadius,
    sqrt(max(radius * radius - diskRadius * diskRadius, 0.0))
  );
}

float bevelCubicPdf(float radius, float distanceToSource) {
  if (distanceToSource >= radius) return 0.0;
  float falloff = radius - distanceToSource;
  return falloff * falloff * falloff;
}

// Shader bevel. Usage: docs/materials.md (Renderer extensions)
vec3 getBevelNormal(SurfaceInteraction source, float radius) {
  vec3 geometricNormal = source.faceNormal;
  if (dot(geometricNormal, source.vertexNormal) < 0.0) geometricNormal = -geometricNormal;
  vec3 tangent;
  vec3 bitangent;
  sampling_orthonormal_basis(geometricNormal, tangent, bitangent);
  vec3 normalSum = vec3(0.0);

  for (int sampleIndex = 0; sampleIndex < BEVEL_SAMPLES; sampleIndex++) {
    vec2 bevelRnd = sample2D(CAMERA_BEVEL_BASE + uint(sampleIndex));
    float axisSample = bevelRnd.x;
    float radialSample = bevelRnd.y;
    vec3 diskNormal = geometricNormal;
    vec3 diskTangent = tangent;
    vec3 diskBitangent = bitangent;
    float pickPdfNormal = 0.5;
    float pickPdfTangent = 0.25;
    float pickPdfBitangent = 0.25;
    if (axisSample < 0.5) {
      axisSample *= 2.0;
    }
    else if (axisSample < 0.75) {
      vec3 swapAxis = diskNormal;
      diskNormal = diskTangent;
      diskTangent = swapAxis;
      pickPdfNormal = 0.25;
      pickPdfTangent = 0.5;
      axisSample = (axisSample - 0.5) * 4.0;
    }
    else {
      vec3 swapAxis = diskNormal;
      diskNormal = diskBitangent;
      diskBitangent = swapAxis;
      pickPdfNormal = 0.25;
      pickPdfBitangent = 0.5;
      axisSample = (axisSample - 0.75) * 4.0;
    }

    vec2 diskSample = bevelCubicSample(radius, radialSample);
    float phi = TWOPI * axisSample;
    vec3 diskOffset = diskSample.x *
      (cos(phi) * diskTangent + sin(phi) * diskBitangent);
    Ray ray;
    initRay(
      ray,
      source.position + diskNormal * diskSample.y + diskOffset,
      -diskNormal
    );
    SurfaceInteraction hit;
    intersectSceneBevel(
      ray,
      hit,
      source.instanceIndex,
      max(2.0 * diskSample.y, EPS)
    );
    if (!hit.hit) continue;

    float pdfNormal = pickPdfNormal * abs(dot(diskNormal, hit.faceNormal));
    float pdfTangent = pickPdfTangent * abs(dot(diskTangent, hit.faceNormal));
    float pdfBitangent = pickPdfBitangent * abs(dot(diskBitangent, hit.faceNormal));
    float weight = pdfNormal / max(
      pdfNormal * pdfNormal + pdfTangent * pdfTangent +
        pdfBitangent * pdfBitangent,
      1e-8
    );
    weight *= bevelCubicPdf(radius, distance(hit.position, source.position)) /
      max(bevelCubicPdf(radius, diskSample.x), 1e-8);
    normalSum += weight * hit.vertexNormal;
  }

  if (dot(normalSum, normalSum) <= 1e-12) return source.normal;
  vec3 bevelVertexNormal = normalize(normalSum);
  vec3 result = source.normal + bevelVertexNormal - source.vertexNormal;
  return dot(result, result) > 1e-12 ? normalize(result) : source.normal;
}

vec4 integrateOnePathSample(SurfaceInteraction si, Ray ray, OpenPbrResolvedMaterial mat, inout RayTraceAuxiliary outAux) {
  Path path;
  path.ray = ray;
  path.li = vec3(0);
  path.alpha = transmissiveOutputAlphaMin < 1.0 ? 0.0 : 1.0;
  path.beta = vec3(1.0);
  path.fromEye = true;
  path.scatteringPdf = 0.0;
  path.scatteringIsDelta = false;
  path.isNextRefraction = false;
  path.abort = false;
  int depth = 0;
${intelMac ? bounceCodeOnIntelMac : bounceCodeOnOther}
  return vec4(path.li, path.alpha);
}

vec4 integrateOnePath(SurfaceInteraction si, Ray ray, OpenPbrResolvedMaterial mat, inout RayTraceAuxiliary outAux) {
  float coverage = clamp(mat.alpha, 0.0, 1.0);
  if (!si.hit || (mat.materialType != STANDARD && mat.materialType != UNLIT) || coverage >= 1.0) {
    return integrateOnePathSample(si, ray, mat, outAux);
  }

  // glTF BLEND is source-over opacity, not a physical glass boundary. Split
  // the primary ray so reflected radiance is attenuated by alpha every sample
  // while the complementary branch continues straight to the scene behind it.
  // Secondary alpha hits remain stochastic to avoid exponential path growth.
  Ray backRay = ray;
  backRay.o = si.position + ray.d * (EPS * 0.02);
  SurfaceInteraction backSi = si;
  backSi.albedoSampled = false;
  intersectScene(backRay, backSi, false);
  OpenPbrResolvedMaterial backMat;
  getMaterial(backMat, backSi.materialIndex, backSi.uv, backSi.uv1, backSi.instanceIndex, backSi.vertexColor);
  RayTraceAuxiliary backAux = outAux;
  if (backSi.hit && (backMat.materialType == STANDARD || backMat.materialType == UNLIT)) {
    backAux.albedo = backMat.transmissionWeight > 0.5
      ? vec3(1.0)
      : backMat.baseColor;
    backAux.normal = dot(
      backSi.normal,
      backSi.position - vec3(viewInv[3])
    ) > 0.0
      ? -backSi.normal
      : backSi.normal;
    backSi.albedoSampled = backMat.transmissionWeight > 0.5;
  }
  vec4 back = integrateOnePathSample(backSi, backRay, backMat, backAux);
  if (coverage <= 0.0) {
    outAux = backAux;
    return back;
  }

  SurfaceInteraction frontSi = si;
  OpenPbrResolvedMaterial frontMat = mat;
  frontMat.alpha = 1.0;
  RayTraceAuxiliary frontAux = outAux;
  vec4 front = integrateOnePathSample(frontSi, ray, frontMat, frontAux);
  outAux.albedo = mix(backAux.albedo, frontAux.albedo, coverage);
  vec3 blendedNormal = mix(backAux.normal, frontAux.normal, coverage);
  outAux.normal = dot(blendedNormal, blendedNormal) > 1e-12
    ? normalize(blendedNormal)
    : vec3(0.0);
  outAux.isBlank = backAux.isBlank && frontAux.isBlank;
  return mix(back, front, coverage);
}

// Path tracing integrator as described in
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Path_Tracing.html#
vec4 integrator(Ray ray, out RayTraceAuxiliary outAux) {

  SurfaceInteraction si;
  OpenPbrResolvedMaterial mat;

  si.albedoSampled = false;
#ifdef HAS_MEDIUM
  si.mediumType = 0;
  si.mediumExtinction = vec3(0.0);
  si.mediumScattering = vec3(0.0);
  si.mediumAnisotropy = 0.0;
#endif

  intersectScene(ray, si, false);
  getMaterial(mat, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
  si.isTransparency = mat.transmissionWeight > 0.001 || mat.subsurfaceWeight > 0.001 || mat.alpha < 0.999;

#ifdef HAS_BEVEL
  if (bevelEnabled && mat.bevel > 0.0) {
    si.normal = getBevelNormal(si, mat.bevel);
  }
#endif

  // Keep a clean first-hit fallback for denoising. Glass retains this stable
  // guide; other delta paths may replace it at their first non-delta hit.
  if (si.hit && (mat.materialType == STANDARD || mat.materialType == UNLIT)) {
    outAux.albedo = mat.transmissionWeight > 0.5 ? vec3(1.0) : mat.baseColor;
    outAux.normal = dot(si.normal, si.position - vec3(viewInv[3])) > 0.0
      ? -si.normal
      : si.normal;
    // A refracted/reflected continuation is stochastic and therefore not a
    // clean OIDN feature. Keep the stable primary glass guide instead.
    si.albedoSampled = mat.transmissionWeight > 0.5;
  }

  if (mat.transmissionDispersionScale > 0.001) {
    mat.specularIor = sampling_cauchy_ior(
      pathWavelength,
      mat.specularIor,
      mat.transmissionDispersionScale,
      mat.dispersionAbbeNumber
    );
  }
  return integrateOnePath(si, ray, mat, outAux);
}

void main() {

  initRandom();
  rng_initialize(v_Texcoord * viewportSize, int(uint(sampleCount) ^ sampleHash(uint(sequenceSeed))));


  pathWavelength = dispersionWavelengths == 1 ? 0.0 : wavelength;
  heroWavelength = wavelength;
  if (dispersionWavelengths == 1 && wavelength > 0.0) {
    float channel = floor(sample1D(CAMERA_WAVELENGTH) * 3.0);
    heroWavelength = channel < 1.0 ? 650.0 : channel < 2.0 ? 510.0 : 475.0;
  }

  // Thin lens model with depth-of-field
  // http://www.pbr-book.org/3ed-2018/Camera_Models/Projective_Camera_Models.html#TheThinLensModelandDepthofField
  Ray cam = primaryCameraRay();

  RayTraceAuxiliary outAux;
  outAux.albedo = vec3(0.0);
  outAux.normal = vec3(0.0);
  outAux.isBlank = false;
  outAux.isShadowCatcher = false;

  vec4 liAndAlpha = integrator(cam, outAux);

  // Clamp at Integration Level to reduce fireflies.
  // TODO Path level configuration?
#ifdef CLAMPING
  float clamping = float(CLAMPING);
  liAndAlpha.rgb = clamp(liAndAlpha.rgb, -clamping, clamping);
#endif

  // Each sample will be accumulated three times.
  if (pathWavelength > 0.0) {
    // RGB will be normalized using accumated hit in out_albedo.a
    liAndAlpha.rgb *= 3.0;
    if (dispersionWavelengths != 1) {
      // Full spectral samples use three additive passes. Preview only submits
      // one hero wavelength, so its alpha must not be divided.
      liAndAlpha.a /= 3.0;
    }
  }
  if (!(liAndAlpha.x < INF && liAndAlpha.x > -EPS)) {
    liAndAlpha = vec4(0, 0, 0, 1);
  }

  out_color = liAndAlpha;
  out_albedo = vec4(outAux.albedo, outAux.isBlank ? 0.0 : 1.0);
  out_normal = vec4(outAux.normal, 1.0);
  // Moments and count of the built-in denoiser's guide value. The catcher
  // pass accumulates its own samples (see shadowCatcher.frag).
  float guideValue = dot(liAndAlpha.rgb, vec3(0.2126, 0.7152, 0.0722));
  out_moments = outAux.isShadowCatcher
    ? vec4(0.0)
    : vec4(guideValue, guideValue * guideValue, 1.0, 0.0);

}`
  });
}
