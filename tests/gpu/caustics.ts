import {registerMnee, mneeDiagnostics} from '../../src/research/mnee/index.js';
import {Camera,Engine,Render,Mesh,OpenPBRMaterial,RectLight,SpotLight,createPlaneGeometry,createSphereGeometry,generateVertexNormals,DirectionalLight,EnvironmentLight,Texture} from '../../src/main.js';
import {causticDiagnostics} from '../../src/renderer/causticDiagnostics.js';
import type {CausticSettings} from '../../src/Render.js';
async function capture(caustics?: CausticSettings & {mnee?: boolean | {method?: 'newton' | 'sms'}}, samples=64, sphere=false, spot=sphere, omitCaster=false, wave=false,variant='') {
  if (caustics?.mnee) registerMnee();
  mneeDiagnostics.mnee = caustics?.mnee;
  const canvas=document.createElement('canvas');document.querySelector('canvas')!.replaceWith(canvas);
  const engine=new Engine({canvas,textureBinding:variant==='bindless'?'auto':'atlas',backend:location.search.includes('webgl')?'webgl':'webgpu'});
  const render=new Render(engine,{bounces:(globalThis as typeof globalThis&{causticBounces?:number}).causticBounces??8,caustics,batchSamples:true,bevel:false});
  try {
    const dimensions=(globalThis as typeof globalThis&{causticSize?:[number,number]}).causticSize??[192,144];
    const info=await engine.init();const gpuErrors:string[]=[];engine.device?.addEventListener('uncapturederror',event=>gpuErrors.push((event as GPUUncapturedErrorEvent).error.message)); engine.display.setSize(dimensions[0],dimensions[1]);
    const camera=new Camera({projection:'perspective',aspect:dimensions[0]/dimensions[1],fov:50});
    if(variant==='orthographic'){camera.projection='orthographic';camera.left=-3;camera.right=3;camera.top=2.25;camera.bottom=-2.25;}
    if(variant==='dof'){camera.fStop=4;camera.focusDistance=5;}
    camera.position=sphere?[3,2.6,4]:[0,.75,3]; camera.lookAt([0,0,0]);engine.camera=camera;
    const floor=new Mesh(createPlaneGeometry(),new OpenPBRMaterial({baseColor:[.6,.6,.6]}));
    floor.transform[0]=floor.transform[10]=6;
    const caster=new Mesh(sphere?createSphereGeometry(64,32):createPlaneGeometry(wave?32:1,wave?32:1),new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0,specularIor:1.5}));
    if(variant==='shared')caster.geometry=floor.geometry;
    if(wave){const positions=caster.geometry.position.array;for(let i=0;i<positions.length;i+=3)positions[i+1]=.08*Math.sin(positions[i]*7)*Math.cos(positions[i+2]*5);generateVertexNormals(caster.geometry);}
    caster.position=[0,sphere?.85:1,0];
    if (sphere) caster.transform[0]=caster.transform[5]=caster.transform[10]=.8;
    else caster.transform[0]=caster.transform[10]=2.5;
    if(variant==='reflection'){caster.materials[0].transmissionWeight=0;caster.materials[0].baseMetalness=1;caster.materials[0].baseColor=[.9,.8,.7];}
    if(variant==='alpha'){caster.materials[0].opacity=.5;caster.materials[0].alphaMode='blend';}
    if(variant==='volume'){caster.materials[0].transmissionDepth=.8;caster.materials[0].transmissionColor=[.3,.6,.8];}
    if(variant==='catcher')floor.materials[0].shadowCatcher=true;
    if(variant==='dispersion')caster.materials[0].transmissionDispersionScale=1;
    const light=variant==='indirect'?new SpotLight({intensity:120,radius:.25,innerAngle:25,outerAngle:35}):variant==='directional'?new DirectionalLight({intensity:8}):variant==='environment'?new EnvironmentLight({map:new Texture({data:new Float32Array([1,1,1,1]),width:1,height:1})}):spot?new SpotLight({intensity:120,radius:0,innerAngle:25,outerAngle:35}):new RectLight({intensity:8,size:[3,3]});
    light.position=spot||variant==='indirect'?[-1.5,3,0]:[0,3,0];if(light.type!=='EnvironmentLight')light.lookAt([0,0,0]);
    const wall=new Mesh(createPlaneGeometry(1,1,'vertical'),new OpenPBRMaterial({baseColor:[.6,.6,.6]}));wall.position=[0,1.5,-2.5];wall.transform[0]=3;wall.transform[5]=1.5;
    if(variant==='alpha-visibility'){
      camera.fov=20;
      Object.assign(floor.materials[0],{baseColor:[1,1,1],baseMetalness:1,specularRoughness:0});
      Object.assign(caster.materials[0],{baseColor:[0,0,0],transmissionWeight:0,specularWeight:0,specularRoughness:1,opacity:.5,alphaMode:'blend'});
      caster.position=[0,1,-4];caster.transform[0]=caster.transform[10]=20;
      light.position=[0,3,-12];light.lookAt([0,0,-12]);if(light.type==='RectLight')light.size=[8,8];
    }
    const casters=variant==='multiple'?[-3,0,3].map(x=>{const m=new Mesh(createSphereGeometry(16,8),new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0}));m.position=[x,.85,0];m.transform[0]=m.transform[5]=m.transform[10]=.5;return m;}):[];
    engine.scene={meshes:variant==='multiple'?[floor,...casters]:variant==='indirect'?[floor,caster,wall]:(omitCaster||variant==='ordinary')?[floor]:[floor,caster],lights:[light],background:[0,0,0,1]};
    engine.update();
    const study = (window as any).causticStudy;
    if (study) return await study(engine, render, info);
    await Promise.race([render.converge({samples,sampleSequenceOffset:17}),new Promise((_,reject)=>setTimeout(()=>reject(Error(JSON.stringify({status:render.status,diagnostics:engine.getDiagnostics()}))),90000))]);
    let benchmark:unknown;
    if((globalThis as typeof globalThis&{causticBenchmark?:boolean}).causticBenchmark){
      render.maxSamples=samples;render.batchSamples=false;render.timeBudgetMs=1000;render.maxTiles=1;render.restart();const started=performance.now(),timings:unknown[]=[];
      for(let iteration=0;render.samples<samples&&iteration<10000;iteration++){
        render.refine();await engine.device?.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,0));await render._output!.flushDiagnostics();
        const timing=engine.getDiagnostics()?.gpuTraceTiming;if(timing)timings.push({...timing});
      }
      if(render.samples<samples)throw Error('Benchmark incomplete '+JSON.stringify({samples:render.samples,status:render.status,maxSamples:render.maxSamples,diagnostics:engine.getDiagnostics()}));
      benchmark={wallMs:performance.now()-started,samples:render.samples,timings};
    }
    let photonEfficiency:unknown;
    const photon=causticDiagnostics.photonBatch;
    if(causticDiagnostics.capturePhotons&&photon){
      const {device,data,emitted}=photon;const b=device.createBuffer({size:256,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});const e=device.createCommandEncoder();e.copyTextureToBuffer({texture:data},{buffer:b,bytesPerRow:256},[1,1]);device.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);const stored=photon.packed?new Uint32Array(b.getMappedRange())[1]:new Float32Array(b.getMappedRange())[1];photonEfficiency={emitted,stored,fraction:stored/emitted};b.unmap();b.destroy();causticDiagnostics.photonBatch=undefined;
    }
    const image=await render.readPixels('hdr');engine.display.present(render);if(gpuErrors.length)throw Error(gpuErrors.join('\n'));
    let mean=0,finite=true;for(let i=0;i<image.data.length;i+=4) {mean+=(image.data[i]+image.data[i+1]+image.data[i+2])/3;finite&&=Number.isFinite(image.data[i]);}
    return {width:image.width,height:image.height,hdr:Array.from(image.data),backend:engine.backend,adapter:info.adapterName,mean:mean/(image.width*image.height),finite,benchmark,photonEfficiency,diagnostics:engine.getDiagnostics(),image:canvas.toDataURL()};
  } finally {render.dispose();engine.dispose();}
}
Object.assign(window,{causticsTests:{capture}});

