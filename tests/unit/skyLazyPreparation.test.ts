import {afterEach, expect, it, vi} from 'vitest';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass';

afterEach(() => {vi.doUnmock('../../src/renderer/WGPUSkyBaker.js'); vi.resetModules();});
function fixture() {
  return Object.assign(Object.create(WGPURayTracePass.prototype), {_skyTasks: new Map(), _disposed: false, _device: {}}) as any;
}
it('bakes only the latest committed sky after the module loads', async () => {
  let release!: (module: unknown) => void;
  vi.doMock('../../src/renderer/WGPUSkyBaker.js', () => new Promise(resolve => {release = resolve;}));
  const pass = fixture(), source = {sky:{}}, latest = {sky:{}}, texture = {}, output = {};
  pass._backgroundImageSource = source; pass._backgroundTex = texture;
  pass._bakeSky('background', source, texture);
  pass._backgroundImageSource = latest; pass._backgroundTex = output;
  pass._bakeSky('background', latest, output);
  const bake = vi.fn();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release({WGPUSkyBaker: class {bake = bake;}});
  await pass._skyLoading;
  expect(bake).toHaveBeenCalledOnce();
  expect(bake).toHaveBeenCalledWith(latest, output);
  expect(pass._skyTasks.size).toBe(0);
});
it('does not allocate a baker after disposal during loading', async () => {
  let release!: (module: unknown) => void;
  vi.doMock('../../src/renderer/WGPUSkyBaker.js', () => new Promise(resolve => {release = resolve;}));
  const pass = fixture(); pass._bakeSky('background', {sky:{}}, {}); pass._disposed = true;
  const create = vi.fn(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release({WGPUSkyBaker: class {constructor() {create();}}}); await pass._skyLoading;
  expect(create).not.toHaveBeenCalled();
});
it('reports a sky chunk failure through pipeline diagnostics', async () => {
  vi.doMock('../../src/renderer/WGPUSkyBaker.js', () => {throw new Error('not found');});
  const pass = fixture(); pass._bakeSky('background', {sky:{}}, {}); await pass._skyLoading;
  expect(pass.getPipelineError()?.message).toBe('Failed to load or prepare the WebGPU procedural sky.');
  expect(pass.isCompilingShader()).toBe(false);
});
