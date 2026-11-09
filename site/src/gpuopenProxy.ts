// A closed read-only gateway, shared by the Worker and Vite development server.
// Never accept a caller-provided upstream URL or forward caller credentials.
const API = 'https://api.matlib.gpuopen.com';
export const GPUOPEN_PREFIX = '/api/gpuopen/';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const detail = new RegExp(`^(packages|renders)/${UUID}/$`, 'i');
const download = new RegExp(`^(packages/${UUID}/download|renders/${UUID}/download_(thumbnail|preview))/$`, 'i');
const lists = new Set(['materials/', 'categories/', 'tags/', 'licenses/']);

export function gpuOpenUpstream(url: URL): URL | null {
  if (!url.pathname.startsWith(GPUOPEN_PREFIX)) return null;
  const path = url.pathname.slice(GPUOPEN_PREFIX.length);
  if (!lists.has(path) && !detail.test(path) && !download.test(path)) return null;
  const target = new URL(`/api/${path}`, API);
  for (const [key, value] of url.searchParams) {
    if (!lists.has(path) || !['limit', 'offset'].includes(key) || target.searchParams.has(key) || !/^\d{1,5}$/.test(value)) return null;
    const n = Number(value);
    if (key === 'limit' && (n < 1 || n > 1000) || key === 'offset' && n > 10000) return null;
    target.searchParams.set(key, String(n));
  }
  return target;
}

/** Redirects are confined to the requested resource's CDN, including every hop. */
export function gpuOpenRedirect(url: URL, kind: 'json' | 'zip' | 'image'): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && (
    url.origin === API && gpuOpenUpstream(new URL(`${GPUOPEN_PREFIX}${url.pathname.slice(5)}${url.search}`, 'https://local.test')) !== null &&
      url.pathname.startsWith('/api/') ||
    kind === 'zip' && url.hostname === 'media.matlib.gpuopen.com' ||
    kind === 'image' && url.hostname === 'image.matlib.gpuopen.com'
  );
}

const errorResponse = (message: string, status: number) => new Response(message, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
});

export async function proxyGpuOpen(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'GET') return new Response('Use GET', { status: 405, headers: { Allow: 'GET' } });
  const upstream = gpuOpenUpstream(new URL(request.url));
  if (!upstream) return errorResponse('Unknown GPUOpen resource', 400);
  const kind = /packages\/.+\/download\/$/.test(upstream.pathname) ? 'zip'
    : /download_(thumbnail|preview)\/$/.test(upstream.pathname) ? 'image' : 'json';
  const maxBytes = (kind === 'zip' ? 128 : kind === 'image' ? 16 : 2) * 1048576;
  const ttl = kind === 'json' ? 3600 : 86400;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)]);
  try {
    let url = upstream;
    let response: Response;
    for (let hops = 0; ; hops++) {
      response = await fetcher(url, {
        redirect: 'manual', signal, headers: { Accept: kind === 'json' ? 'application/json' : '*/*', 'User-Agent': 'MuTracer/1.0 (+https://mutracer.meimu-studio.com)' }
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || hops >= 3) return errorResponse('Invalid upstream redirect', 502);
      url = new URL(location, url);
      if (!gpuOpenRedirect(url, kind)) return errorResponse('Blocked upstream redirect', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      return errorResponse(`GPUOpen request failed (${response.status})`, response.status === 404 ? 404 : 502);
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      return errorResponse('Package exceeds the download limit (128 MB)', 413);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (kind === 'json' && !contentType.includes('json') || kind === 'image' && !/^image\/(jpeg|png|webp)/.test(contentType)) {
      await response.body?.cancel();
      return errorResponse('Unexpected GPUOpen response', 502);
    }
    // Count decoded bytes too; Content-Length may be missing or describe compressed data.
    const reader = response.body?.getReader();
    let bytes = 0;
    const body = reader ? new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { reader.releaseLock(); controller.close(); return; }
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new Error('GPUOpen response exceeds the size limit');
          controller.enqueue(chunk.value);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) { return reader.cancel(reason); }
    }) : null;
    const headers = new Headers({
      'Content-Type': kind === 'zip' ? 'application/zip' : contentType,
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Content-Type-Options': 'nosniff'
    });
    const length = response.headers.get('content-length');
    if (length && !response.headers.has('content-encoding')) headers.set('Content-Length', length);
    return new Response(body, { headers });
  } catch {
    return errorResponse('Could not reach GPUOpen', 502);
  }
}
