// Fixed-pixel, one-sample manifold records. Decode +10 used by diagnostic HDR.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const output=resolve(process.env.MUTRACER_CAUSTICS_OUTPUT??'.cache/caustics-trace');mkdirSync(output,{recursive:true});
const fields=['receiver','initialPosition','shadingNormal','geometricNormal','iorReflectionInstance','emitter','etaResidualIteration','terminalReason','lastPosition'];
const pixels=[[64,60],[90,70],[65,124]],records=pixels.map(pixel=>({pixel,values:{}}));
for(let i=0;i<fields.length;i++) {
 const directory=resolve(output,fields[i]);mkdirSync(directory,{recursive:true});
 const result=spawnSync(process.execPath,['scripts/caustics-cornell.mjs','--on-only',...(process.argv.includes('--webgl')?['--webgl']:[])],{encoding:'utf8',env:{...process.env,MUTRACER_CAUSTICS_OUTPUT:directory,SPP:'1',WIDTH:'128',HEIGHT:'128',BOUNCES:'2',MNEE_DEBUG_GROUP:String(10+i)}});
 writeFileSync(resolve(directory,'command.txt'),result.stdout+result.stderr);if(result.status!==0)throw Error(fields[i]);
 const b=readFileSync(resolve(directory,`cornell-${process.argv.includes('--webgl')?'webgl':'webgpu'}-mnee-on.f32`));
 records.forEach(r=>r.values[fields[i]]=[0,1,2].map(c=>b.readFloatLE(((r.pixel[1]*128+r.pixel[0])*4+c)*4)-10));
 writeFileSync(resolve(output,'records.json'),JSON.stringify({sampleSequenceOffset:17,bounces:2,records},null,2));
}
