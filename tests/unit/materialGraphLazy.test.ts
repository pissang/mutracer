import {afterEach, expect, it, vi} from 'vitest';
import * as runtime from '../../src/renderer/materialGraph/runtime';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import MaterialGraph from '../../src/scene/MaterialGraph';

afterEach(() => {vi.doUnmock('../../src/renderer/materialGraph/runtime.js'); vi.resetModules();});
const material = () => new OpenPBRMaterial({graph: new MaterialGraph({
  nodes: [{id: 'value', category: 'constant', type: 'color3', inputs: {value: {type: 'color3', value: [.2,.7,.1]}}}],
  terminal: {baseColor: {node: 'value'}}
})});

it('loads only for a graph, preserves constants while loading and installs the latest request without a new revision', async () => {
  let release!: (value: typeof runtime) => void;
  const gate = new Promise<typeof runtime>(resolve => release = resolve);
  const load = vi.fn(() => gate); vi.doMock('../../src/renderer/materialGraph/runtime.js', load);
  const {createMaterialGraphState, loadMaterialGraphRuntime} = await import('../../src/renderer/materialGraph/lazy');
  const ready = vi.fn(), state = createMaterialGraphState(ready);
  state.request([new OpenPBRMaterial()]);
  expect(load).not.toHaveBeenCalled(); expect(state.status).toBe('idle');
  const first = material(); state.request([first]);
  expect(state.status).toBe('compiling');
  expect(state.renderMaterials([first])).toEqual([first]);
  const buffer = new Float32Array([1,2,3]); expect(state.pack(buffer, [])).toBe(buffer);
  const latest = material(); state.request([latest]); const revision = state.revision;
  release(runtime); await loadMaterialGraphRuntime(); await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(state.revision).toBe(revision);
  expect(state.status).toBe('compiling');
  expect(state.requested.materials?.[0]).toBe(latest);
  state.install(state.requested, state.revision);
  expect(state.status).toBe('ready');
  expect(state.installedRevision).toBe(revision);
});
it('reports a rejected chunk and leaves repeated polling in failed state', async () => {
  vi.doMock('../../src/renderer/materialGraph/runtime.js', () => {throw new Error('chunk unavailable');});
  const {createMaterialGraphState} = await import('../../src/renderer/materialGraph/lazy');
  const state = createMaterialGraphState(), source = material(); state.request([source]);
  await vi.waitFor(() => expect(state.status).toBe('failed'));
  expect(state.diagnosticsState.diagnostics[0]).toMatchObject({code:'shader-compilation', message:'Failed to load Material Graph compiler/runtime.'});
  state.request([source]); expect(state.status).toBe('failed');
});
