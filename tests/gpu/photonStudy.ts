import type Engine from '../../src/Engine.js';
import type Render from '../../src/Render.js';
import type {CausticSettings} from '../../src/Render.js';
import {causticDiagnostics} from '../../src/renderer/causticDiagnostics.js';

interface StudyOptions {
  name: string;
  settings: CausticSettings;
  checkpoints: number[];
  denoise?: boolean;
  separate?: boolean;
}

async function save(name: string, body: BodyInit) {
  const result = await fetch('/__evidence/' + name, {method: 'POST', body});
  if (!result.ok) throw Error('Evidence write failed: ' + name);
}

/** Independent fixed-seed batches, with public HDR and OIDN readback. */
export async function measure(engine: Engine, render: Render, options: StudyOptions) {
  const gpuErrors:string[]=[];
  const onGPUError=(event:Event)=>gpuErrors.push((event as GPUUncapturedErrorEvent).error.message);
  engine.device?.addEventListener('uncapturederror',onGPUError);
  causticDiagnostics.mnee = false;
  render.caustics = options.settings;
  render.batchSamples = false;
  render.maxTiles = 1;
  render.timeBudgetMs = 1000;
  render.bounces = 8;
  render.bevel = false;
  render.fallback = null;
  render.aovs = [];
  await render.setDenoiser(options.denoise === false ? null : {
    type: 'oidn', model: 'standard', schedule: 'progressive', weightsBaseUrl: '/oidn/weights/'
  });
  const results = [];
  const audit:any[]=[];
  const pass=causticDiagnostics.rootPass as any;
  if((window as any).photonAudit&&pass){
    pass.__originalCreatePass??=pass.createPass;
    pass.createPass=function(...args:any[]){audit.push({sample:this._rtUniform.views.sampleCount[0],light:this._lightTracing,photon:this._photonMapping,width:this._width,height:this._height});return this.__originalCreatePass(...args);};
  }
  // Warm pipelines and OIDN before timing. converge restarts its fixed sequence.
  await render.converge({samples: 1, samplesPerBatch: 1, sampleSequenceOffset: 17});
  for (const samples of options.checkpoints) {
    const started = performance.now();
    let traceEnded = started;
    await render.converge({samples, samplesPerBatch: 1, sampleSequenceOffset: 17,
      onProgress: event => { if (event.stage === 'denoising') traceEnded = performance.now(); }});
    await engine.device?.queue.onSubmittedWorkDone();
    const ended = performance.now();
    if(render.samples!==samples)throw Error('Incomplete study checkpoint: '+JSON.stringify({wanted:samples,actual:render.samples,status:render.status}));
    if (options.denoise === false) traceEnded = ended;
    const name = options.name + '-' + samples;
    const hdr = await render.readPixels('hdr');
    await save(name + '.f32', hdr.data.buffer as ArrayBuffer);
    engine.display.present(render);
    const canvas=engine.display.canvas;
    await save(name + '.png', canvas instanceof HTMLCanvasElement?await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!))):await canvas.convertToBlob());
    if (options.denoise !== false) {
      const filtered = await render.readPixels('denoised');
      await save(name + '-oidn.f32', filtered.data.buffer as ArrayBuffer);
    }
    await render._output!.flushDiagnostics();
    if(gpuErrors.length)throw Error(gpuErrors.join('\n'));
    const diagnostics = engine.getDiagnostics();
    const metadata = {name, samples, width: hdr.width, height: hdr.height,
      traceMs: traceEnded - started, denoiseMs: ended - traceEnded, totalMs: ended - started,
      settings: options.settings, actualSamples:render.samples,audit:audit.splice(0),diagnostics};
    await save(name + '.json', JSON.stringify(metadata, null, 2));
    if (options.denoise !== false) await save(name + '-oidn.json', JSON.stringify(metadata));
    if(options.separate&&options.denoise!==false){
      // Evidence-only frozen-input prototype. Production display/denoise order
      // stays unchanged until an A/B warrants a separate accumulation target.
      const modulePath=new URL('../../scripts/caustics-study-color.mjs',import.meta.url).href;
      const {displayLinear}=await import(/* @vite-ignore */ modulePath);
      causticDiagnostics.photonSkipVisible=true;
      await render.converge({samples,samplesPerBatch:1,sampleSequenceOffset:17});
      const pt=await render.readPixels('hdr'),filtered=await render.readPixels('denoised');
      causticDiagnostics.photonSkipVisible=false;
      const fullDisplay=displayLinear(hdr),ptDisplay=displayLinear(pt);
      for(let i=0;i<filtered.data.length;i++)if(i%4<3)filtered.data[i]=Math.max(0,filtered.data[i]+fullDisplay.data[i]-ptDisplay.data[i]);
      await save(name+'-bypass-oidn.f32',filtered.data.buffer as ArrayBuffer);
      await save(name+'-bypass.f32',hdr.data.buffer as ArrayBuffer);
      await save(name+'-bypass.json',JSON.stringify(metadata));
      await save(name+'-bypass-oidn.json',JSON.stringify({...metadata,prototype:'PT/deeper-photon OIDN plus frozen visible-photon display delta; no production order change'}));
    }
    results.push(metadata);
  }
  await render.setDenoiser(null);
  render.maxSamples = 16;
  render.restart();
  const timings: unknown[] = [];
  const profileStarted = performance.now();
  for (let i = 0; render.samples < 16 && i < 10000; i++) {
    render.refine();
    await engine.device?.queue.onSubmittedWorkDone();
    await new Promise(resolve => setTimeout(resolve, 0));
    await render._output!.flushDiagnostics();
    if(gpuErrors.length)throw Error(gpuErrors.join('\n'));
    const timing = engine.getDiagnostics()?.gpuTraceTiming;
    if (timing) timings.push({...timing});
  }
  await save(options.name + '-profile.json', JSON.stringify({samples: render.samples,
    wallMs: performance.now() - profileStarted, timings, diagnostics: engine.getDiagnostics()}, null, 2));
  engine.device?.removeEventListener('uncapturederror',onGPUError);
  if(gpuErrors.length)throw Error(gpuErrors.join('\n'));
  return results;
}
