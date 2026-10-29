// Measure the actual viewer RenderLoop, including presentation and OIDN scheduling.
import {createServer} from 'vite';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {launchChrome, delay} from './reference-runtime.mjs';
const root=resolve(process.env.MUTRACER_SOURCE_ROOT??'.');
const out=resolve(process.env.MUTRACER_CAUSTICS_OUTPUT);
mkdirSync(out,{recursive:true});
const server=await createServer({configFile:resolve(root,'viewer/vite.config.ts'),server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/.native-build/**']}}});
await server.listen();
const chrome=await launchChrome();
try {
 const page=await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/#model=research-cornell-caustic&denoise=false&maxSamples=1&caustics=false`);
 try {
  await page.tab.call('Emulation.setDeviceMetricsOverride',{width:2200,height:1200,deviceScaleFactor:1,mobile:false});
  for(let i=0;i<900;i++){
   const ready=await page.tab.evaluate(`(async()=>{try{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const e=getEngine();return e?.code()?.includes('cornell_caustic')&&e.final.samples>0;}catch{return false;}})()`);
   if(ready)break;
   if(i===899)throw Error('Cornell viewer load timeout');await delay(200);
  }
  await page.tab.evaluate(`(async()=>{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const {setSettings}=await import('/src/store.ts');const e=getEngine();window.photonViewerErrors=[];e.engine.device?.addEventListener('uncapturederror',event=>window.photonViewerErrors.push(event.error.message));const c=e.engine.display.canvas;c.style.setProperty('width','1920px','important');c.style.setProperty('height','1080px','important');c.style.setProperty('min-width','1920px','important');c.style.setProperty('min-height','1080px','important');e.needsResize=true;setSettings({cameraIndex:0,bounces:8,caustics:true,causticPhotonMapping:true,causticLightTracing:false,maxSamples:1,fStop:0,autoRotate:false});})()`);
  const results=[];
  for(const denoise of [false,true])for(const scale of [.5,1]){
   await page.tab.evaluate(`import('/src/store.ts').then(m=>m.setSettings({resolutionScale:${scale},denoise:${denoise},maxSamples:1}))`);
   for(let i=0;i<1800;i++){
    const ready=await page.tab.evaluate(`(async()=>{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const e=getEngine();return e.final.samples===1&&e.loop.status==='finished'&&e.final.resolutionScale===${scale};})()`);
    if(ready)break;
    if(i===1799)throw Error('Viewer warmup timeout');await delay(100);
   }
   await page.tab.evaluate(`(async()=>{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const {setSettings}=await import('/src/store.ts');setSettings({maxSamples:64});const e=getEngine();e.final.restart();window.photonViewerStarted=performance.now();})()`);
   let row;
   for(let i=0;i<6000;i++){
    row=await page.tab.evaluate(`(async()=>{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const {useViewer}=await import('/src/store.ts');const e=getEngine();if(window.photonViewerErrors.length)throw Error(window.photonViewerErrors.join('\\n'));if(e.loop.status==='error')throw Error(JSON.stringify(useViewer.getState().toast));if(e.final.samples<64||e.loop.status!=='finished')return null;await e.engine.device?.queue.onSubmittedWorkDone();return{wallMs:performance.now()-window.photonViewerStarted,stats:useViewer.getState().stats,width:e.final.width,height:e.final.height,samples:e.final.samples,settings:useViewer.getState().settings};})()`);
    if(row)break;
    if(i===5999)throw Error('Viewer completion timeout');await delay(100);
   }
   const result={scale,denoise,...row};results.push(result);
   writeFileSync(resolve(out,'viewer.json'),JSON.stringify(results,null,2));
   console.log({scale,denoise,width:row.width,height:row.height,wallMs:row.wallMs,elapsed:row.stats.elapsed});
  }
 }finally{await page.close();}
}finally{await chrome.close();await server.close();}
