// Noise kernels adapted from MaterialX v1.39.4 libraries/stdlib/genglsl/lib/mx_noise.glsl.
// https://github.com/AcademySoftwareFoundation/MaterialX/blob/v1.39.4/libraries/stdlib/genglsl/lib/mx_noise.glsl
// Copyright (c) 2009-2010 Sony Pictures Imageworks Inc., et al. (OSL BSD-3-Clause).
// See LICENSES/MaterialX-OSL-BSD-3-Clause.txt and THIRD_PARTY_NOTICES.md.
export function noiseShader() {
    return `fn mx_rot(x:u32,k:u32) -> u32 { return (x<<k)|(x>>(32u-k)); }
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
// One mx_perlin call site in a channel loop: every inlined copy of the lattice
// loop costs compile time. \`s\` is the point of the offset channel.
fn mx_noise_channels(p:vec3f,s:vec3f,dim:i32,n:i32,fractal:bool) -> vec4f {
  var result:vec4f=vec4f(0.0);
  let count=select(select(4,2,n==2 && fractal),1,n==1);
  for(var c:i32=0;c<count;c++){
    var q:vec3f=p;var channel:i32=-1;
    if(n!=1 && !(n==2 && fractal)){if(c<3){channel=c;}else{q=s;}}else if(c==1){q=s;}
    result[c]=mx_perlin(q,dim,channel);
  }
  if(n==1){return vec4f(result.x);}
  return result;
}
fn mx_noise(p:vec3f,dim:i32,n:i32,fractal:bool) -> vec4f {
  var offset:vec3f=vec3f(19.0,73.0,29.0);if(fractal){offset=vec3f(19.0,193.0,17.0);}
  return mx_noise_channels(p,p+offset,dim,n,fractal);
}
// Fractal octaves; with one octave and \`fractal\` false it is mx_noise, so the
// interpreter evaluates both through one mx_noise_channels call site.
fn mx_noise_octaves(p:vec3f,dim:i32,n:i32,fractal:bool,octaves:i32,lacunarity:f32,diminish:f32) -> vec4f {
  var offset:vec3f=vec3f(19.0,73.0,29.0);if(fractal){offset=vec3f(19.0,193.0,17.0);}
  var position:vec3f=p;var shifted:vec3f=p+offset;var amplitude:f32=1.0;var result:vec4f=vec4f(0.0);
  for(var i:i32=0;i<octaves;i++){
    // The fractal's 2- and 4-channel offsets follow the scaled shifted point.
    let s=select(position+offset,shifted,fractal && (n==2 || n==4));
    result+=amplitude*mx_noise_channels(position,s,dim,n,fractal);amplitude*=diminish;position*=lacunarity;shifted*=lacunarity;
  }
  return result;
}
fn mx_fractal(p:vec3f,n:i32,octaves:i32,lacunarity:f32,diminish:f32) -> vec4f {
  return mx_noise_octaves(p,3,n,true,octaves,lacunarity,diminish);
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
`;
}
