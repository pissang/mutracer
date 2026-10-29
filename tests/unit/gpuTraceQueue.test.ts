import {describe, expect, it} from 'vitest';
import {GPUTraceQueue} from '../../src/renderer/GPUTraceQueue';

describe('GPU trace backpressure', () => {
  it('wakes as soon as one sample frees capacity while the rest of the queue still runs', async () => {
    const complete: (() => void)[] = [];
    const queue = new GPUTraceQueue({onSubmittedWorkDone: () => new Promise<void>(resolve => complete.push(resolve))} as GPUQueue);
    await queue.whenAvailable(); expect(queue.hasPending).toBe(false);
    queue.track(2); queue.track(3); const ready = queue.whenAvailable();
    expect(queue.hasPending).toBe(true);
    expect(queue.available(8)).toBe(3);
    complete[0](); await ready; expect(queue.available(8)).toBe(5);
    expect(queue.hasPending).toBe(true);
    complete[1](); await queue.whenAvailable(); expect(queue.available(8)).toBe(8);
    expect(queue.hasPending).toBe(false);
  });
  it('drops rounding residue once every fence retires, so an empty queue admits a full-budget sample', async () => {
    const complete: (() => void)[] = [];
    const queue = new GPUTraceQueue({onSubmittedWorkDone: () => new Promise<void>(resolve => complete.push(resolve))} as GPUQueue);
    queue.track(.1); queue.track(.2);
    complete[0](); complete[1](); await queue.whenAvailable(); await Promise.resolve();
    expect(queue.available(4)).toBe(4);
  });
  it('retires failed fences too, so device loss cannot leave the queue permanently full', async () => {
    let reject!: (reason: Error) => void;
    const queue = new GPUTraceQueue({onSubmittedWorkDone: () => new Promise((_resolve, fail) => {reject = fail;})} as GPUQueue);
    queue.track(8); expect(queue.available(10)).toBe(2);
    reject(new Error('device lost')); await Promise.resolve();
    expect(queue.hasPending).toBe(false);
    expect(queue.available(10)).toBe(10);
  });
});

