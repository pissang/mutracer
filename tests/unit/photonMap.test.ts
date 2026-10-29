import {gpu} from './shaderSourceFormattingFixture';
import {expect,it,vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {PHOTON_BYTES,defaultPhotonMapPhotons,photonBucketCount,photonGridCompute,photonLayout} from '../../src/renderer/wgsl/photonMap.compute';
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
it('caps the default photon-map batch at 2^18 photons', () => {
  expect(defaultPhotonMapPhotons(480, 272)).toBe(32640);
  expect(defaultPhotonMapPhotons(1920, 1088)).toBe(2 ** 18);
  expect(defaultPhotonMapPhotons(1, 1)).toBe(1);
});

it.each([2 ** 16, 2 ** 18, 2 ** 20])('scales the global progressive radius using %s actual emitted photons', photons => {
 const reference = 2 ** 18, initial = .12, batch = 64, alpha = 2 / 3;
 const legacy = initial * Math.pow(batch, (alpha - 1) / 2);
 expect(photonRadius(initial, batch, alpha, photons, 'none')).toBe(legacy);
 expect(photonRadius(initial, batch, alpha, photons, 'ppm')).toBeCloseTo(legacy * (photons / reference) ** (-1 / 6), 14);
 expect(photonRadius(initial, batch, alpha, photons, 'constant-count')).toBeCloseTo(legacy * (photons / reference) ** (-1 / 2), 14);
 const projection = new Float32Array([2,0,0,0,0,2,0,0,0,0,1,-1,0,0,0,0]);
 const options = {viewProjection: projection, casterSphere: [0,0,-5,1], width: 1000};
 for (const mode of ['none', 'ppm', 'constant-count'] as const) {
  const radius = photonRadius(initial, batch, alpha, photons, mode);
  expect(photonVisibleRadius(radius, options)).toBeCloseTo(Math.min(radius, .01), 14);
  expect(photonRadius(initial, batch * 64, alpha, photons, mode)).toBeCloseTo(radius / 2, 14);
 }
 // A's effective iterations equal batch * N/N0, including non-default alpha.
 expect(photonRadius(initial, batch, .3, photons, 'ppm')).toBeCloseTo(initial * (batch * photons / reference) ** (-.35), 14);
});
it('uses the allocated photon count rather than a larger request when encoding the radius', async () => {
 gpu();
 const {default: WGPURayTracePass} = await import('../../src/renderer/WGPURayTracePass');
 const {causticDiagnostics: diagnostics} = await import('../../src/renderer/causticDiagnostics');
 const previous = diagnostics.photonRadiusScaling;
 const encode = vi.fn(), target = {}, matrix = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
 const pass = Object.assign(Object.create(WGPURayTracePass.prototype), {
  _device: {queue: {writeBuffer() {}}}, _uniforms: {rtUniform: {}},
  _width: 64, _height: 48, _activeTarget: target, _photonMapping: true,
  _photonMap: {get: (key: object) => key === target ? {count: 65536} : undefined, encode},
  _causticSettings: {photonMapping: {photonsPerSample: 1048576, initialRadius: 2}},
  _causticBounds: [0,0,0,1], _photonEmissionGroups: [], _viewProjInv: matrix,
  _rtUniform: {buffer: new ArrayBuffer(4), views: {scaleOffset: [1,1,0,0], sampleCount: [63], sampleSequenceOffset: [0]}},
  _rayTracePipeline: {}, _rayTraceBindGroups: [], _causticPerspective: true
 });
 const encoder = {beginComputePass: () => ({setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {}})} as unknown as GPUCommandEncoder;
 try {
  diagnostics.photonRadiusScaling = 'ppm';
  pass.createPass(encoder, false, [1,1]);
  expect(encode.mock.calls[0][3]).toBeCloseTo(photonRadius(2, 64, 2 / 3, 65536, 'ppm'), 14);
 } finally {diagnostics.photonRadiusScaling = previous;}
});
