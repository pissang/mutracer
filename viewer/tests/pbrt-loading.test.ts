import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { inspect, parseBytes, type Resolver } from '../../tools/pbrt/source';
import { buildScene } from '../../tools/pbrt/scene';
import { checkPbrtMemory } from '../src/engine/pbrtBudget';
import { isModelFile } from '../src/engine/droppedFiles';
const buffer = (text: string) => new TextEncoder().encode(text).buffer;
describe('PBRT import bounds and compressed sources', () => {
  it('streams gzip statements across decoder chunks without splitting strings, arrays or ActiveTransform values', async () => {
    const text = '# '+ 'x'.repeat(100000) + '\nWorldBegin\nActiveTransform StartTime\nShape "sphere" "string label" "Include # [ WorldBegin ]"\n';
    const compressed = gzipSync(new TextEncoder().encode(text)); const statements = [];
    for await (const statement of parseBytes(compressed.buffer as ArrayBuffer, 'test.pbrt.gz')) statements.push(statement);
    expect(statements.map(s => s.kind)).toEqual(['WorldBegin', 'ActiveTransform', 'Shape']); expect(statements[2].line).toBe(4);
    expect(statements[2].params.label.values).toEqual(['Include # [ WorldBegin ]']);
  });
  it('skips curves before retaining the IR and counts every occurrence', async () => {
    const scene = await buildScene('main.pbrt', { read: async () => buffer('WorldBegin\nShape "curve"\nShape "curve"\nShape "sphere"') });
    expect(scene.shapes).toHaveLength(1); expect(scene.warnings[0]).toMatchObject({ line: 2, lastLine: 3, count: 2, code: 'shape' });
  });
  it('does not fetch binary resources while preflighting and reports feature coverage', async () => {
    const requests: string[] = [];
    const resolver: Resolver = { async read(path) { requests.push(path); return buffer('WorldBegin Shape "curve" Shape "plymesh" "string filename" "a.ply"'); }, async size() { return 2e9; } };
    const report = await inspect('main.pbrt', resolver);
    expect(requests).toEqual(['main.pbrt']); expect(report.coverage.shapes).toEqual({ curve: 'skipped', plymesh: 'supported' });
    expect(() => checkPbrtMemory(report)).toThrow('No binary assets were downloaded');
  });
  it('rejects unknown size and accepts the bounded small-scene path', () => {
    expect(() => checkPbrtMemory({ totalBytes: 20, unknownSizes: 1 })).toThrow('unknown');
    expect(() => checkPbrtMemory({ totalBytes: 1000, unknownSizes: 0 })).not.toThrow();
  });
  it('recognizes PBRT file and folder handoffs', () => { expect(isModelFile('scene.pbrt')).toBe(true); expect(isModelFile('scene.pbrt.gz')).toBe(true); expect(isModelFile('mesh.ply')).toBe(false); });
});
