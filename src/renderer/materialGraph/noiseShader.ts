// Noise kernels adapted from MaterialX v1.39.4 libraries/stdlib/genglsl/lib/mx_noise.glsl.
// https://github.com/AcademySoftwareFoundation/MaterialX/blob/v1.39.4/libraries/stdlib/genglsl/lib/mx_noise.glsl
// Copyright (c) 2009-2010 Sony Pictures Imageworks Inc., et al. (OSL BSD-3-Clause).
// See LICENSES/MaterialX-OSL-BSD-3-Clause.txt and THIRD_PARTY_NOTICES.md.
export function noiseShader(backend: 'webgpu' | 'webgl') {
    return backend === 'webgpu' ? `fn mx_rot(x:u32,k:u32) -> u32 { return (x<<k)|(x>>(32u-k)); }
fn mx_hash(p:vec3i,dim:i32,extra:i32) -> u32 {
  let seed:u32=0xdeadbeefu+u32(dim)*4u+13u;
  var a:u32=seed+bitcast<u32>(p.x);var b:u32=seed+bitcast<u32>(p.y);var c:u32=seed;
  if(dim>=3){c+=bitcast<u32>(p.z);}
  if(dim==4){
    a-=c;a^=mx_rot(c,4u);c+=b;b-=a;b^=mx_rot(a,6u);a+=c;c-=b;c^=mx_rot(b,8u);b+=a;
    a-=c;a^=mx_rot(c,16u);c+=b;b-=a;b^=mx_rot(a,19u);a+=c;c-=b;c^=mx_rot(b,4u);b+=a;
    a+=bitcast<u32>(extra);
  }
  c^=b;c-=mx_rot(b,14u);a^=c;a-=mx_rot(c,11u);b^=a;b-=mx_rot(a,25u);
  c^=b;c-=mx_rot(b,16u);a^=c;a-=mx_rot(c,4u);b^=a;b-=mx_rot(a,14u);c^=b;c-=mx_rot(b,24u);
  return c;
}
fn mx_pick(no:f32,yes:f32,condition:bool) -> f32 { if(condition){return yes;}return no; }
fn mx_grad(hash:u32,p:vec3f,dim:i32) -> f32 {
  let h:u32=hash & select(15u,7u,dim==2);
  let u:f32=mx_pick(p.y,p.x,h<select(8u,4u,dim==2));
  var v:f32=mx_pick(p.z,p.x,h==12u||h==14u);
  v=mx_pick(v,p.y,h<4u);
  if(dim==2){v=2.0*mx_pick(p.x,p.y,h<4u);}
  return mx_pick(u,-u,(h&1u)!=0u)+mx_pick(v,-v,(h&2u)!=0u);
}
fn mx_perlin(p:vec3f,dim:i32,channel:i32) -> f32 {
  let base:vec3i=vec3i(floor(p));let f:vec3f=p-floor(p);
  let t:vec3f=f*f*f*(f*(f*6.0-15.0)+10.0);
  var result:f32=0.0;
  for(var z:i32=0;z<2;z++){
    if(dim==2 && z==1){break;}
    for(var y:i32=0;y<2;y++){for(var x:i32=0;x<2;x++){
      let off:vec3i=vec3i(x,y,z);var h:u32=mx_hash(base+off,dim,0);
      if(channel>=0){h=(h>>u32(channel*8))&255u;}
      var weight:f32=mx_pick(1.0-t.x,t.x,x==1)*mx_pick(1.0-t.y,t.y,y==1);
      if(dim==3){weight*=mx_pick(1.0-t.z,t.z,z==1);}
      result+=mx_grad(h,f-vec3f(off),dim)*weight;
    }}
  }
  return result*mx_pick(0.9820,0.6616,dim==2);
}
fn mx_noise(p:vec3f,dim:i32,n:i32,fractal:bool) -> vec4f {
  if(n==1){return vec4f(mx_perlin(p,dim,-1));}
  if(n==2 && fractal){return vec4f(mx_perlin(p,dim,-1),mx_perlin(p+vec3f(19.0,193.0,17.0),dim,-1),0.0,0.0);}
  var offset:vec3f=vec3f(19.0,73.0,29.0);if(fractal){offset=vec3f(19.0,193.0,17.0);}
  return vec4f(mx_perlin(p,dim,0),mx_perlin(p,dim,1),mx_perlin(p,dim,2),mx_perlin(p+offset,dim,-1));
}
fn mx_fractal(p:vec3f,n:i32,octaves:i32,lacunarity:f32,diminish:f32) -> vec4f {
  var position:vec3f=p;var shifted:vec3f=p+vec3f(19.0,193.0,17.0);var amplitude:f32=1.0;var result:vec4f=vec4f(0.0);
  for(var i:i32=0;i<octaves;i++){var value:vec4f=mx_noise(position,3,n,true);if(n==2){value.y=mx_perlin(shifted,3,-1);}if(n==4){value.w=mx_perlin(shifted,3,-1);}result+=amplitude*value;amplitude*=diminish;position*=lacunarity;shifted*=lacunarity;}
  return result;
}
fn mx_cell(p:vec3f,dim:i32,channel:i32) -> f32 {
  let base:vec3i=vec3i(floor(p));var h:u32=0u;
  if(channel<0){h=mx_hash(base,dim,0);}else if(dim==2){h=mx_hash(vec3i(base.xy,channel),3,0);}else{h=mx_hash(base,4,channel);}
  return f32(h)/4294967295.0;
}
fn mx_worley(p:vec3f,dim:i32,n:i32,jitter:f32,style:i32) -> vec3f {
  let base:vec3f=floor(p);let local:vec3f=p-base;var distances:vec3f=vec3f(1e6);var minpos:vec3f=vec3f(0.0);
  for(var x:i32=-1;x<=1;x++){for(var y:i32=-1;y<=1;y++){for(var z:i32=-1;z<=1;z++){
    if(dim==2 && z!=0){continue;}
    let off:vec3f=vec3f(f32(x),f32(y),f32(z));let q:vec3f=base+off;
    var cp:vec3f=off+(vec3f(mx_cell(q,dim,0),mx_cell(q,dim,1),mx_cell(q,dim,2))-0.5)*jitter+0.5-local;
    if(dim==2){cp.z=0.0;}
    let d:f32=dot(cp,cp);
    if(d<distances.x){distances=vec3f(d,distances.xy);minpos=cp;}
    else if(d<distances.y){distances=vec3f(distances.x,d,distances.y);}
    else if(d<distances.z){distances.z=d;}
  }}}
  if(style==1){let q:vec3f=p+minpos;if(n==1){return vec3f(mx_cell(q,dim,-1));}return vec3f(mx_cell(q,dim,0),mx_cell(q,dim,1),mx_cell(q,dim,2));}
  return sqrt(distances);
}
` : `uint mx_rot(uint x, uint k) { return (x<<k)|(x>>(32u-k)); }
uint mx_hash(ivec3 p, int dim, int extra) {
  uint seed=0xdeadbeefu+uint(dim)*4u+13u;
  uint a=seed+uint(p.x);uint b=seed+uint(p.y);uint c=seed;
  if(dim>=3){c+=uint(p.z);}
  if(dim==4){
    a-=c;a^=mx_rot(c,4u);c+=b;b-=a;b^=mx_rot(a,6u);a+=c;c-=b;c^=mx_rot(b,8u);b+=a;
    a-=c;a^=mx_rot(c,16u);c+=b;b-=a;b^=mx_rot(a,19u);a+=c;c-=b;c^=mx_rot(b,4u);b+=a;
    a+=uint(extra);
  }
  c^=b;c-=mx_rot(b,14u);a^=c;a-=mx_rot(c,11u);b^=a;b-=mx_rot(a,25u);
  c^=b;c-=mx_rot(b,16u);a^=c;a-=mx_rot(c,4u);b^=a;b-=mx_rot(a,14u);c^=b;c-=mx_rot(b,24u);
  return c;
}
float mx_pick(float no, float yes, bool condition) { if(condition){return yes;}return no; }
float mx_grad(uint hash, vec3 p, int dim) {
  uint h=hash & (dim==2?7u:15u);
  float u=mx_pick(p.y,p.x,h<(dim==2?4u:8u));
  float v=mx_pick(p.z,p.x,h==12u||h==14u);
  v=mx_pick(v,p.y,h<4u);
  if(dim==2){v=2.0*mx_pick(p.x,p.y,h<4u);}
  return mx_pick(u,-u,(h&1u)!=0u)+mx_pick(v,-v,(h&2u)!=0u);
}
float mx_perlin(vec3 p, int dim, int channel) {
  ivec3 base=ivec3(floor(p));vec3 f=p-floor(p);
  vec3 t=f*f*f*(f*(f*6.0-15.0)+10.0);
  float result=0.0;
  for(int z=0;z<2;z++){
    if(dim==2 && z==1){break;}
    for(int y=0;y<2;y++){for(int x=0;x<2;x++){
      ivec3 off=ivec3(x,y,z);uint h=mx_hash(base+off,dim,0);
      if(channel>=0){h=(h>>uint(channel*8))&255u;}
      float weight=mx_pick(1.0-t.x,t.x,x==1)*mx_pick(1.0-t.y,t.y,y==1);
      if(dim==3){weight*=mx_pick(1.0-t.z,t.z,z==1);}
      result+=mx_grad(h,f-vec3(off),dim)*weight;
    }}
  }
  return result*mx_pick(0.9820,0.6616,dim==2);
}
vec4 mx_noise(vec3 p, int dim, int n, bool fractal) {
  if(n==1){return vec4(mx_perlin(p,dim,-1));}
  if(n==2 && fractal){return vec4(mx_perlin(p,dim,-1),mx_perlin(p+vec3(19.0,193.0,17.0),dim,-1),0.0,0.0);}
  vec3 offset=vec3(19.0,73.0,29.0);if(fractal){offset=vec3(19.0,193.0,17.0);}
  return vec4(mx_perlin(p,dim,0),mx_perlin(p,dim,1),mx_perlin(p,dim,2),mx_perlin(p+offset,dim,-1));
}
vec4 mx_fractal(vec3 p, int n, int octaves, float lacunarity, float diminish) {
  vec3 position=p;vec3 shifted=p+vec3(19.0,193.0,17.0);float amplitude=1.0;vec4 result=vec4(0.0);
  for(int i=0;i<octaves;i++){vec4 value=mx_noise(position,3,n,true);if(n==2){value.y=mx_perlin(shifted,3,-1);}if(n==4){value.w=mx_perlin(shifted,3,-1);}result+=amplitude*value;amplitude*=diminish;position*=lacunarity;shifted*=lacunarity;}
  return result;
}
float mx_cell(vec3 p, int dim, int channel) {
  ivec3 base=ivec3(floor(p));uint h=0u;
  if(channel<0){h=mx_hash(base,dim,0);}else if(dim==2){h=mx_hash(ivec3(base.xy,channel),3,0);}else{h=mx_hash(base,4,channel);}
  return float(h)/4294967295.0;
}
vec3 mx_worley(vec3 p, int dim, int n, float jitter, int style) {
  vec3 base=floor(p);vec3 local=p-base;vec3 distances=vec3(1e6);vec3 minpos=vec3(0.0);
  for(int x=-1;x<=1;x++){for(int y=-1;y<=1;y++){for(int z=-1;z<=1;z++){
    if(dim==2 && z!=0){continue;}
    vec3 off=vec3(float(x),float(y),float(z));vec3 q=base+off;
    vec3 cp=off+(vec3(mx_cell(q,dim,0),mx_cell(q,dim,1),mx_cell(q,dim,2))-0.5)*jitter+0.5-local;
    if(dim==2){cp.z=0.0;}
    float d=dot(cp,cp);
    if(d<distances.x){distances=vec3(d,distances.xy);minpos=cp;}
    else if(d<distances.y){distances=vec3(distances.x,d,distances.y);}
    else if(d<distances.z){distances.z=d;}
  }}}
  if(style==1){vec3 q=p+minpos;if(n==1){return vec3(mx_cell(q,dim,-1));}return vec3(mx_cell(q,dim,0),mx_cell(q,dim,1),mx_cell(q,dim,2));}
  return sqrt(distances);
}
`;
}