// Execute the real resolve fragment shader against the independent fixture.
async function resolveContract() {
  const {WGPURayTraceOutputPass}=await import('../../src/renderer/WGPURayTraceOutput.js');
  const {DataUtils}=await import('three');
  const fixture=await fetch('/tests/fixtures/display-order.json').then(r=>r.json());
  const adapter=await navigator.gpu.requestAdapter();const device=await adapter!.requestDevice();
  const output=new WGPURayTraceOutputPass(device);output.setSize(1,1);
  const buffer=(data:number[])=>{const b=device.createBuffer({size:data.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,new Float32Array(data));return b;};
  const results=[];
  for(const test of fixture.causticResolve) {
    const inputs={wideHdr:test.wideHdr,color:buffer(test.pt),normal:buffer([0,1,0,test.samples]),albedo:buffer([1,1,1,test.samples]),shadowCatcher:buffer(Array(12).fill(0)),caustic:buffer(test.caustic)};
    const readback=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder();output.createPass(encoder,inputs);
    encoder.copyTextureToBuffer({texture:output.getOutput('color')},{buffer:readback,bytesPerRow:256},[1,1]);device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);const value=output.getOutput('color').format==='rgba32float'?Array.from(new Float32Array(readback.getMappedRange()).slice(0,3)):Array.from(new Uint16Array(readback.getMappedRange()).slice(0,3),DataUtils.fromHalfFloat);readback.unmap();
    if(value.some((v,i)=>Math.abs(v-test.expected[i])>Math.max(1e-12,Math.abs(test.expected[i])*1e-5)))throw Error(`${test.name}: ${value}`);
    results.push({name:test.name,value});for(const b of Object.values(inputs))if(b instanceof GPUBuffer)b.destroy();readback.destroy();
  }
  const atomicPath='/src/renderer/wgsl/chunks/causticAtomic.wgsl.ts';
  const {default:atomic}=await import(/* @vite-ignore */ atomicPath);
  const accumulatePath='/src/renderer/wgsl/causticLight.compute.ts';
  const {causticAccumulateCompute,causticUnitRandomWgsl}=await import(/* @vite-ignore */ accumulatePath);
  const splats=device.createBuffer({size:12,usage:GPUBufferUsage.STORAGE});
  const accumulation=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  const shader=`@group(0)@binding(0)var<storage,read_write>splats:array<atomic<u32>>;${atomic}
  @compute @workgroup_size(64)fn main(){causticAtomicAdd(0u,1e-8);causticAtomicAdd(1u,1e8);}`;
  const pipeline=device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code:shader}),entryPoint:'main'}});
  const resolve=device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code:causticAccumulateCompute}),entryPoint:'main'}});
  const encoder=device.createCommandEncoder();
  const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:splats}}]}));pass.dispatchWorkgroups(1);pass.end();
  const resolvePass=encoder.beginComputePass();resolvePass.setPipeline(resolve);resolvePass.setBindGroup(0,device.createBindGroup({layout:resolve.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:splats}},{binding:1,resource:{buffer:accumulation}}]}));resolvePass.dispatchWorkgroups(1);resolvePass.end();
  const readback=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});encoder.copyBufferToBuffer(accumulation,0,readback,0,16);device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
  const values=Array.from(new Float32Array(readback.getMappedRange()));
  if(Math.abs(values[0]/6.4e-7-1)>1e-5||Math.abs(values[1]/6.4e9-1)>1e-5)throw Error('Photon precision regression: '+values);
  results.push({name:'photon-float-dynamic-range',value:values});readback.unmap();splats.destroy();accumulation.destroy();readback.destroy();
  const warp=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  const warpRead=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const warpModule=device.createShaderModule({code:`const EPS=.0005;${causticUnitRandomWgsl}
   @group(0)@binding(0)var<storage,read_write>values:array<f32>;
   @compute @workgroup_size(1)fn main(){values[0]=causticUnitRandom(EPS);values[1]=causticUnitRandom(.5);values[2]=causticUnitRandom(1.0-EPS);values[3]=causticUnitRandom(EPS+(1.0-2.0*EPS)*.25);}`});
  const warpPipeline=device.createComputePipeline({layout:'auto',compute:{module:warpModule,entryPoint:'main'}}),warpEncoder=device.createCommandEncoder(),warpPass=warpEncoder.beginComputePass();
  warpPass.setPipeline(warpPipeline);warpPass.setBindGroup(0,device.createBindGroup({layout:warpPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:warp}}]}));warpPass.dispatchWorkgroups(1);warpPass.end();warpEncoder.copyBufferToBuffer(warp,0,warpRead,0,16);device.queue.submit([warpEncoder.finish()]);await warpRead.mapAsync(GPUMapMode.READ);
  const unit=Array.from(new Float32Array(warpRead.getMappedRange()));
  if(unit[0]!==0||Math.abs(unit[1]-.5)>1e-7||unit[2]<.9999998||unit[2]>=1||Math.abs(unit[3]-.25)>1e-7)throw Error('Emission warp support: '+unit);
  results.push({name:'photon-full-emission-support',value:unit});warpRead.unmap();warpRead.destroy();warp.destroy();
  output.dispose();device.destroy();return results;
}
Object.assign(window,{causticsResolveContract:resolveContract});

