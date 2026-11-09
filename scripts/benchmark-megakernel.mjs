#!/usr/bin/env node
import {createServer} from 'vite';
import {parseArgs} from 'node:util';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchChrome,delay} from './reference-runtime.mjs';

const {values}=parseArgs({options:{scene:{type:'string',default:'all'},repeats:{type:'string',default:'5'},output:{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('node scripts/benchmark-megakernel.mjs [--scene simple|spheres|all] [--repeats 5] [--output result.json]');process.exit(0);}
if(!['simple','spheres','all'].includes(values.scene))throw Error('--scene must be simple, spheres or all');
const repeats=Number(values.repeats);if(!Number.isSafeInteger(repeats)||repeats<1)throw Error('--repeats must be a positive integer');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temporary=mkdtempSync(resolve(tmpdir(),'mutracer-megakernel-'));
const server=await createServer({configFile:resolve(root,'viewer/vite.config.ts'),cacheDir:resolve(temporary,'vite'),server:{host:'127.0.0.1',port:0},plugins:[{
    name:'megakernel-benchmark',configureServer(vite){vite.middlewares.use((req,res,next)=>{
        if(req.url!=='/megakernel-benchmark.html')return next();
        res.setHeader('Content-Type','text/html');res.end(`<script type="module" src="/@fs/${root}/tests/gpu/megakernelBenchmark.ts"></script>`);
    });}
}]});
let chrome;
try{
    await server.listen();const address=server.httpServer.address();if(!address||typeof address==='string')throw Error('Benchmark server address unavailable');
    chrome=await launchChrome();const rows=[];
    for(const scene of values.scene==='all'?['simple','spheres']:[values.scene]){
        const page=await chrome.page(`http://127.0.0.1:${address.port}/megakernel-benchmark.html`);
        try{
            for(let i=0;i<200;i++){if(await page.tab.evaluate('typeof window.runMegakernelBenchmark === "function"'))break;await delay(100);}
            const row=await page.tab.evaluate(`runMegakernelBenchmark(${JSON.stringify(scene)},${repeats})`);rows.push(row);
        }finally{await page.close();}
    }
    const result=JSON.stringify({timingsAreInformational:true,rows},null,2);
    if(values.output){const path=resolve(values.output);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,result+'\n');}
    console.log(result);
}finally{await chrome?.close();await server.close();rmSync(temporary,{recursive:true,force:true});}
