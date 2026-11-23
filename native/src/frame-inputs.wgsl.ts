import {framePixelStruct} from './layout.js';
import type {RayTraceInputHooks} from '../../src/renderer/wgsl/rayTrace.compute.js';
import {GROUP} from './layout.js';
import {unsupportedCoatReflectanceWgsl, unsupportedFuzzReflectanceWgsl} from '../../src/renderer/wgsl/aovReflectance.wgsl.js';
import {createAovDenoisingGuideWgsl, wgslDenoisingPathSupports} from '../../src/renderer/wgsl/aovDenoisingGuide.wgsl.js';

// Internal diagnostic record. It contains resolved first-surface data rather
// than reusing OIDN's possibly downstream guides. BaseColor and directional
// reflectance are distinct fields; optical path branches remain separate.
export function nativeFrameInputHooks(hasCoatNormals: boolean, hasAnisotropyDirections: boolean): RayTraceInputHooks {
  return {
    uniformJitter: true,
    layeredReflectance: true,
    recordReflection: true,
    begin: '  mtFrameBegin(idx);\n',
    primarySurface: '  mtFrameSurface(si, ma, ray);\n',
    preparedSurface: (prepared) => `    mtFrameGuideSurface(${prepared}, si, path);\n`,
    unclampedColor: '  if (mtLeadingSample) { mtFramePixels[mtFrameIndex].unclampedRadiance = vec4f(liAndAlpha.rgb, 1.0); }\n',
    end: '  mtFrameFinish(liAndAlpha.rgb);\n',
    declarations: /* wgsl */ `
${framePixelStruct('MtFramePixel')}
${createAovDenoisingGuideWgsl(hasCoatNormals)}
${wgslDenoisingPathSupports}
override MT_DENOISING_GUIDE_MODEL: u32 = 0u;
@group(${GROUP.OUTPUT}) @binding(4) var<storage, read_write> mtFramePixels: array<MtFramePixel>;
struct MtReflection {
  endpointDistance: vec4f,
  normalInstance: vec4u,
}
@group(${GROUP.OUTPUT}) @binding(10) var<storage, read_write> mtReflections: array<MtReflection>;
var<private> mtReflectionPending: bool;
var<private> mtRefractionStage: u32;
var<private> mtLeadingSample: bool;
const OPT_TRANSMISSION = 0x80000000u;
const OPT_SOLID = 0x40000000u;
const OPT_TERMINAL = 0x20000000u;
const OPT_MISS = 0x10000000u;
const OPT_EXIT = 0x08000000u;
const OPT_INSTANCE_MASK = 0x07ffffffu;
const OPT_PARALLEL = 0x04000000u;
const OPT_TRANSMISSION_INSTANCE_MASK = 0x03ffffffu;
var<private> mtFrameIndex: u32;
var<private> mtFrameCaptured: bool;
var<private> mtGuidePath: AovDenoisingPathGuide;
var<private> mtGuideFirst: AovDenoisingGuide;
var<private> mtGuideHits: u32;
var<private> mtGuideUsable: bool;
var<private> mtGuidePrimaryReady: bool;

fn mtFrameBegin(index: u32) {
  mtFrameIndex = index;
  mtLeadingSample = outNormal[index].a == 0.0;
  mtFrameCaptured = !mtLeadingSample;
  mtReflectionPending = false;
  mtRefractionStage = 0u;
  if (mtLeadingSample) {
    mtFramePixels[index] = MtFramePixel();
    mtReflections[index] = MtReflection();
    mtFramePixels[index].normalRoughness.w = 1.0;
  }
  if (MT_DENOISING_GUIDE_MODEL != 0u) {
    mtGuidePath = AovDenoisingPathGuide(vec3f(1.0), vec3f(0.0), vec3f(0.0), 0.0);
    mtGuideHits = 0u;
    mtGuideUsable = true;
    mtGuidePrimaryReady = false;
  }
}
fn mtFrameGuideSurface(prepared: OpenPbrPreparedBsdf, si: ptr<function, SurfaceInteraction>, path: ptr<function, Path>) {
  if (MT_DENOISING_GUIDE_MODEL == 0u || !mtLeadingSample || SPECTRAL ||
      (mtFramePixels[mtFrameIndex].identity.w & 161u) != 129u) { return; }
  if (!mtGuideUsable || all(mtGuidePath.throughput <= vec3f(0.0)) ||
      (MT_DENOISING_GUIDE_MODEL == 1u && mtGuideHits != 0u)) { return; }
  if (!aovDenoisingPathSupports(prepared.material)) {
    mtGuideUsable = false;
    return;
  }
  // The opaque eye hit uses the same resolved material and shading frame
  // as the physical first-surface record. Reuse its reflectance integral.
  let surface = mtFramePixels[mtFrameIndex].identity.xy;
  let reuse = mtGuideHits == 0u && mtGuidePrimaryReady && (*path).fromEye &&
    all(surface == vec2u(u32((*si).instanceIndex), u32((*si).triangleIndex))) &&
    all(mtFramePixels[mtFrameIndex].positionDepth.xyz == (*si).position);
  var surfaceGuide = mtGuideFirst;
  if (!reuse) {
    surfaceGuide = aovDenoisingGuide(prepared, mtFrameReflectance(prepared));
  }
  if (mtGuideHits == 0u) { mtGuideFirst = surfaceGuide; }
  if (MT_DENOISING_GUIDE_MODEL == 2u) {
    var updated = mtGuidePath;
    let segmentLength = distance((*path).ray.o, (*si).position);
    aovFollowDenoisingPath(&updated, surfaceGuide, segmentLength);
    mtGuidePath = updated;
  }
  mtGuideHits++;
}
fn mtFrameFinish(radiance: vec3f) {
  if (mtLeadingSample) {
    if (MT_DENOISING_GUIDE_MODEL != 0u && mtGuideHits != 0u) {
      let follow = MT_DENOISING_GUIDE_MODEL == 2u && mtGuideUsable;
      let diffuse = select(mtGuideFirst.diffuse, mtGuidePath.diffuse, follow);
      let normal = select(mtGuideFirst.normalRoughness.xyz, mtGuidePath.normal, follow);
      mtFramePixels[mtFrameIndex].diffuseAlbedo = vec4f(diffuse, select(0.0, mtGuidePath.depth, follow));
      mtFramePixels[mtFrameIndex].specularAlbedo = vec4f(mtGuideFirst.specular, 0.0);
      mtFramePixels[mtFrameIndex].normalRoughness = vec4f(normal, mtGuideFirst.normalRoughness.w);
    }
    mtFramePixels[mtFrameIndex].noisyColor = vec4f(radiance, 1.0);
    mtFramePixels[mtFrameIndex].rngState = s0;
    mtFramePixels[mtFrameIndex].rngDimensions = vec4u(hashedCounter, samplingBounce, pixelSampleIndex, rtUniform.sequenceSeed);
  } else {
    let count = outNormal[mtFrameIndex].a;
    let previous = mtFramePixels[mtFrameIndex].noisyColor.rgb;
    mtFramePixels[mtFrameIndex].noisyColor = vec4f(previous + (radiance - previous) / count, 1.0);
  }
}
fn mtReflectionExit(normal: vec3f) {
  if (!mtLeadingSample || (mtFramePixels[mtFrameIndex].identity.w & 161u) != 129u ||
      (SPECTRAL && rtUniform.dispersionWavelengths > 1)) { return; }
  mtReflectionPending = true;
  mtReflections[mtFrameIndex].normalInstance = vec4u(bitcast<vec3u>(normal), OPT_INSTANCE_MASK);
}
fn mtRefractionEntry(thin: bool) {
  if (!mtLeadingSample) { return; }
  let primary = mtFramePixels[mtFrameIndex];
  if ((primary.identity.w & 161u) != 129u || primary.transmission.w <= 0.0 ||
      primary.barycentricsFace.z < 0.5) { return; }
  mtRefractionStage = select(1u, 3u, thin);
  let kind = OPT_TRANSMISSION | select(OPT_SOLID, OPT_EXIT, thin);
  mtReflections[mtFrameIndex].normalInstance = vec4u(
    bitcast<vec3u>(primary.positionDepth.xyz), kind | OPT_TRANSMISSION_INSTANCE_MASK);
}
fn mtRefractionContinue(transmitted: bool) {
  if (mtRefractionStage == 2u) {
    mtRefractionStage = select(0u, 3u, transmitted);
    if (transmitted) { mtReflections[mtFrameIndex].normalInstance.w |= OPT_EXIT; }
  }
}
fn mtRefractionHit(si: SurfaceInteraction, direction: vec3f) {
  let primary = mtFramePixels[mtFrameIndex];
  if (mtRefractionStage == 1u) {
    // Record the first exit from the same solid. Record whether the two
    // geometric normals are parallel for the separate slab approximation.
    mtRefractionStage = 0u;
    if (si.hit && bitcast<u32>(si.instanceIndex) == primary.identity.x &&
        dot(si.faceNormal, direction) > 0.0) {
      let parallel = dot(si.faceNormal, primary.geometricNormal.xyz) < -0.9999;
      mtReflections[mtFrameIndex].normalInstance = vec4u(
        bitcast<vec3u>(si.position),
        mtReflections[mtFrameIndex].normalInstance.w | select(0u, OPT_PARALLEL, parallel));
      mtRefractionStage = 2u;
    }
  } else if (mtRefractionStage == 3u) {
    mtRefractionStage = 0u;
    if (!si.hit) {
      mtReflections[mtFrameIndex].normalInstance.w |= OPT_MISS;
      return;
    }
    let exitPoint = bitcast<vec3f>(mtReflections[mtFrameIndex].normalInstance.xyz);
    let segmentLength = distance(primary.positionDepth.xyz, exitPoint) + distance(exitPoint, si.position);
    if (segmentLength > 0.0 && segmentLength < 3.402823e38) {
      mtReflections[mtFrameIndex].endpointDistance = vec4f(si.position, segmentLength);
      let tags = mtReflections[mtFrameIndex].normalInstance.w & ~OPT_TRANSMISSION_INSTANCE_MASK;
      mtReflections[mtFrameIndex].normalInstance.w =
        tags | OPT_TERMINAL | (bitcast<u32>(si.instanceIndex) & OPT_TRANSMISSION_INSTANCE_MASK);
    }
  }
}
fn mtReflectionHit(si: SurfaceInteraction, direction: vec3f) {
  mtRefractionHit(si, direction);
  if (!mtReflectionPending) { return; }
  mtReflectionPending = false;
  if (!si.hit) {
    mtReflections[mtFrameIndex].endpointDistance.w = -1.0;
    return;
  }
  let distanceFromSurface = distance(mtFramePixels[mtFrameIndex].positionDepth.xyz, si.position);
  if (distanceFromSurface > 0.0 && distanceFromSurface < 3.402823e38) {
    mtReflections[mtFrameIndex].endpointDistance = vec4f(si.position, distanceFromSurface);
    mtReflections[mtFrameIndex].normalInstance.w = bitcast<u32>(si.instanceIndex) & OPT_INSTANCE_MASK;
  }
}
fn mtFrameSurface(si: SurfaceInteraction, material: OpenPbrResolvedMaterial, ray: Ray) {
  if (mtFrameCaptured) { return; }
  mtFrameCaptured = true;
  if (!si.hit) { return; }
  var face = si.faceNormal;
  var normal = si.normal;
  var faceCosine = -dot(face, ray.d);
  var normalCosine = -dot(normal, ray.d);
  if (material.thinWalled & ((material.transmissionWeight > 0.0) | (material.subsurfaceWeight > 0.0))) {
    if (faceCosine < 0.0) { face = -face; faceCosine = -faceCosine; }
    if (normalCosine < 0.0) { normal = -normal; normalCosine = -normalCosine; }
  }
  let useFace = (faceCosine >= 0.0) & (normalCosine < 0.0);
  let selected = select(normal, face, useFace);
  let cosine = select(normalCosine, faceCosine, useFace);
  let oriented = select(-selected, selected, cosine >= 0.0);
  let eye = cameraUniform.viewInv[3].xyz;
  let forward = -normalize(cameraUniform.viewInv[2].xyz);
  let depth = dot(si.position - eye, forward);
  let outside = (cosine > 0.0) | material.thinWalled;
  let eta = openpbr_apply_specular_weight_to_ior(material.specularIor, material.specularWeight);
  var flags = 1u;
  var guideNormal = oriented;
  var guideRoughness = material.specularRoughness;
  let unsupportedAnisotropy = material.specularAnisotropy > 0.0 && material.transmissionWeight > 0.0;
  // Surface data can be inspected even when complete temporal/RR inputs have
  // not been validated. Do not silently reinterpret these material layers.
  if ((material.materialType != STANDARD) | (material.alpha < 1.0) |
      (${unsupportedCoatReflectanceWgsl}) | (${unsupportedFuzzReflectanceWgsl}) |
      unsupportedAnisotropy | (material.subsurfaceWeight > 0.0) |
      (dot(material.mediumScattering, material.mediumScattering) > 0.0) |
      (material.bevel > 0.0) | (material.thinFilmWeight > 0.0) |
      (material.transmissionDispersionScale > 0.0)) { flags |= 32u; }
  if ((flags & 32u) == 0u) {
    var resolved = material;
    // The same entering/exiting convention used by SampleMaterial. Do not
    // modify the production material or add draws to its random stream.
    resolved.inside = (cosine <= 0.0) & !material.thinWalled;
    resolved.relativeIor = select(material.specularIor, 1.0 / material.specularIor, cosine > 0.0);
${hasCoatNormals ? /* wgsl */ `    if (material.coatNormalEnabled) {
      let view = -ray.d;
      let geometricView = dot(si.faceNormal, view);
      resolved.geometricNormal = select(-si.faceNormal, si.faceNormal, geometricView >= 0.0);
      guideNormal = coat_frame_normal(si.normal, si.faceNormal, view);
      resolved.coatNormal = coat_frame_normal(si.coatNormal, si.faceNormal, view);
      resolved.inside = (geometricView <= 0.0) & !material.thinWalled;
      resolved.relativeIor = select(material.specularIor, 1.0/material.specularIor, (geometricView > 0.0) | material.thinWalled);
    }
` : ''}${hasAnisotropyDirections || hasCoatNormals ? /* wgsl */ `    resolved.directionTangent = si.directionTangent;
    resolved.directionBitangent = si.directionBitangent;
    resolved.geometryTangent = si.geometryTangent;
    resolved.geometryBitangent = si.geometryBitangent;
` : ''}    let prepared = openpbr_prepare(si.tangent, resolved, -ray.d, guideNormal);
    let reflectance = mtFrameReflectance(prepared);
    if (MT_DENOISING_GUIDE_MODEL != 0u && !SPECTRAL && aovDenoisingPathSupports(prepared.material)) {
      mtGuideFirst = aovDenoisingGuide(prepared, reflectance);
      mtGuidePrimaryReady = true;
    }
    mtFramePixels[mtFrameIndex].diffuseAlbedo = vec4f(reflectance.diffuse, 0.0);
    mtFramePixels[mtFrameIndex].specularAlbedo = vec4f(reflectance.specular + reflectance.coat, 0.0);
    if (material.specularAnisotropy > 0.0) {
      // The tracer keeps both GGX axes. RR's scalar perceptual roughness
      // is the square root of their geometric-mean alpha.
      guideRoughness = sqrt(sqrt(prepared.material.alphaX * prepared.material.alphaY));
    }
    if (material.coatWeight > 0.0) {
      let baseWeight = openpbr_luminance(reflectance.specular);
      let coatWeight = openpbr_luminance(reflectance.coat);
      let totalWeight = baseWeight + coatWeight;
      if (totalWeight > 1e-6) {
        guideRoughness = (baseWeight * guideRoughness + coatWeight * material.coatRoughness) / totalWeight;
      }
${hasCoatNormals ? /* wgsl */ `      if (material.coatNormalEnabled) {
        let baseEnergy = baseWeight + openpbr_luminance(reflectance.diffuse);
        let weightedNormal = guideNormal * baseEnergy + resolved.coatNormal * coatWeight;
        if (dot(weightedNormal, weightedNormal) > 1e-12) { guideNormal = normalize(weightedNormal); }
      }
` : ''}
    }
    flags |= 128u;
  }
  mtFramePixels[mtFrameIndex].normalRoughness = vec4f(guideNormal, guideRoughness);
  mtFramePixels[mtFrameIndex].positionDepth = vec4f(si.position, depth);
  // Keep the original geometric normal, not the face-forward shading normal.
  mtFramePixels[mtFrameIndex].geometricNormal = vec4f(si.faceNormal, 0.0);
  mtFramePixels[mtFrameIndex].baseColorMetalness = vec4f(material.baseColor, material.baseMetalness);
  mtFramePixels[mtFrameIndex].transmission = vec4f(material.transmissionColor, material.transmissionWeight);
  mtFramePixels[mtFrameIndex].roughnessIor = vec4f(material.specularRoughness, material.specularRoughness,
    select(eta, 1.0, outside), select(1.0, eta, outside));
  mtFramePixels[mtFrameIndex].absorption = vec4f(material.mediumExtinction, f32(material.mediumType));
  // Publication-local scene indices only. A stable cross-publication identity
  // map is required before these can establish rigid/deformation motion.
  mtFramePixels[mtFrameIndex].identity = vec4u(u32(si.instanceIndex), u32(si.triangleIndex), u32(material.thinWalled), flags);
  mtFramePixels[mtFrameIndex].barycentricsFace = vec4f(si.barycentrics, f32(dot(si.faceNormal, ray.d) < 0.0), f32(si.materialIndex));
}
`
  };
}
