import {Engine, Render, Camera, Mesh, OpenPBRMaterial, MaterialGraph, Texture, AmbientLight, SphereLight, createPlaneGeometry, type MaterialAlphaMode} from '../../src/main.js';
const pause=()=>new Promise(r=>setTimeout(r,10));
async function run(){
 const backend=location.search.includes('webgl')?'webgl':'webgpu',rows=[];
 for(const mode of ['auto','opaque','mask','blend'] as MaterialAlphaMode[])for(const cutoff of mode==='mask'?[0.25,0.5]:[0])for(const uvScale of mode==='blend'?[1,2]:[1])for(const mapped of mode==='blend'&&uvScale===1?[false,true]:[false]){
  const canvas=document.createElement('canvas'),engine=new Engine({backend,canvas});engine.display.setSize(48,48);
  const graph=new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2'},{id:'alpha',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}},index:{type:'integer',value:0}}}],terminal:{geometryOpacity:{node:'alpha'}}});
  const material=new OpenPBRMaterial({graph,uvProjectionScale:[uvScale,1],alphaMode:mode,alphaCutoff:cutoff,baseColor:[0.7,0.15,0.05],specularRoughness:0.5});
  if(mapped){material.alphaMap=new Texture({width:1,height:1,data:new Float32Array([0.5,0.5,0.5,1])});material.alphaMap.colorSpace='linear';}
  const blocker=new Mesh(createPlaneGeometry(1,1,'vertical'),material);blocker.position=[0,0,0.6];blocker.transform[0]=0.4;blocker.transform[5]=0.4;blocker.geometry.uv!.array.fill(0.37);
  const receiver=new Mesh(createPlaneGeometry(4,4,'vertical'),new OpenPBRMaterial({baseColor:[0.5,0.6,0.7],specularRoughness:0.7}));
  const light=new SphereLight({radius:0,intensity:8});light.position=[1.5,1,2];
  const camera=new Camera({projection:'orthographic',left:-1,right:1,top:1,bottom:-1});camera.position=[0,0,3];camera.lookAt([0,0,0]);
  engine.scene={meshes:[receiver,blocker],lights:[light,new AmbientLight({intensity:0.1})],background:[0.2,0.3,0.4,1]};engine.camera=camera;
  const render=new Render(engine,{bounces:3,samplingPattern:'sobol',directLightCandidates:1});
  const settle=async()=>{engine.update();const start=performance.now();for(;;){render.refine();await pause();const d=engine.getDiagnostics()?.materialGraphs;if(d?.status==='failed')throw Error(JSON.stringify(d));if(d?.status!=='compiling'&&render.samples)break;if(performance.now()-start>90000)throw Error('timeout');}render.restart();await render.converge({samples:32,sampleSequenceOffset:0,timeoutMs:90000});return (await render.readPixels('hdr')).data.slice();};
  try{
   const pixels=await settle();material.graph=undefined;material.opacity=0.37*uvScale;const reference=await settle();let maxError=0;for(let i=0;i<pixels.length;i++)maxError=Math.max(maxError,Math.abs(pixels[i]-reference[i]));
   material.alphaMode='opaque';material.opacity=1;const solid=await settle();material.alphaMode='blend';material.opacity=0;const clear=await settle();let coverageDifference=0;for(let i=0;i<solid.length;i++)coverageDifference=Math.max(coverageDifference,Math.abs(solid[i]-clear[i]));
   const nonblack=pixels.some((v,i)=>i%4<3&&v>0.05);const name=`opacity-${mode}-${cutoff}-${uvScale}${mapped?'-map':''}`;
   await fetch(`/evidence/${backend}-${name}.f32`,{method:'POST',body:pixels});await fetch(`/evidence/${backend}-${name}-reference.f32`,{method:'POST',body:reference});
   rows.push({name,maxError,coverageDifference,nonblack,passed:coverageDifference>0.01&&nonblack&&maxError<0.003});
  }finally{render.dispose();engine.dispose();}
 }
 return {backend,rows,passed:rows.every(r=>r.passed)};
}
Object.assign(window,{runBenchmark:run});
