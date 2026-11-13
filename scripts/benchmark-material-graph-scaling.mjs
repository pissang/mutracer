#!/usr/bin/env node
import {createServer} from 'vite';
import {parseArgs} from 'node:util';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchChrome, delay} from './reference-runtime.mjs';

const {values} = parseArgs({options: {
  structures: {type: 'string', default: '0,1,10,50,100,300,1000'},
  modes: {type: 'string', default: 'constant,baked,graph'},
  class: {type: 'string', default: 'simple'},
  'bake-size': {type: 'string', default: '128'},
  'texture-binding': {type: 'string', default: 'auto'},
  hdr: {type: 'boolean', default: false},
  'first-index': {type: 'string'},
  'close-up': {type: 'boolean', default: false},
  'hdr-block': {type: 'string', default: '8'},
  swap: {type: 'boolean', default: false},
  output: {type: 'string'}, help: {type: 'boolean'}
}});
if (values.help) {
  console.log('node scripts/benchmark-material-graph-scaling.mjs [--structures 0,1,10] [--modes constant,baked,graph,interpreter] [--class simple|noise] [--bake-size 128] [--texture-binding auto|atlas] [--hdr] [--first-index 0] [--close-up] [--hdr-block 8] [--swap] [--output rows.jsonl]');
  process.exit(0);
}
// Graph structures start at a fresh index per invocation unless pinned, keeping graph compiles cold.
const firstIndex = Number(values['first-index'] ?? Math.floor(Math.random() * 1e6) * 1000);
const counts = values.structures.split(',').map(Number), modes = values.modes.split(',');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), temporary = mkdtempSync(resolve(tmpdir(), 'mutracer-graph-scaling-'));
const server = await createServer({configFile: resolve(root, 'viewer/vite.config.ts'), cacheDir: resolve(temporary, 'vite'), server: {host: '127.0.0.1', port: 0}, plugins: [{
  name: 'graph-scaling-benchmark', configureServer(vite) { vite.middlewares.use((req, res, next) => {
    if (req.url !== '/graph-scaling-benchmark.html') return next();
    res.setHeader('Content-Type', 'text/html'); res.end(`<script type="module" src="/@fs/${root}/tests/gpu/materialGraphScalingBenchmark.ts"></script>`);
  }); }
}]});
if (values.output) mkdirSync(dirname(resolve(values.output)), {recursive: true});
try {
  await server.listen(); const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw Error('Benchmark server address unavailable');
  for (const structures of counts) for (const mode of modes) {
    // A fresh browser and profile per run keeps pipeline caches cold.
    const chrome = await launchChrome();
    try {
      const page = await chrome.page(`http://127.0.0.1:${address.port}/graph-scaling-benchmark.html`);
      try {
        for (let i = 0; i < 300; i++) { if (await page.tab.evaluate('typeof window.runMaterialGraphScaling === "function"')) break; await delay(100); }
        const options = {structures, mode, graphClass: values.class, bakeSize: Number(values['bake-size']), textureBinding: values['texture-binding'], hdr: values.hdr, firstIndex, closeUp: values['close-up'], hdrBlock: Number(values['hdr-block']), swap: values.swap};
        let row;
        try { row = await page.tab.evaluate(`runMaterialGraphScaling(${JSON.stringify(options)})`); }
        catch (error) { row = {...options, error: String(error).slice(0, 2000)}; }
        console.log(JSON.stringify({structures, mode, firstFrameMs: row.firstFrameMs, graphReadyMs: row.graphReadyMs, firstCorrectFrameMs: row.firstCorrectFrameMs, gpuSampleTimeMs: row.gpuSampleTimeMs,
          sourceBytes: row.shaderCompilation?.sourceBytes, pipelineMs: row.shaderCompilation?.pipelineCompilationTimeMs, swap: row.swap, error: row.error}));
        if (values.output) appendFileSync(resolve(values.output), JSON.stringify(row) + '\n');
      } finally { await page.close(); }
    } finally { await chrome.close(); }
  }
} finally { await server.close(); rmSync(temporary, {recursive: true, force: true}); }
