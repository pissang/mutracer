import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import Render from '../../src/Render';
import {renderFixture} from '../helpers/renderPipeline';

const example = readFileSync(new URL('../../docs/progressive-rendering.md', import.meta.url), 'utf8')
  .split('<!-- own-loop-refill -->')[1].match(/```js\n([\s\S]*?)```/)![1];

describe('copyable progressive loop example', () => {
  it.each(['complete', 'empty', 'input', 'hidden', 'deadline'] as const)('refills tiled work and stops on %s', async reason => {
    const {engine, targets} = renderFixture({tiles: 3});
    const render = new Render(engine, {batchSamples: true});
    render.refine(); render.refine(); render.refine();
    const listeners = new Map<string, () => void>();
    const frames: ((timestamp: number) => void)[] = [];
    const document = {hidden: false}; let now = 0;
    let queued = true, calls = 0;
    Object.assign(targets[0], {getRealtimeSampleTime: () => 120, getRealtimeTileTime: () => 20,
      whenTraceAvailable: async () => {
        calls++;
        if (reason === 'input') listeners.get('pointerdown')!();
        if (reason === 'hidden') document.hidden = true;
        if (reason === 'deadline') now = 20;
        return reason === 'empty' ? false : queued;
      }});
    const refine = vi.spyOn(render, 'refine').mockImplementation((...args) => {
      // The frame starts tile one; two refills finish it, then no sampling remains.
      const result = Render.prototype.refine.apply(render, args);
      if (render.samples === 2) queued = false;
      return result;
    });
    new Function('engine', 'render', 'document', 'requestAnimationFrame', 'addEventListener', 'performance', example)(
      engine, render, document, (frame: (timestamp: number) => void) => frames.push(frame),
      (name: string, listener: () => void) => listeners.set(name, listener), {now: () => now});
    frames.shift()!(0);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(render.samples).toBe(reason === 'complete' ? 2 : 1);
    expect(refine).toHaveBeenCalledTimes(reason === 'complete' ? 3 : 1);
    expect(calls).toBe(reason === 'complete' ? 3 : 1);
    engine.dispose();
  });
});
