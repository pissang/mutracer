import {GROUP, HWRT_BINDING} from './layout.js';
import {createSceneIntersectionsWgsl} from '../../src/renderer/wgsl/chunks/intersect.wgsl.js';
import type {WGPUShaderFeatures} from '../../src/renderer/wgpuShaderSource.js';
import {nativeIntersections} from './intersections.wgsl.js';

// An independent diagnostic PSO runs the actual integrator, recording every
// closest query whose guide is still open. This also covers alpha back rays
// and reset wavelength/front branches without modifying their random streams.
export function nativePathIntersections(features: WGPUShaderFeatures, empty: boolean, hardware: boolean, indexed = false, opaqueClosest = false): string {
  const intersections = hardware ? nativeIntersections(features, empty, false, true, indexed, opaqueClosest)
    : createSceneIntersectionsWgsl({...features,
      hasAnisotropyDirections: features.hasAnisotropyDirections || features.hasCoatNormals,
      closestHitHook: `  mtPathRecord(ray, (*si).albedoSampled, isHit, hitInsIdx, (*si).triangleIndex,
    select(RAY_MAX_DISTANCE, hitT, isHit), hitBarycentric, bounces, doubleSided, isRefractionRay, currentTriangleIndex);
`});
  return intersections + /* wgsl */ `
struct MtPathEvent { identity: vec4u, barycentric: vec4f, origin: vec4f, direction: vec4f, }
@group(${GROUP.SCENE}) @binding(${HWRT_BINDING.DIAGNOSTIC}) var<storage, read_write> mtPathEvents: array<MtPathEvent>;
@group(${GROUP.SCENE}) @binding(${HWRT_BINDING.PATH_PARAMETERS}) var<storage, read> mtPathParameters: vec4u;
var<private> mtPathBase: u32;
var<private> mtPathCount: u32;
fn mtPathBegin(coord: vec2u) {
  mtPathBase = (coord.x + (coord.y - mtPathParameters.x) * u32(rtUniform.outputSize.x)) * 129u;
  mtPathCount = 0u;
}
fn mtPathRecord(ray: Ray, guideSelected: bool, hit: bool, instance: i32, record: i32,
    t: f32, barycentric: vec3f, bounces: i32, doubleSided: bool, refraction: bool, skipRecord: i32) {
  if (guideSelected) { return; }
  let event = mtPathCount;
  mtPathCount++;
  if (event >= 128u) { return; }
  let flags = u32(max(0, bounces)) | select(0u, 256u, doubleSided) | select(0u, 512u, refraction);
  mtPathEvents[mtPathBase + 1u + event] = MtPathEvent(
    vec4u(u32(hit), bitcast<u32>(select(-1, instance, hit)), bitcast<u32>(select(-1, record, hit)), bitcast<u32>(select(RAY_MAX_DISTANCE, t, hit))),
    vec4f(barycentric, 0.0), vec4f(ray.o, bitcast<f32>(flags)), vec4f(ray.d, bitcast<f32>(skipRecord)));
}
fn mtPathEnd(normal: vec3f, albedo: vec3f) {
  mtPathEvents[mtPathBase] = MtPathEvent(vec4u(min(mtPathCount, 128u), u32(mtPathCount > 128u), mtPathParameters.z, pixelSampleIndex),
    vec4f(normal, 0.0), vec4f(albedo, 0.0), vec4f(0.0));
}
`;
}
