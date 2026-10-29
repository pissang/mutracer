// Compare disabled caustics against an independently checked-out reference.
import {createServer} from 'vite';
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {launchChrome,delay} from './reference-runtime.mjs';
const root=resolve('.'),reference=resolve(process.argv[2]),out=resolve(process.env.MUTRACER_CAUSTICS_OUTPUT??'.cache/caustics-disabled');mkdirSync(out,{recursive:true});
const samples=Number(process.env.SPP??32),results=[],sha=b=>createHash('sha256').update(b).digest('hex');
const fixture=readFileSync(resolve(root,'tests/gpu/caustics.ts')),html=readFileSync(resolve(root,'tests/gpu/caustics.html'));
async function capture(source,label){
 const paths=['tests/gpu/caustics.ts','tests/gpu/caustics.html','src/renderer/causticDiagnostics.ts'].map(p=>resolve(source,p));
 const contents=[fixture,html,readFileSync(resolve(root,'src/renderer/causticDiagnostics.ts'))];
 const originals=paths.map(p=>existsSync(p)?readFileSync(p):null);
 paths.forEach((p,i)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,contents[i]);});
 const server=await createServer({root:source,configFile:false,optimizeDeps:{entries:[],noDiscovery:true},server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/.native-build/**']}}});await server.listen();const chrome=await launchChrome();
 try{for(const backend of ['webgpu','webgl']){
  const page=await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/caustics.html${backend==='webgl'?'?webgl':''}`);
  try{for(let i=0;i<200;i++){if(await page.tab.evaluate('!!window.causticsTests'))break;await delay(100);}
   await page.tab.evaluate(`(()=>{window.disabledSources=[];
    if(window.GPUDevice){const original=GPUDevice.prototype.createShaderModule;GPUDevice.prototype.createShaderModule=function(descriptor){window.disabledSources.push(String(descriptor.code));return original.call(this,descriptor);};}
    const original=WebGL2RenderingContext.prototype.shaderSource;WebGL2RenderingContext.prototype.shaderSource=function(shader,source){window.disabledSources.push(source);return original.call(this,shader,source);};})()`);
   for(const [scene,args]of [['ordinary',`{},${samples},false,false,true`],['glass',`{},${samples},true,false,false`]]){
    const r=await page.tab.evaluate(`window.causticsTests.capture(${args})`),bytes=Buffer.from(new Float32Array(r.hdr).buffer);
    writeFileSync(resolve(out,`${label}-${backend}-${scene}.f32`),bytes);
   }
   const sources=await page.tab.evaluate('window.disabledSources');
   writeFileSync(resolve(out,`${label}-${backend}-sources.json`),JSON.stringify(sources));
  }finally{await page.close();}
 }}finally{await chrome.close();await server.close();paths.forEach((p,i)=>originals[i]?writeFileSync(p,originals[i]):unlinkSync(p));}
 // Cornell uses exactly the authored glTF camera and records HDR through Render.
 for(const backend of ['webgpu','webgl']){
  const directory=resolve(out,label);mkdirSync(directory,{recursive:true});
  const r=spawnSync(process.execPath,['scripts/caustics-cornell.mjs','--off-only',...(backend==='webgl'?['--webgl']:[])],{cwd:root,encoding:'utf8',env:{...process.env,MUTRACER_SOURCE_ROOT:source,MUTRACER_CAUSTICS_OUTPUT:directory,SPP:String(samples),WIDTH:'128',HEIGHT:'128'}});
  writeFileSync(resolve(out,`${label}-${backend}-cornell.log`),(r.stdout??'')+(r.stderr??''));if(r.status!==0)throw Error('Cornell capture failed');
  writeFileSync(resolve(out,`${label}-${backend}-cornell.f32`),readFileSync(resolve(directory,`cornell-${backend}-mnee-off.f32`)));
 }
}
await capture(reference,'reference');await capture(root,'current');
for(const backend of ['webgpu','webgl'])for(const scene of ['ordinary','glass','cornell']){
 const a=readFileSync(resolve(out,`reference-${backend}-${scene}.f32`)),b=readFileSync(resolve(out,`current-${backend}-${scene}.f32`));let maximum=0;
 for(let i=0;i<Math.min(a.length,b.length);i+=4)maximum=Math.max(maximum,Math.abs(a.readFloatLE(i)-b.readFloatLE(i)));
 results.push({backend,scene,identical:a.equals(b),referenceSha256:sha(a),currentSha256:sha(b),maximum});
}
for(const backend of ['webgpu','webgl']){
 const a=readFileSync(resolve(out,`reference-${backend}-sources.json`)),b=readFileSync(resolve(out,`current-${backend}-sources.json`));
 results.push({backend,scene:'shader-sources',identical:a.equals(b),referenceSha256:sha(a),currentSha256:sha(b)});
}
writeFileSync(resolve(out,'comparison.json'),JSON.stringify({reference,root,samples,results},null,2));console.log(results);if(results.some(r=>!r.identical))process.exitCode=1;
