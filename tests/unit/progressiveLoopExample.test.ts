import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import Render from '../../src/Render';
import {renderFixture} from '../helpers/renderPipeline';

const example = readFileSync(new URL('../../docs/progressive-rendering.md', import.meta.url), 'utf8')
  .split('<!-- own-loop-refill -->')[1].match(/```js\n([\s\S]*?)```/)![1];
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('copyable progressive loop example', () => {
  it.each(['complete', 'empty', 'input', 'hidden', 'deadline', 'pause', 'next-frame'] as const)('refills tiled work and stops on %s', async reason => {
    const {engine, targets} = renderFixture({tiles: 3});
    const render = new Render(engine, {batchSamples: true});
    render.refine(); render.refine(); render.refine();
    const listeners = new Map<string, () => void>();
    const frames: ((timestamp: number) => void)[] = [];
    const document = new EventTarget() as EventTarget & {hidden: boolean}; document.hidden = false;
    vi.stubGlobal('document', document);
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    let queued = true, calls = 0;
    let pause!: () => void;
    Object.assign(targets[0], {getRealtimeSampleTime: () => 120, getRealtimeTileTime: () => 20,
      whenTraceAvailable: async () => {
        calls++;
        if (reason === 'pause') pause();
        if (reason === 'input') listeners.get('pointerdown')!();
        if (reason === 'hidden') {document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));}
        if (reason === 'deadline') now = 20;
        return reason === 'empty' ? false : queued;
      }});
    const refine = vi.spyOn(render, 'refine').mockImplementation((...args) => {
      const result = Render.prototype.refine.apply(render, args);
      if (render.samples === 2) queued = false;
      return result;
    });
    pause = new Function('engine', 'render', 'requestAnimationFrame', 'addEventListener', example + '\nreturn stop;')(
      engine, render, (frame: (timestamp: number) => void) => frames.push(frame),
      (name: string, listener: () => void) => listeners.set(name, listener));
    frames.shift()!(0);
    if (reason === 'next-frame') frames.shift()!(0);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(render.samples).toBe(reason === 'complete' || reason === 'next-frame' ? 2 : 1);
    expect(refine).toHaveBeenCalledTimes(reason === 'complete' || reason === 'next-frame' ? 3 : 1);
    expect(calls).toBe(reason === 'complete' || reason === 'next-frame' ? 3 : 1);
    pause(); engine.dispose();
  });
});
