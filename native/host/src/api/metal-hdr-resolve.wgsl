// Transport conversion matching hdr.rs's f32 CPU order. The existing borrowed
// HDR texture has a different contract (sum/hit); keep both APIs unchanged.
// Integer division gives round-to-nearest-even instead of the Metal reciprocal's
// permitted ULP error. No scene sampling or accumulation is changed.
fn normalized(value: u32) -> vec2u {
  let e=(value>>23u)&255u; let m=value&0x7fffffu;
  if(e!=0u){return vec2u(m|0x800000u,bitcast<u32>(i32(e)-127));}
  let shift=countLeadingZeros(m)-8u;
  return vec2u(m<<shift,bitcast<u32>(-126-i32(shift)));
}
fn ieeeDivide(a: f32,b: f32) -> f32 {
  let av=bitcast<u32>(a);let bv=bitcast<u32>(b);let sign=(av^bv)&0x80000000u;
  if((av&0x7fffffffu)==0u){return bitcast<f32>(sign);}
  let an=normalized(av);let bn=normalized(bv);var ma=an.x;let mb=bn.x;
  var e=bitcast<i32>(an.y)-bitcast<i32>(bn.y);
  if(ma<mb){ma<<=1u;e-=1;}
  if(e>127){return bitcast<f32>(sign|0x7f800000u);}
  if(e < -150){return bitcast<f32>(sign);}
  if(e == -150){return bitcast<f32>(sign|select(0u,1u,ma>mb));}
  // Power-of-two divisors (samples, full coverage) need only exponent/bit shifts.
  if(mb==0x800000u){
    if(e>=-126){return bitcast<f32>(sign|((u32(e+126)<<23u)+ma));}
    let shift=u32(-126-e);var q=ma>>shift;let r=ma&((1u<<shift)-1u);let half=1u<<(shift-1u);
    if(r>half || (r==half&&(q&1u)!=0u)){q+=1u;}return bitcast<f32>(sign|q);
  }
  let bits=u32(min(23,e+149));var q=1u;var r=ma-mb;
  for(var i=0u;i<bits;i++){r<<=1u;q<<=1u;if(r>=mb){r-=mb;q|=1u;}}
  if(r*2u>mb || (r*2u==mb && (q&1u)!=0u)){q+=1u;}
  if(e < -126){return bitcast<f32>(sign|q);}
  // Adding instead of OR handles a rounded significand carrying into exponent.
  return bitcast<f32>(sign|((u32(e+126)<<23u)+q));
}
fn ieeeMultiply(a: f32,b: f32) -> f32 {
  let av=bitcast<u32>(a);let bv=bitcast<u32>(b);let sign=(av^bv)&0x80000000u;
  if((av&0x7fffffffu)==0u || (bv&0x7fffffffu)==0u){return bitcast<f32>(sign);}
  let an=normalized(av);let bn=normalized(bv);
  let al=an.x&4095u;let ah=an.x>>12u;let bl=bn.x&4095u;let bh=bn.x>>12u;
  let low=al*bl;let mid=(low>>12u)+al*bh+ah*bl;
  let hi=ah*bh+(mid>>12u);let lo=(low&4095u)|((mid&4095u)<<12u);
  let extra=select(0,1,hi>=0x800000u);let e=bitcast<i32>(an.y)+bitcast<i32>(bn.y)+extra;
  if(e>127){return bitcast<f32>(sign|0x7f800000u);}
  if(e < -150){return bitcast<f32>(sign);}
  let shift=u32(23+extra+max(0,-126-e));
  var q=0u;var halfway=false;var sticky=false;
  if(shift>=24u){
    let s=shift-24u;q=hi>>s;
    if(s==0u){halfway=(lo&0x800000u)!=0u;sticky=(lo&0x7fffffu)!=0u;}
    else{halfway=((hi>>(s-1u))&1u)!=0u;sticky=(lo!=0u)||((hi&((1u<<(s-1u))-1u))!=0u);}
  }else{q=(hi<<1u)|(lo>>23u);halfway=(lo&0x400000u)!=0u;sticky=(lo&0x3fffffu)!=0u;}
  if(halfway&&(sticky||(q&1u)!=0u)){q+=1u;}
  if(e < -126){return bitcast<f32>(sign|q);}
  return bitcast<f32>(sign|((u32(e+126)<<23u)+q));
}
@group(0) @binding(0) var<storage,read> raw: array<vec4f>;
@group(0) @binding(1) var<storage,read> normal: array<vec4f>;
@group(0) @binding(2) var<storage,read> albedo: array<vec4f>;
@group(0) @binding(3) var<uniform> parameters: vec4u;
fn loadHdr(p: vec2u) -> vec4f {
  let i=p.x+(parameters.y-1u-p.y)*parameters.x;let samples=f32(parameters.z);
  let count=ieeeDivide(normal[i].w,samples);let hit=ieeeDivide(albedo[i].w,samples);
  if(count<=0.0){return vec4f(0);}
  let total=max(count,ieeeDivide(1.0,samples));let divisor=select(total,hit,hit>0.0);
  let c=raw[i];var v=vec4f(ieeeDivide(ieeeDivide(c.x,samples),divisor),ieeeDivide(ieeeDivide(c.y,samples),divisor),ieeeDivide(ieeeDivide(c.z,samples),divisor),ieeeDivide(ieeeDivide(c.w,samples),total));
  let coverage=clamp(ieeeDivide(hit,total),0.0,1.0);
  if(parameters.w!=0u && coverage>0.0){v=vec4f(ieeeMultiply(v.x,coverage),ieeeMultiply(v.y,coverage),ieeeMultiply(v.z,coverage),v.w);}
  return v;
}
