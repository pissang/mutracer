import WGPURayTracePass from '../../src/renderer/WGPURayTracePass.js';
import {Engine,Render,Camera,Mesh,InstancedMesh,OpenPBRMaterial,MaterialGraph,Texture,GeometryAttribute,createPlaneGeometry} from '../../src/main.js';
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
const backend=location.search.includes('webgl')?'webgl':'webgpu';
async function capture(name:string, graph:MaterialGraph|undefined, unlit=false, luminance=4, candidates=1, samples=128, instanced=false, secondary=false) {
 const query=new URLSearchParams(location.search),only=query.get('case');
 if(only && !name.startsWith(only))return {name,skipped:true};
 samples=Number(query.get('samples')) || samples;
 // Test-only BSDF reference: disable both NEE choices and its competing PDF.
 const prototype=WGPURayTracePass.prototype as unknown as {_updateLightSamplingData:()=>void};
 const update=prototype._updateLightSamplingData;
 if(candidates===0)prototype._updateLightSamplingData=function(this:{_rtUniform:{views:{lightChoiceCount:Int32Array;lightWeightTotal:Float32Array}}}) {update.call(this);this._rtUniform.views.lightChoiceCount[0]=0;this._rtUniform.views.lightWeightTotal[0]=0;};
 const engine=new Engine({backend,canvas:document.createElement('canvas')});engine.display.setSize(48,48);
 const material=new OpenPBRMaterial({graph,unlit,emissionColor:[1,.3,.1],emissionLuminance:luminance,coatWeight:.6,coatColor:[.3,.6,1],baseColor:[.1,.1,.1]});
 if(secondary) {
  material.uvProjectionScale=[.7,1.3];
  material.coatWeightMap=new Texture({width:2,height:2,data:new Float32Array([.1,0,0,1,.8,0,0,1,.4,0,0,1,1,0,0,1])});material.coatWeightMap.colorSpace='linear';material.coatWeightMap.uvChannel=1;
 }
 const geometry=createPlaneGeometry(1,1,'vertical');
 if(secondary)geometry.uv1=new GeometryAttribute(Float32Array.from(geometry.uv!.array,v=>1-v),2);
 const emitter=instanced ? new InstancedMesh(geometry,material,{count:2}) : new Mesh(geometry,material);
 if(emitter instanceof InstancedMesh){emitter.transforms[0]=emitter.transforms[5]=emitter.transforms[16]=emitter.transforms[21]=.5;emitter.transforms[12]=-.7;emitter.transforms[28]=.7;}emitter.position=[0,0,1];emitter.transform[0]=-.8;emitter.transform[5]=.8;emitter.transform[10]=-1;
 const receiver=new Mesh(createPlaneGeometry(4,4,'vertical'),new OpenPBRMaterial({baseColor:[.6,.6,.6],specularWeight:0}));
 const camera=new Camera({projection:'orthographic',left:-1,right:1,top:1,bottom:-1});camera.position=[.9,.3,3];camera.lookAt([0,0,0]);
 engine.scene={meshes:[receiver,emitter],lights:[],background:[0,0,0,1]};engine.camera=camera;
 const render=new Render(engine,{bounces:3,directLightCandidates:candidates,samplingPattern:'sobol'});
 try {
  engine.update();const start=performance.now();
  while(true){render.refine();await pause();const state=engine.getDiagnostics()?.materialGraphs;if(backend==='webgpu'&&state?.status==='failed')throw Error(JSON.stringify(state));if(state?.status!=='compiling'&&render.samples>0)break;if(performance.now()-start>90000)throw Error('Graph compilation timed out');}
  render.restart();await render.converge({samples,sampleSequenceOffset:0,timeoutMs:180000});
  const pixels=await render.readPixels('hdr');await fetch(`/evidence/${backend}-${name}.f32`,{method:'POST',body:pixels.data});
  return {name,diagnostics:engine.getDiagnostics(),width:pixels.width,height:pixels.height,finite:pixels.data.every(Number.isFinite)};
 }finally{render.dispose();engine.dispose();prototype._updateLightSamplingData=update;}
}
const uvGraph=()=>new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2'},{id:'color',category:'convert',type:'color3',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}],terminal:{emissionColor:{node:'color'}}});
Object.assign(window,{runBenchmark:async()=>{
 const rows=[];
 rows.push(await capture('constant',undefined));
 rows.push(await capture('unlit',uvGraph(),true));
 if(!location.search.includes('baseline')) {
  rows.push(await capture('lit',uvGraph(),false,4,1,8192));
  if(backend==='webgpu')rows.push(await capture('lit-bsdf',uvGraph(),false,4,0,8192));
  const graph=uvGraph();graph.setNode({id:'gain',category:'constant',type:'float',inputs:{value:{type:'float',value:4}}}).setTerminal({emissionColor:{node:'color'},emissionLuminance:{node:'gain'}});
  rows.push(await capture('black-fallback',graph,false,0,1,8192));
  if(backend==='webgl') {rows.push(await capture('fallback-reference',undefined,false,4,1,8192));rows.push(await capture('black-fallback-reference',undefined,false,0,1,8192));}
  if(backend==='webgpu') {
   rows.push(await capture('black-fallback-bsdf',graph,false,0,0,8192));
   const objectGraph=new MaterialGraph({nodes:[{id:'p',category:'position',type:'vector3'},{id:'shift',category:'add',type:'vector3',inputs:{in1:{type:'vector3',connection:{node:'p'}},in2:{type:'vector3',value:[1.1,1.1,1.1]}}},{id:'c',category:'convert',type:'color3',inputs:{in:{type:'vector3',connection:{node:'shift'}}}}],terminal:{emissionColor:{node:'c'}}});
   rows.push(await capture('instances',objectGraph,false,4,1,8192,true));
   rows.push(await capture('instances-bsdf',objectGraph,false,4,0,8192,true));
   const coat=uvGraph();coat.setNode({id:'weight',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}).setTerminal({emissionColor:{node:'color'},coatWeight:{node:'weight'},coatColor:{node:'color'}});
   rows.push(await capture('coat',coat,false,4,1,8192));
   rows.push(await capture('coat-bsdf',coat,false,4,0,8192));
   const secondary=uvGraph();secondary.setInput('uv','index',{type:'integer',value:1});
   rows.push(await capture('uv1-coat-map',secondary,false,4,1,8192,false,true));
   rows.push(await capture('uv1-coat-map-bsdf',secondary,false,4,0,8192,false,true));
  }
 }
 return {backend,rows};
}});
