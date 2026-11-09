import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {expect, it} from 'vitest';
import {cmakeDependencies, sdkCmakeConfig, sdkVersion, sdkVersionHeader} from '../../native/scripts/sdk-cmake.mjs';

it('uses the native package version rather than a dependency version', () => {
  expect(sdkVersion('[package]\nname = "sdk"\nversion = "0.0.0"\n\n[dependencies]\nversion = "3.2.1"\n'))
    .toBe('0.0.0');
  expect(() => sdkVersion('[dependencies]\nversion = "3.2.1"\n')).toThrow();
});

it('refuses to export a non-relocatable native link argument', () => {
  expect(() => cmakeDependencies(['/build/private/lib.a'], 'linux')).toThrow('Non-relocatable');
  expect(() => cmakeDependencies(['-L/build/private'], 'linux')).toThrow('Non-relocatable');
  expect(() => cmakeDependencies(['-framework'], 'darwin')).toThrow('Invalid rustc framework');
});

// These configure-only tests check CMake semantics, not cross-platform linking.
it.each([
  {platform: 'darwin', shared: 'libmutracer.dylib', static_: 'libmutracer.a',
    libraries: ['-lc++', '-framework', 'Metal', '-lc++'], expected: '-lc++;FRAMEWORK;-lc++'},
  {platform: 'linux', shared: 'libmutracer.so', static_: 'libmutracer.a',
    libraries: ['-lgcc_s', '-lutil', '-lrt', '-lpthread', '-lm', '-ldl', '-lc'], expected: '-lgcc_s;-lutil;-lrt;-lpthread;-lm;-ldl;-lc'},
  {platform: 'win32', shared: 'mutracer.dll', static_: 'mutracer.lib',
    libraries: ['kernel32.lib', 'C:\\SDK path\\runtime.lib', 'kernel32.lib'], expected: 'kernel32.lib;runtime.lib;kernel32.lib'},
])('exposes relocatable imported targets for $platform', ({platform, shared, static_, libraries, expected}) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mutracer cmake '));
  try {
    const prefix = resolve(directory, 'moved SDK'), source = resolve(directory, 'consumer');
    const config = resolve(prefix, 'lib/cmake/MuTracer');
    mkdirSync(config, {recursive: true});
    mkdirSync(resolve(prefix, 'include'));
    mkdirSync(source);
    writeFileSync(resolve(config, 'MuTracerConfig.cmake'), sdkCmakeConfig({platform, version: '0.0.0', abi: 10, nativeLibraries: libraries}));
    const path = (part: string) => resolve(prefix, part).replaceAll('\\', '/');
    const framework = path('lib/fake Metal.framework');
    writeFileSync(resolve(source, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.20)
project(SdkContract LANGUAGES NONE)
set(_MuTracer_framework_Metal "${framework}")
find_package(MuTracer CONFIG REQUIRED)
find_package(MuTracer CONFIG REQUIRED)
function(check target property expected)
  get_target_property(actual \${target} \${property})
  if(NOT "\${actual}" STREQUAL "\${expected}")
    message(FATAL_ERROR "\${target} \${property}: \${actual} != \${expected}")
  endif()
endfunction()
check(MuTracer::mutracer TYPE SHARED_LIBRARY)
check(MuTracer::mutracer_static TYPE STATIC_LIBRARY)
check(MuTracer::mutracer IMPORTED_LOCATION "${path(`lib/${shared}`)}")
check(MuTracer::mutracer_static IMPORTED_LOCATION "${path(`lib/${static_}`)}")
check(MuTracer::mutracer INTERFACE_INCLUDE_DIRECTORIES "${path('include')}")
check(MuTracer::mutracer_static INTERFACE_INCLUDE_DIRECTORIES "${path('include')}")
check(MuTracer::mutracer_static INTERFACE_LINK_LIBRARIES "${expected.replace('FRAMEWORK', framework)}")
${platform === 'win32' ? `check(MuTracer::mutracer IMPORTED_IMPLIB "${path('lib/mutracer.dll.lib')}")` : ''}
if(NOT MuTracer_ABI_VERSION EQUAL 10 OR NOT MuTracer_VERSION STREQUAL "0.0.0")
  message(FATAL_ERROR "Incorrect SDK version/ABI")
endif()
`);
    execFileSync('cmake', ['-S', source, '-B', resolve(directory, 'build'), `-DCMAKE_PREFIX_PATH=${prefix}`], {stdio: 'pipe'});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

it('derives C package version macros from the native crate version', () => {
  const version = sdkVersion('[package]\nversion = "2.7.3"\n');
  const header = sdkVersionHeader(version);
  expect(header).toContain('#define MT_SDK_VERSION "2.7.3"');
  expect(header).toContain('#define MT_SDK_VERSION_MAJOR 2u');
  expect(header).toContain('#define MT_SDK_VERSION_MINOR 7u');
  expect(header).toContain('#define MT_SDK_VERSION_PATCH 3u');
});
