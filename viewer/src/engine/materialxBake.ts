import MaterialGraph from '../../../src/scene/MaterialGraph';
import Texture from '../../../src/scene/Texture';
import {normalizeGraph} from '../../../src/renderer/materialGraph/normalize';
import {generateGraph} from '../../../src/renderer/materialGraph/codegen';
import {evaluateGraph,numeric} from '../../../src/renderer/materialGraph/evaluate';
import {graphMathShader} from '../../../src/renderer/materialGraph/shader';
import {type BakeImage,type BakeNodes,planDisplacement,quantizeHeight} from './materialxDisplacement';

export interface BakeResult {
  heights:Float32Array;
  width:number;
  height:number;
  backend:'webgpu'|'cpu';
  timings:{compileMs:number;executeMs:number;readbackMs:number;cacheHit:boolean};
}
const mode=(wrap:Texture['wrapS'])=>wrap==='repeat'?0:wrap==='clamp-to-edge'?1:2;
const wrap=(x:number,m:number)=>m===0?x-Math.floor(x):m===1?Math.max(0,Math.min(1,x)):1-Math.abs(1-(x-2*Math.floor(x/2)));
const srgb=(x:number)=>x<=0.04045?x/12.92:Math.pow((x+0.055)/1.055,2.4);

/** Same normalized, bilinear image semantics as graph rendering; color decoding
 * follows filtering. Images here have top-first rows and the viewer's flipY. */
export function sampleBakeImage(image:BakeImage,uv:readonly number[]) {
  const u=wrap(uv[0],mode(image.wrapS))*image.width-0.5,v=(1-wrap(uv[1],mode(image.wrapT)))*image.height-0.5;
  const ix=Math.floor(u),iy=Math.floor(v),fx=u-ix,fy=v-iy;
  const address=(x:number,n:number,m:number)=>m===0?((x%n)+n)%n:Math.max(0,Math.min(n-1,x));
  const pixel=(x:number,y:number,c:number)=>image.pixels[(address(y,image.height,mode(image.wrapT))*image.width+address(x,image.width,mode(image.wrapS)))*4+c]/255;
  return [0,1,2,3].map(c=>{const a=pixel(ix,iy,c)*(1-fx)+pixel(ix+1,iy,c)*fx,b=pixel(ix,iy+1,c)*(1-fx)+pixel(ix+1,iy+1,c)*fx;const x=a*(1-fy)+b*fy;return image.srgb&&c<3?srgb(x):x;});
}

function loadedGraph(description:BakeNodes,images:BakeImage[]) {
  const graph=new MaterialGraph(description),textures=new Map<Texture,BakeImage>();
  for(const image of images) {
    const texture=new Texture({width:image.width,height:image.height,data:image.pixels});
    texture.colorSpace=image.srgb?'srgb':'linear';texture.flipY=true;
    texture.wrapS=image.wrapS;texture.wrapT=image.wrapT;
    graph.setInput(image.node,'file',{type:'filename',value:texture});textures.set(texture,image);
  }
  const plan=planDisplacement(graph);
  if(plan.mode==='fallback')throw Error(plan.reason);
  const normalized=normalizeGraph(graph);
  return {normalized,textures};
}

export function bakeHeightCPU(description:BakeNodes,images:BakeImage[],width:number,height:number):BakeResult {
  const {normalized,textures}=loadedGraph(description,images),heights=new Float32Array(width*height),start=performance.now();
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    // PNG rows are top-first; the installed texture is flipped back for UVs.
    const uv=[(x+0.5)/width,1-(y+0.5)/height];
    heights[y*width+x]=evaluateGraph(normalized,{uv,uv1:uv,sample:(texture,uv)=>sampleBakeImage(textures.get(texture)!,uv)}).specularRoughness[0];
  }
  return {heights,width,height,backend:'cpu',timings:{compileMs:0,executeMs:performance.now()-start,readbackMs:0,cacheHit:false}};
}

const imageShader=`
struct ImageInfo {size:vec2f,offset:f32,srgb:f32,modes:vec2f,padding:vec2f};
@group(0) @binding(0) var<storage,read> parameters:array<vec4f>;
@group(0) @binding(1) var<storage,read> imageInfo:array<ImageInfo>;
@group(0) @binding(2) var<storage,read> imagePixels:array<vec4f>;
@group(0) @binding(3) var output:texture_storage_2d<r32float,write>;
fn mx_parameter(base:i32,slot:i32)->vec4f{return parameters[slot];}
fn mx_wrap(x:f32,m:f32)->f32 {if(m<0.5){return fract(x);}if(m<1.5){return clamp(x,0.0,1.0);}return 1.0-abs(1.0-(x-2.0*floor(x*0.5)));}
fn mx_address(x:i32,n:i32,m:f32)->i32 {if(m<0.5){return ((x%n)+n)%n;}return clamp(x,0,n-1);}
fn mx_pixel(info:ImageInfo,p:vec2i)->vec4f {
  let x=mx_address(p.x,i32(info.size.x),info.modes.x);let y=mx_address(p.y,i32(info.size.y),info.modes.y);
  return imagePixels[i32(info.offset)+y*i32(info.size.x)+x];
}
fn mx_image(index:i32,uv:vec2f,fallback:vec4f,color:bool)->vec4f {
  if(index<0){return fallback;}let info=imageInfo[index];
  let p=vec2f(mx_wrap(uv.x,info.modes.x),1.0-mx_wrap(uv.y,info.modes.y))*info.size-0.5;
  let base=vec2i(floor(p));let f=fract(p);
  var c=mix(mix(mx_pixel(info,base),mx_pixel(info,base+vec2i(1,0)),f.x),mix(mx_pixel(info,base+vec2i(0,1)),mx_pixel(info,base+vec2i(1,1)),f.x),f.y);
  if(color&&info.srgb>0.5){c=vec4f(select(pow((c.rgb+0.055)/1.055,vec3f(2.4)),c.rgb/12.92,c.rgb<=vec3f(0.04045)),c.a);}return c;
}
struct MXResult {specularRoughness:f32};
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}
  let uv=vec2f((f32(id.x)+0.5)/f32(size.x),1.0-(f32(id.y)+0.5)/f32(size.y));
  let identity=mat4x4f(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0),vec4f(0,0,0,1));
  let result=mx_eval(0,uv,uv,vec3f(0),vec3f(0),vec3f(0),vec3f(0),identity,identity,MXResult(0));
  textureStore(output,vec2i(id.xy),vec4f(result.specularRoughness,0,0,1));
}`;

