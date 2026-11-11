import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync,statSync,existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {spawnCompiler} from '../native/scripts/compiler.mjs';
import {archiveName} from '../native/scripts/platform.mjs';
import {launchChrome, delay} from './reference-runtime.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function command(command, args, cwd, env = process.env, log) {
  const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024});
  if (log) writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.status !== 0) throw result.error ?? Error(`${command} failed (${result.status}); see ${log}`);
  return result.stdout.trim();
}
export function reference(commit) {
  const sha = command('git', ['rev-parse', '--verify', commit + '^{commit}'], root);
  const directory = resolve(process.env.MUTRACER_REFERENCE_CACHE ?? resolve(root, '.cache/reference'), sha);
  const source = resolve(directory, 'source');
  mkdirSync(directory, {recursive: true});
  if (!existsSync(source)) command('git', ['worktree', 'add', '--detach', source, sha], root);
  for (const path of ['node_modules', 'native/toolchain/node_modules', '.cache/tinybvh']) {
    const target = resolve(source, path);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), {recursive: true});
      symlinkSync(resolve(root, path), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  return {sha, directory, source};
}
export function buildLibrary(source, directory) {
  mkdirSync(directory, {recursive: true});
  command('npm', ['run', 'build:lib'], source, process.env, resolve(directory, 'build-lib.log'));
}
export async function serve(source, directory, fixture, resolveOptions, allowedPaths = []) {
  const server = await createServer({root: source, configFile: false, resolve: resolveOptions,
    optimizeDeps: {entries: [], noDiscovery: true}, server: {host: '127.0.0.1', port: 0, hmr: false, watch: {ignored: ['**/.native-build/**']},
      fs: {allow: [source, root, directory, ...allowedPaths, ...(process.env.MUTRACER_NATIVE_DISPLAY_PNG ? [dirname(process.env.MUTRACER_NATIVE_DISPLAY_PNG)] : []), ...(process.env.MUTRACER_OIDN_DISPLAY_INPUT ? [process.env.MUTRACER_OIDN_DISPLAY_INPUT] : [])]}}, plugins: [{name: 'reference-fixture', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        if (request.method === 'POST' && url.pathname.startsWith('/evidence/')) {
          const name = url.pathname.slice('/evidence/'.length);
          if (!/^[\w.-]+$/.test(name)) {response.statusCode = 400; response.end(); return;}
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const path = resolve(directory, name), offset = request.headers['x-mutracer-offset'];
          if (offset !== undefined && offset !== '0') {
            if (!/^\d+$/.test(offset) || !existsSync(path) || statSync(path).size !== Number(offset)) {
              response.statusCode = 400; response.end('Invalid evidence offset'); return;
            }
            appendFileSync(path, Buffer.concat(chunks));
          } else writeFileSync(path, Buffer.concat(chunks));
          response.end('ok');
          return;
        }
        if (url.pathname === '/reference') {
          response.setHeader('content-type', 'text/html');
          response.end(`<title>MuTracer reference</title><canvas></canvas><button id="run">Run</button><pre id="result"></pre><script type="module" src="/@fs/${fixture}"></script>`);
          return;
        }
        next();
      });
    }}]});
  await server.listen();
  return {url: `http://127.0.0.1:${server.httpServer.address().port}/reference`, close: () => server.close()};
}
export async function ready(tab) {
  for (let i = 0; i < 600; i++) {
    if (await tab.evaluate("typeof window.runBenchmark === 'function'")) return;
    await delay(100);
  }
  throw Error('Browser fixture did not load');
}
function files(directory, prefix = '') {
  return readdirSync(resolve(directory, prefix), {withFileTypes: true}).flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? files(directory, name + '/') : [name];
  }).sort();
}
const fixturePath = process.env.MUTRACER_OIDN_DISPLAY_INPUT;
function fixtureKey() {
  if (!fixturePath) return {synthetic: true};
  return Object.fromEntries(['hdr', 'normal', 'albedo'].map(name =>
    [name, sha256(readFileSync(resolve(fixturePath, name + '.f32')))]));
}
async function capture(source, directory) {
  const started = performance.now();
  const output = resolve(directory, 'output');
  rmSync(output, {recursive: true, force: true});
  mkdirSync(output, {recursive: true});
  buildLibrary(source, directory);
  const server = await serve(source, output, resolve(root, 'scripts/reference-browser.ts'));
  let chrome;
  try {
    chrome = await launchChrome();
    for (const backend of ['webgpu', 'webgl']) {
      const page = await chrome.page(server.url + (backend === 'webgl' ? '?webgl' : ''));
      try {
        await ready(page.tab);
        console.log(await page.tab.evaluate('window.runBenchmark()'));
      } finally {await page.close();}
    }
  } finally {await chrome?.close(); await server.close();}
  const archive = resolve(directory, archiveName('render-core'));
  const compiler = process.env.MUTRACER_SCRIPTC ?? command(process.execPath, ['native/toolchain/compiler.mjs'], root);
  // Hash only the AOT inputs; GPU adapter changes must not rebuild the archive.
  const graph = files(resolve(source, 'src')).filter(name => name.endsWith('.ts'))
    .map(name => readFileSync(resolve(source, 'src', name)));
  graph.push(...files(resolve(source, 'native/src')).map(name => readFileSync(resolve(source, 'native/src', name))));
  const aotKey = sha256(Buffer.concat(graph));
  const keyPath = resolve(directory, 'archive-key');
  if (!existsSync(archive) || !existsSync(keyPath) || readFileSync(keyPath, 'utf8') !== aotKey) {
    const result = spawnCompiler(compiler, ['build', '--lib', '--profile', 'native/src/render-core-profile.json', '-o', archive],
      {cwd: source, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024});
    writeFileSync(resolve(directory, 'aot-build.log'), (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.error || result.status !== 0) throw result.error ?? Error('AOT build failed');
    writeFileSync(keyPath, aotKey);
  }
  const env = {...process.env, MUTRACER_AOT_ARCHIVE: archive,
    CARGO_TARGET_DIR: resolve(directory, 'host-target'), MUTRACER_REFERENCE_OUTPUT: resolve(output, 'native')};
  mkdirSync(env.MUTRACER_REFERENCE_OUTPUT, {recursive: true});
  // The same test harness must also compile on the unmodified reference commit.
  const testFile = resolve(source, 'native/host/src/display/effects_tests.rs');
  const original = readFileSync(testFile, 'utf8');
  try {
    writeFileSync(testFile, original + '\ninclude!(' + JSON.stringify(resolve(root, 'native/validation/reference-display.rs')) + ');\n');
    command('cargo', ['test', '--locked', '--manifest-path', 'native/host/Cargo.toml', '--lib',
      'reference_display_capture', '--', '--ignored', '--nocapture'], source, env, resolve(directory, 'native-display.log'));
  } finally {writeFileSync(testFile, original);}
  for (const [label, input] of [['synthetic', undefined], ...(fixturePath ? [['frozen', fixturePath]] : [])]) {
    const captureEnv = {...env, MUTRACER_TEST_CAPTURE: resolve(output, 'oidn-' + label)};
    delete captureEnv.MUTRACER_OIDN_DISPLAY_INPUT;
    if (input) captureEnv.MUTRACER_OIDN_DISPLAY_INPUT = input;
    const log = resolve(directory, 'oidn-' + label + '.log');
    command('cargo', ['test', '--locked', '--manifest-path', 'native/host/Cargo.toml', '--lib',
      'viewer_display_oidn_contains_firefly_spread_and_preserves_sdk_hdr', '--', '--ignored', '--nocapture'], source, captureEnv, log);

  }
  const manifest = {version: 1, inputs: fixtureKey(), seconds: (performance.now() - started) / 1000,
    files: Object.fromEntries(files(output).map(name => [name, sha256(readFileSync(resolve(output, name)))]))};
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export function compareFiles(reference, current) {
  const names = new Set([...files(reference), ...files(current)]);
  return [...names].sort().map(name => {
    const a = existsSync(resolve(reference, name)) ? readFileSync(resolve(reference, name)) : undefined;
    const b = existsSync(resolve(current, name)) ? readFileSync(resolve(current, name)) : undefined;
    if (!a || !b) return {file: name, identical: false, missing: a ? 'current' : 'reference'};
    const identical = a.equals(b);
    let firstDifferentOffset = null, maxDifference = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i] && firstDifferentOffset === null) firstDifferentOffset = i;
      maxDifference = Math.max(maxDifference, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    }
    if (name.endsWith('.f32') && a.length % 4 === 0 && b.length === a.length) {
      maxDifference = 0;
      for (let i = 0; i < a.length; i += 4) {
        const x = a.readFloatLE(i), y = b.readFloatLE(i);
        maxDifference = Math.max(maxDifference, Object.is(x, y) ? 0 : Math.abs(x - y) || Infinity);
      }
    }
    return {file: name, identical, referenceBytes: a.length, currentBytes: b.length,
      firstDifferentOffset, maxDifference: Number.isFinite(maxDifference) ? maxDifference : 'nonfinite'};
  });
}
async function main() {
  const [action, commit] = process.argv.slice(2);
  if (!['capture', 'compare'].includes(action) || !commit) throw Error('Usage: reference-capture.mjs capture|compare <commit>');
  const base = reference(commit);
  const manifestPath = resolve(base.directory, 'manifest.json');
  if (!existsSync(manifestPath)) await capture(base.source, base.directory);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(fixtureKey())) throw Error('Frozen inputs differ from cached reference; use the original inputs');
  if (action === 'capture') {console.log(`Reusing reference ${base.sha}: ${manifestPath}`); return;}
  const current = resolve(base.directory, 'current');
  await capture(root, current);
  const results = compareFiles(resolve(base.directory, 'output'), resolve(current, 'output'));
  const report = {reference: base.sha, passed: results.every(file => file.identical), results};
  writeFileSync(resolve(current, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
