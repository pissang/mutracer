
override AOV_COMPACT: bool = false;
fn aovUnpack(value: vec2u) -> vec4f {return vec4f(unpack2x16float(value.x),unpack2x16float(value.y));}
fn aovPack(value: vec4f) -> vec2u {return vec2u(pack2x16float(value.xy),pack2x16float(value.zw));}

struct AovResolvedAccumulation { geometry: vec4f, position: vec4f, diffuse: vec4f, specular: vec4f, }
struct AovResolvedCenter { identity: vec4u, motion: vec4f, }
@group(0) @binding(0) var<storage,read> accumulation: array<u32>;
fn loadAov(source: u32) -> AovResolvedAccumulation {
  if(AOV_COMPACT){let o=source*6u;return AovResolvedAccumulation(vec4f(bitcast<f32>(accumulation[o]),0,0,0),
    vec4f(0,0,0,bitcast<f32>(accumulation[o+1u])),aovUnpack(vec2u(accumulation[o+2u],accumulation[o+3u])),aovUnpack(vec2u(accumulation[o+4u],accumulation[o+5u])));}
  let o=source*16u;
  return AovResolvedAccumulation(bitcast<vec4f>(vec4u(accumulation[o],accumulation[o+1u],accumulation[o+2u],accumulation[o+3u])),
    bitcast<vec4f>(vec4u(accumulation[o+4u],accumulation[o+5u],accumulation[o+6u],accumulation[o+7u])),
    bitcast<vec4f>(vec4u(accumulation[o+8u],accumulation[o+9u],accumulation[o+10u],accumulation[o+11u])),
    bitcast<vec4f>(vec4u(accumulation[o+12u],accumulation[o+13u],accumulation[o+14u],accumulation[o+15u])));
}
@group(0) @binding(1) var<storage,read> center: array<AovResolvedCenter>;
@group(0) @binding(3) var<uniform> parameters: vec4u;
fn aovResolvedValue(source: u32, kind: u32) -> vec4u {
  if(kind==5u){return center[source].identity;}
  var value=vec4f(0.0);
  if(kind==6u){let motion=center[source].motion;value=vec4f(motion.xy,0.0,motion.w);}
  else{
    let pixel=loadAov(source);let hits=pixel.position.w;
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

@group(0) @binding(2) var<storage,read_write> output: array<vec4u>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let width=parameters.x;let height=parameters.y;
  if(id.x>=width||id.y>=height){return;}
  let index=id.x+id.y*width;
  let source=id.x+select(id.y,height-1u-id.y,(parameters.w&256u)!=0u)*width;
  output[index]=aovResolvedValue(source,parameters.w&255u);
}
