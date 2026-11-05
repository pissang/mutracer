/** Shared normalization for readback and GPU denoiser snapshots. */
export const aovResolveCommon = /* wgsl */ `
struct AovResolvedAccumulation { geometry: vec4f, position: vec4f, diffuse: vec4f, specular: vec4f, }
struct AovResolvedCenter { identity: vec4u, motion: vec4f, }
@group(0) @binding(0) var<storage,read> accumulation: array<AovResolvedAccumulation>;
@group(0) @binding(1) var<storage,read> center: array<AovResolvedCenter>;
@group(0) @binding(3) var<uniform> parameters: vec4u;
fn aovResolvedValue(source: u32, kind: u32) -> vec4u {
  if(kind==5u){return center[source].identity;}
  var value=vec4f(0.0);
  if(kind==6u){let motion=center[source].motion;value=vec4f(motion.xy,0.0,motion.w);}
  else{
    let pixel=accumulation[source];let hits=pixel.position.w;
    let scale=select(0.0,1.0/max(hits,1.0),hits>0.0);let coverage=hits/f32(max(parameters.z,1u));
    if(kind==0u){value=vec4f(pixel.geometry.x*scale,0.0,0.0,coverage);}
    else if(kind==1u){value=vec4f(pixel.position.xyz*scale,coverage);}
    else if(kind==2u){value=vec4f(pixel.geometry.yzw*scale,coverage);}
    else{let reflectance=select(pixel.diffuse,pixel.specular,kind==4u);
      let inv=select(0.0,1.0/max(reflectance.w,1.0),reflectance.w>0.0);
      value=vec4f(reflectance.xyz*inv,reflectance.w/f32(max(parameters.z,1u)));
    }
  }
  return bitcast<vec4u>(value);
}
`;
/** Bit 8 of kind requests top row first. Kept for the native single-output pass. */
export default aovResolveCommon + /* wgsl */ `
@group(0) @binding(2) var<storage,read_write> output: array<vec4u>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let width=parameters.x;let height=parameters.y;
  if(id.x>=width||id.y>=height){return;}
  let index=id.x+id.y*width;
  let source=id.x+select(id.y,height-1u-id.y,(parameters.w&256u)!=0u)*width;
  output[index]=aovResolvedValue(source,parameters.w&255u);
}
`;

/** Borrowed depth texture: rg32float (depth, hit coverage), top row first. */
export const aovBorrowDepthShader = aovResolveCommon + /* wgsl */ `
@group(0) @binding(2) var image: texture_storage_2d<rg32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if(any(id.xy>=parameters.xy)){return;}
  let source=id.x+(parameters.y-1u-id.y)*parameters.x;
  let value=bitcast<vec4f>(aovResolvedValue(source,parameters.w));
  textureStore(image,vec2i(id.xy),vec4f(value.x,value.w,0,0));
}`;
/** Borrowed reflectance texture, rendered into rgba8unorm-srgb, top row first. */
export const aovBorrowReflectanceShader = aovResolveCommon + /* wgsl */ `
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p=vec2f(f32((index<<1u)&2u),f32(index&2u));return vec4f(p*2.0-1.0,0,1);
}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let id=vec2u(position.xy);
  let source=id.x+(parameters.y-1u-id.y)*parameters.x;
  return clamp(bitcast<vec4f>(aovResolvedValue(source,parameters.w)),vec4f(0),vec4f(1));
}`;
