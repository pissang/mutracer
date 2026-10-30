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

it.each([
 [1, 65535, [1, 1]],
 [65535 * 64, 65535, [65535, 1]],
 [65535 * 64 + 1, 65535, [65535, 2]],
 [3024 * 1792, 65535, [65535, 2]],
 [129, 2, [2, 2]]
] as const)('accumulates %s pixels within the %s workgroup limit', (pixels, limit, expected) => {
 const target = {}, splats = {}, accumulation = {size: pixels * 16};
 const dispatchWorkgroups = vi.fn(), emit = vi.fn();
 const pass = Object.assign(Object.create(WGPUCausticLightPass.prototype), {
  device: {limits: {maxComputeWorkgroupsPerDimension: limit}},
  outputs: new Map([[target, {splats, accumulation, resolveGroup: {}}]]),
  pipeline: {}, accumulate: {}, emit
 }) as WGPUCausticLightPass;
 const encoder = {
  clearBuffer: vi.fn(),
  beginComputePass: () => ({setPipeline() {}, setBindGroup() {}, dispatchWorkgroups, end() {}})
 } as unknown as GPUCommandEncoder;
 const options = {width: pixels, height: 1, photons: 1, batch: 0,
  clear: true, run: false, viewProjection: new Float32Array(16), casterSphere: [0,0,0,1], cameraScale: 1};
 pass.encode(encoder, [], target, options);
 expect(emit).not.toHaveBeenCalled();
 expect(dispatchWorkgroups).not.toHaveBeenCalled();
 pass.encode(encoder, [], target, {...options, clear: false, run: true});
 expect(emit).toHaveBeenCalledTimes(1);
 expect(dispatchWorkgroups.mock.calls).toEqual([expected]);
 expect(encoder.clearBuffer).toHaveBeenCalledWith(accumulation);
 expect(encoder.clearBuffer).toHaveBeenCalledWith(splats);
});
