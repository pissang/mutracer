import {spawnNative as spawnSync, cCompiler, executable as nativeExecutable, hostLibraryEnv} from '../scripts/platform.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??'.native-build/scene-api');mkdirSync(out,{recursive:true});
const target=resolve(process.env.CARGO_TARGET_DIR??'.native-build/host-target');const executable=resolve(out,nativeExecutable('scene-api-host'));
const env=hostLibraryEnv(target);
function run(name,command,args){const r=spawnSync(command,args,{cwd:root,encoding:'utf8',env,timeout:900000,maxBuffer:32*1024*1024});writeFileSync(resolve(out,name+'.log'),(r.stdout??'')+(r.stderr??''));if(r.error||r.status!==0)throw Error(`${name} failed; see ${out}/${name}.log`);return r.stdout;}
run('build',cCompiler,['-std=c11','-Wall','-Wextra','-Werror','-I','native/include','native/examples/scene-api-host.c','-L',resolve(target,'release'),'-lmutracer','-Wl,-rpath,'+resolve(target,'release'),'-o',executable]);
const results=[];for(const backend of process.argv.includes('--software-only')?[0]:[0,1]){const text=run('backend-'+backend,executable,[String(backend),resolve(root,'native/validation/assets/sample.glb'),...(process.env.MUTRACER_TEST_ADAPTER?[process.env.MUTRACER_TEST_ADAPTER]:[])]);if(!text.includes('PASS scene API'))throw Error('Missing scene API host result');results.push({backend,adapter:process.env.MUTRACER_TEST_ADAPTER??'default',passed:true});}
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,results},null,2)+'\n');console.log('Scene API C host: descriptor, HDR and ABI 8 AOV snapshots on both backends');
