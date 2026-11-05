import {afterEach,expect,it,vi} from 'vitest';
import {createEasuPass, createEasuPassImpl} from '../../src/renderer/easu';
import type {PostProcessContext} from '../../src/Display';

afterEach(()=>{vi.unstubAllGlobals();});
it.each([{ratioRange:[0,1]},{ratioRange:[2,1]},{coverageThreshold:0},{depthThreshold:NaN}])('rejects invalid detail controls %o',options=>{
 expect(()=>createEasuPassImpl(options as never)).toThrow(RangeError);
});
it('accepts only albedoDetail publicly and warns once when the displayed render lacks detail AOVs',()=>{
 vi.stubGlobal('GPUBufferUsage',{UNIFORM:1});
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 expect(()=>createEasuPass({albedoDetail:true,ratioRange:[0,1]} as never)).not.toThrow();
 const image=(width:number,height:number)=>({width,height,format:'rgba8unorm',createView:()=>({})}) as unknown as GPUTexture;
 const device={createShaderModule:()=>({}),createRenderPipeline:()=>({getBindGroupLayout:()=>({})}),
  createBuffer:()=>({getMappedRange:()=>new ArrayBuffer(16),unmap(){},destroy(){}}),createBindGroup:()=>({}),queue:{onSubmittedWorkDone:async()=>{}}} as unknown as GPUDevice;
 const encoder={beginRenderPass:()=>({setPipeline(){},setBindGroup(){},draw(){},end(){}}),copyTextureToTexture(){}} as unknown as GPUCommandEncoder;
 const render={aovs:['depth','diffuseAlbedo','specularAlbedo'],aovResolution:'display',getAovTexture:()=>undefined};
 const context={device,encoder,input:image(7,5),output:image(14,10),width:7,height:5,render} as unknown as PostProcessContext;
 const pass=createEasuPass({albedoDetail:true});
 pass({...context,input:image(14,10)});expect(warn).not.toHaveBeenCalled();
 pass(context);pass(context);expect(warn).toHaveBeenCalledOnce();
 warn.mockClear();render.aovs=['depth','diffuseColor','specularColor'];
 const configured=createEasuPass({albedoDetail:true});configured(context);
 render.aovResolution='render';createEasuPass()(context);expect(warn).not.toHaveBeenCalled();
 warn.mockRestore();
});
it('reuses scratch at the input size and retires it after resize, device replacement and disposal',async()=>{
 vi.stubGlobal('GPUBufferUsage',{UNIFORM:1});vi.stubGlobal('GPUTextureUsage',{TEXTURE_BINDING:1,RENDER_ATTACHMENT:2});
 const image=(width:number,height:number)=>({width,height,format:'rgba16float',createView:()=>({}),destroy:vi.fn()}) as unknown as GPUTexture;
 const devices=()=>{
  const textures:GPUTexture[]=[];
  const device={createShaderModule:vi.fn(()=>({})),createRenderPipeline:vi.fn(()=>({getBindGroupLayout:()=>({})})),
   createBuffer:()=>({getMappedRange:()=>new ArrayBuffer(16),unmap(){},destroy:vi.fn()}),createBindGroup:()=>({}),
   createTexture:({size}:{size:number[]})=>{const value=image(size[0],size[1]);textures.push(value);return value;},
   createCommandEncoder:()=>({beginRenderPass:()=>({setPipeline(){},setBindGroup(){},draw(){},end(){}}),finish:()=>({})}),queue:{submit(){},onSubmittedWorkDone:vi.fn(async()=>{})}} as unknown as GPUDevice;
  return {device,textures};
 };
 const first=devices(),second=devices();
 const encoder={beginRenderPass:()=>({setPipeline(){},setBindGroup(){},draw(){},end(){}})} as unknown as GPUCommandEncoder;
 const context={device:first.device,encoder,input:image(7,5),output:image(14,10),width:7,height:5,
  render:{aovs:['depth','diffuseColor','specularColor'],aovResolution:'display',getAovTexture:()=>image(14,10),_engine:{display:{toneMapping:'agx',toneMappingExposure:1,contrast:1,saturation:1,temperature:0,tint:0}}}} as unknown as PostProcessContext;
 // Two low-resolution albedo guides, a tone table and two albedo-fit images per device;
 // only the tone table survives input resizes.
 const pass=createEasuPass({albedoDetail:true});pass(context);pass(context);expect(first.textures).toHaveLength(5);
 pass({...context,input:image(8,6)});expect(first.textures).toHaveLength(9);
 await vi.waitFor(()=>expect(first.textures[0].destroy).toHaveBeenCalledOnce());
 await vi.waitFor(()=>expect(first.textures[3].destroy).toHaveBeenCalledOnce());expect(first.textures[2].destroy).not.toHaveBeenCalled();
 pass({...context,device:second.device});await vi.waitFor(()=>expect(first.textures[7].destroy).toHaveBeenCalledOnce());expect(first.textures[2].destroy).toHaveBeenCalledOnce();
 pass.dispose();await vi.waitFor(()=>expect(second.textures[0].destroy).toHaveBeenCalledOnce());
});
it('downsamples albedo again only when the borrowed AOV contents change',async()=>{
 const {borrowedAovRevision}=await import('../../src/renderer/WGPUAov');
 vi.stubGlobal('GPUBufferUsage',{UNIFORM:1});vi.stubGlobal('GPUTextureUsage',{TEXTURE_BINDING:1,RENDER_ATTACHMENT:2});
 const image=(width:number,height:number)=>({width,height,format:'rgba16float',createView:()=>({}),destroy:vi.fn()}) as unknown as GPUTexture;
 const labels:string[]=[];
 const encoder={beginRenderPass:({label}:{label:string})=>{labels.push(label);return {setPipeline(){},setBindGroup(){},draw(){},end(){}};}} as unknown as GPUCommandEncoder;
 const device={createShaderModule:vi.fn(()=>({})),createRenderPipeline:vi.fn(()=>({getBindGroupLayout:()=>({})})),
  createBuffer:()=>({getMappedRange:()=>new ArrayBuffer(16),unmap(){},destroy:vi.fn()}),createBindGroup:()=>({}),
  createTexture:({size}:{size:number[]})=>image(size[0],size[1]),createCommandEncoder:()=>({...encoder,finish:()=>({})}),
  queue:{submit:vi.fn(),onSubmittedWorkDone:vi.fn(async()=>{})}} as unknown as GPUDevice;
 const aovs={diffuseColor:image(14,10),specularColor:image(14,10),depth:image(14,10)};
 const context={device,encoder,input:image(7,5),output:image(14,10),width:7,height:5,
  render:{aovs:Object.keys(aovs),aovResolution:'display',getAovTexture:(kind:keyof typeof aovs)=>aovs[kind],_engine:{display:{toneMapping:'agx',toneMappingExposure:1,contrast:1,saturation:1,temperature:0,tint:0}}}} as unknown as PostProcessContext;
 const downsamples=()=>labels.filter(label=>label==='Albedo area downsample').length;
 const pass=createEasuPass({albedoDetail:true});
 pass(context);pass(context);expect(downsamples()).toBe(1);expect(labels.filter(label=>label==='EASU tone table')).toHaveLength(1);expect(labels.filter(label=>label==='FSR 1 EASU')).toHaveLength(2);
 borrowedAovRevision.set(aovs.specularColor,(borrowedAovRevision.get(aovs.specularColor)??0)+1);
 pass(context);expect(downsamples()).toBe(2);
 pass({...context,input:image(8,6)});expect(downsamples()).toBe(3);
 pass.dispose();
});
it('declares the bindings the pass supplies in every EASU shader', async()=>{
 vi.stubGlobal('GPUShaderStage',{VERTEX:1,FRAGMENT:2,COMPUTE:4});
 const {makeShaderDataDefinitions}=await import('webgpu-utils');
 const {easuShader,areaDownsampleShader}=await import('../../src/renderer/wgsl/easu.wgsl');
 const {easuDetailShader,albedoDownsampleShader,toneLutShader,guidedCoefficientShader}=await import('../../src/renderer/wgsl/easuDetail.wgsl');
 const bindings=(code:string)=>{const parsed=makeShaderDataDefinitions(code);
  return [...Object.values(parsed.uniforms),...Object.values(parsed.textures)].map(value=>(value as {binding:number}).binding).sort((a,b)=>a-b);};
 expect(bindings(easuShader)).toEqual([0,1]);expect(bindings(areaDownsampleShader)).toEqual([0,1]);
 for(const separate of [false,true]) {
  expect(bindings(easuDetailShader(separate))).toEqual([0,1,2,3,4,5,6,7,8,9,11,12]);
  expect(bindings(easuDetailShader(separate,true))).toEqual([0,1,2,3,4,5,6,7,8,9,10,11,12]);
  expect(bindings(easuDetailShader(separate,false,false))).toEqual([0,1,2,3,4,5,6,7,8,9]);
 }
 expect(bindings(guidedCoefficientShader)).toEqual([0,1,2,8,9]);
 for(const depth of [false,true]) expect(bindings(albedoDownsampleShader(depth))).toEqual([0,1,2,3]);
 expect(bindings(toneLutShader)).toEqual([0,1]);
});

