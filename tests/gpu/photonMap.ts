import {WGPUPhotonMap} from '../../src/renderer/WGPUPhotonMap.js';
import {photonPackingWgsl} from '../../src/renderer/wgsl/photonMap.compute.js';

/** Exercise packed records, invalid slots, both scan levels and every scatter index. */
export async function photonMapContract() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  const errors:string[]=[];device.addEventListener('uncapturederror',event=>errors.push((event as GPUUncapturedErrorEvent).error.message));
  const map = new WGPUPhotonMap(device);
  const target = {};
  const count = 513;
  const batch = map.ensure(target, count);
  const code = `${photonPackingWgsl}
    @group(0) @binding(0) var records:texture_storage_2d<rgba32uint,write>;
    fn store(i:u32,value:vec4u){let width=textureDimensions(records).x;textureStore(records,vec2i(vec2u(i%width,i/width)),value);}
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id)id:vec3u){
      let i=id.x;if(i>=513u){return;}
      let position=bitcast<vec3u>(vec3f(f32(i%17u)*.2-2.0,f32(i%13u)*.3,f32(i%11u)*.4));
      store(i,vec4u(position,select(photonEncodeFlux(vec3f(1.0,.5,.25)),0u,i==512u)));
    }`;
  const pipeline = device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: batch.data.createView()}]}));
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  map.encode(encoder, [], target, 1, {width: 1, height: 1, photons: count, batch: 0, mnee: false,
    clear: true, run: true, viewProjection: new Float32Array(16), casterSphere: [0, 0, 0, 1], cameraScale: 1});
  const stride = Math.ceil(batch.headers.width * 4 / 256) * 256;
  const readback = device.createBuffer({size: stride * batch.headers.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  encoder.copyTextureToBuffer({texture: batch.headers}, {buffer: readback, bytesPerRow: stride}, [batch.headers.width, batch.headers.height]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const padded = new Uint32Array(readback.getMappedRange());
  const words = Array.from({length: batch.headers.width * batch.headers.height}, (_, i) => padded[Math.floor(i / batch.headers.width) * stride / 4 + i % batch.headers.width]);
  const indices = words.slice(8 + batch.buckets * 2, 8 + batch.buckets * 2 + 512);
  if (words[1] !== 512 || new Set(indices).size !== 512 || indices.some(i => i >= 512)) throw Error('Photon scan/scatter lost or duplicated records '+JSON.stringify({words:words.slice(0,10),unique:new Set(indices).size,indices:indices.slice(0,8),errors}));
  let offset = 0;
  for (let bucket = 0; bucket < batch.buckets; bucket++) {
    if (words[8 + bucket * 2] !== offset) throw Error('Photon prefix offset mismatch');
    offset += words[9 + bucket * 2];
  }
  if (offset !== 512) throw Error('Photon histogram total mismatch');
  const quantized=device.createBuffer({size:256*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  const quantizedRead=device.createBuffer({size:256*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const quantizedCode=`${photonPackingWgsl}
    @group(0)@binding(0)var<storage,read_write>result:array<vec4f>;
    @compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
      let i=id.x;let t=f32(i);let direction=normalize(vec3f(sin(t*1.3),cos(t*2.1),sin(t*.37)));
      let uv=round(photonEncodeOct(direction)*255.0)/255.0;
      let normalUv=round(photonEncodeOct(direction)*vec2f(255.0,127.0))/vec2f(255.0,127.0);
      let flux=vec3f(1.0,.37,.023)*exp2(t/8.0-16.0);
      let decoded=photonDecodeFlux(photonEncodeFlux(flux));
      result[i]=vec4f(dot(direction,photonDecodeOct(uv)),dot(direction,photonDecodeOct(normalUv)),max(max(abs(decoded.x-flux.x),abs(decoded.y-flux.y)),abs(decoded.z-flux.z))/flux.x,0.0);
    }`;
  const quantizedPipeline=device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code:quantizedCode}),entryPoint:'main'}});
  const quantizedEncoder=device.createCommandEncoder(),quantizedPass=quantizedEncoder.beginComputePass();
  quantizedPass.setPipeline(quantizedPipeline);quantizedPass.setBindGroup(0,device.createBindGroup({layout:quantizedPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:quantized}}]}));quantizedPass.dispatchWorkgroups(4);quantizedPass.end();
  quantizedEncoder.copyBufferToBuffer(quantized,0,quantizedRead,0,256*16);device.queue.submit([quantizedEncoder.finish()]);await quantizedRead.mapAsync(GPUMapMode.READ);
  const precision=new Float32Array(quantizedRead.getMappedRange());let minDirectionDot=1,minNormalDot=1,maxFluxRelative=0;
  for(let i=0;i<256;i++){minDirectionDot=Math.min(minDirectionDot,precision[i*4]);minNormalDot=Math.min(minNormalDot,precision[i*4+1]);maxFluxRelative=Math.max(maxFluxRelative,precision[i*4+2]);}
  if(minDirectionDot<.9995||minNormalDot<.999||maxFluxRelative>.008)throw Error('Photon quantization precision regression');
  quantizedRead.unmap();quantized.destroy();quantizedRead.destroy();
  readback.unmap();
  readback.destroy();
  map.dispose();
  device.destroy();
  return {count, stored: offset, buckets: batch.buckets, recordBytes: 20, indexBytes: 4,minDirectionDot,minNormalDot,maxFluxRelative};
}
