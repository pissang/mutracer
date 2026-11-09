import {spawnNative as spawnSync, cCompiler, hostLibraryEnv, executable} from '../scripts/platform.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/settings'));
const target=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'cargo-target')),camera=resolve(out,'camera'),context=resolve(camera,'jobs/context');
mkdirSync(out,{recursive:true});
// Reused scene fixtures fix the sample count the chained hosts compare against.
const samples=process.env.MUTRACER_NATIVE_SCENE_OUTPUT?process.env.MUTRACER_NATIVE_SAMPLES??'8':'64';
const env={...hostLibraryEnv(target),CARGO_TARGET_DIR:target,MUTRACER_NATIVE_OUTPUT:camera,MUTRACER_NATIVE_SAMPLES:samples};
function run(name,cmd,args){const p=spawnSync(cmd,args,{cwd:root,env,encoding:'utf8',timeout:600000,maxBuffer:32*1024*1024});
 writeFileSync(resolve(out,name+'.log'),(p.stdout??'')+(p.stderr??''));if(p.error||p.status!==0)throw Error(name+': '+(p.error?.message??p.stderr));return p.stdout;}
run('camera',process.execPath,['native/validation/camera-render.mjs']);
const host=resolve(out,executable('settings-host'));
run('build',cCompiler,['-Wall','-Wextra','-Werror','-I','native/include','native/examples/settings-host.c','-L',resolve(target,'release'),'-lmutracer','-Wl,-rpath,'+resolve(target,'release'),'-o',host]);
const results=[];
for(const fixture of ['baseline','v2-alpha','v3-ies','v3-displacement-uv'])for(const backend of [0,1]){
 const destination=resolve(out,fixture+'-'+backend);mkdirSync(destination,{recursive:true});
 const input=resolve(context,'raw',fixture==='baseline'?'image':fixture,'scene-input.bin');
 const text=run(fixture+'-'+backend,host,[input,destination,String(backend)]),match=/PASS (\d+) settings checks/.exec(text);
 if(!match)throw Error('Missing settings result');
 results.push({fixture,backend,checks:Number(match[1]),jobAndBlockingByteIdentical:true});
 writeFileSync(resolve(out,'settings-verification.json'),JSON.stringify({complete:false,results},null,2));
}
writeFileSync(resolve(out,'settings-verification.json'),JSON.stringify({complete:true,results},null,2));
console.log('Native render settings: 8 fixture/backend combinations passed');
