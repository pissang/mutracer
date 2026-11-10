// Archive the app, then run its native executable after extraction outside the checkout.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {delimiter,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {executable,nativeTar,viewerPlatform} from './platform.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/viewer'));
const dist=resolve(process.env.MUTRACER_NATIVE_DIST??resolve(out,'dist'));
const platform=viewerPlatform(),mac=platform==='macos-arm64';
const gpuValidation=process.argv.includes('--gpu')||process.env.MUTRACER_NATIVE_GUI_SMOKE==='1';
const appName=mac?'MuTracer.app':'MuTracer',app=resolve(out,appName);
function run(command,args,options={}) {
  const result=spawnSync(command,args,{stdio:'inherit',...options});
  if(result.error||result.status!==0)throw result.error??new Error(`${command} failed: ${result.status}`);
  return result;
}
if(mac) {
  run('codesign',['--verify','--deep','--strict',app]);
  const arch=run('lipo',['-archs',resolve(app,'Contents/MacOS/mutracer-viewer')],{encoding:'utf8',stdio:'pipe'});
  if(arch.stdout.trim()!=='arm64')throw new Error('Expected a macOS arm64 app');
}
mkdirSync(dist,{recursive:true});
const name=`MuTracer-${platform}.${platform==='linux-x64'?'tar.gz':'zip'}`,archive=resolve(dist,name);
if(mac)run('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,archive]);
else run(nativeTar,[platform==='windows-x64'?'-acf':'-czf',archive,'-C',out,appName]);
writeFileSync(archive+'.sha256',`${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${name}\n`);
const relocated=mkdtempSync(resolve(out,'relocated-'));
if(mac)run('ditto',['-x','-k',archive,relocated]);
else run(nativeTar,['-xf',archive,'-C',relocated]);
const binary=resolve(relocated,appName,mac?'Contents/MacOS/mutracer-viewer':executable('mutracer-viewer'));
if(process.platform==='win32') {
  const imports={};
  for(const name of readdirSync(dirname(binary)).filter(name=>/\.(?:dll|exe)$/i.test(name))) {
    const dump=run('dumpbin.exe',['/nologo','/dependents',resolve(dirname(binary),name)],{encoding:'utf8',stdio:'pipe'});
    const dependencies=[...dump.stdout.matchAll(/^\s+([\w.+-]+\.dll)\s*$/gim)].map(match=>match[1]);
    if(dependencies.some(name=>/libgcc|libstdc\+\+|winpthread|msys-/i.test(name)))throw Error('Packaged executable depends on a GNU CRT');
    for(const dependency of dependencies.filter(name=>/^(?:vcruntime|msvcp|concrt)140/i.test(name)))
      if(!existsSync(resolve(dirname(binary),dependency)))throw Error(`Missing app-local MSVC runtime: ${dependency}`);
    imports[name]=dependencies;
  }
  writeFileSync(resolve(out,'package-dependencies.json'),JSON.stringify(imports,null,2)+'\n');
}
const env={...process.env};delete env.MUTRACER_OIDN_LIBRARY;
env.MUTRACER_NATIVE_GPU_VALIDATION=gpuValidation?'1':'0';
for(const key of ['LD_LIBRARY_PATH','DYLD_LIBRARY_PATH','DYLD_FALLBACK_LIBRARY_PATH'])delete env[key];
if(process.platform==='win32') {
  // Developer PATH entries must not supply missing packaged DLLs.
  for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
  env.PATH=[dirname(binary),resolve(process.env.SystemRoot,'System32'),process.env.SystemRoot].join(delimiter);
}
if(process.platform==='linux'&&!env.XDG_RUNTIME_DIR) {
  env.XDG_RUNTIME_DIR=resolve(relocated,'runtime');mkdirSync(env.XDG_RUNTIME_DIR,{mode:0o700});
}
const smoke=spawnSync(binary,['--package-smoke',resolve(out,'package-smoke')],{
  cwd:relocated,env,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
writeFileSync(resolve(out,'package-smoke.log'),(smoke.stdout??'')+(smoke.stderr??''));
if(smoke.error||smoke.status!==0)throw smoke.error??new Error(`Relocated package smoke failed; see ${out}/package-smoke.log`);
const summary=JSON.parse(readFileSync(resolve(out,'package-smoke/summary.json'),'utf8'));
if(!summary.passed||summary.denoiser!=='oidn-webgpu')throw new Error('Incomplete relocated package smoke');
if(gpuValidation) {
  if(!summary.gpu||summary.gpuValidation!=='passed'||summary.denoisingValidation!=='passed')throw new Error('Packaged GPU rendering was not validated');
  const args=[binary,'--evidence',resolve(out,'startup-window')];
  const command=process.platform==='linux'?'xvfb-run':args.shift();
  if(process.platform==='linux')args.unshift('-a');
  const window=spawnSync(command,args,{cwd:relocated,env,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  writeFileSync(resolve(out,'startup-smoke.log'),(window.stdout??'')+(window.stderr??''));
  if(window.error||window.status!==0)throw window.error??new Error(`Window startup failed; see ${out}/startup-smoke.log`);
}
console.log(`Native package: ${archive}\n${JSON.stringify(summary)}`);
