export const temporalOverflowBuckets = 4096;
export const temporalOverflowEntryBytes = 32;

export const temporalFlagsWGSL = /* wgsl */ `
const GUIDE_MASK = 65535u;
const CENTER_HIT = 1u << 18u;
const NEARER_FOREGROUND = 1u << 19u;
const HDR_OVERFLOW = 1u << 20u;
const HDR_MISSING = 1u << 21u;
`;

// Reflection capture uses the upper word of nonmetal records for dielectric
// reflection strength. Other records keep the pair of unorm16 fields.
export const temporalMaterialFormat = 'r32uint';
export const temporalMaterialBytes = 4;
export const temporalMaterialWGSL = /* wgsl */ `
const METALLIC_THRESHOLD = 0.10;
fn packSurfaceMaterial(roughness: vec2f, gloss: u32, reflections: bool) -> u32 {
  let r = select(0., roughness.x, abs(roughness.x) <= 3.402823e38);
  if (reflections && !(roughness.y > METALLIC_THRESHOLD)) {
    if (gloss >> 8u == 0u) { return u32(round(clamp(r, 0., 1.) * 65535.)); }
    return ((gloss & 255u) * 257u) | ((gloss >> 8u) << 16u);
  }
  // The scale gives .10 an exact code. Preserve the threshold classification
  // when a metallic value slightly above it rounds down to the same code.
  let encodedMetallic = u32(round(clamp(roughness.y, 0., 1.) * 65530.));
  let metallic = select(min(encodedMetallic, 6553u), max(encodedMetallic, 6554u),
    roughness.y > METALLIC_THRESHOLD);
  return u32(round(clamp(r, 0., 1.) * 65535.)) | (metallic << 16u);
}
fn unpackSurfaceMaterial(record: u32) -> vec3f {
  let upper = record >> 16u;
  let metallic = upper > 6553u;
  return vec3f(f32(record & 65535u) / 65535., f32(upper) / 65530., select(f32(upper)/255.,0.,metallic));
}
`;

export const temporalMetadataWGSL = /* wgsl */ `${temporalFlagsWGSL}
fn frameFlags(at: vec2i, slot: u32) -> u32 {
  return u32(textureLoad(motions, at, i32(slot), 0).w);
}
fn motionSample(at: vec2i, slot: u32) -> vec4f {
  let sample = textureLoad(motions, at, i32(slot), 0);
  return vec4f(sample.xyz, f32(u32(sample.w) & 3u));
}
`;

export const temporalOverflowWGSL = /* wgsl */ `
const OVERFLOW_BUCKETS=${temporalOverflowBuckets}u;
struct Overflow { index: atomic<u32>, color: vec4f }
fn bucket(index: u32, probe: u32, slot: u32) -> u32 {
  return slot*OVERFLOW_BUCKETS+((index*2654435761u+probe)&(OVERFLOW_BUCKETS-1u));
}
`;

export const temporalRadianceWGSL = /* wgsl */ `
fn loadRadiance(at: vec2i, slot: u32, width: u32) -> vec4f {
  let value = textureLoad(hdr, at, i32(slot), 0);
  if ((frameFlags(at, slot) & HDR_OVERFLOW) == 0u) { return value; }
  let key = u32(at.y) * width + u32(at.x) + 1u;
  for (var probe = 0u; probe < OVERFLOW_BUCKETS; probe++) {
    let address = bucket(key, probe, slot);
    let found = atomicLoad(&overflow[address].index);
    if (found == key) { return overflow[address].color; }
    if (found == 0u) { break; }
  }
  return vec4f(0);
}
`;

// The window capture explicitly rounded to nearest half. Post used native
// texture stores. Keep both representations to preserve correspondence tests.
export const temporalPostSurfaceWGSL = /* wgsl */ `
fn postSurface(at: vec2i, slot: u32, field: u32) -> vec4f {
  let surface = textureLoad(surfaces, at, i32(slot * 2u + 1u), 0);
  let hit = f32((frameFlags(at, slot) & CENTER_HIT) != 0u);
  if (field == 1u) { return vec4f(surface.w, 0, 0, hit); }
  return vec4f(surface.xyz, hit);
}
`;

