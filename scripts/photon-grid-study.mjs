// Fixed-seed quality/cost checkpoints; raw arrays are uploaded without JSON expansion.
import {createServer} from 'vite';
import {readFileSync,writeFileSync,mkdirSync,createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {launchChrome,delay} from './reference-runtime.mjs';
const root=resolve('.'), directory=resolve(process.env.MUTRACER_CAUSTICS_OUTPUT);
mkdirSync(directory,{recursive:true});
const width=Number(process.env.WIDTH??192),height=Number(process.env.HEIGHT??192),exposure=1;
const checkpoints=[...new Set([...(process.env.RADIUS_MODE&&process.env.COUNTERS_ONLY!=='1'?[1,2]:[]),...(process.env.CHECKPOINTS??'4,16,64').split(',').map(Number)])].sort((a,b)=>a-b);
const modes=(process.env.STUDY_MODES??'pt,light,photon,reference,light-photon').split(',');
const scenes=(process.env.STUDY_SCENES??'cornell,sphere').split(',');
const server=await createServer({configFile:resolve(root,'viewer/vite.config.ts'),server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/.native-build/**']}},plugins:[{name:'study-evidence',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='POST'&&url.pathname.startsWith('/__evidence/')){const name=url.pathname.slice(12);if(!/^[\w.-]+$/.test(name)){res.statusCode=400;res.end();return;}const chunks=[];for await(const b of req)chunks.push(b);writeFileSync(resolve(directory,name),Buffer.concat(chunks));res.end('ok');return;}
 if(url.pathname==='/study'){res.setHeader('Content-Type','text/html');res.end(`<canvas></canvas><script type="module" src="/@fs/${root}/tests/gpu/caustics.ts"></script>`);return;}
 next();
});}}]});await server.listen();const chrome=await launchChrome();
try {for(const scene of scenes){
 const page=await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/`+(scene==='cornell'?'#model=research-cornell-caustic&denoise=false&maxSamples=1&caustics=false':'study'));
 try {
 await page.tab.call('Emulation.setDeviceMetricsOverride',{width:960,height:720,deviceScaleFactor:1,mobile:false});
 page.tab.socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.consoleAPICalled'){const message=m.params.args.map(a=>a.value??a.description??'').join(' ');if(m.params.type==='error')console.error(message);else if(message.startsWith('[photon-radius]'))console.log(message);}});await page.tab.call('Runtime.enable');
 if(scene==='cornell'){
 for(let i=0;i<900;i++) {
 const state=await page.tab.evaluate(`(async()=>{try{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const e=getEngine();return e&&{model:e.code()?.includes('cornell_caustic'),samples:e.final.samples};}catch{return null;}})()`);
 if(state?.model&&state.samples>0)break;
 if(i===899)throw Error('Cornell load timeout: '+JSON.stringify(state));await delay(200);
 }
 const audit=await page.tab.evaluate(`(async()=>{const {getEngine}=await import('/src/engine/ViewerEngine.ts');const {useViewer,setSettings}=await import('/src/store.ts');setSettings({cameraIndex:0,denoise:false,caustics:false,fStop:0});useViewer.setState({paused:true});const e=window.causticViewer=getEngine();e.final.fallback=null;e.final.denoiser=null;e.final.aovs=[];e.final.bounces=${Number(process.env.BOUNCES??8)};e.final.bevel=false;e.final.batchSamples=false;e.final.resolutionScale=1;e.engine.display.setSize(${width},${height});e.engine.display.toneMappingExposure=${exposure};e.engine.camera.copy(e.lensCamera(e.modelCameras[0],10));
 const objects=[];e.modelGroup.traverse(o=>{if(o.isMesh){objects.push({name:o.name,matrix:o.matrixWorld.toArray(),materials:(Array.isArray(o.material)?o.material:[o.material]).map(m=>({name:m.name,ior:m.ior,roughness:m.roughness,transmission:m.transmission,emissive:m.emissive?.toArray(),emissiveIntensity:m.emissiveIntensity}))});if(${process.argv.includes('--no-water')}&&o.name.includes('Water'))o.visible=false;}});
 e.sync.update();e.viewSync.update();e.engine.camera.aspect=${width}/${height};e.needsResize=false;e.engine.update();return{limits:e.engine.device?{maxStorageBufferBindingSize:e.engine.device.limits.maxStorageBufferBindingSize,maxBufferSize:e.engine.device.limits.maxBufferSize}:null,objects,camera:{transform:Array.from(e.engine.camera.transform),fov:e.engine.camera.fov,aspect:e.engine.camera.aspect},code:e.code()};})()`);

 writeFileSync(resolve(directory,'scene.json'),JSON.stringify(audit,null,2));
 }else{for(let i=0;i<200;i++){if(await page.tab.evaluate('!!window.causticsTests'))break;await delay(100);}}
 await page.tab.evaluate(`(async()=>{const {causticDiagnostics:d}=await import('/@fs/${root}/src/renderer/causticDiagnostics.ts');const research=await import('/@fs/${root}/src/research/mnee/index.ts');research.registerMnee();research.mneeDiagnostics.mnee=false;research.mneeDiagnostics.captureRoots=true;window.photonGridCounters=${process.env.COUNTERS==='1'};window.photonAudit=${process.env.AUDIT==='1'};d.photonSkipQuery=${process.env.QUERY_OFF==='1'};d.photonScreenRadius=${process.env.SCREEN_RADIUS!=='0'};d.photonSeparate=${process.env.SEPARATE==='1'};d.capturePhotons=true;window.causticSize=[${width},${height}];})()`);
 for(const mode of modes){
 const settings={lightTracing:mode==='light'||mode==='light-photon',photonMapping:mode==='fixed'?{photonsPerSample:Number(process.env.FIXED_PHOTONS??262144)}:mode==='reference'?{photonsPerSample:Number(process.env.REFERENCE_PHOTONS??5000000),initialRadius:.05}:mode==='photon'||mode==='light-photon'};
 const options={name:scene+'-'+width+'x'+height+'-'+mode,settings,checkpoints,countersOnly:process.env.COUNTERS_ONLY==='1',fixedPixel:scene==='cornell'&&process.env.FIXED_PIXEL==='1'?[Math.round(width/2+(140-128)*height/256),Math.round(39*height/256)]:undefined,progress:!!process.env.RADIUS_MODE,queryProfile:process.env.QUERY_PROFILE==='1',counterGroups:process.env.COUNTER_GROUPS?.split(',').map(Number),denoise:process.env.DENOISE!=='0',separate:process.env.SEPARATE==='1'};
 console.log(options.name);
 const result=await page.tab.evaluate(`(async()=>{const study=await import('/@fs/${root}/tests/gpu/photonGridStudy.ts');const {causticDiagnostics:d}=await import('/@fs/${root}/src/renderer/causticDiagnostics.ts');d.photonRadiusScaling=${JSON.stringify(process.env.RADIUS_MODE??'none')};d.photonAlpha=${mode==='reference'?.3:2/3};${scene==='cornell'?`return await study.measure(window.causticViewer.engine,window.causticViewer.final,${JSON.stringify(options)});`:`window.causticStudy=(engine,render)=>study.measure(engine,render,${JSON.stringify(options)});return await window.causticsTests.capture(${JSON.stringify(settings)},1,true,true);`}})()`);
 console.log(result.map(r=>({samples:r.samples,traceMs:r.traceMs,denoiseMs:r.denoiseMs})));
 }
 }finally{await page.close();}
}}finally{await chrome.close();await server.close();}
