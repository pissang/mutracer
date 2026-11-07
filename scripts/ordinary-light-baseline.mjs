import {createServer} from 'vite';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {launchChrome, delay} from './reference-runtime.mjs';

const out = resolve(process.env.MUTRACER_LIGHT_OUTPUT ?? '.cache/ordinary-light-baseline');
const root = resolve(process.env.MUTRACER_LIGHT_ROOT ?? '.');
mkdirSync(out, {recursive: true});
const server = await createServer({root, configFile: false, optimizeDeps: {entries: [], noDiscovery: true},
  server: {host: '127.0.0.1', port: 0, hmr: false}});
await server.listen(); let chrome;
try {
  chrome = await launchChrome();
  for (const backend of ['webgpu', 'webgl']) {
    const page = await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/ordinaryLightBaseline.html${backend === 'webgl' ? '?webgl' : ''}`);
    try {
      let ready = false;
      for (let i = 0; i < 200; i++) {
        if (await page.tab.evaluate('!!window.ordinaryLightBaseline')) { ready = true; break; }
        await delay(100);
      }
      if (!ready) throw Error('fixture did not load');
      const result = await page.tab.evaluate('window.ordinaryLightBaseline.capture()');
      writeFileSync(resolve(out, `${backend}.f32`), Buffer.from(new Float32Array(result.pixels).buffer));
      delete result.pixels;
      writeFileSync(resolve(out, `${backend}.json`), JSON.stringify(result, null, 2) + '\n');
      console.log(backend, JSON.stringify(result));
    } finally { await page.close(); }
  }
} finally { await chrome?.close(); await server.close(); }
