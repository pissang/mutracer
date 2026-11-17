import {mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm, realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {build as viteBuild} from 'vite';
import {build as esbuild} from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const allowed = new Set(Object.keys({...manifest.dependencies, ...manifest.peerDependencies}));
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
async function* files(dir) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(filename);
    else yield filename;
  }
}
// Scan emitted runtime code, including modules unreachable from today's fixtures.
// AST traversal also catches import() and re-exports without mistaking shader text for JS.
for await (const file of files(path.join(root, 'lib'))) {
  if (!file.endsWith('.js')) continue;
  const ast = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const name = specifier.text;
      if (!name.startsWith('.') && !name.startsWith('/') && !allowed.has(packageName(name))) {
        throw new Error(`Undeclared runtime dependency ${JSON.stringify(name)} in ${path.relative(root, file)}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

const fixtures = {
  engine: "import {Engine} from '@meimu/mutracer'; globalThis.fixture = new Engine();",
  application: "import {Engine, Render, RenderLoop, THREESync, fromTHREEScene} from '@meimu/mutracer'; globalThis.fixture = [new Engine(), Render, RenderLoop, THREESync, fromTHREEScene];",
  scene: "import {Mesh, OpenPBRMaterial, Geometry} from '@meimu/mutracer'; globalThis.fixture = [Mesh, OpenPBRMaterial, Geometry];",
  namespace: "import * as mutracer from '@meimu/mutracer'; globalThis.fixture = mutracer;"
};
const outputIndex = process.argv.indexOf('--output');
const keep = outputIndex !== -1;
if (keep && !process.argv[outputIndex + 1]) throw new Error('--output requires a directory');
const scratch = keep ? path.resolve(process.argv[outputIndex + 1]) : await realpath(await mkdtemp(path.join(os.tmpdir(), 'mutracer-consumer-'))); // Vite compares real paths (/var -> /private/var on macOS).
await mkdir(scratch, {recursive: true});
const modules = path.join(scratch, 'node_modules');
await mkdir(path.join(modules, '@meimu'), {recursive: true});
await rm(path.join(modules, '@meimu/mutracer'), {force: true, recursive: true});
await symlink(root, path.join(modules, '@meimu/mutracer'), 'dir');
// Only declared dependencies can be resolved through these links. Three is an
// optional peer, kept external to measure MuTracer independently of its version.
for (const name of Object.keys(manifest.dependencies)) {
  const dest = path.join(modules, name);
  await mkdir(path.dirname(dest), {recursive: true});
  await rm(dest, {recursive: true, force: true});
  await symlink(path.join(root, 'node_modules', name), dest, 'dir');
}
const external = name => name === 'three' || name.startsWith('three/');
const report = {};
try {
  for (const [name, source] of Object.entries(fixtures)) {
    const fixture = path.join(scratch, name);
    await mkdir(fixture, {recursive: true});
    await writeFile(path.join(fixture, 'main.js'), source);
    await writeFile(path.join(fixture, 'index.html'), '<script type="module" src="./main.js"></script>');
    for (const bundler of ['vite', 'esbuild']) {
      const outdir = path.join(fixture, bundler);
      await rm(outdir, {recursive: true, force: true});
      let main, staticChunks = new Set();
      if (bundler === 'vite') {
        const result = await viteBuild({
          configFile: false, root: fixture, logLevel: 'error',
          build: {target: 'es2022', outDir: outdir, assetsInlineLimit: 0,
            rollupOptions: {external}, minify: 'esbuild', reportCompressedSize: false}
        });
        const chunks = result.output.filter(item => item.type === 'chunk');
        main = chunks.find(item => item.isEntry).fileName;
        const visit = filename => {
          if (staticChunks.has(filename)) return;
          staticChunks.add(filename);
          chunks.find(item => item.fileName === filename)?.imports.forEach(visit);
        };
        visit(main);
        await writeFile(path.join(fixture, 'vite-modules.json'), JSON.stringify(Object.fromEntries(
          chunks.map(chunk => [chunk.fileName, chunk.modules])), null, 2));
      } else {
        // esbuild leaves new URL() untouched. Bundle worker entries explicitly
        // and copy URL assets, matching Vite's worker/asset semantics. Validate
        // every URL against disk so missing packaged files fail in both builds.
        const pending = new Map();
        const urls = {name: 'consumer-url-assets', setup(build) {
          build.onLoad({filter: /\.js$/}, async args => {
            const code = await readFile(args.path, 'utf8');
            const edits = [];
            const ast = ts.createSourceFile(args.path, code, ts.ScriptTarget.Latest, true);
            function visit(node) {
              if (ts.isNewExpression(node) && node.expression.getText(ast) === 'URL' && node.arguments?.length === 2 &&
                  ts.isStringLiteralLike(node.arguments[0]) && node.arguments[1].getText(ast) === 'import.meta.url' &&
                  node.arguments[0].text.startsWith('.')) {
                edits.push({start: node.arguments[0].getStart(ast), end: node.arguments[0].end, relative: node.arguments[0].text});
              }
              ts.forEachChild(node, visit);
            }
            visit(ast);
            for (const edit of edits) {
              const target = path.resolve(path.dirname(args.path), edit.relative);
              const filename = `${path.basename(target, path.extname(target))}-${createHash('sha256').update(target).digest('hex').slice(0, 8)}${path.extname(target)}`;
              if (!pending.has(target)) pending.set(target, (async () => {
                if (target.endsWith('.js')) {
                  const worker = await esbuild({entryPoints: [target], bundle: true, splitting: true, format: 'esm', target: 'es2022', minify: true,
                    outdir, entryNames: filename.slice(0, -3), chunkNames: 'worker-[name]-[hash]', external: ['three', 'three/*'], plugins: [urls], metafile: true});
                  await writeFile(path.join(fixture, `${filename}.meta.json`), JSON.stringify(worker.metafile, null, 2));
                } else {
                  await mkdir(outdir, {recursive: true});
                  await writeFile(path.join(outdir, filename), await readFile(target));
                }
              })());
              await pending.get(target);
              edit.text = JSON.stringify(`./${filename}`);
            }
            let contents = code;
            for (const edit of edits.reverse()) contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
            return {contents, loader: 'js', resolveDir: path.dirname(args.path)};
          });
        }};
        const result = await esbuild({absWorkingDir: fixture, entryPoints: ['main.js'], bundle: true, splitting: true, format: 'esm',
          target: 'es2022', minify: true, outdir, external: ['three', 'three/*'], plugins: [urls], metafile: true});
        main = 'main.js';
        const visit = filename => {
          if (staticChunks.has(filename)) return;
          staticChunks.add(filename);
          const output = Object.entries(result.metafile.outputs).find(([key]) => path.resolve(fixture, key) === path.join(outdir, filename))?.[1];
          output?.imports.filter(item => item.kind === 'import-statement' && !item.external)
            .forEach(item => visit(path.relative(outdir, path.resolve(fixture, item.path))));
        };
        visit(main);
        await writeFile(path.join(fixture, 'esbuild-meta.json'), JSON.stringify(result.metafile, null, 2));
      }
      const outputs = [];
      for await (const file of files(outdir)) {
        const relative = path.relative(outdir, file);
        if (relative.endsWith('.html')) continue;
        const data = await readFile(file);
        outputs.push({file: relative, kind: relative === main ? 'main' : staticChunks.has(relative) ? 'static' : relative.endsWith('.js') ? 'lazy/worker' : 'asset',
          bytes: data.length, gzip: gzipSync(data).length});
      }
      outputs.sort((a, b) => a.file.localeCompare(b.file));
      report[`${bundler}/${name}`] = outputs;
      console.log(`\n${bundler}/${name}`);
      for (const item of outputs) console.log(`  ${item.kind.padEnd(11)} ${item.file}: ${item.bytes} B (gzip ${item.gzip} B)`);
    }
  }
  await writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\nConsumer bundles resolve; all lib runtime dependencies are declared.');
} finally {
  if (!keep) await rm(scratch, {recursive: true, force: true});
}
