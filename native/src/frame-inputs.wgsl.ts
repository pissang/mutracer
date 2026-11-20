import {framePixelStruct} from './layout.js';
import type {RayTraceInputHooks} from '../../src/renderer/wgsl/rayTrace.compute.js';
import {GROUP} from './layout.js';
import {unsupportedCoatReflectanceWgsl} from '../../src/renderer/wgsl/aovReflectance.wgsl.js';

// Internal diagnostic record. It contains resolved first-surface data rather
// than reusing OIDN's possibly downstream guides. BaseColor and directional
// reflectance are distinct fields; optical path branches remain separate.
export function nativeFrameInputHooks(hasCoatNormals: boolean): RayTraceInputHooks {
  return {
    uniformJitter: true,
    layeredReflectance: true,
    recordReflection: true,
    begin: '  mtFrameBegin(idx);\n',
    primarySurface: '  mtFrameSurface(si, ma, ray);\n',
    unclampedColor: '  if (mtLeadingSample) { mtFramePixels[mtFrameIndex].unclampedRadiance = vec4f(liAndAlpha.rgb, 1.0); }\n',
    end: '  mtFrameFinish(liAndAlpha.rgb);\n',
    declarations: /* wgsl */ `
${framePixelStruct('MtFramePixel')}
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
var<private> mtFrameIndex: u32;
var<private> mtFrameCaptured: bool;

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
}
fn mtFrameFinish(radiance: vec3f) {
  if (mtLeadingSample) {
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
      primary.barycentricsFace.z < 0.5 || primary.roughnessIor.y > 0.06) { return; }
  mtRefractionStage = select(1u, 3u, thin);
  let kind = OPT_TRANSMISSION | select(OPT_SOLID, OPT_EXIT, thin);
  mtReflections[mtFrameIndex].normalInstance = vec4u(
    bitcast<vec3u>(primary.positionDepth.xyz), kind | OPT_INSTANCE_MASK);
}
fn mtRefractionContinue(transmitted: bool) {
  if (mtRefractionStage == 2u) {
    mtRefractionStage = select(0u, 3u, transmitted);
    if (transmitted) { mtReflections[mtFrameIndex].normalInstance.w |= OPT_EXIT; }
  }
}
fn mtRefractionHit(si: SurfaceInteraction) {
  let primary = mtFramePixels[mtFrameIndex];
  if (mtRefractionStage == 1u) {
    // This compact record supports a closed slab with two parallel boundaries.
    // A second instance, a side wall or an internal reflection stays incomplete.
    mtRefractionStage = 0u;
    if (si.hit && bitcast<u32>(si.instanceIndex) == primary.identity.x &&
        dot(si.faceNormal, primary.geometricNormal.xyz) < -0.9999) {
      mtReflections[mtFrameIndex].normalInstance = vec4u(
        bitcast<vec3u>(si.position), mtReflections[mtFrameIndex].normalInstance.w);
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
      let tags = mtReflections[mtFrameIndex].normalInstance.w & ~OPT_INSTANCE_MASK;
      mtReflections[mtFrameIndex].normalInstance.w =
        tags | OPT_TERMINAL | (bitcast<u32>(si.instanceIndex) & OPT_INSTANCE_MASK);
    }
  }
}
fn mtReflectionHit(si: SurfaceInteraction) {
  mtRefractionHit(si);
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
  var guideRoughness = material.specularRoughness;
  // Surface data can be inspected even when complete temporal/RR inputs have
  // not been validated. Do not silently reinterpret these material layers.
  if ((material.materialType != STANDARD) | (material.alpha < 1.0) |
      (${unsupportedCoatReflectanceWgsl(hasCoatNormals)}) | (material.fuzzWeight > 0.0) |
      (material.specularAnisotropy > 0.0) | (material.subsurfaceWeight > 0.0) |
      (dot(material.mediumScattering, material.mediumScattering) > 0.0) |
      (material.bevel > 0.0) | (material.thinFilmWeight > 0.0) |
      (material.transmissionDispersionScale > 0.0)) { flags |= 32u; }
  if ((flags & 32u) == 0u) {
    var resolved = material;
    // The same entering/exiting convention used by SampleMaterial. Do not
    // modify the production material or add draws to its random stream.
    resolved.inside = (cosine <= 0.0) & !material.thinWalled;
    resolved.relativeIor = select(material.specularIor, 1.0 / material.specularIor, cosine > 0.0);
    let prepared = openpbr_prepare(si.tangent, resolved, -ray.d, oriented);
    let reflectance = mtFrameReflectance(prepared);
    mtFramePixels[mtFrameIndex].diffuseAlbedo = vec4f(reflectance.diffuse, 0.0);
    mtFramePixels[mtFrameIndex].specularAlbedo = vec4f(reflectance.specular + reflectance.coat, 0.0);
    if (material.coatWeight > 0.0) {
      let baseWeight = openpbr_luminance(reflectance.specular);
      let coatWeight = openpbr_luminance(reflectance.coat);
      let totalWeight = baseWeight + coatWeight;
      if (totalWeight > 1e-6) {
        guideRoughness = (baseWeight * guideRoughness + coatWeight * material.coatRoughness) / totalWeight;
      }
    }
    flags |= 128u;
  }
  mtFramePixels[mtFrameIndex].normalRoughness = vec4f(oriented, guideRoughness);
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
