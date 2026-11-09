import {expect, it} from 'vitest';
import {delimiter, resolve} from 'node:path';
import {cCompilerArgs, macosDeploymentTarget, nativeToolchainEnv, windows} from '../../native/scripts/platform.mjs';

it('preserves compiler discovery when a Windows Path environment is copied and extended', () => {
  const source = {Path: 'zig;gcc;node', KEEP: 'value'};
  const env = nativeToolchainEnv(source);
  if (windows) {
    expect(env.PATH).toBe(source.Path);
    expect(Object.keys(env).filter(key => key.toLowerCase() === 'path')).toEqual(['PATH']);
    env.PATH = 'release' + delimiter + env.PATH;
    expect(env.PATH).toContain(source.Path);
  } else expect(env).toEqual({...source, ...(process.platform === 'darwin'
    ? {MACOSX_DEPLOYMENT_TARGET: macosDeploymentTarget} : {})});
  expect(env.KEEP).toBe('value');
  expect(source).toEqual({Path: 'zig;gcc;node', KEEP: 'value'});
});

it('keeps the SDK C consumer optimized when translating its flags to MSVC', () => {
  const args = cCompilerArgs(['-O2', 'consumer.c', '-o', 'consumer.exe'], 'win32');
  expect(args).toContain('/O2');
  expect(args).not.toContain('-O2');
  expect(args).toContain('/MD');
});

it('puts the MSVC linker ahead of Git Bash while retaining the supplied toolchain path', () => {
  const source = {Path: 'git;zig;gcc', VCToolsInstallDir: resolve('vc')};
  const env = nativeToolchainEnv(source);
  if (windows) {
    const tools = resolve(source.VCToolsInstallDir, 'bin/Hostx64/x64');
    expect(env.PATH).toBe(tools + delimiter + source.Path);
    expect(env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER).toBe(resolve(tools, 'link.exe'));
  } else expect(env).toEqual({...source, ...(process.platform === 'darwin'
    ? {MACOSX_DEPLOYMENT_TARGET: macosDeploymentTarget} : {})});
});

it.skipIf(process.platform !== 'darwin')('pins native toolchain builds to the supported macOS minimum', () => {
  const source = {MACOSX_DEPLOYMENT_TARGET: '27.2', KEEP: 'value'};
  expect(nativeToolchainEnv(source)).toEqual({MACOSX_DEPLOYMENT_TARGET: '14.0', KEEP: 'value'});
  expect(source.MACOSX_DEPLOYMENT_TARGET).toBe('27.2');
});
