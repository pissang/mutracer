import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { shaderFormattingPlugin } from '../scripts/shader-formatting.mjs';

const repoRoot = path.resolve(__dirname, '..');
const weightsDir = path.join(repoRoot, 'oidn/weights');

/**
 * Serves the repository's OIDN weights at `/oidn/weights/` and copies them
 * into the build. The CDN copy only exists for published versions.
 */
function oidnWeights(): Plugin {
  return {
    name: 'mutracer-viewer-oidn-weights',
    configureServer(server) {
      server.middlewares.use('/oidn/weights/', (req, res, next) => {
        const file = path.join(weightsDir, path.basename((req.url ?? '').split('?')[0]));
        if (!file.endsWith('.tza') || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of readdirSync(weightsDir)) {
        if (!name.endsWith('.tza')) continue;
        this.emitFile({ type: 'asset', fileName: `oidn/weights/${name}`, source: readFileSync(path.join(weightsDir, name)) });
      }
    }
  };
}

/**
 * Development only: saves thumbnails posted by `generateThumbnails()` (see
 * src/dev/thumbnails.ts) into src/assets/thumbnails/. Loopback requests only.
 */
function thumbnailWriter(): Plugin {
  const dir = path.join(__dirname, 'src/assets/thumbnails');
  return {
    name: 'mutracer-viewer-thumbnail-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__thumbnails/', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '');
        const loopback = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '');
        if (req.method !== 'POST' || !loopback || !/^[a-z0-9-]+\.webp$/.test(name)) return next();
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    }
  };
}

export default defineConfig({
  root: __dirname,
  publicDir: path.join(repoRoot, 'site/public'),
  base: './',
  plugins: [react(), shaderFormattingPlugin(), oidnWeights(), thumbnailWriter()],
  resolve: {
    alias: [
      { find: /^@meimu\/mutracer\/oidn$/, replacement: path.join(repoRoot, 'src/oidn.ts') },
      { find: /^@meimu\/mutracer$/, replacement: path.join(repoRoot, 'src/main.ts') }
    ]
  },
  server: {
    host: true,
    port: 3012,
    fs: { allow: [repoRoot] }
  },
  build: {
    outDir: path.join(repoRoot, 'dist-viewer'),
    emptyOutDir: true,
    target: 'es2022'
  },
  worker: { format: 'es' },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' }
  }
});
