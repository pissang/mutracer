import {readFileSync} from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Render from '../../src/Render';
import RenderLoop from '../../src/RenderLoop';
import Sync from '../../src/Sync';
import { renderFixture } from '../helpers/renderPipeline';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
class Source extends Sync {
  update = vi.fn();
  moving = false;
  get active() {return this.moving || super.active;}
  activate(ms: number) {this.activateFor(ms);}
}
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('RenderLoop selection and presentation', () => {
  it('uses an 80 ms adaptive preview budget with an independent final budget', () => {
    const {engine} = renderFixture(); const loop = new RenderLoop(engine);
    expect(loop.preview!.timeBudgetMs).toBe(80);
    expect(loop.preview!.adaptiveResolution).toEqual({targetFrameMs: 80, minScale: .125});
    expect(loop.final.timeBudgetMs).toBe(21);
    expect(loop.final.batchSamples).toBe(false);
    expect(loop.preview!.batchSamples).toBe(false);
    loop.dispose(); engine.dispose();
  });
  it('disables batching during interaction even when preview is disabled or final is explicitly selected', () => {
    for (const preview of [false, undefined] as const) {
      const {engine, targets} = renderFixture(); const sync = new Source(engine);
      const loop = new RenderLoop(engine, {sync, preview, final: {batchSamples: true}}); loop.select = () => 'final';
      loop.tick(); expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({batchSamples: true}));
      sync.moving = true; loop.tick();
      expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({batchSamples: false}));
      expect(loop.final.batchSamples).toBe(true);
      sync.moving = false; loop.tick();
      expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({batchSamples: true}));
      loop.dispose(); engine.dispose();
    }
  });
  it('batches final samples only when requested, including through the deprecated alias', () => {
    const {engine} = renderFixture();
    for (const [final, batching] of [[undefined, false], [{batchSamples: true}, true], [{allowMultipleSamplesPerFrame: true}, true], [new Render(engine, {batchSamples: true}), true]] as const) {
      const loop = new RenderLoop(engine, {final}); loop.tick();
      expect(loop.final._output!.configure).toHaveBeenLastCalledWith(expect.objectContaining({batchSamples: batching}));
      loop.dispose();
    }
    engine.dispose();
  });
  it.each([false, true])('finishes tiled previews during continuous camera edits (coalescing: %s)', coalesceSceneUpdates => {
    const {engine, camera, targets, operations} = renderFixture({tiles: 3});
    const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync, coalesceSceneUpdates, preview: {maxSamples: 1}});
    for (let frame = 1; frame <= 12; frame++) {
      camera.position = [frame, 0, 0]; loop.tick();
    }
    const presented = operations.filter(operation => operation.kind === 'present');
    expect(presented.length).toBeGreaterThanOrEqual(4);
    expect(targets).toHaveLength(1);
    const cameras = operations.filter(operation => operation.kind === 'draw').map(operation => operation.camera!.position[0]);
    expect(cameras).toEqual([1, 1, 1, 4, 4, 4, 7, 7, 7, 10, 10, 10]);
    // The next frame commits the newest input, rather than replaying queued poses.
    camera.position = [20, 0, 0]; loop.tick();
    expect(operations.filter(operation => operation.kind === 'draw').at(-1)!.camera!.position[0]).toBe(20);
    loop.dispose(); engine.dispose();
  });
  it('completes preview inference after its last tile before committing newer input', async () => {
    const {engine, camera, targets, operations} = renderFixture({tiles: 3});
    const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync, coalesceSceneUpdates: true, preview: {maxSamples: 1, denoiser: {type: 'jnlm'}}});
    loop.tick(); let complete!: (value: boolean) => void;
    vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    camera.position = [1, 0, 0]; loop.tick(); camera.position = [2, 0, 0]; loop.tick(); await settle();
    expect(targets[0].trace).toHaveBeenCalledTimes(3); expect(targets[0].present).not.toHaveBeenCalled();
    camera.position = [3, 0, 0]; loop.tick(); expect(targets[0].trace).toHaveBeenCalledTimes(3);
    complete(true); await settle(); camera.position = [4, 0, 0]; loop.tick();
    expect(targets[0].present).toHaveBeenCalledOnce();
    expect(operations.filter(operation => operation.kind === 'draw').at(-1)!.camera!.position[0]).toBe(4);
    loop.dispose(); engine.dispose();
  });
  it('starts final with the latest camera after interaction ends during a partial preview', () => {
    const {engine, camera, operations} = renderFixture({tiles: 3});
    const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync, preview: {maxSamples: 1}});
    loop.tick(); camera.position = [5, 0, 0]; sync.moving = false;
    loop.tick(); loop.tick(); expect(loop.changing).toBe(false);
    loop.tick(); expect(loop.final.samples).toBe(0);
    expect(operations.filter(operation => operation.kind === 'draw').at(-1)!.camera!.position[0]).toBe(5);
    loop.tick(); expect(loop.tick()).toBe('converging'); expect(loop.final.samples).toBe(1);
    loop.dispose(); engine.dispose();
  });
  it('retains preview status until a tiled final can replace the displayed preview', () => {
    const {engine, camera, targets} = renderFixture({tiles: 3, fits: false}); const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync});
    for (let i = 0; i < 3; i++) loop.tick();
    const trace = vi.mocked(targets[0].trace).getMockImplementation()!;
    vi.mocked(targets[0].trace).mockImplementation((camera, cap) => {trace(camera, cap); return trace(camera, cap);});
    const statuses = vi.fn(); loop.on('status', statuses);
    camera.position = [1, 0, 0]; sync.moving = false;
    expect(loop.tick()).toBe('previewing'); expect(loop.changing).toBe(false); expect(loop.final.samples).toBe(0);
    expect(loop.tick()).toBe('previewing'); expect(loop.final.samples).toBe(0);
    expect(loop.tick()).toBe('converging'); expect(loop.final.samples).toBe(1);
    expect(statuses.mock.calls.map(([event]) => event.status)).toEqual(['converging']);
    loop.dispose(); engine.dispose();
  });
  it('keeps preview sampling separate from completion and final denoising', async () => {
    const {engine, targets} = renderFixture(); const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync, preview: {maxSamples: 2}, final: {maxSamples: 2, denoiser: {type: 'jnlm'}}});
    const sample = vi.fn(); loop.on('sample', sample);
    for (let i = 0; i < 4; i++) {expect(loop.tick()).toBe('previewing'); expect(loop.samples).toBe(0);}
    expect(loop.preview!.samples).toBe(2); expect(sample).not.toHaveBeenCalled();
    expect(targets[0].performDenoise).not.toHaveBeenCalled();
    sync.moving = false;
    expect(loop.tick()).toBe('converging'); expect(loop.samples).toBe(1);
    expect(loop.tick()).toBe('denoising'); await settle();
    expect(loop.tick()).toBe('finished'); expect(loop.samples).toBe(2);
    expect(sample.mock.calls.map(([event]) => event)).toEqual([
      {samples: 1, isFirstFrame: true, frameTimeMs: 20, preview: false},
      {samples: 2, isFirstFrame: false, frameTimeMs: 20, preview: false},
    ]); loop.dispose(); engine.dispose();
  });
  it('ends explicit activity immediately, displaying fallback until the first final sample completes', () => {
    const {engine, targets} = renderFixture({tiles: 3, fits: false}); const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync, final: {maxSamples: 2}});
    for (let i = 0; i < 3; i++) loop.tick();
    sync.moving = false;
    expect(loop.tick()).toBe('previewing'); expect(loop.changing).toBe(false); expect(loop.final.samples).toBe(0);
    expect(targets[1].trace).toHaveBeenCalledOnce();
    expect(loop.tick()).toBe('previewing'); expect(loop.tick()).toBe('converging');
    expect(loop.final.samples).toBe(1); loop.dispose(); engine.dispose();
  });
  it('fills fallback and starts final in the same tick for an isolated edit', () => {
    const {engine, camera, targets} = renderFixture({tiles: 3, fits: false}); const loop = new RenderLoop(engine);
    loop.tick(); camera.position = [1, 0, 0];
    const calls = vi.mocked(targets[0].trace).mock.calls.length;
    loop.tick(); expect(loop.changing).toBe(false);
    expect(vi.mocked(targets[0].trace).mock.calls.length).toBe((calls ?? 0) + 1);
    expect(targets[1].trace).toHaveBeenCalledTimes(2); loop.dispose(); engine.dispose();
  });
  it('uses the idle heuristic only for consecutive unsynchronized changes', () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const {engine, camera} = renderFixture(); const loop = new RenderLoop(engine, {idleMs: 150});
    camera.position = [1, 0, 0]; loop.tick(); expect(loop.changing).toBe(false);
    now = 16; camera.position = [2, 0, 0]; expect(loop.tick()).toBe('previewing');
    now = 165; loop.tick(); expect(loop.changing).toBe(true);
    now = 166; loop.tick(); expect(loop.changing).toBe(false); loop.dispose(); engine.dispose();
  });
  it('honors custom selection and preview:false even with progressive denoising', async () => {
    const a = renderFixture(); const source = new Source(a.engine); source.moving = true;
    const loop = new RenderLoop(a.engine, {sync: source, preview: false, final: {maxSamples: 1, denoiser: {type: 'jnlm', schedule: 'progressive'}}});
    loop.select = () => 'preview'; expect(loop.tick()).toBe('denoising'); await settle(); expect(loop.tick()).toBe('finished');
    expect(loop.preview).toBeUndefined(); expect(a.targets).toHaveLength(1); loop.dispose(); a.engine.dispose();
    const b = renderFixture(); const custom = new RenderLoop(b.engine);
    custom.select = () => 'preview'; expect(custom.tick()).toBe('previewing'); expect(custom.final.samples).toBe(0);
    custom.select = () => 'final'; custom.tick(); expect(custom.final.samples).toBe(1); custom.dispose(); b.engine.dispose();
  });
  it('synchronizes inputs without GPU submissions once final is finished, but presents display edits', () => {
    const {engine, targets} = renderFixture(); const sync = new Source(engine); const loop = new RenderLoop(engine, {sync, final: {maxSamples: 1}});
    const update = vi.spyOn(engine, 'update'); expect(loop.tick()).toBe('finished');
    const present = vi.mocked(targets[0].present).mock.calls.length;
    loop.tick(); loop.tick(); expect(sync.update).toHaveBeenCalledTimes(3); expect(update).toHaveBeenCalledTimes(3);
    expect(targets[0].trace).toHaveBeenCalledOnce(); expect(targets[0].present).toHaveBeenCalledTimes(present);
    engine.display.toneMappingExposure = 2; loop.tick(); expect(targets[0].present).toHaveBeenCalledTimes(present + 2);
    expect(targets[0].trace).toHaveBeenCalledOnce(); loop.dispose(); engine.dispose();
  });
});

