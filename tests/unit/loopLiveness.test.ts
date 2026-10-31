import {afterEach, expect, it, vi} from 'vitest';
import RenderLoop from '../../src/RenderLoop';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createPlaneGeometry} from '../../src/util/commonGeometry';
import {renderFixture} from '../helpers/renderPipeline';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('reports an exception from a tick as the error status', () => {
  const {engine} = renderFixture();
  const loop = new RenderLoop(engine, {preview: false});
  loop.tick();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const update = vi.spyOn(engine, 'update').mockImplementation(() => { throw new Error('Bad scene'); });
  expect(loop.tick()).toBe('error');
  expect(loop.lastError?.message).toBe('Bad scene');
  update.mockRestore();
  expect(loop.tick()).not.toBe('error');
  expect(loop.lastError).toBeUndefined();
  loop.dispose(); engine.dispose();
});

it('commits edits after preview inference stalls while coalescing', async () => {
  const {engine, camera, targets} = renderFixture();
  const loop = new RenderLoop(engine, {coalesceSceneUpdates: true, preview: {maxSamples: 1, denoiser: {type: 'jnlm', schedule: 'every-sample'}}});
  loop.select = () => 'preview';
  loop.tick();
  vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(() => {}));
  await settle(); loop.tick(); await settle();
  expect(loop.preview!.denoising).toBe(true);
  const update = vi.spyOn(engine, 'update');
  const now = vi.spyOn(performance, 'now');
  const start = performance.now();
  now.mockReturnValue(start);
  camera.position = [5, 0, 0];
  loop.tick(); loop.tick();
  expect(update).not.toHaveBeenCalled();
  now.mockReturnValue(start + 6000);
  loop.tick();
  expect(update).toHaveReturnedWith(true);
  loop.dispose(); engine.dispose();
});

it('continues denoising after a cancelled job never settles', async () => {
  const {engine} = renderFixture();
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const controller = new AbortController(), next = vi.fn(async () => {});
  void engine._enqueueDenoise(() => new Promise<void>(() => {}), controller.signal);
  const queued = engine._enqueueDenoise(next);
  await vi.advanceTimersByTimeAsync(20000);
  expect(next).not.toHaveBeenCalled();
  controller.abort();
  await vi.advanceTimersByTimeAsync(9000);
  expect(next).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  await queued;
  expect(next).toHaveBeenCalledTimes(1);
  engine.dispose();
});

it('uploads once after BVH preparation fails instead of retrying every frame', async () => {
  const {engine} = renderFixture();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  engine.bvhBuilder = 'tinybvh';
  const prepare = vi.spyOn(engine, 'prepare').mockRejectedValue(new Error('Worker failed'));
  engine.scene = {meshes: [new Mesh(createPlaneGeometry(), new OpenPBRMaterial())], lights: []};
  engine.update(); await settle();
  engine.update(); engine.update(); await settle();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(engine._ready).toBe(true);
  engine.dispose();
});

it('cancels preparation of replaced meshes and prepares the latest scene', async () => {
  const {engine} = renderFixture();
  engine.bvhBuilder = 'tinybvh';
  const signals: AbortSignal[] = [];
  const prepare = vi.spyOn(engine, 'prepare').mockImplementation((_scene, options) => new Promise((_resolve, reject) => {
    signals.push(options!.signal!);
    options!.signal!.addEventListener('abort', () => reject(new Error('Aborted')));
  }));
  const scene = () => ({meshes: [new Mesh(createPlaneGeometry(), new OpenPBRMaterial())], lights: []});
  engine.scene = scene(); engine.update(); await settle();
  const started = prepare.mock.calls.length;
  engine.scene = scene(); engine.update(); await settle();
  expect(signals[started - 1].aborted).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(started + 1);
  engine.dispose();
});
