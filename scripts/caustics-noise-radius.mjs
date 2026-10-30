// Historical stage 2A screen: new captures of removed variants require
// MUTRACER_EXPERIMENT_ROOT pointing to the archived experiment checkout.
// node scripts/caustics-noise-radius.mjs k4-r3 --groups 4 --radius 3
// Re-evaluate a cache with --input /absolute/capture-stem (without extension).
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadHdr} from './caustics-compare.mjs';
import {noiseMetrics} from './caustics-noise-metrics.mjs';
const args=process.argv.slice(2),name=args.shift();
if(!name||!/^[\w-]+$/.test(name))throw Error('Expected candidate name');
const option=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
const parent=resolve(process.env.MUTRACER_NOISE_EVIDENCE??'/Users/lang/.codex/experiments/mutracer-caustics-noise-shape-20261030');
const E=resolve(parent,'phase2a'),directory=resolve(E,name),mode=option('mode','photon');
const groups=Number(option('groups',4)),radius=Number(option('radius',2)),divisor=Number(option('divisor',4));
const samples=Number(option('samples',64)),sequenceSeed=Number(option('sequence-seed',0));
if(![0,4,8].includes(groups)||!(radius>0)||!(divisor>0)||!Number.isInteger(samples)||samples<1||!Number.isInteger(sequenceSeed)||sequenceSeed<0||sequenceSeed>0xffffffff||!['photon','light-photon'].includes(mode))throw Error('Invalid candidate configuration');
const stem=resolve(option('input',resolve(directory,`cornell-960x544-${mode}-${samples}`)));
const referencePath=resolve(option('reference',resolve(E,'reference/cornell-960x544-light-photon-4096.f32')));
if(referencePath.endsWith('-oidn.f32'))throw Error('Use unfiltered HDR as the reference');
const config={groups,radius,divisor,samples,sequenceSeed,mode,stem,referencePath};
mkdirSync(directory,{recursive:true});
const configPath=resolve(directory,'configuration.json');
if(existsSync(configPath)&&JSON.stringify(JSON.parse(readFileSync(configPath)))!==JSON.stringify(config))throw Error('Cached settings differ; choose a new name');
if(!existsSync(stem+'-oidn.f32')) {
 if(args.includes('--input'))throw Error('Missing cached input: '+stem);
 const env={...process.env,MUTRACER_CAUSTICS_OUTPUT:directory,WIDTH:'960',HEIGHT:'544',STUDY_SCENES:'cornell',STUDY_MODES:mode,CHECKPOINTS:String(samples),SEED:'17',SEQUENCE_SEED:String(sequenceSeed),DENOISE:'1',SUBSET_GROUPS:String(groups),SUBSET_PATTERN:'stratified',SCREEN_PIXELS:String(radius),PHOTON_DIVISOR:String(divisor)};
 const run=spawnSync(process.execPath,['scripts/photon-grid-study.mjs'],{env,encoding:'utf8',timeout:240000,maxBuffer:4e6});
 writeFileSync(resolve(E,name+'.log'),(run.stdout??'')+(run.stderr??''));
 if(run.error||run.status!==0)throw run.error??Error('Capture failed: '+run.stderr);
}
const meta=JSON.parse(readFileSync(stem+'.json'));
if((meta.sequenceSeed??0)!==sequenceSeed)throw Error('Wrong capture sequence seed');
const {display,rows}=noiseMetrics(loadHdr(stem+'.f32'),loadHdr(stem+'-oidn.f32'),loadHdr(referencePath));
const result={name,...config,traceMsPerBatch:meta.traceMs/samples,denoiseMs:meta.denoiseMs,rows};
const allPath=resolve(E,'screening.json'),all=existsSync(allPath)?JSON.parse(readFileSync(allPath)):[];
const base=all.find(x=>x.name==='pm-2px'),strat=all.find(x=>x.name==='k4-2px');
for(const row of rows) {
 const b=base?.rows.find(x=>x.region===row.region),s=strat?.rows.find(x=>x.region===row.region);
 const underwater=row.region.startsWith('underwater');
 row.verdict=!b||name==='pm-2px'||name==='lt-pm-2px'?'对照':
  row.oidnRMSE>b.oidnRMSE*1.10||row.oidnD>b.oidnD*1.10?'方向不对':
  row.oidnRMSE<=b.oidnRMSE*.9&&row.oidnD<=b.oidnD*.8&&(!s||underwater||row.oidnRMSE<=s.oidnRMSE*1.05)&&result.traceMsPerBatch<=base.traceMsPerBatch*1.3?'有希望':'不确定';
}
writeFileSync(configPath,JSON.stringify(config,null,2));
writeFileSync(resolve(directory,'screening.json'),JSON.stringify(result,null,2));
const updated=all.filter(x=>x.name!==name);updated.push(result);writeFileSync(allPath,JSON.stringify(updated,null,2));
writeFileSync(resolve(directory,mode+'-display.f32'),Buffer.from(display.data.buffer));
const figure=spawnSync('python3',['scripts/caustics-noise-shape-figure.py',E,name,mode,String(samples),parent,stem],{encoding:'utf8'});
if(figure.status!==0)throw Error(figure.stderr);
const textRow=x=>'|'+[x.name,`${x.groups}/${x.radius}/${x.divisor}`,x.rows.map(r=>[r.rhoRaw.toFixed(3),(100*r.rawB).toFixed(3),(100*r.oidnB).toFixed(3),(100*r.oidnD).toFixed(3),(100*r.oidnRMSE).toFixed(2)].join('/')).join('<br>'),x.traceMsPerBatch.toFixed(2),x.rows.map(r=>r.verdict).join('/')].join('|')+'|';
const progressPath=resolve('plans/caustics-noise-shape-progress.md');
if(existsSync(progressPath)) {
 let text=readFileSync(progressPath,'utf8');const start=text.indexOf('## 2A 筛选表'),end=text.indexOf('\n## 剩余顺序');
 const section='## 2A 筛选表\n\n区域顺序同上；每组为 ρ/Braw%/Boidn%/Doidn%/RMSEoidn%。参考为独立种子同分辨率 LT+PM4096 HDR。\n\n|方案|K/半径/密度除数|五区域指标|ms/批|五区域初判|\n|---|---|---|---|---|\n'+updated.map(textRow).join('\n')+'\n';
 if(end>=0)text=start>=0?text.slice(0,start)+section+text.slice(end):text.slice(0,end)+section+text.slice(end);
 writeFileSync(progressPath,text);
}
console.log([name,result.traceMsPerBatch.toFixed(2)+'ms',...rows.map(r=>`${r.region}: rho=${r.rhoRaw.toFixed(3)} D=${(100*r.oidnD).toFixed(3)}% RMSE=${(100*r.oidnRMSE).toFixed(2)}% HDRraw=${(100*r.hdrRMSE).toFixed(1)}% ${r.verdict}`)].join(' | '));
