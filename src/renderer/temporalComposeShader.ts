export const composePackWGSL = /* wgsl */ `
struct Frame { size: vec2u, samples: u32, guideSlot: u32 }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage,read> accumulated: array<vec4f>;
@group(0) @binding(2) var guides: texture_2d_array<f32>;
@group(0) @binding(3) var<storage,read_write> color: array<vec4f>;
@group(0) @binding(4) var<storage,read_write> albedo: array<vec4f>;
@group(0) @binding(5) var<storage,read_write> normal: array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=frame.size)) {return;}
  let at=vec2i(g.xy); let rgba=accumulated[g.y*frame.size.x+g.x];
  let alb=textureLoad(guides,at,i32(frame.guideSlot*2u),0); let nrm=textureLoad(guides,at,i32(frame.guideSlot*2u+1u),0);
  let n=f32(frame.samples); let hit=floor(alb.a*n+0.5); let dst=(frame.size.y-1-g.y)*frame.size.x+g.x;
  color[dst]=vec4f(rgba.rgb*select(n,hit,hit>0.0),rgba.a*n);
  albedo[dst]=vec4f(alb.rgb*n,hit);
  normal[dst]=vec4f(select(vec3f(0),(nrm.rgb-0.5)*2.0*n,nrm.a>0.0),n);
}`;
export const motionCoverageWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage,read> position: array<vec4u>;
struct Counts { values: array<atomic<u32>> }
@group(0) @binding(1) var<storage,read_write> counts: Counts;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(workgroup_id) group: vec3u) {
  if (g.x < arrayLength(&position) && bitcast<f32>(position[g.x].w) > 0.5) { atomicAdd(&counts.values[group.x], 1u); }
}`;