/** The worker owns one device and an eight-topology LRU. Values, images and
 * resolution remain data, so rebaking the same structure reuses its pipeline. */
export class HeightBaker {
  private pipelines=new Map<string,Promise<GPUComputePipeline>>();
  constructor(private device:GPUDevice){}
  async bake(description:BakeNodes,images:BakeImage[],width:number,height:number):Promise<BakeResult> {
    const {normalized,textures}=loadedGraph(description,images),generated=generateGraph(normalized,'webgpu');
    const key=normalized.key,start=performance.now(),cacheHit=this.pipelines.has(key);
    let pending=this.pipelines.get(key);
    if(!pending) {
      const source=imageShader+graphMathShader([normalized],'webgpu')+generated.source;
      const module=this.device.createShaderModule({code:source});
      const bindings=this.device.createBindGroupLayout({entries:[...[0,1,2].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage' as const}})),{binding:3,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:'write-only',format:'r32float'}}]});
      pending=this.device.createComputePipelineAsync({layout:this.device.createPipelineLayout({bindGroupLayouts:[bindings]}),compute:{module,entryPoint:'main'}});
      this.pipelines.set(key,pending);
      pending.catch(()=>this.pipelines.delete(key));
      if(this.pipelines.size>8)this.pipelines.delete(this.pipelines.keys().next().value!);
    } else {this.pipelines.delete(key);this.pipelines.set(key,pending);}
    const pipeline=await pending,compileMs=performance.now()-start;
    const limit=this.device.limits;
    if(width>limit.maxTextureDimension2D||height>limit.maxTextureDimension2D)throw Error('Displacement bake exceeds the device texture size limit');
    const imageList=[...textures],slots=new Map(imageList.map(([t],i)=>[t,i]));
    const fileSlots=new Set(normalized.nodes.flatMap(n=>n.inputs.file?.slot===undefined?[]:[n.inputs.file.slot]));
    const params=new Float32Array(Math.max(4,generated.parameters.length*4));
    generated.parameters.forEach((p,i)=>params.set(p instanceof Texture?[slots.get(p)??-1]:fileSlots.has(i)?[-1]:numeric(p),i*4));
    const infos=new Float32Array(Math.max(8,images.length*8));let count=0;
    for(const [i,[,image]] of imageList.entries()){infos.set([image.width,image.height,count,image.srgb?1:0,mode(image.wrapS),mode(image.wrapT),0,0],i*8);count+=image.width*image.height;}
    const pixels=new Float32Array(Math.max(4,count*4));let offset=0;
    for(const [,image] of imageList){for(const p of image.pixels)pixels[offset++]=p/255;}
    const resources:GPUBuffer[]=[];
    const buffer=(data:Float32Array)=>{
      if(data.byteLength>limit.maxStorageBufferBindingSize)throw Error('Displacement bake exceeds the device storage limit');
      const b=this.device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});resources.push(b);this.device.queue.writeBuffer(b,0,data);return b;
    };
    let output:GPUTexture|undefined;
    this.device.pushErrorScope('validation');
    try {
      const buffers=[buffer(params),buffer(infos),buffer(pixels)];
      output=this.device.createTexture({size:[width,height],format:'r32float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
      const pitch=Math.ceil(width*4/256)*256,read=this.device.createBuffer({size:pitch*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});resources.push(read);
      const group=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...buffers.map((b,binding)=>({binding,resource:{buffer:b}})),{binding:3,resource:output.createView()}]});
      const t=performance.now(),encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();
      this.device.queue.submit([encoder.finish()]);await this.device.queue.onSubmittedWorkDone();const executeMs=performance.now()-t;
      const r=performance.now(),copy=this.device.createCommandEncoder();copy.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:pitch},[width,height]);this.device.queue.submit([copy.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const source=new Float32Array(read.getMappedRange()),heights=new Float32Array(width*height);
      for(let y=0;y<height;y++)heights.set(source.subarray(y*pitch/4,y*pitch/4+width),y*width);
      read.unmap();
      return {heights,width,height,backend:'webgpu',timings:{compileMs,executeMs,readbackMs:performance.now()-r,cacheHit}};
    } finally {
      for(const b of resources)b.destroy();output?.destroy();
      const error=await this.device.popErrorScope();if(error)throw Error(error.message);
    }
  }
}

export async function heightPNG(result:BakeResult) {
  const {pixels,scale,bias,maxError}=quantizeHeight(result.heights),canvas=new OffscreenCanvas(result.width,result.height);
  canvas.getContext('2d')!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>,result.width,result.height),0,0);
  return {file:await canvas.convertToBlob({type:'image/png'}),scale,bias,maxError};
}