describe('RenderLoop events and inference', () => {
  it('keeps preview visible until the first filtered final image is ready', async () => {
    const {engine, targets} = renderFixture(); const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync, preview: {maxSamples: 1}, final: {maxSamples: 4, denoiser: {type: 'jnlm', schedule: 'progressive'}}});
    expect(loop.tick()).toBe('previewing'); sync.moving = false;
    expect(loop.tick()).toBe('previewing'); let complete!: (value: boolean) => void;
    vi.mocked(targets[1].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    await settle(); expect(loop.tick()).toBe('previewing'); expect(targets[1].present).not.toHaveBeenCalled();
    complete(true); await settle(); expect(loop.tick()).toBe('converging');
    expect(targets[1].present).toHaveBeenCalledOnce(); loop.dispose(); engine.dispose();
  });
  it('keeps converging when unused fallback inference outlives the first final sample', async () => {
    const {engine, targets} = renderFixture({fits: false});
    const loop = new RenderLoop(engine, {coalesceSceneUpdates: true, preview: {maxSamples: 1, denoiser: {type: 'jnlm'}}, final: {maxSamples: 4}});
    const statuses = vi.fn(); loop.on('status', statuses);
    expect(loop.tick()).toBe('converging'); expect(loop.final.samples).toBe(1);
    let complete!: (value: boolean) => void;
    vi.mocked(targets[1].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    await settle(); expect(loop.preview!.denoising).toBe(true);
    expect(loop.tick()).toBe('converging'); expect(loop.final.samples).toBe(2);
    expect(loop.tick()).toBe('converging'); expect(loop.final.samples).toBe(3);
    complete(true); await settle(); expect(loop.tick()).toBe('finished');
    expect(targets[1].present).not.toHaveBeenCalled();
    expect(statuses.mock.calls.map(([event]) => event.status)).toEqual(['converging', 'finished']);
    loop.dispose(); engine.dispose();
  });
  it.each([false, true])('keeps completed preview denoising visible while rendering the next frame (deferred: %s)', async deferred => {
    const {engine, camera, targets, operations} = renderFixture(); const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync, coalesceSceneUpdates: true, preview: {maxSamples: 1, denoiser: {type: 'jnlm', schedule: 'every-sample'}}});
    loop.tick();
    let complete!: (value: boolean) => void;
    if (deferred) vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    await settle();
    expect(targets[0].present).not.toHaveBeenCalled();
    if (deferred) {
      loop.tick(); expect(targets[0].present).not.toHaveBeenCalled();
      complete(true); await settle();
    }
    camera.position = [1, 0, 0]; const count = operations.length;
    expect(loop.tick()).toBe('previewing');
    expect(operations.slice(count).filter(operation => operation.kind === 'present' || operation.kind === 'draw').map(operation => operation.kind)).toEqual(['present', 'draw']);
    expect(targets[0].present).toHaveBeenCalledOnce();
    await settle();
    if (deferred) {
      loop.tick(); expect(targets[0].present).toHaveBeenCalledOnce();
      complete(true); await settle();
    }
    sync.moving = false; loop.tick(); expect(loop.final.samples).toBe(1);
    loop.dispose(); engine.dispose();
  });
  it('reports only final denoising and completion while converging', async () => {
    const {engine, targets} = renderFixture(); const loop = new RenderLoop(engine, {preview: false, final: {maxSamples: 8, denoiser: {type: 'jnlm', schedule: 'progressive'}}});
    const statuses = vi.fn(); loop.on('status', statuses);
    let complete!: (value: boolean) => void;
    loop.tick(); vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    await settle(); expect(loop.final.denoising).toBe(true); expect(loop.status).toBe('converging');
    complete(true); await settle();
    while (loop.samples < 4) loop.tick(); await settle(); expect(loop.status).toBe('converging');
    complete(true); await settle();
    while (loop.samples < 8) loop.tick(); await settle(); expect(loop.status).toBe('denoising');
    complete(true); await settle(); expect(loop.tick()).toBe('finished');
    expect(statuses.mock.calls.map(([event]) => event.status)).toEqual(['converging', 'denoising', 'finished']);
    loop.dispose(); engine.dispose();
  });
  it('supports multiple subscriptions, unsubscribe and status transitions', () => {
    const {engine} = renderFixture(); const loop = new RenderLoop(engine, {preview: false, final: {maxSamples: 3}});
    const status = vi.fn(), first = vi.fn(), second = vi.fn(); loop.on('status', status);
    const off = loop.on('sample', first); loop.on('sample', second);
    loop.tick(); off(); loop.tick(); loop.tick(); loop.tick();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenLastCalledWith({samples: 3, preview: false, isFirstFrame: false, frameTimeMs: 20});
    expect(status.mock.calls.map(([event]) => event)).toEqual([{status: 'converging', previous: 'preparing'}, {status: 'finished', previous: 'converging'}]);
    loop.dispose(); engine.dispose();
  });
  it('coalesces animated scene updates and denoises the latest state', async () => {
    const {engine, scene, targets, operations, pipeline} = renderFixture(); const sync = new Source(engine); sync.moving = true;
    let frame = 0; sync.update.mockImplementation(() => {scene.background = [++frame, 0, 0, 1];});
    const loop = new RenderLoop(engine, {sync, coalesceSceneUpdates: true, preview: {maxSamples: 1, denoiser: {type: 'jnlm', schedule: 'every-sample'}}});
    loop.tick(); let complete!: (value: boolean) => void;
    vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    await settle(); const update = vi.spyOn(engine, 'update');
    loop.tick(); loop.tick(); expect(update).not.toHaveBeenCalled(); expect(targets[0].trace).toHaveBeenCalledOnce();
    complete(true); await settle(); const count = operations.length;
    loop.tick(); await settle();
    expect(update).toHaveBeenCalledOnce(); expect(frame).toBe(4); expect(engine.scene!.background).toEqual([4, 0, 0, 1]);
    expect(pipeline.setBackground).toHaveBeenLastCalledWith([4, 0, 0, 1]);
    expect(operations.slice(count).find(operation => operation.kind === 'present')?.id).toBe(targets[0].label);
    expect(targets[0].performDenoise).toHaveBeenCalledTimes(2); expect(targets[0].trace).toHaveBeenCalledTimes(2);
    complete(true); await settle(); loop.dispose(); engine.dispose();
  });
  it('coalesces camera movement during preview inference and commits the latest camera', async () => {
    const {engine, camera, targets, operations} = renderFixture(); const sync = new Source(engine); sync.moving = true;
    const loop = new RenderLoop(engine, {sync, coalesceSceneUpdates: true, preview: {maxSamples: 1, denoiser: {type: 'jnlm'}}});
    loop.tick(); let complete!: (value: boolean) => void;
    vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;})); await settle();
    camera.position = [1, 0, 0]; loop.tick(); camera.position = [2, 0, 0]; loop.tick();
    expect(targets[0].trace).toHaveBeenCalledOnce(); complete(true); await settle(); loop.tick(); await settle();
    expect(operations.filter(operation => operation.kind === 'draw').at(-1)?.camera?.position).toEqual([2, 0, 0]);
    complete(true); await settle(); loop.dispose(); engine.dispose();
  });
  it('lets camera movement cancel settled final denoising with coalescing disabled', async () => {
    const {engine, camera, targets} = renderFixture(); const sync = new Source(engine);
    const loop = new RenderLoop(engine, {sync, final: {maxSamples: 1, denoiser: {type: 'jnlm'}}});
    loop.tick(); let complete!: (value: boolean) => void;
    vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;})); await settle();
    const cancellations = vi.mocked(targets[0].cancelDenoise!).mock.calls.length;
    camera.position = [2, 0, 0]; sync.moving = true; expect(loop.tick()).toBe('previewing');
    expect(targets[0].cancelDenoise).toHaveBeenCalledTimes(cancellations + 1); expect(loop.samples).toBe(0);
    complete(true); await settle(); loop.dispose(); engine.dispose();
  });
  it('does not defer scene invalidation behind inference by default', async () => {
    const {engine, scene, targets, pipeline} = renderFixture(); const source = new Source(engine); source.moving = true;
    const loop = new RenderLoop(engine, {sync: source, preview: {maxSamples: 1, denoiser: {type: 'jnlm'}}});
    loop.tick(); let complete!: (value: boolean) => void;
    vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;})); await settle();
    scene.background = [.2, .3, .4, 1]; loop.tick();
    expect(pipeline.setBackground).toHaveBeenLastCalledWith([.2, .3, .4, 1]); expect(targets[0].trace).toHaveBeenCalledTimes(2);
    complete(true); await settle(); loop.dispose(); engine.dispose();
  });
  it('starts independent final denoising when preview ends after completed interactive inference', async () => {
    const {engine, targets} = renderFixture(); const source = new Source(engine); source.moving = true;
    const loop = new RenderLoop(engine, {sync: source, preview: {maxSamples: 1, denoiser: {type: 'jnlm'}}, final: {maxSamples: 1, denoiser: {type: 'jnlm'}}});
    expect(loop.tick()).toBe('previewing'); await settle();
    source.moving = false; expect(loop.tick()).toBe('previewing'); expect(loop.final.denoising).toBe(true);
    await settle(); expect(loop.tick()).toBe('finished');
    expect(targets.map(target => vi.mocked(target.performDenoise!).mock.calls.length)).toEqual([1, 1]);
    loop.dispose(); engine.dispose();
  });
});

