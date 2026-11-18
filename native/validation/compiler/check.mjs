import {spawnCompiler} from '../../scripts/compiler.mjs';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { summarizeCoverage } from '../diagnostics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(root, process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build');
const compiler = process.env.MUTRACER_SCRIPTC ?? 'scriptc';
mkdirSync(output, { recursive: true });
const run = args => {
  const result = spawnCompiler(compiler, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`scriptc terminated by ${result.signal}`);
  return result;
};
const version = run(['--version']);
if (version.status !== 0 || !/\b0\.3\.2\b/.test(version.stdout)) {
  throw new Error(`This experiment requires scriptc 0.4.4: ${version.stdout} ${version.stderr}`);
}

// Inventory both published entries, including type-only exports for context.
// This is an API inventory, not a claim that each member has a native ABI.
const configFile = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();
const inventory = {};
for (const entry of ['src/main.ts', 'src/three.ts', 'src/oidn.ts']) {
  const source = program.getSourceFile(resolve(root, entry));
  const module = checker.getSymbolAtLocation(source);
  inventory[entry] = checker.getExportsOfModule(module).map(symbol => {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const runtime = !!(target.flags & ts.SymbolFlags.Value);
    return { name: symbol.name, runtime };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
writeFileSync(resolve(output, 'public-exports.json'), JSON.stringify(inventory, null, 2) + '\n');

const coverage = {};
for (const [name, entry] of [
  ['main-direct', 'src/main.ts'],
  ['oidn-direct', 'src/oidn.ts'],
  ['full-with-browser-types', 'native/validation/compiler/full-library.ts']
]) {
  const result = run(['coverage', entry, '--print', 'diagnostics', '--fail-on', 'blockers']);
  writeFileSync(resolve(output, `${name}.json`), result.stdout);
  writeFileSync(resolve(output, `${name}.stderr`), result.stderr);
  coverage[name] = summarizeCoverage(JSON.parse(result.stdout), result.status);
  console.log(`${name}: ${coverage[name].errorSites} error sites (${coverage[name].errorGroups} groups)`);
}

const builds = {};
for (const name of ['engine', 'engine-core', 'async-boundary']) {
  const artifact = resolve(output, `${name}.lib.a`);
  rmSync(artifact, { force: true });
  const result = run(['build', '--lib', '--profile', `native/validation/compiler/${name}-profile.json`, '-o', artifact]);
  writeFileSync(resolve(output, `${name}-build.log`), result.stdout + result.stderr);
  builds[name] = { passed: result.status === 0 && existsSync(artifact), exitCode: result.status, artifact };
  console.log(`${name} archive: ${builds[name].passed ? 'built' : 'blocked'}`);
}
const report = {
  compiler: version.stdout.trim(),
  platform: `${process.platform}-${process.arch}`,
  coverage, builds,
  // Standalone archives and the GPU capture replay do not implement the full
  // public native API; clean probes alone cannot certify the whole library.
  wholeLibraryNative: false,
  reason: 'Full public API and asynchronous lifecycle equivalents remain incomplete; native GPU replay is validated separately.'
};
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Whole native library: unavailable. Report: ${resolve(output, 'summary.json')}`);
process.exitCode = 1;
