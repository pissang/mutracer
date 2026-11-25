import {GROUP, HWRT_BINDING} from './layout.js';
import {cameraJitterWgsl} from '../../src/renderer/wgsl/chunks/sampling.wgsl.js';
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
  return Triangle(vertexPosition(index.x),
    vertexPosition(index.y),
    vertexPosition(index.z));
}
fn mtWorldToLocal(instance: i32) -> mat4x4f {
  return mat4x4f(instancesBuffer[instance * 10 + 1], instancesBuffer[instance * 10 + 2],
    instancesBuffer[instance * 10 + 3], instancesBuffer[instance * 10 + 4]);
}
fn mtTrace(ray: Ray, limit: f32, shadow: bool, onlyInstance: i32, skipRecord: i32, skipInstance:i32,
    doubleSided: bool, isRefractionRay: bool, previousHit: MtHit, queryHash: u32) -> MtHit {
  var best = previousHit;
  let resolveTie = best.kind != RAY_QUERY_INTERSECTION_NONE;
  var bestCatcher = false;
  var minimum = 0.0;
  var maximum = limit;
  if (resolveTie) {
    let tolerance = rayRoundoff(ray.o, best.t);
    minimum = max(0.0, best.t - tolerance);
    maximum = min(limit, best.t + tolerance);
    if (HAS_SHADOW_CATCHER) {
      let insData = instancesBuffer[best.instance * 10];
      let material = mtSurfaceMaterial(i32(unpackMaterialIndex(bitcast<i32>(insData.z)).x),
        mtIndices(best.instance, best.record), best.barycentric, best.record);
      bestCatcher = materialsBuffer[material].matType == f32(SHADOW_CATCHER);
    }
  }
  var query: ray_query;
  // The first pass can use the ordinary opaque fast path. The bounded
  // second pass exposes all candidates without shrinking its interval.
  let flags = ${opaqueClosest ? 'select(select(0u, 2u, resolveTie || skipRecord >= 0 || onlyInstance >= 0), 6u, shadow)' : 'select(2u, 6u, shadow)'};
  rayQueryInitialize(&query, mtAcceleration, RayDesc(flags, 255u, minimum, maximum, ray.o, ray.d));
  var generated: MtHit;
  generated.t = maximum;
  while rayQueryProceed(&query) {
    let candidate = rayQueryGetCandidateIntersection(&query);
    let instance = i32(candidate.instance_custom_data);
    if (onlyInstance >= 0 && instance != onlyInstance) { continue; }
    let record = mtRecord(instance, candidate.primitive_index);
${diagnostic ? `    mtCandidateCount++;
    if (instance == mtWantedInstance && record == mtWantedRecord) { mtWantedSeen++; }` : ''}
    if (record == skipRecord && instance == skipInstance) { continue; }
    if (resolveTie && record == best.record && instance == best.instance) { continue; }
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
      let n0 = normalize(vertexNormal(index.x));
      let n1 = normalize(vertexNormal(index.y));
      let n2 = normalize(vertexNormal(index.z));
      tri.p0 += n0 * matData.displacementBias;
      tri.p1 += n1 * matData.displacementBias;
      tri.p2 += n2 * matData.displacementBias;
      normal = normalize(cross(tri.p1 - tri.p0, tri.p2 - tri.p0));
      let minMaxH = bitcast<i32>(bvhBuffer[record].w);
      if (abs(insData.w) > 0.0 && minMaxH > 0) {
        let map = i32(matData.displacementMapIndex);
        // The bounded query may visit procedural candidates in another
        // order. Key marching jitter by primitive so it repeats that hit.
        let savedHash = hashedCounter;
        let primitiveHash = sampleSeed(sampleSeed(queryHash, u32(instance)), u32(record));
        hashedCounter = primitiveHash;
        let hit = intersectDisplacement(o, d, generated.t, tri.p0, tri.p1, tri.p2,
          n0, n1, n2,
          vertexUv(index.x),
          vertexUv(index.y),
          vertexUv(index.z),
          map, getMapSize(map), f32(minMaxH >> 8) / 255.0, f32(minMaxH & 255) / 255.0,
          insData.w, matData.displacementBias, matData.displacementStepSize, i32(matData.displacementUvProjection),
          vec2f(matData.displacementUvProjectionScale), shadow, isRefractionRay);
        let sampled = hashedCounter != primitiveHash;
        hashedCounter = savedHash + u32(sampled && !resolveTie);
        t = hit.t; barycentric = hit.barycentric; normal = hit.normal; micro = true;
      } else {
        // Zero-height triangles inside a procedural geometry still need a
        // surface test; ordinary triangle AS hits never enter this branch.
        let dimension = maxDimension(abs(d));
        let hit = intersectTriangle(o, d, tri, dimension, getShear(d, dimension), generated.t);
        t = hit.t; barycentric = hit.barycentric;
      }
` : ''}
    }
    if (!(t > 0.0 && t >= minimum && t <= maximum)) { continue; }
${diagnostic ? `    if (instance == mtWantedInstance && record == mtWantedRecord) { mtWantedDot = dot(normal, d); }` : ''}
    if (!shadow && !micro && !doubleSided && materialsBuffer[materialIndex].doubleSided <= 0.5
        && dot(normal, d) > 0.0) { continue; }
    // Primary/path alpha remains in the shared integrator, exactly as software:
    // filtering it here as well would square stochastic BLEND coverage.
    if (shadow && HAS_ALPHA && !intersectionAlphaPasses(materialIndex, index, barycentric, o + t * d, normal${features.compactVertices ? ", record" : ""}${features.materialHooks?.graph?.opacity ? ", instance" : ""})) { continue; }
${diagnostic ? `    if (instance == mtWantedInstance && record == mtWantedRecord) { mtWantedConfirmed++; }` : ''}
    if (resolveTie) {
      var catcher = false;
      if (HAS_SHADOW_CATCHER) {
        let material = mtSurfaceMaterial(materialIndex, index, barycentric, record);
        catcher = materialsBuffer[material].matType == f32(SHADOW_CATCHER);
      }
      if (closestHitPreferred(catcher, instance, record, bestCatcher, best.instance, best.record)) {
        best = MtHit(candidate.kind, t, instance, record, barycentric, normal, micro);
        bestCatcher = catcher;
      }
      continue;
    }
    // naga 30 requires the generated-distance expression to dominate the call.
    let generatedDistance = t;
    if (candidate.kind == RAY_QUERY_INTERSECTION_AABB) {
      generated = MtHit(2u, generatedDistance, instance, record, barycentric, normal, micro);
      rayQueryGenerateIntersection(&query, generatedDistance);
    } else { rayQueryConfirmIntersection(&query); }
  }
  let hit = rayQueryGetCommittedIntersection(&query);
  if (resolveTie || hit.kind == RAY_QUERY_INTERSECTION_NONE) { return best; }
  if (hit.kind == RAY_QUERY_INTERSECTION_GENERATED) { return generated; }
  let instance = i32(hit.instance_custom_data);
  let record = mtRecord(instance, hit.primitive_index);
  let tri = mtTriangle(mtIndices(instance, record));
  let barycentric = vec3f(1.0 - hit.barycentrics.x - hit.barycentrics.y, hit.barycentrics);
  let normal = normalize(cross(tri.p1 - tri.p0, tri.p2 - tri.p0));
  return MtHit(hit.kind, hit.t, instance, record, barycentric, normal, false);
}

fn mtClosest(ray: Ray, limit: f32, onlyInstance: i32, skipRecord: i32, skipInstance: i32,
    doubleSided: bool, isRefractionRay: bool) -> MtHit {
  let queryHash = hashedCounter;
  var miss: MtHit;
  let nearest = mtTrace(ray, limit, false, onlyInstance, skipRecord, skipInstance, doubleSided, isRefractionRay, miss, queryHash);
  if (nearest.kind == RAY_QUERY_INTERSECTION_NONE) { return nearest; }
  return mtTrace(ray, limit, false, onlyInstance, skipRecord, skipInstance, doubleSided, isRefractionRay, nearest, queryHash);
}
fn mtSurfaceMaterial(fallback: i32, index: vec3i, barycentric: vec3f, record: i32) -> i32 {
  let savedHash = hashedCounter;
  let material = resolveSurfaceMaterialIndex(fallback, index, barycentric${features.compactVertices ? ', record' : ''});
  hashedCounter = savedHash;
  return material;
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
  let hit = mtClosest(ray, RAY_MAX_DISTANCE, -1, (*si).triangleIndex, (*si).instanceIndex, doubleSided, isRefractionRay);
${pathDiagnostic ? `  mtPathRecord(ray, (*si).albedoSampled, hit.kind != 0u, hit.instance, hit.record, hit.t, hit.barycentric, bounces, doubleSided, isRefractionRay, (*si).triangleIndex);` : ''}
  mtComplete(ray, si, hit);
}
fn intersectSceneShadow(ray: Ray, lightDistance: f32, currTriangleIndex: i32,currInstanceIndex:i32) -> bool {
  let limit = min(max(lightDistance, 0.0), RAY_MAX_DISTANCE);
  if (limit <= 0.0) { return false; }
  var miss: MtHit;
  return mtTrace(ray, limit, true, -1, currTriangleIndex, currInstanceIndex, true, false, miss, hashedCounter).kind != 0u;
}
fn intersectSceneBevel(ray: Ray, si: ptr<function, SurfaceInteraction>, instanceIndex: i32, maxDistance: f32) {
  mtComplete(ray, si, mtClosest(ray, maxDistance, instanceIndex, -1, -1, true, false));
}
`;
}

// A separate entry point is generated only for explicit diagnostic execution.
// Integer identity bits are read back raw, never passed through AOV averaging.
export function nativeHitDiagnostics(features: WGPUShaderFeatures, empty: boolean, backend: 'both' | 'software' | 'hardware' = 'both'): string {
  return createSceneHitQueryWgsl(features.hasAnisotropyDirections || features.hasCoatNormals, features.compactVertices) + /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn diagnoseHits(@builtin(global_invocation_id) id: vec3u) {
  let size = rtUniform.outputSize;
  if (id.x >= u32(size.x) || id.y >= u32(size.y)) { return; }
  let coord = id.xy;
  let idx = coord.x + coord.y * u32(size.x);
  let uv = (vec2f(coord) + vec2f(0.5)) / size;
  samplingPixel = coord; pixelSampleIndex = 0u; samplingBounce = 0u; hashedCounter = 0u;
  var jitter = rtUniform.jitter;
${cameraJitterWgsl('size', !!features.sampleIndexedRandomJitter)}
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
  ${empty || backend === 'software' ? 'let hardware = software;' : `let hw = mtClosest(ray, RAY_MAX_DISTANCE, -1, -1, -1, false, false);
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
