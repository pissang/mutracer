// One real-GPU gate; the two runtimes retain independent orchestration.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {root} from './reference-capture.mjs';
import {archiveName} from '../native/scripts/platform.mjs';
const out=resolve(process.env.MUTRACER_PARITY_OUTPUT??'.cache/display-parity');
const native=resolve(out,'native');mkdirSync(native,{recursive:true});
const env={...process.env,MUTRACER_PARITY_OUTPUT:out,MUTRACER_NATIVE_OUTPUT:native,
 MUTRACER_AOT_ARCHIVE:resolve(process.env.MUTRACER_AOT_PREBUILT??process.env.MUTRACER_AOT_ARCHIVE??resolve(native,archiveName('render-core'))),
 CARGO_TARGET_DIR:resolve(process.env.CARGO_TARGET_DIR??resolve(native,'host-target'))};
const stages=[];
function run(name,command,args,extra={}){
 console.log(`\n[parity] ${name}`);
 const result=spawnSync(command,args,{cwd:root,env:{...env,...extra},stdio:'inherit'});
 stages.push({name,exitCode:result.status});
 if(result.error||result.status!==0)throw result.error??Error(`${name} failed (${result.status})`);
}
let frozen={status:'skipped',reason:'MUTRACER_OIDN_DISPLAY_INPUT is not set'};
try{
 run('browser WebGPU and WebGL',process.execPath,['scripts/display-parity.mjs','--browser-only']);
 run('native parity and schedule',process.execPath,['native/scripts/ci.mjs','--only',process.env.MUTRACER_AOT_PREBUILT?'host-tests':'aot-build,host-tests',
  '--gpu-tests','display_parity|display_schedule_event_table','--batch-gpu-tests']);
 run('cross-backend images and traces',process.execPath,['scripts/display-parity.mjs','--compare-only']);
 run('browser schedule',process.execPath,[process.env.npm_execpath??'node_modules/vitest/vitest.mjs',
  ...(process.env.npm_execpath?['exec','--','vitest']:[]),'run','tests/unit/displaySchedule.test.ts']);
 if(process.env.MUTRACER_OIDN_DISPLAY_INPUT){
  const capture=resolve(out,'frozen-native');
  run('native frozen highlight', 'cargo',['test','--locked','--manifest-path','native/host/Cargo.toml','--lib',
   'viewer_display_oidn_contains_firefly_spread_and_preserves_sdk_hdr','--','--ignored','--test-threads=1','--nocapture'],{MUTRACER_TEST_CAPTURE:capture});
  run('frozen browser/native comparison',process.execPath,['scripts/display-frozen.mjs'],
   {MUTRACER_PARITY_OUTPUT:resolve(out,'frozen'),MUTRACER_NATIVE_DISPLAY_PNG:resolve(capture,'after-display-oidn.png')});
  frozen={status:'passed'};
 }else console.log('[parity] SKIP frozen highlight comparison: set MUTRACER_OIDN_DISPLAY_INPUT to the frozen HDR/guide directory.');
 writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,stages,frozen},null,2)+'\n');
}catch(error){writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:false,stages,frozen,error:String(error)},null,2)+'\n');throw error;}
