import {afterEach,expect,it,vi} from 'vitest';
import {createEasuPass} from '../../src/renderer/easu';
import type {PostProcessContext} from '../../src/Display';

afterEach(()=>{vi.unstubAllGlobals();});
it.each([{ratioRange:[0,1]},{ratioRange:[2,1]},{coverageThreshold:0},{depthThreshold:NaN}])('rejects invalid detail controls %o',options=>{
 expect(()=>createEasuPass(options as never)).toThrow(RangeError);
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
  render:{getAovTexture:()=>image(14,10),_engine:{display:{toneMapping:'agx',toneMappingExposure:1,contrast:1,saturation:1,temperature:0,tint:0}}}} as unknown as PostProcessContext;
 // Two low-resolution albedo guides and one tone table per device; the table survives input resizes.
 const pass=createEasuPass({albedoDetail:true});pass(context);pass(context);expect(first.textures).toHaveLength(3);
 pass({...context,input:image(8,6)});expect(first.textures).toHaveLength(5);
 await vi.waitFor(()=>expect(first.textures[0].destroy).toHaveBeenCalledOnce());expect(first.textures[2].destroy).not.toHaveBeenCalled();
 pass({...context,device:second.device});await vi.waitFor(()=>expect(first.textures[3].destroy).toHaveBeenCalledOnce());expect(first.textures[2].destroy).toHaveBeenCalledOnce();
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
 const aovs={diffuseAlbedo:image(14,10),specularAlbedo:image(14,10),depth:image(14,10)};
 const context={device,encoder,input:image(7,5),output:image(14,10),width:7,height:5,
  render:{getAovTexture:(kind:keyof typeof aovs)=>aovs[kind],_engine:{display:{toneMapping:'agx',toneMappingExposure:1,contrast:1,saturation:1,temperature:0,tint:0}}}} as unknown as PostProcessContext;
 const downsamples=()=>labels.filter(label=>label==='Albedo area downsample').length;
 const pass=createEasuPass({albedoDetail:true});
 pass(context);pass(context);expect(downsamples()).toBe(1);expect(labels.filter(label=>label==='EASU tone table')).toHaveLength(1);expect(labels.filter(label=>label==='FSR 1 EASU')).toHaveLength(2);
 borrowedAovRevision.set(aovs.specularAlbedo,(borrowedAovRevision.get(aovs.specularAlbedo)??0)+1);
 pass(context);expect(downsamples()).toBe(2);
 pass({...context,input:image(8,6)});expect(downsamples()).toBe(3);
 pass.dispose();
});
it('declares the bindings the pass supplies in every EASU shader', async()=>{
 vi.stubGlobal('GPUShaderStage',{VERTEX:1,FRAGMENT:2,COMPUTE:4});
 const {makeShaderDataDefinitions}=await import('webgpu-utils');
 const {easuShader}=await import('../../src/renderer/wgsl/easu.wgsl');
 const {easuDetailShader,albedoDownsampleShader,toneLutShader}=await import('../../src/renderer/wgsl/easuDetail.wgsl');
 const bindings=(code:string)=>{const parsed=makeShaderDataDefinitions(code);
  return [...Object.values(parsed.uniforms),...Object.values(parsed.textures)].map(value=>(value as {binding:number}).binding).sort((a,b)=>a-b);};
 expect(bindings(easuShader)).toEqual([0,1]);
 for(const separate of [false,true]) {
  expect(bindings(easuDetailShader(separate))).toEqual([0,1,2,3,4,5,6,7,8,9]);
  expect(bindings(easuDetailShader(separate,true))).toEqual([0,1,2,3,4,5,6,7,8,9,10]);
 }
 for(const depth of [false,true]) expect(bindings(albedoDownsampleShader(depth))).toEqual([0,1,2,3]);
 expect(bindings(toneLutShader)).toEqual([0,1]);
});
