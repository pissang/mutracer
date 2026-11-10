// Reproducible native CI, with outputs isolated from the Web install/build.
import {buildWebviewUI} from './webview-ui-build.mjs';
import {ciOptions,steps} from './ci-options.mjs';
import {prepareTinyBvh} from '../../scripts/fetch-tinybvh.mjs';
import {finalizeHostLibrary} from './finalize-host-library.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {closeSync,mkdirSync,openSync,readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnCompiler} from './compiler.mjs';
import {classifyHostGpuResult,hwrtLoopIterations} from './host-gpu-results.mjs';
import {gpuValidationCoverage} from './ci-gpu-summary.mjs';
import {archiveName,executable,nativeToolchainEnv,windows} from './platform.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const {only,skip,filter,gpuFilter,batch,subset,enabled}=ciOptions(process.argv.slice(2));
const gpuValidation=process.argv.includes('--gpu')||process.argv.includes('--hosts');
const hostGpuValidation=gpuValidation||gpuFilter!==undefined||batch;
const loopIterations=hostGpuValidation?hwrtLoopIterations(process.env.MT_LOOP_ITERATIONS):undefined;
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??mkdtempSync(resolve(tmpdir(),'mutracer-native-ci-')));
mkdirSync(out,{recursive:true});
const compiler=process.env.MUTRACER_SCRIPTC??spawnSync(process.execPath,['native/toolchain/compiler.mjs'],{cwd:root,encoding:'utf8'}).stdout?.trim();
if(!compiler)throw Error('Install native/toolchain optional dependencies or set MUTRACER_SCRIPTC.');
const hostTarget=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'host-target')),viewerTarget=resolve(out,'viewer-target'),archive=resolve(process.env.MUTRACER_AOT_ARCHIVE??resolve(out,archiveName('render-core')));
const env={...nativeToolchainEnv(),MUTRACER_SCRIPTC:compiler,MUTRACER_AOT_ARCHIVE:archive,CARGO_TARGET_DIR:hostTarget,MUTRACER_NATIVE_OUTPUT:out};
// Scene and viewer builds link the archive built here instead of recompiling it.
const prebuilt={MUTRACER_AOT_PREBUILT:archive};
const checks=[],ciStarted=performance.now();
const seconds=started=>Math.round((performance.now()-started)/100)/10;
function record(name,command,args,exitCode,started,fields={}){
 const check={name,command:[command,...args],exitCode,seconds:seconds(started),...fields};
 checks.push(check);writeFileSync(resolve(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');
 console.log(`${name}: ${exitCode} (${check.seconds} s)`);return check;
}
// scriptc staging is synchronous; these steps run before any concurrent lane.
function runSync(name,command,args){
 if(!enabled(name))return undefined;
 console.log(`${name}...`);const started=performance.now();
 const result=(command===compiler?spawnCompiler:spawnSync)(command,args,{cwd:root,env,encoding:'utf8',maxBuffer:64*1024*1024,timeout:900000});
 writeFileSync(resolve(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
 record(name,command,args,result.status,started);
 if(result.error||result.signal||result.status!==0)throw result.error??Error(`${name} failed; see ${out}/${name}.log`);
 return result;
}
// Output goes straight to the log file, so concurrent steps never block on a pipe.
async function run(name,command,args,extra={},{allowFailure=false,timeout=900000,log=resolve(out,name+'.log'),fields}={}){
 if(!enabled(name.startsWith('host-gpu-')?'host-tests':name))return undefined;
 if(command==='npm'&&process.env.npm_execpath){args=[process.env.npm_execpath,...args];command=process.execPath;}
 console.log(`${name}...`);const started=performance.now(),fd=openSync(log,'w');
 const result=await new Promise(done=>{
  const child=spawn(command,args,{cwd:root,env:{...env,...extra},stdio:['ignore',fd,fd]});
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.on('error',error=>{clearTimeout(timer);done({error});});
  child.on('close',(status,signal)=>{clearTimeout(timer);done({status,signal});});
 });
 closeSync(fd);
 const check=record(name,command,args,result.status,started,fields);
 if(result.error||result.signal||result.status!==0&&!allowFailure)throw result.error??Error(`${name} failed; see ${log}`);
 return {...result,check,output:readFileSync(log,'utf8')};
}
const version=runSync('compiler-version',compiler,['--version']);
if(version&&version.stdout.trim()!=='0.4.4')throw Error('Native CI requires scriptc0.4.4.');
if(windows)runSync('windows-msvc-runtime',process.execPath,['native/validation/windows-msvc-runtime.mjs']);
runSync('aot-build',compiler,['build','--lib','--profile','native/src/render-core-profile.json','-o',archive]);
if(enabled('native-build'))await prepareTinyBvh();
await run('native-build','cargo',['build','--release','--locked','--manifest-path','native/host/Cargo.toml']);
if(enabled('native-build'))finalizeHostLibrary(hostTarget);
if(windows)await run('windows-dll-exit',process.execPath,['native/validation/windows-dll-exit.mjs']);
await run('adapter-info',resolve(hostTarget,'release',executable('gpu-availability')),['--adapter-only']);
let gpu={validated:false,reason:'CPU-only CI; run native:ci:gpu on a real GPU'};
if(hostGpuValidation&&enabled('gpu-availability')){
 const probe=runSync('gpu-availability',resolve(hostTarget,'release',executable('gpu-availability')),['--require-hardware','--require-ray-query']);
 gpu=JSON.parse(probe.stdout);
 if(!gpu.hardware||!gpu.rayQuery)throw Error('Full GPU validation requires a real GPU with ray-query support.');
}
if(!gpuFilter&&!batch)await run('host-tests','cargo',['test','--locked','--manifest-path','native/host/Cargo.toml','--','--test-threads=1'],
 {MUTRACER_TEST_CPU_ONLY:gpuValidation?'0':'1'});
await run('postprocess-shaders',process.execPath,['native/validation/postprocess-shaders.mjs'],
 {MUTRACER_NATIVE_OUTPUT:resolve(out,'postprocess-shaders')});
await run('jnlm-shaders',process.execPath,['native/validation/jnlm-shaders.mjs'],
 {MUTRACER_NATIVE_OUTPUT:resolve(out,'jnlm-shaders')});
await run('scene-picking',process.execPath,['native/validation/scene-picking.mjs'],
 {CARGO_TARGET_DIR:hostTarget,MUTRACER_NATIVE_OUTPUT:resolve(out,'picking')});
// Separate target dirs avoid an unhashed multi-crate-type rlib being reused with
// a different wgpu feature graph by the independent viewer manifest.
if(enabled('viewer-tests'))env.MUTRACER_WEBVIEW_ASSETS=buildWebviewUI(root,resolve(out,'viewer-ui'),env);
await run('viewer-tests','cargo',['test','--locked','--manifest-path','native/webview-viewer/Cargo.toml'],{CARGO_TARGET_DIR:viewerTarget});
// CPU-only work runs beside the GPU steps; no GPU work ever runs concurrently.
const lane=work=>work().then(()=>null,error=>error);
const modulesLane=lane(async()=>{
 await run('build-lib','npm',['run','build:lib']);
 await run('modules-build',process.execPath,['native/validation/module-check.mjs'],{},{allowFailure:true});
 if(enabled('modules-build')){
 const matrix=JSON.parse(readFileSync(resolve(out,'modules/summary.json'),'utf8'));
 const required=matrix.results.filter(r=>r.name!=='materials');
 if(required.length!==15||required.some(r=>r.status!=='archive-built'))throw Error('Required AOT module failed.');
 }
 await run('modules-verify','npm',['run','native:modules:verify']);
 await run('storage-verify','npm',['run','native:storage:verify'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'storage')});
 return 15;
});
// The release viewer has its own target dir, so it never waits on the test builds' lock.
const viewerLane=gpuValidation&&lane(()=>run('viewer-build','npm',['run','native:viewer:build'],
 {MUTRACER_NATIVE_OUTPUT:resolve(out,'viewer'),CARGO_TARGET_DIR:resolve(out,'viewer-release-target'),...prebuilt}));
const joinLane=async pending=>{const error=await pending;if(error)throw error;};
let hostGpuTests;
if(hostGpuValidation&&enabled('host-tests'))hostGpuTests=await runHostGpuTests();
if(gpuValidation){
 if(process.platform==='darwin')await run('metal-gpu-host',process.execPath,['native/validation/metal-render.mjs'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'metal-host'),MTL_DEBUG_LAYER:'1'});
 await run('viewer-gpu-scenes',process.execPath,['native/validation/webview-scene-reference.mjs'],{MUTRACER_WEBVIEW_REFERENCE:resolve(out,'webview-reference')});
 await run('viewer-gpu-scenes','cargo',['test','--locked','--manifest-path','native/webview-viewer/Cargo.toml','shared_web_scenes_render_with_native_engine','--','--ignored','--nocapture'],{CARGO_TARGET_DIR:viewerTarget,MUTRACER_WEBVIEW_REFERENCE:resolve(out,'webview-reference')});
 await run('raw-gpu-fixtures','npm',['run','native:scene'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'fixtures'),MUTRACER_NATIVE_SAMPLES:'8',...prebuilt},{timeout:1800000});
 // Keep the standalone SDK surface/HDR lifecycle probe alongside the WebView app.
 const surfaceArgs=['run','--locked','--manifest-path','native/webview-viewer/Cargo.toml','--example','surface','--',resolve(out,'fixtures/image/scene-input.bin'),resolve(out,'surface/summary.json')];
 const surfaceEnv={CARGO_TARGET_DIR:viewerTarget,MUTRACER_NATIVE_GPU_VALIDATION:'1'};
 if(process.platform==='linux'&&!env.XDG_RUNTIME_DIR){surfaceEnv.XDG_RUNTIME_DIR=resolve(out,'surface/runtime');mkdirSync(surfaceEnv.XDG_RUNTIME_DIR,{recursive:true,mode:0o700});}
 await run('viewer-gpu-surface',process.platform==='linux'?'xvfb-run':'cargo',process.platform==='linux'?['-a','cargo',...surfaceArgs]:surfaceArgs,surfaceEnv);
 if(enabled('viewer-gpu-surface')){
 const surfaceReport=JSON.parse(readFileSync(resolve(out,'surface/summary.json'),'utf8'));
 if(!surfaceReport.passed)throw Error('Window/HDR surface validation failed.');
 gpu.hdrPresentation=surfaceReport.results.map(r=>({backend:r.activeBackend,...r.hdr}));
 }
 if(process.platform==='darwin'&&enabled('c-window')){
  await run('c-window',process.execPath,['native/scripts/window-host.mjs',
   resolve(hostTarget,'release/libmutracer.dylib'),resolve(out,'fixtures/image/scene-input.bin'),resolve(out,'c-window')]);
  gpu.cWindow=JSON.parse(readFileSync(resolve(out,'c-window/summary.json'),'utf8'));
  if(gpu.cWindow.passed!==true)throw Error('C window presentation was not validated.');
 }
 await run('ray-query-contracts',resolve(hostTarget,'release',executable('ray-query-probe')),[resolve(out,'ray-query')]);
 if(enabled('ray-query-contracts')&&!JSON.parse(readFileSync(resolve(out,'ray-query/result.json'),'utf8')).supported)throw Error('HWRT execution was not validated.');
 // --hosts: the context, job, camera, settings and engine C hosts, reusing the fixtures above.
 let cHosts;
 if(process.argv.includes('--hosts')){
  await run('c-hosts','npm',['run','native:engine'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'hosts'),
    MUTRACER_NATIVE_SCENE_OUTPUT:resolve(out,'fixtures'),MUTRACER_NATIVE_SAMPLES:'8'});
  if(enabled('c-hosts'))cHosts=JSON.parse(readFileSync(resolve(out,'hosts/engine-verification.json'),'utf8'));
  await run('scene-api-c-host',process.execPath,['native/validation/scene-api-render.mjs'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'scene-api-host')});
 }
 await joinLane(viewerLane);
 await run('viewer-gpu-package','npm',['run','native:viewer:package','--','--gpu'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'viewer')});
 if(enabled('raw-gpu-fixtures')){
 const oracle=readFileSync(resolve(out,'fixtures/incremental-oracle.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 gpu.oracle={passed:oracle.filter(row=>row.pass===true).length,skipped:oracle.filter(row=>row.skipped===true).length};
 if(gpu.oracle.passed+gpu.oracle.skipped!==oracle.length)throw Error('Incomplete incremental render results.');
 if(hostGpuTests)Object.assign(gpu,gpuValidationCoverage(gpu.oracle,hostGpuTests,cHosts));
 }
 console.log(`GPU validation coverage: ${JSON.stringify(gpu)}`);
}else{
 await run('scene-static','npm',['run','native:scene:static'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'fixtures'),...prebuilt});
 console.log('GPU rendering, HWRT execution and windows NOT VALIDATED (CPU-only CI).');
}
await joinLane(modulesLane);
if(subset)gpu={...gpu,validated:false,reason:'Partial iteration run; full native CI is required'};
const totalSeconds=seconds(ciStarted);
console.log(`Native CI: ${totalSeconds} s`);
const completed=new Set(checks.map(check=>check.name));
const skippedSteps=[...steps].filter(name=>!completed.has(name));
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,validated:!subset&&gpu.validated,subset,skippedSteps,gpuTestsSkipped:hostGpuTests?.skipped??[],scriptc:'0.4.4',gpu,hostGpuTests,requiredModules:15,totalSeconds,checks},null,2)+'\n');

