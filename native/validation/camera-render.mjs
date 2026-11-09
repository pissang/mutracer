import {spawnNative as spawnSync, cCompiler, hostLibraryEnv, executable} from '../scripts/platform.mjs';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/camera-core'));
const jobs=resolve(out,'jobs'),target=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'cargo-target'));
const samples=Number(process.env.MUTRACER_NATIVE_SAMPLES??256);
if(!Number.isInteger(samples)||samples<8||samples>4096)throw new Error('Camera validation samples must be 8..4096');
mkdirSync(out,{recursive:true});
const env={...hostLibraryEnv(target),CARGO_TARGET_DIR:target,MUTRACER_NATIVE_OUTPUT:jobs,MUTRACER_NATIVE_SAMPLES:String(samples)};
const checks=[];
function run(name,command,args){
 console.log(`${name}...`);
 const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout:600000,maxBuffer:32*1024*1024});
 writeFileSync(resolve(out,`${name}.log`),(result.stdout??'')+(result.stderr??''));
 checks.push({name,exitCode:result.status});writeFileSync(resolve(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');
 if(result.error||result.status!==0)throw new Error(`${name}: ${result.error?.message??result.stderr??result.stdout}`);
 return result;
}
// Revalidate the complete AOT/raw/context/job graph before testing partial uploads.
run('job-validation',process.execPath,['native/validation/job-render.mjs']);
const host=resolve(out,executable('camera-host'));
run('camera-host-build',cCompiler,['-Wall','-Wextra','-Werror','-I','native/include','native/examples/camera-host.c','-L',resolve(target,'release'),'-lmutracer',`-Wl,-rpath,${resolve(target,'release')}`,'-pthread','-o',host]);
const fixtures=JSON.parse(readFileSync(resolve(jobs,'job-verification.json'))).results;
const results=[];
for(const {variant} of fixtures){
 const destination=resolve(out,variant);mkdirSync(destination,{recursive:true});
 const result=run(`camera-${variant}`,host,[resolve(jobs,'context/raw',variant==='baseline'?'image':variant,'scene-input.bin'),destination,String(samples)]);
 const match=/PASS (\d+) camera checks/.exec(result.stdout);if(!match)throw new Error(`Missing camera checks for ${variant}`);
 results.push({variant,checks:Number(match[1]),samples,cameraCases:6,partialAndFullCommitByteIdentical:true,restoredOriginalByteIdentical:true});
 writeFileSync(resolve(out,'camera-verification.json'),JSON.stringify({complete:false,results},null,2)+'\n');
}
writeFileSync(resolve(out,'camera-verification.json'),JSON.stringify({complete:true,results},null,2)+'\n');
console.log(`Native partial camera updates: ${results.length} scenes / ${results.length*6} camera cases passed`);
