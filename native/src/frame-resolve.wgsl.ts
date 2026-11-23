import {framePixelStruct} from './layout.js';
import optics from '../../src/renderer/wgsl/opticalReprojection.wgsl.js';
export default `${framePixelStruct('FramePixel')}
${optics}
@group(0) @binding(0) var<storage, read> pixels: array<FramePixel>;
@group(0) @binding(1) var color: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var normal: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var depth: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var validity: texture_storage_2d<r32uint, write>;
@group(0) @binding(5) var diffuse: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var specular: texture_storage_2d<rgba32float, write>;
@group(0) @binding(7) var motion: texture_storage_2d<rg32float, write>;
struct Correspondence {
    currentViewProjection: mat4x4f,
    previousViewProjection: mat4x4f,
    previousEye: vec4f, // world position; w is 1 for an orthographic camera
    previousForward: vec4f,
    previousJitter: vec4f,
    enabled: vec4u,
}
@group(0) @binding(8) var<uniform> correspondence: Correspondence;
@group(0) @binding(9) var<storage, read> previousPixels: array<FramePixel>;
@group(0) @binding(10) var<storage,read> stableMetadata: array<u32>;
@group(0) @binding(11) var<storage,read> previousIds: array<vec4u>;
@group(0) @binding(12) var<storage,read_write> stableIds: array<vec4u>;
struct ReflectionRecord {
  endpointDistance: vec4f,
  normalInstance: vec4u,
}
@group(0) @binding(13) var<storage, read> reflections: array<ReflectionRecord>;
@group(0) @binding(14) var reflectionGuide: texture_storage_2d<rgba32float, write>;
@group(0) @binding(15) var<storage, read> previousOptics: array<ReflectionRecord>;
@group(0) @binding(16) var<storage, read_write> transmissionGuide: array<vec4f>;

const OPT_TRANSMITTED_ENDPOINT = 0xa8000000u;
const OPT_SOLID_SLAB = 0x40000000u;
const OPT_PARALLEL = 0x04000000u;
const OPT_INSTANCE_INDEX = 0x03ffffffu;

fn stableMatrix(offset:u32)->mat4x4f {
  return mat4x4f(bitcast<vec4f>(vec4u(stableMetadata[offset],stableMetadata[offset+1u],stableMetadata[offset+2u],stableMetadata[offset+3u])),
    bitcast<vec4f>(vec4u(stableMetadata[offset+4u],stableMetadata[offset+5u],stableMetadata[offset+6u],stableMetadata[offset+7u])),
    bitcast<vec4f>(vec4u(stableMetadata[offset+8u],stableMetadata[offset+9u],stableMetadata[offset+10u],stableMetadata[offset+11u])),
    bitcast<vec4f>(vec4u(stableMetadata[offset+12u],stableMetadata[offset+13u],stableMetadata[offset+14u],stableMetadata[offset+15u])));
}
fn reprojectNormal(transform: mat4x4f, normal: vec3f) -> vec3f {
  let a = transform[0].xyz;
  let b = transform[1].xyz;
  let c = transform[2].xyz;
  return normalize(mat3x3f(cross(b,c), cross(c,a), cross(a,b)) * normal / dot(a, cross(b,c)));
}
fn stableIdentity(pixel:FramePixel)->vec4u {
  if(correspondence.enabled.y==0u || (pixel.identity.w&1u)==0u){return vec4u(0xffffffffu);}
  let o=52u+pixel.identity.x*24u;
  return vec4u(stableMetadata[o],stableMetadata[o+1u],stableMetadata[stableMetadata[16u]+u32(pixel.barycentricsFace.w)],stableMetadata[stableMetadata[17u]+pixel.identity.y]);
}
// Returns prev-current in unjittered input pixels. The lookup into the previous
// sampled image removes its jitter once; it never adds jitter to the motion.
fn cameraMotion(pixel: FramePixel, size: vec2u) -> vec3f {
    if (correspondence.enabled.x == 0u || (pixel.identity.w & 33u) != 1u) { return vec3f(0.0); }
    let position = vec4f(pixel.positionDepth.xyz, 1.0);
    let a = correspondence.currentViewProjection * position;
    var oldPosition=position;
    var oldNormal=pixel.geometricNormal.xyz;
    if(correspondence.enabled.y!=0u){
      let offset=52u+pixel.identity.x*24u;
      if(stableMetadata[offset+2u]==0u){return vec3f(0.0);}
      let transform=stableMatrix(offset+4u);oldPosition=transform*position;
      oldNormal=reprojectNormal(transform,oldNormal);
    }
    let b = correspondence.previousViewProjection * oldPosition;
    if (a.w <= 0.0 || b.w <= 0.0 || !all(abs(a) < vec4f(3.402823e38))
        || !all(abs(b) < vec4f(3.402823e38))) { return vec3f(0.0); }
    let current = a.xyz / a.w;
    let previous = b.xyz / b.w;
    if (abs(previous.z) > 1.0 || abs(current.z) > 1.0) { return vec3f(0.0); }
    let scale = vec2f(size);
    let currentPixel = vec2f(current.x * 0.5 + 0.5, 0.5 - current.y * 0.5) * scale;
    let previousPixel = vec2f(previous.x * 0.5 + 0.5, 0.5 - previous.y * 0.5) * scale;
    let lookup = previousPixel - correspondence.previousJitter.xy;
    if (any(lookup < vec2f(0.0)) || any(lookup >= scale)) { return vec3f(0.0); }
    let p = vec2u(floor(lookup));
    let sample = previousPixels[p.x + (size.y - 1u - p.y) * size.x];
    if ((sample.identity.w & 33u) != 1u) {return vec3f(0.0);}
    if(correspondence.enabled.y!=0u){
      if(any(previousIds[p.x+(size.y-1u-p.y)*size.x].xy!=stableIdentity(pixel).xy)){return vec3f(0.0);}
    }else if(any(sample.identity.xy!=pixel.identity.xy)){return vec3f(0.0);}
    if (dot(sample.geometricNormal.xyz, oldNormal) < 0.9) { return vec3f(0.0); }
    // The retained hit lies on the actual previous jittered ray. Intersect
    // that ray with the previous tangent plane and compare view depths at
    // the same sample location, including on steeply sloped surfaces.
    let ray = select(normalize(sample.positionDepth.xyz - correspondence.previousEye.xyz),
        correspondence.previousForward.xyz, correspondence.previousEye.w != 0.0);
    let incidence = dot(ray, oldNormal);
    if (!(abs(incidence) > 1e-6)) { return vec3f(0.0); }
    let distance = dot(oldPosition.xyz - sample.positionDepth.xyz, oldNormal) / incidence;
    let depthDelta = distance * dot(ray, correspondence.previousForward.xyz);
    let planeDepth = sample.positionDepth.w + depthDelta;
    if (!(planeDepth > 0.0 && abs(depthDelta) <= max(1e-4, planeDepth * 1e-3))) {
        return vec3f(0.0);
    }
    return vec3f(previousPixel - currentPixel, 1.0);
}
fn reflectionMotion(pixel: FramePixel, reflection: ReflectionRecord, size: vec2u) -> vec3f {
    if (correspondence.enabled.x == 0u || reflection.endpointDistance.w <= 0.0) { return vec3f(0.0); }
    let normal = bitcast<vec3f>(reflection.normalInstance.xyz);
    let point = pixel.positionDepth.xyz;
    let endpoint = reflection.endpointDistance.xyz;
    var previousPoint = point;
    var previousNormal = normal;
    var previousGeometricNormal = pixel.geometricNormal.xyz;
    var previousEndpoint = endpoint;
    if (correspondence.enabled.z == 0u) {
        if (correspondence.enabled.y == 0u || reflection.normalInstance.w == 0x07ffffffu) { return vec3f(0.0); }
        let surfaceOffset = 52u + pixel.identity.x * 24u;
        let endpointOffset = 52u + reflection.normalInstance.w * 24u;
        if (stableMetadata[surfaceOffset + 2u] == 0u || stableMetadata[endpointOffset + 2u] == 0u) { return vec3f(0.0); }
        let surfaceTransform = stableMatrix(surfaceOffset + 4u);
        previousPoint = (surfaceTransform * vec4f(point, 1.0)).xyz;
        previousNormal = reprojectNormal(surfaceTransform, normal);
        previousGeometricNormal = reprojectNormal(surfaceTransform, previousGeometricNormal);
        previousEndpoint = (stableMatrix(endpointOffset + 4u) * vec4f(endpoint, 1.0)).xyz;
    }
    let now = opticalReflectionImage(point, normal, endpoint);
    let old = opticalReflectionImage(previousPoint, previousNormal, previousEndpoint);
    let motion = opticalImageMotion(now, old, correspondence.currentViewProjection,
        correspondence.previousViewProjection, vec2f(size));
    if (motion.z == 0.0) { return vec3f(0.0); }
    let oldClip = correspondence.previousViewProjection * vec4f(old, 1.0);
    let oldNdc = oldClip.xy / oldClip.w;
    let lookup = (oldNdc * vec2f(0.5, -0.5) + vec2f(0.5)) * vec2f(size) - correspondence.previousJitter.xy;
    if (any(lookup < vec2f(0.0)) || any(lookup >= vec2f(size))) { return vec3f(0.0); }
    let p = vec2u(floor(lookup));
    let index = p.x + (size.y - 1u - p.y) * size.x;
    let previous = previousPixels[index];
    if ((previous.identity.w & 161u) != 129u ||
        dot(previous.geometricNormal.xyz, previousGeometricNormal) < 0.999 ||
        abs(dot(previous.positionDepth.xyz - previousPoint, previousGeometricNormal)) > 1e-3) {
        return vec3f(0.0);
    }
    if (correspondence.enabled.y != 0u) {
        if (any(previousIds[index].xyz != stableIdentity(pixel).xyz)) { return vec3f(0.0); }
    } else if (previous.identity.x != pixel.identity.x) { return vec3f(0.0); }
    return motion;
}
fn transmissionMotion(pixel: FramePixel, optical: ReflectionRecord, size: vec2u) -> vec3f {
    if (correspondence.enabled.x == 0u || correspondence.enabled.w == 0u ||
        (optical.normalInstance.w & OPT_TRANSMITTED_ENDPOINT) != OPT_TRANSMITTED_ENDPOINT ||
        pixel.roughnessIor.y > 0.06 ||
        (optical.normalInstance.w & (OPT_SOLID_SLAB | OPT_PARALLEL)) == OPT_SOLID_SLAB) {
        return vec3f(0.0);
    }
    let point = pixel.positionDepth.xyz;
    let normal = pixel.geometricNormal.xyz;
    if (dot(pixel.normalRoughness.xyz, normal) < 0.9999) { return vec3f(0.0); }
    let endpoint = optical.endpointDistance.xyz;
    let ior = pixel.roughnessIor.w / pixel.roughnessIor.z;
    let exit = bitcast<vec3f>(optical.normalInstance.xyz);
    let surfaceOffset = 52u + pixel.identity.x * 24u;
    let endpointInstance = optical.normalInstance.w & OPT_INSTANCE_INDEX;
    let endpointOffset = 52u + endpointInstance * 24u;
    var previousEndpoint = endpoint;
    var previousPoint = point;
    var previousNormal = normal;
    var previousExit = exit;
    if (correspondence.enabled.z == 0u) {
        if (correspondence.enabled.y == 0u || endpointInstance == OPT_INSTANCE_INDEX ||
            stableMetadata[surfaceOffset + 2u] == 0u || stableMetadata[endpointOffset + 2u] == 0u) {
            return vec3f(0.0);
        }
        let transform = stableMatrix(surfaceOffset + 4u);
        previousPoint = (transform * vec4f(point, 1.0)).xyz;
        previousNormal = reprojectNormal(transform, normal);
        previousExit = (transform * vec4f(exit, 1.0)).xyz;
        previousEndpoint = (stableMatrix(endpointOffset + 4u) * vec4f(endpoint, 1.0)).xyz;
    }
    let thickness = max(0.0, dot(previousPoint - previousExit, previousNormal));
    let oldEntrance = opticalSlabEntrance(previousPoint, previousNormal, thickness, ior,
        correspondence.previousEye.xyz, previousEndpoint);
    if (oldEntrance.w == 0.0) { return vec3f(0.0); }
    let motion = opticalImageMotion(point, oldEntrance.xyz, correspondence.currentViewProjection,
        correspondence.previousViewProjection, vec2f(size));
    if (motion.z == 0.0) { return vec3f(0.0); }
    let oldClip = correspondence.previousViewProjection * vec4f(oldEntrance.xyz, 1.0);
    let lookup = (oldClip.xy / oldClip.w * vec2f(0.5, -0.5) + vec2f(0.5)) *
        vec2f(size) - correspondence.previousJitter.xy;
    if (any(lookup < vec2f(0.0)) || any(lookup >= vec2f(size))) { return vec3f(0.0); }
    let p = vec2u(floor(lookup));
    let index = p.x + (size.y - 1u - p.y) * size.x;
    let previous = previousPixels[index];
    let previousOptical = previousOptics[index];
    let pathMask = OPT_TRANSMITTED_ENDPOINT | OPT_SOLID_SLAB | OPT_PARALLEL;
    if ((previousOptical.normalInstance.w & pathMask) != (optical.normalInstance.w & pathMask) ||
        previous.roughnessIor.y > 0.06 ||
        dot(previous.geometricNormal.xyz, previousNormal) < 0.9999 ||
        abs(dot(previous.positionDepth.xyz - previousPoint, previousNormal)) > 1e-4 ||
        abs(dot(previous.positionDepth.xyz - bitcast<vec3f>(previousOptical.normalInstance.xyz),
            previousNormal) - thickness) > 1e-4 ||
        abs(previous.roughnessIor.w / previous.roughnessIor.z - ior) > 1e-4) { return vec3f(0.0); }
    let previousTerminal = previousOptical.normalInstance.w & OPT_INSTANCE_INDEX;
    if (correspondence.enabled.y != 0u) {
        if (any(previousIds[index].xyz != stableIdentity(pixel).xyz) ||
            stableMetadata[endpointOffset + 2u] == 0u ||
            stableMetadata[endpointOffset + 3u] != previousTerminal) { return vec3f(0.0); }
    } else if (previous.identity.x != pixel.identity.x || endpointInstance != previousTerminal) {
        return vec3f(0.0);
    }
    return motion;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) p: vec3u) {
    let size = textureDimensions(color);
    if (any(p.xy >= size)) { return; }
    // The integrator stores bottom-row-first; all frame textures are top-row-first.
    let index = p.x + (size.y - 1u - p.y) * size.x;
    let pixel = pixels[index];
    stableIds[index]=stableIdentity(pixel);
    textureStore(color, vec2i(p.xy), pixel.noisyColor);
    textureStore(normal, vec2i(p.xy), pixel.normalRoughness);
    textureStore(depth, vec2i(p.xy), vec4f(pixel.positionDepth.w));
    let correspondenceMotion = cameraMotion(pixel, size);
    var flags = pixel.identity.w;
    if ((flags & 1u) != 0u) {
        flags |= select(64u, 2u, correspondenceMotion.z > 0.0);
    }
    textureStore(motion, vec2i(p.xy), vec4f(correspondenceMotion.xy, 0.0, 0.0));
    let reflection = reflections[index];
    var opticalGuide = vec4f(0.0);
    if ((reflection.normalInstance.w & 0x80000000u) == 0u) {
        let opticalMotion = reflectionMotion(pixel, reflection, size);
        if (reflection.endpointDistance.w > 0.0) { flags |= 4u; }
        if (reflection.endpointDistance.w < 0.0) { flags |= 8u; }
        if (opticalMotion.z > 0.0) { flags |= 256u; }
        opticalGuide = vec4f(opticalMotion, max(0.0, reflection.endpointDistance.w));
    }
    if (correspondence.enabled.w != 0u) {
        transmissionGuide[index] = vec4f(transmissionMotion(pixel, reflection, size), 0.0);
    }
    textureStore(reflectionGuide, vec2i(p.xy), opticalGuide);
    textureStore(validity, vec2i(p.xy), vec4u(flags));
    textureStore(diffuse, vec2i(p.xy), pixel.diffuseAlbedo);
    textureStore(specular, vec2i(p.xy), pixel.specularAlbedo);
}
`;
