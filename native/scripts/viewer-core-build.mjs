// Shared startup preparation for the packaged viewer and the Subsecond dev host.
import {prepareTinyBvh} from '../../scripts/fetch-tinybvh.mjs';
import {spawnCompiler} from './compiler.mjs';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarizeCoverage} from '../validation/diagnostics.mjs';
import {archiveName,nativeToolchainEnv} from './platform.mjs';

export const viewerRoot=resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// MUTRACER_SCRIPTC overrides the compiler installed by npm ci --prefix native/toolchain.
function bundledCompiler() {
  const result=spawnSync(process.execPath,['native/toolchain/compiler.mjs'],{cwd:viewerRoot,encoding:'utf8'});
  if(result.status!==0||!result.stdout.trim())
    throw new Error('Install the native compiler with: npm ci --prefix native/toolchain --include=optional, or set MUTRACER_SCRIPTC.');
  return result.stdout.trim();
}

export async function prepareViewerCore(out,target,environment=process.env) {
  mkdirSync(out,{recursive:true});
  const compiler=environment.MUTRACER_SCRIPTC||bundledCompiler();
  const env={...nativeToolchainEnv(environment),MUTRACER_SCRIPTC:compiler,CARGO_TARGET_DIR:target,
    MUTRACER_AOT_ARCHIVE:resolve(environment.MUTRACER_AOT_PREBUILT??resolve(out,archiveName('render-core')))};
  function run(command,args) {
    const result=(command===compiler?spawnCompiler:spawnSync)(command,args,{cwd:viewerRoot,env,stdio:'inherit'});
    if(result.error||result.status!==0)throw new Error(`${command} failed: ${result.error?.message??result.signal??result.status}`);
  }
  const version=spawnCompiler(compiler,['--version'],{encoding:'utf8'});
  if(version.status!==0||version.stdout.trim()!=='0.4.4')throw new Error('Set MUTRACER_SCRIPTC to scriptc 0.4.4.');
  const coverage=spawnCompiler(compiler,['coverage','native/src/render-core.ts','--print','diagnostics','--fail-on','blockers'],
    {cwd:viewerRoot,encoding:'utf8',maxBuffer:32*1024*1024});
  writeFileSync(resolve(out,'coverage.json'),coverage.stdout??'');
  if(coverage.nativeMatrixPrecision!==64)throw new Error('Native viewer requires Float64 CPU matrix storage.');
  if(coverage.error||!summarizeCoverage(JSON.parse(coverage.stdout),coverage.status).passed)
    throw new Error('AOT compilation graph failed; see coverage.json.');
  if(!environment.MUTRACER_AOT_PREBUILT)
    run(compiler,['build','--lib','--profile','native/src/render-core-profile.json','-o',env.MUTRACER_AOT_ARCHIVE]);
  run(process.execPath,['native/scripts/generate-display.mjs','--check']);
  run(process.execPath,['native/scripts/generate-sky.mjs','--check']);
  run(process.execPath,['native/scripts/generate-viewer-spheres.mjs','--check']);
  await prepareTinyBvh();
  return {env,run};
}
