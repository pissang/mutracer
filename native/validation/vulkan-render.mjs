// Run after native:ci with matching CARGO_TARGET_DIR and Vulkan SDK headers.
import {spawnNative,cCompiler,executable,windows} from '../scripts/platform.mjs';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??'.native-build/vulkan');mkdirSync(out,{recursive:true});
const include=process.env.MUTRACER_VULKAN_INCLUDE??(process.env.VULKAN_SDK?resolve(process.env.VULKAN_SDK,'Include'):undefined);
if(!include||!existsSync(resolve(include,'vulkan/vulkan.h')))throw Error('Set VULKAN_SDK or MUTRACER_VULKAN_INCLUDE to the Vulkan SDK headers.');
const library=resolve(process.env.CARGO_TARGET_DIR??'.native-build/host-target','release');
const binary=resolve(out,executable('vulkan-host')),env={...process.env};
if(windows){const key=Object.keys(env).find(k=>k.toLowerCase()==='path')??'PATH';env[key]=library+delimiter+(env[key]??'');}
const checks=[];
function run(name,command,args){
  const result=spawnNative(command,args,{cwd:root,env,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
  writeFileSync(resolve(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
  checks.push({name,command:[command,...args],exitCode:result.status,error:result.error?.message});
  writeFileSync(resolve(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');
  if(result.error||result.status!==0)throw Error(`${name} failed; see ${out}/${name}.log`);
  return result.stdout;
}
run('build',cCompiler,['-std=c11','-Wall','-Wextra','-Werror','-I','native/include','-I',include,'native/examples/vulkan-host.c','-L',library,'-lmutracer','-Wl,-rpath,'+library,...(process.platform==='linux'?['-ldl']:[]),'-o',binary]);
const results=[];
for(const backend of process.argv.includes('--software-only')?[0]:[0,1]){
  const text=run('backend-'+backend,binary,[String(backend)]);
  if(!text.includes(`PASS Vulkan C ABI 8: actual backend ${backend};`))throw Error('Missing actual Vulkan C traversal result');
  results.push({backend,passed:true});
}
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,hardware:!process.argv.includes('--software-only'),include,checks,results},null,2)+'\n');
console.log('Vulkan C host: negotiated device import, copies, leases, postprocessing, AOV exclusion and retirement');
