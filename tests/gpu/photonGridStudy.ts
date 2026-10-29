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
export async function measure(engine: Engine, render: Render, options: {name:string;settings:CausticSettings;checkpoints:number[];countersOnly?:boolean}) {
  const errors:string[]=[];
  engine.device?.addEventListener('uncapturederror', e=>errors.push((e as GPUUncapturedErrorEvent).error.message));
  render.caustics=options.settings;
  render.batchSamples=false;render.maxTiles=1;render.timeBudgetMs=1000;render.bounces=8;
  render.bevel=false;render.fallback=null;render.aovs=[];await render.setDenoiser(null);
  d.captureRoots=true;
  await render.converge({samples:1,samplesPerBatch:1,sampleSequenceOffset:17});
  const results=[];
  for(const samples of options.countersOnly?[]:options.checkpoints){
    const started=performance.now();
    await render.converge({samples,samplesPerBatch:1,sampleSequenceOffset:17});
    await engine.device?.queue.onSubmittedWorkDone();
    const totalMs=performance.now()-started;
    const hdr=await render.readPixels('hdr');
    const row={name:options.name,samples,width:hdr.width,height:hdr.height,totalMs,traceMs:totalMs,denoiseMs:0};
    await save(options.name+'-'+samples+'.f32',hdr.data.buffer as ArrayBuffer);
    await save(options.name+'-'+samples+'.json',JSON.stringify(row));results.push(row);
  }
  if(!options.countersOnly){
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
  const pass=d.rootPass as any;
  const memory=pass?._photonMap?.bytes(pass._activeTarget)??0;
  const batch=pass?._photonMap?.get(pass._activeTarget);
  const profile={samples:render.samples,timings,memory,emitted:batch?.count,buckets:batch?.buckets,diagnostics:engine.getDiagnostics()};
  await save(options.name+'-profile.json',JSON.stringify(profile,null,2));
  }
  d.photonDebugBatch=64;
  if((window as any).photonGridCounters&&options.settings.photonMapping){
    const deepReads:number[]=[],deepPassed:number[]=[],rows=[];
    // Transmission paths may shade more than bounces events; PM accepts depths 0–20.
    for(const group of [50,...Array.from({length:21},(_,i)=>51+i)]){
      d.mneeDebugGroup=group;
      render.restart();
      await render.converge({samples:1,samplesPerBatch:1,sampleSequenceOffset:80});
      const hdr=await render.readPixels('hdr');const reads:number[]=[],passed:number[]=[];
      for(let i=0;i<hdr.data.length;i+=4)if(hdr.data[i+2]>.5){reads.push(hdr.data[i]);passed.push(hdr.data[i+1]);}
      if(group!==50){for(const x of reads)deepReads.push(x);for(const x of passed)deepPassed.push(x);}
      rows.push({group,read:stats(reads),passed:stats(passed)});
    }
    rows.push({group:99,read:stats(deepReads),passed:stats(deepPassed)});
    await save(options.name+'-queries.json',JSON.stringify(rows,null,2));
    d.mneeDebugGroup=-1;
  }
  d.photonDebugBatch=undefined;
  if(errors.length)throw Error(errors.join('\n'));
  return results;
}
