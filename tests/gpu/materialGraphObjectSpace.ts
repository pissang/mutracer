import {Engine,Render,Camera,Mesh,OpenPBRMaterial,MaterialGraph,GeometryAttribute,createPlaneGeometry} from '../../src/main.js';
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
Object.assign(window,{runBenchmark:async()=>{
 const backend=location.search.includes('webgl')?'webgl':'webgpu',rows=[];
 for(const category of ['position','normal']){
  const engine=new Engine({backend,canvas:document.createElement('canvas')});engine.display.setSize(48,48);
  const nodes:any[]=[{id:'geometry',category,type:'vector3'}];
  if(category==='position')nodes.push({id:'bias',category:'add',type:'vector3',inputs:{in1:{type:'vector3',connection:{node:'geometry'}},in2:{type:'vector3',value:[1,1,1]}}},{id:'scale',category:'multiply',type:'vector3',inputs:{in1:{type:'vector3',connection:{node:'bias'}},in2:{type:'float',value:0.5}}});
  nodes.push({id:'out',category:'convert',type:'color3',inputs:{in:{type:'vector3',connection:{node:category==='position'?'scale':'geometry'}}}});
  const graph=new MaterialGraph({nodes,terminal:{emissionColor:{node:'out'}}}),material=new OpenPBRMaterial({graph,unlit:true,emissionLuminance:1});
  const geometry=createPlaneGeometry(1,1,'vertical'),mesh=new Mesh(geometry,material);const c=Math.cos(0.4),s=Math.sin(0.4);mesh.transform[0]=c;mesh.transform[2]=-s;mesh.transform[8]=s;mesh.transform[10]=c;mesh.transform[12]=0.2;
  const camera=new Camera({projection:'orthographic',left:-1.5,right:1.5,top:1.5,bottom:-1.5});camera.position=[0,0,4];camera.lookAt([0,0,0]);engine.scene={meshes:[mesh],lights:[]};engine.camera=camera;
  const render=new Render(engine,{bounces:1});
  const settle=async()=>{engine.update();const started=performance.now();for(;;){render.refine();await pause();const status=engine.getDiagnostics()?.materialGraphs?.status;if(status==='failed')throw new Error(JSON.stringify(engine.getDiagnostics()?.materialGraphs));if(status!=='compiling'&&render.samples>0)break;if(performance.now()-started>60000)throw new Error('object-space timeout');}render.restart();await render.converge({samples:4,sampleSequenceOffset:0,timeoutMs:60000});return(await render.readPixels('hdr')).data.slice();};
  try{
   const image=await settle();material.graph=undefined;
   if(category==='position'){const colors=Float32Array.from(geometry.position.array,x=>(x+1)*0.5);geometry.color=new GeometryAttribute(colors,3);geometry.markUpdated();material.emissionColor=[1,1,1];}
   else material.emissionColor=[0,0,1];
   const reference=await settle();let maxError=0;for(let i=0;i<image.length;i++)maxError=Math.max(maxError,Math.abs(image[i]-reference[i]));
   await fetch(`/evidence/${backend}-object-${category}.f32`,{method:'POST',body:image});// The WebGPU reference stores vertex colors in RGB8; include its half-step
   // (0.5/255) plus one F16 output step (1/2048), independently of graph math.
   const tolerance=backend==='webgpu'&&category==='position'?0.5/255+1/2048:0.002;
   rows.push({category,maxError,tolerance,referenceEncoding:backend==='webgpu'?'RGB8 vertex colors / F16 output':'Float32 vertex colors / F16 output',passed:maxError<=tolerance});
  }finally{render.dispose();engine.dispose();}
 }
 return{backend,rows,passed:rows.every(r=>r.passed)};
}});
