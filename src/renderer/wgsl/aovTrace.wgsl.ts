import {materialCall, type MaterialShaderHooks} from './materialShaderHooks.js';
// These entry points use their own output bindings and never mutate beauty RNG
// state or accumulation. Storage usage remains four scene + three AOV buffers.
export function createAovTraceWgsl(materialHooks: MaterialShaderHooks = {}) { return /* wgsl */ `
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
      (material.coatWeight > 0.0) | (material.fuzzWeight > 0.0) |
      (material.specularAnisotropy > 0.0) | (material.subsurfaceWeight > 0.0) |
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
    let prepared=openpbr_prepare(si.tangent,material,-ray.d,normal);
    let reflectance=mtFrameReflectanceComponents(prepared, (aovParameters.w & 8u) != 0u, (aovParameters.w & 16u) != 0u);
    aovAccum[index].diffuse+=vec4f(reflectance.diffuse,1.0);
    aovAccum[index].specular+=vec4f(reflectance.specular,1.0);
  }
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
  aovCenter[index].motion.z = dot(si.position-aovVector(36u),aovVector(40u));
  if (aovScene[offset+2u] == 0u) { return; }
  let oldWorld = aovMatrix(offset+4u) * vec4f(si.position,1.0);
  let oldClip = aovMatrix(0u) * oldWorld;
  if (oldClip.w <= 0.0) { return; }
  let oldNdc=oldClip.xyz/oldClip.w;
  let oldPixel=(oldNdc.xy*0.5+0.5)*vec2f(size);
  if (any(oldPixel < vec2f(0.0)) || any(oldPixel >= vec2f(size)) || abs(oldNdc.z)>1.0) { return; }
  let previous=aovPrevious[u32(oldPixel.x)+u32(oldPixel.y)*size.x];
  let oldDepth=dot(oldWorld.xyz-aovVector(44u),aovVector(48u));
  if (any(previous.identity.xy != aovCenter[index].identity.xy) || abs(previous.motion.z-oldDepth)>max(1e-4,abs(oldDepth)*1e-3)) { return; }
  let motion=(oldPixel-(vec2f(id.xy)+0.5))*vec2f(1.0,-1.0);
  aovCenter[index].motion=vec4f(motion,aovCenter[index].motion.z,3.0);
}
`;
}
export default createAovTraceWgsl();
