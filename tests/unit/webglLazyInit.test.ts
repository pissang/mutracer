import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => {vi.doUnmock('../../src/renderer/webgl.js'); vi.resetModules(); vi.restoreAllMocks();});
it('reports a WebGL chunk load failure through initialization and engine diagnostics', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.doMock('../../src/renderer/webgl.js', () => {throw new Error('WebGL chunk unavailable');});
  const {default: Engine} = await import('../../src/Engine.js');
  const engine = new Engine({backend: 'webgl', canvas: Object.assign(new EventTarget(), {width: 1, height: 1}) as HTMLCanvasElement});
  const errors = vi.fn(); engine.on('error', errors);
  const failure = await engine.init().catch(error => error);
  // Vitest wraps an import factory rejection; the original cause remains intact.
  expect(failure).toMatchObject({cause: {message: 'WebGL chunk unavailable'}});
  expect(engine.lastError).toBe(failure);
  expect(errors).toHaveBeenCalledWith(failure);
  expect(errors).toHaveBeenCalledOnce();
  engine.dispose();
});
