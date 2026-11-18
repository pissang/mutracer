import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {delay, launchChrome} from './reference-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({root, server: {host: '127.0.0.1', port: 0}});
let chrome;
try {
  await server.listen();
  chrome = await launchChrome();
  const page = await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/oidnBuffers.html`);
  try {
    for (let i = 0; i < 300; i++) {
      if (await page.tab.evaluate('typeof window.runOIDNBufferTests === "function"')) break;
      await delay(100);
    }
    console.log(JSON.stringify(await page.tab.evaluate('window.runOIDNBufferTests()'), null, 2));
  } finally { await page.close(); }
} finally {
  await chrome?.close();
  await server.close();
}
