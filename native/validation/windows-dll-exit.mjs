// Exercise the real TinyBVH DLL/CRT teardown path without requiring a GPU.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT, 'windows-dll-exit');
const builds = resolve(process.env.CARGO_TARGET_DIR, 'release/build');
const includes = readdirSync(builds).filter(name => name.startsWith('mutracer-native-'))
  .map(name => resolve(builds, name, 'out/tinybvh'))
  .filter(path => existsSync(resolve(path, 'tiny_bvh_base.h')))
  .sort((a, b) => statSync(resolve(b, 'tiny_bvh_base.h')).mtimeMs - statSync(resolve(a, 'tiny_bvh_base.h')).mtimeMs);
if (!includes.length) throw new Error('Build the Windows native host before the DLL exit check');
if (!readFileSync(resolve(includes[0], 'tiny_bvh_base.h'), 'utf8').includes('if (!::mt_native_process_terminating())'))
  throw new Error('Rebuild the Windows host to update the TinyBVH process-exit hook');
mkdirSync(out, {recursive:true});
const compiler = process.env.CXX ?? 'cl.exe';
const dll = resolve(out, 'tinybvh-exit.dll'), library = resolve(out, 'tinybvh-exit.lib');
const binary = resolve(out, 'tinybvh-thread-exit.exe');
function run(name, command, args, timeout = 120000) {
  const result = spawnSync(command, args, {cwd:root, encoding:'utf8', timeout, maxBuffer:4 * 1024 * 1024});
  writeFileSync(resolve(out, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${name} failed: ${result.status}`);
}
const flags = ['/nologo','/std:c++20','/MD','/EHsc','/O1','/fp:strict'];
run('dll-build', compiler, [...flags, '/LD', '/I'+includes[0], 'native/tests/tinybvh-exit-dll.cpp',
  '/Fo'+resolve(out,'tinybvh-exit.obj'), '/Fe'+dll, '/link', '/IMPLIB:'+library, 'ntdll.lib']);
run('host-build', compiler, [...flags, 'native/tests/tinybvh-thread-exit.cpp', library,
  '/Fo'+resolve(out,'thread-exit.obj'), '/Fe'+binary]);
// The fixture joins its calling thread, explicitly shuts down/restarts the pool
// twice, and leaves the final pool for DLL process detach. A hang is a failure.
run('process-exit', binary, [], 30000);
writeFileSync(resolve(out, 'summary.json'), JSON.stringify({passed:true, rounds:3, explicitShutdowns:2, dllProcessExit:true}, null, 2) + '\n');
console.log('PASS TinyBVH DLL worker lifetime, shutdown/restart and process exit');
