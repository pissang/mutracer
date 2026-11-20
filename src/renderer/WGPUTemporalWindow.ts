export const directGeometryWGSL = /* wgsl */ `
fn surface(x: vec2i, frame: u32, field: u32) -> vec4f {
  return textureLoad(surfaces, x, i32(frame*2u+field), 0);
}
fn ident(x: vec2i, frame: u32) -> vec3u {
  return textureLoad(ids, x, i32(frame), 0).xyz;
}
fn project(world: vec3f, frame: u32) -> vec3f {
  let m=cameras[frame].vp;
  let q=((world.x*m[0]+world.y*m[1])+world.z*m[2])+m[3];
  return vec3f((q.x/max(q.w,1e-4)+1.0)*f32(p.size.x)*0.5-0.5,
    (1.0-q.y/max(q.w,1e-4))*f32(p.size.y)*0.5-0.5,q.w);
}
fn coc(depth:f32, frame:u32)->f32 {
  let lens=cameras[frame].lens;
  return lens.x*lens.y*abs(1.0/max(depth,1e-4)-1.0/lens.z);
}
`;

// Direct temporal window. Each neighbor is projected once into the current frame.
const windowBindingsAndGeometry = /* wgsl */ `
struct Params { size: vec2u, current: u32, source: u32, delta: i32, symmetric: u32, stage: u32, mode: u32 }
struct Camera { vp: mat4x4f, lens: vec4f }
const OVERFLOW_BUCKETS=4096u;
struct Overflow { index: atomic<u32>, color: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var surfaces: texture_2d_array<f32>;
@group(0) @binding(2) var ids: texture_2d_array<u32>;
@group(0) @binding(3) var hdr: texture_2d_array<f32>;
@group(0) @binding(4) var<storage, read> cameras: array<Camera>;
@group(0) @binding(5) var<storage, read_write> total: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> output: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> overflow: array<Overflow>;
@group(0) @binding(8) var<storage, read_write> rejects: array<atomic<u32>>;

${directGeometryWGSL}
fn radiance(x:vec2i,frame:u32)->vec3f {
  let color=textureLoad(hdr,x,i32(frame),0);
  if(color.a!=-1.0){return color.rgb;}
  let index=u32(x.y)*p.size.x+u32(x.x)+1u;
  for(var probe=0u;probe<OVERFLOW_BUCKETS;probe++){
    let address=frame*OVERFLOW_BUCKETS+((index*2654435761u+probe)&(OVERFLOW_BUCKETS-1u));
    let key=atomicLoad(&overflow[address].index);
    if(key==index){return overflow[address].color.rgb;}
    if(key==0u){break;}
  }
  return vec3f(0);
}
fn tapRejection(at:vec2i, pos:vec4f, normal:vec4f, id:vec3u)->u32 {
  let oldPos=surface(at,p.source,0u);
  let oldNormal=surface(at,p.source,1u);
  if (!(oldPos.w>0.0001 && oldNormal.w>0.0)) { return 5u; }
  if (!(oldNormal.w>1.0)) { return 6u; }
  if (any(id!=ident(at,p.source))) { return 7u; }
  if (abs(dot(oldPos.xyz-pos.xyz,normal.xyz))>0.015*pos.w) { return 8u; }
  if (dot(oldNormal.xyz,normal.xyz)<0.95) { return 9u; }
  return 0u;
}
fn rejection(x:vec2i, q:vec3f, nearest:vec2i, partial:bool)->u32 {
  let pos=surface(x,p.current,0u);
  let normal=surface(x,p.current,1u);
  if (!(pos.w>0.0001 && normal.w>0.0)) { return 1u; }
  if (!(normal.w>=f32(1+abs(p.delta)*select(1,2,p.symmetric==1u)))) { return 2u; }
  if (!(all(q.xy>=vec2f(0)) && all(q.xy<=vec2f(p.size)-1.0) && q.z>0.0)) { return 3u; }
  if (!(abs(coc(pos.w,p.current)-coc(q.z,p.source))<=0.5)) { return 4u; }
  let id=ident(x,p.current);
  if (partial) { return tapRejection(nearest,pos,normal,id); }
  let origin=vec2i(floor(q.xy));
  for (var dy=0;dy<=1;dy++) { for (var dx=0;dx<=1;dx++) {
    let at=min(origin+vec2i(dx,dy),vec2i(p.size)-1);
    let reason=tapRejection(at,pos,normal,id);
    if (reason!=0u) { return reason; }
  }}
  return 0u;
}
fn footprintWeight(x:vec2i,q:vec2f,nearest:vec2i)->f32 {
  let origin=vec2i(floor(q));
  let phase=fract(q);
  let pos=surface(x,p.current,0u);
  let normal=surface(x,p.current,1u);
  let id=ident(x,p.current);
  var coverage=0.0;
  for(var dy=0;dy<2;dy++){for(var dx=0;dx<2;dx++){
    let at=min(origin+vec2i(dx,dy),vec2i(p.size)-1);
    if(tapRejection(at,pos,normal,id)==0u){
      coverage+=select(1-phase.x,phase.x,dx==1)*select(1-phase.y,phase.y,dy==1);
    }
  }}
  // At a silhouette, even a validated nearest tap can have different subpixel coverage.
  let offset=q-vec2f(nearest);
  return select(0.35*coverage*exp(-16.*dot(offset,offset)),1.,coverage>.9999);
}
`;

