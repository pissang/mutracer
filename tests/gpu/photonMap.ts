import {WGPUPhotonMap} from '../../src/renderer/WGPUPhotonMap.js';
import {photonPackingWgsl,photonLayout} from '../../src/renderer/wgsl/photonMap.compute.js';

/** Exercise packed records, invalid slots, both scan levels and every scatter index. */
export async function photonMapContract() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  const errors:string[]=[];device.addEventListener('uncapturederror',event=>errors.push((event as GPUUncapturedErrorEvent).error.message));
  const map = new WGPUPhotonMap(device);
  const target = {};
  const count = 131073;
  const valid = count - 1;
  const batch = map.ensure(target, count);
  const code = `${photonPackingWgsl}
    @group(0) @binding(0) var records:texture_storage_2d<rgba32uint,write>;
    fn store(i:u32,value:vec4u){let width=textureDimensions(records).x;textureStore(records,vec2i(vec2u(i%width,i/width)),value);}
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id)id:vec3u){
      let i=id.x;if(i>=${count}u){return;}
      let position=bitcast<vec3u>(vec3f(f32(i%17u)*.2-2.0,f32(i%13u)*.3,f32(i%11u)*.4));
      store(i,vec4u(position,select(photonEncodeFlux(vec3f(1.0,.5,.25)),0u,i==${valid}u)));
    }`;
  const pipeline = device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: batch.data.createView()}]}));
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  map.encode(encoder, [], target, 1, {width: 100, height: 100, photons: count, batch: 0, mnee: false,
    clear: true, run: true, viewProjection: new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), orthographic: true, casterSphere: [0, 0, 0, 1], cameraScale: 1});
  const stride = Math.ceil(batch.headers.width * 4 / 256) * 256;
  const readback = device.createBuffer({size: stride * batch.headers.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  encoder.copyTextureToBuffer({texture: batch.headers}, {buffer: readback, bytesPerRow: stride}, [batch.headers.width, batch.headers.height]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const padded = new Uint32Array(readback.getMappedRange());
  const words = Array.from({length: batch.headers.width * batch.headers.height}, (_, i) => padded[Math.floor(i / batch.headers.width) * stride / 4 + i % batch.headers.width]);
  const layout=photonLayout(count);
  const hash=(c:number[])=>((Math.imul(c[0],73856093)^Math.imul(c[1],19349663)^Math.imul(c[2],83492791))>>>0)&(batch.buckets-1);
  const position=(i:number)=>[Math.fround(Math.fround((i%17)*Math.fround(.2))-2),Math.fround((i%13)*Math.fround(.3)),Math.fround((i%11)*Math.fround(.4))];
  const cell=(p:number[],size:number)=>p.map(x=>Math.floor(Math.fround(x/Math.fround(size))));
  const radii=new Float32Array(new Uint32Array([words[0],words[6]]).buffer);
  let checkedSets=0;
  for(let layer=0;layer<2;layer++){
    const header=layer===0?layout.coarseHeaders:layout.fineHeaders;
    const start=layer===0?layout.coarseIndices:layout.fineIndices;
    const indices=words.slice(start,start+valid);
    if(words[1]!==valid||new Set(indices).size!==valid||indices.some(i=>i>=valid))throw Error('Photon scan/scatter lost or duplicated records '+JSON.stringify({layer,header:words.slice(0,8),valid,unique:new Set(indices).size,max:indices.reduce((a,b)=>Math.max(a,b),0),errors}));
    let offset=0;
    for(let bucket=0;bucket<batch.buckets;bucket++){
      if(words[header+bucket*2]!==offset)throw Error('Photon prefix offset mismatch');
      const n=words[header+bucket*2+1];
      for(let j=offset;j<offset+n;j++)if(hash(cell(position(words[start+j]),(radii[layer]*(layer===0?1:2))))!==bucket)throw Error('Photon assigned to wrong grid cell');
      offset+=n;
    }
    if(offset!==valid)throw Error('Photon histogram total mismatch');
    for(const center of [[-1.1,.6,.8],[0,1.2,2],[.4,1.8,3.2]]){
      const radius=.07,size=(radii[layer]*(layer===0?1:2));
      const first=cell(center.map(x=>x-radius),size),last=cell(center.map(x=>x+radius),size),found=new Set<number>();
      for(let z=first[2];z<=last[2];z++)for(let y=first[1];y<=last[1];y++)for(let x=first[0];x<=last[0];x++){
        const lower=[x,y,z].map(v=>v*size),padding=lower.map(v=>Math.max(size*1e-5,Math.abs(v)*1e-6));
        const closest=center.map((v,i)=>Math.max(lower[i]-padding[i],Math.min(lower[i]+size+padding[i],v)));
        if(Math.hypot(...closest.map((v,i)=>v-center[i]))>=radius)continue;
        const bucket=hash([x,y,z]),offset=words[header+bucket*2],n=words[header+bucket*2+1];
        for(let j=offset;j<offset+n;j++){
          const id=words[start+j],p=position(id),c=cell(p,size);
          if(c[0]===x&&c[1]===y&&c[2]===z&&Math.hypot(...p.map((v,i)=>v-center[i]))<radius){
            if(found.has(id))throw Error('Duplicate gather photon');found.add(id);
          }
        }
      }
      for(let id=0;id<valid;id++)if(found.has(id)!==(Math.hypot(...position(id).map((v,i)=>v-center[i]))<radius))throw Error('Gather set differs from brute force');
      checkedSets++;
    }
  }
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
  if(errors.length)throw Error(errors.join('\n'));
  map.dispose();
  device.destroy();
  return {count, stored: valid, buckets: batch.buckets, recordBytes: 20, indexBytes: 8,checkedSets,minDirectionDot,minNormalDot,maxFluxRelative};
}
