import {build} from 'esbuild';
import {chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const fromHere = path => fileURLToPath(new URL(path, import.meta.url));
const outfile = fromHere('./dist/main.mjs');
await build({
  entryPoints: [fromHere('./src/main.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['three', 'three/*'],
  banner: {js: '#!/usr/bin/env node'},
});
await chmod(outfile, 0o755);
