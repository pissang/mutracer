import { createServer } from 'vite';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { FloatType } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { launchChrome, delay } from './reference-runtime.mjs';
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), input = args.shift();
if (!input) throw new Error('Usage: npm run pbrt:compare -- <scene.pbrt> [--spp N] [--scale S] [--webgl] [--out path]');
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const samples = Number(option('--spp', '64')), scale = Number(option('--scale', '1'));
if (!Number.isSafeInteger(samples) || samples < 1 || !(scale > 0 && scale <= 4)) throw new Error('Invalid spp or scale');
const sceneFile = resolve(input), sceneDir = dirname(sceneFile);
const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const output = resolve(option('--out', `${process.env.HOME}/.codex/experiments/mutracer-pbrt-${date}/${basename(input, '.pbrt')}-${samples}${args.includes('--webgl') ? '-webgl' : ''}`));
const pbrt = option('--pbrt', process.env.PBRT_BIN ?? `${process.env.HOME}/.codex/tools/pbrt-v4/build/pbrt`);
await mkdir(output, { recursive: true });
let temporary, chrome, memoryTimer; let peakBrowserRSSBytes = 0;
const server = await createServer({ root, configFile: false, optimizeDeps: { disabled: true }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] }, fs: { allow: [root] } }, plugins: [{ name: 'pbrt-comparison', configureServer(s) {
  s.middlewares.use(async (req, res, next) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/oidn/weights/')) {
        const name = basename(url.pathname); if (!/^[\w.-]+\.tza$/.test(name)) throw new Error('Invalid weights path');
        const file = resolve(root, 'oidn/weights', name); res.setHeader('Content-Length', (await stat(file)).size); createReadStream(file).pipe(res); return;
      }
      if (url.pathname.startsWith('/asset/')) {
        const path = resolve(sceneDir, decodeURIComponent(url.pathname.slice(7)));
        if (!path.startsWith(sceneDir + sep)) { res.statusCode = 403; res.end(); return; }
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
  const width = Math.max(1, Math.round(Number(film?.params.xresolution?.values[0] ?? 1280) * scale));
  const height = Math.max(1, Math.round(Number(film?.params.yresolution?.values[0] ?? 720) * scale));
  const format = s => {
    const params = { ...s.params };
    if (s.kind === 'Film') for (const [name, value] of [['xresolution', width], ['yresolution', height], ['savefp16', false]]) params[name] = { type: name === 'savefp16' ? 'bool' : 'integer', values: [value] };
    const argumentsText = s.args.map((a, i) => typeof a === 'number' || s.kind === 'ActiveTransform' || s.kind === 'Option' && i === 1 ? String(a) : JSON.stringify(a)).join(' ');
    return `${s.kind} ${['Transform', 'ConcatTransform'].includes(s.kind) ? '[' + argumentsText + ']' : argumentsText} ${Object.entries(params).map(([name, p]) => `${JSON.stringify(p.type + ' ' + name)} [${p.values.map(v => typeof v === 'string' ? JSON.stringify(v) : v).join(' ')}]`).join(' ')}`;
  };
  // PBRT's search directory is the main file's directory, so the temporary
  // rewritten entry must stay next to the original. It is always removed.
  temporary = resolve(sceneDir, `.mutracer-${randomUUID()}.pbrt`);
  await writeFile(temporary, 'PixelFilter \"box\" \"float xradius\" .5 \"float yradius\" .5\n' + statements.filter(s => s.kind !== 'PixelFilter').map(format).join('\n'));
  const ref = resolve(output, 'reference.exr'), start = performance.now();
  const result = await exec(pbrt, ['--quiet', '--nthreads', '6', '--seed', '0', '--spp', String(samples), '--outfile', ref, temporary], { maxBuffer: 16 * 1024 * 1024, timeout: 1800000 });
  await writeFile(resolve(output, 'pbrt.log'), result.stdout + result.stderr);
  if (args.includes('--noise')) {
    await exec(pbrt, ['--quiet', '--nthreads', '6', '--seed', '1', '--spp', String(samples), '--outfile', resolve(output, 'reference-noise.exr'), temporary], { maxBuffer: 16 * 1024 * 1024, timeout: 1800000 });
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
  const page = await chrome.page(`${url}?scene=${encodeURIComponent(basename(sceneFile))}&width=${width}&height=${height}&spp=${samples}${args.includes('--webgl') ? '&webgl' : ''}${args.includes('--oidn') ? '&oidn' : ''}`);
  for (let i = 0; i < 600; i++) { if (await page.tab.evaluate("typeof window.runBenchmark === 'function'")) break; await delay(100); }
  const browser = await page.tab.evaluate('window.runBenchmark()');
  if (args.includes('--noise')) await page.tab.evaluate(`window.runBenchmark(${samples}, 'noise-')`);
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
  if (args.includes('--noise')) {
    const noise = await readFile(resolve(output, 'noise-mutracer.f32'));
    noiseA = new Float32Array(noise.buffer.slice(noise.byteOffset, noise.byteOffset + noise.byteLength));
    const bytes = await readFile(resolve(output, 'reference-noise.exr'));
    const image = new EXRLoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    noiseB = new Float32Array(reference.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) noiseB[(y * width + x) * 4 + c] = image.data[((height - y - 1) * width + x) * 4 + c] / (c < 3 ? sensorScale : 1);
  }
  const excluded = new Set(browser.approximateMaterialIds), regions = [];
  const measure = (name, x0, y0, x1, y1, approximate, materialId) => {
    let count = 0, abs = 0, square = 0, signal = 0, noiseSquare = 0; const sumA = [0, 0, 0], sumB = [0, 0, 0], sumNA = [0, 0, 0], sumNB = [0, 0, 0];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const offset = (y * width + x) * 4;
      if (excluded.has(ids[offset + 2]) !== approximate || materialId !== undefined && ids[offset + 2] !== materialId) continue;
      count++;
      for (let c = 0; c < 3; c++) { const a = mu[offset + c], b = reference[offset + c], d = a - b; sumA[c] += a; sumB[c] += b; if (noiseA) { sumNA[c] += noiseA[offset + c]; sumNB[c] += noiseB[offset + c]; noiseSquare += ((a - noiseA[offset+c])**2 + (b - noiseB[offset+c])**2) / 2; } abs += Math.abs(d); square += d * d; signal += b * b; }
    }
    if (count) regions.push({ name, approximate, pixels: count, meanMu: sumA.map(v => v / count), meanReference: sumB.map(v => v / count), relativeMeanError: sumA.map((v, c) => (v - sumB[c]) / Math.max(1e-10, sumB[c])), relativeRMSE: Math.sqrt(square / Math.max(1e-20, signal)), noiseRelativeRMSE: noiseA ? Math.sqrt(noiseSquare / Math.max(1e-20, signal)) : undefined, noiseStandardError: noiseA ? sumA.map((v,c)=>Math.sqrt(((v-sumNA[c])**2+(sumB[c]-sumNB[c])**2)/2)/count) : undefined, meanBias: sumA.map((v,c)=>(v-sumB[c])/count), mae: abs / (count * 3) });
  };
  measure('comparable', 0, 0, width, height, false); measure('approximate', 0, 0, width, height, true);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) measure(`tile-${x}-${y}`, Math.floor(x * width / 4), Math.floor(y * height / 4), Math.floor((x + 1) * width / 4), Math.floor((y + 1) * height / 4), false);
  for (const id of new Set(Array.from(ids).filter((_, i) => i % 4 === 2))) measure(`material-${id}`, 0, 0, width, height, excluded.has(id), id);
  const errors = regions.filter(region => !region.approximate && region.noiseRelativeRMSE !== undefined && region.relativeRMSE > region.noiseRelativeRMSE * (1 + 6 * Math.sqrt(2 / (region.pixels * 3)))).map(region => region.name);
  const report = { comparisonStatus: !noiseA ? 'unassessed-noise' : errors.length ? 'mismatch' : 'within-estimated-noise', comparisonErrors: errors, peakBrowserRSSBytes, memoryMeasurement: 'Sum of Chrome process-family RSS; includes shared pages', scene: sceneFile, spp: samples, width, height, referenceMs, browser, display: { comparison: 'linear HDR, top row first, no tone mapping', preview: 'v/(1+v), gamma 2.2', exposure: 1, referenceSensorScale: sensorScale, pixelFilter: 'box, radius 0.5 (PBRT override to match MuTracer)' }, regions, conclusion: 'Measurements only; noise equivalence requires independent-seed reference renders and diagnosis.' };
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
  if (errors.length) process.exitCode = 2;
  await page.close();
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ scene: sceneFile, error: error.stack }, null, 2)); throw error;
} finally { clearInterval(memoryTimer); if (temporary) await unlink(temporary).catch(() => {}); await chrome?.close(); await server.close(); }