describe('RenderLoop sampling between display frames', () => {
  function refillFixture() {
    let id = 0; const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frames.set(++id, callback); return id;});
    vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
    const fixture = renderFixture(), sync = new Source(fixture.engine);
    const loop = new RenderLoop(fixture.engine, {sync, final: {batchSamples: true}}); loop.tick();
    const target = fixture.targets[0], completions: (() => void)[] = [];
    const budget = vi.fn(), defer = vi.fn();
    Object.assign(target, {getRealtimeSampleTime: () => 1, setRealtimeBatchBudget: budget, setRealtimeDeferPostProcess: defer,
      whenTraceAvailable: () => fixture.engine.device!.queue.onSubmittedWorkDone()});
    vi.spyOn(fixture.engine.device!.queue, 'onSubmittedWorkDone').mockImplementation(() => new Promise(resolve => completions.push(() => resolve(undefined))));
    loop.tick();
    return {...fixture, loop, sync, target, frames, completions, budget, defer, async complete() {completions.shift()!(); await settle();}};
  }
  it('refills short batches after GPU completion without updating syncs or presenting extra frames', async () => {
    const f = refillFixture(); const {loop, engine, target, sync, operations, budget, defer} = f;
    expect(loop.final.samples).toBe(2); const presents = operations.filter(o => o.kind === 'present').length;
    expect(defer).toHaveBeenLastCalledWith(false);
    await f.complete(); await f.complete();
    // Refills leave resolving to the next presentation.
    expect(defer).toHaveBeenLastCalledWith(true);
    expect(loop.final.samples).toBe(4); expect(sync.update).toHaveBeenCalledTimes(2);
    expect(operations.filter(o => o.kind === 'present')).toHaveLength(presents);
    expect(target.configure).toHaveBeenLastCalledWith(expect.objectContaining({timeBudgetMs: 21}));
    expect(budget).toHaveBeenLastCalledWith(4);
    loop.stop(); await f.complete(); expect(loop.final.samples).toBe(4);
    loop.dispose(); engine.dispose();
  });
  const refillTimes: number[] = JSON.parse(readFileSync(new URL('../fixtures/display-schedule.json', import.meta.url), 'utf8')).refillSampleTimesMs;
  it.each(refillTimes)('refills incomplete tiles with a %s ms full sample estimate', async fullSampleMs => {
    const f = refillFixture();
    let submitted = 0, pending = false;
    Object.assign(f.target, {getRealtimeSampleTime: () => fullSampleMs, hasPendingTrace: () => pending});
    // A tile does real work without advancing the completed-sample counter.
    vi.mocked(f.target.trace).mockImplementation(() => {submitted++; pending = true; return false;});
    f.loop.tick();
    const samples = f.loop.final.samples, presents = f.operations.filter(o => o.kind === 'present').length;
    await f.complete(); await f.complete(); await f.complete();
    expect(submitted).toBe(3); expect(f.loop.final.samples).toBe(samples);
    expect(f.operations.filter(o => o.kind === 'present')).toHaveLength(presents);
    // No submission means no promise/microtask spin while preparation is pending.
    vi.mocked(f.target.trace).mockImplementation(() => {pending = false; return false;});
    await f.complete(); expect(f.completions).toHaveLength(0);
    f.loop.dispose(); f.engine.dispose();
  });
  it('expires a manual tick at the next display frame and ignores old completion callbacks after a new tick', async () => {
    const f = refillFixture();
    const expire = [...f.frames.values()][0]; expire(0);
    await f.complete(); expect(f.loop.final.samples).toBe(2);
    f.loop.tick(); f.loop.tick(); expect(f.loop.final.samples).toBe(4);
    await f.complete(); expect(f.loop.final.samples).toBe(4);
    await f.complete(); expect(f.loop.final.samples).toBe(5);
    f.loop.dispose(); f.engine.dispose();
  });
  it.each(['input', 'selection', 'camera', 'aov', 'stop', 'dispose', 'hidden', 'device'] as const)('cancels deferred work on %s', async reason => {
    const f = refillFixture();
    if (reason === 'input') f.sync.moving = true;
    if (reason === 'selection') f.loop.select = () => 'preview';
    if (reason === 'camera') {f.camera.position = [1, 0, 0]; f.engine.update();}
    if (reason === 'aov') f.engine.display.channel = 'depth';
    if (reason === 'stop') f.loop.stop();
    if (reason === 'dispose') f.loop.dispose();
    if (reason === 'hidden') vi.stubGlobal('document', {hidden: true, removeEventListener: vi.fn()});
    if (reason === 'device') vi.spyOn(f.engine, 'device', 'get').mockReturnValue(undefined);
    const before = vi.mocked(f.target.trace).mock.calls.length;
    await f.complete(); expect(f.target.trace).toHaveBeenCalledTimes(before);
    f.loop.dispose(); f.engine.dispose();
  });
  it('cancels interactive refills before offline convergence', async () => {
    const f = refillFixture();
    const converge = vi.spyOn(f.loop.final, 'converge').mockResolvedValue({samples: 2, averageSamplesPerPixel: 2, pilotSamples: 0, adaptiveSampling: false});
    await f.loop.converge({samples: 2}); const before = vi.mocked(f.target.trace).mock.calls.length;
    await f.complete(); expect(f.target.trace).toHaveBeenCalledTimes(before); expect(converge).toHaveBeenCalledOnce();
    f.loop.dispose(); f.engine.dispose();
  });
  it('stops at the denoising boundary instead of submitting another batch', async () => {
    const f = refillFixture();
    f.loop.final.maxSamples = 3; await f.loop.final.setDenoiser({type: 'jnlm'});
    await f.complete(); expect(f.loop.final.samples).toBe(3); expect(f.loop.final.denoising).toBe(true);
    const before = vi.mocked(f.target.trace).mock.calls.length;
    await f.complete(); expect(f.target.trace).toHaveBeenCalledTimes(before); expect(f.completions).toHaveLength(0);
    f.loop.dispose(); f.engine.dispose();
  });
  it('does not re-arm when a sample listener stops the loop', async () => {
    const f = refillFixture(); f.loop.on('sample', () => f.loop.stop());
    f.loop.tick(); expect(f.loop.final.samples).toBe(3); expect(f.completions).toHaveLength(1);
    await f.complete(); expect(f.loop.final.samples).toBe(3);
    f.loop.dispose(); f.engine.dispose();
  });
});

