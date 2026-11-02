// Headless real-GPU measurements; outputs belong outside the repository.
import{spawn}from'node:child_process';import{mkdirSync,writeFileSync,readFileSync,readdirSync}from'node:fs';import{resolve}from'node:path';
const out=resolve(process.env.MUTRACER_CAUSTICS_OUTPUT??'/Users/lang/.codex/experiments/mutracer-caustics-full-20261029/G');mkdirSync(out,{recursive:true});
async function run(name,script,args=[],extra={}){
 const directory=resolve(out,name);mkdirSync(directory,{recursive:true});console.log(name);
 const output=await new Promise((done,reject)=>{const child=spawn(process.execPath,[script,...args],{cwd:process.cwd(),env:{...process.env,WIDTH:'192',HEIGHT:'144',SPP:'128',CAUSTIC_BENCHMARK:'1',MUTRACER_CAUSTICS_OUTPUT:directory,...extra}});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);child.on('error',reject);child.on('close',code=>{writeFileSync(resolve(directory,'command.txt'),log);code===0?done(log):reject(Error(name+' failed; see '+directory));});});return output;
}
const requested=process.argv.includes('--cases')?process.argv[process.argv.indexOf('--cases')+1].split(','):['ordinary','sphere','cornell','casters','rays'];
for(const name of requested){
 if(name==='ordinary'||name==='sphere'){
  await run(name,'scripts/caustics-capture.mjs',['--matrix','--photon-map','--full-matrix',...(name==='sphere'?['--sphere','--area-light']:[])],{CAUSTIC_VARIANT:name==='ordinary'?'ordinary':''});
  await run(name+'-sms','scripts/caustics-capture.mjs',name==='sphere'?['--sphere','--area-light']:[],{CAUSTIC_VARIANT:name==='ordinary'?'ordinary':'',CAUSTIC_MODES:'mnee',MNEE_METHOD:'sms'});
 }else if(name==='cornell'){
  for(const method of (process.env.CORNELL_METHODS??'mnee,sms,light,both,photon,mnee-photon,light-photon,all').split(','))await run('cornell-'+method,'scripts/caustics-cornell.mjs',[],{WIDTH:'192',HEIGHT:'192',SPP:method==='sms'?'16':'128',CAUSTIC_ESTIMATOR:method});
 }else if(name==='casters'){
  for(const distribution of ['union','individual'])await run('casters-'+distribution,'scripts/caustics-capture.mjs',['--matrix','--photon-map'],{CAUSTIC_BENCHMARK:'',SPP:'32',CAUSTIC_MODES:'photon',PHOTONS_PER_SAMPLE:'65536',CAUSTIC_VARIANT:'multiple',CASTER_DISTRIBUTION:distribution});
 }else if(name==='rays'){
  await run('rays-sphere','scripts/caustics-capture.mjs',['--sphere','--area-light'],{CAUSTIC_BENCHMARK:'',SPP:'32',CAUSTIC_MODES:'mnee',MNEE_DEBUG_GROUP:'4'});
  await run('rays-cornell','scripts/caustics-cornell.mjs',[],{CAUSTIC_BENCHMARK:'',SPP:'32',WIDTH:'192',HEIGHT:'192',MNEE_DEBUG_GROUP:'4'});
 }else throw Error('Unknown benchmark case: '+name);
}
const median=a=>{a.sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:undefined;};
const rows=[];for(const directory of readdirSync(out,{withFileTypes:true}).filter(e=>e.isDirectory()))for(const file of readdirSync(resolve(out,directory.name)).filter(f=>f.endsWith('.json'))){const p=resolve(out,directory.name,file),d=JSON.parse(readFileSync(p,'utf8'));if(d.benchmark){const times=d.benchmark.timings;rows.push({case:directory.name,image:file,wallMsPerSample:d.benchmark.wallMs/d.benchmark.samples,measurements:times.length,fullFrameMs:median(times.map(t=>t.estimatedFullFrameTimeMs)),lightMs:median(times.map(t=>t.causticTimeMs??0)),photonMs:median(times.map(t=>t.photonMappingTimeMs??0))});}else if(d.photonEfficiency)rows.push({case:directory.name,...d.photonEfficiency});else if(directory.name.startsWith('rays-')&&file.includes('-on')||directory.name.startsWith('rays-')&&file==='webgpu-mnee-sphere.json'){const bytes=readFileSync(p.replace(/\.json$/,'.f32'));const f=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);let nearest=0,shadow=0;for(let i=0;i<f.length;i+=4){nearest+=f[i];shadow+=f[i+1];}rows.push({case:directory.name,nearestQueriesPerSample:nearest,shadowQueriesPerSample:shadow});}}
writeFileSync(resolve(out,'summary.json'),JSON.stringify({note:'GPU timestamp resolution and sub-millisecond timings are noisy; frame budgets include both photon passes. Queries count logical MNEE traversal calls.',rows},null,2));console.log('Saved '+resolve(out,'summary.json'));
