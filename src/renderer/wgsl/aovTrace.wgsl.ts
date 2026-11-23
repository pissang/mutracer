import {materialCall, type MaterialShaderHooks} from './materialShaderHooks.js';
import {unsupportedCoatReflectanceWgsl, unsupportedFuzzReflectanceWgsl} from './aovReflectance.wgsl.js';
// These entry points use their own output bindings and never mutate beauty RNG
// state or accumulation. Storage usage remains four scene + three AOV buffers.
export function createAovTraceWgsl(materialHooks: MaterialShaderHooks = {}, hasCoatNormals?: boolean, displayMasks = false, hasAnisotropyDirections = false) {
  // The native AOT caller omits the web clearcoat capability until its
  // temporal producer and coverage policy have been validated.
  const unsupportedCoat = hasCoatNormals === undefined ? 'material.coatWeight > 0.0'
    : unsupportedCoatReflectanceWgsl;
  const unsupportedFuzz = hasCoatNormals === undefined ? 'material.fuzzWeight > 0.0'
    : unsupportedFuzzReflectanceWgsl;
  const unsupportedAnisotropy = hasCoatNormals === undefined ? 'material.specularAnisotropy > 0.0'
    : 'material.specularAnisotropy > 0.0 && (material.transmissionWeight > 0.0 || material.coatWeight > 0.0)';
  return /* wgsl */ `
override AOV_REFLECTANCE: bool = true;
override AOV_PRIMARY: bool = false;
struct AovAccumulation {
  depthRoughness: vec4f,
  position: vec4f,
  diffuse: vec4f,
  specular: vec4f,
}
struct AovCenter { identity: vec4u, motion: vec4f, }
@group(3) @binding(5) var<storage, read_write> aovAccum: array<AovAccumulation>;
@group(3) @binding(6) var<storage, read_write> aovCenter: array<AovCenter>;
@group(3) @binding(7) var<storage, read> aovScene: array<u32>;
@group(3) @binding(9) var<storage, read> aovPrevious: array<AovCenter>;
@group(3) @binding(8) var<uniform> aovParameters: vec4u;

fn aovMatrix(offset: u32) -> mat4x4f {
  return mat4x4f(bitcast<vec4f>(vec4u(aovScene[offset], aovScene[offset+1u], aovScene[offset+2u], aovScene[offset+3u])),
    bitcast<vec4f>(vec4u(aovScene[offset+4u], aovScene[offset+5u], aovScene[offset+6u], aovScene[offset+7u])),
    bitcast<vec4f>(vec4u(aovScene[offset+8u], aovScene[offset+9u], aovScene[offset+10u], aovScene[offset+11u])),
    bitcast<vec4f>(vec4u(aovScene[offset+12u], aovScene[offset+13u], aovScene[offset+14u], aovScene[offset+15u])));
}
fn aovVector(offset:u32)->vec3f {return bitcast<vec3f>(vec3u(aovScene[offset],aovScene[offset+1u],aovScene[offset+2u]));}
fn aovSnapshotVertex(offset:u32, vertex:u32)->vec3f {
  let word=offset+vertex*3u;
  return bitcast<vec3f>(vec3u(aovScene[word],aovScene[word+1u],aovScene[word+2u]));
}
// Previous-frame pixel, 1/w and view depth/w of a current world point. Both
// reciprocal terms are affine in screen space for any projective camera.
fn aovPreviousProjection(world: vec3f, transform: mat4x4f, size: vec2f) -> vec4f {
  let oldWorld = transform * vec4f(world, 1.0);
  let clip = aovMatrix(0u) * oldWorld;
  let w = 1.0 / clip.w;
  return vec4f((clip.xy * w * 0.5 + 0.5) * size, w, dot(oldWorld.xyz - aovVector(44u), aovVector(48u)) * w);
}
// View depth of the current surface's tangent plane at the previous pixel
// centre. Comparing it with the depth traced there stays exact on grazing
// planes, where half a pixel of depth slope exceeds any fixed relative
// tolerance. Returns a negative value for edge-on planes.
fn aovPlaneDepthAtPreviousCenter(world: vec3f, normal: vec3f, transform: mat4x4f, size: vec2f, scale: f32, origin: vec4f) -> f32 {
  let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.9);
  let t1 = normalize(cross(normal, helper));
  let t2 = cross(normal, t1);
  let a = aovPreviousProjection(world + t1 * scale, transform, size) - origin;
  let b = aovPreviousProjection(world + t2 * scale, transform, size) - origin;
  let det = a.x * b.y - a.y * b.x;
  if (abs(det) < 1e-6) { return -1.0; }
  let d = floor(origin.xy) + 0.5 - origin.xy;
  let s = (d.x * b.y - d.y * b.x) / det;
  let t = (a.x * d.y - a.y * d.x) / det;
  let reciprocal = origin.zw + s * a.zw + t * b.zw;
  if (reciprocal.x <= 0.0) { return -1.0; }
  return reciprocal.y / reciprocal.x;
}
fn aovSurface(rayInput: Ray, si: ptr<function, SurfaceInteraction>, material: ptr<function, OpenPbrResolvedMaterial>) -> bool {
  var ray = rayInput;
  (*si).triangleIndex = -1;
  for (var layer = 0; layer < 32; layer++) {
    intersectScene(ray, si, 0, false, false);
    if (!(*si).hit) { return false; }
    ${materialCall('material', '(*si)', materialHooks)}
    if ((*material).materialType != SHADOW_CATCHER && (*material).alpha >= 0.5) { return true; }
    ray.o = (*si).position + ray.d * (EPS * 0.02);
  }
  return false;
}
@compute @workgroup_size(8, 8)
fn aovTrace(@builtin(global_invocation_id) id: vec3u) {
  let size = aovParameters.xy;
  if (any(id.xy >= size)) { return; }
  let index = id.x + id.y * size.x;
  let sample = aovParameters.z;
  if (sample == 0u) { aovAccum[index] = AovAccumulation(); }
  samplingPixel = id.xy; pixelSampleIndex = sample + rtUniform.sampleSequenceOffset;
  samplingBounce = 0u; hashedCounter = 0u;
  rng_initialize(id.xy, i32(pixelSampleIndex ^ sampleHash(rtUniform.sequenceSeed)));
  let uv = (vec2f(id.xy) + sample2D(CAMERA_PIXEL)) / vec2f(size);
  var ray = initCameraRay(uv);
  if (cameraUniform.apertureRadius > 0.0) {
    let eye = cameraUniform.viewInv[3].xyz;
    let forward = -normalize(cameraUniform.viewInv[2].xyz);
    let focusPoint = eye + ray.d * (cameraUniform.focusDistance / dot(ray.d, forward));
    let lens = cameraUniform.apertureRadius * sampleCircle(sample2D(CAMERA_LENS));
    let origin = (cameraUniform.viewInv * vec4f(lens, 0.0, 1.0)).xyz;
    initRay(&ray, origin, normalize(focusPoint-origin));
  }
  var si: SurfaceInteraction; var material: OpenPbrResolvedMaterial;
  if (!aovSurface(ray, &si, &material)) { return; }
  let depth = max(dot(si.position-cameraUniform.viewInv[3].xyz, -normalize(cameraUniform.viewInv[2].xyz)), 0.0);
  let unsupported = (material.materialType != STANDARD) | (material.alpha < 1.0) |
      (${unsupportedCoat}) | (${unsupportedFuzz}) |
      (${unsupportedAnisotropy}) | (material.subsurfaceWeight > 0.0) |
      (dot(material.mediumScattering, material.mediumScattering) > 0.0) |
      (material.bevel > 0.0) | (material.thinFilmWeight > 0.0) |
      (material.transmissionDispersionScale > 0.0);
  aovAccum[index].depthRoughness += vec4f(depth, material.specularRoughness, material.baseMetalness, select(0.0,1.0,unsupported));
  if (AOV_REFLECTANCE && (aovParameters.w & 24u) != 0u && !unsupported) {
    var normal=si.normal; var face=si.faceNormal;
    var cosine=-dot(normal,ray.d); var faceCosine=-dot(face,ray.d);
    if (material.thinWalled && (material.transmissionWeight>0.0 || material.subsurfaceWeight>0.0)) {
      if(cosine<0.0){normal=-normal;cosine=-cosine;}
      if(faceCosine<0.0){face=-face;faceCosine=-faceCosine;}
    }
    if(faceCosine>=0.0 && cosine<0.0){normal=face;cosine=faceCosine;}
    normal=select(-normal,normal,cosine>=0.0);
    material.inside=(cosine<=0.0) && !material.thinWalled;
    material.relativeIor=select(material.specularIor,1.0/material.specularIor,cosine>0.0);
${hasCoatNormals ? /* wgsl */ `    if (material.coatNormalEnabled) {
      let view = -ray.d;
      let geometricView = dot(si.faceNormal, view);
      material.geometricNormal = select(-si.faceNormal, si.faceNormal, geometricView >= 0.0);
      normal = coat_frame_normal(si.normal, si.faceNormal, view);
      material.coatNormal = coat_frame_normal(si.coatNormal, si.faceNormal, view);
      material.inside = (geometricView <= 0.0) && !material.thinWalled;
      material.relativeIor = select(material.specularIor, 1.0/material.specularIor, (geometricView > 0.0) || material.thinWalled);
    }
` : ''}${hasAnisotropyDirections ? /* wgsl */ `    material.directionTangent = si.directionTangent;
    material.directionBitangent = si.directionBitangent;
    material.geometryTangent = si.geometryTangent;
    material.geometryBitangent = si.geometryBitangent;
` : ''}    let prepared=openpbr_prepare(si.tangent,material,-ray.d,normal);
    let reflectance=mtFrameReflectanceComponents(prepared, (aovParameters.w & 8u) != 0u, (aovParameters.w & 16u) != 0u);
${hasCoatNormals === undefined && !displayMasks ? /* wgsl */ `    aovAccum[index].diffuse+=vec4f(reflectance.diffuse,1.0);
    aovAccum[index].specular+=vec4f(reflectance.specular,1.0);
` : /* wgsl */ `    if ((aovParameters.w & 8u) != 0u) { aovAccum[index].diffuse+=vec4f(reflectance.diffuse,1.0); }
    if ((aovParameters.w & 16u) != 0u) { aovAccum[index].specular+=vec4f(reflectance.specular${hasCoatNormals === undefined ? '' : ' + reflectance.coat'},1.0); }
`}  }
  aovAccum[index].position += vec4f(si.position, 1.0);
}
@compute @workgroup_size(8, 8)
fn aovTraceCenter(@builtin(global_invocation_id) id: vec3u) {
  let size = aovParameters.xy;
  if (any(id.xy >= size)) { return; }
  let index = id.x + id.y * size.x;
  aovCenter[index] = AovCenter(vec4u(0xffffffffu), vec4f(0.0));
  // Optional tail shares the binding without changing identity/history layout.
  let primaryIndex = index + size.x * size.y;
  if (AOV_PRIMARY) { aovCenter[primaryIndex] = AovCenter(vec4u(0u), vec4f(0.0)); }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let ray = initCameraRay(uv);
  var si: SurfaceInteraction; var material: OpenPbrResolvedMaterial;
  if (!aovSurface(ray, &si, &material)) { return; }
  if (AOV_PRIMARY) {
    let depth = max(dot(si.position-cameraUniform.viewInv[3].xyz, -normalize(cameraUniform.viewInv[2].xyz)), 0.0);
    aovCenter[primaryIndex] = AovCenter(bitcast<vec4u>(vec4f(si.normal, depth)), vec4f(si.position, 1.0));
  }
  let offset = 52u + u32(si.instanceIndex) * 24u;
  let materialOffset = aovScene[16u];
  let primitiveOffset = aovScene[17u];
  aovCenter[index].identity = vec4u(aovScene[offset], aovScene[offset+1u],
    aovScene[materialOffset + u32(si.materialIndex)], aovScene[primitiveOffset + u32(si.triangleIndex)]);
  // Keep current depth in z for next-frame visibility; w carries previous depth when valid.
  aovCenter[index].motion.z = dot(si.position-aovVector(36u),aovVector(40u));
  if (aovScene[offset+2u] == 0u) { return; }
  var transform = aovMatrix(offset+4u); var projectionTransform=transform;
  var oldWorld=transform*vec4f(si.position,1.0); var projectionPoint=si.position; var oldFace=si.faceNormal;
  if (aovScene[offset+3u] != 0u) {
    let record=bvhBuffer[u32(si.triangleIndex)];
    let indices=bitcast<vec3u>(record.xyz);
    let p0=aovSnapshotVertex(aovScene[offset+3u],indices.x);
    let p1=aovSnapshotVertex(aovScene[offset+3u],indices.y);
    let p2=aovSnapshotVertex(aovScene[offset+3u],indices.z);
    let bary=vec3f(si.barycentrics,1.0-si.barycentrics.x-si.barycentrics.y);
    let oldP0=(transform*vec4f(p0,1.0)).xyz; let oldP1=(transform*vec4f(p1,1.0)).xyz; let oldP2=(transform*vec4f(p2,1.0)).xyz;
    oldWorld=vec4f(oldP0*bary.x+oldP1*bary.y+oldP2*bary.z,1.0);
    projectionPoint=oldWorld.xyz;
    oldFace=normalize(cross(oldP1-oldP0,oldP2-oldP0));
    projectionTransform=mat4x4f(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0),vec4f(0,0,0,1));
  }
  let oldClip = aovMatrix(0u) * oldWorld;
  if (oldClip.w <= 0.0) { return; }
  let oldNdc=oldClip.xyz/oldClip.w;
  let oldPixel=(oldNdc.xy*0.5+0.5)*vec2f(size);
  if (any(oldPixel < vec2f(0.0)) || any(oldPixel >= vec2f(size)) || abs(oldNdc.z)>1.0) { return; }
  let previous=aovPrevious[u32(oldPixel.x)+u32(oldPixel.y)*size.x];
  if (any(previous.identity.xy != aovCenter[index].identity.xy)) { return; }
  let origin = aovPreviousProjection(projectionPoint, projectionTransform, vec2f(size));
  let planeDepth = aovPlaneDepthAtPreviousCenter(projectionPoint, oldFace, projectionTransform, vec2f(size),
    max(aovCenter[index].motion.z, 1e-3) * 1e-2, origin);
  if (planeDepth <= 0.0 || abs(previous.motion.z-planeDepth)>max(1e-4,planeDepth*1e-3)) { return; }
  let motion=(oldPixel-(vec2f(id.xy)+0.5))*vec2f(1.0,-1.0);
  let previousDepth = dot(oldWorld.xyz-aovVector(44u),aovVector(48u));
  aovCenter[index].motion=vec4f(motion,aovCenter[index].motion.z,previousDepth);
}
`;
}
export default createAovTraceWgsl();
