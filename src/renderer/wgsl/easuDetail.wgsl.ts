import {easuShader} from './easu.wgsl.js';
import {composeDefine} from './compose.frag.wgsl.js';

/** Scene-linear log2 range covered by the tone lookup table. */
export const TONE_LUT_LOG2 = [-24, 24] as const;
export const TONE_LUT_SIZE = 1024;
/** Detail compensation defaults and fixed regularizers shared by the Web and native passes. */
export const EASU_DETAIL = {
  ratioRange: [0.7, 1.43] as const, depthThreshold: 0.02, coverageThreshold: 0.95,
  // Albedo below this is treated as black; relative depth tolerance floor.
  minimumAlbedo: 1e-3, depthTolerance: 1e-4,
  // Regularizes the local albedo variance of the albedo-radiance fit, in squared albedo units.
  guidedEpsilon: 1e-4,
};

// Tone table lookups and display encoding shared by the detail passes; tone.x is the maximum display value.
const toneCodingDefine = /* wgsl */ `
// Row 0: display value of a gray scene-linear input at TONE_LUT_LOG2 stops, per channel.
// Row 1: log2 scene-linear input per channel for display values (sqrt-spaced up to tone.x).
@group(0) @binding(8) var toneLut: texture_2d<f32>;
@group(0) @binding(9) var<uniform> tone: vec4f;
fn toneLutRow(row: i32, u: vec3f) -> vec3f {
  let last=f32(textureDimensions(toneLut).x-1u);let p=clamp(u,vec3f(0),vec3f(1))*last;
  let i=vec3i(floor(p));let j=min(i+1,vec3i(i32(last)));let f=p-floor(p);
  var result=vec3f(0);
  for(var c=0;c<3;c++){result[c]=mix(textureLoad(toneLut,vec2i(i[c],row),0)[c],textureLoad(toneLut,vec2i(j[c],row),0)[c],f[c]);}
  return result;
}
fn toneForward(log2x: vec3f) -> vec3f {return toneLutRow(0,(log2x-(${TONE_LUT_LOG2[0]}.0))/${TONE_LUT_LOG2[1]-TONE_LUT_LOG2[0]}.0);}
fn toneInverse(d: vec3f) -> vec3f {return toneLutRow(1,sqrt(max(d,vec3f(0))/tone.x));}
// Applies a scene-linear albedo ratio before the display transform: displayed
// RGB is mapped back to scene-linear per channel, scaled and mapped forward, so
// curve shoulders and toes respond as the tone mapper would. Only the change is
// added to the displayed value, which keeps it exact where the ratio is 1.
fn toneAware(d: vec3f, ratio: vec3f) -> vec3f {
  let x=toneInverse(d);
  let changed=max(d+toneForward(x+log2(max(ratio,vec3f(1e-6))))-toneForward(x),vec3f(0));
  return select(changed,d,abs(ratio-vec3f(1))<vec3f(1e-4));
}
fn detailDecode(c: vec3f) -> vec3f {
  let a=max(c,vec3f(0));
  return select(pow((a+0.055)/1.055,vec3f(2.4)),a/12.92,a<=vec3f(0.04045));
}
fn detailEncode(c: vec3f) -> vec3f {
  let a=max(c,vec3f(0));
  return select(1.055*pow(a,vec3f(1.0/2.4))-0.055,a*12.92,a<=vec3f(0.0031308));
}
`;

/**
 * guided: scale only the albedo-correlated part of local scene-linear radiance (default);
 * separate: lobe-share approximation; silhouettes: depth-guided edge reconstruction.
 * The last two are retained for comparisons.
 */
