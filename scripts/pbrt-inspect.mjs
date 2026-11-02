import { createServer } from 'vite';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function withPbrt(run) {
  const server = await createServer({ root, configFile: false, optimizeDeps: { disabled: true }, server: { middlewareMode: true, watch: { ignored: ['**/*'] } }, appType: 'custom' });
  try { return await run(await server.ssrLoadModule('/tools/pbrt/source.ts')); }
  finally { await server.close(); }
}
export function nodeResolver() {
  return {
    async read(path) { const b = await readFile(path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async size(path) { return (await stat(path)).size; }
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) { console.error('Usage: npm run pbrt:inspect -- <path-or-url>'); process.exitCode = 1; }
  else await withPbrt(async ({ inspect, urlResolver }) => {
    const url = /^https?:\/\//.test(input);
    console.log(JSON.stringify(await inspect(url ? input : resolve(input), url ? urlResolver() : nodeResolver()), null, 2));
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