const recoverHistoryWGSL = /* wgsl */ `
// Jittered hit coverage and square-root albedo share the unused ID lane.
// The center-ray identity remains the only authority for accepting a surface.
fn packedGuide(x: vec2i, frame: u32) -> u32 {
  return textureLoad(ids,x,i32(frame),0).w;
}
fn hitCoverage(x: vec2i, frame: u32) -> f32 {
  return f32(packedGuide(x,frame)&255u)/255.;
}
fn skyCorrection(x: vec2i, tap: vec2i, pos: vec4f, rgb: vec3f) -> vec3f {
  let current=packedGuide(x,p.current);
  let source=packedGuide(tap,p.source);
  if(min(current&255u,source&255u)>246u){return rgb;}
  let currentAlbedo=f32(current>>8u);
  let sourceAlbedo=f32(source>>8u);
  if(min(currentAlbedo,sourceAlbedo)<8. || abs(currentAlbedo-sourceAlbedo)<1.){return rgb;}

  // Estimate the sky contribution only when nearby misses agree that there
  // is no second visible surface behind this silhouette.
  let reach=i32(clamp(ceil(coc(pos.w,p.current))+1.,2.,4.));
  let id=ident(x,p.current);
  var background=vec3f(0);
  var count=0.;
  for(var dy=-1;dy<=1;dy++){
    for(var dx=-1;dx<=1;dx++){
      if(dx==0 && dy==0){continue;}
      let at=clamp(x+vec2i(dx,dy)*reach,vec2i(0),vec2i(p.size)-1);
      let depth=surface(at,p.current,0u).w;
      if(depth>0. && any(ident(at,p.current)!=id)){return rgb;}
      if(depth==0. && (packedGuide(at,p.current)&255u)<=8u){
        background+=radiance(at,p.current);
        count+=1.;
      }
    }
  }
  if(count<2.){return rgb;}
  background/=count;
  let ratio=clamp((currentAlbedo*currentAlbedo)/(sourceAlbedo*sourceAlbedo),.5,1.8);
  let prediction=max(vec3f(0),background+(rgb-background)*ratio);
  return mix(rgb,prediction,.75);
}

struct HistoryTap { at: vec2i, support: f32 }
fn recoverTap(x: vec2i, pos: vec4f, q: vec3f, original: HistoryTap) -> HistoryTap {
  let nearestDepth=surface(original.at,p.source,0u).w;
  if(nearestDepth>.0001 && nearestDepth<q.z*.985){return original;}
  let normal=surface(x,p.current,1u);
  let id=ident(x,p.current);
  let coverage=hitCoverage(x,p.current);
  var best=0.;
  var at=original.at;
  for(var dy=-1;dy<=1;dy++){
    for(var dx=-1;dx<=1;dx++){
      let tap=original.at+vec2i(dx,dy);
      if(any(tap<vec2i(0)) || any(tap>=vec2i(p.size))){continue;}
      let why=tapRejection(tap,pos,normal,id);
      if(why!=0u && why!=9u){continue;}
      let source=surface(tap,p.source,0u);
      let alignment=dot(normal.xyz,surface(tap,p.source,1u).xyz);
      if(alignment<.80 || abs(source.w-q.z)>.015*q.z){continue;}
      let forward=vec2f(tap)-q.xy;
      let reverse=project(source.xyz,p.current).xy-vec2f(x);
      let distance2=max(dot(forward,forward),dot(reverse,reverse));
      if(distance2>2.25){continue;}
      let coverageDelta=coverage-hitCoverage(tap,p.source);
      let score=exp(-1.5*distance2-(1.-min(alignment,1.))*24.-coverageDelta*coverageDelta*18.);
      if(score>best){
        best=score;
        at=tap;
      }
    }
  }
  let confidence=best*1.2*(4.-f32(abs(p.delta)))/3.;
  let mixed=1.-smoothstep(.85,1.,min(coverage,hitCoverage(at,p.source)));
  let luma=vec3f(.2126,.7152,.0722);
  let currentY=max(.005,dot(radiance(x,p.current),luma));
  let historyY=max(.005,dot(radiance(at,p.source),luma));
  let change=log(historyY/currentY);
  let support=confidence*exp(-mixed*(1.6*pow(max(change,0.),2.)+.2*pow(min(change,0.),2.)));
  if(support>original.support){return HistoryTap(at,support);}
  return original;
}
`;