export function easuDetailShader(separate = false, silhouettes = false, guided = true) {
  return easuShader.replace(`@vertex fn vertex`, /* wgsl */ `
@group(0) @binding(2) var diffuseHi: texture_2d<f32>;
@group(0) @binding(3) var specularHi: texture_2d<f32>;
@group(0) @binding(4) var depthHi: texture_2d<f32>;
@group(0) @binding(5) var diffuseLo: texture_2d<f32>;
@group(0) @binding(6) var specularLo: texture_2d<f32>;
@group(0) @binding(7) var<uniform> detail: vec4f;
${silhouettes ? '@group(0) @binding(10) var depthLo: texture_2d<f32>;' : ''}
${guided ? '@group(0) @binding(11) var slopeLo: texture_2d<f32>;\n@group(0) @binding(12) var offsetLo: texture_2d<f32>;' : ''}
fn loadLow(image: texture_2d<f32>, p: vec2i) -> vec4f {
  return textureLoad(image,clamp(p,vec2i(0),vec2i(textureDimensions(image))-1),0);
}
${toneCodingDefine}
@vertex fn vertex`).replace(`return clamp(result/total,lower,upper);`, /* wgsl */ `
  let color=clamp(result/total,lower,upper);
  var diffuse=vec4f(0);var specular=vec4f(0);
  for(var i=0u;i<12u;i++){
    // Identical direction, phase, support and weights as beauty.
    let weight=easuWeight(vec2f(offsets[i])-phase,direction,length,lobe);
    diffuse+=loadLow(diffuseLo,base+offsets[i])*weight;
    specular+=loadLow(specularLo,base+offsets[i])*weight;
  }
  let dlo=min(min(loadLow(diffuseLo,base),loadLow(diffuseLo,base+vec2i(1,0))),min(loadLow(diffuseLo,base+vec2i(0,1)),loadLow(diffuseLo,base+vec2i(1,1))));
  let dhi=max(max(loadLow(diffuseLo,base),loadLow(diffuseLo,base+vec2i(1,0))),max(loadLow(diffuseLo,base+vec2i(0,1)),loadLow(diffuseLo,base+vec2i(1,1))));
  let slo=min(min(loadLow(specularLo,base),loadLow(specularLo,base+vec2i(1,0))),min(loadLow(specularLo,base+vec2i(0,1)),loadLow(specularLo,base+vec2i(1,1))));
  let shi=max(max(loadLow(specularLo,base),loadLow(specularLo,base+vec2i(1,0))),max(loadLow(specularLo,base+vec2i(0,1)),loadLow(specularLo,base+vec2i(1,1))));
  diffuse=clamp(diffuse/total,dlo,dhi);specular=clamp(specular/total,slo,shi);
  ${guided ? `var slope=vec4f(0);var intercept=vec4f(0);
  for(var i=0u;i<12u;i++){
    let weight=easuWeight(vec2f(offsets[i])-phase,direction,length,lobe);
    slope+=loadLow(slopeLo,base+offsets[i])*weight;intercept+=loadLow(offsetLo,base+offsets[i])*weight;
  }
  var lowerSlope=loadLow(slopeLo,base);var upperSlope=lowerSlope;var lowerIntercept=loadLow(offsetLo,base);var upperIntercept=lowerIntercept;
  for(var k=1;k<4;k++){
    let q=base+vec2i(k&1,k>>1u);let a=loadLow(slopeLo,q);let b=loadLow(offsetLo,q);
    lowerSlope=min(lowerSlope,a);upperSlope=max(upperSlope,a);lowerIntercept=min(lowerIntercept,b);upperIntercept=max(upperIntercept,b);
  }
  slope=clamp(slope/total,lowerSlope,upperSlope);intercept=clamp(intercept/total,lowerIntercept,upperIntercept);` : ''}
  let p=vec2i(position.xy);let size=vec2i(textureDimensions(depthHi));
  let d=textureLoad(diffuseHi,p,0);let s=textureLoad(specularHi,p,0);let z=textureLoad(depthHi,p,0).xy;
  let tolerance=max(detail.w,detail.z*abs(z.x));
  let radius=max(vec2i(1),vec2i(ceil(outputSize.xy/vec2f(textureDimensions(colorImage)))));
  // A silhouette changes hit coverage or breaks the planarity of inverse depth,
  // which is linear in screen space on planes; sloped planes are not silhouettes.
  var silhouette=false;let inverse=1.0/max(z.x,1e-6);
  let directions=array<vec2i,4>(vec2i(1,0),vec2i(0,1),vec2i(1,1),vec2i(1,-1));
  for(var k=0;k<4;k++){
    let a=textureLoad(depthHi,clamp(p+directions[k]*radius,vec2i(0),size-1),0).xy;
    let b=textureLoad(depthHi,clamp(p-directions[k]*radius,vec2i(0),size-1),0).xy;
    silhouette=silhouette || abs(a.y-z.y)>0.5 || abs(b.y-z.y)>0.5 ||
      (min(min(a.y,b.y),z.y)>0.0 && abs(1.0/max(a.x,1e-6)+1.0/max(b.x,1e-6)-2.0*inverse)>detail.z*inverse);
  }
  ${silhouettes ? `  // Transmissive and other unguided hits show surfaces behind their depth; keep EASU there.
  let guided=min(d.a,s.a)>=detail.y;
  if(silhouette && z.y>=0.5 && !guided){return color;}
  if(silhouette){
    // Silhouettes: estimate this surface's color from covered low-resolution neighbors
    // at a similar nearest depth, the background from uncovered ones, and mix them by
    // this pixel's full-resolution hit coverage, which keeps edges antialiased.
    let center=vec2i(round(point));var front=vec4f(0);var back=vec4f(0);var frontWeight=0.0;var backWeight=0.0;
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
      let q=center+vec2i(x,y);let offset=vec2f(q)-point;
      let lowDepth=loadLow(depthLo,q).xy;let spatial=exp(-dot(offset,offset));
      let similar=exp(-pow(abs(lowDepth.x-z.x)/tolerance,2.0));
      let sample=loadColor(q);let value=vec4f(detailDecode(sample.rgb),sample.a);
      let f=spatial*lowDepth.y*lowDepth.y*select(1.0,similar,z.y>0.0);let b=spatial*(1.0-lowDepth.y)*(1.0-lowDepth.y);
      front+=value*f;frontWeight+=f;back+=value*b;backWeight+=b;
    }}
    let haveFront=frontWeight>1e-3;let haveBack=backWeight>1e-3;
    if(!haveFront && !haveBack){return color;}
    var mixed=select(back/max(backWeight,1e-8),front/max(frontWeight,1e-8),haveFront);
    if(haveFront && haveBack){mixed=mix(back/backWeight,front/frontWeight,z.y);}
    return vec4f(detailEncode(mixed.rgb),mixed.a);
  }
