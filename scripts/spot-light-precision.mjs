import {createServer} from 'vite';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {launchChrome, delay} from './reference-runtime.mjs';

const output = process.env.MUTRACER_SPOT_OUTPUT;
if (output) mkdirSync(output, {recursive: true});
const server = await createServer({configFile: false, optimizeDeps: {entries: [], noDiscovery: true},
  server: {host: '127.0.0.1', port: 0, hmr: false, watch: {ignored: ['**/.native-build/**']}}});
await server.listen();
let chrome;
let passed = true;
try {
  chrome = await launchChrome();
  for (const backend of ['webgpu', 'webgl']) {
    const page = await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/spotLightPrecision.html${backend === 'webgl' ? '?webgl' : ''}`);
    try {
      let ready = false;
      for (let i = 0; i < 200; i++) {
        if (await page.tab.evaluate('!!window.spotLightPrecision')) {ready = true; break;}
        await delay(100);
      }
      if (!ready) throw Error('Spotlight fixture did not load');
      const result = await page.tab.evaluate('window.spotLightPrecision.capture()');
      if (output) for (const [radius, pixels] of Object.entries(result.captures)) {
        writeFileSync(resolve(output, `${backend}-${radius}.f32`), Buffer.from(new Float32Array(pixels).buffer));
      }
      delete result.captures;
      if (output) writeFileSync(resolve(output, `${backend}.json`), JSON.stringify(result, null, 2) + '\n');
      console.log(backend, JSON.stringify(result));
      passed &&= result.results.every(row => row.passed);
    } finally {await page.close();}
  }
} finally {await chrome?.close(); await server.close();}
if (!passed) process.exitCode = 1;
