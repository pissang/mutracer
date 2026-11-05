import { describe, it, expect, vi } from 'vitest';
import Render from '../../src/Render.js';
import RenderLoop from '../../src/RenderLoop.js';
import { renderFixture } from '../helpers/renderPipeline.js';
import { AOV_KINDS } from '../../src/renderer/aov.js';
import { DEFAULT_AOV_DISPLAY, packAovDisplay, validateAovDisplay } from '../../src/renderer/aovDisplay.js';
describe('AOV display channels', () => {
  // A lobe's albedo and color share storage, so each render requests one of them.
  it.each([[AOV_KINDS.filter(kind => !kind.endsWith('Color'))], [AOV_KINDS.filter(kind => !kind.endsWith('Albedo'))]])('selects declared outputs without restarting sampling or invalidating denoising (%#)', kinds => {
    const { engine, targets } = renderFixture();
    const render = new Render(engine, { aovs: kinds });
    render.refine();
    engine.display.present(render);
    const changed = vi.spyOn(render, '_displayChanged');
    for (const channel of kinds) {
      engine.display.channel = channel;
      engine.display.present(render);
      expect(targets[0].setOutput).toHaveBeenLastCalledWith(channel);
    }
    engine.display.aovDepthRange = [1, 50];
    engine.display.aovIdComponent = 'material';
    engine.display.present(render);
    expect(changed).not.toHaveBeenCalled();
    expect(targets[0].restartSamples).toHaveBeenCalledTimes(1);
    expect(render.samples).toBe(1);
    expect(render.aovs).toEqual(kinds);
    engine.dispose();
  });
  it('requires explicit outputs on the selected render and leaves its image untouched on error', () => {
    const { engine, targets } = renderFixture();
    const render = new Render(engine);
    render.refine();
    engine.display.present(render);
    const draws = vi.mocked(targets[0].drawPostProcess).mock.calls.length;
    engine.display.channel = 'depth';
    expect(() => engine.display.present(render)).toThrow('not enabled');
    expect(targets[0].drawPostProcess).toHaveBeenCalledTimes(draws);
    expect(render.aovs).toEqual([]);
    expect(render.samples).toBe(1);
    engine.display.channel = 'normal';
    expect(() => engine.display.present(render)).not.toThrow();
    engine.dispose();
  });
  it('waits for a newly enabled output and wakes a finished loop for AOV settings', () => {
    const {engine, targets} = renderFixture();
    const loop = new RenderLoop(engine, {preview: false, final: {maxSamples: 1}});
    expect(loop.tick()).toBe('finished');
    const target = targets[0];
    let ready = false;
    target.aovReady = kind => ready && !!vi.mocked(target.configure).mock.calls.at(-1)?.[0].aovs?.includes(kind);
    target.getAovSamples = () => ready ? 1 : 0;
    target.refineAovs = vi.fn().mockReturnValueOnce(false).mockImplementation(() => { ready = true; return true; });
    loop.final.aovs = ['depth']; engine.display.channel = 'depth';
    const draws = vi.mocked(target.drawPostProcess).mock.calls.length;
    expect(engine.display.present(loop.final)).toBeUndefined();
    expect(target.drawPostProcess).toHaveBeenCalledTimes(draws);
    expect(loop.tick()).toBe('compiling');
    expect(loop.tick()).toBe('finished');
    expect(target.refineAovs).toHaveBeenCalledTimes(2);
    expect(loop.final.samples).toBe(1);
    expect(target.restartSamples).toHaveBeenCalledOnce();
    expect(target.trace).toHaveBeenCalledOnce();
    const present = vi.mocked(target.present).mock.calls.length;
    engine.display.aovDepthRange = [0, 20];
    expect(loop.tick()).toBe('finished');
    expect(vi.mocked(target.present).mock.calls.length).toBeGreaterThan(present);
    expect(target.trace).toHaveBeenCalledOnce();
    loop.dispose(); engine.dispose();
  });
  it.each(AOV_KINDS)('traces only surface outputs while viewing %s and resumes beauty on Final', async channel => {
    const {engine, targets, camera} = renderFixture();
    const loop = new RenderLoop(engine, {preview: false, final: {aovs: [channel], maxSamples: 4, aovSamples: 2, denoiser: {type: 'jnlm'}}});
    await new Promise(resolve => setTimeout(resolve, 0));
    engine.display.channel = channel;
    expect(loop.tick()).toBe(channel === 'id' || channel === 'motion' ? 'finished' : 'converging');
    for (let i = 0; i < 3; i++) loop.tick();
    const target = targets[0];
    expect(loop.status).toBe('finished'); expect(loop.samples).toBe(0);
    expect(loop.final.samples).toBe(0); expect(loop.final.converged).toBe(false);
    expect(target.trace).not.toHaveBeenCalled(); expect(target.performDenoise).not.toHaveBeenCalled();
    expect(target.present).toHaveBeenCalled(); expect(target.isFirstFrame()).toBe(true);
    expect(loop.final.aovSamplesRendered).toBe(channel === 'id' || channel === 'motion' ? 1 : 2);
    expect((await loop.final.readPixels('hdr')).data).toHaveLength(0);
    camera.position = [1, 0, 0]; engine.update(); loop.tick();
    expect(loop.final.samples).toBe(0); expect(target.trace).not.toHaveBeenCalled();
    expect(vi.mocked(target.refineAovs!).mock.calls.at(-1)?.[0].position).toEqual(camera.position);
    engine.display.channel = 'final'; loop.tick();
    expect(target.trace).toHaveBeenCalledOnce(); expect(loop.final.samples).toBe(1);
    loop.dispose(); engine.dispose();
  });
  it('keeps preview selection responsive without invoking beauty or filtering', () => {
    const {engine, targets, camera} = renderFixture();
    const loop = new RenderLoop(engine, {coalesceSceneUpdates: true, preview: {aovs: ['depth']}, final: {aovs: ['depth'], aovSamples: 1}});
    engine.display.channel = 'depth'; loop.select = () => 'preview';
    loop.tick(); camera.position = [1,0,0]; loop.tick();
    expect(loop.status).toBe('previewing');
    expect(targets.every(t => !vi.mocked(t.trace).mock.calls.length)).toBe(true);
    expect(loop.preview!._completeFor('depth')).toBe(true);
    loop.select = () => 'final'; loop.tick(); expect(loop.status).toBe('finished');
    expect(loop.final.samples).toBe(0);
    loop.dispose(); engine.dispose();
  });
  it.each([false, true])('settles motion once after input changes (preview %s)', preview => {
    const {engine, camera, targets} = renderFixture();
    const loop = new RenderLoop(engine, {idleMs: 0, preview: preview ? {aovs: ['motion']} : false, final: {aovs: ['motion']}});
    engine.display.channel = 'motion';
    let moving = false;
    loop.select = () => moving && preview ? 'preview' : 'final';
    loop.tick(); loop.tick();
    const final = targets[0];
    moving = true;
    for (let i = 0; i < 3; i++) {camera.position = [i + 1, 0, 0]; loop.tick();}
    moving = false;
    const presentedRestarts: number[] = [];
    // A preview/final switch must prime final's history before presenting it.
    final.present = vi.fn(() => presentedRestarts.push(vi.mocked(final.restartAovs!).mock.calls.length));
    const restarts = vi.mocked(final.restartAovs!).mock.calls.length;
    loop.tick(); loop.tick();
    expect(final.restartAovs).toHaveBeenCalledTimes(restarts + 1);
    expect(presentedRestarts[0]).toBe(restarts + 1);
    const settled = vi.mocked(final.refineAovs!).mock.calls.length;
    for (let i = 0; i < 4; i++) loop.tick();
    expect(final.refineAovs).toHaveBeenCalledTimes(settled);
    expect(final.trace).not.toHaveBeenCalled();
    expect(loop.status).toBe('finished');
    // Externally committed edits still get a moving frame, then a static one.
    camera.position = [9, 0, 0]; engine.update();
    loop.tick(); const updated = vi.mocked(final.restartAovs!).mock.calls.length;
    loop.tick(); expect(final.restartAovs).toHaveBeenCalledTimes(updated + 1);
    loop.dispose(); engine.dispose();
  });
  it.each([false, true])('waits for motion history while shaders are pending (camera changes %s)', changing => {
    const {engine, camera, targets} = renderFixture();
    const loop = new RenderLoop(engine, {idleMs: 0, preview: {aovs: ['motion']}, final: {aovs: ['motion']}});
    engine.display.channel = 'motion'; loop.tick(); loop.tick();
    const final = targets[0], refine = final.refineAovs!;
    loop.select = () => 'preview'; camera.position = [1, 0, 0]; loop.tick();
    loop.select = () => 'final';
    final.refineAovs = vi.fn().mockReturnValueOnce(false).mockImplementationOnce(refine).mockReturnValueOnce(false).mockImplementation(refine);
    const presented = vi.mocked(final.present).mock.calls.length;
    if (changing) camera.position = [2, 0, 0];
    expect(loop.tick()).toBe('previewing');
    expect(final.present).toHaveBeenCalledTimes(presented);
    if (changing) camera.position = [3, 0, 0];
    expect(loop.tick()).toBe('previewing');
    expect(final.present).toHaveBeenCalledTimes(presented);
    expect(loop.tick()).toBe('finished');
    expect(final.present).toHaveBeenCalledTimes(presented + 1);
    loop.tick(); expect(final.refineAovs).toHaveBeenCalledTimes(4);
    loop.dispose(); engine.dispose();
  });
  it('settles a preview/final switch that coincides with a final small camera edit', () => {
    const {engine, camera, targets} = renderFixture();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const loop = new RenderLoop(engine, {preview: {aovs: ['motion'], adaptiveResolution: false}, final: {aovs: ['motion']}});
    try {
      engine.display.channel = 'motion'; loop.tick(); loop.tick();
      now.mockReturnValue(16); camera.position = [1, 0, 0]; loop.tick();
      now.mockReturnValue(32); camera.position = [2, 0, 0]; loop.tick();
      expect(loop.status).toBe('previewing');
      now.mockReturnValue(48); loop.tick();
      // Orbit damping can produce an isolated Float32 camera change after
      // consecutive changes have stopped and the idle delay has elapsed.
      const final = targets[0], restartCount = vi.mocked(final.restartAovs!).mock.calls.length;
      const presented: number[] = [];
      final.present = vi.fn(() => presented.push(vi.mocked(final.restartAovs!).mock.calls.length));
      now.mockReturnValue(200); camera.position = [2.000001, 0, 0];
      expect(loop.tick()).toBe('finished');
      expect(presented).toEqual([restartCount + 1]);
    } finally {loop.dispose(); engine.dispose(); now.mockRestore();}
  });
  it('preserves accumulated beauty and denoising when settling motion', async () => {
    const {engine, targets} = renderFixture();
    const loop = new RenderLoop(engine, {preview: false, final: {aovs: ['motion'], maxSamples: 1, denoiser: {type: 'jnlm'}}});
    await new Promise(resolve => setTimeout(resolve, 0));
    loop.tick(); const samples = loop.final.samples;
    const target = targets[0], restarts = vi.mocked(target.restartSamples).mock.calls.length;
    const cancelled = vi.mocked(target.cancelDenoise!).mock.calls.length;
    engine.display.channel = 'motion'; loop.tick(); loop.tick();
    expect(loop.final.samples).toBe(samples);
    expect(target.restartSamples).toHaveBeenCalledTimes(restarts);
    expect(target.cancelDenoise).toHaveBeenCalledTimes(cancelled);
    engine.display.channel = 'final'; loop.tick();
    expect(loop.final.samples).toBe(samples);
    expect(target.trace).toHaveBeenCalledOnce();
    loop.dispose(); engine.dispose();
  });
  it('adapts preview resolution from surface-only frames without adding beauty samples', () => {
    const {engine} = renderFixture();
    let frame!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frame = callback; return 1;});
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const render = new Render(engine, {aovs: ['depth'], adaptiveResolution: {targetFrameMs: 10, minScale: .25}});
    try {
      render.refine('depth'); const width = render.width;
      now.mockReturnValue(90); frame(90); render.refine('depth');
      expect(render.width).toBeLessThan(width); expect(render.samples).toBe(0);
    } finally {engine.dispose(); now.mockRestore(); vi.unstubAllGlobals();}
  });
  it('keeps direct refine/converge on the beauty path with an AOV display selected', async () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine, {aovs: ['depth'], maxSamples: 2});
    engine.display.channel = 'depth'; render.refine(); expect(render.samples).toBe(1);
    await render.converge({samples: 2});
    expect(render.samples).toBe(2); expect(targets[0].trace).toHaveBeenCalled(); engine.dispose();
  });
  it('validates mappings and packs integer lanes separately from float32 ranges', () => {
    const words = packAovDisplay(48, 32, 4, 'id', { ...DEFAULT_AOV_DISPLAY, idComponent: 'primitive' }, false), f = new Float32Array(words.buffer);
    expect(Array.from(words.slice(0, 4))).toEqual([48, 32, 4, 5]);
    expect(Array.from(f.slice(4, 8))).toEqual([0, 10, 1, 16]);
    expect(words[8]).toBe(3);
    for (const change of [{ depthRange: [1, 1] }, { depthRange: [-1, 2] }, { depthRange: [0, Infinity] }, { depthRange: [1, 1 + 1e-10] }, { positionScale: 0 }, { positionScale: '1' }, { positionScale: 1e40 }, { motionScale: 1e-50 }, { idComponent: 'bad' }])
      expect(() => validateAovDisplay({ ...DEFAULT_AOV_DISPLAY, ...change } as never)).toThrow();
  });
});
