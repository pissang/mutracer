import {spawnCompiler} from '../scripts/compiler.mjs';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeCoverage } from './diagnostics.mjs';
import { archiveName } from '../scripts/platform.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const importRoot = root.replaceAll('\\', '/');
const output = resolve(root, process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build', 'modules');
const compiler = process.env.MUTRACER_SCRIPTC ?? 'scriptc';
mkdirSync(output, { recursive: true });
// Keep compiler entries inside the project so its Node typings are resolved;
// external evidence-directory entries otherwise inject conflicting fallback DOM types.
const entries = resolve(root, '.native-build/module-probes');
mkdirSync(entries, { recursive: true });
const modules = [
  ['math', 'src/math.ts', null, 'native/tests/modules/math.ts', 'mathParameters'],
  ['geometry', 'src/util/commonGeometry.ts', null, 'native/tests/modules/geometry.ts', 'geometryParameters'],
  ['camera', 'src/scene/Camera.ts', null, 'native/tests/modules/camera.ts', 'cameraParameters'],
  ['environment', 'src/renderer/envMapDistribution.ts', null, 'native/tests/modules/environment.ts', 'environmentParameters'],
  ['geometry-updates', 'src/renderer/geometryUpdates.ts', null, 'native/tests/modules/geometry-updates.ts', 'geometryUpdateParameters'],
  ['bvh-core', 'src/renderer/binnedSahBvh.ts', null, 'native/src/bvh-core.ts', 'buildBvh'],
  ['bvh-facade', 'src/renderer/bvhAccel.ts', null, 'native/tests/modules/bvh-facade.ts', 'bvhParameters'],
  ['materials', 'src/renderer/MaterialTable.ts', `import MaterialTable from '${importRoot}/src/renderer/MaterialTable.js';
import Material from '${importRoot}/src/scene/OpenPBRMaterial.js';
export function run(bytes: Uint8Array): Uint8Array { return new Uint8Array(new MaterialTable([new Material()], []).getBufferArray().buffer); }`],
  ['material-graph', 'src/renderer/materialGraph/generate.ts', null, 'native/tests/modules/material-graph.ts', 'materialGraphParameters'],
  ['material-packing', 'src/renderer/materialLayout.ts', null, 'native/tests/modules/material-packing.ts', 'materialParameters'],
  ['material-data', 'src/renderer/materialCore.ts', null, 'native/tests/modules/material-data.ts', 'materialDataParameters'],
  // The native light entry includes the portable model constructors: scriptc
  // needs their values in the graph to lower class-typed sampler parameters.
  ['lights', 'src/renderer/lightCore.ts', null, 'native/tests/modules/lights.ts', 'lightParameters'],
  ['shader-generation', 'src/renderer/wgsl/rayTrace.compute.ts', null, 'native/tests/modules/shader-generation.ts', 'shaderParameters'],
  ['displacement', 'src/renderer/displacementPreparation.ts', null, 'native/tests/modules/displacement.ts', 'displacementParameters'],
  ['ies', 'src/scene/IESProfile.ts', null, 'native/tests/modules/ies.ts', 'iesParameters'],
  ['sampling', 'src/renderer/sampling.ts', null, 'native/src/sampling-core.ts', 'samplingParameters']
];
function invoke(name, args) {
  const result = spawnCompiler(compiler, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90_000 });
  writeFileSync(resolve(output, `${name}.stdout`), result.stdout ?? '');
  writeFileSync(resolve(output, `${name}.stderr`), result.stderr ?? '');
  return result;
}
const version = invoke('version', ['--version']);
if (version.status !== 0 || version.stdout.trim() !== '0.4.4') throw new Error('Module probes require scriptc 0.4.4');
const results = [];
for (const [name, source, wrapper, providedEntry, providedExport] of modules) {
  console.log(`Module ${name}: coverage...`);
  const coverageEntry = resolve(entries, `${name}-coverage.ts`);
  const coverageSource = `/// <reference path="${importRoot}/native/src/browser-types.d.ts" />\nexport * from '${importRoot}/${source.replace(/\.ts$/, '.js')}';\n`;
  writeFileSync(coverageEntry, coverageSource);
  writeFileSync(resolve(output, `${name}-coverage.ts`), coverageSource);
  const check = invoke(`${name}-coverage`, ['coverage', coverageEntry, '--print', 'diagnostics', '--fail-on', 'blockers']);
  let coverage;
  try { coverage = summarizeCoverage(JSON.parse(check.stdout), check.status); }
  catch { coverage = { passed: false, error: check.error?.message ?? 'No valid diagnostics', exitCode: check.status }; }
  const record = { name, source, coverage, archive: { attempted: false, passed: false } };
  if (wrapper || providedEntry) {
    const entry = providedEntry ? resolve(root, providedEntry) : resolve(entries, `${name}-entry.ts`);
    if (wrapper) {
      const source = `/// <reference path="${importRoot}/native/src/browser-types.d.ts" />\n${wrapper}\n`;
      writeFileSync(entry, source); writeFileSync(resolve(output, `${name}-entry.ts`), source);
    }
    const profile = resolve(output, `${name}-profile.json`), artifact = resolve(output, archiveName(name));
    writeFileSync(profile, JSON.stringify({ profile_format: 1, name: `module_${name.replaceAll('-', '_')}`, entry,
      emission: 'llvm', abi: { prefix: 'mt_module_', init_symbol: 'mt_module_init', collect_symbol: 'mt_module_collect',
        result_reset_symbol: 'mt_module_reset', sink_register_symbol: 'mt_module_sink', localize_runtime: true },
      exports: [{ export: providedExport ?? 'run', symbol: 'mt_module_run', params: ['bytes'], returns: 'bytes' }] }, null, 2));
    rmSync(artifact, { force: true });
    const build = invoke(`${name}-build`, ['build', '--lib', '--profile', profile, '-o', artifact]);
    record.archive = { attempted: true, passed: build.status === 0 && existsSync(artifact), exitCode: build.status,
      error: build.error?.message, artifact };
  }
  record.status = coverage.passed && record.archive.passed ? 'archive-built' : 'blocked';
  results.push(record);
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify({ compiler: '0.4.4', results,
    scope: 'Coverage counts all error scopes in every listed source graph, including the portable material/light model entries. The browser MaterialTable remains a separate diagnostic target. Archives expose representative byte adapters; they do not certify every public API or runtime behavior.',
    wholeLibraryNative: false }, null, 2) + '\n');
  console.log(`Module ${name}: ${record.status}${coverage.errorSites !== undefined ? ` (${coverage.errorSites} error sites)` : ''}`);
}
// A matrix with blocked modules is an expected experiment result, not a full-library success.
console.log(`Module matrix: ${resolve(output, 'summary.json')}`);
// Compilation is the current project gate. Partial module success is retained
// as evidence, but must not produce a successful full compilation command.
if (results.some(result => result.status !== 'archive-built')) process.exitCode = 1;
