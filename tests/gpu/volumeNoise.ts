import {volumeNoiseWgsl} from '../../src/renderer/wgsl/chunks/volumeNoise.wgsl';
import {volumeNoiseGlsl} from '../../src/renderer/glsl/chunks/volumeNoise.glsl';
import {gradientNoise, volumeFbm, noiseVectors, noiseMask} from '../fixtures/volumeNoiseReference';

/** Execute the same fixed vectors in both shader languages and the CPU reference. */
export async function checkVolumeNoiseValues(backend: 'webgpu' | 'webgl') {
  const vectors=noiseVectors.flatMap(p=>[1,4,6].flatMap(o=>[0,.5,1,2].map(warp=>({p,o,warp,coverage:.6,softness:.4}))))
    .concat([[-.125,-.25,.375],...noiseVectors].flatMap(p=>[0,.5,1].map(warp=>({p,o:4,warp,coverage:.5,softness:1e-9})))), count=vectors.length;
  const expected=vectors.flatMap(({p,o,warp,coverage,softness})=>[gradientNoise(p),volumeFbm(p,o),noiseMask(p,[4,4,4],[.125,.25,-.375],coverage,softness,o,warp),1]);
  let values: Float32Array;
  if(backend==='webgpu') {
    const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No GPU');
    const device=await adapter.requestDevice();const errors:string[]=[];
    device.addEventListener('uncapturederror',e=>errors.push((e as GPUUncapturedErrorEvent).error.message));
    try {
      const code=volumeNoiseWgsl+`
@group(0) @binding(0) var<storage,read_write> output: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
let p=array<vec3f,${count}>(${vectors.map(v=>`vec3f(${v.p.map(x=>x.toFixed(8)).join(',')})`).join(',')});
let o=array<i32,${count}>(${vectors.map(v=>v.o).join(',')});
let warp=array<f32,${count}>(${vectors.map(v=>v.warp.toFixed(1)).join(',')});
let coverage=array<f32,${count}>(${vectors.map(v=>v.coverage).join(',')});
let softness=array<f32,${count}>(${vectors.map(v=>v.softness).join(',')});
output[id.x]=vec4f(volumeGradientNoise(p[id.x]),volumeFbm(p[id.x],o[id.x]),volumeNoiseMask(p[id.x],vec4f(4,4,4,f32(o[id.x])),vec4f(.125,.25,-.375,coverage[id.x]),softness[id.x],warp[id.x]),1);}`;
      const module=device.createShaderModule({code});const info=await module.getCompilationInfo();
      if(info.messages.some(m=>m.type==='error'))throw Error(JSON.stringify(info.messages));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const output=device.createBuffer({size:count*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const readback=device.createBuffer({size:count*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);
      pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output}}]}));
      pass.dispatchWorkgroups(count);pass.end();encoder.copyBufferToBuffer(output,0,readback,0,count*16);device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);values=new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();output.destroy();readback.destroy();if(errors.length)throw Error(errors.join('\n'));
    } finally {device.destroy();}
  } else {
    const canvas=document.createElement('canvas');canvas.width=count;canvas.height=1;
    const gl=canvas.getContext('webgl2')!;if(!gl?.getExtension('EXT_color_buffer_float'))throw Error('No float render target');
    const compile=(type:number,source:string)=>{const shader=gl.createShader(type)!;gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader)!);return shader;};
    const vertex=compile(gl.VERTEX_SHADER,'#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}');
    const fragment=compile(gl.FRAGMENT_SHADER,`#version 300 es
precision highp float;precision highp int;out vec4 color;
${volumeNoiseGlsl}
void main(){int i=int(gl_FragCoord.x);vec3 p[${count}]=vec3[](${vectors.map(v=>`vec3(${v.p.map(x=>x.toFixed(8)).join(',')})`).join(',')});
int o[${count}]=int[](${vectors.map(v=>v.o).join(',')});float warp[${count}]=float[](${vectors.map(v=>v.warp.toFixed(1)).join(',')});float coverage[${count}]=float[](${vectors.map(v=>v.coverage).join(',')});float softness[${count}]=float[](${vectors.map(v=>v.softness).join(',')});color=vec4(volumeGradientNoise(p[i]),volumeFbm(p[i],o[i]),volumeNoiseMask(p[i],vec4(4,4,4,float(o[i])),vec4(.125,.25,-.375,coverage[i]),softness[i],warp[i]),1);}`);
    const program=gl.createProgram()!;gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program)!);
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA32F,count,1);
    const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Incomplete framebuffer');
    gl.useProgram(program);gl.viewport(0,0,count,1);gl.drawArrays(gl.TRIANGLES,0,3);
    values=new Float32Array(count*4);gl.readPixels(0,0,count,1,gl.RGBA,gl.FLOAT,values);
    const error=gl.getError();gl.deleteFramebuffer(fbo);gl.deleteTexture(texture);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
    gl.getExtension('WEBGL_lose_context')?.loseContext();if(error)throw Error('GL error '+error);
  }
  const maxError=Math.max(...values.map((v,i)=>Math.abs(v-expected[i])));
  if(!values.every(Number.isFinite))throw Error(`${backend} non-finite noise value`);
  for(let i=0;i<count;i++)if(vectors[i].softness===1e-9&&![0,1].includes(values[i*4+2]))throw Error(`${backend} non-binary tiny-softness mask`);
  // The CPU fBm uses double arithmetic; float32 threshold edges add rounding.
  if(maxError>1e-6)throw Error(`${backend} noise error ${maxError}`);
  return {backend,maxError,vectors,values:Array.from(values),expected};
}
