import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {expect, it} from 'vitest';
import {checkArchiveEntries} from '../../native/scripts/sdk-archive.mjs';

it('rejects AppleDouble entries anywhere in the archive', () => {
  expect(checkArchiveEntries('SDK/lib/libmutracer.a\nSDK/include/mutracer-status.h\n')).toHaveLength(2);
  for (const entry of ['SDK/._LICENSE', '__MACOSX/SDK/LICENSE', 'SDK/lib/__MACOSX/file', 'SDK\\lib\\._file'])
    expect(() => checkArchiveEntries(entry)).toThrow('AppleDouble');
  expect(() => checkArchiveEntries('')).toThrow('empty');
});

it.skipIf(process.platform !== 'darwin')('does not archive resource forks or extended attributes', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mutracer archive '));
  try {
    const stage = resolve(directory, 'SDK'), archive = resolve(directory, 'SDK.zip');
    mkdirSync(stage);
    writeFileSync(resolve(stage, 'LICENSE'), 'license');
    execFileSync('xattr', ['-w', 'com.mutracer.test', 'metadata', resolve(stage, 'LICENSE')]);
    execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', stage, archive]);
    expect(checkArchiveEntries(execFileSync('tar', ['-tf', archive], {encoding: 'utf8'})))
      .toContain('SDK/LICENSE');
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

it.each([
  {platform: 'macos-arm64', libraries: ['libhdMuTracer.dylib', 'libmutracer.dylib']},
  {platform: 'windows-x64', libraries: ['hdMuTracer.dll', 'mutracer.dll']},
])('packages $platform Blender libraries and rejects contaminated zips', ({platform, libraries}) => {
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const directory = mkdtempSync(resolve(tmpdir(), 'mutracer blender '));
  try {
    const plugin = resolve(directory, 'plugin'), archive = resolve(directory, 'addon.zip');
    for (const file of [...libraries, 'resources/plugInfo.json',
      '__MACOSX/hidden', 'resources/._plugInfo.json']) {
      const path = resolve(plugin, 'hdMuTracer', file);
      mkdirSync(resolve(path, '..'), {recursive: true});
      writeFileSync(path, 'fixture');
    }
    execFileSync(python, ['native/integrations/blender/package.py', plugin, archive, '--platform', platform]);
    const listing = execFileSync(python, ['-c',
      'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', archive], {encoding: 'utf8'});
    expect(checkArchiveEntries(listing)).toContain(`mutracer_blender/plugin/hdMuTracer/${libraries[1]}`);
    const result = execFileSync(python, ['-c', `import runpy,zipfile,sys
check = runpy.run_path('native/integrations/blender/package.py')['check_archive']
with zipfile.ZipFile(sys.argv[1], 'a') as archive: archive.writestr('__MACOSX/._file', b'bad')
try: check(sys.argv[1])
except ValueError: print('rejected')
else: raise AssertionError('metadata accepted')`, archive], {encoding: 'utf8'});
    expect(result.trim()).toBe('rejected');
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
