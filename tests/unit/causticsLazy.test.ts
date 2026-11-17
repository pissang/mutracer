import {afterEach, expect, it, vi} from 'vitest';
afterEach(() => {vi.doUnmock('../../src/renderer/WGPUCaustics.js'); vi.resetModules();});
it('waits for one module request before preparing caustic pipelines', async () => {
  let release!: (module: unknown) => void;
  vi.doMock('../../src/renderer/WGPUCaustics.js', () => new Promise(resolve => {release = resolve;}));
  const {default: Pass} = await import('../../src/renderer/WGPURayTracePass');
  const pass = Object.assign(Object.create(Pass.prototype), {_lightTracing: true, _photonMapping: false}) as any;
  const pending = pass.updatePipeline(); expect(pass.updatePipeline()).toBe(pending);
  expect(pass.isCompilingShader()).toBe(true);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release({}); await pending;
  expect(pass.isCompilingShader()).toBe(false);
});
it('reports a caustic chunk failure only for renders requesting caustics', async () => {
  vi.doMock('../../src/renderer/WGPUCaustics.js', () => {throw new Error('not found');});
  const {default: Pass} = await import('../../src/renderer/WGPURayTracePass');
  const pass = Object.assign(Object.create(Pass.prototype), {_lightTracing:true}) as any;
  await pass.updatePipeline();
  expect(pass.getPipelineError()?.message).toBe('Failed to load the WebGPU caustics renderer.');
  expect(pass.isCompilingShader()).toBe(false);
  pass._lightTracing = false; expect(pass.getPipelineError()).toBeUndefined();
});
