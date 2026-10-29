import {photonQueryWgsl} from './photonMap.compute.js';
import backgroundWgsl from './chunks/background.wgsl.js';
import {createMneeWgsl} from './chunks/mnee.wgsl.js';
import {causticPartitionWGSL} from './chunks/caustics.wgsl.js';
import { MAX_PATH_EVENTS } from '../pathLimits.js';
import shadowCatcherAccumulationWGSL from './chunks/shadowCatcherAccumulation.wgsl.js';
import reflectanceWGSL from './aovReflectance.wgsl.js';
import aovTraceWGSL from './aovTrace.wgsl.js';
import depthQueryWGSL from './depthQuery.wgsl.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import commonWgsl from './chunks/common.wgsl.js';
import { WGPU_SCENE_FEATURE_BITS } from '../WGPUSceneFeatures.js';
import {ALL_MATERIAL_SHADER_CAPABILITIES, MATERIAL_SHADER_CAPABILITIES} from '../shaderCapabilities.js';
import rayTraceCoreWgsl from './chunks/rayTraceCore.wgsl.js';
import { createMaterialBufferWgsl } from './chunks/materialBuffer.wgsl.js';
import createIntersectionWgsl from './chunks/intersect.wgsl.js';
import randomWgsl from './chunks/random.wgsl.js';
import randWgsl from './chunks/rand.wgsl.js';
import { createSampleMaterialWgsl } from './chunks/sampleMaterial.wgsl.js';
import sampleLightWgsl from './chunks/sampleLight.wgsl.js';
import { createOpenPbrBsdfWgsl } from './chunks/openPbrBsdf.wgsl.js';
import samplingWgsl from './chunks/sampling.wgsl.js';
import sampleShadowCatcherWgsl from './chunks/sampleShadowCatcher.wgsl.js';
import envMapWgsl from './chunks/envMap.wgsl.js';
import uvProjectionWgsl from './chunks/uvProjection.wgsl.js';
export const WORKGROUP_SIZE = 8;

/** Native input instrumentation; omitted hooks preserve the production source. */
export interface RayTraceInputHooks {
  declarations: string;
  begin: string;
  primarySurface: string;
  unclampedColor: string;
  end: string;
  uniformJitter: boolean;
}

export interface RayTraceShaderOptions {
  hasDisplacement: boolean;
  mnee?: boolean;
  mneeDebugGroup?: number;
  mneeSeeds?:number;
  mneeDamping?:boolean;
  smsRoulette?:boolean;
  mneeMaxDepth?:number;
  mneeMethod?:'newton'|'sms';
  /** Native ray-query hits carry source primitive indices. Default false. */
  mneeHardwareIndices?:boolean;
  /** Invocation block edge; the native host matches dispatch to this value. Default 8. */
  workgroupSize?:number;
  lightTracing?: boolean;
  photonMapping?:boolean;
  photonMaxDepth?:number;
  /** Include direction frames only when used, preserving the legacy shader arithmetic otherwise. */
  hasAnisotropyDirections?: boolean;
  /** Include independent coat normals only when a material uses that slot. */
  hasCoatNormals?: boolean;
  /** Split glTF BLEND primary hits deterministically instead of stochastically. */
  hasAlpha?: boolean;
  /** Any scene material uses alpha mask or blend. */
  hasSceneAlpha?: boolean;
  /** Bit mask of the BLAS layouts present in the scene (bvh2, bvh4, bvh-gpu, cwbvh). */
  blasLayoutMask?: number;
  /** Defined only when pipeline constants are baked into the source. */
  spectral?: boolean;
  sceneCapabilities?: number;
  /** Retained environment support must still respect the current illumination state. */
  dynamicEnvironment?: boolean;
  materialCapabilities?: number;
  lightCapabilities?: number;
}

