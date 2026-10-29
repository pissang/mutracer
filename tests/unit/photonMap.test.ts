import {gpu} from './shaderSourceFormattingFixture';
import {expect,it,vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {PHOTON_BYTES,photonBucketCount,photonGridCompute} from '../../src/renderer/wgsl/photonMap.compute';
import {photonRadius} from '../../src/renderer/WGPUPhotonMap';
it('matches the photon and hash storage contracts and the consistent radius schedule',()=>{
 gpu();const d=makeShaderDataDefinitions(photonGridCompute),record=d.structs.Bucket;
 expect(PHOTON_BYTES).toBe(20);expect(record.size).toBe(16);
 expect(d.structs.Bucket.size).toBe(16);expect(d.uniforms.parameters.size).toBe(32);
 expect(photonRadius(2,100,.3)).toBeCloseTo(2*Math.pow(100,-.35));
 expect(photonRadius(2,1)).toBe(2);expect(photonRadius(2,64)).toBeCloseTo(1);expect(photonRadius(2,4096)).toBeCloseTo(.5);
});

it('keeps five-million-photon batches and dispatches their second row',async()=>{
 gpu();vi.stubGlobal('GPUTextureUsage',{STORAGE_BINDING:1,TEXTURE_BINDING:2,COPY_SRC:4});
 const {WGPUPhotonMap}=await import('../../src/renderer/WGPUPhotonMap');
 const dispatches:number[][]=[];
 const device={
  limits:{maxTextureDimension2D:8192,maxStorageBufferBindingSize:512*1024*1024,maxComputeWorkgroupsPerDimension:65535},
  createBindGroupLayout:()=>({}),createPipelineLayout:()=>({}),createShaderModule:()=>({}),createComputePipeline:()=>({}),createBindGroup:()=>({}),
  createBuffer:({size}:{size:number})=>({size,destroy(){}}),
  createTexture:({size}:{size:number[]})=>({width:size[0],height:size[1],createView(){return {};},destroy(){}}),
  queue:{writeBuffer(){}}
 } as unknown as GPUDevice;
 const map=new WGPUPhotonMap(device),target={};
 const batch=map.ensure(target,5_000_000);expect(batch.count).toBe(5_000_000);expect(map.bytes(target)).toBeLessThan(123_000_000);
 expect(batch.data.width*batch.data.height).toBeGreaterThanOrEqual(5_000_000);
 const encoder={clearBuffer(){},beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(...args:number[]){dispatches.push(args);},end(){}};}} as unknown as GPUCommandEncoder;
 map.encode(encoder,[],target,.05,{width:1,height:1,photons:5_000_000,batch:0,mnee:false,clear:true,run:true,viewProjection:new Float32Array(16),casterSphere:[0,0,0,1],cameraScale:1});
 expect(dispatches).toEqual([[65535,2],[256,1],[1,1],[65535,2]]);
 const capped=map.ensure({},100_000_000);expect(capped.count).toBeLessThan(5_600_000);
 map.dispose();
});

it('scales hash capacity to small batches and caps large batches',()=>{
 for(const n of [1,128,129,4096,9216,5000000]){
  const buckets=photonBucketCount(n);expect(Math.log2(buckets)%1).toBe(0);
  expect(buckets).toBeGreaterThanOrEqual(256);expect(buckets).toBeLessThanOrEqual(65536);
 }
 expect(photonBucketCount(9216)).toBe(32768);expect(photonBucketCount(5000000)).toBe(65536);
});
