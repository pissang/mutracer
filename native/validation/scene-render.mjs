import {spawnNative as spawnSync} from '../scripts/platform.mjs';
import {prepareTinyBvh} from '../../scripts/fetch-tinybvh.mjs';
import {finalizeHostLibrary} from '../scripts/finalize-host-library.mjs';
import {spawnCompiler} from '../scripts/compiler.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeCoverage } from './diagnostics.mjs';
import { archiveName, cCompiler, cLinkFlags, executable, nativeToolchainEnv, windows } from '../scripts/platform.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? resolve(root, '.native-build/scene-core'));
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(out, 'cargo-target'));
const compiler = process.env.MUTRACER_SCRIPTC ?? 'scriptc';
const staticOnly = process.argv.includes('--static');
const samples = Number(process.env.MUTRACER_NATIVE_SAMPLES ?? '256');
if (!Number.isInteger(samples) || samples < 1 || samples > 4096)
    throw new Error('Samples must be 1..4096');
mkdirSync(out, { recursive: true });
// native:ci passes the archive it already built; the Cargo build script keys on its path.
const prebuilt = process.env.MUTRACER_AOT_PREBUILT;
const env = { ...nativeToolchainEnv(), MUTRACER_NATIVE_OUTPUT: out, CARGO_TARGET_DIR: target, MUTRACER_AOT_ARCHIVE: resolve(prebuilt ?? resolve(out, archiveName('render-core'))) };
if(windows)env.PATH=resolve(target,'release')+delimiter+env.PATH;
const checks = [];
function run(name, command, args, check = true) {
    console.log(`${name}...`);
    const result = (command === compiler ? spawnCompiler : spawnSync)(command, args, { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(resolve(out, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    checks.push({ name, exitCode: result.status });
    writeFileSync(resolve(out, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
    if (result.error || check && result.status !== 0)
        throw new Error(`${name}: ${result.error?.message || result.stderr || result.stdout}`);
    return result;
}
if (run('compiler-version', compiler, ['--version']).stdout.trim() !== '0.4.4')
    throw new Error('Requires scriptc 0.4.4');
run('material-property-contract', process.execPath, ['native/scripts/generate-material-properties.mjs', '--check']);
const coverage = run('scene-coverage', compiler, ['coverage', 'native/src/scene-core.ts', '--print', 'diagnostics', '--fail-on', 'blockers'], false);
const diagnostics = JSON.parse(coverage.stdout);
writeFileSync(resolve(out, 'coverage.json'), JSON.stringify(diagnostics, null, 2));
const summary = summarizeCoverage(diagnostics, coverage.status);
writeFileSync(resolve(out, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
if (!summary.passed)
    throw new Error('Composed scene graph has compiler diagnostics; inspect coverage.json');
const composed = run('render-core-coverage', compiler, ['coverage', 'native/src/render-core.ts', '--print', 'diagnostics', '--fail-on', 'blockers'], false);
const composedDiagnostics = JSON.parse(composed.stdout);
writeFileSync(resolve(out, 'render-core-coverage.json'), JSON.stringify(composedDiagnostics, null, 2));
if (!summarizeCoverage(composedDiagnostics, composed.status).passed)
    throw new Error('Full AOT entry graph has compiler diagnostics');
if (!prebuilt)
    run('aot-build', compiler, ['build', '--lib', '--profile', 'native/src/render-core-profile.json', '-o', env.MUTRACER_AOT_ARCHIVE]);
await prepareTinyBvh();
run('native-build', 'cargo', ['build', '--release', '--locked', '--manifest-path', 'native/host/Cargo.toml']);
finalizeHostLibrary(target);
const sceneHost=resolve(out,executable('scene-host')), minimalHost=resolve(out,executable('minimal-host'));
const linkLibrary=windows?[resolve(target,'release/mutracer.dll.lib')]:['-L',resolve(target,'release'),'-lmutracer',`-Wl,-rpath,${resolve(target,'release')}`];
run('scene-host-build', cCompiler, ['-Wall', '-Wextra', '-Werror', '-I', 'native/include', 'native/examples/scene-host.c', ...linkLibrary, ...cLinkFlags,'-o',sceneHost]);
run('minimal-host-build', cCompiler, ['-Wall', '-Wextra', '-Werror', '-I', 'native/include', 'native/examples/minimal-host.c', ...linkLibrary, ...cLinkFlags,'-o',minimalHost]);
run('core-host-build', cCompiler, ['-Wall', '-Wextra', '-Werror', '-Dmt_module_init=mt_core_init', '-Dmt_module_reset=mt_core_reset', '-Dmt_module_collect=mt_core_collect', '-Dmt_module_sink=mt_core_sink', '-Dmt_module_run=mt_core_scene', 'native/tests/module-host.c', env.MUTRACER_AOT_ARCHIVE, ...cLinkFlags, '-o', resolve(out, executable('core-host'))]);
for (const variant of ['baseline', 'textures', 'transforms', 'orthographic', 'emissive', 'missing-normals', 'float-textures', 'sphere-light', 'directional-light', 'spot-light', 'disk-light', 'cylinder-light', 'lights-1024', 'alpha', 'v2-environment', 'v2-environment-only', 'v2-background', 'v2-hidden-background', 'v2-film', 'v2-medium', 'v2-alpha', 'v2-bevel', 'v2-vertices', 'v2-multimaterial', 'v2-instances', 'v2-empty-batch', 'v3-displacement-uv', 'v3-displacement-triplanar', 'v3-displacement-spherical', 'v3-displacement-cylindrical', 'v3-displacement-negative', 'v3-displacement-bytes', 'v3-displacement-zero', 'v3-ies', 'v3-ies-shared', 'v3-rect-texture']) {
    const directory=resolve(out,variant==='baseline'?'image':variant);
    if(staticOnly){
        mkdirSync(directory,{recursive:true});
        run(`fixture-${variant}`,sceneHost,[resolve(directory,'scene-input.bin'),'0',variant]);
    }else run(`render-${variant}`,sceneHost,[directory,String(samples),variant,...(variant==='baseline'?['repeat']:[])]);
}
if(!staticOnly)run('minimal-host', minimalHost, [String(Math.min(samples, 16))]);
run('verify-scenes', process.execPath, ['native/validation/scene-verify.mjs']);
if(staticOnly){
    writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,gpuValidated:false,checks},null,2)+'\n');
    console.log('Scene packets/resources/WGSL verified without a GPU; rendering NOT VALIDATED.');
    process.exit(0);
}
// Incremental commits must render exactly like full commits of the same descriptor.
const fixtures = ['baseline', 'textures', 'transforms', 'orthographic', 'emissive', 'missing-normals', 'float-textures', 'sphere-light', 'directional-light', 'spot-light', 'disk-light', 'cylinder-light', 'lights-1024', 'alpha', 'v2-environment', 'v2-environment-only', 'v2-background', 'v2-hidden-background', 'v2-film', 'v2-medium', 'v2-alpha', 'v2-bevel', 'v2-vertices', 'v2-multimaterial', 'v2-instances', 'v2-empty-batch', 'v3-displacement-uv', 'v3-displacement-triplanar', 'v3-displacement-spherical', 'v3-displacement-cylindrical', 'v3-displacement-negative', 'v3-displacement-bytes', 'v3-displacement-zero', 'v3-ies', 'v3-ies-shared', 'v3-rect-texture']
  .map(variant => resolve(out, variant === 'baseline' ? 'image' : variant, 'scene-input.bin'));
// Each scene has many paired full/incremental renders. Bound each fixture
// separately so a healthy real-GPU run is not limited to five minutes in total.
let oracleOutput = '';
for (const [i, fixture] of fixtures.entries()) {
    const oracle = run(`incremental-oracle-${i}`, resolve(target, 'release', executable('incremental-oracle')), [String(Math.min(samples, 8)), '0', fixture]);
    oracleOutput += oracle.stdout;
    writeFileSync(resolve(out, 'incremental-oracle.jsonl'), oracleOutput);
}
// Both baseline renders execute in one C process with reset/collection between calls.
for (const name of ['render', 'normal', 'albedo'])
    if (!readFileSync(resolve(out, `image/${name}.rgba32f`)).equals(readFileSync(resolve(out, `image/repeat/${name}.rgba32f`))))
        throw new Error(`Repeated native ${name} differs`);
console.log(`Native scene image: ${resolve(out, 'image/render.png')}`);
