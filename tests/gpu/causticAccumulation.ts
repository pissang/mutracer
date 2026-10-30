import {WGPUCausticLightPass} from '../../src/renderer/WGPUCausticLightPass.js';

/** Exercise the production dispatch and shader across the first dispatch-row boundary. */
export async function causticAccumulationContract() {
 const adapter = await navigator.gpu.requestAdapter();
 const device = await adapter!.requestDevice();
 const errors: string[] = [];
 device.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
 const light = new WGPUCausticLightPass(device), target = {};
 const width = 3024, height = 1792, pixels = width * height;
 const boundary = device.limits.maxComputeWorkgroupsPerDimension * 64;
 const indices = [0, boundary - 1, boundary, pixels - 1, Math.floor(pixels / 2)];
 const compact = device.createBuffer({size: 80, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
 const readback = device.createBuffer({size: 80, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
 try {
  light.setDistribution([], {data: new Float32Array(), count: 0});
  // Deterministic splats isolate image accumulation from transport noise.
  await light.prepare(`
   @group(0) @binding(1) var<storage,read_write> splats:array<atomic<u32>>;
   @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
    if(id.x>=4u) { return; }
    let points=array<u32,4>(${indices.slice(0,4).map(i => `${i}u`).join(',')});
    let start=points[id.x]*3u;
    for(var c=0u;c<3u;c++) { atomicStore(&splats[start+c],bitcast<u32>(f32(c+1u))); }
   }`, []);
  const options = {width, height, photons: 4, batch: 0, clear: true, run: true,
   viewProjection: new Float32Array(16), casterSphere: [0,0,0,1], cameraScale: 1};
  for(let batch=0;batch<2;batch++) {
   const encoder = device.createCommandEncoder();
   light.encode(encoder, [], target, {...options, batch, clear: batch === 0});
   device.queue.submit([encoder.finish()]);
  }
  const pipeline = device.createComputePipeline({layout: 'auto', compute: {
   module: device.createShaderModule({code: `
    @group(0) @binding(0) var<storage,read> accumulation:array<vec4f>;
    @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
     let points=array<u32,5>(${indices.map(i => `${i}u`).join(',')});
     result[id.x]=accumulation[points[id.x]];
    }`}), entryPoint: 'main'
  }});
  const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
   {binding: 0, resource: {buffer: light.get(target)!}}, {binding: 1, resource: {buffer: compact}}
  ]}));
  pass.dispatchWorkgroups(indices.length); pass.end();
  encoder.copyBufferToBuffer(compact, 0, readback, 0, 80); device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const values = Array.from(new Float32Array(readback.getMappedRange()));
  for(let i=0;i<indices.length;i++) {
   const expected = i<4 ? [2,4,6,2] : [0,0,0,2];
   if(expected.some((v,c) => values[i*4+c] !== v)) throw Error(`Caustic accumulation at ${indices[i]}: ${values.slice(i*4,i*4+4)}`);
  }
  if(errors.length) throw Error(errors.join('\n'));
  return {width, height, boundary, indices, values};
 } finally {
  if(readback.mapState === 'mapped') readback.unmap();
  readback.destroy(); compact.destroy(); light.dispose(); device.destroy();
 }
}
