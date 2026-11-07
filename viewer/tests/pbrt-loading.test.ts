import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'fflate';
import { inspect, parseBytes, type Resolver } from '../../tools/pbrt/source';
import { buildScene } from '../../tools/pbrt/scene';
import { checkPbrtMemory, confirmPbrtImport } from '../src/engine/pbrtBudget';
import { useViewer } from '../src/store';
import { isModelFile } from '../src/engine/droppedFiles';
vi.hoisted(() => vi.stubGlobal('location', { search: '', hash: '' }));
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
    expect(checkPbrtMemory(report)).toBe(report.totalBytes * 8);
  });
  it('rejects unknown size and accepts the bounded small-scene path', () => {
    expect(() => checkPbrtMemory({ totalBytes: 20, unknownSizes: 1 })).toThrow('unknown');
    expect(() => checkPbrtMemory({ totalBytes: 1000, unknownSizes: 0 })).not.toThrow();
  });
  it('recognizes PBRT file and folder handoffs', () => { expect(isModelFile('scene.pbrt')).toBe(true); expect(isModelFile('scene.pbrt.gz')).toBe(true); expect(isModelFile('mesh.ply')).toBe(false); });
});

describe('PBRT import confirmation', () => {
  afterEach(() => useViewer.setState({ toast: null }));
  const report = (totalBytes: number) => ({ totalBytes, unknownSizes: 0 });
  it('allows a local scene above the estimate threshold after explicit confirmation', async () => {
    let accepted = false;
    const pending = confirmPbrtImport(report(3_132_955_097), false).then(() => { accepted = true; });
    await Promise.resolve();
    expect(accepted).toBe(false);
    const toast = useViewer.getState().toast!;
    expect(toast.message).toContain('23.3 GiB');
    expect(toast.message).not.toContain('download');
    expect(toast.actions![0].label).toBe('Load anyway');
    toast.actions![0].onClick();
    await pending;
    expect(accepted).toBe(true);
  });
  it('asks once for a remote scene above both thresholds', async () => {
    const pending = confirmPbrtImport(report(2e9), true);
    useViewer.getState().toast!.actions![0].onClick();
    await pending;
  });
  it('keeps the 1 GB download confirmation below the memory threshold', async () => {
    const pending = confirmPbrtImport(report(1e9), true);
    expect(useViewer.getState().toast!.message).toContain('downloads 1.00 GB');
    useViewer.getState().toast!.actions![0].onClick();
    await pending;
  });
  it('loads small scenes and local files below the memory threshold without a prompt', async () => {
    await confirmPbrtImport(report(1000), true);
    await confirmPbrtImport(report(1e9), false);
    expect(useViewer.getState().toast).toBeNull();
  });
  it.each(['cancel', 'dismiss', 'abort'])('stops before loading when the prompt is cancelled via %s', async action => {
    const controller = new AbortController();
    const pending = confirmPbrtImport(report(2e9), false, controller.signal);
    const rejected = expect(pending).rejects.toThrow('Scene loading cancelled');
    if (action === 'cancel') useViewer.getState().toast!.actions![1].onClick();
    if (action === 'dismiss') useViewer.setState({ toast: null });
    if (action === 'abort') controller.abort();
    await rejected;
  });
  it('rejects unknown sizes and already aborted imports before showing a prompt', async () => {
    await expect(confirmPbrtImport({ totalBytes: 0, unknownSizes: 1 }, true)).rejects.toThrow('unknown');
    await expect(confirmPbrtImport(report(2e9), false, AbortSignal.abort())).rejects.toThrow();
    expect(useViewer.getState().toast).toBeNull();
  });
});