describe('RenderLoop lifecycle', () => {
  it('rejects foreign engines before allocating targets', () => {
    const a = renderFixture(), b = renderFixture(); const render = new Render(b.engine), sync = new Source(b.engine);
    expect(() => new RenderLoop(a.engine, {preview: render})).toThrow('same engine');
    expect(() => new RenderLoop(a.engine, {final: render})).toThrow('same engine');
    expect(() => new RenderLoop(a.engine, {sync})).toThrow('same engine');
    const loop = new RenderLoop(a.engine); expect(() => loop.addSync(sync)).toThrow('same engine');
    loop.dispose(); a.engine.dispose(); b.engine.dispose();
  });
  function animationFrames() {
    let id = 0; const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {callbacks.set(++id, callback); return id;}));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((key: number) => callbacks.delete(key)));
    return {callbacks, frame() {const [key, callback] = [...callbacks][0]; callbacks.delete(key); callback(0);}};
  }
  it('makes start idempotent and warns once for manual ticks, then stops and disposes ownership correctly', () => {
    const {engine} = renderFixture(); const frames = animationFrames(); const supplied = new Render(engine);
    const loop = new RenderLoop(engine, {final: supplied}); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loop.start(); loop.start(); expect(frames.callbacks.size).toBe(1); loop.tick(); loop.tick(); expect(warn).toHaveBeenCalledOnce(); expect(supplied.samples).toBe(0);
    frames.frame(); expect(supplied.samples).toBe(1); loop.stop(); expect(frames.callbacks.size).toBe(0); loop.tick(); expect(supplied.samples).toBe(2);
    loop.dispose(); supplied.refine(); expect(supplied.samples).toBe(3); expect(() => loop.tick()).toThrow('disposed'); engine.dispose();
  });
  it('pauses for visibility and resumes without duplicate animation frames', () => {
    const events = new Map<string, () => void>(); const doc = {hidden: false, addEventListener: vi.fn((name, fn) => events.set(name, fn)), removeEventListener: vi.fn()};
    vi.stubGlobal('document', doc); const frames = animationFrames(); const {engine} = renderFixture(); const loop = new RenderLoop(engine);
    loop.start(); doc.hidden = true; events.get('visibilitychange')!(); expect(frames.callbacks.size).toBe(0);
    doc.hidden = false; events.get('visibilitychange')!(); expect(frames.callbacks.size).toBe(1);
    loop.dispose(); expect(doc.removeEventListener).toHaveBeenCalled(); engine.dispose();
  });
  it('pauses interactive ticks during convergence and resumes a started loop, including errors', async () => {
    const {engine, targets} = renderFixture(); const frames = animationFrames(); const loop = new RenderLoop(engine, {final: {maxSamples: 4}});
    loop.start(); const promise = loop.converge({samples: 4}); expect(frames.callbacks.size).toBe(0);
    expect(await promise).toMatchObject({samples: 4}); expect(loop.status).toBe('finished'); expect(frames.callbacks.size).toBe(1);
    expect(targets[0].present).toHaveBeenCalledOnce();
    const abort = new AbortController(); abort.abort(new Error('cancel')); await expect(loop.converge({samples: 4, signal: abort.signal})).rejects.toThrow('cancel');
    expect(loop.status).toBe('error'); expect(frames.callbacks.size).toBe(1); loop.dispose(); engine.dispose();
  });
  it('adds and removes integrations, extends timed activity, and calls them in order', () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); const {engine} = renderFixture();
    const a = new Source(engine), b = new Source(engine), order: string[] = [];
    a.update.mockImplementation(() => order.push('a')); b.update.mockImplementation(() => order.push('b'));
    const loop = new RenderLoop(engine, {sync: a}); loop.addSync(b); loop.addSync(b); a.activate(10); loop.tick(); expect(loop.changing).toBe(true); expect(order).toEqual(['a', 'b']);
    now = 10; loop.removeSync(a); loop.tick(); expect(loop.changing).toBe(false); expect(order).toEqual(['a', 'b', 'b']); loop.dispose(); engine.dispose();
  });
});