const startWindowWGSL = /* wgsl */ `
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3u) {
  if(any(g.xy>=p.size)){return;}
  let x=vec2i(g.xy); let index=g.y*p.size.x+g.x;
  if(p.stage==0u){
    total[index]=vec4f(radiance(x,p.current),1.0);
    return;
  }
  if(p.stage==2u){ output[index]=vec4f(total[index].rgb/total[index].a,total[index].a); return; }
  let pos=surface(x,p.current,0u);
  if(pos.w<=0.0001){return;}
  let q=project(pos.xyz,p.source);
  let nearest=clamp(vec2i(floor(q.xy+0.5)),vec2i(0),vec2i(p.size)-1);
  var radius=select(17.0,8.0,p.symmetric==1u);
  if((p.mode & 1u)!=0u){radius=clamp(8.0+8.0*max(coc(pos.w,p.current)-2.0,0.0),8.0,16.0);}
  if(abs(f32(p.delta))>radius){return;}
  let partial=(p.mode & 2u)!=0u;
  let reason=rejection(x,q,nearest,partial);
`;

// Keep the original tap and weighting expressions for the strict and round-1 controls.
export const directWindowWGSL = /* wgsl */ `${windowBindingsAndGeometry}
${startWindowWGSL}  if(reason!=0u){atomicAdd(&rejects[reason],1u);return;}
  atomicAdd(&rejects[0],1u);
  var weight=(radius+1.0-abs(f32(p.delta)))/(radius+1.0);
  if(partial){weight*=footprintWeight(x,q.xy,nearest);}
  total[index]+=vec4f(radiance(nearest,p.source)*weight,weight);
}
`;

const mixedWindowWGSL = /* wgsl */ `${windowBindingsAndGeometry}
${recoverHistoryWGSL}
${startWindowWGSL}  var tap=HistoryTap(nearest,0.);
  if(reason==0u){
    tap.support=1.;
    if(partial){tap.support=footprintWeight(x,q.xy,nearest);}
  }
  if(partial && abs(p.delta)<=3 && (reason>=5u || (reason==0u && tap.support<1.))){
    tap=recoverTap(x,pos,q,tap);
  }
  if(tap.support<=0.){atomicAdd(&rejects[reason],1u);return;}
  atomicAdd(&rejects[0],1u);
  let weight=(radius+1.-abs(f32(p.delta)))/(radius+1.)*tap.support;
  let rgb=skyCorrection(x,tap.at,pos,radiance(tap.at,p.source));
  total[index]+=vec4f(rgb*weight,weight);
}
`;

