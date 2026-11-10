// Explicit optional local build. NVIDIA files never enter the default SDK/npm build.
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeToolchainEnv} from './platform.mjs';
if(process.platform!=='win32'||process.arch!=='x64')throw Error('The DLSS viewer currently supports Windows x64 Vulkan.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const required=name=>{if(!process.env[name])throw Error(`Set ${name}. See native/webview-viewer/README.md.`);return resolve(process.env[name]);};
const sdk=required('MUTRACER_DLSS_SDK');
const runtime=required('MUTRACER_DLSS_RUNTIME');
const vulkan=required('MUTRACER_VULKAN_INCLUDE');
const library=process.env.MUTRACER_NGX_LIBRARY?resolve(process.env.MUTRACER_NGX_LIBRARY):resolve(sdk,'lib/Windows_x86_64/x64/nvsdk_ngx_s.lib');
for(const file of [resolve(sdk,'include/nvsdk_ngx_helpers_dlssd_vk.h'),resolve(sdk,'LICENSE.txt'),resolve(runtime,'nvngx_dlssd.dll'),resolve(vulkan,'vulkan/vulkan.h'),library])if(!existsSync(file))throw Error(`Missing DLSS build input: ${file}`);
const sha256=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
// Fixed SDK 310.9.16, NVIDIA/DLSS commit 9981c6350dc58c0ce21f024fd65e31e851c31689.
for(const [file,expected] of [[library,'7b9a5239c1145af5f645ab472aa066f9ea79db36ac819562312aae69d65f3765'],
    [resolve(runtime,'nvngx_dlssd.dll'),'b49435ae346f227feafe7bbe937d88277ea0ee7323975ec06488f377fdb46cee']])
  if(sha256(file)!==expected)throw Error(`Use the supported DLSS 310.9.16 SDK/runtime together: ${file}`);
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/dlss-viewer'));
mkdirSync(out,{recursive:true});
const env={...nativeToolchainEnv(),MUTRACER_NATIVE_OUTPUT:out,MUTRACER_VIEWER_DLSS:'1'};
function run(command,args) {const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit',timeout:30*60*1000});if(result.error||result.status!==0)throw Error(`${command} failed: ${result.error??result.status}`);}
// Separate /MT DLL isolates the SDK loader's CRT from the Rust app's /MD CRT.
const shim=resolve(out,'mutracer_ngx.dll');
run('cl.exe',['/nologo','/std:c++20','/O2','/MT','/EHsc','/LD',`/I${resolve(sdk,'include')}`,`/I${vulkan}`,resolve(root,'native/webview-viewer/src/dlss/ngx.cpp'),library,`/Fo${resolve(out,'ngx.obj')}`,`/Fe${shim}`,'/link','advapi32.lib','user32.lib','shell32.lib','ole32.lib','version.lib','shlwapi.lib']);
run(process.execPath,['native/scripts/viewer-build.mjs','--build-only']);
const app=resolve(out,'MuTracer');
copyFileSync(shim,resolve(app,'mutracer_ngx.dll'));
copyFileSync(resolve(runtime,'nvngx_dlssd.dll'),resolve(app,'nvngx_dlssd.dll'));
const notices=resolve(app,'licenses/NVIDIA-DLSS');mkdirSync(notices,{recursive:true});
copyFileSync(resolve(sdk,'LICENSE.txt'),resolve(notices,'LICENSE.txt'));
writeFileSync(resolve(app,'MuTracer-DLSS.cmd'),'@echo off\r\nset MUTRACER_VIEWER_DLSS=1\r\n"%~dp0mutracer-viewer.exe" %*\r\nif errorlevel 1 pause\r\n');
const binaries=['mutracer-viewer.exe','mutracer_ngx.dll','nvngx_dlssd.dll'];
const sources=['native/host/src/api/temporal.rs','native/webview-viewer/src/main.rs','native/webview-viewer/src/wire.rs',
 'native/webview-viewer/src/dlss/mod.rs','native/webview-viewer/src/dlss/ffi.rs','native/webview-viewer/src/dlss/gpu.rs',
 'native/webview-viewer/src/dlss/ngx.cpp','native/webview-viewer/src/dlss/prepare.wgsl','native/webview-viewer/src/dlss/resolve.wgsl','native/scripts/dlss-build.mjs'];
writeFileSync(resolve(app,'dlss-build.json'),JSON.stringify({sdk:'310.9.16',
  gitRevision:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout?.trim(),
  binaries:Object.fromEntries(binaries.map(file=>[file,sha256(resolve(app,file))])),
  sources:Object.fromEntries(sources.map(file=>[file,sha256(resolve(root,file))]))},null,2)+'\n');
console.log(`DLSS viewer: ${app}`);