const common = /* wgsl */`
struct Params { size: vec2u, a: u32, b: u32, delta: i32, stage: u32, axis: u32, pad: u32 }
struct Camera { vp: mat4x4f, lens: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var surfaces: texture_2d_array<f32>;
@group(0) @binding(2) var ids: texture_2d_array<u32>;
@group(0) @binding(3) var<storage, read> cameras: array<Camera>;

fn ident(x: vec2i, frame: u32) -> vec3u { return textureLoad(ids, x, i32(frame), 0).xyz; }
fn materialRevision(x:vec2i,frame:u32)->u32{return textureLoad(ids,x,i32(frame),0).w;}
fn sameMaterial(x:vec2i,frame:u32,id:vec3u,revision:u32)->bool{return all(ident(x,frame)==id)&&materialRevision(x,frame)==revision;}
@group(0) @binding(6) var motions: texture_2d_array<f32>;
${temporalMetadataWGSL}
${temporalPostSurfaceWGSL}
fn inside(q: vec2f) -> bool { return all(q>=vec2f(0)) && all(q<=vec2f(p.size)-1.0); }
fn nearest(q: vec2f) -> vec2i { return clamp(vec2i(floor(q+0.5)),vec2i(0),vec2i(p.size)-1); }
fn motionAt(q: vec2f, frame: u32, id: vec3u, revision:u32) -> vec4f {
  if (!inside(q)) { return vec4f(0); }
  let origin=vec2i(floor(q)); let phase=fract(q); var value=vec4f(0); var weightSum=0.0;
  for(var dy=0;dy<2;dy++){for(var dx=0;dx<2;dx++){
    let at=origin+vec2i(dx,dy); if(any(at>=vec2i(p.size))){continue;}
    let sample=motionSample(at, frame);
    if(sample.w!=3.0 || !sameMaterial(at,frame,id,revision)){continue;}
    let weight=select(1.0-phase.x,phase.x,dx==1)*select(1.0-phase.y,phase.y,dy==1);
    value+=sample*weight; weightSum+=weight;
  }}
  if(weightSum<=0.0){return vec4f(0);}
  return vec4f(value.xyz/weightSum,3.0);
}
fn guideAt(q: vec2f, frame: u32, field: u32, id: vec3u, revision:u32) -> vec4f {
  if (!inside(q)) { return vec4f(0); }
  let origin=vec2i(floor(q)); let phase=fract(q); var value=vec4f(0); var weightSum=0.0;
  for(var dy=0;dy<2;dy++){for(var dx=0;dx<2;dx++){
    let at=origin+vec2i(dx,dy); if(any(at>=vec2i(p.size)) || !sameMaterial(at,frame,id,revision)){continue;}
    let sample=postSurface(at,frame,field); if(sample.w<=0.0){continue;}
    let weight=select(1.0-phase.x,phase.x,dx==1)*select(1.0-phase.y,phase.y,dy==1);
    value+=sample*weight; weightSum+=weight;
  }}
  if(weightSum<=0.0){return vec4f(0);}
  value/=weightSum;
  if(field==2u){value=vec4f(normalize(value.xyz),1.0);}
  return value;
}
fn trace(q0: vec2f, id: vec3u, delta: i32, first: u32, capacity: u32) -> vec4f {
  let revision=materialRevision(nearest(q0),first);
  var q=q0; var depth=guideAt(q,first,1u,id,revision).x; var n=guideAt(q,first,2u,id,revision).xyz;
  for(var step=0;step<abs(delta);step++){
    let later=i32(first)+select(-step,step+1,delta>0);
    let laterSlot=u32((later+i32(capacity))%i32(capacity));
    let previousSlot=u32((later-1+i32(capacity))%i32(capacity));
    let sourceN=guideAt(q,select(previousSlot,laterSlot,delta<0),2u,id,revision);
    if(sourceN.w<=0.0 || dot(n,sourceN.xyz)<0.95){return vec4f(q,depth,0);}
    var next=q; var motion=vec4f(0);
    if(delta<0){
      motion=motionAt(q,laterSlot,id,revision); if(motion.w!=3.0){return vec4f(q,depth,0);}
      next=q+motion.xy; depth=motion.z;
    }else{
      motion=motionAt(q,laterSlot,id,revision); if(motion.w!=3.0){return vec4f(q,depth,0);}
      next=q-motion.xy;
      var found=true;
      for(var iteration=0;iteration<4;iteration++){
        let edge=motionAt(next,laterSlot,id,revision); if(edge.w!=3.0){found=false;break;}
        next=q-edge.xy; motion=edge;
      }
      if(!found){return vec4f(q,depth,0);}
      let edge=motionAt(next,laterSlot,id,revision);
      if(edge.w!=3.0 || length(next+edge.xy-q)>=0.05){return vec4f(q,depth,0);}
      let currentDepth=guideAt(next,laterSlot,1u,id,revision);
      if(currentDepth.w<=0.0){return vec4f(q,depth,0);}
      depth+=currentDepth.x-motion.z;
    }
    if(!inside(next)){return vec4f(q,depth,0);}
    let destN=guideAt(next,select(laterSlot,previousSlot,delta<0),2u,id,revision);
    if(destN.w<=0.0 || dot(n,destN.xyz)<0.95){return vec4f(q,depth,0);}
    q=next; n=destN.xyz;
  }
  return vec4f(q,depth,1);
}
`;
export const reproject = common + /* wgsl */`
@group(0) @binding(4) var<storage, read_write> mapping: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> counts: array<atomic<u32>>;
fn reject(x: vec2i, q: vec4f, y: vec2i) -> u32 {
  let pos=postSurface(x,p.a,0u); let id=ident(x,p.a);
  let revision=materialRevision(x,p.a);
  if (!(pos.w>0.5)) { return 0u; }
  if (!(q.w>0.5 && inside(q.xy) && q.z>0.0)) { return 1u; }
  if (!sameMaterial(y,p.b,id,revision)) { return 2u; }
  let depth=postSurface(y,p.b,1u);
  if (!(depth.w>0.5 && abs(depth.x-q.z)<=0.015*max(q.z,depth.x))) { return 3u; }
  let n=postSurface(x,p.a,2u); let o=postSurface(y,p.b,2u);
  if (!(n.w>0.5 && o.w>0.5)) { return 4u; }
  return 9u;
}
var<workgroup> localCounts: array<atomic<u32>,20>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_index) local: u32) {
  if (all(g.xy<p.size)) {
    let x=vec2i(g.xy); let path=trace(vec2f(x),ident(x,p.a),p.delta,p.a,p.pad);
    let q=vec4f(path.xy,path.z,path.w); let y=nearest(q.xy);
    let reason=reject(x,q,y);
    let at=select(vec2f(-1),q.xy,reason>=2u);
    mapping[g.y*p.size.x+g.x]=vec4f(at,select(0.0,1.0,reason==9u),f32(reason));
    if (p.axis==1u) {
      atomicAdd(&localCounts[reason],1u);
      if (g.x>=1000u && g.y<330u) { atomicAdd(&localCounts[reason+10u],1u); }
    }
  }
  workgroupBarrier();
  if (p.axis==1u && local<20u) {
    let count=atomicLoad(&localCounts[local]);
    if (count>0u) { atomicAdd(&counts[local],count); }
  }
}
`;
export const accumulate = /* wgsl */ `
struct Params { size: vec2u, a: u32, b: u32, delta: i32, stage: u32, axis: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var images: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read_write> total: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=p.size)) { return; }
  let color=textureLoad(images,vec2i(g.xy),i32(p.a),0);
  let idx=g.y*p.size.x+g.x;
  if (p.stage==0u) { total[idx]=vec4f(color.rgb,1.0); return; }
  output[idx]=vec4f(total[idx].rgb/total[idx].w,color.w);
}
`;
export const blur = /* wgsl */`
struct Params { size: vec2u, a: u32, b: u32, delta: i32, stage: u32, axis: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var inputImage: texture_2d_array<f32>;
@group(0) @binding(2) var outputImage: texture_storage_2d_array<rgba16float,write>;
fn reflect(x: i32, n: i32) -> i32 { return select(select(x,2*n-x-2,x>=n),-x,x<0); }
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=p.size)) { return; }
  let x=vec2i(g.xy); var value=vec3f(0); var weights=0.0;
  for (var k=-5; k<=5; k++) {
    let at=x+select(vec2i(k,0),vec2i(0,k),p.axis==1u);
    let uv=vec2i(reflect(at.x,i32(p.size.x)),reflect(at.y,i32(p.size.y)));
    let weight=exp(-0.5*pow(f32(abs(k))/1.2,2.0));
    value+=textureLoad(inputImage,uv,i32(select(p.a,0u,p.axis==1u)),0).xyz*weight; weights+=weight;
  }
  textureStore(outputImage,x,i32(select(0u,p.a,p.axis==1u)),vec4f(value/weights,1));
}
`;

