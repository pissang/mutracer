// Historical stage 1 screen: new captures of removed variants require
// MUTRACER_EXPERIMENT_ROOT pointing to the archived experiment checkout.
// One candidate: node scripts/caustics-noise-shape.mjs hash2 --groups 2
// Evidence/reference inputs stay outside the repository. No public render defaults change.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadHdr,resampleReference,cornellBlotchMasks,cornellRegions,denoisedBlotchStatistics,statistics} from './caustics-compare.mjs';
import {displayLinear} from './caustics-study-color.mjs';
const args=process.argv.slice(2),name=args.shift();
if(!name||!/^[\w-]+$/.test(name))throw Error('Expected candidate name');
const option=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
const groups=Number(option('groups',0)),pattern=option('pattern','hash');
const radius=Number(option('radius',2)),divisor=Number(option('divisor',4));
if(![0,2,4,8].includes(groups)||!['hash','stratified'].includes(pattern)||!(radius>0)||!(divisor>0))throw Error('Invalid subset/radius/density configuration');
const E=resolve(process.env.MUTRACER_NOISE_EVIDENCE??'/Users/lang/.codex/experiments/mutracer-caustics-noise-shape-20261030');
const old=resolve(process.env.MUTRACER_NOISE_REFERENCE??'/Users/lang/.codex/experiments/mutracer-caustics-blotch-bias-20261029');
const directory=resolve(E,name),samples=Number(option('samples',64)),seed=Number(option('seed',17)),sequenceSeed=Number(option('sequence-seed',0));
const mode=option('mode','photon'),stem=resolve(directory,`cornell-960x544-${mode}-${samples}`);
if(!Number.isInteger(samples)||samples<1||!Number.isInteger(seed)||seed<0||!['photon','light-photon'].includes(mode))throw Error('Invalid capture configuration');
mkdirSync(directory,{recursive:true});
const config={groups,pattern,radius,divisor,seed,samples,mode,...(sequenceSeed?{sequenceSeed}:{})};
const configPath=resolve(directory,`configuration-${mode}-${samples}.json`);
if(existsSync(configPath)&&JSON.stringify(JSON.parse(readFileSync(configPath)))!==JSON.stringify(config))throw Error('Cached candidate has different settings; choose a new name');
if(!existsSync(stem+'-oidn.f32')) {
 const env={...process.env,MUTRACER_CAUSTICS_OUTPUT:directory,WIDTH:'960',HEIGHT:'544',STUDY_SCENES:'cornell',STUDY_MODES:mode,CHECKPOINTS:String(samples),SEED:String(seed),SEQUENCE_SEED:String(sequenceSeed),DENOISE:'1',
 SUBSET_GROUPS:String(groups),SUBSET_PATTERN:pattern,SCREEN_PIXELS:String(radius),PHOTON_DIVISOR:String(divisor)};
 const run=spawnSync(process.execPath,['scripts/photon-grid-study.mjs'],{env,encoding:'utf8',timeout:240000,maxBuffer:4e6});
 writeFileSync(resolve(E,name+'.log'),(run.stdout??'')+(run.stderr??''));
 if(run.error||run.status!==0)throw run.error??Error('Capture failed: '+run.stderr);
}
writeFileSync(configPath,JSON.stringify(config,null,2));
const raw=loadHdr(stem+'.f32'),oidn=loadHdr(stem+'-oidn.f32'),display=displayLinear(raw);
const target=loadHdr(resolve(old,'ab-50-combined/cornell-960x544-light-photon-1024-oidn.f32'));
const reference=displayLinear(resampleReference(loadHdr(resolve(old,'reference-pbrt/cornell-rgb-aligned-512.f32')),960,544,{verticalFov:true}));
const masks=cornellBlotchMasks(960,544,{verticalFov:true});
for(const key of ['underwaterBackWall','underwaterFloor']) {
 const [a,b,c,d]=cornellRegions[key],indices=[];
 for(let y=Math.round(b*544/256);y<Math.round(d*544/256);y++)for(let x=Math.round(480+(a-128)*544/256);x<Math.round(480+(c-128)*544/256);x++)indices.push(y*960+x);
 masks[key]=indices;
}
const meta=JSON.parse(readFileSync(stem+'.json')),rows=[];
if((meta.sequenceSeed??0)!==sequenceSeed)throw Error('Capture did not use the requested sequence seed');
for(const [region,indices]of Object.entries(masks)) {
 const blotch=denoisedBlotchStatistics(display,oidn,target,indices,1.5),rho=blotch.before.autocorrelation[1].value;
 // Discard the largest 0.1% squared luminance errors, then normalize by the
 // independently trimmed reference mean. Report RMSE, not signed regional bias.
 const luminance=(im,i)=>(im.data[4*i]+im.data[4*i+1]+im.data[4*i+2])/3;
 const squared=indices.map(i=>(luminance(oidn,i)-luminance(reference,i))**2);
 const rmse=Math.sqrt(statistics(squared).trimmedMean)/statistics(indices.map(i=>luminance(reference,i))).trimmedMean;
 rows.push({region,pixels:indices.length,rhoRaw:rho,rawB:blotch.before.cloudBandRelativeRMS*Math.sqrt(Math.max(0,rho)),oidnB:blotch.correlatedCloudRelativeRMS,oidnD:blotch.after.cloudBandRelativeRMS,oidnRMSE:rmse});
}
const result={name:name==='baseline'?name+'-'+mode:name,groups,pattern,radius,divisor,seed,sequenceSeed,samples,traceMsPerBatch:meta.traceMs/samples,totalMs:meta.totalMs,rows};
const allPath=resolve(E,'screening.json'),all=existsSync(allPath)?JSON.parse(readFileSync(allPath)):[];
const base=all.find(r=>r.name==='baseline-photon');
for(const row of rows) {
 const b=base?.rows.find(r=>r.region===row.region);
 row.verdict=name==='baseline'?'对照':!b?'不确定':
  row.oidnRMSE>b.oidnRMSE*1.10||row.rhoRaw>b.rhoRaw*.85?'方向不对':
  row.oidnB<=b.oidnB*.5&&row.oidnRMSE<=b.oidnRMSE*1.03&&row.oidnD<=b.oidnD*.8&&result.traceMsPerBatch<=base.traceMsPerBatch*1.3?'有希望':'不确定';
}
writeFileSync(resolve(directory,`screening-${mode}-${samples}.json`),JSON.stringify(result,null,2));
const filtered=all.filter(r=>r.name!==result.name);filtered.push(result);writeFileSync(allPath,JSON.stringify(filtered,null,2));
console.log([name,(meta.traceMs/samples).toFixed(2),...rows.map(r=>`${r.region}: rho=${r.rhoRaw.toFixed(3)} Braw=${(100*r.rawB).toFixed(3)}% Boidn=${(100*r.oidnB).toFixed(3)}% RMSE=${(100*r.oidnRMSE).toFixed(2)}% ${r.verdict}`)].join(' | '));
// Save display-space float images for a consistent side-by-side figure.
writeFileSync(resolve(directory,mode+'-display.f32'),Buffer.from(display.data.buffer));
const figure=spawnSync('python3',['scripts/caustics-noise-shape-figure.py',E,name,mode,String(samples)],{encoding:'utf8'});
if(figure.status!==0)throw Error(figure.stderr);
// Keep the local ignored plan snapshot useful during a multi-candidate screen.
const progressPath=resolve('plans/caustics-noise-shape-progress.md');
if(existsSync(progressPath)) {
 const text=readFileSync(progressPath,'utf8'),start=text.indexOf('## 筛选表'),end=text.indexOf('\n## 剩余顺序',start);
 if(start>=0&&end>start) {
  const header='## 筛选表\n\n区域顺序：后墙左上、整面后墙、天花板、水下后墙、水下地面。每组为 ρ / Braw% / Boidn% / RMSE%；详细 D 和图见证据。\n\n|方案|K / 半径 / 密度除数|五区域指标|ms/批|五区域初判|\n|---|---|---|---|---|\n';
  const table=filtered.map(x=>'|'+[x.name,`${x.groups} / ${x.radius} / ${x.divisor}`,x.rows.map(r=>[r.rhoRaw.toFixed(3),(100*r.rawB).toFixed(3),(100*r.oidnB).toFixed(3),(100*r.oidnRMSE).toFixed(2)].join('/')).join('<br>'),x.traceMsPerBatch.toFixed(2),x.rows.map(r=>r.verdict??'待重算').join(' / ')].join('|')+'|').join('\n');
  writeFileSync(progressPath,text.slice(0,start)+header+table+'\n'+text.slice(end));
 }
}
