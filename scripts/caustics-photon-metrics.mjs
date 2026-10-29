// node scripts/caustics-photon-metrics.mjs captures complete-energy-reference.{exr,f32}
// For clouds, also set BLOTCH_REFERENCE to a long capture of the same path class;
// use BLOTCH_REFERENCE_SPACE=display-linear for an OIDN capture. PT needs its own target.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {compare,loadHdr,resampleReference,cornellBlotchMasks,denoisedBlotchStatistics} from './caustics-compare.mjs';

import {displayLinear} from './caustics-study-color.mjs';

// Optional noise target must cover the same transport class as each candidate.
// BLOTCH_REFERENCE_SPACE=display-linear accepts an OIDN capture; default is HDR.
const directory=resolve(process.argv[2]), reference=loadHdr(resolve(process.argv[3]));
const noisePath=process.env.BLOTCH_REFERENCE,noiseReference=noisePath?loadHdr(resolve(noisePath)):null;
const files=readdirSync(directory).filter(f=>f.endsWith('.f32')&&(process.env.SCENE?f.startsWith(process.env.SCENE):true));
const rows=[];
for(const file of files){
 const candidate=loadHdr(resolve(directory,file));
 let matchingReference=reference;
 let masks;
 if(file.startsWith('sphere-')){
  // Floor intersections outside the sphere silhouette, inside a fixed world patch.
  const {width,height}=candidate,indices=[],core=[],tan=Math.tan(25*Math.PI/180);
  const eye=[3,2.6,4],len=Math.hypot(...eye),f=eye.map(v=>-v/len),r=[-f[2],0,f[0]],rl=Math.hypot(...r);r.forEach((_,i)=>r[i]/=rl);
  const u=[r[1]*f[2]-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]-r[1]*f[0]];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const a=(2*(x+.5)/width-1)*tan*width/height,b=(1-2*(y+.5)/height)*tan,d=f.map((v,i)=>v+r[i]*a+u[i]*b),t=-eye[1]/d[1];
   if(t<=0)continue;const p=eye.map((v,i)=>v+t*d[i]);if(Math.abs(p[0])>1.5||Math.abs(p[2])>1.5)continue;
   const o=[eye[0],eye[1]-.85,eye[2]],dot=o.reduce((s,v,i)=>s+v*d[i],0),dd=d.reduce((s,v)=>s+v*v,0),disc=dot*dot-dd*(o.reduce((s,v)=>s+v*v,0)-.8*.8);
   if(disc>=0&&(-dot-Math.sqrt(disc))/dd<t)continue;
   indices.push(y*width+x);
   if(p[0]>.05&&p[0]<1.2&&Math.abs(p[2])<.6)core.push(y*width+x);
  }
  masks={causticFloor:indices,causticCore:core};
 }
 const verticalFov=file.startsWith('cornell-');
 const hdrReference=resampleReference(matchingReference,candidate.width,candidate.height,{verticalFov});
 const oidn=file.includes('-oidn');
 const referenceImage=oidn?displayLinear(hdrReference):hdrReference;
 const result=compare(referenceImage,[{path:file,image:candidate}],{masks,verticalFov,gaussianSigma:Number(process.env.GAUSSIAN_SIGMA??0)*candidate.height/544});
 // Quantify filtering against the same display-linear target, keeping raw HDR
 // energy agreement as an independent metric with its own units.
 let before;
 if(oidn){const raw=loadHdr(resolve(directory,file.replace('-oidn','')));before=compare(referenceImage,[{path:file,image:displayLinear(raw)}],{masks,verticalFov,gaussianSigma:Number(process.env.GAUSSIAN_SIGMA??0)*candidate.height/544});}
 const metadata=JSON.parse(readFileSync(resolve(directory,file.replace('.f32','.json'))));
 // Keep noise diagnosis separate from energy agreement. The reference may be a
 // long-batch capture of the same path class; never compare PT noise to missing
 // transport in a different estimator. Masks follow geometry, not brightness.
 if(oidn&&noiseReference&&file.includes('-pt-')===basename(noisePath).includes('-pt-')){
  const matched=resampleReference(noiseReference,candidate.width,candidate.height,{verticalFov});
  const noiseTarget=process.env.BLOTCH_REFERENCE_SPACE==='display-linear'?matched:displayLinear(matched);
  const raw=displayLinear(loadHdr(resolve(directory,file.replace('-oidn',''))));
  const noiseMasks=masks??cornellBlotchMasks(candidate.width,candidate.height,{verticalFov});
  for(const [region,indices]of Object.entries(noiseMasks))rows.push({region,path:file,
   space:'AgX display-linear',samples:metadata.samples,traceMs:metadata.traceMs,totalMs:metadata.totalMs,
   denoisedBlotch:denoisedBlotchStatistics(raw,candidate,noiseTarget,indices,1.5*candidate.height/544)});
 }
 for(const row of result.rows)rows.push({...row,space:oidn?'AgX display-linear':'HDR radiance',beforeDenoise:before?.rows.find(r=>r.region===row.region),samples:metadata.samples,traceMs:metadata.traceMs,totalMs:metadata.totalMs,denoiseMs:metadata.denoiseMs});
}
writeFileSync(resolve(directory,(process.env.SCENE??'all')+'-metrics.json'),JSON.stringify({directory,reference:process.argv[3],rows},null,2));
for(const row of rows.filter(r=>r.samples===64&&r.relativeError))console.log(basename(row.path),row.region,(row.relativeError.trimmedMean*100).toFixed(2),row.logRMSE.toFixed(4),row.relativeGradientError.toFixed(3));
