import { describe, expect, it } from 'vitest';
import { parse, tokenize } from '../../tools/pbrt/parser';
import { inspect, resolvePath, walk, type Resolver } from '../../tools/pbrt/source';
const source = (files: Record<string, string>): Resolver => ({ async read(path) { if (!(path in files)) throw new Error(`Missing ${path}`); return new TextEncoder().encode(files[path]).buffer; }, async size() { return 10; } });

describe('PBRT grammar', () => {
  it('parses multiline parameters, scientific numbers, escaped strings and comments', () => {
    const [s] = [...parse('# h\nShape "trianglemesh"\n "point3 P" [0 0 0 1e-2 0 0 .5 +1 -2] "integer indices" [0 1 2] "bool test" true "string label" "a\\\"b"', 'test.pbrt')];
    expect(s.line).toBe(2); expect(s.params.P.values).toEqual([0, 0, 0, .01, 0, 0, .5, 1, -2]);
    expect(s.params.test.values).toEqual([true]); expect(s.params.label.values).toEqual(['a"b']);
  });
  it('keeps punctuation and comments in strings', () => { expect([...tokenize('"a#[]b"')][0].value).toBe('a#[]b'); });
  it('reads matrices and following statements', () => {
    expect([...parse('Transform [1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1]\nWorldBegin')].map(s => s.kind)).toEqual(['Transform', 'WorldBegin']);
  });
  it.each(['Shape "sphere" "float radius" [1', 'Translate 1 nope 3', 'Shape "sphere" "integer n" 1.5', 'Camera "perspective" "bool test" 2', 'Shape "sphere" "texture Kd" 2'])('rejects malformed input with file and line (%s)', (text) => {
    expect(() => [...parse(`\n${text}`, 'broken.pbrt')]).toThrow(/broken.pbrt:2:/);
  });
  it('rejects unterminated strings and unknown statements', () => {
    expect(() => [...parse('Shape "sphere')]).toThrow('Unterminated string');
    expect(() => [...parse('Bogus')]).toThrow('Unknown statement');
  });
});

describe('PBRT file resolution and inspection', () => {
  it('normalizes paths using the main scene search directory', () => {
    expect(resolvePath('../maps/a.exr', '/scenes/a/main.pbrt')).toBe('/scenes/maps/a.exr');
    expect(resolvePath('mesh.ply', 'folder/main.pbrt')).toBe('folder/mesh.ply');
    expect(resolvePath('../x.ply', 'https://host/a/main.pbrt')).toBe('https://host/x.ply');
    expect(resolvePath('maps/a #1.png', 'https://host/a/main.pbrt')).toBe('https://host/a/maps/a%20%231.png');
    expect(resolvePath('../../a.ply', '/main.pbrt')).toBe('/a.ply');
  });
  it('inlines Include and brackets Import state, retaining file locations', async () => {
    const files = source({ 'a/main.pbrt': 'Include "sub/a.pbrt" Import "b.pbrt"', 'a/sub/a.pbrt': 'Include "b.pbrt"', 'a/b.pbrt': 'Shape "sphere"' });
    const statements = []; for await (const s of walk('a/main.pbrt', files)) statements.push(s);
    expect(statements.map(s => s.kind)).toEqual(['Include', 'Include', 'Shape', 'Import', 'Shape', 'ImportEnd']);
    expect(statements[2].file).toBe('a/b.pbrt');
  });
  it('rejects include cycles', async () => {
    await expect(inspect('a.pbrt', source({ 'a.pbrt': 'Include "a.pbrt"' }))).rejects.toThrow('Cyclic');
  });
  it('inventories unique dependencies without downloading binaries or treating outputs as inputs', async () => {
    const report = await inspect('main.pbrt', source({ 'main.pbrt': 'Film "rgb" "string filename" "out.exr"\nShape "plymesh" "string filename" "mesh.ply"\nShape "plymesh" "string filename" "mesh.ply"\nMakeNamedMaterial "gold" "string type" "conductor"' }));
    expect(report.resources.map(r => r.path)).toEqual(['main.pbrt', 'mesh.ply']);
    expect(report.features.materials).toEqual({ conductor: 1 });
    expect(report.unknownSizes).toBe(0);
  });
});