` : '  if(silhouette){return color;}\n'}  let valid=min(min(d.a,s.a),min(diffuse.a,specular.a))>=detail.y && z.y>=detail.y;
  if(!valid){return color;}
  let low=diffuse.rgb+specular.rgb;
  var ratio=clamp((d.rgb+s.rgb)/max(low,vec3f(detail.x)),vec3f(outputSize.z),vec3f(outputSize.w));
  ${separate ? `
  // Estimate beauty lobe shares from low albedo; no separate beauty lobes are available.
  let share=diffuse.rgb/max(low,vec3f(detail.x));
  let rd=clamp(d.rgb/max(diffuse.rgb,vec3f(detail.x)),vec3f(outputSize.z),vec3f(outputSize.w));
  let rs=clamp(s.rgb/max(specular.rgb,vec3f(detail.x)),vec3f(outputSize.z),vec3f(outputSize.w));
  ratio=share*rd+(vec3f(1)-share)*rs;` : ''}
  ${guided ? `// Local radiance is modeled as slope * albedo + intercept. Only the albedo-correlated
  // part follows the full-resolution albedo; the intercept, such as specular highlights,
  // does not. Pure diffuse (zero intercept) reduces to the albedo ratio.
  let modeled=slope.rgb*low+intercept.rgb;
  ratio=select(ratio,clamp((slope.rgb*(d.rgb+s.rgb)+intercept.rgb)/max(modeled,vec3f(1e-8)),vec3f(outputSize.z),vec3f(outputSize.w)),modeled>vec3f(1e-8));` : ''}
  ratio=select(vec3f(1),ratio,low>vec3f(detail.x));
  // Albedo ratios are scene-linear; the composed image is tone mapped and sRGB encoded.
  return vec4f(detailEncode(toneAware(detailDecode(color.rgb),ratio)),color.a);`);
}

// Exact box overlap integrates noninteger footprints instead of point sampling.
export const albedoDownsampleShader = (depthOutput = false) => /* wgsl */ `
@group(0) @binding(0) var diffuse: texture_2d<f32>;
@group(0) @binding(1) var specular: texture_2d<f32>;
@group(0) @binding(2) var<uniform> outputSize: vec4f;
@group(0) @binding(3) var depth: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p=vec2f(f32((index<<1u)&2u),f32(index&2u));return vec4f(p*2.0-1.0,0,1);
}
struct Result {@location(0) diffuse: vec4f, @location(1) specular: vec4f, ${depthOutput ? '@location(2) depth: vec4f,' : ''}}
@fragment fn fragment(@builtin(position) p: vec4f) -> Result {
  let scale=vec2f(textureDimensions(diffuse))/outputSize.xy;
  let start=floor(p.xy)*scale;let end=start+scale;
  var d=vec4f(0);var s=vec4f(0);var nearest=3.4e38;var hits=0.0;
  for(var y=i32(floor(start.y));y<i32(ceil(end.y));y++){
    for(var x=i32(floor(start.x));x<i32(ceil(end.x));x++){
      let overlap=max(vec2f(0),min(vec2f(vec2i(x+1,y+1)),end)-max(vec2f(vec2i(x,y)),start));let weight=overlap.x*overlap.y;
      let a=textureLoad(diffuse,vec2i(x,y),0);let b=textureLoad(specular,vec2i(x,y),0);let z=textureLoad(depth,vec2i(x,y),0).xy;
      d+=vec4f(a.rgb*a.a,a.a)*weight;s+=vec4f(b.rgb*b.a,b.a)*weight;
      hits+=z.y*weight;if(z.y>0.0){nearest=min(nearest,z.x);}
    }
  }
  var result: Result;
  ${depthOutput ? 'result.depth=vec4f(select(0.0,nearest,hits>0.0),hits/(scale.x*scale.y),0,0);' : ''}
  result.diffuse=vec4f(d.rgb/max(d.a,1e-8),d.a/(scale.x*scale.y));
  result.specular=vec4f(s.rgb/max(s.a,1e-8),s.a/(scale.x*scale.y));return result;
}
`;