it('copies an input that already has the output size without creating pipelines',()=>{
 const copy=vi.fn();const device={createShaderModule:vi.fn(),createRenderPipeline:vi.fn(),createTexture:vi.fn()} as unknown as GPUDevice;
 const image=(width:number,height:number)=>({width,height,format:'rgba8unorm',createView:()=>({})}) as unknown as GPUTexture;
 const input=image(16,8),output=image(16,8);
 createEasuPass({albedoDetail:true})({device,encoder:{copyTextureToTexture:copy} as unknown as GPUCommandEncoder,input,output,width:16,height:8,render:{} as never});
 expect(copy).toHaveBeenCalledWith({texture:input},{texture:output},[16,8]);
 expect(device.createRenderPipeline).not.toHaveBeenCalled();expect(device.createTexture).not.toHaveBeenCalled();
});
it('area-averages a larger input instead of running EASU or reading AOVs',()=>{
 vi.stubGlobal('GPUBufferUsage',{UNIFORM:1});
 const labels:string[]=[],getAovTexture=vi.fn();
 const device={createShaderModule:vi.fn(()=>({})),createRenderPipeline:vi.fn(()=>({getBindGroupLayout:()=>({})})),createTexture:vi.fn(),
  createBuffer:()=>({getMappedRange:()=>new ArrayBuffer(16),unmap(){},destroy:vi.fn()}),createBindGroup:()=>({}),queue:{onSubmittedWorkDone:async()=>{}}} as unknown as GPUDevice;
 const encoder={beginRenderPass:({label}:{label:string})=>{labels.push(label);return {setPipeline(){},setBindGroup(){},draw(){},end(){}};}} as unknown as GPUCommandEncoder;
 const image=(width:number,height:number)=>({width,height,format:'rgba8unorm',createView:()=>({})}) as unknown as GPUTexture;
 createEasuPass({albedoDetail:true})({device,encoder,input:image(3808,2160),output:image(3144,1788),width:3808,height:2160,render:{getAovTexture} as never});
 expect(labels).toEqual(['Area downsample']);expect(getAovTexture).not.toHaveBeenCalled();expect(device.createTexture).not.toHaveBeenCalled();
});
