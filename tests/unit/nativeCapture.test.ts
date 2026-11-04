import { describe, expect, it } from 'vitest';
import { CaptureDevice } from '../../native/validation/resource-recorder.mjs';
import { frameParameters } from '../../native/src/render-core.js';

describe('native capture buffer boundaries', () => {
  it('captures mapped-at-creation writes before later queue updates', () => {
    const device = new CaptureDevice();
    const buffer = device.createBuffer({size: 8, mappedAtCreation: true});
    new Uint32Array(buffer.getMappedRange()).set([17, 93]);
    buffer.unmap();
    expect(() => buffer.getMappedRange()).toThrow();
    device.queue.writeBuffer(buffer, 4, new Uint32Array([42]));
    expect([...new Uint32Array(buffer.data.buffer)]).toEqual([17, 42]);
  });
  it('copies TypedArray subranges using element offsets and source byteOffset', () => {
    const device = new CaptureDevice();
    const buffer = device.createBuffer({ size: 16 });
    const source = new Float32Array([99, 1, 2, 3, 88]);
    device.queue.writeBuffer(buffer, 4, source.subarray(1, 4), 1, 2);
    expect([...new Float32Array(buffer.data.buffer)]).toEqual([0, 2, 3, 0]);
    source.fill(0);
    expect([...new Float32Array(buffer.data.buffer)]).toEqual([0, 2, 3, 0]);
  });

  it('writes ArrayBuffer byte spans without extending the resource', () => {
    const device = new CaptureDevice();
    const buffer = device.createBuffer({ size: 8 });
    const data = new Uint8Array([1, 2, 3, 4]);
    device.queue.writeBuffer(buffer, 2, data.buffer, 1, 2);
    expect([...buffer.data]).toEqual([0, 0, 2, 3, 0, 0, 0, 0]);
    expect(() => device.queue.writeBuffer(buffer, 7, data)).toThrow();
  });

  it('preserves the per-frame numeric ABI and original depth normalization', () => {
    const data = frameParameters(3, 99, 0xffffffff);
    expect(data.byteLength).toBe(16);
    const view = new DataView(data.buffer);
    expect(view.getFloat32(0, true)).toBe(3);
    expect(view.getInt32(4, true)).toBe(20);
    expect(view.getUint32(8, true)).toBe(0xffffffff);
    expect(view.getUint32(12, true)).toBe(0);
    expect(new DataView(frameParameters(0, NaN, 1).buffer).getInt32(4, true)).toBe(1);
  });
});
