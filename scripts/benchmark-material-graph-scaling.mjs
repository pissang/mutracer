#!/usr/bin/env node
import {createServer} from 'vite';
import {parseArgs} from 'node:util';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, dirname, extname, sep} from 'node:path';
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
  'no-interim': {type: 'boolean', default: false},
  'budget-ms': {type: 'string'},
  'target-samples': {type: 'string'},
  'settle-ms': {type: 'string'},
  edits: {type: 'string'},
  'edit-interval-ms': {type: 'string'},
  'edit-kind': {type: 'string'},
  'compile-speed': {type: 'string'},
  'compile-backend': {type: 'string'},
  probe: {type: 'string'},
  'probe-delay-ms': {type: 'string'},
  policy: {type: 'string'},
  features: {type: 'string', default: 'lean'},
  mtlx: {type: 'string'},
  'mtlx-no-values': {type: 'boolean', default: false},
  repeats: {type: 'string', default: '1'},
  'scene-gltf': {type: 'string'},
  'scene-fbx': {type: 'string'},
  output: {type: 'string'}, help: {type: 'boolean'}
}});
if (values.help) {
  console.log(`node scripts/benchmark-material-graph-scaling.mjs [options]
  --structures 0,1,10        distinct graph structures per run
  --modes constant,baked,graph,interpreter,auto   runs per structure count, interleaved in this order
  --repeats 1                repeats of the whole mode sequence (paired A/B)
  --class simple|noise  --bake-size 128  --texture-binding auto|atlas
  --scene-gltf scene.glb | --scene-fbx scene.fbx   loaded scene instead of the sphere grid
  --no-interim  --budget-ms 1000   fixed planner budgets instead of the calibrated policy
  --target-samples 2048      render target while the tier policy decides (auto)
  --settle-ms 60000          longest wait for the policy decision (auto); rows report settleOutcome
  --edits 10 --edit-interval-ms 1000 --edit-kind structure|parameter   edit simulation
  --compile-speed 3          debug device compile speed factor (simulates a slower compiler)
  --compile-backend d3d12    debug compile-cost shape of another backend
  --probe contended|solo --probe-delay-ms 1000   concurrency probe: an edit needing a compile during (or without) a long upgrade compile
  --policy '{"margin":1.5}'  tier policy overrides (JSON)
  --hdr --hdr-block 8 --close-up --first-index 0 --swap
  --output rows.jsonl        full rows (calibration samples, upgrade events, edits, timings)
  --mtlx wood,marble         viewer MaterialX samples as the graph materials (--mtlx-no-values: graphs only)
  --features lean|full       full adds spheres enabling every surface lobe, anisotropy and emission
Environment: MUTRACER_CHROME=path to Chrome when it is not in the default location.`);
  process.exit(0);
}
// Graph structures start at a fresh index per invocation unless pinned, keeping graph compiles cold.
const firstIndex = Number(values['first-index'] ?? Math.floor(Math.random() * 1e6) * 1000);
const scenePath = values['scene-gltf'] ?? values['scene-fbx'];
const sceneUrl = scenePath ? `/graph-scaling-scene${extname(scenePath).toLowerCase()}` : undefined;
const counts = values.structures.split(',').map(Number), modes = values.modes.split(','), repeats = Number(values.repeats);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), temporary = mkdtempSync(resolve(tmpdir(), 'mutracer-graph-scaling-'));
const server = await createServer({configFile: resolve(root, 'viewer/vite.config.ts'), cacheDir: resolve(temporary, 'vite'), server: {host: '127.0.0.1', port: 0}, plugins: [{
  name: 'graph-scaling-benchmark', configureServer(vite) { vite.middlewares.use((req, res, next) => {
    // A local scene file is served as data at a fixed URL; it never enters the repository.
    if (sceneUrl && req.url === sceneUrl) { res.setHeader('Content-Type', 'application/octet-stream'); createReadStream(resolve(scenePath)).pipe(res); return; }
    if (req.url !== '/graph-scaling-benchmark.html') return next();
    res.setHeader('Content-Type', 'text/html'); res.end(`<script type="module" src="/@fs/${root.split(sep).join('/').replace(/^\/+/, '')}/tests/gpu/materialGraphScalingBenchmark.ts"></script>`);
  }); }
}]});
if (values.output) mkdirSync(dirname(resolve(values.output)), {recursive: true});
try {
  await server.listen(); const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw Error('Benchmark server address unavailable');
  for (let repeat = 0; repeat < repeats; repeat++) for (const structures of counts) for (const mode of modes) {
    // A fresh browser and profile per run keeps pipeline caches cold.
    const chrome = await launchChrome();
    try {
      const page = await chrome.page(`http://127.0.0.1:${address.port}/graph-scaling-benchmark.html`);
      try {
        for (let i = 0; i < 300; i++) { if (await page.tab.evaluate('typeof window.runMaterialGraphScaling === "function"')) break; await delay(100); }
        const number = name => values[name] === undefined ? undefined : Number(values[name]);
        const options = {structures, mode, graphClass: values.class, bakeSize: Number(values['bake-size']), textureBinding: values['texture-binding'], hdr: values.hdr, firstIndex, closeUp: values['close-up'], hdrBlock: Number(values['hdr-block']), swap: values.swap, sceneUrl, interim: !values['no-interim'], budgetMs: number('budget-ms'),
          targetSamples: number('target-samples'), settleMs: number('settle-ms'), edits: number('edits'), editIntervalMs: number('edit-interval-ms'), editKind: values['edit-kind'], compileSpeed: number('compile-speed'), features: values.features, mtlx: values.mtlx?.split(','), mtlxValues: !values['mtlx-no-values'], compileBackend: values['compile-backend'], probe: values.probe, probeDelayMs: number('probe-delay-ms'), policy: values.policy ? JSON.parse(values.policy) : undefined};
        let row;
        try { row = await page.tab.evaluate(`runMaterialGraphScaling(${JSON.stringify(options)})`); }
        catch (error) { row = {...options, error: String(error).slice(0, 2000)}; }
        const last = (type) => row.upgrades?.filter(e => e.type === type).at(-1);
        console.log(JSON.stringify({repeat, structures, mode, firstFrameMs: row.firstFrameMs, graphReadyMs: row.graphReadyMs, firstCorrectFrameMs: row.firstCorrectFrameMs, optimizedMs: row.optimizedMs, tiers: row.tiers?.map(t => `${t.interim ? 'i' : 'f'}${t.specialized}/${t.interpreted}@${Math.round(t.atMs)}`).join(' '), gpuSampleTimeMs: row.gpuSampleTimeMs,
          settle: row.settleOutcome, wallSampleMs: row.wallSampleMs, sourceBytes: row.shaderCompilation?.sourceBytes, pipelineMs: row.shaderCompilation?.pipelineCompilationTimeMs, swap: row.swap,
          upgrades: row.upgrades?.map(e => `${e.type}@${Math.round(e.atMs)}`).join(' '), verified: (last('keep') ?? last('rollback'))?.verification,
          compiles: row.compiles?.map(c => `${c.kind}:${Math.round(c.totalKB)}KB/${Math.round(c.ms)}ms s=${c.speed.toFixed(2)}`).join(' '),
          probe: row.probe && {upgradeStart: Math.round(row.probe.upgradeStartMs ?? -1), editAt: Math.round(row.probe.editAtMs), editReady: row.probe.editReadyMs === undefined ? 'timeout' : Math.round(row.probe.editReadyMs),
            editCompile: row.probe.editCompile && `${Math.round(row.probe.editCompile.ms)}ms overlap ${Math.round(row.probe.editCompile.overlapMs)} done@${Math.round(row.probe.editCompile.finishedMs)}`,
            upgradeCompile: row.probe.upgradeCompile && `${Math.round(row.probe.upgradeCompile.ms)}ms done@${Math.round(row.probe.upgradeCompile.finishedMs)}`},
          edits: row.edits?.length ? row.edits.map(e => `${e.readyMs === undefined ? 'timeout' : Math.round(e.readyMs)}${e.compiledKB ? 'c' : ''}`).join(' ') : undefined, error: row.error}));
        if (values.output) appendFileSync(resolve(values.output), JSON.stringify(row) + '\n');
      } finally { await page.close(); }
    } finally { await chrome.close(); }
  }
} finally { await server.close(); rmSync(temporary, {recursive: true, force: true}); }
