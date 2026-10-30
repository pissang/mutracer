// Headless real-GPU prototype checks. Evidence is kept outside the repository.
import {createServer} from 'vite';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {compare} from './caustics-compare.mjs';
import {launchChrome,delay} from './reference-runtime.mjs';
const directory=process.env.MUTRACER_CAUSTICS_OUTPUT??'/Users/lang/.codex/experiments/mutracer-caustics-20261028';mkdirSync(directory,{recursive:true});
const server=await createServer({configFile:false,optimizeDeps:{entries:[],noDiscovery:true},server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/.native-build/**']}}});await server.listen();
const chrome=await launchChrome();
try {
 for(const backend of (process.argv.includes('--webgl')?['webgl']:['webgpu'])) {
 const page=await chrome.page(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/caustics.html`+(backend==='webgl'?'?webgl':''));
 let rejectGPU;
 const gpuError=new Promise((_,reject)=>{rejectGPU=reject;});
 page.tab.socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.consoleAPICalled' && m.params.type==='error'){const error=m.params.args.map(a=>a.value??a.description??'').join(' ');console.error(error);rejectGPU(Error(error));}});
 await page.tab.call('Runtime.enable');await page.tab.call('Log.enable');
 try {
 for(let i=0;i<200;i++){if(await page.tab.evaluate('!!window.causticsTests'))break;await delay(100);}
 if(process.env.FULL_EMISSION_RANDOM)await page.tab.evaluate(`import('/src/renderer/causticDiagnostics.ts').then(m=>m.causticDiagnostics.fullEmissionRandom=${process.env.FULL_EMISSION_RANDOM!=='0'})`);
 if(process.env.RADIUS_MODE)await page.tab.evaluate(`import('/src/renderer/causticDiagnostics.ts').then(m=>m.causticDiagnostics.photonRadiusScaling=${JSON.stringify(process.env.RADIUS_MODE)})`);
 if(process.env.BOUNCES)await page.tab.evaluate(`window.causticBounces=${Number(process.env.BOUNCES)}`);
 if(process.env.CAUSTIC_BENCHMARK)await page.tab.evaluate('window.causticBenchmark=true');
 if(process.env.CASTER_DISTRIBUTION)await page.tab.evaluate(`import('/src/renderer/causticDiagnostics.ts').then(m=>{m.causticDiagnostics.capturePhotons=true;m.causticDiagnostics.aggregateCasters=${process.env.CASTER_DISTRIBUTION==='union'};})`);
 if(process.env.WIDTH&&process.env.HEIGHT)await page.tab.evaluate(`window.causticSize=[${Number(process.env.WIDTH)},${Number(process.env.HEIGHT)}]`);
 if(process.env.MNEE_DEBUG_GROUP!==undefined)await page.tab.evaluate(`import('/src/research/mnee/index.ts').then(m=>{m.registerMnee();m.mneeDiagnostics.mneeDebugGroup=${Number(process.env.MNEE_DEBUG_GROUP)};})`);
 if(backend==='webgpu') {
 const resolved=await page.tab.evaluate('window.causticsResolveContract()');
 writeFileSync(resolve(directory,'resolve-contract.json'),JSON.stringify(resolved,null,2));
 if(process.argv.includes('--photon-map')){const photonContract=await page.tab.evaluate("import('/tests/gpu/photonMap.ts').then(m=>m.photonMapContract())");writeFileSync(resolve(directory,'photon-contract.json'),JSON.stringify(photonContract,null,2));}
 if(process.argv.includes('--accumulation-contract')){const accumulation=await page.tab.evaluate("import('/tests/gpu/causticAccumulation.ts').then(m=>m.causticAccumulationContract())");writeFileSync(resolve(directory,'accumulation-contract.json'),JSON.stringify(accumulation,null,2));}
 }
 if(process.argv.includes('--medium-contract'))writeFileSync(resolve(directory,'medium-contract.json'),JSON.stringify(await page.tab.evaluate("import('/tests/gpu/causticMedium.ts').then(m=>m.causticMediumContract())"),null,2));
 if(process.argv.includes('--emitter-contract'))writeFileSync(resolve(directory,'emitter-contract.json'),JSON.stringify(await page.tab.evaluate('window.emitterFacingContract()'),null,2));
 if(process.argv.includes('--alpha-contract'))writeFileSync(resolve(directory,'alpha-contract.json'),JSON.stringify(await page.tab.evaluate('window.alphaVisibilityContract()'),null,2));
 if(process.argv.includes('--directional-contract'))writeFileSync(resolve(directory,'directional-contract.json'),JSON.stringify(await page.tab.evaluate('window.directionalCausticsContract()'),null,2));
 if(process.argv.includes('--shared-contract'))writeFileSync(resolve(directory,'shared-contract.json'),JSON.stringify(await page.tab.evaluate('window.sharedGeometryContract()'),null,2));
 const matrix=process.argv.includes('--matrix');
 const hdrCaptures=[];
 let modes=matrix?[['off',{}],['mnee',{mnee:true}],['light',{lightTracing:true}],['both',{mnee:true,lightTracing:true}]]:[['off',{}],['mnee',{mnee:true}]];
 if(process.argv.includes('--photon-map'))modes.push(['photon',{photonMapping:true}],['all',{mnee:true,lightTracing:true,photonMapping:true}]);
 if(process.argv.includes('--full-matrix'))modes.push(['mnee-photon',{mnee:true,photonMapping:true}],['light-photon',{lightTracing:true,photonMapping:true}]);
 if(process.env.CAUSTIC_MODES)modes=modes.filter(([name])=>process.env.CAUSTIC_MODES.split(',').includes(name));
 for(const [name,settings] of modes){
 if(settings.photonMapping&&(process.env.PHOTONS_PER_SAMPLE||process.env.PHOTON_RADIUS))settings.photonMapping={photonsPerSample:Number(process.env.PHOTONS_PER_SAMPLE??6912),initialRadius:Number(process.env.PHOTON_RADIUS??.2)};
 if(settings.mnee&&process.env.MNEE_METHOD)settings.mnee={method:process.env.MNEE_METHOD};
 if(settings.lightTracing&&process.env.PHOTONS_PER_SAMPLE)settings.lightTracing={photonsPerSample:Number(process.env.PHOTONS_PER_SAMPLE)};
 console.log(backend,name);
 const value=await Promise.race([gpuError,page.tab.evaluate(`window.causticsTests.capture(${JSON.stringify(settings)},${process.env.SPP??64},${process.argv.includes('--sphere')},${(process.argv.includes('--sphere')&&!process.argv.includes('--area-light'))||process.argv.includes('--spot-plane')},false,${process.argv.includes('--wave')},${JSON.stringify(process.env.CAUSTIC_VARIANT??'')})`)]);
 if(value.hdr){hdrCaptures.push({path:name,image:{width:value.width,height:value.height,data:new Float32Array(value.hdr)}});writeFileSync(resolve(directory,`${backend}-${name}${process.argv.includes('--sphere')?'-sphere':process.argv.includes('--spot-plane')?'-spot-plane':''}.f32`),Buffer.from(new Float32Array(value.hdr).buffer));delete value.hdr;}
 
 writeFileSync(resolve(directory,`${backend}-${name}${process.argv.includes('--sphere')?'-sphere':process.argv.includes('--spot-plane')?'-spot-plane':''}.png`),Buffer.from(value.image.split(',')[1],'base64'));delete value.image;
 writeFileSync(resolve(directory,`${backend}-${name}${process.argv.includes('--sphere')?'-sphere':process.argv.includes('--spot-plane')?'-spot-plane':''}.json`),JSON.stringify(value,null,2));console.log(value.mean,value.finite);
 }
 if(hdrCaptures.length&&!process.argv.includes('--sphere')&&!(process.env.CAUSTIC_VARIANT)){const reference=hdrCaptures.find(c=>c.path==='off');if(reference){const metrics=compare(reference.image,hdrCaptures,{receiver:true});writeFileSync(resolve(directory,backend+'-receiver-energy.json'),JSON.stringify(metrics,null,2));if(process.argv.includes('--sanity')&&metrics.rows.some(r=>r.path==='mnee'&&Math.abs(r.relativeError.rawMean)>.01))throw Error('MNEE receiver energy regression');}}
 }finally{await page.close();}
 }
}finally{await chrome.close();await server.close();}