async function sharedGeometryContract(){
 const a=await capture({},128),b=await capture({},128,false,false,false,false,'shared');
 let maxError=0;for(let i=0;i<a.hdr.length;i++)maxError=Math.max(maxError,Math.abs(a.hdr[i]-b.hdr[i]));
 if(maxError>1e-5)throw Error('Shared BLAS instance visibility differs: '+maxError);
 return {independentMean:a.mean,sharedMean:b.mean,maxError};
}
Object.assign(window,{sharedGeometryContract});

async function directionalCausticsContract(){
 const scope=globalThis as typeof globalThis&{causticBounces?:number};const previous=scope.causticBounces;scope.causticBounces=1;
 try{
  const mnee=await capture({mnee:true},1024,false,false,false,false,'directional');
  const light=await capture({lightTracing:{photonsPerSample:131072}},1024,false,false,false,false,'directional');
  const relative=light.mean/mnee.mean-1;if(Math.abs(relative)>.01)throw Error('Primary directional partition: '+relative);
  return {mnee:mnee.mean,light:light.mean,relative};
 }finally{scope.causticBounces=previous;}
}
Object.assign(window,{directionalCausticsContract});

async function alphaVisibilityContract(){
 const a=await capture({},2048,false,false,true,false,'alpha-visibility');
 const b=await capture({},2048,false,false,false,false,'alpha-visibility');
 const ratio=b.mean/a.mean;const result={uncovered:a.mean,covered:b.mean,ratio,expected:.5};
 if(Math.abs(ratio-.5)>.01)throw Error('Analytic-light coverage: '+JSON.stringify(result));
 const baseline=await capture({},128,true,false,false,false,'alpha');
 for(const options of [{lightTracing:true},{photonMapping:true}]){
  const fallback=await capture(options,128,true,false,false,false,'alpha');
  if(baseline.hdr.some((v:number,i:number)=>v!==fallback.hdr[i]))throw Error('Stochastic caster fallback changed PT HDR');
 }
 return {...result,photonFallbackIdentical:true};
}
Object.assign(window,{alphaVisibilityContract});

