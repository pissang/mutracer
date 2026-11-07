import {Engine, Render, Camera, Mesh, InstancedMesh, Geometry, GeometryAttribute as Attribute, OpenPBRMaterial, RectLight, Texture} from '../../src/main.js';
import {generateVertexNormals, generateVertexTangents} from '../../src/util/geometry.js';

type Backend = 'webgpu' | 'webgl';
type Profile = {stages: Record<string, {ms: number; calls: number}>; uploadBytes: number; uploadMs: number; uploadCalls: number};
let profile: Profile;
function reset() { profile = {stages: {}, uploadBytes: 0, uploadMs: 0, uploadCalls: 0}; }
reset();
Object.assign(globalThis, {__p02hRecord(name: string, ms: number) {
  const stage = profile.stages[name] ??= {ms: 0, calls: 0}; stage.ms += ms; stage.calls++;
}});
function grid(segments = 12) {
  const n = segments + 1, positions = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), indices = new Uint32Array(segments * segments * 6);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = y * n + x; positions[v*3] = x/segments-.5; positions[v*3+2] = y/segments-.5; uv[v*2] = x/segments; uv[v*2+1] = y/segments; }
  for (let y = 0; y < segments; y++) for (let x = 0; x < segments; x++) { const v = y*n+x; indices.set([v,v+n,v+1,v+1,v+n,v+n+1], (y*segments+x)*6); }
  return new Geometry({position: new Attribute(positions,3), uv: new Attribute(uv,2), indices: new Attribute(indices,1)});
}
export function createUpdateFixture(count: number, instances: number, segments = 12) {
  const pixels=new Uint8Array(256).fill(128);for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
  const image = new Texture({width:8,height:8,data:pixels});
  const materials = Array.from({length:256}, (_, i) => { const m = new OpenPBRMaterial({map:i%2?image:undefined}); m.aovId = i+10000; return m; });
  const meshes: Mesh[] = Array.from({length:count}, (_, i) => { const m = new Mesh(grid(segments), materials[i%256]); m.transform[12] = (i%64)*1.1; m.transform[14] = Math.floor(i/64)*1.1; m.aovId = i+1; return m; });
  const batch = new InstancedMesh(meshes[0].geometry,materials[255],{count:instances}); batch.aovId = count+1;
  for(let i=0;i<instances;i++){batch.transforms[i*16+12]=(i%512)*1.1;batch.transforms[i*16+14]=100+Math.floor(i/512)*1.1;}
  if(instances)meshes.push(batch);
  const lights=Array.from({length:4},()=>{const l=new RectLight({intensity:.1});l.position=[2,8,2];l.lookAt([0,0,0]);return l;});
  const camera=new Camera({projection:'perspective',aspect:16/9});camera.position=[3,4,6];camera.lookAt([2,0,2]);
  meshes[0].geometry.dynamic=true;
  return {scene:{meshes,lights,background:[.05,.06,.08,1] as [number,number,number,number]},camera,batch,geometry:meshes[0].geometry};
}
async function context(backend: Backend, f: ReturnType<typeof createUpdateFixture>, width=640, height=360, aovs: 'id'[] = []) {
  const canvas=document.createElement('canvas'),engine=new Engine({canvas,backend});engine.display.setSize(width,height);engine.scene=f.scene;engine.camera=f.camera;
  const errors:string[]=[];engine.on('error',e=>errors.push(e.message));await engine.init();
  // API enqueue time and bytes; queue completion is measured separately below.
  if(backend==='webgpu') {const q=engine.device!.queue,original=q.writeBuffer.bind(q);q.writeBuffer=((...args: Parameters<GPUQueue['writeBuffer']>)=>{const t=performance.now();original(...args);const data=args[2],element=ArrayBuffer.isView(data)?('BYTES_PER_ELEMENT' in data?Number(data.BYTES_PER_ELEMENT):1):1;profile.uploadBytes+=(args[4]??(data.byteLength/element-(args[3]??0)))*element;profile.uploadCalls++;profile.uploadMs+=performance.now()-t;}) as GPUQueue['writeBuffer'];}
  else {const gl=canvas.getContext('webgl2')!;let pendingUploads=0;const original=gl.texSubImage2D.bind(gl);gl.texSubImage2D=((...args:any[])=>{const t=performance.now();(original as Function)(...args);const data=args[8];if(ArrayBuffer.isView(data)){const channels=args[6]===gl.RGBA?4:args[6]===gl.RG?2:1;const bytes=args[7]===gl.FLOAT||args[7]===gl.UNSIGNED_INT?4:args[7]===gl.HALF_FLOAT||args[7]===gl.UNSIGNED_SHORT?2:1;profile.uploadBytes+=args[4]*args[5]*channels*bytes;profile.uploadCalls++;if((globalThis as any).__p02hDrainGL&&++pendingUploads%128===0)gl.finish();profile.uploadMs+=performance.now()-t;}}) as typeof gl.texSubImage2D;}
  const render=new Render(engine,{width,height,maxSamples:1,bounces:4,aovs});engine.update();await render.converge({samples:1,timeoutMs:180000});
  return {engine,render,errors,async complete(){if(backend==='webgpu')await engine.device!.queue.onSubmittedWorkDone();else canvas.getContext('webgl2')!.finish();},dispose(){render.dispose();engine.dispose();}};
}
async function timed(c: Awaited<ReturnType<typeof context>>, edit:()=>void) {
  await c.complete(); reset();const start=performance.now();edit();const edited=performance.now();c.engine.update();const updated=performance.now();
  await c.render.converge({samples:1,sampleSequenceOffset:3,timeoutMs:180000});await c.complete();
  if(c.errors.length)throw Error(c.errors.join('\n'));
  return {editMs:edited-start,updateMs:updated-edited,totalMs:performance.now()-start,...structuredClone(profile)};
}
export async function measure(backend:Backend, instances=110000, count=4096, repeats=5, only='all') {
  const f=createUpdateFixture(count,instances),c=await context(backend,f),rows: Record<string, unknown>[]=[];Object.assign(globalThis,{__p02hRows:rows});
  try {
    const total=instances||count;
    for(const n of [...new Set([1,64,1024,16384,Math.floor(total/2),total])].filter(n=>n<=total && (only==='all'||only==='matrices'||only===String(n))))for(let repeat=0;repeat<=repeats;repeat++) {
      rows.push({name:'matrices',n,repeat,...await timed(c,()=>{if(instances){for(let i=0;i<n;i++)f.batch.transforms[i*16+12]+=(repeat%2?-.01:.01);f.batch.markTransformsUpdated(0,n);}else for(let i=0;i<n;i++)f.scene.meshes[i].transform[12]+=(repeat%2?-.01:.01);})});
    }
    for(const name of (only==='all'||only==='vertices'?['verticesSmall','verticesAll','deform']:[]))for(let repeat=0;repeat<=(name==='deform'?9:repeats);repeat++)rows.push({name,repeat,...await timed(c,()=>{
      const a=f.geometry.position.array,n=name==='verticesSmall'?1:a.length/3;for(let v=0;v<n;v++)a[v*3+1]=.02*Math.sin(v*.3+repeat*.4);
      const normal=f.geometry.normal;generateVertexNormals(f.geometry);normal.array.set(f.geometry.normal.array);f.geometry.normal=normal;
      if(f.geometry.tangent){const tangent=f.geometry.tangent;generateVertexTangents(f.geometry);tangent.array.set(f.geometry.tangent!.array);f.geometry.tangent=tangent;}f.geometry.markVerticesUpdated();
    })});
    return {backend,instances,count,repeats,width:640,height:360,userAgent:navigator.userAgent,rows};
  }finally{c.dispose();}
}
type Context = Awaited<ReturnType<typeof context>>;
async function capture(c: Context) {
  await c.render.converge({samples:16,sampleSequenceOffset:7,timeoutMs:180000}); await c.complete();
  const pixels=(await c.render.readPixels('hdr')).data,ids=(await c.render.readPixels('id')).data;
  const picks=[];for(const [x,y] of [[.5,.5],[.25,.4],[.75,.6],[.5,.2]])picks.push(await c.engine._pick(x,y));
  return {pixels,ids,picks:JSON.stringify(picks)};
}
function compare(a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) {
  let maxAbs=0,sum=0,differences=0,idDifferences=0;
  for(let i=0;i<a.pixels.length;i++){const d=Math.abs(a.pixels[i]-b.pixels[i]);if(d)differences++;maxAbs=Math.max(maxAbs,d);sum+=d*d;}
  for(let i=0;i<a.ids.length;i++)if(a.ids[i]!==b.ids[i])idDifferences++;
  return {differences,maxAbs,rmse:Math.sqrt(sum/a.pixels.length),idDifferences,picksEqual:a.picks===b.picks};
}
function parityFixture(instances:number,isolated=false) {
  const f=createUpdateFixture(24,instances);f.camera.position=[3.21,4,6.3];f.camera.lookAt([0,0,0]);
  for(let i=0;i<Math.min(instances,64);i++){f.batch.transforms[i*16+12]=(i%8)-4;f.batch.transforms[i*16+13]=.3;f.batch.transforms[i*16+14]=Math.floor(i/8)-4;}
  if(isolated)f.scene.meshes=[f.batch];
  return f;
}
type Fixture = ReturnType<typeof createUpdateFixture>;
/** Large batch, mixed commits and repeated shared deformation versus full preparation. */
export async function parity(backend:Backend,instances=16384,retainedFull=false,isolated=false) {
  const operations:[string,(f:Fixture)=>void][]=[
    ['one',f=>{f.batch.transforms[13]+=.2;f.batch.markTransformsUpdated(0,1);}],
    ['64',f=>{for(let i=0;i<Math.min(64,instances);i++)f.batch.transforms[i*16+13]+=.15;f.batch.markTransformsUpdated(0,Math.min(64,instances));}],
    ['half',f=>{for(let i=0;i<Math.floor(instances/2);i++)f.batch.transforms[i*16+12]+=.02;f.batch.markTransformsUpdated(0,Math.floor(instances/2));}],
    ['all',f=>{for(let i=0;i<instances;i++)f.batch.transforms[i*16+14]+=.02;f.batch.markTransformsUpdated();}],
    ...Array.from({length:4},(_,step)=>['deform'+step,(f:Fixture)=>{for(let v=0;v<f.geometry.vertexCount;v++)f.geometry.position.array[v*3+1]=.01*Math.sin(v+step);f.geometry.markVerticesUpdated();}] as [string,(f:Fixture)=>void]),
    ['mixed',f=>{f.geometry.position.array[1]+=.01;f.geometry.markVerticesUpdated();f.batch.transforms[13]+=.1;f.batch.markTransformsUpdated(0,1);}],
    ['invalid',f=>{f.batch.transforms[28]=NaN;f.batch.markTransformsUpdated(1,1);}],
    ['restore',f=>{f.batch.transforms[28]=-3;f.batch.markTransformsUpdated(1,1);}],
    ['allInvalid',f=>{for(let i=0;i<instances;i++)f.batch.transforms[i*16+15]=NaN;f.batch.markTransformsUpdated();}],
    ['allRestored',f=>{for(let i=0;i<instances;i++)f.batch.transforms[i*16+15]=1;f.batch.markTransformsUpdated();}]
  ];
  const f=parityFixture(instances,isolated),c=await context(backend,f,256,144,['id']),rows=[];
  const retained=retainedFull?parityFixture(instances,isolated):undefined,retainedContext=retained?await context(backend,retained,256,144,['id']):undefined;
  try {for(let step=0;step<operations.length;step++) {
    const [name,edit]=operations[step];edit(f);c.engine.update();const edited=await capture(c);
    const full=retained??parityFixture(instances,isolated);
    if(retained){edit(full);full.geometry.position.array=full.geometry.position.array.slice();full.geometry.markVerticesUpdated();retainedContext!.engine.update();}
    else for(let i=0;i<=step;i++)operations[i][1](full);
    const reference=retainedContext??await context(backend,full,256,144,['id']);
    try{rows.push({name,...compare(edited,await capture(reference))});}finally{if(!retainedContext)reference.dispose();}
  }return {backend,instances,retainedFull,isolated,rows};}finally{retainedContext?.dispose();c.dispose();}
}
/** Equal-content refit/rebuild throughput, excluding preparation and shader warmup. */
export async function quality(backend:Backend) {
  const f=createUpdateFixture(1,4096,48),c=await context(backend,f,640,360),rows=[];
  try{reset();for(let v=0;v<f.geometry.vertexCount;v++){f.geometry.position.array[v*3+1]=.002*Math.sin(v*.13);f.geometry.position.array[v*3]+=.025*Math.sin(f.geometry.position.array[v*3+2]*5);}
    const editStart=performance.now();
    f.geometry.markVerticesUpdated();c.engine.update();await c.render.converge({samples:1,timeoutMs:180000});await c.complete();const deformationStages=structuredClone(profile.stages),deformationMs=performance.now()-editStart;
    for(const rebuilt of [false,true]){if(rebuilt){f.geometry.markUpdated();c.engine.update();await c.render.converge({samples:1,timeoutMs:180000});await c.complete();}
      for(let repeat=0;repeat<5;repeat++){const start=performance.now();await c.render.converge({samples:128,sampleSequenceOffset:3+repeat*128,timeoutMs:180000});await c.complete();const ms=performance.now()-start;rows.push({rebuilt,repeat,ms,samplesPerSecond:128000/ms});}
    }return {backend,deformationStages,deformationMs,rows};
  }finally{c.dispose();}
}
Object.assign(window,{instanceVertexTests:{measure,parity,quality}});
