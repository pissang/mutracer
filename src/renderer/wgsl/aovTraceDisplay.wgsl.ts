import original from './aovTrace.wgsl.js';
import {aovCompactStorage} from './aovCompact.wgsl.js';

// Web-only storage specialization. The default shader (also used by native)
// remains byte-identical; geometry/material evaluation comes from that source.
export default aovCompactStorage + '\noverride AOV_DISPLAY: bool = false;\n' + original
  .replace('var<storage, read_write> aovAccum: array<AovAccumulation>;', 'var<storage, read_write> aovAccum: array<u32>;')
  .replace('fn aovMatrix(', /* wgsl */ `fn aovLoad(index: u32) -> AovAccumulation {
  if(AOV_COMPACT){
    let o=index*6u;
    return AovAccumulation(vec4f(bitcast<f32>(aovAccum[o]),0,0,0),vec4f(0,0,0,bitcast<f32>(aovAccum[o+1u])),
      aovUnpack(vec2u(aovAccum[o+2u],aovAccum[o+3u])),aovUnpack(vec2u(aovAccum[o+4u],aovAccum[o+5u])));
  }
  let o=index*16u;
  return AovAccumulation(bitcast<vec4f>(vec4u(aovAccum[o],aovAccum[o+1u],aovAccum[o+2u],aovAccum[o+3u])),
    bitcast<vec4f>(vec4u(aovAccum[o+4u],aovAccum[o+5u],aovAccum[o+6u],aovAccum[o+7u])),
    bitcast<vec4f>(vec4u(aovAccum[o+8u],aovAccum[o+9u],aovAccum[o+10u],aovAccum[o+11u])),
    bitcast<vec4f>(vec4u(aovAccum[o+12u],aovAccum[o+13u],aovAccum[o+14u],aovAccum[o+15u])));
}
fn aovStore(index: u32,pixel: AovAccumulation){
  if(AOV_COMPACT){
    let o=index*6u;let d=aovPack(pixel.diffuse);let s=aovPack(pixel.specular);
    aovAccum[o]=bitcast<u32>(pixel.depthRoughness.x);aovAccum[o+1u]=bitcast<u32>(pixel.position.w);
    aovAccum[o+2u]=d.x;aovAccum[o+3u]=d.y;aovAccum[o+4u]=s.x;aovAccum[o+5u]=s.y;
  }else{
    let lanes=array<vec4f,4>(pixel.depthRoughness,pixel.position,pixel.diffuse,pixel.specular);
    for(var lane=0u;lane<4u;lane++){for(var channel=0u;channel<4u;channel++){aovAccum[index*16u+lane*4u+channel]=bitcast<u32>(lanes[lane][channel]);}}
  }
}
fn aovMatrix(`)
  .replace('if (sample == 0u) { aovAccum[index] = AovAccumulation(); }', 'var pixel=AovAccumulation(); if(sample>0u){pixel=aovLoad(index);}')
  .replace('if (!aovSurface(ray, &si, &material)) { return; }', 'if (!aovSurface(ray, &si, &material)) { aovStore(index,pixel); return; }')
  .replace(/aovAccum\[index\]\./g, 'pixel.')
  .replace('pixel.position += vec4f(si.position, 1.0);', 'pixel.position += vec4f(si.position, 1.0); aovStore(index,pixel);')
  .replace('(material.transmissionDispersionScale > 0.0);', '(material.transmissionDispersionScale > 0.0) | (AOV_DISPLAY && material.transmissionWeight > 0.0);');