// Each ignored test runs in its own process, so a panic cannot poison the shared
// test lock for the rest. The HWRT loop runs fewer iterations than its default.
async function runHostGpuTests(){
 const cargo=['test','--locked','--manifest-path','native/host/Cargo.toml','--lib'];
 const started=performance.now(),logs=resolve(out,'host-gpu-tests');mkdirSync(logs,{recursive:true});
 const listing=await run('host-gpu-tests-list','cargo',[...cargo,'--','--ignored','--list','--format=terse'],{},{log:resolve(logs,'list.log')});
 const allTests=[...listing.output.matchAll(/^(\S+): test$/gm)].map(match=>match[1]);
 const tests=allTests.filter(test=>!gpuFilter||gpuFilter.test(test));
 if(!tests.length)throw Error('No ignored host GPU tests were listed.');
 const results=[];
 if(batch){
  const log=resolve(logs,'batch.log');
  const result=await run('host-gpu-tests-batch','cargo',[...cargo,'--','--ignored','--test-threads=1',...tests],
   {MT_LOOP_ITERATIONS:String(loopIterations)},{allowFailure:true,log});
  const passed=new Set([...result.output.matchAll(/^test (\S+) \.\.\. ok$/gm)].map(match=>match[1]));
  const summary=/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/.exec(result.output);
  if(result.error||result.signal||!summary||Number(summary[1])+Number(summary[2])!==tests.length)
   throw Error(`Incomplete GPU batch; see ${log}`);
  for(const test of tests)results.push({test,status:passed.has(test)?'passed':'failed',log});
 }else for(const test of tests){
  const log=resolve(logs,test.replace(/[^\w.-]+/g,'_')+'.log');
  const result=await run(`host-gpu-test ${test}`,'cargo',[...cargo,'--','--ignored','--exact',test,'--test-threads=1'],
   {MT_LOOP_ITERATIONS:String(loopIterations)},{allowFailure:true,log});
  results.push({test,...classifyHostGpuResult(test,result,gpu),seconds:result.check.seconds,log});
 }
 const failed=results.filter(r=>r.status==='failed'),open=results.filter(r=>r.status==='known-open-hwrt-failure');
 const summary={batch,filter,skipped:allTests.filter(test=>!tests.includes(test)),tests:results.length,passed:results.length-failed.length-open.length,failed:failed.length,knownOpenHwrtFailures:open.length,
  hwrtLoopIterations:loopIterations,seconds:seconds(started),results};
 writeFileSync(resolve(logs,'summary.json'),JSON.stringify(summary,null,2)+'\n');
 for(const r of open)console.log(`host-gpu-tests: known-open HWRT failure in ${r.test}: ${r.failure}`);
 console.log(`host-gpu-tests: ${summary.passed}/${summary.tests} passed, ${open.length} known-open HWRT failures (${summary.seconds} s)`);
 if(failed.length)throw Error(`Host GPU tests failed: ${failed.map(r=>r.test).join(', ')}; see ${logs}`);
 return summary;
}
