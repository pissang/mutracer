// Experimental center-only supplemental sampling for the native offline window.
// The past half of a frame's window decides which pixels lack history. Their
// extra samples are traced into a separate accumulation and blended only into
// that frame's own center tap, so neighboring frames keep reusing base samples.
import {temporalMaterialWGSL} from '../../src/renderer/temporalKernels.js';

// Turn one window's weight sums into extra sample counts and append each
// pixel that needs samples to a compact list: [count, x | y << 16 | n << 24...].
// `mirror` extrapolates the past history weight to the whole window. A zero
// mirror (unused) treats the sums as a complete window.
export const supplementNeedWGSL = /* wgsl */ `
struct Params { size: vec2u, slot: u32, reflections: u32, base: u32, cap: u32, goal: f32, mirror: f32, radius: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> surfaceSum: array<vec4f>;
@group(0) @binding(2) var<storage, read> reflectedSum: array<vec4f>;
@group(0) @binding(3) var surfaces: texture_2d_array<f32>;
@group(0) @binding(4) var materials: texture_2d_array<u32>;
@group(0) @binding(5) var<storage, read_write> list: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> info: array<vec4f>;
${temporalMaterialWGSL}
fn effective(sum: f32) -> f32 {
  // The center has weight one. History weight on the unseen side is assumed
  // to match the observed side.
  return select(sum, 1. + max(sum - 1., 0.)*p.mirror, p.mirror > 0.);
}
fn hit(at: vec2i) -> bool {
  return textureLoad(surfaces, at, i32(2u*p.slot), 0).w > .0001;
}
// Reflected share of the windowed luminance. Smooth metals rely almost
// entirely on reflected history.
fn share(at: vec2i, index: u32) -> f32 {
  if (p.reflections == 0u) { return 0.; }
  let luma = vec3f(.2126,.7152,.0722);
  let surface = surfaceSum[index];
  let reflected = reflectedSum[index];
  let s = max(dot(surface.rgb/max(surface.a,1e-6), luma), 0.);
  let r = max(dot(reflected.rgb/max(reflected.a,1e-6), luma), 0.);
  let material = unpackSurfaceMaterial(textureLoad(materials, at, i32(p.slot), 0).x);
  return select(r/max(s + r, 1e-6), 1., material.y > METALLIC_THRESHOLD && s + r <= 1e-6);
}
fn support(at: vec2i) -> f32 {
  let index = u32(at.y)*p.size.x + u32(at.x);
  let es = max(effective(surfaceSum[index].a), 1.);
  let er = select(es, max(effective(reflectedSum[index].a), 1.), p.reflections != 0u);
  return 1./mix(1./es, 1./er, share(at, index));
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy >= p.size)) { return; }
  let index = g.y*p.size.x + g.x;
  let at = vec2i(g.xy);
  // A rejection decision can depend on a pixel's own samples, for example
  // through the endpoint of a sampled glossy reflection. Selecting by the
  // neighborhood keeps the extra samples from targeting only the pixels whose
  // base samples were outliers. The low bits of radius give the reach; bit 8
  // averages the support of nearby hit pixels, otherwise the weakest counts.
  let r = i32(p.radius & 255u);
  let average = (p.radius & 256u) != 0u;
  var total = 0.;
  var weakest = 1e30;
  var count = 0.;
  for (var dy = -r; dy <= r; dy++) {
    for (var dx = -r; dx <= r; dx++) {
      let q = at + vec2i(dx, dy);
      if (any(q < vec2i(0)) || any(q >= vec2i(p.size)) || !hit(q)) { continue; }
      let value = support(q);
      total += value;
      weakest = min(weakest, value);
      count += 1.;
    }
  }
  let estimate = select(weakest, total/max(count, 1.), average);
  let deficit = f32(p.base)*(p.goal - estimate);
  var need = 0u;
  if (hit(at) && deficit > .5) { need = min(u32(round(deficit)), p.cap); }
  let surface = surfaceSum[index].a;
  info[index] = vec4f(surface, select(surface, reflectedSum[index].a, p.reflections != 0u), share(at, index), f32(need));
  if (need > 0u) {
    let k = atomicAdd(&list[0], 1u);
    atomicStore(&list[1u + k], g.x | (g.y << 12u) | (need << 24u));
  }
}
`;

// Read the supplemental accumulation at listed pixels. Each entry stores the
// surface part with its weight relative to the base count, then the reflected part.
export const supplementGatherWGSL = /* wgsl */ `
struct Params { size: vec2u, base: u32, reflections: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> list: array<u32>;
@group(0) @binding(2) var<storage, read> colors: array<vec4f>;
@group(0) @binding(3) var<storage, read> albedos: array<vec4f>;
@group(0) @binding(4) var<storage, read> normals: array<vec4f>;
@group(0) @binding(5) var<storage, read> radiance: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> entries: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x + g.y*65535u*64u;
  if (k >= list[0]) { return; }
  let packed = list[1u + k];
  let x = packed & 4095u;
  let y = (packed >> 12u) & 4095u;
  // Native accumulation is bottom row first.
  let source = (p.size.y - 1u - y)*p.size.x + x;
  let samples = normals[source].w;
  let hits = albedos[source].w;
  let hdr = colors[source].rgb/max(select(samples, hits, hits > 0.), 1.);
  var reflected = vec3f(0);
  if (p.reflections != 0u) {
    reflected = clamp(radiance[source].rgb/max(1., select(samples, hits, hits > 0.)), vec3f(0), max(hdr, vec3f(0)));
  }
  let finite = all(abs(hdr) <= vec3f(65504.)) && all(abs(reflected) <= vec3f(65504.));
  let weight = select(0., samples/f32(p.base), finite);
  let destination = y*p.size.x + x;
  entries[2u*k] = vec4f(select(vec3f(0), hdr - reflected, finite), weight);
  entries[2u*k + 1u] = vec4f(select(vec3f(0), reflected, finite), bitcast<f32>(destination));
}
`;

// Add the gathered samples to the current frame's center tap before the
// window normalizes. Rejection decisions and history weights are unchanged.
export const supplementBlendWGSL = /* wgsl */ `
struct Params { count: u32, reflections: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> entries: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> total: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> reflectedTotal: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x + g.y*65535u*64u;
  if (k >= p.count) { return; }
  let surface = entries[2u*k];
  let reflected = entries[2u*k + 1u];
  let index = bitcast<u32>(reflected.w);
  total[index] += vec4f(surface.rgb*surface.w, surface.w);
  if (p.reflections != 0u) {
    reflectedTotal[index] += vec4f(reflected.rgb*surface.w, surface.w);
  }
}
`;
