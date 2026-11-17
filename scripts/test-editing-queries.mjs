import {createServer} from 'vite';
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {launchChrome,delay} from './reference-runtime.mjs';
import {loadShaderIdentifierMap} from './shader-identifiers.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temporary=mkdtempSync(resolve(tmpdir(),'mutracer-query-tests-'));
const output=resolve(process.env.MUTRACER_EDITING_QUERY_OUTPUT??'.cache/editing-queries/result.json');
const cases=process.env.MUTRACER_EDITING_QUERY_CASES?.split(',');
const server=await createServer({root,configFile:false,cacheDir:resolve(temporary,'vite'),optimizeDeps:{entries:['tests/gpu/editingQueries.ts']},server:{host:'127.0.0.1',port:0},plugins:[{
 name:'editing-query-regression',transform(source,id){
  if(process.env.MUTRACER_EDITING_QUERY_BUILT==='1'&&/\/tests\/gpu\/editing(?:Queries|TextureSampling)\.ts$/.test(id.replaceAll('\\','/')))return source.replaceAll('../../src/','../../lib/');
 },configureServer(vite){vite.middlewares.use((req,res,next)=>{
  if(req.url!=='/editing-queries.html')return next();res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/tests/gpu/editingQueries.ts"></script>');
 });}
}]});
let chrome;
try{
 await server.listen();chrome=await launchChrome();const page=await chrome.page('http://127.0.0.1:'+server.httpServer.address().port+'/editing-queries.html');
 try{
  for(let i=0;i<300;i++){if(await page.tab.evaluate('typeof window.runEditingQueryTests === "function"'))break;await delay(100);}
  const identifiers=process.env.MUTRACER_EDITING_QUERY_BUILT==='1'?[...loadShaderIdentifierMap()]:undefined;
  const rows=await page.tab.evaluate('runEditingQueryTests('+JSON.stringify(cases)+','+JSON.stringify(identifiers)+')');
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({passed:true,rows},null,2)+'\n');console.log(JSON.stringify({passed:true,output,rows}));
 }finally{await page.close();}
}catch(error){mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({passed:false,error:String(error)},null,2)+'\n');throw error;}
finally{
 await chrome?.close();await server.close();
 const target=resolve(temporary);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('mutracer-query-tests-'))throw Error('Unexpected temporary directory: '+target);
 rmSync(target,{recursive:true,force:true});
}
