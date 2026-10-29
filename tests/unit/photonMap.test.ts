import {gpu} from './shaderSourceFormattingFixture';
import {expect,it,vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {PHOTON_BYTES,photonBucketCount,photonGridCompute,photonLayout} from '../../src/renderer/wgsl/photonMap.compute';
import {photonRadius,photonVisibleRadius} from '../../src/renderer/WGPUPhotonMap';
it('matches the photon and hash storage contracts and the consistent radius schedule',()=>{
 gpu();const d=makeShaderDataDefinitions(photonGridCompute),record=d.structs.Bucket;
 expect(PHOTON_BYTES).toBe(20);expect(record.size).toBe(16);
 expect(d.structs.Bucket.size).toBe(16);expect(d.uniforms.parameters.size).toBe(32);
 expect(photonRadius(2,100,.3)).toBeCloseTo(2*Math.pow(100,-.35));
 expect(photonRadius(2,1)).toBe(2);expect(photonRadius(2,64)).toBeCloseTo(1);expect(photonRadius(2,4096)).toBeCloseTo(.5);
});

it('caps dual-index allocations to the budget and dispatches their second row',async()=>{
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
 const batch=map.ensure(target,5_000_000);expect(batch.count).toBeGreaterThan(4_194_240);expect(batch.count).toBeLessThan(5_000_000);expect(map.bytes(target)).toBeLessThanOrEqual(128*1024*1024);
 expect(batch.data.width*batch.data.height).toBeGreaterThanOrEqual(batch.count);
 const encoder={clearBuffer(){},beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(...args:number[]){dispatches.push(args);},end(){}};}} as unknown as GPUCommandEncoder;
 map.encode(encoder,[],target,.05,{width:1,height:1,photons:5_000_000,batch:0,mnee:false,clear:true,run:true,viewProjection:new Float32Array(16),casterSphere:[0,0,0,1],cameraScale:1});
 expect(dispatches).toEqual([[65535,2],[1024,2],[1,2],[65535,2]]);
 const capped=map.ensure({},100_000_000);expect(capped.count).toBeLessThan(5_000_000);
 map.dispose();
});

it('scales hash capacity to small batches and caps large batches',()=>{
 for(const n of [1,128,129,4096,9216,5000000]){
  const buckets=photonBucketCount(n);expect(Math.log2(buckets)%1).toBe(0);
  expect(buckets).toBeGreaterThanOrEqual(256);expect(buckets).toBeLessThanOrEqual(262144);
 }
 expect(photonBucketCount(9216)).toBe(32768);expect(photonBucketCount(5000000)).toBe(262144);
});

it('keeps both index ranges and directions disjoint at every bucket transition',()=>{
 for(const n of [1,128,129,32768,32769,131072,131073,5_000_000]){
  const l=photonLayout(n);
  expect(l.fineHeaders).toBe(l.coarseHeaders+l.buckets*2);
  expect(l.coarseIndices).toBe(l.fineHeaders+l.buckets*2);
  expect(l.fineIndices).toBe(l.coarseIndices+n);
  expect(l.directions).toBe(l.fineIndices+n);
  expect(l.texels).toBe(l.directions+n);
 }
 expect(photonBucketCount(32769)).toBe(131072);
 expect(photonBucketCount(131073)).toBe(262144);
});
it('estimates perspective and orthographic footprints without changing the gather cap',()=>{
 const projection=new Float32Array([2,0,0,0,0,2,0,0,0,0,1,-1,0,0,0,0]);
 const options={viewProjection:projection,casterSphere:[0,0,-5,1],width:1000};
 expect(photonVisibleRadius(.05,options)).toBeCloseTo(.01);
 expect(photonVisibleRadius(.005,options)).toBe(.005);
 expect(photonVisibleRadius(.05,{...options,orthographic:true})).toBeCloseTo(.002);
 expect(photonVisibleRadius(.05,options,0)).toBe(.05);
});
