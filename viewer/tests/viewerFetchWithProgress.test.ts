import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithProgress } from '../src/engine/fetchWithProgress';

const sample = 'https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/yamaha-mt-09/model.glb';

describe('viewer downloads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('recovers from a temporary 503 and reports the successful download', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }));
    vi.stubGlobal('fetch', fetchMock);
    const progress = vi.fn();
    const result = fetchWithProgress(sample, progress);
    await vi.runAllTimersAsync();
    expect(new Uint8Array(await result)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([sample, sample]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it('retries the same GitHub path and ref after transient failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('model'));
    vi.stubGlobal('fetch', fetchMock);
    const pinned = sample.replace('/main/', '/v0.1.0/');
    const result = fetchWithProgress(pinned);
    await vi.runAllTimersAsync();
    expect(new TextDecoder().decode(await result)).toBe('model');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([pinned, pinned, pinned]);
  });

  it('does not retry missing files', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithProgress(sample)).rejects.toThrow(`404 request failed: ${sample}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  const lfsRaw = 'https://raw.githubusercontent.com/ErfanMo77/gltf-research-scenes/main/scenes/test/mesh.bin';
  const lfsMedia = lfsRaw.replace('raw.githubusercontent.com/', 'media.githubusercontent.com/media/');
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 3\n`;

  it('resolves GitHub LFS pointers and reports progress for the real payload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(pointer))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }));
    vi.stubGlobal('fetch', fetchMock);
    const progress = vi.fn();
    expect(new Uint8Array(await fetchWithProgress(lfsRaw, progress))).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([lfsRaw, lfsMedia]);
    expect(progress).toHaveBeenCalledWith(0, 0);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it('retries the LFS media download after a transient failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(pointer))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('abc'));
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchWithProgress(lfsRaw);
    await vi.runAllTimersAsync();
    expect(new TextDecoder().decode(await result)).toBe('abc');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([lfsRaw, lfsMedia, lfsMedia]);
  });

  it('leaves LFS-like contents from other servers untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(pointer));
    vi.stubGlobal('fetch', fetchMock);
    expect(new TextDecoder().decode(await fetchWithProgress('https://example.com/mesh.bin'))).toBe(pointer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    sample,
    'https://cdn.jsdelivr.net/gh/another/repo@main/model.glb',
    'https://example.com/model.glb'
  ])('limits failures to three attempts for %s', async (url) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const failure = expect(fetchWithProgress(url)).rejects.toThrow('503');
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchMock.mock.calls.map(([address]) => address)).toEqual([url, url, url]);
  });

  it('cancels a pending retry immediately when the caller aborts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const failure = expect(fetchWithProgress(sample, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await failure;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an aborted fetch', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithProgress(sample)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('discards partial bytes and resets progress after a stream failure', async () => {
    let reads = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new Uint8Array([9]));
        else controller.error(new TypeError('Connection closed'));
      }
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(broken))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]))));
    const progress = vi.fn();
    const result = fetchWithProgress(sample, progress);
    await vi.runAllTimersAsync();
    expect(new Uint8Array(await result)).toEqual(new Uint8Array([1, 2]));
    expect(progress.mock.calls).toEqual([[1, 0], [0, 0], [2, 0]]);
  });
  it.each([
    ['6', undefined], ['0', undefined], ['2', undefined], ['12', undefined], ['2', 'gzip']
  ])('assembles multiple chunks with length %s and encoding %s', async (length, encoding) => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
    const body = new ReadableStream<Uint8Array>({start(c) {for (const chunk of chunks) c.enqueue(chunk); c.close();}});
    const headers = new Headers({'content-length': length}); if (encoding) headers.set('content-encoding', encoding);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {headers})));
    const progress = vi.fn();
    expect([...new Uint8Array(await fetchWithProgress(sample, progress))]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress).toHaveBeenLastCalledWith(6, Number(length));
  });
  it('cancels the body if a progress callback stops the download', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({start(c) {c.enqueue(new Uint8Array([1]));}, cancel});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {headers: {'content-length': '4'}})));
    await expect(fetchWithProgress(sample, () => {throw Error('Stop');})).rejects.toThrow('Stop');
    expect(cancel).toHaveBeenCalledOnce();
  });

});
