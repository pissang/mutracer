import {registerMnee, mneeDiagnostics} from '../../src/research/mnee/index.js';
import type Engine from '../../src/Engine.js';
import type Render from '../../src/Render.js';
import type {CausticSettings} from '../../src/Render.js';
import {causticDiagnostics as d} from '../../src/renderer/causticDiagnostics.js';

async function save(name: string, body: BodyInit) {
  const r = await fetch('/__evidence/' + name, {method: 'POST', body});
  if (!r.ok) throw Error('Evidence write failed: ' + name);
}
function stats(a: number[]) {
  a.sort((x,y)=>x-y);
  return {queries:a.length,mean:a.reduce((x,y)=>x+y,0)/Math.max(1,a.length),p99:a[Math.floor(a.length*.99)]??0,max:a.at(-1)??0};
}
/** Stage timings are uninstrumented; counters run separately at batch 64. */
export async function measure(engine: Engine, render: Render, options: {name:string;settings:CausticSettings;checkpoints:number[];countersOnly?:boolean;denoise?:boolean;counterGroups?:number[];queryProfile?:boolean;progress?:boolean}) {
  const errors:string[]=[];
  engine.device?.addEventListener('uncapturederror', e=>errors.push((e as GPUUncapturedErrorEvent).error.message));
  render.caustics=options.settings;
  render.batchSamples=false;render.maxTiles=1;render.timeBudgetMs=1000;render.bounces=8;
  render.bevel=false;render.fallback=null;render.aovs=[];await render.setDenoiser(null);
  registerMnee(); mneeDiagnostics.captureRoots=true;
  await render.converge({samples:1,samplesPerBatch:1,sampleSequenceOffset:17});
  const results=[];
  if (options.denoise && !options.countersOnly) {
    await render.setDenoiser({type:'oidn', model:'standard', schedule:'progressive', weightsBaseUrl:'/oidn/weights/'});
    await render.converge({samples:1,samplesPerBatch:1,sampleSequenceOffset:17});
  }
  for(const samples of options.countersOnly?[]:options.checkpoints){
    const started=performance.now();
    let traceEnded=started;
    await render.converge({samples,samplesPerBatch:1,sampleSequenceOffset:17,
      onProgress:event=>{
        if(event.stage==='denoising')traceEnded=performance.now();
        if(options.progress&&event.stage==='final'&&event.samples%64===0)
          console.log(`[photon-radius] ${options.name} ${event.samples}/${samples}`);
      }});
    await engine.device?.queue.onSubmittedWorkDone();
    const ended=performance.now(),totalMs=ended-started;
    if(!options.denoise)traceEnded=ended;
    const hdr=await render.readPixels('hdr');
    const row={name:options.name,samples,width:hdr.width,height:hdr.height,totalMs,traceMs:traceEnded-started,denoiseMs:ended-traceEnded};
    await save(options.name+'-'+samples+'.f32',hdr.data.buffer as ArrayBuffer);
    await save(options.name+'-'+samples+'.json',JSON.stringify(row));results.push(row);
    if(options.denoise){
      const denoised=await render.readPixels('denoised');
      await save(options.name+'-'+samples+'-oidn.f32',denoised.data.buffer as ArrayBuffer);
      await save(options.name+'-'+samples+'-oidn.json',JSON.stringify(row));
    }
  }
  await render.setDenoiser(null);
  if(!options.countersOnly){
  const originalSkip=d.photonSkipQuery;
  for(const skip of options.queryProfile?[false,true]:[!!originalSkip]){
  d.photonSkipQuery=skip;
  const timings=[];
  // Hold the progressive radius at the 64th batch, with fixed query/emit streams.
  d.photonDebugBatch=64;
  await render.converge({samples:1,samplesPerBatch:1,sampleSequenceOffset:80});
  render.maxSamples=12;render.restart();
  for(let i=0;render.samples<12&&i<10000;i++){
    const before=render.samples;
    render.refine();await engine.device?.queue.onSubmittedWorkDone();
    await new Promise(r=>setTimeout(r,0));await render._output!.flushDiagnostics();
    if(render.samples>before){const t=engine.getDiagnostics()?.gpuTraceTiming;if(t)timings.push({...t});}
  }
  const pass=mneeDiagnostics.rootPass as any;
  const memory=pass?._photonMap?.bytes(pass._activeTarget)??0;
  const batch=pass?._photonMap?.get(pass._activeTarget);
  const profile={samples:render.samples,timings,memory,emitted:batch?.count,buckets:batch?.buckets,diagnostics:engine.getDiagnostics()};
  await save(options.name+(skip&&options.queryProfile?'-queryoff':'')+'-profile.json',JSON.stringify(profile,null,2));
  }
  d.photonSkipQuery=originalSkip;
  }
  d.photonDebugBatch=64;
  if((window as any).photonGridCounters&&options.settings.photonMapping){
    const deepReads:number[]=[],deepPassed:number[]=[],rows=[];
    // Transmission paths may shade more than bounces events; PM accepts depths 0–20.
    for(const group of options.counterGroups??[50,...Array.from({length:21},(_,i)=>51+i)]){
      d.debugGroup=group;
      render.restart();
      await render.converge({samples:1,samplesPerBatch:1,sampleSequenceOffset:80});
      const hdr=await render.readPixels('hdr');const reads:number[]=[],passed:number[]=[];let queryCount=0,totalReads=0,totalPassed=0;
      for(let i=0;i<hdr.data.length;i+=4)if(hdr.data[i+2]>.5){reads.push(hdr.data[i]);passed.push(hdr.data[i+1]);queryCount+=hdr.data[i+2];totalReads+=hdr.data[i];totalPassed+=hdr.data[i+1];}
      if(group!==50){for(const x of reads)deepReads.push(x);for(const x of passed)deepPassed.push(x);}
      rows.push({group,read:stats(reads),passed:stats(passed),queryCount,totalReads,totalPassed,readsPerQuery:totalReads/Math.max(1,queryCount),passedPerQuery:totalPassed/Math.max(1,queryCount)});
    }
    rows.push({group:99,read:stats(deepReads),passed:stats(deepPassed)});
    await save(options.name+'-queries.json',JSON.stringify(rows,null,2));
    d.debugGroup=-1;
  }
  d.photonDebugBatch=undefined;
  if(errors.length)throw Error(errors.join('\n'));
  return results;
}
