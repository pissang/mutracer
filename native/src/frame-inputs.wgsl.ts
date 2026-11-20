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
    unclampedColor: '  mtFramePixels[mtFrameIndex].unclampedRadiance = vec4f(liAndAlpha.rgb, 1.0);\n',
    end: '  mtFramePixels[mtFrameIndex].noisyColor = vec4f(liAndAlpha.rgb, 1.0);\n  mtFramePixels[mtFrameIndex].rngState = s0;\n  mtFramePixels[mtFrameIndex].rngDimensions = vec4u(hashedCounter, samplingBounce, pixelSampleIndex, rtUniform.sequenceSeed);\n',
    declarations: /* wgsl */ `
${framePixelStruct('MtFramePixel')}
@group(${GROUP.OUTPUT}) @binding(4) var<storage, read_write> mtFramePixels: array<MtFramePixel>;
struct MtReflection {
  endpointDistance: vec4f,
  normalInstance: vec4u,
}
@group(${GROUP.OUTPUT}) @binding(10) var<storage, read_write> mtReflections: array<MtReflection>;
var<private> mtReflectionPending: bool;
var<private> mtFrameIndex: u32;
var<private> mtFrameCaptured: bool;

fn mtFrameBegin(index: u32) {
  mtFrameIndex = index;
  mtFrameCaptured = false;
  mtFramePixels[index] = MtFramePixel();
  mtReflections[index] = MtReflection();
  mtReflectionPending = false;
  mtFramePixels[index].normalRoughness.w = 1.0;
}
fn mtReflectionExit(normal: vec3f) {
  if ((mtFramePixels[mtFrameIndex].identity.w & 161u) != 129u ||
      (SPECTRAL && rtUniform.dispersionWavelengths > 1)) { return; }
  mtReflectionPending = true;
  mtReflections[mtFrameIndex].normalInstance = vec4u(bitcast<vec3u>(normal), 0xffffffffu);
}
fn mtReflectionHit(si: SurfaceInteraction) {
  if (!mtReflectionPending) { return; }
  mtReflectionPending = false;
  if (!si.hit) {
    mtReflections[mtFrameIndex].endpointDistance.w = -1.0;
    return;
  }
  let distanceFromSurface = distance(mtFramePixels[mtFrameIndex].positionDepth.xyz, si.position);
  if (distanceFromSurface > 0.0 && distanceFromSurface < 3.402823e38) {
    mtReflections[mtFrameIndex].endpointDistance = vec4f(si.position, distanceFromSurface);
    mtReflections[mtFrameIndex].normalInstance.w = bitcast<u32>(si.instanceIndex);
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
