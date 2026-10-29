import {assertNoResearchArtifacts, assertNoProductionResearchImports} from './check-research-artifacts.mjs';
// Builds the static site deployed to Cloudflare (see wrangler.jsonc):
//   dist-site/            home page (site/)
//   dist-site/viewer/     viewer (viewer/)
//   dist-site/examples/   examples (examples/)
//   dist-site/oidn/       OIDN weights shared by the viewer and the examples
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-site');

await build({ configFile: path.join(root, 'site/vite.config.ts') });
await build({
  configFile: path.join(root, 'viewer/vite.config.ts'),
  build: { outDir: path.join(out, 'viewer') }
});
await build({ configFile: path.join(root, 'examples/vite.config.ts') });

// The viewer build emits the weights at its root; the site serves them at /oidn/weights/.
rmSync(path.join(out, 'oidn'), { recursive: true, force: true });
renameSync(path.join(out, 'viewer/oidn'), path.join(out, 'oidn'));
// three.ts loads this at run time, so Vite does not copy it.
mkdirSync(path.join(out, 'examples/assets'), { recursive: true });
copyFileSync(path.join(root, 'examples/assets/chess.glb'), path.join(out, 'examples/assets/chess.glb'));

assertNoProductionResearchImports(root);
assertNoResearchArtifacts(out);
