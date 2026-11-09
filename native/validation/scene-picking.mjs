// Run after native:ci, with its host-target and evidence directory configured.
import {spawnNative,cCompiler,executable,windows} from '../scripts/platform.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??'.native-build/picking');mkdirSync(out,{recursive:true});
const library=resolve(process.env.CARGO_TARGET_DIR??'.native-build/host-target','release');
const binary=resolve(out,executable('scene-picking'));
const env={...process.env};
if(windows) {const key=Object.keys(env).find(k=>k.toLowerCase()==='path')??'PATH';env[key]=library+delimiter+(env[key]??'');}
function run(name,command,args) {
  const r=spawnNative(command,args,{cwd:root,encoding:'utf8',env,timeout:900000,maxBuffer:8*1024*1024});
  writeFileSync(resolve(out,name+'.log'),(r.stdout??'')+(r.stderr??''));
  if(r.error||r.status!==0)throw Error(`${name} failed: ${r.error??r.status}; see ${out}/${name}.log`);
  return r.stdout;
}
run('build',cCompiler,['-std=c11','-Wall','-Wextra','-Werror','-I','native/include','native/examples/scene-picking.c','-L',library,'-lmutracer','-Wl,-rpath,'+library,'-lm','-o',binary]);
const output=run('consumer',binary,process.argv.slice(2));
if(!output.includes('PASS scene picking'))throw Error('Missing C consumer result');
writeFileSync(resolve(out,'summary.json'),JSON.stringify({validated:true,importedFixture:process.argv[2]??null},null,2)+'\n');
console.log(output.trim());