/** Generates the WebGPU megakernel path tracing compute shader. */
export default function rayTraceCompute({
  hasDisplacement,workgroupSize=WORKGROUP_SIZE,
  mnee = false, lightTracing = false,photonMapping=false,photonMaxDepth=20, mneeDebugGroup = -1,mneeSeeds=4,mneeDamping=false,mneeMaxDepth=20,smsRoulette=false,mneeMethod='newton',mneeHardwareIndices=false,
  hasAnisotropyDirections = false,
  hasCoatNormals = false,
  hasAlpha = true,
  hasSceneAlpha = true,
  blasLayoutMask = 1,
  spectral,
  sceneCapabilities,
  dynamicEnvironment = false,
  materialCapabilities = ALL_MATERIAL_SHADER_CAPABILITIES,
  lightCapabilities
}: RayTraceShaderOptions, sceneIntersections = '', pathDiagnostic = false, inputHooks?: RayTraceInputHooks) {
  hasAnisotropyDirections ||= hasCoatNormals;
  const deterministicPrimaryAlpha = hasAlpha;
  const hasShadowCatcher = sceneCapabilities === undefined || (sceneCapabilities & WGPU_SCENE_FEATURE_BITS.HAS_SHADOW_CATCHER) !== 0;
  const primaryVariables = /* wgsl */ `
  var si: SurfaceInteraction;
  var ma: OpenPbrResolvedMaterial;
  si.albedoSampled = false;
  si.mediumType = 0;
  si.mediumExtinction = vec3f(0.0);
  si.mediumScattering = vec3f(0.0);
  si.mediumAnisotropy = 0.0;
  si.barycentrics = vec2f(0.0);

`;
  const primaryGuides = /* wgsl */ `${inputHooks?.primarySurface ?? ''}  if (${hasShadowCatcher ? /* wgsl */ `si.hit && ma.materialType == SHADOW_CATCHER` : /* wgsl */ `false`}) {
    (*outAux).isShadowCatcher = true;
    // The composed denoising input includes this receiver's shadow. Supply
    // neutral reflectance and its shading normal, independent of visibility.
    (*outAux).albedo = vec3f(1.0);
    (*outAux).normal = select(si.normal, -si.normal, dot(si.normal, ray.d) > 0.0);
    var path: Path;
    path.ray = ray;
    path.fromEye = true;
    (*outAux).shadowCounts = sampleShadowCatcher(si, 0, &path);
    // RGB stores primary catcher coverage. The shadow travels in the
    // auxiliary counts, out of reach of color clamping.
    return vec4f(1.0);
  }
  else {
    if (HAS_BEVEL && rtUniform.bevel != 0) {
      if (ma.bevel > 0.0) {
        si.normal = getBevelNormal(si, ma.bevel);
      }
    }

    // Store a clean first-hit fallback. Glass retains this stable guide;
    // other delta paths may replace it at their first non-delta hit.
    if (si.hit && (ma.materialType == STANDARD || ma.materialType == UNLIT)) {
      (*outAux).albedo = select(ma.baseColor, vec3f(1.0), ma.transmissionWeight > 0.5);
      (*outAux).normal = select(
        si.normal,
        -si.normal,
        dot(si.normal, si.position - cameraUniform.viewInv[3].xyz) > 0.0
      );

      // Do not replace a glass guide with a randomly selected downstream
      // refraction/reflection hit; OIDN auxiliary features must stay clean.
      si.albedoSampled = ma.transmissionWeight > 0.5;
    }

    (*outAux).isShadowCatcher = false;


  }
`;
  const source = /* wgsl */ `

${commonWgsl}

${rayTraceCoreWgsl({ hasSceneAlpha, hasAnisotropyDirections, hasCoatNormals, lightCapabilities, caustics: mnee || lightTracing || photonMapping })}

${uvProjectionWgsl}

${createMaterialBufferWgsl({ hasSceneAlpha, hasAnisotropyDirections, hasCoatNormals,
  caustics: mnee || lightTracing || photonMapping,
  hasTransmission: (materialCapabilities & MATERIAL_SHADER_CAPABILITIES.transmission) !== 0,
  hasMetalness: (materialCapabilities & MATERIAL_SHADER_CAPABILITIES.metal) !== 0 })}

${createIntersectionWgsl({ hasDisplacement, blasLayoutMask, hasAnisotropyDirections, hasCoatNormals, sceneIntersections })}
${randWgsl}
${randomWgsl}
${envMapWgsl}

${samplingWgsl}
${createOpenPbrBsdfWgsl(hasAnisotropyDirections, hasCoatNormals)}
${sampleLightWgsl}${inputHooks?.declarations ?? ''}

// Index of the path vertex currently being shaded.
var<private> bounceIndex: u32 = 0u;

// Number of light candidates resampled for each NEE estimate. Interactive
// preview caps the budget at two.
fn neeCandidateCount() -> u32 {
  return u32(max(rtUniform.directLightCandidates, 1));
}

// Hash-based random number used to select among light candidates. It is
// independent of the path sample stream so the candidate count does not
// change the dimensions consumed by later bounces.
fn lightCandidateRandom(salt: u32) -> f32 {
  // Reservoir replacement needs the full [0, 1) interval: sample1D's EPS
  // remapping makes small positive replacement probabilities unreachable.
  // Preserve the legacy sequential RNG draw in the random sampling mode so
  // subsequent path samples retain their stream; selection uses the hash.
  if (SAMPLING_PATTERN == 2) { _ = rand(); }
  let pixelID = samplingPixel.x + samplingPixel.y * u32(rtUniform.outputSize.x);
  let key = sampleSeed(sampleSeed(pixelID, pixelSampleIndex), rtUniform.sequenceSeed);
  let dimension = sampleSeed(samplingBounce, salt) ^ 0xa511e9b3u;
  return f32(sampleHash(key ^ dimension) >> 8u) * (1.0 / 16777216.0);
}

// MIS weight of a light-sampled contribution. With several resampled
// candidates the NEE technique is drawn neeCandidateCount() times.
fn neeMISWeight(lightPdf: f32, scatteringPdf: f32) -> f32 {
  let candidateCount = neeCandidateCount();
  if (candidateCount <= 1u) {
    return sampling_power_heuristic(lightPdf, scatteringPdf);
  }
  let weightedLightPdf = f32(candidateCount) * lightPdf;
  return weightedLightPdf /
    max(weightedLightPdf + scatteringPdf, 1e-20);
}

// MIS weight of a BSDF-sampled ray that hits a light.
fn bsdfMISWeight(scatteringPdf: f32, lightPdf: f32) -> f32 {
  let candidateCount = neeCandidateCount();
  if (candidateCount <= 1u) {
    return sampling_power_heuristic(scatteringPdf, lightPdf);
  }
  let weightedLightPdf = f32(candidateCount) * lightPdf;
  return scatteringPdf /
    max(scatteringPdf + weightedLightPdf, 1e-20);
}

${mnee || lightTracing || photonMapping ? causticPartitionWGSL(mnee, lightTracing,photonMapping,mneeMaxDepth,mneeDebugGroup>=30,photonMaxDepth) : ''}${mnee ? createMneeWgsl(mneeDebugGroup >= 0,mneeMethod==='sms',mneeHardwareIndices,mneeSeeds,mneeDamping,mneeMaxDepth,smsRoulette) : ''}${photonMapping?`const CAUSTIC_LIGHT_TRACING=${lightTracing};
const CAUSTIC_MNEE=${mnee};
const CAUSTIC_MNEE_MAX_DEPTH=${mneeMaxDepth}u;
const CAUSTIC_PHOTON_MAX_DEPTH=${photonMaxDepth}u;
`+photonQueryWgsl:''}${createSampleMaterialWgsl(hasAnisotropyDirections, hasCoatNormals, mnee || lightTracing || photonMapping, mnee,photonMapping)}
${sampleShadowCatcherWgsl}

// Output
@group(3) @binding(0) var<storage, read_write> outColor: array<vec4f>;
@group(3) @binding(1) var<storage, read_write> outNormal: array<vec4f>;
@group(3) @binding(2) var<storage, read_write> outAlbedo: array<vec4f>;

${shadowCatcherAccumulationWGSL}
@group(3) @binding(3) var<storage, read_write> outShadowCatcher: array<ShadowCatcherAccumulation>;


fn accumulateNormalOrVariance(
  pixelIndex: u32,
  radiance: vec3f,
  normal: vec3f
) {
  if (rtUniform.varianceMoments != 0) {
    let value = dot(radiance, luminance);
    outNormal[pixelIndex] += vec4f(value * value, 0.0, 0.0, 1.0);
  }
  else {
    outNormal[pixelIndex] += vec4f(normal, 1.0);
  }
}

// Moments of the per-sample value the built-in denoiser compares, used to
// estimate the variance of each pixel's mean.
fn accumulateDenoiseMoments(pixelIndex: u32, value: f32) {
  outShadowCatcher[pixelIndex].moments += vec4f(value, value * value, 0.0, 0.0);
}


struct RayTraceAuxiliary {
  // Denoising guides and auxiliary pixel classification.
  albedo: vec3f,
  isShadowCatcher: bool,
  normal: vec3f,
  isBlank: bool,
  // Shadow-catcher hits: occluded and total light sample counts.
  shadowCounts: vec2f,
}

${backgroundWgsl}fn sampleSpectralSceneBackground(ray: Ray, wavelength: f32) -> vec4f {
  let bg = sampleSceneBackground(ray);
  if (SPECTRAL) {
    return vec4f(sampling_spectral_rgb_filter(bg.rgb, wavelength), bg.a);
  }
  return bg;
}

// Split shading from hit completion so primary and secondary rays can share
// one traversal/material-load call site in the common RGB integrator.
fn shadeVertex(uv: vec2f, path: ptr<function, Path>, depth: ptr<function, i32>, si: ptr<function, SurfaceInteraction>, ma: ptr<function, OpenPbrResolvedMaterial>, outAux: ptr<function, RayTraceAuxiliary>, sampleIgnoredOut: ptr<function, bool>) {
  *sampleIgnoredOut = false;
  samplingBounce = u32(max(*depth, 0));
  let matType = (*ma).materialType;
  let isShadowCatcher = ${hasShadowCatcher ? /* wgsl */ `matType == SHADOW_CATCHER` : /* wgsl */ `false`};
  if (isShadowCatcher) {
    if ((*path).fromEye) {
      (*si).hit = false;
    }
    else {
      // The catcher only contributes to the separate shadow mask. Secondary
      // rays must see the environment behind it instead of its default white
      // material, otherwise it appears in reflections.
      if (USE_ENVMAP) {
        if ((*path).isNextRefraction) {
          // A camera-visible transmitted ray can hit the invisible catcher
          // before the grounded skybox. Preserve the displayed projection.
          let bg = sampleSpectralSceneBackground(
            (*path).ray,
            (*si).wavelength
          );
          let backgroundMisWeight = select(bsdfMISWeight((*path).scatteringPdf,
            envMapPdf(environmentUv((*path).ray.d)) * rtUniform.envLightPmf),
            1.0, (*path).scatteringIsDelta);
          (*path).li += backgroundMisWeight * (*path).beta * bg.rgb * bg.a;
          (*path).alpha = max((*path).alpha, bg.a);
        }
        else {
          let envUv = environmentUv((*path).ray.d);
          var emission = textureLinear(envMap, envUv).rgb;
          if (SPECTRAL) {
            emission = sampling_spectral_rgb_filter(emission, (*si).wavelength);
          }
          (*path).li += (*path).beta * emission *
            bsdfMISWeight((*path).scatteringPdf, envMapPdf(envUv));
        }
      }
      else {
        let bg = sampleSpectralSceneBackground(
          (*path).ray,
          (*si).wavelength
        );
        (*path).li += (*path).beta * bg.rgb * bg.a;
      }
      (*path).abort = true;
      return;
    }
  }
  if (!(*si).hit) {
    // The spectral integrator traces red, green, and blue paths separately.
    // Split background radiance by wavelength as well so the three paths
    // reconstruct the skybox instead of adding three full RGB copies.
    let bg = sampleSpectralSceneBackground(
      (*path).ray,
      (*si).wavelength
    );
    if ((*path).fromEye) {
      // Sample from background if first ray not hit anything.
      (*path).li = (*path).beta * bg.rgb * bg.a;
      (*path).alpha = bg.a;
      // Only treat as blank pixels when the background is transparent
      (*outAux).isBlank = bg.a < 0.001 ||
        (USE_BACKGROUND && !USE_BACKGROUND_MAP);
    }
    else {
      let cam = initCameraRay(uv);
      let towardsCam = dot(cam.d, (*path).ray.d) > 0.0;
      if (rtUniform.transmissiveOutputAlphaMin < 1.0) {
        if (towardsCam) {
          (*path).alpha = max((*path).alpha, bg.a);
        } else {
          (*path).alpha = 1.0;
        }
      }
      if (!USE_ENVMAP) {
        // A display background is not an illumination environment, but a
        // visible secondary ray (e.g. through glass) still resolves it.
        if (towardsCam) {
          // This is a terminal BSDF-hit contribution, not a replacement for
          // NEE accumulated at earlier vertices on the same path.
          (*path).li += (*path).beta *
            bsdfMISWeight((*path).scatteringPdf, 1.0) * bg.rgb;
        }
      }
    }
    (*path).abort = true;
    return;
  }


  if ((matType == STANDARD || matType == UNLIT)) {
    let alpha = clamp((*ma).alpha, 0.0, 1.0);
    
    if (alpha < 1.0) {
      // Alpha is stochastic coverage. Keep accepted surface radiance at full
      // weight instead of multiplying it by alpha a second time.
      if (alpha <= 0.0 || hashedSample(3u) > alpha) {
        (*sampleIgnoredOut) = true;
      }
    }
    if (!(*sampleIgnoredOut) && rtUniform.transmissiveOutputAlphaMin < 1.0) {
      // A selected stochastic coverage sample is fully covered. Ignored
      // samples leave output alpha untouched and continue to the back layer.
      let outputAlpha = max(1.0 - (*ma).transmissionWeight, 1.0 - pow(1.0 - rtUniform.transmissiveOutputAlphaMin, f32(*depth)));
      (*path).alpha = max(outputAlpha, (*path).alpha);
    }
    if (!(*sampleIgnoredOut)) {
      bounceIndex = u32(max(*depth, 0));
      SampleMaterial(si, ma, path);
    }
    else {
      // Alpha-null traversal does not consume the receiver event. The first
      // accepted surface behind it is still the receiver for NEE/AOVs.
      (*path).ray.o = (*si).position + (*path).ray.d * EPS;
    }
  }

  if (!(*si).albedoSampled && !(*sampleIgnoredOut)) {
    // Select denoising guides.
    if ((matType == STANDARD || matType == UNLIT)) {
      if (!((*ma).transmissionWeight > 0.5 ||
        ((*ma).specularRoughness <= 0.02 && (*ma).baseMetalness > 0.98))) {
        (*outAux).albedo = (*ma).baseColor;
        (*outAux).normal = select(
          (*si).normal,
          -(*si).normal,
          dot(
            (*si).normal,
            (*si).position - cameraUniform.viewInv[3].xyz
          ) > 0.0
        );
        (*si).albedoSampled = true;
      }
      // TODO pick albedo and normal on the surface if ray is too deep and can't hit any rough or opaque surfaces.
      if (*depth > 4) {
        (*si).albedoSampled = true;
      }
    }
  }

  // Russian roulette with throughput compensation.
  if (USE_RR) {
    if (*depth >= RR_MAX && !(*sampleIgnoredOut)) {
      let rouletteBeta = (*path).beta;
      // Max-component survival (pbrt-v4) avoids over-amplifying saturated paths.
      let maxComponent = max(max(rouletteBeta.x, rouletteBeta.y), rouletteBeta.z);
      let q: f32 = max(0.0, 1.0 - maxComponent);
      if (sample1D(bounceDim(RUSSIAN_ROULETTE)) < q) {
        // TODO we force use alpha 1.0 here.
        // To avoid the glass pixels is transparent even if it's on an opaque object.
        (*path).alpha = 1.0;
        (*path).abort = true;
      }
      else {
        (*path).beta /= 1.0 - q;
      }
    }
  }
  if ((*path).abort) {
    return;
  }


}

fn completeVertex(path: ptr<function, Path>, depth: ptr<function, i32>, si: ptr<function, SurfaceInteraction>, ma: ptr<function, OpenPbrResolvedMaterial>, sampleIgnored: bool) {
  if (SPECTRAL) {
    // Is glass
    if ((*ma).transmissionWeight > 0.001) {
      (*ma).specularIor = sampling_cauchy_ior(
        (*si).wavelength,
        (*ma).specularIor,
        (*ma).transmissionDispersionScale,
        (*ma).dispersionAbbeNumber
      );
    }
  }

  if (sampleIgnored) {
    return;
  }

  // Use light if hit the light
  var lightSample: LightSampleRec;
  let isAlphaOccluded = hashedSample(3u) < (*ma).alpha;
  for (var i = 0; i < rtUniform.lightsCount; i++) {
    // Fetch light Data
    let light: Light = analyticLights[i];
    let d = intersectLight((*path).ray, light, &lightSample);
    lightSample.pdf *= light.selectionPmf;
    let occluded = (*si).hit && d > distance((*si).position, (*path).ray.o);
    if (d != INF && !(occluded && isAlphaOccluded)) {
      let misWeight = bsdfMISWeight((*path).scatteringPdf, lightSample.pdf);
      if (SPECTRAL) {
        lightSample.emission = sampling_spectral_rgb_filter(lightSample.emission, (*si).wavelength);
      }
      ${mnee || lightTracing || photonMapping ? 'if (!causticHitOwned(*path, true, true)) { causticHotRecord(*path,misWeight*lightSample.emission,2u); ' : ''}(*path).li += misWeight * (*path).beta * lightSample.emission;${mnee || lightTracing || photonMapping ? ' }' : ''}
      (*path).alpha = 1.0;
      (*path).abort = true;
    }
  }

  if (USE_ENVMAP) {
    if (!((*si).hit && isAlphaOccluded)) {${lightTracing||photonMapping ? /* wgsl */ `
      if(causticHitOwned(*path,false,true)){(*path).abort=true;return;}` : ''}
      if ((*path).isNextRefraction) {
        // Camera-visible transmission follows the displayed background,
        // including grounded projection. Other rays use the raw environment
        // map as the physically sampled lighting source.
        let bg = sampleSpectralSceneBackground(
          (*path).ray,
          (*si).wavelength
        );
        let backgroundMisWeight = select(bsdfMISWeight((*path).scatteringPdf,
            envMapPdf(environmentUv((*path).ray.d)) * rtUniform.envLightPmf),
            1.0, (*path).scatteringIsDelta);
          (*path).li += backgroundMisWeight * (*path).beta * bg.rgb * bg.a;
        (*path).alpha = max((*path).alpha, bg.a);
        (*path).abort = true;
        return;
      }
      let _uv = environmentUv((*path).ray.d);
      var emission = textureLinear(envMap, _uv).rgb;
      let misWeight = bsdfMISWeight(
        (*path).scatteringPdf,
        envMapPdf(_uv) * rtUniform.envLightPmf
      );
      if (SPECTRAL) {
        emission = sampling_spectral_rgb_filter(emission, (*si).wavelength);
      }
      // TODO force the min alpha to be 1 when showing envmap as background
      if (!USE_BACKGROUND) {
        (*path).alpha = 1.0;
      }
      (*path).li += (*path).beta * emission * misWeight;
      (*path).abort = true;
    }
  }

  *depth = *depth + 1;
}

fn initCameraRay(coord: vec2f) -> Ray {
  let origin = cameraUniform.viewProjectionInv * vec4f(coord * 2.0 - 1.0, -1.0, 1.0);
  let center = cameraUniform.viewProjectionInv * vec4f(coord * 2.0 - 1.0, 1.0, 1.0);
  var cam: Ray;
  initRay(&cam, origin.xyz / origin.w, normalize(center.xyz * origin.w - origin.xyz * center.w));

  return cam;
}


fn bevelCubicSample(radius: f32, xi: f32) -> vec2f {
  var x = 0.25;
  for (var iteration = 0; iteration < 10; iteration++) {
    let x2 = x * x;
    let x3 = x2 * x;
    let oneMinusX = 1.0 - x;
    let value = 10.0 * x2 - 20.0 * x3 + 15.0 * x2 * x2 -
      4.0 * x2 * x3 - xi;
    let derivative = 20.0 * x * oneMinusX * oneMinusX * oneMinusX;
    if (abs(value) < 1e-6 || derivative == 0.0) { break; }
    x = clamp(x - value / derivative, 0.0, 1.0);
  }
  let diskRadius = x * radius;
  return vec2f(diskRadius, sqrt(max(radius * radius - diskRadius * diskRadius, 0.0)));
}

fn bevelCubicPdf(radius: f32, distanceToSource: f32) -> f32 {
  if (distanceToSource >= radius) { return 0.0; }
  let falloff = radius - distanceToSource;
  return falloff * falloff * falloff;
}

// Shader bevel. Usage: docs/materials.md (Renderer extensions)
fn getBevelNormal(source: SurfaceInteraction, radius: f32) -> vec3f {
  var geometricNormal = source.faceNormal;
  if (dot(geometricNormal, source.vertexNormal) < 0.0) {
    geometricNormal = -geometricNormal;
  }
  var tangent: vec3f;
  var bitangent: vec3f;
  sampling_orthonormal_basis(geometricNormal, &tangent, &bitangent);
  var normalSum = vec3f(0.0);

  for (var sampleIndex = 0; sampleIndex < BEVEL_SAMPLES; sampleIndex++) {
    let bevelRnd = sample2D(CAMERA_BEVEL_BASE + u32(sampleIndex));
    var axisSample = bevelRnd.x;
    let radialSample = bevelRnd.y;
    var diskNormal = geometricNormal;
    var diskTangent = tangent;
    var diskBitangent = bitangent;
    var pickPdfNormal = 0.5;
    var pickPdfTangent = 0.25;
    var pickPdfBitangent = 0.25;
    if (axisSample < 0.5) {
      axisSample *= 2.0;
    }
    else if (axisSample < 0.75) {
      let swapAxis = diskNormal;
      diskNormal = diskTangent;
      diskTangent = swapAxis;
      pickPdfNormal = 0.25;
      pickPdfTangent = 0.5;
      axisSample = (axisSample - 0.5) * 4.0;
    }
    else {
      let swapAxis = diskNormal;
      diskNormal = diskBitangent;
      diskBitangent = swapAxis;
      pickPdfNormal = 0.25;
      pickPdfBitangent = 0.5;
      axisSample = (axisSample - 0.75) * 4.0;
    }

    let diskSample = bevelCubicSample(radius, radialSample);
    let phi = TWOPI * axisSample;
    let diskOffset = diskSample.x *
      (cos(phi) * diskTangent + sin(phi) * diskBitangent);
    var ray: Ray;
    initRay(
      &ray,
      source.position + diskNormal * diskSample.y + diskOffset,
      -diskNormal
    );
    var hit: SurfaceInteraction;
    intersectSceneBevel(
      ray,
      &hit,
      source.instanceIndex,
      max(2.0 * diskSample.y, EPS)
    );
    if (!hit.hit) { continue; }

    let pdfNormal = pickPdfNormal * abs(dot(diskNormal, hit.faceNormal));
    let pdfTangent = pickPdfTangent * abs(dot(diskTangent, hit.faceNormal));
    let pdfBitangent = pickPdfBitangent * abs(dot(diskBitangent, hit.faceNormal));
    var weight = pdfNormal / max(
      pdfNormal * pdfNormal + pdfTangent * pdfTangent +
        pdfBitangent * pdfBitangent,
      1e-8
    );
    weight *= bevelCubicPdf(radius, distance(hit.position, source.position)) /
      max(bevelCubicPdf(radius, diskSample.x), 1e-8);
    normalSum += weight * hit.vertexNormal;
  }

  if (dot(normalSum, normalSum) <= 1e-12) { return source.normal; }
  let bevelVertexNormal = normalize(normalSum);
  let result = source.normal + bevelVertexNormal - source.vertexNormal;
  if (dot(result, result) > 1e-12) { return normalize(result); }
  return source.normal;
}

fn integrateOnePathSample(uv: vec2f, si: ptr<function, SurfaceInteraction>, ray: Ray, ma: ptr<function, OpenPbrResolvedMaterial>, outAux: ptr<function, RayTraceAuxiliary>, initialQuery: bool) -> vec4f {
  var path: Path;
  path.ray = ray;
  path.li = vec3f(0.0);
  path.alpha = select(1.0, 0.0, rtUniform.transmissiveOutputAlphaMin < 1.0);
  path.beta = vec3f(1.0);
  path.fromEye = true;
  path.scatteringPdf = 0.0;
  path.scatteringIsDelta = false;
  path.isNextRefraction = false;
  path.abort = false;

  let bounceLimit = max(rtUniform.bounces, 0);
  let eventLimit = min(bounceLimit * 3, ${MAX_PATH_EVENTS});
  var depth = 0;
  var sampleIgnored = false;
  var isNotTransparent = false;
  // Back branches and subsequent bounces share one query/material call site.
  // Keep wavelength/branch loops separate so GPU lanes reconverge between
  // paths. Include the final query, which the legacy bounce completed before
  // testing its event budget. Even a zero-bounce back branch resolves guides.
  for (var event = 0; event <= eventLimit; event++) {
    if ((event != 0) | initialQuery) {
      intersectScene(path.ray, si, depth, event != 0, path.isNextRefraction);
      getMaterial(ma, (*si).materialIndex, (*si).uv, (*si).uv1, (*si).instanceIndex, (*si).vertexColor);
    }
    if (event == 0) {
      if (initialQuery & (*si).hit & ((*ma).materialType == STANDARD)) {
        (*outAux).albedo = select((*ma).baseColor, vec3f(1.0), (*ma).transmissionWeight > 0.5);
        (*outAux).normal = select((*si).normal, -(*si).normal,
          dot((*si).normal, (*si).position - cameraUniform.viewInv[3].xyz) > 0.0);
        (*si).albedoSampled = (*ma).transmissionWeight > 0.5;
      }
      isNotTransparent = ((*ma).transmissionWeight < 0.001) & ((*ma).subsurfaceWeight < 0.001) & ((*ma).alpha > 0.99);
    } else {
      completeVertex(&path, &depth, si, ma, sampleIgnored);
    }
    if (isNotTransparent & (event > bounceLimit)) { path.abort = true; }
    if (path.abort | (event >= eventLimit)) { break; }
    shadeVertex(uv, &path, &depth, si, ma, outAux, &sampleIgnored);
    if (path.abort) { break; }
  }

  return vec4f(path.li, path.alpha);
}

fn integrateOnePath(uv: vec2f, si: ptr<function, SurfaceInteraction>, ray: Ray, ma: ptr<function, OpenPbrResolvedMaterial>, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
  ${deterministicPrimaryAlpha ? /* wgsl */ `let coverage = clamp((*ma).alpha, 0.0, 1.0);
  // glTF BLEND is source-over opacity, not a physical glass boundary. Split
  // the primary ray so reflected radiance is attenuated by alpha every sample
  // while the complementary branch continues straight to the scene behind it.
  // Secondary alpha hits remain stochastic to avoid exponential path growth.
  let split = (*si).hit & (((*ma).materialType == STANDARD) | ((*ma).materialType == UNLIT)) & (coverage < 1.0);
  var branchRay = ray;
  var branchSi = *si;
  var branchMa = *ma;
  var branchAux = *outAux;
  if (split) {
    branchRay.o = (*si).position + ray.d * (EPS * 0.02);
    branchSi.albedoSampled = false;
  }
  var back: vec4f;
  var backAux: RayTraceAuxiliary;
  // One path graph for opaque, back and front branches. The guard is fixed at
  // four; a dynamic bound keeps DXC from cloning that graph for each branch.
  let branchCount = select(1u, rtUniform.loopUnrollGuard >> 1u, split & (coverage > 0.0));
  for (var branch = 0u; branch < branchCount; branch++) {
    let result = integrateOnePathSample(uv, &branchSi, branchRay, &branchMa, &branchAux, split & (branch == 0u));
    if (!split | (coverage <= 0.0)) { *outAux = branchAux; return result; }
    if (branch == 0u) {
      back = result; backAux = branchAux;
      branchSi = *si; branchMa = *ma; branchMa.alpha = 1.0;
      branchRay = ray; branchAux = *outAux;
    } else {
      (*outAux).albedo = mix(backAux.albedo, branchAux.albedo, coverage);
      let blendedNormal = mix(backAux.normal, branchAux.normal, coverage);
      (*outAux).normal = select(vec3f(0.0), normalize(blendedNormal), dot(blendedNormal, blendedNormal) > 1e-12);
      (*outAux).isBlank = backAux.isBlank & branchAux.isBlank;
      (*outAux).isShadowCatcher = backAux.isShadowCatcher & branchAux.isShadowCatcher;
      (*outAux).shadowCounts = mix(backAux.shadowCounts, branchAux.shadowCounts, coverage);
      return mix(back, result, coverage);
    }
  }
  return vec4f(0.0);` : /* wgsl */ `return integrateOnePathSample(uv, si, ray, ma, outAux, false);`}
}

// Path tracing integrator as described in
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Path_Tracing.html#
${spectral === false && deterministicPrimaryAlpha ? /* wgsl */ `fn integrator(uv: vec2f, ray: Ray, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
${primaryVariables}
  var primarySi: SurfaceInteraction;
  var primaryMa: OpenPbrResolvedMaterial;
  var primaryAux: RayTraceAuxiliary;
  var primaryReady = false;
  var query = true;
  var split = false;
  var coverage = 1.0;
  var front = false;
  var back: vec4f;
  var backAux: RayTraceAuxiliary;
  var path: Path; path.ray = ray;
  path.alpha = select(1.0, 0.0, rtUniform.transmissiveOutputAlphaMin < 1.0);
  path.beta = vec3f(1.0); path.fromEye = true;
  let bounceLimit = max(rtUniform.bounces, 0);
  let eventLimit = min(bounceLimit * 3, ${MAX_PATH_EVENTS});
  var event = 0; var depth = 0; var sampleIgnored = false;
  var isNotTransparent = false;
  // Share one query/material graph across the primary, back and front paths.
  // Complete the back path before the front path to preserve random streams.
  for (var step = 0; step < (${MAX_PATH_EVENTS} + 1) * 2 + 2; step++) {
    if (query) {
      intersectScene(path.ray, &si, depth, event != 0, path.isNextRefraction);
      getMaterial(&ma, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
    }
    query = true;
    if (!primaryReady) {
${primaryGuides}
      primarySi = si; primaryMa = ma; primaryAux = *outAux;
      primaryReady = true;
      coverage = clamp(ma.alpha, 0.0, 1.0);
      split = si.hit & ((ma.materialType == STANDARD) | (ma.materialType == UNLIT)) & (coverage < 1.0);
      if (split) {
        path.ray.o = si.position + ray.d * (EPS * 0.02);
        si.albedoSampled = false;
        continue;
      }
    } else if ((event == 0) & !front & split) {
      if (si.hit & (ma.materialType == STANDARD)) {
        (*outAux).albedo = select(ma.baseColor, vec3f(1.0), ma.transmissionWeight > 0.5);
        (*outAux).normal = select(si.normal, -si.normal,
          dot(si.normal, si.position - cameraUniform.viewInv[3].xyz) > 0.0);
        si.albedoSampled = ma.transmissionWeight > 0.5;
      }
    }
    if (event == 0) {
      isNotTransparent = (ma.transmissionWeight < 0.001) & (ma.subsurfaceWeight < 0.001) & (ma.alpha > 0.99);
    } else {
      completeVertex(&path, &depth, &si, &ma, sampleIgnored);
    }
    if (isNotTransparent & (event > bounceLimit)) { path.abort = true; }
    if (!path.abort & (event < eventLimit)) {
      shadeVertex(uv, &path, &depth, &si, &ma, outAux, &sampleIgnored);
    }
    if (path.abort | (event >= eventLimit)) {
      let result = vec4f(path.li, path.alpha);
      if (!split | (coverage <= 0.0)) { return result; }
      if (front) {
        (*outAux).albedo = mix(backAux.albedo, (*outAux).albedo, coverage);
        let blendedNormal = mix(backAux.normal, (*outAux).normal, coverage);
        (*outAux).normal = select(vec3f(0.0), normalize(blendedNormal), dot(blendedNormal, blendedNormal) > 1e-12);
        (*outAux).isBlank = backAux.isBlank & (*outAux).isBlank;
        (*outAux).isShadowCatcher = backAux.isShadowCatcher & (*outAux).isShadowCatcher;
        (*outAux).shadowCounts = mix(backAux.shadowCounts, (*outAux).shadowCounts, coverage);
        return mix(back, result, coverage);
      }
      back = result; backAux = *outAux;
      front = true; query = false; event = 0; depth = 0; sampleIgnored = false;
      si = primarySi; ma = primaryMa; ma.alpha = 1.0; *outAux = primaryAux;
      path = Path(); path.ray = ray; path.beta = vec3f(1.0); path.fromEye = true;
      path.alpha = select(1.0, 0.0, rtUniform.transmissiveOutputAlphaMin < 1.0);
    } else { event++; }
  }
  return vec4f(0.0);
}
` : spectral === false && !deterministicPrimaryAlpha ? /* wgsl */ `fn integrator(uv: vec2f, ray: Ray, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
${primaryVariables}
  var path: Path;
  path.ray = ray;
  path.alpha = select(1.0, 0.0, rtUniform.transmissiveOutputAlphaMin < 1.0);
  path.beta = vec3f(1.0);
  path.fromEye = true;
  let bounceLimit = max(rtUniform.bounces, 0);
  let eventLimit = min(bounceLimit * 3, ${MAX_PATH_EVENTS});
  var isNotTransparent = false;
  var depth = 0;
  var sampleIgnored = false;
  // The extra iteration completes the last ray query, as the legacy bounce
  // did before testing the event budget. Queries consume the preceding bounce's
  // random stream; shading advances samplingBounce only after hit completion.
  for (var event = 0; event <= eventLimit; event++) {
    intersectScene(path.ray, &si, depth, event != 0, path.isNextRefraction);
    getMaterial(&ma, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
    if (event == 0) {
${primaryGuides}
      isNotTransparent = ma.transmissionWeight < 0.001 && ma.subsurfaceWeight < 0.001 && ma.alpha > 0.99;
    } else {
      completeVertex(&path, &depth, &si, &ma, sampleIgnored);
    }
    if (isNotTransparent && event > bounceLimit) { path.abort = true; }
    if (path.abort || event >= eventLimit) { break; }
    shadeVertex(uv, &path, &depth, &si, &ma, outAux, &sampleIgnored);
    if (path.abort) { break; }
  }
  return vec4f(path.li, path.alpha);
}
` : spectral === true && !deterministicPrimaryAlpha ? /* wgsl */ `
fn integrator(uv: vec2f, ray: Ray, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
${primaryVariables}
  var primarySi: SurfaceInteraction;
  var primaryMa: OpenPbrResolvedMaterial;
  var primaryReady = false;
  var path: Path; path.ray = ray;
  let bounceLimit = max(rtUniform.bounces, 0);
  let eventLimit = min(bounceLimit * 3, ${MAX_PATH_EVENTS});
  var depth = 0; var event = 0; var sampleIgnored = false;
  var isNotTransparent = false;
  var wavelengthIndex = 0;
  let singleWavelength = rtUniform.dispersionWavelengths == 1;
  var dispersivePrimary = false;
  var heroWavelengthIndex = 0;
  var wavelengthRngState: vec4u;
  var wavelengthHashedCounter = 0u;
  var wavelengthAux: RayTraceAuxiliary;
  let wavelengths = array<f32, 3>(650.0, 510.0, 475.0);
  var color = vec3f(0.0); var alpha = 0.0;
  var accumulatedGuideAlbedo = vec3f(0.0);
  var accumulatedGuideNormal = vec3f(0.0);
  var allBlank = true;
  // Flatten the wavelength/path loops to share primary and secondary queries.
  // Each of the three paths uses at most MAX_PATH_EVENTS + 1 iterations,
  // including completion of its final query. The primary hit is reused.
  let stepLimit = min((${MAX_PATH_EVENTS} + 1) * 3, i32(rtUniform.loopUnrollGuard * ${Math.ceil((MAX_PATH_EVENTS + 1) * 3 / 4)}u));
  for (var step = 0; step < stepLimit; step++) {
    if (!primaryReady | ((event != 0) & !path.abort)) {
      intersectScene(path.ray, &si, depth, event != 0, path.isNextRefraction);
      getMaterial(&ma, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
    }
    if (event == 0) {
      if (!primaryReady) {
${primaryGuides}
        primarySi = si; primaryMa = ma; primaryReady = true;
        wavelengthRngState = s0; wavelengthHashedCounter = hashedCounter;
        dispersivePrimary = si.hit & (ma.transmissionWeight > 0.001) & (ma.transmissionDispersionScale > 0.001);
        if (singleWavelength & dispersivePrimary) {
          heroWavelengthIndex = min(i32(floor(sample1D(CAMERA_WAVELENGTH) * 3.0)), 2);
        }
      }
      si = primarySi; ma = primaryMa; wavelengthAux = *outAux;
      if (!singleWavelength) {
        s0 = wavelengthRngState; hashedCounter = wavelengthHashedCounter; samplingBounce = 0u;
        wavelengthAux.isBlank = false; wavelengthAux.isShadowCatcher = false;
      }
      si.wavelength = 0.0;
      if (!singleWavelength | dispersivePrimary) {
        si.wavelength = wavelengths[select(wavelengthIndex, heroWavelengthIndex, singleWavelength)];
        ma.specularIor = sampling_cauchy_ior(si.wavelength, ma.specularIor,
          ma.transmissionDispersionScale, ma.dispersionAbbeNumber);
      }
      path = Path(); path.ray = ray; path.beta = vec3f(1.0); path.fromEye = true;
      path.alpha = select(1.0, 0.0, rtUniform.transmissiveOutputAlphaMin < 1.0);
      depth = 0; sampleIgnored = false;
      isNotTransparent = (ma.transmissionWeight < 0.001) & (ma.subsurfaceWeight < 0.001) & (ma.alpha > 0.99);
    } else if (!path.abort) {
      completeVertex(&path, &depth, &si, &ma, sampleIgnored);
    }
    if (isNotTransparent & (event > bounceLimit)) { path.abort = true; }
    if (!path.abort & (event < eventLimit)) {
      shadeVertex(uv, &path, &depth, &si, &ma, &wavelengthAux, &sampleIgnored);
    }
    if (path.abort | (event >= eventLimit)) {
      let result = vec4f(path.li, path.alpha);
      if (singleWavelength) {
        *outAux = wavelengthAux;
        let scale = select(1.0, 3.0, dispersivePrimary);
        return vec4f(result.rgb * scale, result.a);
      }
      color += result.rgb; alpha = max(alpha, result.a);
      accumulatedGuideAlbedo += wavelengthAux.albedo;
      accumulatedGuideNormal += wavelengthAux.normal;
      allBlank = allBlank & wavelengthAux.isBlank;
      wavelengthIndex++;
      if (wavelengthIndex >= 3) {
        (*outAux).albedo = accumulatedGuideAlbedo / 3.0;
        (*outAux).normal = accumulatedGuideNormal / 3.0;
        (*outAux).isBlank = allBlank;
        return vec4f(color, alpha);
      }
      event = 0;
    } else { event++; }
  }
  return vec4f(0.0);
}
` : /* wgsl */ `fn integrator(uv: vec2f, ray: Ray, outAux: ptr<function, RayTraceAuxiliary>) -> vec4f {
${primaryVariables}
  intersectScene(ray, &si, 0, false, false);
  getMaterial(&ma, si.materialIndex, si.uv, si.uv1, si.instanceIndex, si.vertexColor);
${primaryGuides}
    if (SPECTRAL) {
      // Keep one source-level integrateOnePath call for both interactive
      // preview and offline RGB splitting. A runtime loop bound prevents the
      // WGSL compiler from cloning the full path graph three times while the
      // uniform still selects the exact existing preview/offline behavior.
      let rgbWaveLengths = array<f32, 3>(650.0, 510.0, 475.0);
      var colAccum = vec3f(0.0);
      var alpha = 0.0;
      var accumulatedGuideAlbedo = vec3f(0.0);
      var accumulatedGuideNormal = vec3f(0.0);
      var allBlank = true;
      var si2 = si;
      var ma2 = ma;
      let wavelengthRngState = s0;
      let wavelengthHashedCounter = hashedCounter;
      let singleWavelength = rtUniform.dispersionWavelengths == 1;
      let dispersivePrimary = si.hit &&
        ma.transmissionWeight > 0.001 &&
        ma.transmissionDispersionScale > 0.001;
      let wavelengthCount = select(3, 1, singleWavelength);
      var heroWavelengthIndex = 0;
      if (singleWavelength && dispersivePrimary) {
        // Stochastic hero wavelength: one RGB channel per pixel keeps the
        // preview spectral at one-third of the full three-path cost.
        heroWavelengthIndex = min(i32(floor(sample1D(CAMERA_WAVELENGTH) * 3.0)), 2);
      }
      for (var i = 0; i < wavelengthCount; i++) {
        // Common random numbers keep Monte Carlo error correlated between
        // RGB wavelengths. This removes much of the colored variance that
        // otherwise turns into dirty chromatic patches after OIDN.
        if (!singleWavelength) {
          s0 = wavelengthRngState;
          hashedCounter = wavelengthHashedCounter;
          samplingBounce = 0u;
        }
        si.wavelength = 0.0;
        if (!singleWavelength || dispersivePrimary) {
          si.wavelength = rgbWaveLengths[select(i, heroWavelengthIndex, singleWavelength)];
          ma.specularIor = sampling_cauchy_ior(
            si.wavelength,
            ma.specularIor,
            ma.transmissionDispersionScale,
            ma.dispersionAbbeNumber
          );
        }
        var wavelengthAux: RayTraceAuxiliary;
        if (singleWavelength) {
          wavelengthAux = *outAux;
        } else {
          wavelengthAux.albedo = (*outAux).albedo;
          wavelengthAux.normal = (*outAux).normal;
          wavelengthAux.isBlank = false;
          wavelengthAux.isShadowCatcher = false;
        }
        let res = integrateOnePath(uv, &si, ray, &ma, &wavelengthAux);
        if (singleWavelength) {
          *outAux = wavelengthAux;
          let scale = select(1.0, 3.0, dispersivePrimary);
          return vec4f(res.rgb * scale, res.a);
        }
        colAccum += res.rgb;
        alpha = max(alpha, res.a);
        accumulatedGuideAlbedo += wavelengthAux.albedo;
        accumulatedGuideNormal += wavelengthAux.normal;
        allBlank = allBlank && wavelengthAux.isBlank;
        si = si2;
        ma = ma2;
      }
      (*outAux).albedo = accumulatedGuideAlbedo / 3.0;
      (*outAux).normal = accumulatedGuideNormal / 3.0;
      (*outAux).isBlank = allBlank;
      return vec4f(colAccum, alpha);
    }
    else {
      return integrateOnePath(uv, &si, ray, &ma, outAux);
    }
}
`}

fn sampleCircle(ip: vec2f) -> vec2f {
  let p = 2.0 * ip - 1.0;
  let greater = abs(p.x) > abs(p.y);
  let r = select(p.y, p.x, greater);
  let theta = select(PI * (0.5 - 0.25 * p.x / p.y), 0.25 * PI * p.y / p.x, greater);
  return r * vec2f(cos(theta), sin(theta));
}


@compute @workgroup_size(${workgroupSize}, ${workgroupSize}, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let outputSize = rtUniform.outputSize;
  let scaleOffset = rtUniform.scaleOffset;
  var jitter = rtUniform.jitter;
  // TODO if outputSize is not multiple of 8?
${pathDiagnostic ? `  if (globalId.y >= mtPathParameters.y) { return; }
  let pathId = vec2u(globalId.x, globalId.y + mtPathParameters.x);
` : ''}  let coord = ${pathDiagnostic ? 'pathId' : 'globalId.xy'} * vec2u(scaleOffset.xy) + vec2u(scaleOffset.zw);
  if (coord.x >= u32(outputSize.x) || coord.y >= u32(outputSize.y)) {
    return;
  }
  let idx = coord.x + coord.y * u32(outputSize.x);

  if (
    rtUniform.adaptiveSampling != 0 &&
    outNormal[idx].a >= textureLoad(
      adaptiveSampleTargets,
      vec2i(coord),
      0
    ).r
  ) {
    return;
  }

  // Match WebGL's rasterized v_Texcoord, whose sample is at the center of
  // each pixel. Keeping the same origin is material relevant: a half-pixel
  // shift moves a narrow metal highlight across several pixels.
  let uv = (vec2<f32>(f32(coord.x), f32(coord.y)) + vec2f(0.5)) / outputSize;

  samplingPixel = coord;
  pixelSampleIndex = u32(outNormal[idx].a) + rtUniform.sampleSequenceOffset;
  samplingBounce = 0u; hashedCounter = 0u;
  if (${inputHooks?.uniformJitter ? 'false' : 'SAMPLING_PATTERN == 0 || SAMPLING_PATTERN == 1'}) {
    jitter = (sample2D(CAMERA_PIXEL) - 0.5) / outputSize;
  }
  rng_initialize(coord, i32(pixelSampleIndex ^ sampleHash(rtUniform.sequenceSeed)));
  var cam = initCameraRay(uv + jitter);

  if (cameraUniform.apertureRadius > 0.0) {
    // Thin lens: the focus plane is perpendicular to the view direction.
    let eye = cameraUniform.viewInv[3].xyz;
    let forward = -normalize(cameraUniform.viewInv[2].xyz);
    let focusPoint = eye + cam.d * (cameraUniform.focusDistance / dot(cam.d, forward));
    let lensPoint = cameraUniform.apertureRadius * sampleCircle(sample2D(CAMERA_LENS));
    let origin = (cameraUniform.viewInv * vec4f(lensPoint, 0.0, 1.0)).xyz;
    let dir = normalize(focusPoint - origin);
    initRay(&cam, origin, dir);
  }

  var outAux: RayTraceAuxiliary;
  outAux.albedo = vec3f(0.0);
  outAux.normal = vec3f(0.0);
  outAux.isBlank = false;
  outAux.isShadowCatcher = false;
${pathDiagnostic ? '  mtPathBegin(coord);\n' : ''}${inputHooks?.begin ?? ''}  var liAndAlpha = integrator(uv + jitter, cam, &outAux);
${inputHooks?.unclampedColor ?? ''}
${(mnee||lightTracing||photonMapping) && mneeDebugGroup >= 0 ? /* wgsl */ `  liAndAlpha=${mneeDebugGroup>=30?`vec4f(causticHot[${mneeDebugGroup-30}],1.0)`:mneeDebugGroup>=10?`vec4f(mneeTrace[${mneeDebugGroup-10}]+vec3f(10.0),1.0)`:`vec4f(f32(mneeCounters[${mneeDebugGroup*3}]),f32(mneeCounters[${mneeDebugGroup*3+1}]),f32(mneeCounters[${mneeDebugGroup*3+2}]),1.0)`};
` : ''}  // Clamp at Integration Level to reduce fireflies.
  // TODO Path level configuration?
  if (rtUniform.clamping > 0.0) {
    let clamping = rtUniform.clamping;
    liAndAlpha = vec4(clamp(liAndAlpha.rgb, -vec3f(clamping), vec3f(clamping)), liAndAlpha.a);
  }
  if (!(liAndAlpha.x < INF && liAndAlpha.x > -EPS)) {
    liAndAlpha = vec4f(0.0, 0.0, 0.0, 1.0);
  }

  if (outAux.isShadowCatcher) {
    // The catcher is invisible, so the main color at this pixel must still
    // contain whatever the camera ray would have seen behind it.
    let backgroundSample = sampleSceneBackground(cam);
    let backgroundHit = select(0.0, 1.0, backgroundSample.a >= 0.01);
    let backgroundPremultiplied = vec4f(backgroundSample.rgb * backgroundSample.a, backgroundSample.a);
    // Keep the background contribution separate from geometry at silhouettes.
    // mask: catcher coverage, background alpha, background hits. The resolve
    // pass derives shadow opacity from the occluded/total sample counts in moments.zw.
    outShadowCatcher[idx].mask += vec4f(1.0, backgroundSample.a, backgroundHit, 0.0);
    outShadowCatcher[idx].moments += vec4f(0.0, 0.0, outAux.shadowCounts);
    outShadowCatcher[idx].background += backgroundPremultiplied;
    outColor[idx] += backgroundPremultiplied;
    outAlbedo[idx] += vec4f(outAux.albedo, backgroundHit);
    accumulateNormalOrVariance(idx, backgroundSample.rgb, outAux.normal);
    // The composed catcher is the background darkened by the shadow. Over a
    // transparent background the shadow is only its opacity.
    let counts = outAux.shadowCounts;
    let visibility = 1.0 - select(0.0, counts.x / counts.y, counts.y > 0.0);
    accumulateDenoiseMoments(idx, visibility * select(
      1.0, dot(backgroundSample.rgb, luminance), backgroundSample.a >= 0.01
    ));
  }
  else {
    if (HAS_SHADOW_CATCHER && outAux.isBlank && USE_BACKGROUND && !USE_BACKGROUND_MAP && rtUniform.backgroundColor.a >= 0.99999) {
      // A primary miss sees the same opaque display backdrop as a catcher
      // hit, but must never receive its shadow. Keep that radiance and alpha
      // out of the geometry layer before hit-count normalization/tone mapping.
      // Red/blue still count only actual catcher hits; green counts all
      // background alpha removed from the foreground during normalization.
      outShadowCatcher[idx].background += liAndAlpha;
      outShadowCatcher[idx].mask.g += liAndAlpha.a;
    }
    outColor[idx] += liAndAlpha;
    outAlbedo[idx] += vec4f(outAux.albedo, select(1.0, 0.0, outAux.isBlank));
    accumulateNormalOrVariance(idx, liAndAlpha.rgb, outAux.normal);
    accumulateDenoiseMoments(idx, dot(liAndAlpha.rgb, luminance));
  }
${pathDiagnostic ? '  mtPathEnd(outAux.normal, outAux.albedo);\n' : ''}${inputHooks?.end ?? ''}}
`;
  // The query entry point shares the exact BVH and material implementation.
  // It has no effect on the beauty entry point or its bindings.
  // Gate optional material layers on scene-level feature flags so drivers can
  // skip the unused BSDF lobes.
  let specializedSource = source + depthQueryWGSL + reflectanceWGSL + aovTraceWGSL;
  const backgroundBits: Record<string, number> = {
    USE_BACKGROUND: 1,
    USE_BACKGROUND_MAP: 2,
    USE_GROUNDED_BACKGROUND: 4
  };
  specializedSource = specializedSource.replace(
    /\b(?:USE_BACKGROUND|USE_BACKGROUND_MAP|USE_GROUNDED_BACKGROUND)\b/g,
    (name) => `((rtUniform.backgroundFlags & ${backgroundBits[name]}) != 0)`
  );
  specializedSource = specializedSource.replace(
    new RegExp(`\\b(?:${Object.keys(WGPU_SCENE_FEATURE_BITS).join('|')})\\b`, 'g'),
    // Material weights and absent texture indices already disable retained
    // material capabilities. Environment presence also changes background/MIS
    // behavior, so its active flag must remain dynamic when support is retained.
    name => sceneCapabilities === undefined || dynamicEnvironment && name === 'USE_ENVMAP' && (sceneCapabilities & WGPU_SCENE_FEATURE_BITS[name]) !== 0
      ? /* wgsl */ `((rtUniform.sceneFeatureFlags & ${WGPU_SCENE_FEATURE_BITS[name]}u) != 0u)`
      : (sceneCapabilities & WGPU_SCENE_FEATURE_BITS[name]) !== 0 ? /* wgsl */ `true` : /* wgsl */ `false`
  );
  return specializedSource;
}
