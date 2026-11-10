import {describe, expect, it, vi} from 'vitest';
import {NativeTransport, pointerPacket} from '../src/engine/nativeTransport';

describe('native viewer transport', () => {
  it('correlates out-of-order replies and publishes unsolicited events', async () => {
    const send = vi.fn(), event = vi.fn();
    const transport = new NativeTransport(send, event);
    const first = transport.request<number>('first'), second = transport.request<string>('second');
    const one = JSON.parse(send.mock.calls[0][0]), two = JSON.parse(send.mock.calls[1][0]);
    expect(one).toMatchObject({version: 1, command: 'first', args: {}});
    transport.receive({event: 'stats', value: {samples: 16}});
    transport.receive({id: two.id, result: 'done'}); transport.receive({id: one.id, result: 7});
    await expect(first).resolves.toBe(7); await expect(second).resolves.toBe('done');
    expect(event).toHaveBeenCalledWith('stats', {samples: 16});
    transport.dispose();
  });
  it('rejects host errors, disposal and timeouts', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(), transport = new NativeTransport(send, vi.fn());
      const failed = transport.request('edit');
      const failure = expect(failed).rejects.toThrow('Unknown material');
      transport.receive({id: JSON.parse(send.mock.calls[0][0]).id, error: 'Unknown material'}); await failure;
      const pending = transport.request('capture'), disposal = expect(pending).rejects.toThrow('disposed');
      transport.dispose(); await disposal;
      await expect(transport.request('afterDispose')).rejects.toThrow('disposed');
      const next = new NativeTransport(send, vi.fn());
      const timed = expect(next.request('load')).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(120_000); await timed; next.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('encodes pointer input as five little-endian float32 words without JSON', () => {
    const packet = pointerPacket(1, 123.5, -4.25, 2, 1);
    expect(packet[0]).toBe('~');
    const bytes = Uint8Array.from(atob(packet.slice(1)), c => c.charCodeAt(0));
    expect(bytes.length).toBe(20);
    const view = new DataView(bytes.buffer);
    expect(Array.from({length: 5}, (_, i) => view.getFloat32(i * 4, true))).toEqual([1, 123.5, -4.25, 2, 1]);
  });
});