// A mirror sees the underside of a horizontal emissive mesh. Secondary BVH
// traversal deliberately accepts back faces; emission must still respect sidedness.
async function emitterFacingContract(){
 const rows=[];
 for(const doubleSided of [false,true]){
  const canvas=document.createElement('canvas');
  const engine=new Engine({canvas,backend:location.search.includes('webgl')?'webgl':'webgpu'});
  const render=new Render(engine,{bounces:3,bevel:false});
  try{
   await engine.init();engine.display.setSize(16,16);
   const camera=new Camera({projection:'perspective',aspect:1,fov:20});camera.position=[0,1,3];camera.lookAt([0,0,0]);engine.camera=camera;
   const mirror=new Mesh(createPlaneGeometry(),new OpenPBRMaterial({baseMetalness:1,baseColor:[1,1,1],specularRoughness:0}));mirror.transform[0]=mirror.transform[10]=20;
   const emitter=new Mesh(createPlaneGeometry(),new OpenPBRMaterial({baseWeight:0,specularWeight:0,emissionColor:[4,2,1],emissionLuminance:1,doubleSided}));emitter.position=[0,2,-6];emitter.transform[0]=emitter.transform[10]=40;
   engine.scene={meshes:[mirror,emitter],lights:[],background:[0,0,0,1]};engine.update();await render.converge({samples:16,samplesPerBatch:1,sampleSequenceOffset:17});
   const image=await render.readPixels('hdr');let mean=0,maximum=0;for(let i=0;i<image.data.length;i+=4){mean+=(image.data[i]+image.data[i+1]+image.data[i+2])/3;maximum=Math.max(maximum,image.data[i],image.data[i+1],image.data[i+2]);}
   rows.push({doubleSided,mean:mean/(16*16),maximum});
  }finally{render.dispose();engine.dispose();}
 }
 if(rows[0].maximum!==0||rows[1].mean<1)throw Error('Emitter sidedness: '+JSON.stringify(rows));
 return rows;
}
Object.assign(window,{emitterFacingContract});