export const snapshot = /* wgsl */ `
struct Params { size: vec2u, a: u32, b: u32, delta: i32, stage: u32, axis: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage,read> input: array<vec4f>;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=p.size)) { return; }
  var color = input[g.y*p.size.x+g.x];
  if (p.stage==4u) {
    let linear=max(color.rgb,vec3f(0));
    let encoded=select(1.055*pow(linear,vec3f(1.0/2.4))-0.055,12.92*linear,linear<=vec3f(0.0031308));
    color=vec4f(clamp(encoded,vec3f(0),vec3f(1))*255.0,255);
  }
  textureStore(dst,vec2i(g.xy),i32(p.a),color);
}
`;

export const idSnapshot = /* wgsl */ `
struct Params { size: vec2u, a: u32, b: u32, delta: i32, stage: u32, axis: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage,read> input: array<vec4u>;
@group(0) @binding(2) var<storage,read> revisions: array<vec2u>;
@group(0) @binding(3) var dst: texture_storage_2d_array<rgba32uint,write>;
fn materialRevision(id:u32)->u32 {
  var low=0u; var high=p.pad;
  for(var iteration=0u;iteration<32u && low<high;iteration++){
    let mid=low+(high-low)/2u; let entry=revisions[mid];
    if(entry.x==id){return entry.y;}
    if(entry.x<id){low=mid+1u;}else{high=mid;}
  }
  return 0u;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=p.size)) { return; }
  let identity=input[g.y*p.size.x+g.x];
  textureStore(dst,vec2i(g.xy),i32(p.a),vec4u(identity.xyz,materialRevision(identity.z)));
}
`;
