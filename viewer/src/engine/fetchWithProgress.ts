class DownloadError extends Error {
  constructor(readonly status: number, url: string, statusText: string) {
    super(`${status} ${statusText || 'request failed'}: ${url}`);
  }
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function isTransientDownloadError(error: unknown) {
  return error instanceof DownloadError
    ? error.status === 408 || error.status === 429 || error.status >= 500 && error.status <= 599
    : error instanceof TypeError;
}

/** Fetches bytes with bounded retries, including a mirror for research scenes. */
export async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const parsed = new URL(url, 'https://localhost/');
  const githubRaw = parsed.protocol === 'https:' && parsed.hostname === 'raw.githubusercontent.com';
  const researchPath = githubRaw && parsed.pathname.match(/^(\/ErfanMo77\/gltf-research-scenes)\/([^/]+)(\/scenes\/.+)$/);
  let bytes: ArrayBuffer;
  try {
    bytes = await fetchWithRetries(url, onProgress, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (!researchPath || !isTransientDownloadError(error)) throw error;
    const [, repo, ref, path] = researchPath;
    onProgress?.(0, 0);
    bytes = await fetchWithRetries(`https://cdn.jsdelivr.net/gh${repo}@${ref}${path}${parsed.search}`, onProgress, signal);
  }
  // Both origins can return an LFS pointer. Resolve it using the original
  // GitHub path so the glTF resource base and cache keys stay canonical.
  if (githubRaw && bytes.byteLength < 1024 &&
    /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\noid sha256:[a-f0-9]{64}\r?\nsize \d+\s*$/.test(new TextDecoder().decode(bytes))) {
    onProgress?.(0, 0);
    return fetchWithRetries(`https://media.githubusercontent.com/media${parsed.pathname}${parsed.search}`, onProgress, signal);
  }
  return bytes;
}

async function fetchWithRetries(
  url: string,
  onProgress: ((loaded: number, total: number) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fetchOnce(url, onProgress, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!isTransientDownloadError(error) || attempt === 2) throw error;
      await retryDelay(attempt === 0 ? 250 : 750, signal);
      onProgress?.(0, 0);
    }
  }
}

async function fetchOnce(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DownloadError(response.status, url, response.statusText);
  }
  const length = Number(response.headers.get('content-length'));
  const total = Number.isSafeInteger(length) && length > 0 ? length : 0;
  if (!response.body || !onProgress) return response.arrayBuffer();
  const reader = response.body.getReader();
  // Content-Length describes compressed bytes when an encoding is present.
  // Otherwise write directly into the final allocation, retaining no chunk list.
  const encoded = response.headers.get('content-encoding');
  let out = new Uint8Array(!encoded || encoded === 'identity' ? total : 0);
  let loaded = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const required = loaded + value.byteLength;
      if (required > out.byteLength) {
        const capacity = Math.max(required, out.byteLength * 2, 65536);
        // transfer can move the backing store; the fallback supports older browsers.
        if (typeof out.buffer.transfer === 'function') out = new Uint8Array(out.buffer.transfer(capacity));
        else {const next = new Uint8Array(capacity); next.set(out); out = next;}
      }
      out.set(value, loaded);
      loaded = required;
      onProgress(loaded, total);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (loaded === out.byteLength) return out.buffer;
  return typeof out.buffer.transfer === 'function' ? out.buffer.transfer(loaded) : out.buffer.slice(0, loaded);
}
