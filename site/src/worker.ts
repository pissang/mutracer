import { GPUOPEN_PREFIX, proxyGpuOpen } from './gpuopenProxy';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith(GPUOPEN_PREFIX)) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return proxyGpuOpen(request);
    const key = new Request(request.url);
    const cache = caches.default;
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await proxyGpuOpen(request);
    if (response.ok) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    return response;
  }
};
