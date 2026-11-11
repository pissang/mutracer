import {resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {serve,ready,root} from '../../scripts/reference-capture.mjs';
import {launchChrome} from '../../scripts/reference-runtime.mjs';
const out=resolve(process.env.MUTRACER_WEBVIEW_REFERENCE??process.argv[2]??'.cache/webview-reference');mkdirSync(out,{recursive:true});
const server=await serve(root,out,resolve(root,'native/validation/webview-scene-reference.ts'),{alias:[{find:/^@meimu\/mutracer$/,replacement:resolve(root,'src/main.ts')}]});let chrome;
try{chrome=await launchChrome();const page=await chrome.page(server.url + "?spp=" + (process.env.SPP ?? 16) + (process.env.WEBGL ? "&webgl" : ""));try{await ready(page.tab);console.log(await page.tab.evaluate('window.runBenchmark()'));}finally{await page.close();}}finally{await chrome?.close();await server.close();}
