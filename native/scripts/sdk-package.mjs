// Stage SDK artifacts separately from Cargo outputs. Relinking the release
// staticlib gives every platform one authoritative export list, without Rust's
// cdylib exports also exposing dependency #[no_mangle] functions.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {archiveName, cCompiler, executable, nativeTar, nativeToolchainEnv, spawnNative, viewerPlatform, windows} from './platform.mjs';
import {checkSdkExports, nativeLinkArguments, publicApiSymbols} from './sdk-symbols.mjs';
import {bundleWindowsRuntime} from './windows-redist.mjs';
import {prepareDxc} from './fetch-dxc.mjs';
import {finalizeHostLibrary} from './finalize-host-library.mjs';
import {sdkCmakeConfig, sdkVersion} from './sdk-cmake.mjs';
import {checkCmakeConsumer} from './sdk-cmake-consumer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build/scene-core');
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(out, 'cargo-target'));
const dist = resolve(process.env.MUTRACER_NATIVE_DIST ?? resolve(out, 'dist'));
const platform = viewerPlatform(), mac = process.platform === 'darwin';
const work = resolve(out, 'sdk'), name = `MuTracer-SDK-${platform}`;
const stage = resolve(work, name), lib = resolve(stage, 'lib');
const symbols = resolve(work, `${name}-symbols`);
const env = nativeToolchainEnv({...process.env, CARGO_TARGET_DIR: target,
  MUTRACER_AOT_ARCHIVE: resolve(process.env.MUTRACER_AOT_ARCHIVE ?? resolve(out, archiveName('render-core')))});
