import {Engine,Render,Camera,Mesh,OpenPBRMaterial,MaterialGraph,Texture,AmbientLight,createPlaneGeometry} from '../../src/main.js';
import {collectEmissiveTriangles} from '../../src/renderer/lightSampling.js';
const pause=()=>new Promise(r=>setTimeout(r,10));
async function run(){
 const backend='webgpu',rows=[];
 for(const test of [{port:'emissionColor',map:false},{port:'emissionLuminance',map:false},{port:'coatWeight',map:false},{port:'emissionColor',map:true}]){
  const {port}=test,name=port+(test.map?'-map':'');
  const engine=new Engine({backend,canvas:document.createElement('canvas')});engine.display.setSize(48,48);
  const graph=new MaterialGraph({nodes:[{id:'uv',category:'normal',type:'vector3'},{id:'color',category:'convert',type:'color3',inputs:{in:{type:'vector3',connection:{node:'uv'}}}},{id:'scalar',category:'extract',type:'float',inputs:{in:{type:'vector3',connection:{node:'uv'}}}}],terminal:{[port]:{node:port==='emissionColor'?'color':'scalar'}}});
  const material=new OpenPBRMaterial({graph,emissionColor:[1,0.3,0.1],emissionLuminance:5,coatWeight:0.6,coatColor:[0.3,0.6,1]});
  if(test.map){material.emissiveMap=new Texture({width:2,height:2,data:new Float32Array([1,.2,.1,1,.2,1,.1,1,.1,.2,1,1,1,.5,.2,1])});material.emissiveMap.colorSpace='linear';}
  const emitter=new Mesh(createPlaneGeometry(1,1,'vertical'),material);emitter.position=[0,0,1];emitter.transform[0]=-0.3;emitter.transform[5]=0.3;emitter.transform[10]=-1;
  const receiver=new Mesh(createPlaneGeometry(3,3,'vertical'),new OpenPBRMaterial({baseColor:[0.6,0.6,0.6],specularRoughness:0.5}));
  const camera=new Camera({projection:'orthographic',left:-1,right:1,top:1,bottom:-1});camera.position=[0.6,0.4,3];camera.lookAt([0,0,0]);engine.scene={meshes:[receiver,emitter],lights:[new AmbientLight({intensity:0.05})],background:[0.1,0.1,0.1,1]};engine.camera=camera;
  const render=new Render(engine,{bounces:3,directLightCandidates:1,samplingPattern:'sobol'});
  const settle=async()=>{engine.update();render.restart();await render.converge({samples:32,sampleSequenceOffset:0,timeoutMs:90000});await pause();return(await render.readPixels('hdr')).data.slice();};
  try{
   const image=await settle(),diagnostics=engine.getDiagnostics();material.graph=undefined;const reference=await settle();let maxError=0;for(let i=0;i<image.length;i++)maxError=Math.max(maxError,Math.abs(image[i]-reference[i]));
   const fallback=diagnostics?.materialGraphs?.diagnostics.some(d=>d.code==='unsupported-emission-graph'&&d.port===port),emissiveTriangles=collectEmissiveTriangles([{mesh:emitter,geometry:emitter.geometry,materialIndices:[0]}],[material]).length,nonblack=image.some((x,i)=>i%4<3&&x>0.02);
   await fetch(`/evidence/${backend}-lit-fallback-${name}.f32`,{method:'POST',body:image});await fetch(`/evidence/${backend}-lit-fallback-${name}-reference.f32`,{method:'POST',body:reference});
   material.emissionLuminance=0;const dark=await settle();let emissionDifference=0,receiverEmissionDifference=0;for(let i=0;i<reference.length;i++){const delta=Math.abs(reference[i]-dark[i]);emissionDifference=Math.max(emissionDifference,delta);if(Math.floor(i/4)%48>=36&&i%4<3)receiverEmissionDifference=Math.max(receiverEmissionDifference,delta);}
   rows.push({name,port,emissionDifference,receiverEmissionDifference,lightSampling:diagnostics?.lightSampling,maxError,fallback,emissiveTriangles,nonblack,diagnostics:diagnostics?.materialGraphs,passed:!!fallback&&emissiveTriangles>0&&(backend!=='webgpu'||(diagnostics?.lightSampling?.emissiveTriangles??0)>0)&&receiverEmissionDifference>0.01&&nonblack&&maxError<0.003});
  }finally{render.dispose();engine.dispose();}
 }
 return{backend,rows,passed:rows.every(r=>r.passed)};
}
Object.assign(window,{runBenchmark:run});
