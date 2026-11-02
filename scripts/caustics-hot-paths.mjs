// Classify actual post-MIS PT contributions above 100 using deterministic HDR counters.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {cornellRegions} from './caustics-compare.mjs';
const output=resolve(process.env.MUTRACER_CAUSTICS_OUTPUT??'.cache/caustics-hot');mkdirSync(output,{recursive:true});
const groups=(process.env.HOT_GROUPS??'30,31,32,39').split(',').map(Number),depths=(process.env.HOT_DEPTHS??'2,20').split(',').map(Number);
const samples=Number(process.env.SPP??128),size=Number(process.env.WIDTH??256),estimator=process.env.CAUSTIC_ESTIMATOR??'photon',results=[];
for(const depth of depths){const totals={},images={};
 for(const group of groups){
  const directory=resolve(output,`depth-${depth}-group-${group}`);mkdirSync(directory,{recursive:true});const file=resolve(directory,`cornell-webgpu-${estimator}-on.f32`);
  if(!process.argv.includes('--resume')||!existsSync(file)){
   const command=spawnSync(process.execPath,['scripts/caustics-cornell.mjs','--on-only'],{encoding:'utf8',env:{...process.env,MUTRACER_CAUSTICS_OUTPUT:directory,CAUSTIC_ESTIMATOR:estimator,PHOTON_MAX_DEPTH:String(depth),MNEE_DEBUG_GROUP:String(group),WIDTH:String(size),HEIGHT:String(size),SPP:String(samples),PHOTONS_PER_SAMPLE:process.env.PHOTONS_PER_SAMPLE??'65536',PHOTON_RADIUS:'.05'}});
   writeFileSync(resolve(directory,'command.txt'),command.stdout+command.stderr);if(command.status!==0)throw Error(directory);
  }
  const b=readFileSync(file),image=new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);images[group]=image;const sum=[0,0,0];
  for(let i=0;i<image.length;i+=4)for(let c=0;c<3;c++)sum[c]+=image[i+c]*samples;
  totals[group]=sum;
 }
 const pixels=[];if(images[30])for(let p=0;p<size*size;p++)if(images[30][p*4]>0){
  const values=Object.fromEntries(groups.map(group=>[group,Array.from(images[group].slice(p*4,p*4+3),v=>v*samples)]));
  pixels.push({pixel:[p%size,Math.floor(p/size)],values});
 }
 const regions={};for(const [name,rectangle]of Object.entries(cornellRegions)){
  const r=rectangle.map(v=>Math.round(v*size/256));regions[name]=Object.fromEntries(groups.map(group=>{const sum=[0,0,0];for(let y=r[1];y<r[3];y++)for(let x=r[0];x<r[2];x++)for(let c=0;c<3;c++)sum[c]+=images[group][(y*size+x)*4+c]*samples;return[group,sum];}));
 }
 results.push({depth,estimator,samples,size,totals,regions,pixels});
 writeFileSync(resolve(output,'summary.json'),JSON.stringify({threshold:100,source:'actual contributions after MIS and visibility, before sample radiance clamping',groups:{30:'count, depth sum, smooth-chain sum',31:'hasReceiver, singleT, receiverPrimary counts',32:'MNEE receiver, photon receiver counts, summed peak contribution',39:'NEE, BSDF emissive, analytic hit counts',40:'MNEE estimate count, depth sum, summed peak contribution',41:'photon estimate count, depth sum, summed peak contribution',42:'emitter cosine + 1, fromEye, doubleSided sums',43:'emitter MIS weight, material type, light weight total',44:'BSDF PDF, emission luminance, peak throughput'},results},null,2));
 console.log({depth,totals});
}
