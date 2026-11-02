import {GROUP, HWRT_BINDING} from './layout.js';
import {createSceneHitQueryWgsl} from '../../src/renderer/wgsl/chunks/intersect.wgsl.js';
import type {WGPUShaderFeatures} from '../../src/renderer/wgpuShaderSource.js';

// Hardware hit metadata is authoritative. Production uses source primitive
// offsets; leaf-order regression diagnostics retain their indexed soup map.
// Both supply identity only, never a software hit test.
export function nativeIntersections(features: WGPUShaderFeatures, empty: boolean, diagnostic = false, pathDiagnostic = false, indexed = false, opaqueClosest = false): string {
  if (empty) return /* wgsl */ `
fn intersectScene(ray: Ray, si: ptr<function, SurfaceInteraction>, bounces: i32, doubleSided: bool, isRefractionRay: bool) { (*si).hit = false; }
fn intersectSceneShadow(ray: Ray, lightDistance: f32, currTriangleIndex: i32,currInstanceIndex:i32) -> bool { return false; }
fn intersectSceneBevel(ray: Ray, si: ptr<function, SurfaceInteraction>, instanceIndex: i32, maxDistance: f32) { (*si).hit = false; }
`;
  const vector = features.hasAnisotropyDirections || features.hasCoatNormals ? '.xyz' : '';
  return /* wgsl */ `
${diagnostic ? `var<private> mtWantedInstance: i32;
var<private> mtWantedRecord: i32;
var<private> mtWantedSeen: u32;
var<private> mtWantedConfirmed: u32;
var<private> mtWantedDot: f32;
var<private> mtCandidateCount: u32;` : ''}
@group(${GROUP.SCENE}) @binding(${HWRT_BINDING.ACCELERATION}) var mtAcceleration: acceleration_structure;
@group(${GROUP.SCENE}) @binding(${HWRT_BINDING.INDICES}) var<storage, read> mtTriangleRecords: array<u32>;
struct MtHit {
  kind: u32, t: f32, instance: i32, record: i32,
  barycentric: vec3f, normal: vec3f, micro: bool,
}
fn mtRecord(instance: i32, primitive: u32) -> i32 {
  return ${indexed ? 'bitcast<i32>(instancesBuffer[instance * 10].x) + i32(primitive)' : 'i32(mtTriangleRecords[mtTriangleRecords[instance] + primitive])'};
}
fn mtIndices(instance: i32, record: i32) -> vec3i {
  return ${indexed ? 'vec3i(i32(mtTriangleRecords[record * 3]), i32(mtTriangleRecords[record * 3 + 1]), i32(mtTriangleRecords[record * 3 + 2])) + vec3i(bitcast<i32>(instancesBuffer[instance * 10].y))' : 'bitcast<vec3i>(bvhBuffer[record].xyz) + vec3i(bitcast<i32>(instancesBuffer[instance * 10].y))'};
}
fn mtTriangle(index: vec3i) -> Triangle {
  return Triangle(attrBuffers[index.x * ATTR_STRIDE + POSITION_OFF].xyz,
    attrBuffers[index.y * ATTR_STRIDE + POSITION_OFF].xyz,
    attrBuffers[index.z * ATTR_STRIDE + POSITION_OFF].xyz);
}
fn mtWorldToLocal(instance: i32) -> mat4x4f {
  return mat4x4f(instancesBuffer[instance * 10 + 1], instancesBuffer[instance * 10 + 2],
    instancesBuffer[instance * 10 + 3], instancesBuffer[instance * 10 + 4]);
}
fn mtTrace(ray: Ray, limit: f32, shadow: bool, onlyInstance: i32, skipRecord: i32, skipInstance:i32,
    doubleSided: bool, isRefractionRay: bool) -> MtHit {
  var query: ray_query;
  // OPAQUE is enabled only for all-double-sided, non-alpha, non-PDM geometry.
  // A previous-record or instance restriction still requires every candidate.
  // Shadow retains its existing alpha-aware terminate-on-first-hit semantics.
  let flags = ${opaqueClosest ? 'select(select(0u, 2u, skipRecord >= 0 || onlyInstance >= 0), 4u, shadow)' : 'select(2u, 4u, shadow)'};
  let minimum = select(0.0, 1e-7, shadow);
  rayQueryInitialize(&query, mtAcceleration, RayDesc(flags, 255u, minimum, limit, ray.o, ray.d));
  var generated: MtHit;
  generated.t = limit;
  while rayQueryProceed(&query) {
    let candidate = rayQueryGetCandidateIntersection(&query);
    let instance = i32(candidate.instance_custom_data);
    if (onlyInstance >= 0 && instance != onlyInstance) { continue; }
    let record = mtRecord(instance, candidate.primitive_index);
${diagnostic ? `    mtCandidateCount++;
    if (instance == mtWantedInstance && record == mtWantedRecord) { mtWantedSeen++; }` : ''}
    if (!shadow && record == skipRecord && instance == skipInstance) { continue; }
    let index = mtIndices(instance, record);
    var tri = mtTriangle(index);
    let w2l = mtWorldToLocal(instance);
    let o = (w2l * vec4f(ray.o, 1.0)).xyz;
    let d = (w2l * vec4f(ray.d, 0.0)).xyz;
    var normal = normalize(cross(tri.p1 - tri.p0, tri.p2 - tri.p0));
    var barycentric = vec3f(1.0 - candidate.barycentrics.x - candidate.barycentrics.y, candidate.barycentrics);
    var t = candidate.t;
    var micro = false;
    let insData = instancesBuffer[instance * 10];
    let materialIndex = i32(unpackMaterialIndex(bitcast<i32>(insData.z)).x);
    if (candidate.kind == RAY_QUERY_INTERSECTION_AABB) {
${features.hasDisplacement ? /* wgsl */ `
      let matData = materialsBuffer[materialIndex];
      let n0 = normalize(attrBuffers[index.x * ATTR_STRIDE + NORMAL_OFF]${vector});
      let n1 = normalize(attrBuffers[index.y * ATTR_STRIDE + NORMAL_OFF]${vector});
      let n2 = normalize(attrBuffers[index.z * ATTR_STRIDE + NORMAL_OFF]${vector});
      tri.p0 += n0 * matData.displacementBias;
      tri.p1 += n1 * matData.displacementBias;
      tri.p2 += n2 * matData.displacementBias;
      normal = normalize(cross(tri.p1 - tri.p0, tri.p2 - tri.p0));
      let minMaxH = bitcast<i32>(bvhBuffer[record].w);
      if (abs(insData.w) > 0.0 && minMaxH > 0) {
        let map = i32(matData.displacementMapIndex);
        let hit = intersectDisplacement(o, d, generated.t, tri.p0, tri.p1, tri.p2,
          n0, n1, n2,
          attrBuffers[index.x * ATTR_STRIDE + UV_OFF].xy,
          attrBuffers[index.y * ATTR_STRIDE + UV_OFF].xy,
          attrBuffers[index.z * ATTR_STRIDE + UV_OFF].xy,
          map, getMapSize(map), f32(minMaxH >> 8) / 255.0, f32(minMaxH & 255) / 255.0,
          insData.w, matData.displacementBias, matData.displacementStepSize, i32(matData.displacementUvProjection),
          vec2f(matData.displacementUvProjectionScale), shadow, isRefractionRay);
        t = hit.t; barycentric = hit.barycentric; normal = hit.normal; micro = true;
      } else {
        // Zero-height triangles inside a procedural geometry still need a
        // surface test; ordinary triangle AS hits never enter this branch.
        let dimension = maxDimension(abs(d));
        let hit = intersectTriangle(o, d, tri, dimension, getShear(d, dimension), generated.t);
        t = hit.t; barycentric = hit.barycentric;
      }
` : ''}
      if (!(t > minimum && t < generated.t)) { continue; }
    }
${diagnostic ? `    if (instance == mtWantedInstance && record == mtWantedRecord) { mtWantedDot = dot(normal, d); }` : ''}
    if (!shadow && !micro && !doubleSided && materialsBuffer[materialIndex].doubleSided <= 0.5
        && dot(normal, d) > 0.0) { continue; }
    // Primary/path alpha remains in the shared integrator, exactly as software:
    // filtering it here as well would square stochastic BLEND coverage.
    if (shadow && HAS_ALPHA && !intersectionAlphaPasses(materialIndex, index, barycentric, o + t * d, normal)) { continue; }
${diagnostic ? `    if (instance == mtWantedInstance && record == mtWantedRecord) { mtWantedConfirmed++; }` : ''}
    // naga 30 requires the generated-distance expression to dominate the call.
    let generatedDistance = t;
    if (candidate.kind == RAY_QUERY_INTERSECTION_AABB) {
      generated = MtHit(2u, generatedDistance, instance, record, barycentric, normal, micro);
      rayQueryGenerateIntersection(&query, generatedDistance);
    } else { rayQueryConfirmIntersection(&query); }
  }
  let hit = rayQueryGetCommittedIntersection(&query);
  if (hit.kind == RAY_QUERY_INTERSECTION_GENERATED) { return generated; }
  var result: MtHit;
  if (hit.kind == RAY_QUERY_INTERSECTION_NONE) { return result; }
  result.kind = hit.kind; result.t = hit.t; result.instance = i32(hit.instance_custom_data);
  result.record = mtRecord(result.instance, hit.primitive_index);
  result.barycentric = vec3f(1.0 - hit.barycentrics.x - hit.barycentrics.y, hit.barycentrics);
  let tri = mtTriangle(mtIndices(result.instance, result.record));
  result.normal = normalize(cross(tri.p1 - tri.p0, tri.p2 - tri.p0));
  return result;
}
fn mtComplete(ray: Ray, si: ptr<function, SurfaceInteraction>, hit: MtHit) {
  (*si).hit = false;
  if (hit.kind == 0u) { return; }
  let w2l = mtWorldToLocal(hit.instance);
  let o = (w2l * vec4f(ray.o, 1.0)).xyz;
  let d = (w2l * vec4f(ray.d, 0.0)).xyz;
  let index = mtIndices(hit.instance, hit.record);
  (*si).triangleIndex = hit.record;
  completeSurfaceInteraction(si, mtTriangle(index), hit.barycentric, index, hit.micro,
    hit.instance, hit.normal, o + hit.t * d, -1);
}
fn intersectScene(ray: Ray, si: ptr<function, SurfaceInteraction>, bounces: i32, doubleSided: bool, isRefractionRay: bool) {
  let hit = mtTrace(ray, RAY_MAX_DISTANCE, false, -1, select(-1, (*si).triangleIndex, bounces > 0), (*si).instanceIndex, doubleSided, isRefractionRay);
${pathDiagnostic ? `  mtPathRecord(ray, (*si).albedoSampled, hit.kind != 0u, hit.instance, hit.record, hit.t, hit.barycentric, bounces, doubleSided, isRefractionRay, (*si).triangleIndex);` : ''}
  mtComplete(ray, si, hit);
}
fn intersectSceneShadow(ray: Ray, lightDistance: f32, currTriangleIndex: i32,currInstanceIndex:i32) -> bool {
  let limit = min(max(lightDistance, 0.0), RAY_MAX_DISTANCE);
  if (limit <= 1e-7) { return false; }
  return mtTrace(ray, limit, true, -1, -1, -1, true, false).kind != 0u;
}
fn intersectSceneBevel(ray: Ray, si: ptr<function, SurfaceInteraction>, instanceIndex: i32, maxDistance: f32) {
  mtComplete(ray, si, mtTrace(ray, maxDistance, false, instanceIndex, -1, -1, true, false));
}
`;
}