// Builds the tone lookup rows for the current grading and tone mapping.
// toneMappingParams: x mode, y maximum display value, z exposure, w 1 for extended output.
export const toneLutShader = /* wgsl */ `
@group(0) @binding(0) var<uniform> toneMappingParams: vec4f;
@group(0) @binding(1) var<uniform> colorGradingParams: vec4f;
${composeDefine}
fn toneGray(x: f32) -> vec3f {
  var v=gradeColor(vec3f(x)*toneMappingParams.z);
  if(toneMappingParams.w<0.5){v=applyToneMapping(v);}
  return v;
}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p=vec2f(f32((index<<1u)&2u),f32(index&2u));return vec4f(p*2.0-1.0,0,1);
}
@fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let u=floor(p.x)/${TONE_LUT_SIZE - 1}.0;
  if(p.y<1.0){return vec4f(toneGray(exp2(mix(${TONE_LUT_LOG2[0]}.0,${TONE_LUT_LOG2[1]}.0,u))),1);}
  let d=u*u*toneMappingParams.y;var result=vec3f(0);
  for(var c=0;c<3;c++){
    var lo=${TONE_LUT_LOG2[0]}.0;var hi=${TONE_LUT_LOG2[1]}.0;
    for(var i=0;i<28;i++){let mid=0.5*(lo+hi);if(toneGray(exp2(mid))[c]<d){lo=mid;}else{hi=mid;}}
    result[c]=0.5*(lo+hi);
  }
  return vec4f(result,1);
}
`;

// Per low-resolution pixel, fits scene-linear radiance x ~ slope * albedo + offset over a
// 3x3 window of guided samples, per channel (a guided-filter regression). Flat albedo
// gives slope ~0, so its radiance is not modulated; tone.y regularizes the variance.
export const guidedCoefficientShader = /* wgsl */ `
@group(0) @binding(0) var colorImage: texture_2d<f32>;
@group(0) @binding(1) var diffuseLo: texture_2d<f32>;
@group(0) @binding(2) var specularLo: texture_2d<f32>;
${toneCodingDefine}
fn loadAt(image: texture_2d<f32>, p: vec2i) -> vec4f {return textureLoad(image,clamp(p,vec2i(0),vec2i(textureDimensions(image))-1),0);}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p=vec2f(f32((index<<1u)&2u),f32(index&2u));return vec4f(p*2.0-1.0,0,1);
}
struct Result {@location(0) slope: vec4f, @location(1) offset: vec4f,}
@fragment fn fragment(@builtin(position) position: vec4f) -> Result {
  let center=vec2i(position.xy);
  var weight=0.0;var meanAlbedo=vec3f(0);var meanRadiance=vec3f(0);var meanProduct=vec3f(0);var meanSquare=vec3f(0);
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let q=center+vec2i(x,y);let d=loadAt(diffuseLo,q);let s=loadAt(specularLo,q);
    let w=step(0.5,min(d.a,s.a));let albedo=d.rgb+s.rgb;
    let radiance=exp2(toneInverse(detailDecode(loadAt(colorImage,q).rgb)));
    weight+=w;meanAlbedo+=albedo*w;meanRadiance+=radiance*w;meanProduct+=albedo*radiance*w;meanSquare+=albedo*albedo*w;
  }}
  var result: Result;
  if(weight<1.0){return result;}
  meanAlbedo/=weight;meanRadiance/=weight;meanProduct/=weight;meanSquare/=weight;
  let slope=max((meanProduct-meanAlbedo*meanRadiance)/(meanSquare-meanAlbedo*meanAlbedo+vec3f(tone.y)),vec3f(0));
  result.slope=vec4f(slope,1);result.offset=vec4f(meanRadiance-slope*meanAlbedo,1);
  return result;
}
`;
