import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withPbrt, nodeResolver } from './pbrt-inspect.mjs';
const exec = promisify(execFile);
const commit = '30cf4a0346ae5a80a2d7a530a3ef7d0fa4f70572';
const cache = process.env.PBRT_SCENES_CACHE ?? `${process.env.HOME}/.codex/cache/pbrt-v4-scenes`;
const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/pbrt-catalog.mjs <evidence-directory>');
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
const treeFile = join(cache, 'tree.json');
try { await readFile(treeFile); } catch {
  await exec('curl', ['-fsSL', '--retry', '3', `https://api.github.com/repos/mmp/pbrt-v4-scenes/git/trees/${commit}?recursive=1`, '-o', treeFile]);
}
const tree = JSON.parse(await readFile(treeFile, 'utf8'));
if (tree.sha !== commit || tree.truncated) throw new Error('Expected complete pinned GitHub tree');
const entries = tree.tree.filter((item) => item.type === 'blob');
const files = entries.filter((item) => /\.pbrt(?:\.gz)?$/.test(item.path));
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < files.length) {
    const item = files[next++], path = join(cache, commit, item.path);
    try { if ((await readFile(path)).byteLength === item.size) continue; } catch { /* download */ }
    await mkdir(dirname(path), { recursive: true });
    await exec('curl', ['-fsSL', '--retry', '3', '--max-time', '180', `https://raw.githubusercontent.com/mmp/pbrt-v4-scenes/${commit}/${item.path}`, '-o', `${path}.part`]);
    if ((await readFile(`${path}.part`)).byteLength !== item.size) throw new Error(`Wrong size: ${item.path}`);
    await rename(`${path}.part`, path);
    console.error(`cached ${item.path}`);
  }
}));
await withPbrt(async ({ inspect }) => {
  const sizes = new Map(entries.map((item) => [join(cache, commit, item.path), item.size]));
  const resolver = { ...nodeResolver(), size: async (path) => sizes.get(path) };
  const reports = [], catalog = [];
  for (const item of files.filter((item) => /^[^/]+\/[^/]+\.pbrt$/.test(item.path))) {
    try {
      const result = await inspect(join(cache, commit, item.path), resolver);
      const prefix = `${join(cache, commit)}/`;
      result.entry = item.path;
      for (const r of result.resources) r.path = r.path.replace(prefix, '');
      for (const w of result.warnings) w.file = w.file.replace(prefix, '');
      reports.push(result);
      // Include/material fragments are inspected, but cannot be opened as scenes.
      if (result.features.statements.Camera && result.features.statements.WorldBegin) catalog.push({
        path: item.path, group: item.path.split('/')[0], bytes: result.totalBytes, unknownSizes: result.unknownSizes,
        resources: result.resources.map(({path}) => path)
      });
      console.error(`inspected ${item.path}: ${result.totalBytes} bytes, ${result.unknownSizes} unknown`);
    } catch (error) { reports.push({ entry: item.path, error: error.message }); console.error(error.message); }
  }
  await writeFile(join(output, 'inventory.json'), JSON.stringify({ commit, reports }, null, 2) + '\n');
  await mkdir('viewer/src/engine', { recursive: true });
  const used = new Set(catalog.flatMap((scene) => scene.resources));
  const sizesByPath = Object.fromEntries(entries.filter((file) => used.has(file.path)).map((file) => [file.path, file.size]));
  await writeFile('viewer/src/engine/pbrt-catalog.json', JSON.stringify({ commit, scenes: catalog.map(({resources, ...scene}) => scene), sizes: sizesByPath }, null, 2) + '\n');
});