const captureWGSL = /* wgsl */ `
struct Params { size: vec2u, slot: u32, pad: u32 }
struct Overflow { index: atomic<u32>, color: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage,read> position: array<vec4f>;
@group(0) @binding(2) var<storage,read> depth: array<vec4f>;
@group(0) @binding(3) var<storage,read> normal: array<vec4f>;
@group(0) @binding(4) var<storage,read> roughness: array<vec4f>;
@group(0) @binding(5) var<storage,read> identity: array<vec4u>;
@group(0) @binding(6) var<storage,read> albedo: array<vec4f>;
@group(0) @binding(7) var surfaceOut: texture_storage_2d_array<rgba16float,write>;
@group(0) @binding(8) var idOut: texture_storage_2d_array<rgba32uint,write>;
@group(0) @binding(9) var<storage,read> color: array<vec4f>;
@group(0) @binding(10) var hdrOut: texture_storage_2d_array<rgba16float,write>;
@group(0) @binding(11) var<storage,read_write> overflowOut: array<Overflow>;
fn nearestHalf(value:f32)->f32{
  let magnitude=abs(value);if(magnitude==0. || magnitude>65504.){return value;}
  let step=select(exp2(floor(log2(magnitude))-10.),exp2(-24.),magnitude<exp2(-14.));
  let scaled=magnitude/step;let lower=floor(scaled);let fraction=scaled-lower;
  let increment=select(0.,1.,fraction>.5 || (fraction==.5 && (u32(lower)&1u)==1u));
  return sign(value)*(lower+increment)*step;
}
fn nearestHalf4(value:vec4f)->vec4f{return vec4f(nearestHalf(value.x),nearestHalf(value.y),nearestHalf(value.z),nearestHalf(value.w));}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3u){
  if(any(g.xy>=p.size)){return;}
  let i=g.y*p.size.x+g.x; let valid=position[i].w>.5 && depth[i].w>.5;
  textureStore(surfaceOut,vec2i(g.xy),i32(p.slot*2u),nearestHalf4(vec4f(position[i].xyz,select(0.,depth[i].x,valid))));
  let r=roughness[i]; let cap=select(255.,1.,!(abs(r.x)<=3.402823e38) || (r.x<.25 && r.y>.10));
  textureStore(surfaceOut,vec2i(g.xy),i32(p.slot*2u+1u),nearestHalf4(vec4f(normal[i].xyz,select(0.,cap,valid))));
  let peak=max(albedo[i].x,max(albedo[i].y,albedo[i].z));
  let guide=u32(floor(255.*sqrt(clamp(peak,0.,1.))+.5)); let coverage=u32(floor(255.*clamp(r.w,0.,1.)+.5));
  textureStore(idOut,vec2i(g.xy),i32(p.slot),vec4u(identity[i].xyz,(guide<<8u)|coverage));
  let rgba=color[i];let exceeds=any(!(abs(rgba.rgb)<=vec3f(65504.)));
  textureStore(hdrOut,vec2i(g.xy),i32(p.slot),select(nearestHalf4(vec4f(rgba.rgb,1.)),vec4f(0.,0.,0.,-1.),exceeds));
  if(exceeds){let key=i+1u;for(var probe=0u;probe<4096u;probe++){
    let address=p.slot*4096u+((key*2654435761u+probe)&4095u);
    let claim=atomicCompareExchangeWeak(&overflowOut[address].index,0u,key);
    if(claim.exchanged || claim.old_value==key){overflowOut[address].color=vec4f(rgba.rgb,0.);break;}
  }}
}`;

