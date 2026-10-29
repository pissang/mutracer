import {assertNoResearchArtifacts, assertNoProductionResearchImports} from './check-research-artifacts.mjs';
import ts from 'typescript';
import { createShaderFormattingTransformer } from './shader-formatting.mjs';
import { loadShaderIdentifierMap } from './shader-identifiers.mjs';
import {
  copyFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'lib');

rmSync(outputRoot, { recursive: true, force: true });

const configPath = path.join(projectRoot, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, projectRoot);
assertNoProductionResearchImports(projectRoot);
const researchRoot = path.join(projectRoot, 'src', 'research') + path.sep;
const program = ts.createProgram(parsed.fileNames.filter(filename => !filename.startsWith(researchRoot)), parsed.options);
const diagnostics = [...(config.error ? [config.error] : []), ...parsed.errors,
  ...ts.getPreEmitDiagnostics(program)];
if (!diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
  diagnostics.push(...program.emit(undefined, undefined, undefined, undefined, {
    before: [createShaderFormattingTransformer(loadShaderIdentifierMap())]
  }).diagnostics);
}
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => projectRoot,
    getCanonicalFileName: filename => filename,
    getNewLine: () => '\n'
  }));
}
if (diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) process.exit(1);

const tinyBvhOutput = path.join(outputRoot, 'tinybvh');
mkdirSync(tinyBvhOutput, { recursive: true });
copyFileSync(
  path.join(projectRoot, 'src', 'tinybvh', 'tinybvh.wasm'),
  path.join(tinyBvhOutput, 'tinybvh.wasm')
);
copyFileSync(
  path.join(projectRoot, 'src', 'tinybvh', 'LICENSE'),
  path.join(tinyBvhOutput, 'LICENSE')
);

// Source builds let Vite discover the TypeScript worker; published ESM uses
// the adjacent compiled JavaScript entry so consumers need no TS loader.
const workerClientPath = path.join(outputRoot, 'renderer', 'bvhWorkerClient.js');
writeFileSync(workerClientPath,
  readFileSync(workerClientPath, 'utf8').replace('./bvh.worker.ts', './bvh.worker.js'));

assertNoResearchArtifacts(outputRoot);
