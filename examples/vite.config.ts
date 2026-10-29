import path from 'node:path';
import { defineConfig } from 'vite';
import { shaderFormattingPlugin } from '../scripts/shader-formatting.mjs';

const repoRoot = path.resolve(__dirname, '..');
const pages = ['index', 'basic', 'three', 'animation', 'advanced', 'instancing', 'caustics'];

/**
 * Static build of the examples for the site (`npm run build:site`). During
 * development `npm run dev` serves them from the repository root instead.
 */
export default defineConfig({
  plugins: [shaderFormattingPlugin()],
  root: __dirname,
  base: './',
  // assets/ holds the runtime-loaded chess.glb; the build script copies it.
  publicDir: false,
  resolve: {
    alias: [
      { find: /^@meimu\/mutracer\/oidn$/, replacement: path.join(repoRoot, 'src/oidn.ts') },
      { find: /^@meimu\/mutracer$/, replacement: path.join(repoRoot, 'src/main.ts') }
    ]
  },
  build: {
    outDir: path.join(repoRoot, 'dist-site/examples'),
    emptyOutDir: true,
    assetsDir: 'bundle',
    target: 'es2022',
    rollupOptions: {
      input: Object.fromEntries(pages.map((name) => [name, path.join(__dirname, `${name}.html`)]))
    }
  }
});
