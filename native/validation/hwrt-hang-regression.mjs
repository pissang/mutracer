// External-asset Metal HWRT regression. Run GPU cases in separate, serial processes.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const required=name=>{assert(process.env[name],`Set ${name}`);return resolve(process.env[name]);};
const selected=process.argv[2];
assert(!selected||['chess','sanmiguel'].includes(selected),'Optional scene must be chess or sanmiguel');
const out=required('MUTRACER_HWRT_OUTPUT');
const chess=required('MUTRACER_HWRT_CHESS');
const san=required('MUTRACER_HWRT_SANMIGUEL');
const model=required('MUTRACER_HWRT_MODEL');
mkdirSync(out,{recursive:true});
const build=spawnSync('cargo',['test','--locked','--manifest-path','native/webview-viewer/Cargo.toml','--no-run','--message-format=json'],{encoding:'utf8',maxBuffer:32*1024*1024});
writeFileSync(join(out,'build.log'),build.stdout+build.stderr);
assert.equal(build.status,0,'Regression harness build failed');
const binary=build.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.reason==='compiler-artifact'&&row.profile.test&&row.executable)?.executable;
assert(binary,'Missing test binary');
const cases=[
 {name:'chess',runs:3,env:{MUTRACER_HWRT_SCENE:chess,WIDTH:'96',HEIGHT:'64',SPP:'4096',BOUNCES:'3',CANDIDATES:'4',BEVEL:'1',WAVELENGTHS:'3'}},
 {name:'sanmiguel',runs:5,env:{MUTRACER_HWRT_SCENE:join(san,'native-ui.bin'),MUTRACER_HWRT_REFS:join(san,'refs.json'),MUTRACER_HWRT_MODEL:model,WIDTH:'724',HEIGHT:'744',SPP:'256',BOUNCES:'6',CANDIDATES:'2',BEVEL:'0',WAVELENGTHS:'1'}}
];
const summary={commit:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),passed:true,runs:[],comparisons:[]};
const save=()=>writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
function run(c,backend,index){
 mkdirSync(join(out,c.name),{recursive:true});
 const directory=join(out,c.name,`${backend}-${index}`);mkdirSync(directory);
 // Logging is optional; the SDK checks native execution errors even when it is off.
 const env={...process.env,...c.env,BACKEND:backend,BATCH:'8',MUTRACER_HWRT_OUTPUT:directory};
 if(c.name==='chess'){delete env.MUTRACER_HWRT_MODEL;delete env.MUTRACER_HWRT_REFS;}
 writeFileSync(join(directory,'config.json'),JSON.stringify(c.env,null,2));
 const fd=openSync(join(directory,'run.log'),'w');
 let result;
 try{result=spawnSync(binary,['hwrt_regression::hwrt_hang_replay','--ignored','--nocapture'],{env,stdio:['ignore',fd,fd],timeout:900000});}finally{closeSync(fd);}
 let report;
 try{report=JSON.parse(readFileSync(join(directory,'result.json'),'utf8'));}catch{}
 const recoveries=readFileSync(join(directory,'run.log'),'utf8').split('\n')
  .flatMap(line=>{const match=line.match(/\{"nativeFlightRecovery":\{.*\}\}/);return match?[JSON.parse(match[0]).nativeFlightRecovery]:[];});
 const completed=result.status===0&&report?.samples===Number(c.env.SPP)&&report?.error==null;
 const row={scene:c.name,backend,index,completed,recoveryCount:recoveries.filter(r=>r.recovered).length,recoveries,exitCode:result.status,error:result.error?.message,report};
 summary.runs.push(row);if(!completed)summary.passed=false;save();console.log(JSON.stringify(row));
 return completed?directory:undefined;
}
function compare(a,b,c){
 const x=readFileSync(join(a,'hdr.f32')),y=readFileSync(join(b,'hdr.f32'));assert.equal(x.length,y.length);
 let absolute=0,energy=0,square=0,count=0;
 for(let at=0;at<x.length;at+=4){if(at%16===12)continue;const p=x.readFloatLE(at),q=y.readFloatLE(at),d=p-q;absolute+=Math.abs(d);energy+=Math.abs(q);square+=d*d;count++;}
 const row={scene:c.name,hardware:a,software:b,relativeL1:absolute/Math.max(energy,1e-20),rmse:Math.sqrt(square/count)};
 row.passed=Number.isFinite(row.relativeL1)&&row.relativeL1<0.1;
 summary.comparisons.push(row);if(!row.passed)summary.passed=false;save();
}
for(const c of cases.filter(c=>!selected||c.name===selected)){
 const hardware=[];
 for(let index=1;index<=c.runs;index++)hardware.push(run(c,'Hardware',index));
 const software=run(c,'Software',1);
 if(software)for(const image of hardware.filter(Boolean))compare(image,software,c);
}
save();if(!summary.passed)process.exitCode=1;