it('holds pending preview inference through interaction end, then starts final with the latest camera', async () => {
  const {engine, camera, targets, operations} = renderFixture(); const sync = new Source(engine); sync.moving = true;
  const loop = new RenderLoop(engine, {sync, coalesceSceneUpdates: true, preview: {maxSamples: 1, denoiser: {type: 'jnlm'}}});
  loop.tick(); let complete!: (value: boolean) => void;
  vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;})); await settle();
  camera.position = [3, 0, 0]; sync.moving = false; expect(loop.tick()).toBe('previewing'); expect(loop.changing).toBe(false); expect(loop.final.samples).toBe(0);
  expect(targets).toHaveLength(1); complete(true); await settle(); expect(loop.tick()).toBe('converging');
  expect(operations.filter(operation => operation.kind === 'draw').at(-1)?.camera?.position).toEqual([3, 0, 0]); loop.dispose(); engine.dispose();
});

it('reports preview inference as previewing even when its own sample budget is complete', async () => {
  const {engine, targets} = renderFixture(); const sync = new Source(engine); sync.moving = true;
  const loop = new RenderLoop(engine, {sync, preview: {maxSamples: 1, denoiser: {type: 'jnlm', schedule: 'every-sample'}}, final: {maxSamples: 1}});
  const sample = vi.fn(); loop.on('sample', sample); expect(loop.tick()).toBe('previewing');
  let complete!: (value: boolean) => void; vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;})); await settle();
  expect(loop.preview!.status).toBe('denoising'); expect(loop.tick()).toBe('previewing'); expect(loop.samples).toBe(0); expect(sample).not.toHaveBeenCalled();
  complete(true); await settle(); expect(loop.tick()).toBe('previewing'); sync.moving = false; expect(loop.tick()).toBe('finished'); expect(sample).toHaveBeenCalledOnce(); loop.dispose(); engine.dispose();
});
it('keeps fallback presentation through final shader compilation and tiled sampling', () => {
  const {engine, targets} = renderFixture({tiles: 2, fits: false}); const sync = new Source(engine); sync.moving = true;
  const loop = new RenderLoop(engine, {sync, final: {maxSamples: 2}}); loop.tick(); loop.tick(); sync.moving = false;
  expect(loop.tick()).toBe('previewing'); vi.mocked(targets[1].trace).mockReturnValueOnce(true);
  expect(loop.tick()).toBe('previewing'); expect(loop.final.status).toBe('compiling'); expect(loop.samples).toBe(0);
  expect(loop.tick()).toBe('converging'); expect(loop.samples).toBe(1); loop.dispose(); engine.dispose();
});
it('reports rendering errors and the following successful status transition', () => {
  const {engine, targets} = renderFixture(); const loop = new RenderLoop(engine, {preview: false, final: {maxSamples: 2}}); loop.tick();
  const statuses = vi.fn(); loop.on('status', statuses); const error = new Error('trace failed'); vi.mocked(targets[0].trace).mockImplementationOnce(() => {throw error;});
  vi.spyOn(console, 'error').mockImplementation(() => {}); expect(loop.tick()).toBe('error'); expect(engine.lastError).toBe(error);
  expect(loop.tick()).toBe('finished'); expect(engine.lastError).toBeUndefined();
  expect(statuses.mock.calls.map(([event]) => event.status)).toEqual(['error', 'finished']); loop.dispose(); engine.dispose();
});
it('wakes a finished final for quality edits, restart and denoiser changes', async () => {
  const {engine, targets} = renderFixture(); const loop = new RenderLoop(engine, {preview: false, final: {maxSamples: 1}});
  loop.tick(); loop.final.bounces = 8; loop.tick(); expect(targets[0].trace).toHaveBeenCalledTimes(2);
  loop.final.restart(); loop.tick(); expect(targets[0].trace).toHaveBeenCalledTimes(3);
  loop.final.setDenoiser({type: 'jnlm'}); expect(loop.tick()).toBe('denoising'); await settle(); expect(loop.tick()).toBe('finished');
  expect(targets[0].trace).toHaveBeenCalledTimes(3); loop.dispose(); engine.dispose();
});
it('reports zero formal samples while showing preview without discarding a current final image', () => {
  const {engine} = renderFixture(); const sync = new Source(engine); const loop = new RenderLoop(engine, {sync, final: {maxSamples: 1}});
  expect(loop.tick()).toBe('finished'); expect(loop.samples).toBe(1); sync.moving = true;
  expect(loop.tick()).toBe('previewing'); expect(loop.samples).toBe(0); expect(loop.final.samples).toBe(1);
  sync.moving = false; expect(loop.tick()).toBe('finished'); expect(loop.samples).toBe(1); loop.dispose(); engine.dispose();
});

it('makes completed denoised pixels readable inside the finished status listener', async () => {
  const {engine, targets} = renderFixture(); const loop = new RenderLoop(engine, {preview: false, final: {maxSamples: 1, denoiser: {type: 'jnlm'}}});
  let pixels: ReturnType<Render['readPixels']> | undefined;
  loop.on('status', ({status}) => {if (status === 'finished') pixels = loop.final.readPixels('denoised');});
  expect(loop.tick()).toBe('denoising'); await settle(); expect(loop.tick()).toBe('finished');
  expect((await pixels)!.data[1]).toBe(1); expect(targets[0].readOutput).toHaveBeenCalledWith('denoised'); loop.dispose(); engine.dispose();
});