export class DirectWindowGPU {
  [key: string]: any;
  static async create(device:GPUDevice,width:number,height:number,capacity=17,adaptiveRadius=false,stabilizeSparkle=false,sparkleVariant:'veto'|'round1'='veto') {
    const gpu=new DirectWindowGPU(device,width,height,capacity,adaptiveRadius,stabilizeSparkle,sparkleVariant);
    try {
      await gpu.init();
      return gpu;
    } catch (error) {
      gpu.dispose();
      throw error;
    }
  }
  constructor(device:GPUDevice,width:number,height:number,capacity:number,adaptiveRadius=false,stabilizeSparkle=false,sparkleVariant:'veto'|'round1'='veto') {
    Object.assign(this,{device,width,height,capacity,adaptiveRadius,stabilizeSparkle});
    this.preserveGlints=stabilizeSparkle && sparkleVariant==='veto';
    this.frames=new Map(); this.timings=[];
    this.resources=[];
    this.bytes=width*height*16;
  }
  texture(label:string,layers:number,format:GPUTextureFormat) {
    const t=this.device.createTexture({label,size:[this.width,this.height,layers],format,
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
    this.resources.push(t); return t;
  }
  buffer(label:string,size:number,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC) {
    const b=this.device.createBuffer({label,size,usage}); this.resources.push(b); return b;
  }
  async init() {
    const d=this.device;
    this.surface=this.texture('Direct window surface',this.capacity*2,'rgba16float');
    this.ids=this.texture('Direct window packed IDs',this.capacity,'rgba32uint');
    this.hdr=this.texture('Direct window HDR',this.capacity,'rgba16float');
    this.total=this.buffer('Direct window weighted sum',this.bytes);
    this.output=this.buffer('Direct window normalized output',this.bytes);
    this.camera=this.buffer('Direct window cameras',this.capacity*80);
    this.overflow=this.buffer('Direct window HDR overflow',this.capacity*4096*32);
    this.rejects=this.buffer('Direct window validation counts',64);
    this.params=this.buffer('Direct window parameters',32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const code=this.preserveGlints?mixedWindowWGSL:directWindowWGSL;
    const module=d.createShaderModule({code});
    const errors=(await module.getCompilationInfo()).messages.filter((row:GPUCompilationMessage)=>row.type==='error');
    if(errors.length)throw Error(errors.map((row:GPUCompilationMessage)=>row.message).join('\n'));
    const entries=[{buffer:{type:'uniform'}},
      {texture:{sampleType:'unfilterable-float',viewDimension:'2d-array'}},
      {texture:{sampleType:'uint',viewDimension:'2d-array'}},
      {texture:{sampleType:'unfilterable-float',viewDimension:'2d-array'}},
      {buffer:{type:'read-only-storage'}},{buffer:{type:'storage'}},{buffer:{type:'storage'}},{buffer:{type:'storage'}},{buffer:{type:'storage'}}];
    const layout=d.createBindGroupLayout({entries:entries.map((entry,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,...entry}))});
    this.pipeline=await d.createComputePipelineAsync({layout:d.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module,entryPoint:'main'}});
    this.layout=layout;
    const captureModule=d.createShaderModule({label:'Direct window capture',code:captureWGSL});
    const captureErrors=(await captureModule.getCompilationInfo()).messages.filter((row:GPUCompilationMessage)=>row.type==='error');
    if(captureErrors.length)throw Error(captureErrors.map((row:GPUCompilationMessage)=>row.message).join('\n'));
    this.capturePipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:captureModule,entryPoint:'main'}});
    this.captureParams=this.buffer('Direct window capture parameters',16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  }
  slot(frame:number){return ((frame%this.capacity)+this.capacity)%this.capacity;}
  useHistory(history:any){this.history=history;}
  capture(frame:number,buffers:Record<string,GPUBuffer>){
    const slot=this.slot(frame),d=this.device;
    d.queue.writeBuffer(this.captureParams,0,new Uint32Array([this.width,this.height,slot,0]));
    const clear=d.createCommandEncoder({label:'Direct window overflow clear'});clear.clearBuffer(this.overflow,slot*4096*32,4096*32);d.queue.submit([clear.finish()]);
    const values=[this.captureParams,buffers.centerPosition,buffers.centerDepth,buffers.centerNormal,buffers.roughness,buffers.id,buffers.albedo,this.surface,this.ids,buffers.color,this.hdr,this.overflow];
    const group=d.createBindGroup({layout:this.capturePipeline.getBindGroupLayout(0),entries:values.map((value,binding)=>({binding,resource:value instanceof GPUBuffer?{buffer:value}:value.createView({dimension:'2d-array'})}))});
    const encoder=d.createCommandEncoder({label:'Direct window GPU capture'}),pass=encoder.beginComputePass();
    pass.setPipeline(this.capturePipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
    d.queue.submit([encoder.finish()]);this.frames.set(slot,frame);
  }
  async upload(frame:number,meta:any,arrays:any,capMap:Record<number,number>={}) {
    const s=this.slot(frame), d=this.device, n=this.width*this.height;
    const position=new Float32Array(arrays.centerPosition), depth=new Float32Array(arrays.centerDepth), normal=new Float32Array(arrays.centerNormal);
    const roughness=new Float32Array(arrays.roughness), ids32=new Uint32Array(arrays.id);
    const surfaces=new Float32Array(n*8);
    surfaces.set(position,0); surfaces.set(normal,n*4);
    const idView=ids32.length===n*4?ids32:Uint32Array.from(ids32);
    const components=idView.length===n*3?3:4;
    const roughnessComponents=roughness.length===n*2?2:4;
    const cap=new Float32Array(n*4);
    // The roughness AOV stores roughness in x and metalness in y. Smooth metals get only the current frame.
    for(let i=0;i<n;i++){
      const material=idView[i*components+2];
      const value=roughness[i*roughnessComponents];
      cap[i*4]=!Number.isFinite(value)||(value<0.25&&roughness[i*roughnessComponents+1]>0.10)?1:(capMap[material]??255);
    }
    for(let i=0;i<n;i++){
      surfaces[i*4+3]=position[i*4+3]>0.5&&depth[i*4+3]>0.5?depth[i*4]:0;
      surfaces[n*4+i*4+3]=position[i*4+3]>0.5&&depth[i*4+3]>0.5?cap[i*4]:0;
    }
    d.queue.writeTexture({texture:this.surface,origin:[0,0,s*2]},new Float16Array(surfaces.subarray(0,n*4)),{bytesPerRow:this.width*8},[this.width,this.height,1]);
    d.queue.writeTexture({texture:this.surface,origin:[0,0,s*2+1]},new Float16Array(surfaces.subarray(n*4)),{bytesPerRow:this.width*8},[this.width,this.height,1]);
    const ids=new Uint32Array(n*4);
    for(let i=0;i<n;i++)for(let c=0;c<3;c++)ids[i*4+c]=idView[i*components+c];
    if(this.preserveGlints){
      const albedo=arrays.albedo && new Float32Array(arrays.albedo);
      const albedoComponents=albedo?.length===n*3?3:4;
      for(let i=0;i<n;i++){
        const at=i*albedoComponents;
        const peak=albedo?Math.max(albedo[at],albedo[at+1],albedo[at+2]):0;
        const guide=Math.round(255*Math.sqrt(Math.max(0,Math.min(1,peak))));
        const coverage=roughnessComponents===4?roughness[i*4+3]:1;
        ids[i*4+3]=(guide<<8) | Math.round(255*coverage);
      }
    }
    d.queue.writeTexture({texture:this.ids,origin:[0,0,s]},ids,{bytesPerRow:this.width*16},[this.width,this.height,1]);
    const sourceHdr=new Float32Array(arrays.hdr), hdr=new Float16Array(n*4);
    const overflow=new ArrayBuffer(4096*32), keys=new Uint32Array(overflow), values=new Float32Array(overflow);
    const hdrComponents=sourceHdr.length===n*3?3:4;
    for(let i=0;i<n;i++){
      const base=i*4; let exceeds=false;
      for(let c=0;c<3;c++){
        const value=sourceHdr[i*hdrComponents+c]; hdr[base+c]=value;
        exceeds ||= !Number.isFinite(value)||Math.abs(value)>65504;
      }
      hdr[base+3]=exceeds?-1:1;
      if(exceeds){
        const key=i+1; let bucket=Math.imul(key,2654435761)&4095;
        for(let probe=0;keys[bucket*8];probe++){
          if(probe===4095)throw Error('Direct window HDR overflow table is full.');
          bucket=(bucket+1)&4095;
        }
        keys[bucket*8]=key; values.set(sourceHdr.subarray(i*hdrComponents,i*hdrComponents+3),bucket*8+4);
      }
    }
    d.queue.writeBuffer(this.overflow,s*overflow.byteLength,overflow);
    d.queue.writeTexture({texture:this.hdr,origin:[0,0,s]},hdr,{bytesPerRow:this.width*8},[this.width,this.height,1]);
    const vp=new Float32Array(meta.viewProjection), projection=meta.projection??[];
    d.queue.writeBuffer(this.camera,s*80,new Float32Array([...vp,
      this.height*projection[5]*0.5,meta.apertureRadius??0,meta.focusDistance??1,0]));
    this.frames.set(s,frame);
  }
  async dispatch(current:number,source:number,symmetric:boolean,stage:number) {
    const d=this.device,p=new Uint32Array([this.width,this.height,this.slot(current),this.slot(source),source-current,symmetric?1:0,stage,Number(this.adaptiveRadius) | (Number(this.stabilizeSparkle)<<1)]);
    d.queue.writeBuffer(this.params,0,p);
    const h=this.history;
    const group=d.createBindGroup({layout:this.layout,entries:[this.params,this.surface,this.ids,this.hdr,h?.meta??this.camera,this.total,this.output,this.overflow,this.rejects].map((resource,binding)=>({binding,resource:resource instanceof GPUBuffer?{buffer:resource}:resource.createView({dimension:'2d-array'})}))});
    const encoder=d.createCommandEncoder();
    const pass=encoder.beginComputePass(this.query?{timestampWrites:{querySet:this.query,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{});
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
    if(this.query){encoder.resolveQuerySet(this.query,0,2,this.resolve,0);encoder.copyBufferToBuffer(this.resolve,0,this.timestamps,0,16);}
    d.queue.submit([encoder.finish()]);
  }
  async filter(current:number,neighbors:number[],symmetric:boolean) {
    const frames=this.frames;
    if(frames.get(this.slot(current))!==current)throw Error('Current frame is missing.');
    for(const source of neighbors)if(frames.get(this.slot(source))!==source)throw Error('Neighbor frame is missing: '+source);
    this.device.queue.writeBuffer(this.rejects,0,new Uint32Array(16));
    await this.dispatch(current,current,symmetric,0);
    for(const source of neighbors)await this.dispatch(current,source,symmetric,1);
    await this.dispatch(current,current,symmetric,2);
    return this.output;
  }
  async read(buffer:GPUBuffer=this.output,size:number=this.bytes){
    const d=this.device, staging=d.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{const encoder=d.createCommandEncoder();encoder.copyBufferToBuffer(buffer,0,staging,0,size);d.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);return staging.getMappedRange().slice(0);}
    finally{staging.destroy();}
  }
  async readSurface(frame:number,field=1){
    const d=this.device,size=this.width*this.height*8,staging=d.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{const encoder=d.createCommandEncoder();encoder.copyTextureToBuffer({texture:this.surface,origin:[0,0,this.slot(frame)*2+field]},{buffer:staging,bytesPerRow:this.width*8},[this.width,this.height,1]);d.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);return staging.getMappedRange().slice(0);}
    finally{staging.destroy();}
  }
  memory(){
    const pixels=this.width*this.height;
    const history=this.capacity*pixels*(2*8+16+8)+this.capacity*80+this.capacity*4096*32;
    const scratch=this.bytes*2+32;
    return {slots:this.capacity,history,scratch,total:history+scratch,bytesPerPixel:40};
  }
  dispose(){this.query?.destroy();for(const r of this.resources)r.destroy();this.resources=[];}
}
