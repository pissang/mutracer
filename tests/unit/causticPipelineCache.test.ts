import {expect,it,vi} from 'vitest';
import {WGPUCausticLightPass} from '../../src/renderer/WGPUCausticLightPass';
import {gpu} from './shaderSourceFormattingFixture';

it('rebuilds an emitter when scene binding layouts change with unchanged shader text',async()=>{
 gpu();
 const compile=vi.fn(async()=>({}));
 const device={
  createBuffer:()=>({destroy(){}}),createBindGroupLayout:()=>({}),createPipelineLayout:()=>({}),
  createShaderModule:()=>({getCompilationInfo:async()=>({messages:[]})}),
  createComputePipeline:()=>({}),createComputePipelineAsync:compile
 } as unknown as GPUDevice;
 const pass=new WGPUCausticLightPass(device),first={},second={};
 await pass.prepare('same shader',[],false,first);
 await pass.prepare('same shader',[],false,first);
 expect(compile).toHaveBeenCalledTimes(1);
 await pass.prepare('same shader',[],false,second);
 expect(compile).toHaveBeenCalledTimes(2);
 pass.dispose();
});