mkdirSync(work, {recursive: true});
let log = '';
function run(command, args, {cwd = root, env: commandEnv = env, raw = false} = {}) {
  const result = (raw ? spawnSync : spawnNative)(command, args,
    {cwd, env: commandEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  log += `${JSON.stringify([command, ...args])}\n${result.stdout ?? ''}${result.stderr ?? ''}\n`;
  writeFileSync(resolve(work, 'package.log'), log);
  if (result.error || result.status !== 0) throw result.error ?? Error(`${command} failed; see ${work}/package.log`);
  return (result.stdout ?? '') + (result.stderr ?? '');
}

// Query rustc instead of duplicating its platform/system library dependencies.
// This uses the ordinary release profile and all default features; no size
// optimization, panic-policy or codegen changes are made by packaging.
const nativeLibraries = nativeLinkArguments(run('cargo', ['rustc', '--release', '--locked', '--lib',
  '--manifest-path', 'native/host/Cargo.toml', '--', '--print', 'native-static-libs']));
// The query can relink Cargo's cdylib too; preserve the ordinary development
// artifact's corrected install name/SONAME for subsequent C consumers.
finalizeHostLibrary(target);
const headers = readdirSync(resolve(root, 'native/include')).filter(file => file.endsWith('.h')).sort();
const exports = publicApiSymbols(headers.map(file => readFileSync(resolve(root, 'native/include', file), 'utf8')));
const abi = Number(/#define\s+MT_ABI_VERSION\s+(\d+)/.exec(readFileSync(resolve(root, 'native/include/mutracer-status.h'), 'utf8'))?.[1]);
if (!abi) throw Error('Missing C ABI version');
const version = sdkVersion(readFileSync(resolve(root, 'native/host/Cargo.toml'), 'utf8'));
const staticName = windows ? 'mutracer.lib' : 'libmutracer.a';
const sharedName = windows ? 'mutracer.dll' : `libmutracer.${mac ? 'dylib' : 'so'}`;
const sourceStatic = resolve(target, 'release', staticName), shared = resolve(lib, sharedName);
for (const directory of [stage, symbols]) {
  rmSync(directory, {recursive: true, force: true});
  mkdirSync(directory, {recursive: true});
}
mkdirSync(lib, {recursive: true});
cpSync(resolve(root, 'native/include'), resolve(stage, 'include'), {recursive: true});
copyFileSync(sourceStatic, resolve(lib, staticName));
// Keep the staticlib byte-for-byte intact. Apple's strip also rewrites LLVM
// symbol suffixes in archive members, which can introduce duplicate definitions
// at the consumer's final link, even with only -S. Never strip a link input.
writeFileSync(resolve(lib, 'native-static-libs.json'), JSON.stringify(nativeLibraries, null, 2) + '\n');
const cmake = resolve(lib, 'cmake/MuTracer');
mkdirSync(cmake, {recursive: true});
writeFileSync(resolve(cmake, 'MuTracerConfig.cmake'), sdkCmakeConfig({platform: process.platform, version, abi, nativeLibraries}));
const versionScript = resolve(work, 'cmake-version.cmake');
writeFileSync(versionScript, `cmake_minimum_required(VERSION 3.20)
include(CMakePackageConfigHelpers)
set(CMAKE_SIZEOF_VOID_P 8)
write_basic_package_version_file("${resolve(cmake, 'MuTracerConfigVersion.cmake').replaceAll('\\', '/')}"
  VERSION "${version}" COMPATIBILITY ExactVersion)
`);
run('cmake', ['-P', versionScript]);

if (mac) {
  const list = resolve(work, 'exports.macos');
  writeFileSync(list, exports.map(symbol => '_' + symbol).join('\n') + '\n');
  run(cCompiler, ['-dynamiclib', `-Wl,-force_load,${sourceStatic}`, `-Wl,-exported_symbols_list,${list}`,
    `-Wl,-install_name,@rpath/${sharedName}`, '-Wl,-dead_strip', ...nativeLibraries, '-o', shared]);
  run('dsymutil', [shared, '-o', resolve(symbols, `${sharedName}.dSYM`)]);
  run('strip', ['-S', '-x', shared]);
  run('codesign', ['--force', '--sign', '-', shared]);
  run('codesign', ['--verify', '--strict', shared]);
} else if (windows) {
  const definition = resolve(work, 'exports.def');
  writeFileSync(definition, `LIBRARY mutracer\nEXPORTS\n${exports.join('\n')}\n`);
  run('link.exe', ['/NOLOGO', '/DLL', '/INCREMENTAL:NO', '/OPT:REF', '/DEBUG:FULL',
    // The .def exports are linker roots and select every public API member.
    // /WHOLEARCHIVE also forces unused Rust support/import objects, which MSVC
    // can reject as a corrupt library (LNK1127) on an otherwise usable staticlib.
    `/DEF:${definition}`, sourceStatic, `/OUT:${shared}`,
    `/IMPLIB:${resolve(lib, 'mutracer.dll.lib')}`,
    `/PDB:${resolve(symbols, 'mutracer.pdb')}`, ...nativeLibraries]);
  // MSVC puts linked debug data in the separate PDB, not the shipped DLL.
} else {
  const version = resolve(work, 'exports.elf');
  writeFileSync(version, `{ global:\n${exports.map(symbol => `  ${symbol};`).join('\n')}\nlocal: *;\n};\n`);
  run(cCompiler, ['-shared', '-Wl,--whole-archive', sourceStatic, '-Wl,--no-whole-archive',
    `-Wl,--version-script=${version}`, `-Wl,-soname,${sharedName}`, '-Wl,--gc-sections',
    '-Wl,-z,defs', ...nativeLibraries, '-o', shared]);
  const debug = resolve(symbols, `${sharedName}.debug`);
  run('objcopy', ['--only-keep-debug', shared, debug]);
  run('strip', ['--strip-unneeded', shared]);
  run('objcopy', [`--add-gnu-debuglink=${debug}`, shared]);
}

const actual = mac ? run('nm', ['-gjU', shared]).trim().split(/\r?\n/).map(symbol => symbol.slice(1))
  : windows ? [...run('dumpbin.exe', ['/NOLOGO', '/EXPORTS', shared])
    .matchAll(/^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)/gim)].map(match => match[1])
    : run('nm', ['-D', '--defined-only', '--format=posix', shared]).trim().split(/\r?\n/).map(line => line.split(/\s+/)[0]);
checkSdkExports(exports, actual);

const licenses = resolve(stage, 'licenses');
for (const component of ['', 'native']) {
  const destination = resolve(licenses, component);
  mkdirSync(destination, {recursive: true});
  cpSync(resolve(root, component, 'LICENSES'), resolve(destination, 'LICENSES'), {recursive: true});
  copyFileSync(resolve(root, component, 'THIRD_PARTY_NOTICES.md'), resolve(destination, 'THIRD_PARTY_NOTICES.md'));
}
copyFileSync(resolve(root, 'LICENSE'), resolve(stage, 'LICENSE'));
if (windows) {
  bundleWindowsRuntime(lib, licenses, env);
  const dxc = prepareDxc(), notices = resolve(licenses, 'DXC');
  mkdirSync(notices, {recursive: true});
  for (const file of ['dxcompiler.dll', 'dxil.dll']) copyFileSync(resolve(dxc, 'bin/x64', file), resolve(lib, file));
  for (const file of ['LICENSE-LLVM.txt', 'LICENSE-MS.txt', 'LICENSE-MIT.txt']) copyFileSync(resolve(dxc, file), resolve(notices, file));
}

// The consumer has a relocation for every declared API, including platform
// stubs. Build and execute it against both staged libraries, with no GPU needed.
const consumer = resolve(work, 'consumer.c');
writeFileSync(consumer, `#include <stdint.h>\n#include <stdio.h>\n` +
  exports.filter(symbol => symbol !== 'mt_abi_version').map(symbol => `extern void ${symbol}(void);`).join('\n') +
  `\nextern uint32_t mt_abi_version(void);\nstatic void (*volatile api[])(void) = {\n` +
  exports.map(symbol => `  (void (*)(void))${symbol},`).join('\n') +
  `\n};\nint main(void) {\n  for (unsigned i = 0; i < sizeof api / sizeof api[0]; ++i) if (!api[i]) return 1;\n` +
  `  printf("%u C API symbols, ABI %u\\n", (unsigned)(sizeof api / sizeof api[0]), mt_abi_version());\n  return mt_abi_version() == ${abi} ? 0 : 1;\n}\n`);
for (const kind of ['shared', 'static']) {
  const binary = resolve(lib, executable(`sdk-${kind}-check`));
  const link = kind === 'static' ? [resolve(lib, staticName), ...nativeLibraries]
    : windows ? [resolve(lib, 'mutracer.dll.lib')]
      : ['-L', lib, '-lmutracer', mac ? '-Wl,-rpath,@loader_path' : '-Wl,-rpath,$ORIGIN'];
  run(cCompiler, ['-O2', consumer, ...link, '-o', binary]);
  run(binary, []);
  rmSync(binary);
  // cl emits the object alongside /Fe; it is validation material, not SDK data.
  if (windows) rmSync(resolve(lib, 'consumer.obj'), {force: true});
}
const summary = {platform, version, abi, exports, nativeLibraries,
  staticBytes: statSync(resolve(lib, staticName)).size, sharedBytes: statSync(shared).size,
  validated: {exports: true, staticConsumer: true, sharedConsumer: true, staticArchiveUnmodified: true}};
if (!readFileSync(sourceStatic).equals(readFileSync(resolve(lib, staticName)))) throw Error('Static SDK archive was modified');
mkdirSync(dist, {recursive: true});
function archive(directory, destination) {
  const extension = platform === 'linux-x64' ? 'tar.gz' : 'zip';
  const filename = `${directory}.${extension}`, path = resolve(destination, filename);
  mkdirSync(destination, {recursive: true});
  // Replace rather than update: zip updates otherwise retain removed entries.
  rmSync(path, {force: true});
  if (mac) run('ditto', ['-c', '-k', '--keepParent', resolve(work, directory), path]);
  else run(nativeTar, [windows ? '-acf' : '-czf', path, '-C', work, directory]);
  writeFileSync(path + '.sha256', `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${filename}\n`);
  return path;
}
const sdkArchive = archive(name, dist);
// Hide the staged SDK so an accidental absolute path cannot pass relocation.
const hidden = stage + '-unavailable';
renameSync(stage, hidden);
try {
  summary.cmakeConsumerDirectory = checkCmakeConsumer({archive: sdkArchive, name, work, env, run, abi, version});
  Object.assign(summary.validated, {relocatedCmakeShared: true, relocatedCmakeStatic: true, withoutSdkBuildTools: true});
} finally {
  renameSync(hidden, stage);
}
writeFileSync(resolve(work, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
archive(`${name}-symbols`, resolve(out, 'sdk-symbols'));
console.log(`Native SDK: ${dist}\n${summary.exports.length} public C exports; C and relocated CMake shared/static consumers passed`);
