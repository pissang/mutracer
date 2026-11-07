// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
R"MT_SHADER(
// HgiMetal 26.03 enables fast math unconditionally, and Metal has no double.
// Integer IEEE arithmetic preserves the existing CPU float color operations
// and double projection, including round-to-nearest-even at each operation.
// This shader needs 64-bit integers (available on our Metal target).
#define U64 uint64_t
#if defined(ARCH_GFX_METAL)
#define floatBitsToUint(x) as_type<uint>(x)
#define uintBitsToFloat(x) as_type<float>(x)
#endif
#define ONE U64(1)
#define SIGN (ONE<<63)
#define FRAC ((ONE<<52)-ONE)
#define INF (U64(2047)<<52)
U64 jam(U64 a, int n) {
  if(n<=0)return a;
  if(n>=64)return U64(a!=0);
  return (a>>n)|U64((a&((ONE<<n)-ONE))!=0);
}
// m has 53 significant bits plus guard, round and sticky bits.
U64 rounded(U64 sign, int e, U64 m) {
  if(e<=0){m=jam(m,1-e);e=0;}
  U64 q=m>>3; uint r=uint(m&U64(7));
  if(r>4 || (r==4 && (q&ONE)!=0))q++;
  if(q>=(ONE<<53)){q>>=1;e++;}
  if(e==0 && q>=(ONE<<52))e=1;
  if(e>=2047)return sign|INF;
  return sign|(U64(e)<<52)|(q&FRAC);
}
U64 sum64(U64 a,U64 b,bool odd) {
  if((a&~SIGN)==0)return b;
  if((b&~SIGN)==0)return a;
  if((a&~SIGN)<(b&~SIGN)){U64 t=a;a=b;b=t;}
  int ea=int((a>>52)&U64(2047)), eb=int((b>>52)&U64(2047));
  if(ea==2047)return a;
  U64 ma=(a&FRAC)|(ea==0?U64(0):(ONE<<52));
  U64 mb=(b&FRAC)|(eb==0?U64(0):(ONE<<52));
  ea=max(ea,1);eb=max(eb,1);
  ma<<=3;mb=jam(mb<<3,ea-eb);
  U64 m=((a^b)&SIGN)==0?ma+mb:ma-mb;
  if(m==0)return U64(0);
  if(m>=(ONE<<56)){m=jam(m,1);ea++;}
  while(m<(ONE<<55) && ea>1){m<<=1;ea--;}
  if(ea==1 && m<(ONE<<55))ea=0;
  // Round-to-odd retains the direction of discarded bits before an f32 FMA
  // result is rounded. This avoids double rounding through our f64 carrier.
  if(odd) {
    U64 q=m>>3;if((m&U64(7))!=0)q|=ONE;
    return (a&SIGN)|(U64(ea)<<52)|(q&FRAC);
  }
  return rounded(a&SIGN,ea,m);
}
U64 plus64(U64 a,U64 b){return sum64(a,b,false);}
U64 times64(U64 a,U64 b) {
  U64 sign=(a^b)&SIGN;
  if((a&~SIGN)==0 || (b&~SIGN)==0)return sign;
  int ea=int((a>>52)&U64(2047)),eb=int((b>>52)&U64(2047));
  U64 ma=(a&FRAC)|(ea==0?U64(0):(ONE<<52));
  U64 mb=(b&FRAC)|(eb==0?U64(0):(ONE<<52));
  if(ea==2047 || eb==2047)return sign|INF;
  ea=max(ea,1);eb=max(eb,1);
  while(ma<(ONE<<52)){ma<<=1;ea--;}
  while(mb<(ONE<<52)){mb<<=1;eb--;}
  U64 mask=(ONE<<32)-ONE, al=ma&mask,ah=ma>>32,bl=mb&mask,bh=mb>>32;
  U64 p=al*bl, mid=(p>>32)+al*bh+ah*bl;
  U64 lo=(p&mask)|(mid<<32),hi=ah*bh+(mid>>32);
  int extra=hi>=(ONE<<41)?1:0,shift=49+extra;
  U64 m=(lo>>shift)|(hi<<(64-shift));
  m|=U64((lo&((ONE<<shift)-ONE))!=0);
  return rounded(sign,ea+eb-1023+extra,m);
}
U64 divide64(U64 a,U64 b) {
  U64 sign=(a^b)&SIGN;
  if((a&~SIGN)==0)return sign;
  if((b&~SIGN)==0)return sign|INF;
  int ea=int((a>>52)&U64(2047)),eb=int((b>>52)&U64(2047));
  U64 ma=(a&FRAC)|(ea==0?U64(0):(ONE<<52));
  U64 mb=(b&FRAC)|(eb==0?U64(0):(ONE<<52));
  ea=max(ea,1);eb=max(eb,1);
  while(ma<(ONE<<52)){ma<<=1;ea--;}
  while(mb<(ONE<<52)){mb<<=1;eb--;}
  int e=ea-eb+1023;
  if(ma<mb){ma<<=1;e--;}
  U64 q=0;
  for(int i=0;i<56;i++) {
    q<<=1;if(ma>=mb){q|=ONE;ma-=mb;}ma<<=1;
  }
  return rounded(sign,e,q|U64(ma!=0));
}
U64 from32(uint a) {
  U64 sign=U64(a&0x80000000u)<<32;
  uint e=(a>>23)&255u,m=a&0x7fffffu;
  if(e==255u)return sign|INF|(U64(m)<<29);
  if(e==0 && m==0)return sign;
  int exponent=int(e)+896;
  if(e==0){exponent=897;while(m<0x800000u){m<<=1;exponent--;}m&=0x7fffffu;}
  return sign|(U64(exponent)<<52)|(U64(m)<<29);
}
uint to32(U64 a) {
  uint sign=uint(a>>32)&0x80000000u;
  int e=int((a>>52)&U64(2047))-896;
  if((a&~SIGN)==0)return sign;
  if(e>=255)return sign|0x7f800000u;
  U64 m=(a&FRAC)|(ONE<<52);
  int shift=29+max(0,1-e);
  if(shift>=64)return sign;
  U64 q=m>>shift,r=m&((ONE<<shift)-ONE),halfway=ONE<<(shift-1);
  if(r>halfway || (r==halfway && (q&ONE)!=0))q++;
  if(e<=0)return sign|uint(q);
  return sign|((uint(e-1)<<23)+uint(q));
}
float add32(float a,float b){return uintBitsToFloat(to32(plus64(from32(floatBitsToUint(a)),from32(floatBitsToUint(b)))));}
float mul32(float a,float b){return uintBitsToFloat(to32(times64(from32(floatBitsToUint(a)),from32(floatBitsToUint(b)))));}
float fma32(float a,float b,float c){return uintBitsToFloat(to32(sum64(times64(from32(floatBitsToUint(a)),from32(floatBitsToUint(b))),from32(floatBitsToUint(c)),true)));}
U64 join64(uvec2 p){return U64(p.x)|(U64(p.y)<<32);}
void main() {
  ivec2 dst=ivec2(hd_GlobalInvocationID.xy);
  if(any(greaterThanEqual(dst,ivec2(dimensions.xy))))return;
  if(scaleValue.y!=0.0) {
    HgiSet_color(dst,vec4(mul32(clearValue.x,clearValue.w),mul32(clearValue.y,clearValue.w),
                          mul32(clearValue.z,clearValue.w),clearValue.w));
    HgiSet_depth(dst,vec4(1,0,0,0));return;
  }
  ivec2 src=ivec2(min(dimensions.z-1,uint(mul32(float(dst.x),scaleValue.x))),
    min(dimensions.w-1,uint(mul32(float(dimensions.y-1-uint(dst.y)),scaleValue.x))));
  vec4 v=HgiTexelFetch_hdr(src);
  float a=clamp(v.w,0.0,1.0),inverse=add32(1.0,-a);
  vec4 c;
  c.x=fma32(v.x,a,mul32(mul32(clearValue.x,clearValue.w),inverse));
  c.y=fma32(v.y,a,mul32(mul32(clearValue.y,clearValue.w),inverse));
  c.z=fma32(v.z,a,mul32(mul32(clearValue.z,clearValue.w),inverse));
  c.w=fma32(clearValue.w,inverse,a);
  HgiSet_color(dst,c);
  vec4 z=vec4(0);
  if(scaleValue.z!=0.0)z=HgiTexelFetch_distance(src);
  float depth=1.0;
  if(z.w>0.0) {
    U64 d=from32(floatBitsToUint(-z.x));
    U64 clipZ=plus64(times64(d,join64(projectionZ.xy)),join64(projectionZ.zw));
    U64 clipW=plus64(times64(d,join64(projectionW.xy)),join64(projectionW.zw));
    U64 projected=times64(plus64(divide64(clipZ,clipW),U64(1023)<<52),U64(1022)<<52);
    depth=clamp(uintBitsToFloat(to32(projected)),0.0,1.0);
  }
  HgiSet_depth(dst,vec4(depth,0,0,0));
}
)MT_SHADER"
