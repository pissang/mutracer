import {describe, expect, it} from 'vitest';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ciOptions} from '../../native/scripts/ci-options.mjs';
import {compareFiles} from '../../scripts/reference-capture.mjs';

describe('focused native validation', () => {
  it('keeps the default gate complete and rejects misspelled step selections', () => {
    const options = ciOptions([]);
    expect(options.subset).toBe(false);
    expect(options.enabled('raw-gpu-fixtures')).toBe(true);
    expect(() => ciOptions(['--only', 'host-test'])).toThrow('Unknown');
    expect(() => ciOptions(['--only'])).toThrow('requires a value');
    expect(() => ciOptions(['--gpu-tests', '['])).toThrow();
  });
  it('intersects only/skip and selects GPU names with an expression', () => {
    const options = ciOptions(['--only', 'host-tests,postprocess-shaders,metal-gpu-host', '--skip', 'postprocess-shaders',
      '--gpu-tests', 'display|jnlm', '--batch-gpu-tests']);
    expect(options.subset).toBe(true);
    expect(options.enabled('host-tests')).toBe(true);
    expect(options.enabled('metal-gpu-host')).toBe(true);
    expect(options.enabled('postprocess-shaders')).toBe(false);
    expect(options.enabled('raw-gpu-fixtures')).toBe(false);
    expect(options.gpuFilter!.test('display::jnlm::tests::capture')).toBe(true);
    expect(options.gpuFilter!.test('hardware_loop_against_fresh_l0_contexts')).toBe(false);
  });
});

it('compares the union of files, locating byte and f32 differences', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mutracer-reference-test-'));
  const base = join(directory, 'base'), current = join(directory, 'current');
  mkdirSync(base); mkdirSync(current);
  try {
    for (const path of [base, current]) writeFileSync(join(path, 'same'), 'same');
    writeFileSync(join(base, 'changed'), Buffer.from([1, 9]));
    writeFileSync(join(current, 'changed'), Buffer.from([1, 3]));
    writeFileSync(join(base, 'missing'), 'x');
    writeFileSync(join(current, 'extra'), 'y');
    writeFileSync(join(base, 'image.f32'), Buffer.from(new Float32Array([1, -2]).buffer));
    writeFileSync(join(current, 'image.f32'), Buffer.from(new Float32Array([1, 3]).buffer));
    const result = Object.fromEntries(compareFiles(base, current).map(row => [row.file, row]));
    expect(result.same.identical).toBe(true);
    expect(result.changed).toMatchObject({identical: false, firstDifferentOffset: 1, maxDifference: 6});
    expect(result['image.f32']).toMatchObject({identical: false, maxDifference: 5});
    expect(result.missing.missing).toBe('current');
    expect(result.extra.missing).toBe('reference');
  } finally {rmSync(directory, {recursive: true, force: true});}
});
