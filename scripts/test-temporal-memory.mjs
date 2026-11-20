import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {delay, launchChrome} from './reference-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const lockPath = '/Users/lang/mutracer-evidence/.gpu-heavy.lock';
const outputPath = process.env.MUTRACER_TEMPORAL_MEMORY_OUTPUT ??
  '/Users/lang/mutracer-evidence/temporal-denoiser-20261120/B4-memory/peak-memory.json';
const startedAt = new Date().toISOString();
const session = `B4-temporal-memory ${new Date().toISOString()} pid=${process.pid}`;
let lockFd;
try { lockFd = openSync(lockPath, 'wx'); }
catch (error) {
  if (error.code === 'EEXIST') throw Error(`Heavy GPU lock is held at ${lockPath}; no run was started.`);
  throw error;
}
writeFileSync(lockFd, session + '\n'); closeSync(lockFd);

function chromeTreeRss(rootPid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], {encoding: 'utf8'}).trim().split('\n')
    .map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row.every(Number.isFinite));
  const parent = new Map(rows.map(([pid, ppid, rss]) => [pid, {ppid, rss}]));
  const children = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, item] of parent) if (!children.has(pid) && children.has(item.ppid)) { children.add(pid); grew = true; }
  }
  let bytes = 0;
  for (const pid of children) bytes += (parent.get(pid)?.rss ?? 0) * 1024;
  return {bytes, pids: [...children]};
}

async function runResolution(serverUrl, width, height) {
  const browser = await launchChrome();
  let peak = {bytes: 0, pids: []}, latest = peak;
  const monitor = setInterval(() => {
    try { latest = chromeTreeRss(browser.pid); if (latest.bytes > peak.bytes) peak = latest; } catch {}
  }, 150);
  let page;
  try {
    page = await browser.page(`${serverUrl}/tests/gpu/temporalMemory.html?width=${width}&height=${height}`);
    for (let i = 0; i < 300; i++) {
      if (await page.tab.evaluate('typeof window.runTemporalMemoryTest === "function"')) break;
      await delay(100);
    }
    const result = await page.tab.evaluate('window.runTemporalMemoryTest()');
    const last = chromeTreeRss(browser.pid); if (last.bytes > peak.bytes) peak = last;
    return {...result, chromeTreePeakRssBytes: peak.bytes, chromeTreePeakPids: peak.pids,
      chromeTreeFinalRssBytes: last.bytes, measurement: 'sum of Chrome browser and child-process resident sets; excludes separately accounted GPU-driver/VRAM allocations'};
  } finally { clearInterval(monitor); await page?.close(); await browser.close(); }
}

let server;
try {
  server = await createServer({root, server: {host: '127.0.0.1', port: 0}});
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const results = [];
  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, JSON.stringify({session, startedAt, status: 'running', results}, null, 2) + '\n');
  for (const [width, height] of [[1280, 720], [1920, 1080]]) {
    results.push(await runResolution(origin, width, height));
    writeFileSync(outputPath, JSON.stringify({session, startedAt, status: 'running', results}, null, 2) + '\n');
  }
  writeFileSync(outputPath, JSON.stringify({session, startedAt, status: 'complete', results}, null, 2) + '\n');
  console.log(JSON.stringify({outputPath, results}));
} finally {
  await server?.close();
  if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === session + '\n') rmSync(lockPath);
}
