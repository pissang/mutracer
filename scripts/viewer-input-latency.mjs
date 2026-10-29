// Exercise the actual viewer loop and measure GPU-completed presentation after input.
import {createServer} from 'vite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {launchChrome,delay} from './reference-runtime.mjs';
const root=resolve(process.env.MUTRACER_SOURCE_ROOT??'.'),out=resolve(process.env.MUTRACER_CAUSTICS_OUTPUT);
mkdirSync(out,{recursive:true});
const server=await createServer({configFile:resolve(root,'viewer/vite.config.ts'),server:{host:'127.0.0.1',port:0,hmr:false}});await server.listen();
const chrome=await launchChrome(),results=[];
try{for(const model of (process.env.MODELS?.split(',')??['research-cornell-caustic','spheres'])){
 const page=await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/#model=${model}&denoise=false&maxSamples=1024`);
 try{
 await page.tab.call('Emulation.setDeviceMetricsOverride',{width:2200,height:1200,deviceScaleFactor:1,mobile:false});
 for(let i=0;i<900;i++){
  if(await page.tab.evaluate(`(async()=>{try{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const e=getEngine();return !!e?.model&&e.final.samples>0;}catch{return false;}})()`))break;
  if(i===899)throw Error('load timeout');await delay(200);
 }
 await page.tab.evaluate(`(async()=>{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const {setSettings}=await import('/src/store.ts');const e=window.latencyViewer=getEngine();const c=e.engine.display.canvas;
 c.style.setProperty('width','1920px','important');c.style.setProperty('height','1080px','important');c.style.setProperty('min-width','1920px','important');c.style.setProperty('min-height','1080px','important');e.needsResize=true;
 setSettings({cameraIndex:${model==='research-cornell-caustic'?0:-1},resolutionScale:1,bounces:8,denoise:false,maxSamples:1024,autoRotate:false,fStop:0,caustics:${model==='research-cornell-caustic'},causticPhotonMapping:true,causticLightTracing:false});
 e.controls.enableDamping=false;
 ${process.env.SINGLE_TILE==='1'?'e.final.maxTiles=1;':''}
 window.latencyRows=[];window.latencyPending=null;
 const present=e.engine.display.present.bind(e.engine.display);
 e.engine.display.present=function(render){const shown=present(render),p=window.latencyPending;
  if(shown&&p&&!p.claimed&&shown._complete&&((p.kind==='camera'&&shown._input.camera!==p.camera)||(p.kind==='settings'&&shown===e.final&&shown.bounces===p.bounces))){
   p.claimed=true;const submitted=performance.now();e.engine.device.queue.onSubmittedWorkDone().then(()=>{window.latencyRows.push({kind:p.kind,priorSampleMs:p.priorSampleMs,ms:performance.now()-p.start,submitMs:submitted-p.start,target:shown===e.final?'final':'preview',gpuSampleMs:e.final.gpuSampleTimeMs,width:e.final.width,height:e.final.height});window.latencyPending=null;});
  }return shown;};
 window.beginLatency=(kind)=>{window.latencyPending={kind,start:performance.now(),camera:e.engine._inputs.camera,priorSampleMs:e.final.gpuSampleTimeMs,bounces:e.final.bounces===8?7:8};if(kind==='settings'){e.engine.display.canvas.dispatchEvent(new Event('input',{bubbles:true}));setSettings({bounces:window.latencyPending.bounces});}};
 })()`);
 await delay(3000);
 const box=await page.tab.evaluate(`(()=>{const r=window.latencyViewer.engine.display.canvas.getBoundingClientRect();return{x:r.x+r.width*.4,y:r.y+r.height*.4};})()`);
 for(const kind of ['camera','settings'])for(let trial=0;trial<Number(process.env.TRIALS??20);trial++){
  await delay(400+trial%4*13);
  const count=await page.tab.evaluate('window.latencyRows.length');
  if(kind==='camera')await page.tab.call('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',clickCount:1});
  await page.tab.evaluate(`window.beginLatency('${kind}')`);
  if(kind==='camera'){
   await page.tab.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x+(trial%2?-4:4),y:box.y+(trial%2?-2:2),button:'left',buttons:1});
   await page.tab.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x+(trial%2?-4:4),y:box.y+(trial%2?-2:2),button:'left',clickCount:1});
  }
  for(let i=0;i<400;i++){if(await page.tab.evaluate(`window.latencyRows.length>${count}`))break;if(i===399)throw Error('input image timeout');await delay(25);}
 }
 const rows=await page.tab.evaluate('window.latencyRows');
 for(const kind of ['camera','settings']){const values=rows.filter(r=>r.kind===kind).map(r=>r.ms).sort((a,b)=>a-b);results.push({model,kind,median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1],rows:rows.filter(r=>r.kind===kind)});}
 writeFileSync(resolve(out,'latency.json'),JSON.stringify(results,null,2));console.log(results.map(({rows,...r})=>r));
 }finally{await Promise.race([page.close(),delay(5000)]);}
}}finally{await chrome.close();await server.close();}
