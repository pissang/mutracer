import {temporalFlagsWGSL, temporalMaterialFormat, temporalMaterialWGSL, temporalOverflowWGSL} from './temporalKernels.js';
export const captureWGSL = /* wgsl */ `
struct Params { size: vec2u, slot: u32, centerRecords: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> depth: array<vec4f>;
@group(0) @binding(2) var<storage, read> normal: array<vec4f>;
@group(0) @binding(3) var<storage, read> roughness: array<vec4f>;
@group(0) @binding(4) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(5) var<storage, read> color: array<vec4f>;
@group(0) @binding(6) var<storage, read> motion: array<vec4f>;
@group(0) @binding(7) var surfaceOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(8) var hdrOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(9) var motionOut: texture_storage_2d_array<rgba32float, write>;
${temporalOverflowWGSL}
@group(0) @binding(10) var<storage, read_write> overflow: array<Overflow>;
@group(0) @binding(11) var materialOut: texture_storage_2d_array<${temporalMaterialFormat}, write>;
${temporalFlagsWGSL}
${temporalMaterialWGSL}
fn nearestHalf(value:f32)->f32{
  let magnitude=abs(value);if(magnitude==0. || magnitude>65504.){return value;}
  let step=select(exp2(floor(log2(magnitude))-10.),exp2(-24.),magnitude<exp2(-14.));
  let scaled=magnitude/step;let lower=floor(scaled);let fraction=scaled-lower;
  let increment=select(0.,1.,fraction>.5 || (fraction==.5 && (u32(lower)&1u)==1u));
  return sign(value)*(lower+increment)*step;
}
fn nearestHalf4(value:vec4f)->vec4f{return vec4f(nearestHalf(value.x),nearestHalf(value.y),nearestHalf(value.z),nearestHalf(value.w));}
fn centerDepthAndHit(at: vec2u) -> vec2f {
  if (p.centerRecords != 0u) {
    let source = 2u*(p.size.x*p.size.y + (p.size.y-1u-at.y)*p.size.x + at.x);
    return vec2f(depth[source].w, depth[source+1u].w);
  }
  return depth[at.y*p.size.x+at.x].xw;
}
fn nearerForeground(at: vec2i, currentDepth: f32) -> bool {
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let neighbor = at + vec2i(dx,dy);
      if (any(neighbor < vec2i(0)) || any(neighbor >= vec2i(p.size))) { continue; }
      let sample = centerDepthAndHit(vec2u(neighbor));
      if (sample.y > .5 && sample.x > 0. && sample.x < .96*currentDepth) { return true; }
    }
  }
  return false;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy >= p.size)) { return; }
  let i = g.y * p.size.x + g.x;
  let at = vec2i(g.xy);
  let layer = i32(p.slot);
  let depthAndHit = centerDepthAndHit(g.xy);
  let gloss = select(0u, u32(max(0., depthAndHit.y-1.)), p.centerRecords != 0u);
  let hit = depthAndHit.y > .5;
  let surface = vec4f(normal[i].xyz, depthAndHit.x);
  textureStore(surfaceOut, at, layer * 2, nearestHalf4(surface));
  textureStore(surfaceOut, at, layer * 2 + 1, surface);

  let r = roughness[i];
  textureStore(materialOut, at, layer, vec4u(packSurfaceMaterial(r.xy, gloss, p.centerRecords != 0u), 0, 0, 0));
  let peak = max(albedo[i].x, max(albedo[i].y, albedo[i].z));
  let guide = u32(floor(255. * sqrt(clamp(peak, 0., 1.)) + .5));
  let coverage = u32(floor(255. * clamp(r.w, 0., 1.) + .5));
  let m = motion[i];
  var flags = u32(m.w) | (guide << 10u) | (coverage << 2u) |
    select(0u, CENTER_HIT, hit);
  if (hit && nearerForeground(at, depthAndHit.x)) { flags |= NEARER_FOREGROUND; }

  let rgba = color[i];
  let stored = vec4f(nearestHalf4(vec4f(clamp(rgba.rgb, vec3f(-65504), vec3f(65504)), 0.)).rgb, rgba.a);
  if (any(!(abs(rgba) <= vec4f(65504)))) {
    flags |= HDR_MISSING;
    let key = i + 1u;
    for (var probe = 0u; probe < OVERFLOW_BUCKETS; probe++) {
      let address = bucket(key, probe, p.slot);
      loop {
        let claim = atomicCompareExchangeWeak(&overflow[address].index, 0u, key);
        if (claim.exchanged) {
          overflow[address].color = vec4f(rgba.rgb, select(nearestHalf(rgba.a), rgba.a, abs(rgba.a) > 65504.));
          flags = (flags & ~HDR_MISSING) | HDR_OVERFLOW;
          break;
        }
        if (claim.old_value != 0u) { break; }
      }
      if ((flags & HDR_OVERFLOW) != 0u) { break; }
    }
  }
  textureStore(hdrOut, at, layer, stored);
  // All packed flags fit in the exactly representable integer range of float32.
  textureStore(motionOut, at, layer, vec4f(m.xyz, f32(flags)));
}
`;
