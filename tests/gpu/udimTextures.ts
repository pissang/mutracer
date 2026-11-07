import {Camera, Engine, Mesh, OpenPBRMaterial, Render, Texture, UdimTexture, createPlaneGeometry} from '../../src/main.js';

type Backend = 'webgpu'|'webgl';
type Binding = 'atlas'|'auto';
type Image = {width:number;height:number;data:Uint8Array};
const source=(r:number,g:number,b:number,width=4,height=4):Image=>({width,height,data:new Uint8Array(Array(width*height).fill([r,g,b,255]).flat())});
const black=source(0,0,0),red=source(255,0,0),green=source(0,255,0),blue=source(0,0,255);
const cases=[
  {name:'boundary',tiles:[[1001,red],[1002,green]] as const,uv:[0,2] as const,reference:[red,green]},
  {name:'missing',tiles:[[1001,red],[1003,blue]] as const,uv:[0,3] as const,reference:[red,black,blue]},
  {name:'negative',tiles:[[1001,green]] as const,uv:[-1,1] as const,reference:[black,green]},
  {name:'domain',tiles:[[1010,red]] as const,uv:[9,11] as const,reference:[red,black]},
  {name:'transform',tiles:[[1002,green],[1003,blue]] as const,uv:[0,1] as const,scale:[2,1] as const,offset:[1,0] as const,reference:[green,blue]},
  {name:'sizes',tiles:[[1001,source(255,128,0,1,2)],[1002,source(128,0,255,4,1)]] as const,uv:[0,2] as const,reference:[source(255,128,0,4,2),source(128,0,255,4,2)]},
];

function plane(u0=0,u1=1){const geometry=createPlaneGeometry(1,1,'vertical');geometry.uv!.array.set([u0,0,u1,0,u0,1,u1,1]);geometry.markUpdated();return geometry;}
function material(image:Image){const map=new Texture(image);map.colorSpace='linear';return new OpenPBRMaterial({map,emissiveMap:map,emissionLuminance:4,unlit:true});}
async function capture(backend:Backend,binding:Binding,test:typeof cases[number],udim:boolean){
  const engine=new Engine({backend,textureBinding:binding,canvas:document.createElement('canvas')});engine.display.setSize(72,24);
  const render=new Render(engine,{width:72,height:24,bounces:1,samplingPattern:'sobol'}),meshes:Mesh[]=[];
  if(udim){const map=new UdimTexture(test.tiles.map(([tile,image])=>({udim:tile,image})));map.colorSpace='linear';if(test.scale)map.uvScale=[...test.scale];if(test.offset)map.uvOffset=[...test.offset];const mesh=new Mesh(plane(...test.uv),new OpenPBRMaterial({map,emissiveMap:map,emissionLuminance:4,unlit:true}));mesh.transform[0]=test.reference.length;meshes.push(mesh);}
  else test.reference.forEach((image,index)=>{const mesh=new Mesh(plane(),material(image));mesh.position=[index*2-test.reference.length+1,0,0];meshes.push(mesh);});
  const camera=new Camera({projection:'orthographic',left:-test.reference.length,right:test.reference.length,top:1,bottom:-1});camera.position=[0,0,3];camera.lookAt([0,0,0]);engine.scene={meshes,lights:[]};engine.camera=camera;
  try{engine.update();await render.converge({samples:4,sampleSequenceOffset:0,timeoutMs:60000});const data=(await render.readPixels('hdr')).data.slice();return{data,active:engine.getDiagnostics()?.materialTextures?.active};}
  finally{render.dispose();engine.dispose();}
}
async function save(name:string,data:Float32Array){await fetch(`/evidence/${name}.f32`,{method:'POST',body:data});}
async function compare(backend:Backend,binding:Binding){const results=[];let active:string|undefined;for(const test of cases){const a=await capture(backend,binding,test,true),b=await capture(backend,binding,test,false);active=a.active;for(const [kind,image] of [['udim',a.data],['split',b.data]] as const){let colored=0,red=0,green=0,blue=0;for(let i=0;i<image.length;i+=4){const r=image[i],g=image[i+1],bl=image[i+2];if(!Number.isFinite(r+g+bl))throw new Error(`${test.name} ${kind}: non-finite pixel`);if(Math.max(r,g,bl)>1e-4)colored++;if(r>g*1.5&&r>bl*1.5)red++;if(g>r*1.5&&g>bl*1.5)green++;if(bl>r*1.5&&bl>g*1.5)blue++;}if(!colored)throw new Error(`${test.name} ${kind}: all-black render`);if(test.name==='boundary'&&(!red||!green))throw new Error(`${test.name} ${kind}: red/green tile colors not visible`);if(test.name==='missing'&&(!red||!blue))throw new Error(`${test.name} ${kind}: red/blue tile colors not visible`);if(test.name==='transform'&&(!green||!blue))throw new Error(`${test.name} ${kind}: transformed green/blue tile colors not visible`);}await save(`${backend}-${binding}-${test.name}-udim`,a.data);await save(`${backend}-${binding}-${test.name}-reference`,b.data);let maxError=0;for(let i=0;i<a.data.length;i++)maxError=Math.max(maxError,Math.abs(a.data[i]-b.data[i]));results.push({name:test.name,maxError,passed:maxError<2e-5});}return{binding,active,results,passed:results.every(row=>row.passed)};}
async function measure(backend:Backend,count:number){const tiles=Array.from({length:count},(_,i)=>({udim:1001+i,image:source((i*37)%256,(i*71)%256,(i*113)%256)}));const start=performance.now(),map=new UdimTexture(tiles),constructedMs=performance.now()-start;map.colorSpace='linear';const engine=new Engine({backend,canvas:document.createElement('canvas')});engine.display.setSize(16,16);const mesh=new Mesh(createPlaneGeometry(),new OpenPBRMaterial({map,unlit:true})),camera=new Camera({projection:'orthographic',left:-1,right:1,top:1,bottom:-1});camera.position=[0,3,0];camera.lookAt([0,0,0]);engine.scene={meshes:[mesh],lights:[]};engine.camera=camera;const render=new Render(engine,{bounces:1});try{const uploadStart=performance.now();engine.update();await render.converge({samples:1,timeoutMs:60000});const uploadMs=performance.now()-uploadStart,refineStart=performance.now();await render.converge({samples:9,timeoutMs:60000});const sampleMs=performance.now()-refineStart;return{count,constructedMs,uploadMs,estimatedBytes:engine.getDiagnostics()?.textureAtlas?.estimatedBytes,samplesPerSecond:8/sampleMs*1000};}finally{render.dispose();engine.dispose();}}
async function run(){const backend:Backend=location.search.includes('webgl')?'webgl':'webgpu',atlas=await compare(backend,'atlas'),bindless=backend==='webgpu'?await compare(backend,'auto'):undefined,performance=[];for(const count of [1,4,16,64])performance.push(await measure(backend,count));return{backend,atlas,bindless,performance,passed:atlas.passed&&(!bindless||bindless.active!=='bindless'||bindless.passed)};}
Object.assign(window,{runBenchmark:run});
