import {spawnNative as spawnSync, cCompiler, hostLibraryEnv, archiveName, executable} from '../scripts/platform.mjs';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/job-core'));
const raw=resolve(out,'context'),target=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'cargo-target'));
const samples=Number(process.env.MUTRACER_NATIVE_SAMPLES??256);
if(!Number.isInteger(samples)||samples<8||samples>4096)throw new Error('Job validation samples must be 8..4096');
mkdirSync(out,{recursive:true});
const env={...hostLibraryEnv(target),CARGO_TARGET_DIR:target,MUTRACER_NATIVE_OUTPUT:raw,MUTRACER_NATIVE_SAMPLES:String(samples),MUTRACER_AOT_ARCHIVE:resolve(raw,'raw',archiveName('render-core'))};
const checks=[];
function run(name,command,args){
 console.log(`${name}...`);
 const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024});
 writeFileSync(resolve(out,`${name}.log`),(result.stdout??'')+(result.stderr??''));
 checks.push({name,exitCode:result.status});writeFileSync(resolve(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');
 if(result.error||result.status!==0)throw new Error(`${name}: ${result.error?.message??result.stderr??result.stdout}`);
 return result;
}
// Revalidate blocking contexts and raw scenes before exercising asynchronous jobs.
run('context-validation',process.execPath,['native/validation/context-render.mjs']);
// native:ci:hosts already ran the host tests.
if(!process.env.MUTRACER_NATIVE_SCENE_OUTPUT)run('rust-tests','cargo',['test','--locked','--manifest-path','native/host/Cargo.toml']);
const host=resolve(out,executable('job-host'));
run('job-host-build',cCompiler,['-Wall','-Wextra','-Werror','-I','native/include','native/examples/job-host.c','-L',resolve(target,'release'),'-lmutracer',`-Wl,-rpath,${resolve(target,'release')}`,'-pthread','-o',host]);
const fixtures=JSON.parse(readFileSync(resolve(raw,'raw/scene-verification.json'))).results;
const results=[];
for(const {variant} of fixtures){
 const source=resolve(raw,variant),destination=resolve(out,variant);
 mkdirSync(destination,{recursive:true});
 const result=run(`job-${variant}`,host,[resolve(raw,'raw',variant==='baseline'?'image':variant,'scene-input.bin'),source,destination,String(samples)]);
 const match=/PASS (\d+) job checks/.exec(result.stdout);if(!match)throw new Error(`Missing job checks for ${variant}`);
 for(const name of ['render','normal','albedo'])
  if(!readFileSync(resolve(source,`${name}.rgba32f`)).equals(readFileSync(resolve(destination,`${name}.rgba32f`))))throw new Error(`Job image differs: ${variant}/${name}`);
 // Job HDR bytes already matched; the same pixels have the same native preview.
 copyFileSync(resolve(source,'render.png'),resolve(destination,'render.png'));
 results.push({variant,checks:Number(match[1]),samples,allOutputsByteIdentical:true});
 writeFileSync(resolve(out,'job-verification.json'),JSON.stringify({complete:false,results},null,2)+'\n');
}
writeFileSync(resolve(out,'job-verification.json'),JSON.stringify({complete:true,results},null,2)+'\n');
console.log(`Native GPU jobs: ${results.length} scenes; ${results.reduce((sum,r)=>sum+r.checks,0)} C checks passed`);
