import {basename} from 'node:path';

// Only the native crate versions this SDK; package.json versions the web library.
export function sdkVersion(manifest) {
  const section = /^\[package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(manifest)?.[1];
  const version = /^version\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(section ?? '')?.[1];
  if (!version) throw Error('Expected a numeric native SDK crate version');
  return version;
}

function quoted(value) {
  return `"${value.replaceAll('\\', '/').replaceAll('$', '\\$').replaceAll('"', '\\"').replaceAll(';', '\\;')}"`;
}

// Resolve system frameworks on the consumer's machine. In particular, never
// export SDK/toolchain paths from the machine that ran rustc.
export function cmakeDependencies(arguments_, platform) {
  const libraries = [], setup = [];
  for (let i = 0; i < arguments_.length; ++i) {
    const value = arguments_[i];
    if (value === '-framework') {
      const name = arguments_[++i];
      if (!/^[A-Za-z0-9_]+$/.test(name ?? '')) throw Error('Invalid rustc framework');
      const variable = `_MuTracer_framework_${name}`;
      setup.push(`find_library(${variable} NAMES ${name} REQUIRED)`);
      libraries.push(`"\${${variable}}"`);
    } else if (platform === 'win32' && /\.lib$/i.test(value)) {
      libraries.push(quoted(basename(value.replaceAll('\\', '/'))));
    } else if (/^-l[\w+.-]+$/.test(value) || value === '-pthread') {
      libraries.push(quoted(value));
    } else {
      throw Error(`Non-relocatable or unsupported native SDK link argument: ${value}`);
    }
  }
  return {setup: [...new Set(setup)].join('\n'), libraries: libraries.join('\n    ')};
}

export function sdkCmakeConfig({platform, version, abi, nativeLibraries}) {
  const windows = platform === 'win32', mac = platform === 'darwin';
  const shared = windows ? 'mutracer.dll' : `libmutracer.${mac ? 'dylib' : 'so'}`;
  const static_ = windows ? 'mutracer.lib' : 'libmutracer.a';
  const dependencies = cmakeDependencies(nativeLibraries, platform);
  return `# Generated for the precompiled SDK. All package paths follow this file.
cmake_minimum_required(VERSION 3.20)
get_filename_component(_MuTracer_prefix "\${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
set(MuTracer_VERSION "${version}")
set(MuTracer_ABI_VERSION ${abi})

if(NOT TARGET MuTracer::mutracer)
  add_library(MuTracer::mutracer SHARED IMPORTED)
  set_target_properties(MuTracer::mutracer PROPERTIES
    IMPORTED_LOCATION "\${_MuTracer_prefix}/lib/${shared}"
${windows ? '    IMPORTED_IMPLIB "${_MuTracer_prefix}/lib/mutracer.dll.lib"\n' : ''}    INTERFACE_INCLUDE_DIRECTORIES "\${_MuTracer_prefix}/include")
endif()

if(NOT TARGET MuTracer::mutracer_static)
  ${dependencies.setup.replaceAll('\n', '\n  ')}
  add_library(MuTracer::mutracer_static STATIC IMPORTED)
  set_target_properties(MuTracer::mutracer_static PROPERTIES
    IMPORTED_LOCATION "\${_MuTracer_prefix}/lib/${static_}"
    INTERFACE_INCLUDE_DIRECTORIES "\${_MuTracer_prefix}/include")
  set_property(TARGET MuTracer::mutracer_static PROPERTY INTERFACE_LINK_LIBRARIES
    ${dependencies.libraries})
endif()
unset(_MuTracer_prefix)
`;
}

