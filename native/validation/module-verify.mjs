import {spawnNative as spawnSync} from '../scripts/platform.mjs';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { cCompiler, cLinkFlags, executable } from '../scripts/platform.mjs';
import {compareModuleBytes} from './module-comparison.mjs';
import {createPlaneGeometry, createSphereGeometry} from '../../lib/util/commonGeometry.js';
import { buildBinnedSahBvh, layoutBvh2 } from '../../lib/renderer/binnedSahBvh.js';
import { samplingPatternCode, zSobolLog2SPP, zSobolPermutations, zSobolPackedPermutations, sobolD1Steps } from '../../lib/renderer/sampling.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build', 'modules');
const matrix = JSON.parse(readFileSync(resolve(output, 'summary.json'), 'utf8'));
rmSync(resolve(output, 'runtime.json'), { force: true });
function run(name, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(resolve(output, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.status !== 0) throw new Error(`${name}: exit=${result.status}, signal=${result.signal ?? 'none'}; ${result.error?.message ?? result.stderr}`);
}
const results = [];
// Use source emission for native-only types absent from the published lib and
// for shader templates, which the published build formats/minifies.
const sourceOracleRoot = resolve(output, 'javascript-source');
const sourceConfig = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
const sourceOptions = ts.parseJsonConfigFileContent(sourceConfig.config, ts.sys, root).options;
const sourceModules = ['math', 'geometry', 'camera', 'environment', 'geometry-updates', 'bvh-facade',
  'material-packing', 'material-data', 'lights', 'shader-generation', 'displacement', 'ies'];
const sourceProgram = ts.createProgram(sourceModules.map(name => resolve(root, `native/tests/modules/${name}.ts`)), { ...sourceOptions, rootDir: root,
  outDir: sourceOracleRoot, declaration: false, sourceMap: false, inlineSources: false });
const sourceDiagnostics = [...ts.getPreEmitDiagnostics(sourceProgram), ...sourceProgram.emit().diagnostics];
if (sourceDiagnostics.some(item => item.category === ts.DiagnosticCategory.Error)) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext(sourceDiagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n' }));
}
writeFileSync(resolve(sourceOracleRoot, 'package.json'), '{"type":"module"}\n');
function writeState(complete) {
  writeFileSync(resolve(output, 'runtime.json'), JSON.stringify({ complete,
    success: complete && results.every(result => result.passedCases === result.cases), results }, null, 2) + '\n');
}
writeState(false);
for (const name of ['math', 'geometry', 'camera', 'environment', 'geometry-updates', 'bvh-core', 'bvh-facade', 'material-packing', 'material-data', 'lights', 'shader-generation', 'sampling', 'displacement', 'ies']) {
  const module = matrix.results.find(item => item.name === name);
  if (module?.status !== 'archive-built') throw new Error(`Required composition module blocked: ${name}`);
  const host = resolve(output, executable(`${name}-host`));
  run(`${name}-host-build`, cCompiler, ['-Wall', '-Wextra', '-Werror', 'native/tests/module-host.c', module.archive.artifact, ...cLinkFlags, '-o', host]);
  const fixtures = [];
  if (name !== 'bvh-core' && name !== 'sampling') {
    const oracle = await import(pathToFileURL(resolve(sourceOracleRoot, `native/tests/modules/${name}.js`)).href);
    if (name === 'math') for (const [i, values] of [[0, 0, 0], [1, 2, 3], [-1.25, .3, 4], [.3, -.7, 1.2], [1e-6, 2e-6, -3e-6], [100, -50, .125]].entries()) {
      const input = new Uint8Array(new Float32Array(values).buffer);
      fixtures.push({ label: `numeric-${i}`, input, expected: oracle.mathParameters(input) });
    }
    else if (name === 'geometry') for (const shape of [0, 1, 2, 3, 4, 5]) for (const segments of shape < 3 ? [1, 3, 8] : [1]) {
      const input = new Uint8Array(new Uint32Array([shape, segments]).buffer);
      fixtures.push({ label: `shape-${shape}-${segments}`, input, expected: oracle.geometryParameters(input) });
    }
    else if (name === 'camera') for (let flags = 0; flags < 16; flags++) {
      const input = new Uint8Array(new Uint32Array([flags]).buffer);
      fixtures.push({ label: `camera-${flags}`, input, expected: oracle.cameraParameters(input) });
    }
    else if (name === 'environment') for (const [width, height] of [[1, 1], [8, 4]]) for (let storage = 0; storage < 4; storage++) for (const flags of [0, 1, 2, 4]) {
      const input = new Uint8Array(new Uint32Array([width, height, storage, 4, flags]).buffer);
      fixtures.push({ label: `cdf-${width}-${height}-${storage}-${flags}`, input, expected: oracle.environmentParameters(input) });
    }
    else if (name === 'bvh-facade') for (const count of [0, 1, 3, 17]) for (const [flags, segments, dynamic] of [[0, 1, 0], [3, 8, 0], [5, 8, 1], [9, 8, 0]]) {
      const geometry = flags & 1 ? createSphereGeometry(segments, segments) : createPlaneGeometry(segments, segments);
      const input = new Uint8Array(16 + geometry.position.array.byteLength + geometry.normal.array.byteLength);
      new Uint32Array(input.buffer, 0, 4).set([count, segments, flags, dynamic]);
      input.set(new Uint8Array(geometry.position.array.buffer), 16);
      input.set(new Uint8Array(geometry.normal.array.buffer), 16 + geometry.position.array.byteLength);
      fixtures.push({ label: `instances-${count}-${flags}`, input, expected: oracle.bvhParameters(input) });
    }
    else if (name === 'material-packing') for (const count of [0, 1, 3, 257]) for (const flags of [0, 1, 2, 3]) {
      const input = new Uint8Array(new Uint32Array([count, flags, 7]).buffer);
      fixtures.push({ label: `materials-${count}-${flags}`, input, expected: oracle.materialParameters(input) });
    }
    else if (name === 'geometry-updates') for (const segments of [1, 3]) for (let flags = 0; flags < 136; flags++) {
      const input = new Uint8Array(new Uint32Array([flags, segments]).buffer);
      fixtures.push({label: `updates-${segments}-${flags}`, input, expected: oracle.geometryUpdateParameters(input)});
    }
    else if (name === 'material-data') for (const count of [0, 1, 5]) for (let flags = 0; flags < 128; flags++) {
      const input = new Uint8Array(new Uint32Array([count, flags]).buffer);
      fixtures.push({label: `atlas-${count}-${flags}`, input, expected: oracle.materialDataParameters(input)});
    }
    else if (name === 'displacement') for (const size of [1, 2, 4, 16]) for (let flags = 0; flags < (size === 4 ? 36 : 32); flags++) {
      if ((flags & 8) && !(flags & 3)) continue;
      const input = new Uint8Array(new Uint32Array([size, flags]).buffer);
      fixtures.push({label: `height-${size}-${flags}`, input, expected: oracle.displacementParameters(input)});
    }
    else if (name === 'ies') {
      const valid = 'IESNA:LM-63-2002\nTILT=NONE\n1 1000 1 3 1 1 2 0 0 0 1 1 20\n0 45 90\n0\n100 50 0\n';
      for (const [label, text] of [
        ['valid', valid], ['commas', valid.replaceAll(' ', ',')], ['header', valid.replace('2002', '1995')],
        ['asymmetric', valid.replace('3 1 1 2', '3 3 1 2').replace('0\n100 50 0', '0 90 180\n100 50 0 20 10 0 50 25 0')],
        ['invalid-header', 'bad'], ['tilt', valid.replace('NONE', 'INCLUDE')],
        ['counts', valid.replace('1 1000 1 3', '1 1000 1 4')], ['zero', valid.replace('100 50 0', '0 0 0')],
        ['negative', valid.replace('100 50 0', '-1 50 0')], ['non-finite', valid.replace('100 50 0', 'NaN 50 0')]
      ]) {
        const input = new TextEncoder().encode(text);
        fixtures.push({label, input, expected: oracle.iesParameters(input)});
      }
    }
    else if (name === 'lights') for (let flags = 0; flags < 128; flags++) {
      const input = new Uint8Array(new Uint32Array([flags]).buffer);
      fixtures.push({label: `lights-${flags}`, input, expected: oracle.lightParameters(input)});
    }
    else {
      for (let flags = 0; flags < 32; flags++) for (const mask of [1, 15]) {
        const input = new Uint8Array(new Uint32Array([flags, mask]).buffer);
        fixtures.push({ label: `features-${flags}-${mask}`, input, expected: oracle.shaderParameters(input) });
      }
      const input = new Uint8Array(new Uint32Array([32, 0]).buffer);
      fixtures.push({ label: 'lookup-table', input, expected: oracle.shaderParameters(input) });
    }
  } else if (name === 'bvh-core') {
    let state = 0x12345678;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    for (const count of [0, 1, 2, 17, 63, 1000, 2048]) {
      const boxes = new Float32Array(count * 6);
      for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) {
        const low = count === 17 ? 0 : random() * 40 - 20;
        boxes[i * 6 + axis] = low;
        boxes[i * 6 + axis + 3] = count === 17 ? 0 : low + random() * 2;
      }
      const bvh = buildBinnedSahBvh(boxes, count), layout = layoutBvh2(bvh);
      const words = new Uint32Array(8 + bvh.nodeCount * 10 + count);
      words.set([1, bvh.nodeCount, count, layout.vec4Count, layout.maxDepth, layout.maxLeafPrimitives, 0, 0]);
      let offset = 8;
      for (const data of [new Uint32Array(bvh.bounds.buffer, 0, bvh.nodeCount * 6),
        bvh.leftFirst.subarray(0, bvh.nodeCount), bvh.primCount.subarray(0, bvh.nodeCount), bvh.primIndices, layout.order, layout.offsets]) {
        words.set(data, offset); offset += data.length;
      }
      fixtures.push({ label: `boxes-${count}`, input: new Uint8Array(boxes.buffer), expected: new Uint8Array(words.buffer) });
    }
  } else {
    for (const count of [0, 1, 2, 63, 64, 65, 256, 65536, 0xffffffff]) {
      const values = [samplingPatternCode('sobol'), zSobolLog2SPP(count), ...zSobolPermutations, ...zSobolPackedPermutations, ...sobolD1Steps.flat()];
      fixtures.push({ label: `samples-${count}`, input: new Uint8Array(new Uint32Array([count]).buffer), expected: new Uint8Array(new Uint32Array(values).buffer) });
    }
  }
  const directory = resolve(output, name); mkdirSync(directory, { recursive: true });
  const failures = [];
  let byteIdentical = true, nearZeroComponents = 0;
  for (const fixture of fixtures) {
    const input = resolve(directory, `${fixture.label}.input.bin`), actual = resolve(directory, `${fixture.label}.native.bin`);
    writeFileSync(input, fixture.input);
    writeFileSync(resolve(directory, `${fixture.label}.javascript.bin`), fixture.expected);
    rmSync(actual, { force: true });
    try {
      run(`${name}-${fixture.label}`, host, [input, actual]);
      const bytes = readFileSync(actual);
      const comparison = compareModuleBytes(name, bytes, fixture.expected);
      byteIdentical &&= comparison.byteIdentical;
      nearZeroComponents += comparison.nearZeroComponents;
      if (!comparison.matched) throw new Error(`Module byte mismatch: ${name}/${fixture.label}`);
      if (name === 'lights') {
        const count = bytes.readUInt32LE(4), parts = [];
        let offset = (count + 2) * 4;
        for (let i = 0; i < count; i++) {
          const size = bytes.readUInt32LE((i + 2) * 4);
          parts.push(bytes.subarray(offset, offset + size)); offset += size;
        }
        if (!parts[6].equals(parts[7]) || !parts[6].equals(parts[8]) || !parts[9].equals(parts[10])) {
          throw new Error(`Emissive cache differs from full rebuild: ${fixture.label}`);
        }
        if (parts[0].readDoubleLE(16) !== parts[0].readDoubleLE(24)) {
          throw new Error(`Environment identity cache missed: ${fixture.label}`);
        }
      }
    } catch (error) { failures.push({ label: fixture.label, error: error.message }); }
  }
  results.push({ name, cases: fixtures.length, passedCases: fixtures.length - failures.length,
    repeatedCalls: (fixtures.length - failures.length) * 2, byteIdentical: byteIdentical && failures.length === 0, nearZeroComponents, failures });
  writeState(false);
  console.log(`${name}: ${fixtures.length - failures.length}/${fixtures.length} cases match native/JavaScript${nearZeroComponents ? ` (${nearZeroComponents} Windows libm near-zero components)` : ' bytes'}`);
}
writeState(true);
if (results.some(result => result.passedCases !== result.cases)) process.exitCode = 1;
