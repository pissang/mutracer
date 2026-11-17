import {initOpenPbrEnergyLut} from '/src/renderer/openPbrEnergyLut.browser.ts';
await initOpenPbrEnergyLut();
// Fixed additive inputs; all display decisions and trace nodes belong to production.
import {makeWGPURenderTargets} from '/src/renderer/WGPURenderingPipeline.ts';
import {makeWebGLRenderTargets} from '/src/renderer/WebGLRenderingPipeline.ts';
import {WebGLDevice} from '/src/renderer/webgl.ts';
import {JNLM_DEFAULT_SHAPE} from '/src/renderer/jnlm.ts';
import table from '/tests/fixtures/display-order.json';
const size=16, count=size*size, samples=32;
const backend=new URLSearchParams(location.search).has('webgl')?'webgl':'webgpu';
const save=(name,body)=>fetch('/evidence/'+backend+'-'+name,{method:'POST',body});
const repeat=v=>Float32Array.from({length:count*4},(_,i)=>v[i%4]);
function accumulation(catcher){
 const color=Float32Array.from({length:count*4},(_,i)=>i%4===3?(catcher?.5:1)*samples:
  ((Math.floor(i/4)%size<8?2:6)*[1,.5,.25][i%4]+((Math.floor(i/4)*1664525+19)>>>0)%13*.002)*samples*(catcher?.5:1));
 const albedo=repeat([.3*samples,.4*samples,.5*samples,samples*(catcher?.5:1)]),normal=repeat([0,0,samples,samples]);
 const moments=new Float32Array(count*4),shadow=new Float32Array(count*8);
 for(let i=0;i<count;i++){
  const l=(color[i*4]*.2126+color[i*4+1]*.7152+color[i*4+2]*.0722)/samples;
  moments.set([l*samples,(l*l+10)*samples,catcher?8:0,catcher?16:0],i*4);
  if(catcher)shadow.set([16,0,0,8,0,0,0,0],i*8);
 }
 // GPU accumulations use bottom-row-first coordinates.
 for(const [data,stride] of [[color,4],[albedo,4],[normal,4],[moments,4],[shadow,8]]){
  const top=data.slice();for(let y=0;y<size;y++)data.set(top.subarray((size-1-y)*size*stride,(size-y)*size*stride),y*size*stride);
 }
 return {width:size,height:size,samples,catcher:!!catcher,color,albedo,normal,moments,shadow};
}
window.runBenchmark=async()=>{
 const canvas=document.querySelector('canvas');canvas.width=canvas.height=size;
 let device,renderer,pipeline;const errors=[];
 if(backend==='webgpu'){
  const adapter=await navigator.gpu.requestAdapter();device=await adapter.requestDevice({requiredLimits:{maxColorAttachmentBytesPerSample:40}});
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));pipeline=makeWGPURenderTargets(canvas,device);
 }else{renderer=new WebGLDevice({canvas,parallelShaderCompile:false});pipeline=makeWebGLRenderTargets(renderer);}
 const records=[];
 try{for(const row of table.cases.filter(r=>backend!=='webgl'||!r.hdr&&r.webgl!==false)){
  const target=pipeline.createTarget(row.name);target.activate();
  const diagnostics=target._displayParity();
  target.setToneMappingParams({exposure:row.exposure??1,toneMapping:['agx','aces','cineon','reinhard','linear'][row.tone??0]});
  target.setBloomParams({intensity:row.bloom?.2:0,threshold:1,radius:.6});
  target.setOutput(['final','normal','albedo','shadow','shadowCatcher'][row.output]);
  if(row.hdr&&!target.setHDROutputEnabled(true))throw Error('HDR surface unavailable');
  diagnostics.load(accumulation(row.catcher));
  const trace=[];diagnostics.record(trace);
  // A scene filter publishes through the custom-denoiser path; its deterministic
  // stand-in scales RGB, preserving alpha through the production coverage pass.
  if(row.filter==='scene')await target.performDenoise({kind:'custom',denoiser:{denoise(input){
   const shader=device.createShaderModule({code:'@group(0) @binding(0) var<storage,read> src:array<vec4f>; @group(0) @binding(1) var<storage,read_write> dst:array<vec4f>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x<arrayLength(&src)){dst[id.x]=vec4f(src[id.x].rgb*.5,src[id.x].a);}}'});
   const p=device.createComputePipeline({layout:'auto',compute:{module:shader,entryPoint:'main'}}),e=device.createCommandEncoder(),pass=e.beginComputePass();
   pass.setPipeline(p);pass.setBindGroup(0,device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input.color}},{binding:1,resource:{buffer:input.output}}]}));pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();device.queue.submit([e.finish()]);
  }}});
  else {target.drawPostProcess();if(row.filter==='jnlm')await target.performDenoise({kind:'jnlm',denoiser:{strength:3,shape:JNLM_DEFAULT_SHAPE}});}
  target.present();
  const {data}=await target.readPresentation();diagnostics.record();
  // LinearHDRSurface: comparison-only decode, never part of the execution trace.
  const values=row.hdr&&!row.output?data.map((x,i)=>i%4===3?x:x<=.04045?x/12.92:((x+.055)/1.055)**2.4):data;
  records.push({name:row.name,trace});
  await save(row.name+(row.hdr?'.f32':'.rgba8'),row.hdr?values:Uint8Array.from(values,x=>Math.round(Math.max(0,Math.min(1,x))*255)));
  pipeline.releaseTarget(target);
 }
 await save('trace.json',JSON.stringify(records));
 if(device)await device.queue.onSubmittedWorkDone();
 if(errors.length)throw Error(errors.join('\n'));if(renderer?.gl.getError())throw Error('WebGL error');
 return {passed:true,backend,cases:records.length};
 }finally{pipeline.dispose();if(device){await device.queue.onSubmittedWorkDone();device.destroy();}}
};
