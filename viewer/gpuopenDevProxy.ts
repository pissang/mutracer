import type { Plugin } from 'vite';
import { proxyGpuOpen, GPUOPEN_PREFIX } from '../site/src/gpuopenProxy';

/** The same restricted gateway as production, with no local Worker required. */
export function gpuOpenDevProxy(): Plugin {
  return {
    name: 'gpuopen-dev-proxy', apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(GPUOPEN_PREFIX)) return next();
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        void (async () => {
          const response = await proxyGpuOpen(new Request(new URL(req.url!, 'http://localhost'), {
            method: req.method, signal: controller.signal
          }));
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body) {
            const reader = response.body.getReader();
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (!res.write(chunk.value)) await new Promise<void>(resolve => {
                  res.once('drain', resolve);
                  res.once('close', resolve);
                });
              }
            } finally { await reader.cancel().catch(() => {}); }
          }
          res.end();
        })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); });
      });
    }
  };
}
