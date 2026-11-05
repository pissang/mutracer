import {easuShader} from './easu.wgsl.js';

export function easuDetailShader(separate = false) {
  return easuShader.replace('@vertex fn vertex', /* wgsl */ `
@group(0) @binding(2) var diffuseHi: texture_2d<f32>;
@group(0) @binding(3) var specularHi: texture_2d<f32>;
@group(0) @binding(4) var depthHi: texture_2d<f32>;
@group(0) @binding(5) var diffuseLo: texture_2d<f32>;
@group(0) @binding(6) var specularLo: texture_2d<f32>;
@group(0) @binding(7) var<uniform> detail: vec4f;
fn loadLow(image: texture_2d<f32>, p: vec2i) -> vec4f {
  return textureLoad(image,clamp(p,vec2i(0),vec2i(textureDimensions(image))-1),0);
}
fn detailDecode(c: vec3f) -> vec3f {
  let a=max(c,vec3f(0));
  return select(pow((a+0.055)/1.055,vec3f(2.4)),a/12.92,a<=vec3f(0.04045));
}
fn detailEncode(c: vec3f) -> vec3f {
  let a=max(c,vec3f(0));
  return select(1.055*pow(a,vec3f(1.0/2.4))-0.055,a*12.92,a<=vec3f(0.0031308));
}
@vertex fn vertex`).replace('  return clamp(result/total,lower,upper);', /* wgsl */ `
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
  let p=vec2i(position.xy);let size=vec2i(textureDimensions(depthHi));
  let d=textureLoad(diffuseHi,p,0);let s=textureLoad(specularHi,p,0);let z=textureLoad(depthHi,p,0).xy;
  var valid=min(min(d.a,s.a),min(diffuse.a,specular.a))>=detail.y && z.y>=detail.y;
  let radius=max(vec2i(1),vec2i(ceil(outputSize.xy/vec2f(textureDimensions(colorImage)))));
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let neighbor=textureLoad(depthHi,clamp(p+vec2i(x,y)*radius,vec2i(0),size-1),0).xy;
    valid=valid && neighbor.y>=detail.y && abs(neighbor.x-z.x)<=max(detail.w,detail.z*abs(z.x));
  }}
  if(!valid){return color;}
  let low=diffuse.rgb+specular.rgb;
  var ratio=clamp((d.rgb+s.rgb)/max(low,vec3f(detail.x)),vec3f(outputSize.z),vec3f(outputSize.w));
  ${separate ? `
  // Estimate beauty lobe shares from low albedo; no separate beauty lobes are available.
  let share=diffuse.rgb/max(low,vec3f(detail.x));
  let rd=clamp(d.rgb/max(diffuse.rgb,vec3f(detail.x)),vec3f(outputSize.z),vec3f(outputSize.w));
  let rs=clamp(s.rgb/max(specular.rgb,vec3f(detail.x)),vec3f(outputSize.z),vec3f(outputSize.w));
  ratio=share*rd+(vec3f(1)-share)*rs;` : ''}
  ratio=select(vec3f(1),ratio,low>vec3f(detail.x));
  // Albedo ratios are linear; the composed image is sRGB encoded (extended above 1).
  return vec4f(detailEncode(detailDecode(color.rgb)*ratio),color.a);`);
}

// Exact box overlap integrates noninteger footprints instead of point sampling.
export const albedoDownsampleShader = /* wgsl */ `
@group(0) @binding(0) var diffuse: texture_2d<f32>;
@group(0) @binding(1) var specular: texture_2d<f32>;
@group(0) @binding(2) var<uniform> outputSize: vec4f;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p=vec2f(f32((index<<1u)&2u),f32(index&2u));return vec4f(p*2.0-1.0,0,1);
}
struct Result {@location(0) diffuse: vec4f, @location(1) specular: vec4f,}
@fragment fn fragment(@builtin(position) p: vec4f) -> Result {
  let scale=vec2f(textureDimensions(diffuse))/outputSize.xy;
  let start=floor(p.xy)*scale;let end=start+scale;
  var d=vec4f(0);var s=vec4f(0);
  for(var y=i32(floor(start.y));y<i32(ceil(end.y));y++){
    for(var x=i32(floor(start.x));x<i32(ceil(end.x));x++){
      let overlap=max(vec2f(0),min(vec2f(vec2i(x+1,y+1)),end)-max(vec2f(vec2i(x,y)),start));let weight=overlap.x*overlap.y;
      let a=textureLoad(diffuse,vec2i(x,y),0);let b=textureLoad(specular,vec2i(x,y),0);
      d+=vec4f(a.rgb*a.a,a.a)*weight;s+=vec4f(b.rgb*b.a,b.a)*weight;
    }
  }
  var result: Result;
  result.diffuse=vec4f(d.rgb/max(d.a,1e-8),d.a/(scale.x*scale.y));
  result.specular=vec4f(s.rgb/max(s.a,1e-8),s.a/(scale.x*scale.y));return result;
}
`;
