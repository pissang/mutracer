// Read private counter images from deterministic headless captures.
import{cornellRegions}from'./caustics-compare.mjs';
import{spawn}from'node:child_process';import{mkdirSync,readFileSync,writeFileSync,existsSync}from'node:fs';import{resolve}from'node:path';
const out=resolve(process.env.MUTRACER_CAUSTICS_OUTPUT??'.cache/caustics-stats');mkdirSync(out,{recursive:true});
const samples=Number(process.env.SPP??16),rows=[];
const labels=['attempts','sourceRejected','initialMiss','interfaceRejected','singularJacobian','projectionMiss','constraintResidual','tirOrDirectionMismatch','occlusionOrFacing','emitterOrientationOrSpread','acceptedCandidates','newtonIterations','closestQueries','shadowQueries','reserved','initialInterface','initialReflection','initialNonSpecular','initialInterfaceRejected','iteratedInterfaceRejected','reserved2'];
for(const backend of (process.env.CAUSTIC_STATS_BACKENDS??'webgpu,webgl').split(','))for(const scene of (process.env.CAUSTIC_STATS_SCENES??'plane,wave,cornell').split(',')){
 const values=Array(21).fill(0),regions=Object.fromEntries(Object.keys(cornellRegions).map(k=>[k,Array(21).fill(0)]));let pixels=0;
 for(let group=0;group<7;group++){
  const directory=resolve(out,`${scene}-${backend}-${group}`);mkdirSync(directory,{recursive:true});console.log(scene,backend,group);
  const args=scene==='cornell'?['scripts/caustics-cornell.mjs','--on-only']:['scripts/caustics-capture.mjs',...(scene==='wave'?['--wave']:[])];if(backend==='webgl')args.push('--webgl');
  const file=scene==='cornell'?`cornell-${backend}-mnee-on.f32`:`${backend}-mnee.f32`;
  if(!process.argv.includes('--resume')||!existsSync(resolve(directory,file)))await new Promise((done,reject)=>{const child=spawn(process.execPath,args,{cwd:process.cwd(),env:{...process.env,MUTRACER_CAUSTICS_OUTPUT:directory,WIDTH:'128',HEIGHT:scene==='cornell'?'128':'96',SPP:String(samples),CAUSTIC_MODES:'mnee',MNEE_DEBUG_GROUP:String(group)}});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);child.on('error',reject);child.on('close',code=>{writeFileSync(resolve(directory,'command.txt'),log);code===0?done():reject(Error('Counter capture failed: '+directory));});});
  const b=readFileSync(resolve(directory,file));const image=new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);pixels=image.length/4;
  for(let i=0;i<image.length;i+=4)for(let c=0;c<3;c++)values[group*3+c]+=image[i+c];
  if(scene==='cornell')for(const [key,rectangle]of Object.entries(cornellRegions)){
   const r=rectangle.map(v=>Math.round(v/2));for(let y=r[1];y<r[3];y++)for(let x=r[0];x<r[2];x++)for(let c=0;c<3;c++)regions[key][group*3+c]+=image[(y*128+x)*4+c];
  }
 }
 const counters=Object.fromEntries(labels.map((key,i)=>[key,values[i]]));
 rows.push({scene,backend,samples,pixels,attempts:samples*values[0],acceptance:values[10]/Math.max(values[0],1),accountingResidual:values[0]-values.slice(1,11).reduce((s,v)=>s+v,0),perFullSample:counters,...(scene==='cornell'?{regions:Object.fromEntries(Object.entries(regions).map(([key,v])=>[key,{acceptance:v[10]/Math.max(v[0],1),counters:Object.fromEntries(labels.map((key,i)=>[key,v[i]]))}]))}:{})});
 writeFileSync(resolve(out,'summary.json'),JSON.stringify({note:'Accepted candidates include duplicate roots; counts are logical solver/traversal calls. GLSL combines emitter-facing rejection with shadow rejection.',rows},null,2));
}
