// CPU wall-clock measurements on a real GPU; deliberately excluded from CI.
// Build the current SDK first with native:scene:static. Each run is a new process.
import {spawnNative, cCompiler, executable, hostLibraryEnv} from '../scripts/platform.mjs';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2);
if(args.includes('--help')){
  console.log(`Usage: npm run native:edit-cost -- [options]
  --scales S,M,L,LI       Procedural scene presets (default: all four)
  --backends 0,1         Software / HWRT (default: both)
  --meshes N --materials N --lights N --grid N --instances N
                         Override each selected preset; grid is quads per side
  --repeats N            Warm repetitions after the first observation (5..100)
  --width N --height N   Output pixels (default: 1280 x 720)
  --case NAME[,NAME...]  Select edits; initial and variant probes always run
  --output DIRECTORY    JSONL, logs, commands and median/p90 summary
Build the current SDK with native:scene:static first. CARGO_TARGET_DIR selects
its Cargo target; default: .native-build/scene-core/cargo-target.`);
  process.exit(0);
}
const options=new Set(['scales','backends','meshes','materials','lights','grid','instances','repeats','width','height','case','output']);
for(let i=0;i<args.length;i+=2){
  if(!args[i].startsWith('--')||!options.has(args[i].slice(2))||!args[i+1]||args[i+1].startsWith('--'))
    throw Error('Expected a known option and its value; use --help');
}
const value=(key,fallback)=>{const index=args.indexOf('--'+key);return index<0?fallback:args[index+1];};
const out=resolve(value('output',process.env.MUTRACER_NATIVE_OUTPUT??'.native-build/edit-cost'));
const target=resolve(process.env.CARGO_TARGET_DIR??'.native-build/scene-core/cargo-target');
const host=resolve(out,executable('edit-cost-host'));mkdirSync(out,{recursive:true});
const env=hostLibraryEnv(target);
const commandLog=[];
function run(name,command,argv){
  commandLog.push({name,command,args:argv});writeFileSync(resolve(out,'commands.json'),JSON.stringify(commandLog,null,2)+'\n');
  const result=spawnNative(command,argv,{cwd:root,env,encoding:'utf8',timeout:3600000,maxBuffer:64*1024*1024});
  writeFileSync(resolve(out,name+'.stderr.log'),result.stderr??'');
  writeFileSync(resolve(out,name+'.jsonl'),result.stdout??'');
  if(result.error||result.status!==0)throw Error(`${name}: ${result.error??`exit ${result.status}`}; see ${out}/${name}.stderr.log`);
  return result.stdout;
}
run('build',cCompiler,['-std=c11','-Wall','-Wextra','-Werror','-O2','-I','native/include','native/examples/edit-cost-host.c','-L',resolve(target,'release'),'-lmutracer','-Wl,-rpath,'+resolve(target,'release'),'-lm','-o',host]);
const presets={S:[10,10,4,4,16],M:[1000,100,32,4,1000],L:[4096,256,60,12,0],LI:[4096,256,60,12,110000]};
const summaries=[],failures=[];
const percentile=(a,p)=>a.slice().sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];
for(const scale of value('scales','S,M,L,LI').split(','))for(const backend of value('backends','0,1').split(',')){
  try{
    const preset=presets[scale];if(!preset)throw Error('Unknown scale '+scale);
    const dimensions=['meshes','materials','lights','grid','instances'].map((key,i)=>value(key,String(preset[i])));
    const argv=[backend,...dimensions,value('repeats','5'),value('width','1280'),value('height','720'),...(value('case',null)?[value('case',null)]:[])];
    const name=`${scale}-backend-${backend}`;console.log(name+'...');
    const rows=run(name,host,argv).trim().split('\n').map(line=>JSON.parse(line));
    const metadata=rows.shift();
    const cases=[...new Set(rows.map(r=>r.case))].map(name=>{
      const data=rows.filter(r=>r.case===name),warm=data.filter(r=>r.repeat>0);
      const timing=Object.fromEntries(['prediction_ms','set_ms','update_ms','first_sample_ms','ready_ms','preparation_event_ms'].map(key=>[key,warm.length?{median:percentile(warm.map(r=>r[key]),.5),p90:percentile(warm.map(r=>r[key]),.9)}:null]));
      return {case:name,first:data[0],warm_count:warm.length,predicted:[...new Set(data.map(r=>r.predicted))],actual:[...new Set(data.map(r=>r.actual))],doc_mismatch:data.some(r=>r.doc_mismatch),timing,compilation_events:data.flatMap(r=>r.compile_event_ms),cache_hits:data.reduce((s,r)=>s+r.cache_hits,0)};
    });summaries.push({scale,backend:Number(backend),metadata,cases});
  }catch(error){failures.push({scale,backend,error:String(error)});console.error(String(error));}
  writeFileSync(resolve(out,'summary.json'),JSON.stringify({summaries,failures},null,2)+'\n');
}
if(failures.length)process.exitCode=1;
