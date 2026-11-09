import {spawnNative as spawnSync, cCompiler, hostLibraryEnv, executable} from '../scripts/platform.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/engine'));
const target=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'cargo-target')),settings=resolve(out,'settings');
const context=resolve(settings,'camera/jobs/context');
mkdirSync(out,{recursive:true});
// The settings chain builds the library and the scene fixtures; reused fixtures fix the sample count.
const samples=process.env.MUTRACER_NATIVE_SCENE_OUTPUT?process.env.MUTRACER_NATIVE_SAMPLES??'8':'64';
const env={...hostLibraryEnv(target),CARGO_TARGET_DIR:target,MUTRACER_NATIVE_OUTPUT:settings,MUTRACER_NATIVE_SAMPLES:samples};
function run(name,cmd,args){const p=spawnSync(cmd,args,{cwd:root,env,encoding:'utf8',timeout:900000,maxBuffer:32*1024*1024});
 writeFileSync(resolve(out,name+'.log'),(p.stdout??'')+(p.stderr??''));if(p.error||p.status!==0)throw Error(name+': '+(p.error?.message??p.stderr));return p.stdout;}
run('settings',process.execPath,['native/validation/settings-render.mjs']);
const host=resolve(out,executable('engine-host'));
run('build',cCompiler,['-Wall','-Wextra','-Werror','-I','native/include','native/examples/engine-host.c','-L',resolve(target,'release'),'-lmutracer','-Wl,-rpath,'+resolve(target,'release'),'-pthread','-o',host]);
const results=[];
// Software must match fresh contexts byte for byte; HWRT differences are recorded (known Metal limitation).
for(const fixture of ['baseline','v2-alpha','v3-ies','v3-displacement-uv'])for(const backend of [0,1]){
 const destination=resolve(out,fixture+'-'+backend);mkdirSync(destination,{recursive:true});
 const input=resolve(context,'raw',fixture==='baseline'?'image':fixture,'scene-input.bin');
 const text=run(fixture+'-'+backend,host,[input,destination,samples,String(backend)]),match=/PASS (\d+) engine checks/.exec(text);
 if(!match)throw Error('Missing engine result');
 results.push({fixture,backend,checks:Number(match[1]),hardwareDifferences:(text.match(/HWRT-DIFFERENCE/g)??[]).length});
 writeFileSync(resolve(out,'engine-verification.json'),JSON.stringify({complete:false,results},null,2));
}
writeFileSync(resolve(out,'engine-verification.json'),JSON.stringify({complete:true,results},null,2));
console.log(`Native engine API: 8 fixture/backend combinations passed (${results.reduce((n,r)=>n+r.hardwareDifferences,0)} HWRT differences)`);
