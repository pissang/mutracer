import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {delay, launchChrome} from './reference-runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
let release;
const graphRuntime = new Promise(resolve => { release = resolve; });
const server = await createServer({root, server: {host: '127.0.0.1', port: 0}, plugins: [{
  name: 'cold-material-graph',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url?.split('?')[0];
      if (url === '/__release_material_graph') {
        release();
        res.end();
      } else if (url === '/src/renderer/materialGraph/runtime.ts') {
        void graphRuntime.then(() => next());
      } else {
        next();
      }
    });
  },
}]});
let chrome;
try{
  await server.listen();chrome=await launchChrome();
  const page=await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/temporalMaterialRevision.html`);
  try{
    for(let i=0;i<300;i++){
      if(await page.tab.evaluate('typeof window.runTemporalMaterialRevisionTests === "function"'))break;
      await delay(100);
    }
    console.log(JSON.stringify(await page.tab.evaluate('window.runTemporalMaterialRevisionTests()')));
  }finally{await page.close();}
}finally{release();await chrome?.close();await server.close();}
