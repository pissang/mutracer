import {spawnNative as spawnSync, hostLibraryEnv} from '../scripts/platform.mjs';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
if (process.platform !== 'darwin') { console.log('Metal host requires macOS'); process.exit(0); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build/metal-host');
const target = resolve(process.env.CARGO_TARGET_DIR ?? '.native-build/scene-core/cargo-target');
mkdirSync(out, {recursive: true});
const env = hostLibraryEnv(target), executable = resolve(out, 'metal-host');
function run(name, command, args) {
  const r = spawnSync(command, args, {cwd: root, env, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024});
  writeFileSync(resolve(out, name + '.log'), (r.stdout ?? '') + (r.stderr ?? ''));
  if (r.error || r.status !== 0) throw Error(`${name} failed; see ${out}/${name}.log`);
  return r.stdout;
}
run('build', 'clang', ['-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-I', 'native/include', 'native/examples/metal-host.m', '-framework', 'Foundation', '-framework', 'Metal', '-L', resolve(target, 'release'), '-lmutracer', '-Wl,-rpath,' + resolve(target, 'release'), '-o', executable]);
const startedAt = new Date().toISOString(), results = [];
for (const backend of [0, 1]) {
  const mode = process.argv.includes('--gpu-timing') ? '--gpu-timing' : process.argv.includes('--bench') ? '--bench' : process.argv.includes('--shared') ? '--shared' : '--check';
  const text = run('backend-' + backend + mode, executable, [String(backend), mode]);
  if (!text.includes('PASS Metal GPU export')) throw Error('Missing Metal host success');
  const data = text.split('\n').filter(l => /^(BENCH|THROUGHPUT|GPU) /.test(l)).map(l => JSON.parse(l.slice(l.indexOf(' ') + 1)));
  results.push({backend, mode, passed: true, data});
}
writeFileSync(resolve(out, 'summary.json'), JSON.stringify({startedAt, finishedAt: new Date().toISOString(), validation: env.MTL_DEBUG_LAYER ?? 'default', results}, null, 2) + '\n');
console.log(`Metal host: Software/HWRT passed; ${out}/summary.json`);
