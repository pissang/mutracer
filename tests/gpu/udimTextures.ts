import {Camera, Engine, Mesh, OpenPBRMaterial, Render, Texture, UdimTexture, createPlaneGeometry} from '../../src/main.js';

const source = (r: number, g: number, b: number) => ({width: 4, height: 4, data: new Uint8Array(Array(16).fill([r,g,b,255]).flat())});
async function capture(backend: 'webgpu'|'webgl', udim: boolean) {
  const engine = new Engine({backend, canvas: document.createElement('canvas')}); engine.display.setSize(48,24);
  const render = new Render(engine,{bounces:1,samplingPattern:'sobol'}), geometry=createPlaneGeometry();
  const red=source(255,0,0),green=source(0,255,0), meshes:Mesh[]=[];
  if(udim){geometry.uv!.array.set([0,0,2,0,0,1,2,1]);geometry.markUpdated();const map=new UdimTexture([{udim:1001,image:red},{udim:1002,image:green}]);map.colorSpace='linear';const mesh=new Mesh(geometry,new OpenPBRMaterial({map,unlit:true}));mesh.transform[0]=2;meshes.push(mesh);}
  else for(const [x,image] of [[-1,red],[1,green]] as const){const map=new Texture(image);map.colorSpace='linear';const mesh=new Mesh(geometry,new OpenPBRMaterial({map,unlit:true}));mesh.position=[x,0,0];meshes.push(mesh);}
  const camera=new Camera({projection:'orthographic',left:-2,right:2,top:1,bottom:-1});camera.position=[0,3,0];camera.lookAt([0,0,0]);engine.scene={meshes,lights:[]};engine.camera=camera;
  try{engine.update();await render.converge({samples:4,sampleSequenceOffset:0,timeoutMs:60000});return (await render.readPixels('hdr')).data.slice();}
  finally{render.dispose();engine.dispose();}
}
async function measure(backend:'webgpu'|'webgl',count:number){const tiles=Array.from({length:count},(_,i)=>({udim:1001+i,image:source((i*37)%256,(i*71)%256,(i*113)%256)}));const start=performance.now(),map=new UdimTexture(tiles),constructedMs=performance.now()-start;map.colorSpace='linear';const engine=new Engine({backend,canvas:document.createElement('canvas')});engine.display.setSize(16,16);const material=new OpenPBRMaterial({map,unlit:true}),mesh=new Mesh(createPlaneGeometry(),material),camera=new Camera({projection:'orthographic',left:-1,right:1,top:1,bottom:-1});camera.position=[0,3,0];camera.lookAt([0,0,0]);engine.scene={meshes:[mesh],lights:[]};engine.camera=camera;const render=new Render(engine,{bounces:1});try{const uploadStart=performance.now();engine.update();await render.converge({samples:1,timeoutMs:60000});const uploadMs=performance.now()-uploadStart,refineStart=performance.now();await render.converge({samples:9,timeoutMs:60000});const sampleMs=performance.now()-refineStart;return{count,constructedMs,uploadMs,estimatedBytes:engine.getDiagnostics()?.textureAtlas?.estimatedBytes,samplesPerSecond:8/sampleMs*1000};}finally{render.dispose();engine.dispose();}}
async function run(){const backend=location.search.includes('webgl')?'webgl':'webgpu';const a=await capture(backend,true),b=await capture(backend,false);let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));const performance=[];for(const count of [1,4,16,64])performance.push(await measure(backend,count));return{backend,maxError:max,passed:max<2e-5,performance};}
Object.assign(window,{runBenchmark:run});