// A separate entry point is generated only for explicit diagnostic execution.
// Integer identity bits are read back raw, never passed through AOV averaging.
export function nativeHitDiagnostics(features: WGPUShaderFeatures, empty: boolean, backend: 'both' | 'software' | 'hardware' = 'both'): string {
  return createSceneHitQueryWgsl(features.hasAnisotropyDirections || features.hasCoatNormals) + /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn diagnoseHits(@builtin(global_invocation_id) id: vec3u) {
  let size = rtUniform.outputSize;
  if (id.x >= u32(size.x) || id.y >= u32(size.y)) { return; }
  let coord = id.xy;
  let idx = coord.x + coord.y * u32(size.x);
  let uv = (vec2f(coord) + vec2f(0.5)) / size;
  samplingPixel = coord; pixelSampleIndex = 0u; samplingBounce = 0u; hashedCounter = 0u;
  var jitter = rtUniform.jitter;
  if (SAMPLING_PATTERN == 0 || SAMPLING_PATTERN == 1) { jitter = (sample2D(CAMERA_PIXEL) - 0.5) / size; }
  rng_initialize(coord, i32(sampleHash(rtUniform.sequenceSeed)));
  var ray = initCameraRay(uv + jitter);
  if (cameraUniform.apertureRadius > 0.0) {
    let eye = cameraUniform.viewInv[3].xyz;
    let forward = -normalize(cameraUniform.viewInv[2].xyz);
    let focusPoint = eye + ray.d * (cameraUniform.focusDistance / dot(ray.d, forward));
    let lensPoint = cameraUniform.apertureRadius * sampleCircle(sample2D(CAMERA_LENS));
    let origin = (cameraUniform.viewInv * vec4f(lensPoint, 0.0, 1.0)).xyz;
    initRay(&ray, origin, normalize(focusPoint - origin));
  }
  let software = ${backend === 'hardware' ? 'SceneQueryHit(false, -1, -1, RAY_MAX_DISTANCE, vec3f(0.0))' : 'querySceneSoftware(ray)'};
  ${empty || backend === 'software' ? '' : 'mtWantedInstance = software.instance; mtWantedRecord = software.record;'}
  ${empty || backend === 'software' ? 'let hardware = software;' : `let hw = mtTrace(ray, RAY_MAX_DISTANCE, false, -1, -1, -1, false, false);
  let hardware = SceneQueryHit(hw.kind != 0u, select(-1, hw.instance, hw.kind != 0u),
    select(-1, hw.record, hw.kind != 0u), select(RAY_MAX_DISTANCE, hw.t, hw.kind != 0u), hw.barycentric);`}
  outColor[idx] = bitcast<vec4f>(vec4u(u32(software.hit), bitcast<u32>(software.instance), bitcast<u32>(software.record), bitcast<u32>(software.t)));
  outNormal[idx] = vec4f(software.barycentric, 0.0);
  outAlbedo[idx] = bitcast<vec4f>(vec4u(u32(hardware.hit), bitcast<u32>(hardware.instance), bitcast<u32>(hardware.record), bitcast<u32>(hardware.t)));
  outShadowCatcher[idx].mask = vec4f(hardware.barycentric, ray.d.x);
  outShadowCatcher[idx].background = vec4f(ray.o, ray.d.y);
  outShadowCatcher[idx].moments = ${empty || backend === 'software' ? 'vec4f(0.0)' : 'vec4f(ray.d.z, mtWantedDot, f32(mtWantedConfirmed), f32(mtCandidateCount))'};
}
`;
}
