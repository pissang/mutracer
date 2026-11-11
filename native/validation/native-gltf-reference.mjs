import {resolve,dirname} from 'node:path';
import {serve,ready,root} from '../../scripts/reference-capture.mjs';
import {launchChrome} from '../../scripts/reference-runtime.mjs';
const out=resolve(process.env.MUTRACER_NATIVE_GLTF_REFERENCE);
const model=resolve(process.env.MUTRACER_NATIVE_GLTF_MODEL);
const server=await serve(root,out,resolve(root,'native/validation/native-gltf-reference.ts'),{alias:[{find:/^@meimu\/mutracer$/,replacement:resolve(root,'src/main.ts')}]},[dirname(model)]);
let chrome;
try {
 chrome=await launchChrome();const page=await chrome.page(server.url);
 try {await ready(page.tab);console.log(await page.tab.evaluate(`window.runBenchmark(${JSON.stringify(out)},${JSON.stringify(model)},${process.env.MUTRACER_NATIVE_GLTF_NATIVE_ONLY==='1'})`));}
 finally {await page.close();}
} finally {await chrome?.close();await server.close();}
