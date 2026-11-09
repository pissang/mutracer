import {existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {delimiter, resolve} from 'node:path';
import {executable, macosDeploymentTarget, nativeTar, windows} from './platform.mjs';

const excluded = /^(?:node|nodejs|npm|npx|cargo|rustc|rustup|scriptc)(?:\.(?:exe|cmd|bat|com))?$/i;

function findTool(name, env) {
  const extensions = windows ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const directory of env.PATH.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const path = resolve(directory, name + extension);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

// Node may share /usr/bin with make/cc on Linux, or /usr/local/bin with CMake
// on macOS. Mirror those directories without build-time SDK tools rather than
// assuming each tool has its own installation directory. Windows CI installs
// Node/Rust separately from the MSVC/Windows SDK tools, so no symlinks are needed.
export function consumerEnvironment(environment, directory) {
  const env = {...environment}, paths = [];
  for (const [index, original] of env.PATH.split(delimiter).filter(Boolean).entries()) {
    if (!existsSync(original)) continue;
    const files = readdirSync(original);
    if (!files.some(file => excluded.test(file))) {
      paths.push(original);
    } else if (!windows) {
      const mirror = resolve(directory, `path-${index}`);
      mkdirSync(mirror, {recursive: true});
      for (const file of files.filter(file => !excluded.test(file))) {
        symlinkSync(resolve(original, file), resolve(mirror, file));
      }
      paths.push(mirror);
    }
  }
  env.PATH = paths.join(delimiter);
  for (const key of Object.keys(env)) {
    if (/^(?:NODE|NPM|CARGO|RUST|MUTRACER|SCRIPTC|OIDN_WEBGPU)_/i.test(key)) delete env[key];
  }
  for (const name of ['node', 'nodejs', 'npm', 'npx', 'cargo', 'rustc', 'rustup', 'scriptc']) {
    if (findTool(name, env)) throw Error(`SDK consumer still has ${name} on PATH`);
  }
  return env;
}

export function checkCmakeConsumer({archive, name, work, env, run, abi, version}) {
  const directory = mkdtempSync(resolve(work, 'relocated-'));
  const extracted = resolve(directory, 'SDK with spaces');
  mkdirSync(extracted);
  if (process.platform === 'darwin') run('ditto', ['-x', '-k', archive, extracted]);
  else run(nativeTar, ['-xf', archive, '-C', extracted]);
  const prefix = resolve(extracted, name), source = resolve(directory, 'consumer');
  mkdirSync(source);
  writeFileSync(resolve(source, 'main.c'), `#include "mutracer-scene-api.h"
#include <stdio.h>
#include <string.h>
int main(void) {
  if (strcmp(MT_SDK_VERSION, "${version}") != 0) return 4;
  char error[1024] = {0};
  mt_scene scene = 0;
  if (mt_abi_version() != MT_ABI_VERSION || MT_ABI_VERSION != ${abi}u) return 1;
  if (mt_scene_create(&scene, error, sizeof error) != MT_OK) {
    fprintf(stderr, "%s\\n", error); return 2;
  }
  if (mt_scene_destroy(scene, error, sizeof error) != MT_OK) {
    fprintf(stderr, "%s\\n", error); return 3;
  }
  printf("ABI %u; scene create/destroy passed\\n", mt_abi_version());
  return 0;
}
`);
  writeFileSync(resolve(source, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.20)
project(MuTracerConsumer LANGUAGES C)
find_package(MuTracer ${version} EXACT CONFIG REQUIRED)
# Repeated discovery must keep both targets usable and expose the ABI variable.
find_package(MuTracer CONFIG REQUIRED)
if(NOT MuTracer_ABI_VERSION EQUAL ${abi})
  message(FATAL_ERROR "Wrong package ABI: \${MuTracer_ABI_VERSION}")
endif()
add_executable(consumer main.c)
target_link_libraries(consumer PRIVATE MuTracer::\${SDK_TARGET})
set_property(TARGET consumer PROPERTY MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
set_target_properties(consumer PROPERTIES RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "\${CMAKE_BINARY_DIR}/bin")
if(WIN32)
  file(GLOB runtime_libraries "${prefix.replaceAll('\\', '/')}/lib/*.dll")
  add_custom_command(TARGET consumer POST_BUILD
    COMMAND "\${CMAKE_COMMAND}" -E copy_if_different \${runtime_libraries} "$<TARGET_FILE_DIR:consumer>"
    VERBATIM)
endif()
`);
  const clean = consumerEnvironment(env, directory);
  const cmake = findTool('cmake', env);
  if (!cmake) throw Error('SDK packaging requires CMake 3.20 or later');
  writeFileSync(resolve(directory, 'environment.json'), JSON.stringify({PATH: clean.PATH,
    unavailable: ['node', 'npm', 'cargo', 'rustc', 'scriptc']}, null, 2) + '\n');
  const options = {env: clean, cwd: directory, raw: true};
  // CMake's gmake-first search can select an obsolete Homebrew installation on
  // macOS. Use the platform's make, or the make present in the clean PATH.
  const make = process.platform === 'darwin' ? '/usr/bin/make' : findTool('make', clean);
  for (const kind of ['shared', 'static']) {
    const build = resolve(directory, kind);
    run(cmake, ['-S', source, '-B', build, `-DCMAKE_PREFIX_PATH=${prefix}`,
      `-DSDK_TARGET=${kind === 'shared' ? 'mutracer' : 'mutracer_static'}`,
      '-DCMAKE_BUILD_TYPE=Release',
      ...(process.platform === 'darwin' ? [`-DCMAKE_OSX_DEPLOYMENT_TARGET=${macosDeploymentTarget}`] : []), '-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF',
      '-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF', ...(!windows ? ['-G', 'Unix Makefiles', `-DCMAKE_MAKE_PROGRAM=${make}`] : [])], options);
    run(cmake, ['--build', build, '--config', 'Release', '--verbose'], options);
    run(resolve(build, 'bin', executable('consumer')), [], options);
  }
  return directory;
}
