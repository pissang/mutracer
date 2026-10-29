import {afterEach, describe, expect, it, vi} from 'vitest';
import Render from '../../src/Render';
import {renderFixture} from '../helpers/renderPipeline';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

function fixture(backend: 'webgpu' | 'webgl' = 'webgpu', tiles = 1) {
  const f = renderFixture({backend, tiles});
  const render = new Render(f.engine, {batchSamples: true});
  for (let i = 0; i < tiles; i++) render.refine();
  f.engine.display.present(render);
  const target = f.targets[0];
  const completions: ((ready: boolean) => void)[] = [];
  Object.assign(target, {getRealtimeTileTime: () => 1,
    whenTraceAvailable: vi.fn(() => new Promise<boolean>(resolve => completions.push(resolve)))});
  const refine = vi.spyOn(render, 'refine');
  const start = (signal?: AbortSignal, deadline = performance.now() + 10000) => {
    const promise = render.refineUntil(deadline, {signal});
    f.engine.display.present(render);
    return promise;
  };
  const complete = async (ready = true) => {completions.shift()!(ready); await settle();};
  return {...f, render, target, refine, completions, start, complete};
}

describe('Render.refineUntil', () => {
  it('finishes its ordinary synchronous refine before returning a Promise and allows immediate presentation', async () => {
    const f = fixture(), controller = new AbortController();
    const promise = f.start(controller.signal);
    expect(promise).toBeInstanceOf(Promise);
    expect(f.render.samples).toBe(2);
    expect(f.refine).toHaveBeenCalledTimes(1);
    expect(f.refine).toHaveBeenCalledWith(undefined, undefined);
    expect(f.target.present).toHaveBeenCalledTimes(2);
    controller.abort(); await promise; f.engine.dispose();
  });
  it('finishes tiled samples between presentations without presenting partial samples', async () => {
    const f = fixture('webgpu', 3), controller = new AbortController();
    const promise = f.start(controller.signal);
    expect(f.render.samples).toBe(1);
    await f.complete(); expect(f.render.samples).toBe(1);
    await f.complete(); expect(f.render.samples).toBe(2);
    expect(f.target.present).toHaveBeenCalledTimes(2);
    expect(f.refine).toHaveBeenLastCalledWith(undefined, {targetBatchTimeMs: 4, deferResolve: true});
    controller.abort(); await promise; f.engine.dispose();
  });
  it('stops when no sampling was queued', async () => {
    const f = fixture(); const promise = f.start();
    await f.complete(false); await promise;
    expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  it('resolves at its deadline even while the GPU wait is pending', async () => {
    vi.useFakeTimers(); const f = fixture();
    const promise = f.start(undefined, performance.now() + 10);
    await vi.advanceTimersByTimeAsync(10); await promise;
    await f.complete(); expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  it('rechecks the deadline after GPU completion', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(), promise = f.start(undefined, 10);
    now = 10; await f.complete(); await promise;
    expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  it.each(['before', 'waiting', 'after-refill'] as const)('aborts %s without further submission or rejection', async when => {
    const f = fixture(), controller = new AbortController();
    if (when === 'before') controller.abort();
    const promise = f.start(controller.signal);
    if (when === 'after-refill') await f.complete();
    controller.abort(); await promise;
    if (f.completions.length) await f.complete();
    expect(f.refine).toHaveBeenCalledTimes(when === 'after-refill' ? 2 : 1);
    f.engine.dispose();
  });
  it('resolves on visibility change without waiting for the GPU', async () => {
    const document = new EventTarget() as EventTarget & {hidden: boolean}; document.hidden = false;
    vi.stubGlobal('document', document);
    const f = fixture(), promise = f.start();
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    await promise; await f.complete(); expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  const guards = ['batching', 'status', 'denoising', 'samples', 'timing', 'budget', 'channel', 'other-render', 'device', 'hidden'] as const;
  it.each(guards)('rechecks %s after the GPU wait', async reason => {
    const f = fixture(), promise = f.start();
    if (reason === 'batching') f.render.batchSamples = false;
    if (reason === 'status') vi.spyOn(f.render, 'status', 'get').mockReturnValue('compiling');
    if (reason === 'denoising') vi.spyOn(f.render, 'denoising', 'get').mockReturnValue(true);
    if (reason === 'samples') vi.spyOn(f.render, 'samples', 'get').mockReturnValue(0);
    if (reason === 'timing') Object.assign(f.target, {getRealtimeTileTime: () => undefined});
    if (reason === 'budget') Object.assign(f.target, {getRealtimeTileTime: () => 22});
    if (reason === 'channel') f.engine.display.channel = 'albedo';
    if (reason === 'other-render') {const other = new Render(f.engine); other.refine(); f.engine.display.present(other);}
    if (reason === 'device') vi.spyOn(f.engine, 'device', 'get').mockReturnValue(undefined);
    if (reason === 'hidden') vi.stubGlobal('document', {hidden: true, removeEventListener: vi.fn()});
    await f.complete(); await promise;
    expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  it.each(['batching', 'status', 'denoising', 'samples', 'timing', 'budget', 'channel', 'hidden'] as const)('does not wait when %s already prevents refilling', async reason => {
    const f = fixture();
    if (reason === 'batching') f.render.batchSamples = false;
    if (reason === 'status') vi.spyOn(f.render, 'status', 'get').mockReturnValue('preparing');
    if (reason === 'denoising') vi.spyOn(f.render, 'denoising', 'get').mockReturnValue(true);
    if (reason === 'samples') vi.spyOn(f.render, 'samples', 'get').mockReturnValue(0);
    if (reason === 'timing') Object.assign(f.target, {getRealtimeTileTime: () => undefined});
    if (reason === 'budget') Object.assign(f.target, {getRealtimeTileTime: () => 22});
    if (reason === 'channel') f.engine.display.channel = 'normal';
    if (reason === 'hidden') vi.stubGlobal('document', {hidden: true});
    await f.start(); expect(f.completions).toHaveLength(0);
    expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  it('ends the previous call immediately and ignores its pending GPU completion', async () => {
    const f = fixture(), controller = new AbortController();
    const first = f.start(), second = f.start(controller.signal);
    await first; await f.complete(); expect(f.refine).toHaveBeenCalledTimes(2);
    await f.complete(); expect(f.refine).toHaveBeenCalledTimes(3);
    controller.abort(); await second; f.engine.dispose();
  });
  it('runs only the synchronous call on WebGL even if a target supplies timing and capacity', async () => {
    const f = fixture('webgl'); await f.start();
    expect(f.completions).toHaveLength(0); expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  it.each(['wait', 'refine'] as const)('contains asynchronous %s errors and resolves with error status', async reason => {
    const f = fixture(), failure = new Error('asynchronous failure');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const promise = f.start();
    if (reason === 'wait') {
      // The following capacity wait rejects; the current wait releases normally.
      Object.assign(f.target, {whenTraceAvailable: () => Promise.reject(failure)});
    } else f.refine.mockImplementation(() => {throw failure;});
    await f.complete(); await expect(promise).resolves.toBeUndefined();
    expect(f.render.status).toBe('error'); expect(f.engine.lastError).toBe(failure); f.engine.dispose();
  });
  it.each(['restart', 'dispose', 'inputs', 'converge'] as const)('ends a pending refill on %s', async reason => {
    const f = fixture(), promise = f.start();
    if (reason === 'restart') f.render.restart();
    if (reason === 'dispose') f.render.dispose();
    if (reason === 'inputs') {f.camera.position = [1, 0, 0]; f.engine.update();}
    if (reason === 'converge') await f.render.converge({samples: 1});
    await promise; await f.complete(); expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  it('handles a late capacity rejection after cancellation without an unhandled rejection', async () => {
    const f = fixture(), controller = new AbortController();
    let reject!: (error: Error) => void;
    Object.assign(f.target, {whenTraceAvailable: () => new Promise<boolean>((_, fail) => {reject = fail;})});
    const promise = f.start(controller.signal);
    controller.abort(); await promise;
    reject(new Error('obsolete GPU wait')); await settle();
    expect(f.render.status).toBe('converging'); expect(f.refine).toHaveBeenCalledTimes(1); f.engine.dispose();
  });
  it('ends a reentrant older call when a sample listener starts a newer refill', async () => {
    const f = fixture(), controller = new AbortController();
    let newer!: Promise<void>;
    const unsubscribe = f.render.on('sample', () => {unsubscribe(); newer = f.start(controller.signal);});
    const older = f.start(); await older;
    expect(f.render.samples).toBe(3); expect(f.completions).toHaveLength(1);
    controller.abort(); await newer; f.engine.dispose();
  });
  it('reports synchronous trace errors using the ordinary refine error status', async () => {
    const f = fixture(), failure = new Error('trace failure');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(f.target.trace).mockImplementation(() => {throw failure;});
    await f.start(); expect(f.render.status).toBe('error'); expect(f.engine.lastError).toBe(failure);
    expect(f.completions).toHaveLength(0); f.engine.dispose();
  });
  it('still refines once when the deadline has already expired', async () => {
    const f = fixture(); await f.start(undefined, -1);
    expect(f.render.samples).toBe(2); expect(f.completions).toHaveLength(0); f.engine.dispose();
  });
  it.each(['preparing', 'compiling', 'first-sample'] as const)('advances %s only through its synchronous call', async stage => {
    const f = renderFixture({tiles: 3});
    if (stage === 'preparing') vi.spyOn(f.engine, '_ready', 'get').mockReturnValue(false);
    const render = new Render(f.engine, {batchSamples: true});
    if (stage === 'compiling') {render.refine(); vi.mocked(f.targets[0].trace).mockReturnValue(true);}
    const capacity = vi.spyOn(render, 'whenReadyToRefine');
    await render.refineUntil(Infinity);
    expect(render.status).toBe(stage === 'first-sample' ? 'converging' : stage);
    expect(render.samples).toBe(0); expect(capacity).not.toHaveBeenCalled(); f.engine.dispose();
  });
  it('preserves synchronous lifecycle exceptions', () => {
    const f = fixture(); f.render.dispose();
    expect(() => f.render.refineUntil(Infinity)).toThrow('Render is disposed'); f.engine.dispose();
  });
});
