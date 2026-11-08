import {describe,it,expect} from 'vitest';
import {MaterialGraph} from '@meimu/mutracer';
import {parseMaterialXGraph} from '../src/engine/materialxGraph';
import {planDisplacement,quantizeHeight,type BakeImage} from '../src/engine/materialxDisplacement';
import {bakeHeightCPU,sampleBakeImage,bakeImageInfo} from '../src/engine/materialxBake';
import {loadMaterialXDisplacement} from '../src/engine/materialxFiles';
const doc=(nodes:string,height:string,scale='1')=>`<materialx version="1.39">${nodes}<standard_surface name="S" type="surfaceshader"/><displacement name="D" type="displacementshader"><input name="displacement" type="float" nodename="${height}"/><input name="scale" type="float" value="${scale}"/></displacement><surfacematerial name="M"><input name="surfaceshader" type="surfaceshader" nodename="S"/><input name="displacementshader" type="displacementshader" nodename="D"/></surfacematerial></materialx>`;
const image='<image name="h" type="float"><input name="file" type="filename" value="height.png"/></image>';
describe('MaterialX height displacement',()=>{
 it('packs exact image offsets beyond the consecutive Float32 integer range',()=>{
  const metadata={width:4097,height:4097,srgb:false,wrapS:'repeat' as const,wrapT:'repeat' as const};
  const {infos,pixelCount}=bakeImageInfo([metadata,{...metadata,width:1,height:1}]);
  expect(new Uint32Array(infos.buffer)[10]).toBe(4097*4097);expect(pixelCount).toBe(4097*4097+1);
 });
 it('maps an affine image without decoding or resampling the file',async()=>{
  const m=parseMaterialXGraph(doc(image+'<multiply name="gain" type="float"><input name="in1" type="float" nodename="h"/><input name="in2" type="float" value="2"/></multiply><subtract name="offset" type="float"><input name="in1" type="float" nodename="gain"/><input name="in2" type="float" value="0.25"/></subtract>','offset','0.1'));
  expect(m.displacement?.mode).toBe('direct');expect(m.warnings).toEqual([]);
  const file=new Blob(['original image']),result=await loadMaterialXDisplacement(m,{path:'m.mtlx',text:'',resolve:()=>file});
  expect(result?.file).toBe(file);expect(result?.values.displacementScale).toBeCloseTo(0.2);expect(result?.values.displacementBias).toBeCloseTo(-0.025);
 });
 it('bakes multi-image UV math and rejects geometry-dependent or mixed-UV heights',()=>{
  const m=parseMaterialXGraph(doc(image+image.replace('name="h"','name="h2"')+'<mix name="blend" type="float"><input name="fg" type="float" nodename="h"/><input name="bg" type="float" nodename="h2"/><input name="mix" type="float" value="0.3"/></mix>','blend'));
  expect(m.displacement?.mode).toBe('bake');
  const position=parseMaterialXGraph(doc('<position name="p" type="vector3"/><extract name="x" type="float"><input name="in" type="vector3" nodename="p"/></extract>','x'));
  expect(position.displacement?.mode).toBe('fallback');expect(position.warnings).toContainEqual(expect.stringContaining('non-UV geometry'));
  const mixed=new MaterialGraph({nodes:[{id:'u0',category:'texcoord',type:'vector2'},{id:'u1',category:'texcoord',type:'vector2',inputs:{index:{type:'integer',value:1}}},{id:'p',category:'dotproduct',type:'float',inputs:{in1:{type:'vector2',connection:{node:'u0'}},in2:{type:'vector2',connection:{node:'u1'}}}}],terminal:{specularRoughness:{node:'p'}}});
  expect(planDisplacement(mixed).reason).toContain('UV0 and UV1');
 });
 it('keeps affine UV tiling and height remapping on the original image',async()=>{
  const nodes='<texcoord name="uv" type="vector2"/><multiply name="tile" type="vector2"><input name="in1" type="vector2" nodename="uv"/><input name="in2" type="float" value="3"/></multiply>'+image.replace('</image>','<input name="texcoord" type="vector2" nodename="tile"/></image>')+'<mix name="remap" type="float"><input name="bg" type="float" value="-1"/><input name="fg" type="float" value="2"/><input name="mix" type="float" nodename="h"/></mix>';
  const m=parseMaterialXGraph(doc(nodes,'remap'));
  expect(m.displacement?.mode).toBe('direct');const file=new Blob(['original']),result=await loadMaterialXDisplacement(m,{text:'',path:'m.mtlx',resolve:()=>file});
  expect(result?.file).toBe(file);expect(result?.transform?.uvScale).toEqual([3,3]);expect(result?.values).toEqual({displacementScale:3,displacementBias:-1});
 });
 it('evaluates texel centers with the source UV orientation and Float32 output',()=>{
  const graph=new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2'},{id:'x',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}},index:{type:'integer',value:1}}}],terminal:{specularRoughness:{node:'x'}}});
  expect(Array.from(bakeHeightCPU(graph,[],2,2).heights)).toEqual([.75,.75,.25,.25]);
 });
 it('accepts a uniform connected UV1 selector',()=>{
  const graph=new MaterialGraph({nodes:[{id:'index',category:'constant',type:'integer',inputs:{value:{type:'integer',value:1}}},{id:'uv',category:'texcoord',type:'vector2',inputs:{index:{type:'integer',connection:{node:'index'}}}},{id:'x',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}],terminal:{specularRoughness:{node:'x'}}});
  expect(planDisplacement(graph)).toEqual(expect.objectContaining({mode:'bake',uvChannel:1}));
  expect(Array.from(bakeHeightCPU(graph,[],2,1).heights)).toEqual([.25,.75]);
 });
 it('samples linear color after bilinear filtering with repeat, clamp and mirror',()=>{
  const im:BakeImage={node:'i',width:2,height:1,pixels:new Uint8ClampedArray([0,0,0,255,255,255,255,255]),srgb:false,wrapS:'repeat',wrapT:'repeat'};
  expect(sampleBakeImage(im,[0,.5])[0]).toBe(.5);
  expect(sampleBakeImage({...im,wrapS:'clamp-to-edge'},[-1,.5])[0]).toBe(0);
  expect(sampleBakeImage({...im,wrapS:'mirrored-repeat'},[1.25,.5])[0]).toBe(1);
  expect(sampleBakeImage({...im,srgb:true},[.5,.5])[0]).toBeCloseTo(.21404114);
 });
 it('preserves signed extrema and bounds 8-bit height error, including flat ranges',()=>{
  const heights=new Float32Array([-2,-1.12,0,1.53,4]),q=quantizeHeight(heights);
  expect(q.scale).toBe(6);expect(q.bias).toBe(-2);expect(q.pixels[0]).toBe(0);expect(q.pixels[16]).toBe(255);
  heights.forEach((h,i)=>expect(Math.abs(q.pixels[i*4]/255*q.scale+q.bias-h)).toBeLessThanOrEqual(q.maxError));
  expect(quantizeHeight(new Float32Array([-.3,-.3])).scale).toBe(0);
  expect(()=>quantizeHeight(new Float32Array([NaN]))).toThrow('non-finite');
 });
});
