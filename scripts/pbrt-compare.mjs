import { createServer } from 'vite';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { FloatType } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { comparePixels } from './pbrt-metrics.mjs';
import { launchChrome, delay } from './reference-runtime.mjs';
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), input = args.shift();
if (!input) throw new Error('Usage: npm run pbrt:compare -- <scene.pbrt> [--spp N] [--scale S] [--webgl] [--out path]');
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const samples = Number(option('--spp', '64')), scale = Number(option('--scale', '1'));
if (!Number.isSafeInteger(samples) || samples < 1 || !(scale > 0 && scale <= 4)) throw new Error('Invalid spp or scale');
const sceneFile = resolve(input), sceneDir = dirname(sceneFile), assetBase = dirname(sceneDir);
const sceneAddress = relative(assetBase, sceneFile).split(sep).join('/');
const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const output = resolve(option('--out', `${process.env.HOME}/.codex/experiments/mutracer-pbrt-${date}/${basename(input, '.pbrt')}-${samples}${args.includes('--webgl') ? '-webgl' : ''}`));
const pbrt = option('--pbrt', process.env.PBRT_BIN ?? `${process.env.HOME}/.codex/tools/pbrt-v4/build/pbrt`);
await mkdir(output, { recursive: true });
let temporary, chrome, memoryTimer, page, noiseFailure; let peakBrowserRSSBytes = 0;
const server = await createServer({ root, configFile: false, optimizeDeps: { disabled: true }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] }, fs: { allow: [root] } }, plugins: [{ name: 'pbrt-comparison', configureServer(s) {
  s.middlewares.use(async (req, res, next) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/oidn/weights/')) {
        const name = basename(url.pathname); if (!/^[\w.-]+\.tza$/.test(name)) throw new Error('Invalid weights path');
        const file = resolve(root, 'oidn/weights', name); res.setHeader('Content-Length', (await stat(file)).size); createReadStream(file).pipe(res); return;
      }
      if (url.pathname.startsWith('/asset/')) {
        const path = resolve(assetBase, decodeURIComponent(url.pathname.slice(7)));
        if (!path.startsWith(assetBase + sep)) { res.statusCode = 403; res.end(); return; }
        const info = await stat(path); res.setHeader('Content-Length', info.size);
        if (req.method === 'HEAD') res.end(); else createReadStream(path).pipe(res); return;
      }
      if (url.pathname.startsWith('/evidence-read/')) {
        const name = url.pathname.slice(15); if (!/^[\w.-]+$/.test(name)) throw new Error('Invalid evidence name');
        const file = resolve(output, name); const info = await stat(file); res.setHeader('Content-Length', info.size); createReadStream(file).pipe(res); return;
      }
      if (url.pathname.startsWith('/evidence/') && req.method === 'POST') {
        const name = url.pathname.slice(10); if (!/^[\w.-]+$/.test(name)) throw new Error('Invalid evidence name');
        const chunks = []; for await (const chunk of req) chunks.push(chunk); await writeFile(resolve(output, name), Buffer.concat(chunks)); res.end(); return;
      }
      if (url.pathname === '/compare') {
        res.setHeader('Content-Type', 'text/html'); res.end('<canvas></canvas><script type="module" src="/scripts/pbrt-browser.ts"></script>'); return;
      }
      next();
    } catch (error) { res.statusCode = 500; res.end(error.message); }
  });
} }] });
try {
  const { parse } = await server.ssrLoadModule('/tools/pbrt/parser.ts');
  const statements = [...parse(await readFile(sceneFile, 'utf8'), sceneFile)];
  const film = statements.find(s => s.kind === 'Film');
  const width = Number(option('--width', Math.max(1, Math.round(Number(film?.params.xresolution?.values[0] ?? 1280) * scale))));
  const height = Number(option('--height', Math.max(1, Math.round(Number(film?.params.yresolution?.values[0] ?? 720) * scale))));
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('Invalid output dimensions');
  const format = s => {
    const params = { ...s.params };
    if (s.kind === 'Film') { delete params.cropwindow; delete params.pixelbounds; }
    if (s.kind === 'Film') for (const [name, value] of [['xresolution', width], ['yresolution', height], ['savefp16', false]]) params[name] = { type: name === 'savefp16' ? 'bool' : 'integer', values: [value] };
    const argumentsText = s.args.map((a, i) => typeof a === 'number' || s.kind === 'ActiveTransform' || s.kind === 'Option' && i === 1 ? String(a) : JSON.stringify(a)).join(' ');
    return `${s.kind} ${['Transform', 'ConcatTransform'].includes(s.kind) ? '[' + argumentsText + ']' : argumentsText} ${Object.entries(params).map(([name, p]) => `${JSON.stringify(p.type + ' ' + name)} [${p.values.map(v => typeof v === 'string' ? JSON.stringify(v) : v).join(' ')}]`).join(' ')}`;
  };
  // PBRT's search directory is the main file's directory, so the temporary
  // rewritten entry must stay next to the original. It is always removed.
  temporary = resolve(sceneDir, `.mutracer-${randomUUID()}.pbrt`);
  await writeFile(temporary, 'PixelFilter \"box\" \"float xradius\" .5 \"float yradius\" .5\n' + statements.filter(s => s.kind !== 'PixelFilter').map(format).join('\n'));
  const ref = resolve(output, 'reference.exr'), start = performance.now();
  let referenceReused = false;
  if (args.includes('--reuse-reference') && !args.includes('--load-only')) {
    const { inspect } = await server.ssrLoadModule('/tools/pbrt/source.ts');
    const inspection = await inspect(sceneFile, { async read(path) { const b = await readFile(path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }, async size(path) { return (await stat(path)).size; } });
    const latestInput = Math.max(...await Promise.all(inspection.resources.map(async r => (await stat(r.path)).mtimeMs)));
    const matches = async path => {
      try {
        if ((await stat(path)).mtimeMs < latestInput) return false;
        const b = await readFile(path), image = new EXRLoader().setDataType(FloatType).parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        return image.width === width && image.height === height && image.header.samplesPerPixel === samples;
      } catch { return false; }
    };
    referenceReused = await matches(ref) && (!args.includes('--noise') || await matches(resolve(output, 'reference-noise.exr')));
  }
  if (!args.includes('--load-only') && !referenceReused) {
  const result = await exec(pbrt, ['--quiet', '--nthreads', '6', '--seed', '0', '--spp', String(samples), '--outfile', ref, temporary], { maxBuffer: 16 * 1024 * 1024, timeout: 1800000 });
  await writeFile(resolve(output, 'pbrt.log'), result.stdout + result.stderr);
  if (args.includes('--noise')) {
    await exec(pbrt, ['--quiet', '--nthreads', '6', '--seed', '1', '--spp', String(samples), '--outfile', resolve(output, 'reference-noise.exr'), temporary], { maxBuffer: 16 * 1024 * 1024, timeout: 1800000 });
  }
  }
  const referenceMs = performance.now() - start;
  await server.listen(); const url = `http://127.0.0.1:${server.httpServer.address().port}/compare`;
  chrome = await launchChrome();
  let polling = false;
  memoryTimer = setInterval(async () => {
    if (polling) return; polling = true;
    try {
      const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,rss=']);
      const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)), family = new Set([chrome.pid]);
      for (let n = 0; n < 8; n++) for (const [pid, parent] of rows) if (family.has(parent)) family.add(pid);
      peakBrowserRSSBytes = Math.max(peakBrowserRSSBytes, rows.reduce((sum, [pid, , rss]) => sum + (family.has(pid) ? rss * 1024 : 0), 0));
    } catch { /* RSS unavailable on another host; JS heap remains in report. */ }
    finally { polling = false; }
  }, 250);
  const browserURL = `${url}?scene=${encodeURIComponent(sceneAddress)}&width=${width}&height=${height}&spp=${samples}${args.includes('--webgl') ? '&webgl' : ''}${args.includes('--oidn') ? '&oidn' : ''}`;
  const openPage = async () => {
    page = await chrome.page(browserURL);
    for (let i = 0; i < 600; i++) { if (await page.tab.evaluate("typeof window.runBenchmark === 'function'")) return; await delay(100); }
    throw new Error('Browser fixture did not initialize');
  };
  await openPage();
  const runBrowser = expression => new Promise((resolve, reject) => {
    const limit = setTimeout(() => reject(new Error('Browser rendering timed out; see stage.json')), Number(option('--timeout', '300000')));
    page.tab.evaluate(expression).then(resolve, reject).finally(() => clearTimeout(limit));
  });
  const browser = await runBrowser('window.runBenchmark()');
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(browser, null, 2) + '\n');
  if (args.includes('--noise')) {
    // Keep independent seed pairs in separate processes: disposed scenes can
    // retain large CPU/GPU caches until GC, which would distort peak memory.
    try {
      await page.close(); await chrome.close(); chrome = await launchChrome(); await openPage();
      await runBrowser(`window.runBenchmark(${samples}, 'noise-')`);
    }
    catch (error) {
      noiseFailure = String(error);
      await writeFile(resolve(output, 'noise-failure.json'), JSON.stringify({ error: noiseFailure, primaryComplete: true }, null, 2) + '\n');
      // Retain the complete primary comparison even if the optional replicate
      // loses its browser. A fresh idle page can still draw the evidence PNGs.
      await chrome.close(); chrome = await launchChrome(); await openPage();
    }
  }
  if (args.includes('--load-only')) {
    const report = { scene: sceneFile, spp: samples, width, height, browser, peakBrowserRSSBytes, comparisonStatus: 'load-only' };
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); await page.close();
  } else {
  const buffer = await readFile(ref), image = new EXRLoader().setDataType(FloatType).parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  if (image.width !== width || image.height !== height) throw new Error('Reference resolution mismatch');
  const reference = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) reference.set(image.data.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4);
  const sensorScale = browser.exposure;
  if (!(sensorScale > 0)) throw new Error('Reference exposure must be positive');
  for (let i = 0; i < reference.length; i++) if (i % 4 < 3) reference[i] /= sensorScale;
  await writeFile(resolve(output, 'reference.f32'), new Uint8Array(reference.buffer));
  const raw = await readFile(resolve(output, 'mutracer.f32')), mu = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const idBytes = await readFile(resolve(output, 'ids.u32')), ids = new Uint32Array(idBytes.buffer.slice(idBytes.byteOffset, idBytes.byteOffset + idBytes.byteLength));
  if (!mu.every(Number.isFinite) || !reference.every(Number.isFinite)) throw new Error('Non-finite linear HDR pixels');
  if (mu.length !== reference.length) throw new Error('MuTracer resolution mismatch');
  let noiseA, noiseB;
  if (args.includes('--noise') && !noiseFailure) {
    const noise = await readFile(resolve(output, 'noise-mutracer.f32'));
    noiseA = new Float32Array(noise.buffer.slice(noise.byteOffset, noise.byteOffset + noise.byteLength));
    const bytes = await readFile(resolve(output, 'reference-noise.exr'));
    const image = new EXRLoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    noiseB = new Float32Array(reference.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) noiseB[(y * width + x) * 4 + c] = image.data[((height - y - 1) * width + x) * 4 + c] / (c < 3 ? sensorScale : 1);
  }
  const { regions, comparisonErrors: errors, frameStatus, regionStatus, excludedBoundaryPixels } = comparePixels({
    mu, reference, ids, noiseA, noiseB, width, height, approximateMaterialIds: browser.approximateMaterialIds, sceneComparable: browser.sceneComparable
  });
  const sourceRevision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const report = { sourceRevision, referenceReused, primaryRendered: true, noiseFailure, noiseMethod: noiseA ? { referenceSeeds: [0, 1], mutracerSampleOffsets: [0, samples], note: 'Disjoint Sobol blocks share a scramble; diagnostic estimate, not independent Monte Carlo replicas.' } : undefined, sceneComparable: browser.sceneComparable, comparisonStatus: noiseFailure ? 'noise-run-failed' : browser.sceneComparable === false ? 'not-comparable' : !noiseA ? 'unassessed-noise' : errors.length ? 'mismatch' : 'within-estimated-noise', comparisonErrors: errors, frameStatus, regionStatus, excludedBoundaryPixels, peakBrowserRSSBytes, memoryMeasurement: 'Sum of Chrome process-family RSS; includes shared pages', scene: sceneFile, spp: samples, width, height, referenceMs, browser, display: { comparison: 'linear HDR, top row first, no tone mapping', preview: 'v/(1+v), gamma 2.2', exposure: 1, referenceSensorScale: sensorScale, pixelFilter: 'box, radius 0.5 (PBRT override to match MuTracer)' }, regions, conclusion: 'Measurements only; two-run noise estimates require diagnosis and do not prove noise equivalence.' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await page.tab.evaluate(`(async () => {
    const width=${width},height=${height};
    const load=async name=>new Float32Array(await (await fetch('/evidence-read/'+name)).arrayBuffer());
    const a=await load('reference.f32'),b=await load('mutracer.f32');
    const canvas=new OffscreenCanvas(width*3,height),ctx=canvas.getContext('2d'),image=ctx.createImageData(width*3,height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let panel=0;panel<3;panel++){
      const source=(y*width+x)*4,target=(y*width*3+x+panel*width)*4;
      for(let c=0;c<3;c++) {let v=panel===0?a[source+c]:panel===1?b[source+c]:Math.abs(a[source+c]-b[source+c])*10;image.data[target+c]=255*Math.pow(Math.max(0,v)/(1+Math.max(0,v)),1/2.2);}
      image.data[target+3]=255;
    }
    ctx.putImageData(image,0,0);await fetch('/evidence/comparison.png',{method:'POST',body:await canvas.convertToBlob()});
    const difference=new OffscreenCanvas(width,height);difference.getContext('2d').drawImage(canvas,width*2,0,width,height,0,0,width,height);await fetch('/evidence/difference.png',{method:'POST',body:await difference.convertToBlob()});
    return true;
  })()`);
  console.log(JSON.stringify({ output, ...report }, null, 2));
  if (noiseFailure) process.exitCode = 1; else if (errors.length) process.exitCode = 2;
  await page.close();
  }
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ scene: sceneFile, peakBrowserRSSBytes, error: error.stack }, null, 2)); throw error;
} finally { clearInterval(memoryTimer); if (temporary) await unlink(temporary).catch(() => {}); await chrome?.close(); await server.close(); }
