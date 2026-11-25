import {Engine, Render, getRecommendedDeviceDescriptor} from '../../src/main';
import {TemporalDenoiser, type TemporalFrame} from '../../src/temporal';
import Camera from '../../src/scene/Camera';
import {estimateTemporalMemory, temporalMemoryTiers} from '../../src/temporal/memoryPlan';
import {normalizeTemporalOptions} from '../../src/temporal/options';
import {DirectWindowGPU} from '../../src/renderer/WGPUTemporalWindow';
import {createComposePackWGSL} from '../../src/renderer/temporalComposeShader';
import {TemporalHistoryGPU} from '../../src/renderer/WGPUTemporalHistory';
import {TemporalPostGPU} from '../../src/renderer/WGPUTemporalPost';
import {THREESync, fromTHREECamera} from '../../src/three';
import * as THREE from 'three';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejects(promise: Promise<unknown>, expected: RegExp) {
  try { await promise; } catch (error) { if (expected.test(String(error))) return; throw error; }
  throw new Error('Expected rejection: ' + expected);
}

async function run() {
  if (location.search === '?webgl') {
    const engine = new Engine({canvas: document.createElement('canvas'), backend: 'webgl'});
    const render = new Render(engine, {width: 64, height: 64, maxSamples: 1});
    const temporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false, denoiser: null});
    temporal.attach(render);
    try { await rejects(temporal.push(render), /requires WebGPU/); return {webgl: 'rejected'}; }
    finally { temporal.dispose(); render.dispose(); engine.dispose(); }
  }
  const adapter = await navigator.gpu.requestAdapter(); check(adapter, 'WebGPU unavailable');
  const device = await adapter.requestDevice(getRecommendedDeviceDescriptor(adapter));
  const uncaptured: string[] = [];
  device.addEventListener('uncapturederror', event => uncaptured.push((event as GPUUncapturedErrorEvent).error.message));
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const engine = new Engine({canvas, device});
  const threeScene=new THREE.Scene();
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(1.4,1.1),new THREE.MeshStandardMaterial({color:0x2a84bc,roughness:.4}));
  mesh.rotation.z=.24; threeScene.add(mesh,new THREE.AmbientLight(0xffffff,1));
  const threeCamera=new THREE.PerspectiveCamera(45,1,.1,100);threeCamera.position.z=3;threeCamera.updateMatrixWorld();
  const sync=new THREESync(engine,{scene:threeScene});sync.update();const synced=sync.scene!;synced.background=[.13,.22,.36,1];engine.scene=synced;
  engine.camera=fromTHREECamera(threeCamera); engine.update();
  const render = new Render(engine, {width: 64, height: 64, maxSamples: 1});
  const temporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false, denoiser: null});
  temporal.attach(render);
  try {
    await render.converge({samples: 1}); const source = (await render.readPixels('hdr')).data; await temporal.push(render);
    check(!(temporal as any).post, 'The zero post radius allocated a post history');
    const frames = []; let accumulated: Float32Array | undefined;
    for await (const frame of temporal.flush()) { const channel=engine.display.channel; engine.display.channel='depth'; let rejected=false; try { engine.display.present(frame); } catch { rejected=true; } finally { engine.display.channel=channel; } check(rejected, 'An AOV display channel presented a temporal frame'); check(engine.display.present(frame) === frame, 'Temporal frame was not presented'); await engine.display.toBlob(frame); frames.push(await frame.readPixels()); accumulated = (await frame.readPixels('accumulated')).data; }
    check(frames.length === 1, 'Flush did not yield one frame');
    check(frames[0].width === 64 && frames[0].data.every(Number.isFinite), 'Invalid temporal output');
    let max = 0; for (let i = 0; i < source.length; i++) max = Math.max(max, Math.abs(source[i] - accumulated![i]));
    check(max <= 1e-3, `Radius-zero accumulated identity failed: ${max}`);
    temporal.dispose();
    const transactional = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false, denoiser: null});
    transactional.attach(render); await render.converge({samples: 1});
    const captureTemporal = render._captureTemporal.bind(render); (render as any)._captureTemporal = async () => { throw new Error('synthetic capture failure'); };
    await rejects(transactional.push(render), /synthetic capture failure/); (render as any)._captureTemporal = captureTemporal;
    await transactional.push(render);
    for await (const frame of transactional.flush()) check(frame.index === 0, 'Failed capture consumed a public frame index');
    transactional.dispose();
    const sequence = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 2, stabilizeSparkle: true, denoiser: null});
    const detachSequence = sequence.attach(render); let outputs = 0;
    for (let i = 0; i < 8; i++) {
      await render.converge({samples: 1, sampleSequenceOffset: i}); await sequence.push(render);
      for await (const frame of sequence.drain()) { check(frame.index === outputs, 'Drain order changed');check(engine.display.present(frame)===frame,'Post temporal frame was not presented');await engine.display.toBlob(frame);outputs++; }
    }
    for await (const frame of sequence.flush()) { check(frame.index === outputs, 'Flush order changed');check(engine.display.present(frame)===frame,'Flushed post temporal frame was not presented');await engine.display.toBlob(frame);outputs++; }
    check(outputs === 8, 'Sequence did not flush every frame');
    await render.converge({samples: 1, sampleSequenceOffset: 8}); await sequence.push(render);
    for await (const frame of sequence.flush()) { check(frame.index === 8, 'Push index reset after flush'); await frame.readPixels(); }
    await render.converge({samples: 1, sampleSequenceOffset: 9}); await sequence.push(render);
    await render.converge({samples: 1, sampleSequenceOffset: 10}); // An unpushed preview must break motion history.
    await render.converge({samples: 1, sampleSequenceOffset: 11}); await sequence.push(render);
    for await (const frame of sequence.flush()) { check(frame.index === 9 || frame.index === 10, 'AOV frame gap lost or reordered output'); await frame.readPixels(); }
    detachSequence();
    const resized = new Render(engine, {width: 31, height: 16, maxSamples: 1});
    sequence.attach(resized); await resized.converge({samples: 1}); await sequence.push(resized);
    const cutCamera = new Camera({projection: 'perspective'}); cutCamera.position = [10, 10, 10]; cutCamera.lookAt([10, 10, 11]);
    await resized.converge({samples: 1, camera: cutCamera}); await sequence.push(resized);
    for await (const frame of sequence.flush()) { check((frame.index === 11 || frame.index === 12) && frame.width === 31 && frame.height === 16, 'Flush did not cut invalid motion, reallocate for new dimensions, or preserve the denoiser index'); await frame.readPixels(); }
    sequence.dispose(); resized.dispose();
    const budgetBase = normalizeTemporalOptions({denoiser: null, stabilizeSparkle: false});
    const materialCount = engine._temporalMaterialRevisionEntries.length;
    const reducedTier = temporalMemoryTiers(budgetBase)[2];
    const reducedBudget = estimateTemporalMemory(64, 64, {...budgetBase, ...reducedTier}, materialCount);
    const reduced = new TemporalDenoiser(engine, {denoiser: null, stabilizeSparkle: false, memoryBudget: reducedBudget});
    reduced.attach(render); let reducedOutputs = 0;
    for (let i = 0; i < 12; i++) {
      await render.converge({samples: 1, sampleSequenceOffset: 200 + i}); await reduced.push(render);
      for await (const frame of reduced.drain()) { check(frame.index === reducedOutputs, 'Reduced history changed output order'); reducedOutputs++; }
    }
    check(reduced.plan?.historyRadius.max === 4 && reduced.latency === 7, 'Budget plan did not update the active window radius and latency');
    const reducedInternal = reduced as any;
    const liveBase = reducedInternal.history.memory().total + reducedInternal.window.memory().total + reducedInternal.post.memory().total +
      reducedInternal.motionCoverageCounts.size + reducedInternal.composeParams.size;
    const exactReducedPeak = liveBase + 64 * 64 * (4 * 80 + 3 * 64 + 32);
    check(reduced.plan!.bytes === exactReducedPeak, `Temporal plan did not match live allocations and bounded queue: ${reduced.plan!.bytes} vs ${exactReducedPeak} (base ${liveBase}, pre ${reducedInternal.history.memory().total}, window ${reducedInternal.window.memory().total}, post ${reducedInternal.post.memory().total}, expected ${estimateTemporalMemory(64, 64, {...budgetBase, ...reduced.plan}, materialCount)})`);
    for await (const frame of reduced.flush()) { check(frame.index === reducedOutputs, 'Reduced history flush changed output order'); reducedOutputs++; }
    check(reducedOutputs === 12, `Reduced ring overwrote or lost frames after exceeding capacity: ${reducedOutputs}`);
    reduced.dispose();
    const oom = new TemporalDenoiser(engine, {
      accumulateGuides: true,
      denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'},
    });
    oom.attach(render);
    await render.converge({samples: 1, sampleSequenceOffset: 250});
    const pushErrorScope = device.pushErrorScope, popErrorScope = device.popErrorScope;
    const filters: GPUErrorFilter[] = [];
    let attempts = 0;
    device.pushErrorScope = filter => { pushErrorScope.call(device, filter); filters.push(filter); };
    device.popErrorScope = async () => {
      const filter = filters.pop();
      const error = await popErrorScope.call(device);
      if (filter !== 'out-of-memory' || error) return error;
      attempts++;
      return attempts === 1 ? new GPUOutOfMemoryError('Simulated allocation failure') : null;
    };
    try {
      await oom.push(render);
      check(attempts === 2 && oom.plan?.historyRadius.max === 8 && oom.latency === 11,
        'An out-of-memory scope error did not retry the next plan exactly once');
      const {history, window} = oom as any;
      check(window.guides && history.guideCapacity === 17, 'The OOM retry did not rebuild the smaller guide ring');
    } finally {
      device.pushErrorScope = pushErrorScope;
      device.popErrorScope = popErrorScope;
      oom.dispose();
    }
    // Both axes exercise the padded target stride and the exact public crop.
    const oidnRender = new Render(engine, {width: 57, height: 51, maxSamples: 3,
      denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
    const oidnTemporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false,
      denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
    oidnTemporal.attach(oidnRender); await oidnRender.converge({samples: 3});
    const builtIn = (await oidnRender.readPixels('denoised')).data;
    const baseline=await blobPixels(await engine.display.toBlob(oidnRender)); await oidnTemporal.push(oidnRender);
    let temporalOIDN: Float32Array | undefined, presentationIdentity=0, vignetteChange=0;
    for await (const frame of oidnTemporal.flush()) {
      const read = await frame.readPixels();
      check(frame.width === 57 && frame.height === 51 && read.width === 57 && read.height === 51 &&
        read.data.length === builtIn.length, 'Temporal OIDN readback did not use the requested crop');
      temporalOIDN=read.data; check(engine.display.present(frame)===frame,'OIDN temporal frame was not presented');
      const clean=await blobPixels(await engine.display.toBlob(frame)); engine.display.vignette=.8;
      const vignette=await blobPixels(await engine.display.toBlob(frame)); engine.display.vignette=0;
      for(let i=0;i<clean.length;i++){presentationIdentity=Math.max(presentationIdentity,Math.abs(clean[i]-baseline[i]));vignetteChange=Math.max(vignetteChange,Math.abs(clean[i]-vignette[i]));}
    }
    let oidnMax = 0; for (let i = 0; i < builtIn.length; i++) if (i % 4 !== 3) oidnMax = Math.max(oidnMax, Math.abs(builtIn[i] - temporalOIDN![i]));
    check(oidnMax <= 1e-6, `OIDN identity failed: ${oidnMax}`);
    check(presentationIdentity<=1,`OIDN presentation identity failed: ${presentationIdentity}`);check(vignetteChange>0,'Vignette did not affect temporal presentation');
    oidnTemporal.dispose();
    const postReadTemporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 1, stabilizeSparkle: false,
      denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
    postReadTemporal.attach(oidnRender); await oidnRender.converge({samples: 3, sampleSequenceOffset: 1});
    const postReadBaseline = (await oidnRender.readPixels('denoised')).data;
    await postReadTemporal.push(oidnRender);
    let postReadMaximum = 0;
    for await (const frame of postReadTemporal.flush()) {
      const postReadOutput = (await frame.readPixels('denoised')).data;
      for (let i = 0; i < postReadBaseline.length; i++) if (i % 4 !== 3) {
        postReadMaximum = Math.max(postReadMaximum, Math.abs(postReadBaseline[i] - postReadOutput[i]));
      }
    }
    check(postReadMaximum <= .01, `Post-filtered readPixels left the OIDN color space: ${postReadMaximum}`);
    postReadTemporal.dispose(); oidnRender.dispose();
    let receivedRoughness = false;
    const custom = {async denoise(input: Parameters<import('../../src/Render').Denoiser['denoise']>[0]) {
      receivedRoughness = !!input.aovs?.roughness;
      const encoder = input.device.createCommandEncoder(); encoder.copyBufferToBuffer(input.color, 0, input.output, 0, input.color.size);
      input.device.queue.submit([encoder.finish()]);
    }};
    const customTemporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false,
      denoiser: {type: 'custom', denoiser: custom, aovs: ['roughness']}});
    customTemporal.attach(render); await render.converge({samples: 1, sampleSequenceOffset: 99}); await customTemporal.push(render);
    for await (const frame of customTemporal.flush()) { check(engine.display.present(frame)===frame,'Custom temporal frame was not presented');await engine.display.toBlob(frame); }
    check(receivedRoughness, 'Custom temporal denoiser did not receive its declared AOV'); customTemporal.dispose();
    const narrowRender=new Render(engine,{width:31,height:16,maxSamples:1});
    const narrowTemporal=new TemporalDenoiser(engine,{historyRadius:0,postRadius:0,stabilizeSparkle:false,denoiser:null});
    narrowTemporal.attach(narrowRender);await narrowRender.converge({samples:1});await narrowTemporal.push(narrowRender);
    const narrowHDR = (await narrowRender.readPixels('hdr')).data;
    for await (const frame of narrowTemporal.flush()) {
      const read = await frame.readPixels('accumulated');
      check(read.width === 31 && read.height === 16 && read.data.every((value, i) => Math.abs(value - narrowHDR[i]) <= 1e-3),
        'Temporal accumulation did not match the fixed render crop');
    }
    narrowTemporal.dispose(); narrowRender.dispose();
    const displayAovRender = new Render(engine, {resolutionScale: .5, aovResolution: 'display', maxSamples: 1});
    const displayAovTemporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false, denoiser: null});
    displayAovTemporal.attach(displayAovRender);
    await displayAovRender.converge({samples: 1});
    await rejects(displayAovTemporal.push(displayAovRender), /AOVs at the render resolution/);
    displayAovTemporal.dispose(); displayAovRender.dispose();
    await exercisePaddedPresentation(engine);
    const fullIdResult = await exerciseFullWidthIds(device);
    const overflowResult = await exerciseFullOverflow(device);
    const floatingPostResult = await exerciseFloatingPostCodes(device);
    const materialAcceptanceResult = await exerciseMaterialAcceptance(device);
    const forwardSeed = await exerciseForwardMotionSeed(device);
    await device.queue.onSubmittedWorkDone();
    check(uncaptured.length === 0, `Uncaptured WebGPU errors: ${uncaptured.join(' | ')}`);
    return {identity: true, max, sequence: true, oidnMax, presentationIdentity, vignetteChange, customAov: receivedRoughness, fullIdResult, overflowResult, floatingPostResult, materialAcceptanceResult, forwardSeed, uncapturedErrors: uncaptured.length, plan: temporal.plan};
  } finally { temporal.dispose(); render.dispose(); sync.dispose(); engine.dispose(); device.destroy(); }
}

async function exercisePaddedPresentation(engine: Engine) {
  const width = 64, height = 56;
  const render = new Render(engine, {width, height, maxSamples: 1});
  const temporal = new TemporalDenoiser(engine, {historyRadius: 2, postRadius: 1,
    denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
  const canvas = engine.display.canvas;
  const context = new OffscreenCanvas(width, height).getContext('2d', {willReadFrequently: true})!;
  temporal.attach(render);

  async function compare(frame: TemporalFrame) {
    const read = await frame.readPixels('denoised');
    check(read.width === width && read.height === height, 'Incorrect readback crop');
    check(engine.display.present(frame) === frame, 'Padded temporal frame was not presented');
    // The canvas shows the full 64x64 target. Compare its visible export rectangle.
    context.drawImage(canvas, 0, 4, width, height, 0, 0, width, height);
    const shown = context.getImageData(0, 0, width, height).data;
    const png = await blobPixels(await engine.display.toBlob(frame));
    check(png.length === read.data.length, 'Incorrect PNG crop');
    let presentError = 0, exportError = 0;
    for (let i = 0; i < read.data.length; i++) {
      if (i % 4 === 3) continue;
      const linear = read.data[i];
      const srgb = linear <= .0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - .055;
      const code = Math.round(255 * Math.min(1, Math.max(0, srgb)));
      presentError = Math.max(presentError, Math.abs(shown[i] - code));
      exportError = Math.max(exportError, Math.abs(png[i] - code));
    }
    check(presentError <= 1 && exportError <= 1,
      `Padded frame ${frame.index} differs from readback: present ${presentError}, PNG ${exportError}`);
  }

  try {
    let drained = 0, flushed = 0;
    for (let i = 0; i < 6; i++) {
      // Move the plane across the border so queued frames have different edge pixels.
      const camera = new Camera({projection: 'perspective', fov: 45});
      const y = i % 2 ? -.6 : .6;
      camera.position = [0, y, 2]; camera.lookAt([0, y, 0]);
      await render.converge({camera, samples: 1, sampleSequenceOffset: i});
      await temporal.push(render);
      if (i === 4) continue; // Also drain two finished frames together.
      for await (const frame of temporal.drain()) { await compare(frame); drained++; }
    }
    for await (const frame of temporal.flush()) { await compare(frame); flushed++; }
    check(drained === 3 && flushed === 3, 'Expected three drain and three flush frames');
  } finally { temporal.dispose(); render.dispose(); }
}

async function createTestWindow(device: GPUDevice, width: number, height: number, capacity: number, accumulateGuides = false) {
  const history = await TemporalHistoryGPU.create(device, width, height, capacity, accumulateGuides ? capacity : 1, false);
  const window = await DirectWindowGPU.create(history, false, accumulateGuides);
  return {
    history,
    guides: window.guides,
    rejects: window.rejects,
    filter: window.filter.bind(window),
    read: window.read.bind(window),
    async upload(frame: number, metadata: Parameters<typeof history.capture>[1],
      arrays: Record<string, Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>>) {
      const buffers: Record<string, GPUBuffer> = {};
      try {
        for (const [key, data] of Object.entries({...arrays, normal: arrays.normal ?? arrays.centerNormal})) {
          const buffer = device.createBuffer({size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
          device.queue.writeBuffer(buffer, 0, data);
          buffers[key === 'hdr' ? 'color' : key] = buffer;
        }
        await history.capture(frame, metadata, buffers);
      } finally { for (const buffer of Object.values(buffers)) buffer.destroy(); }
    },
    dispose() { window.dispose(); history.dispose(); },
  };
}

async function exerciseFullWidthIds(device: GPUDevice) {
  const width=8,height=8,pixels=width*height;
  const position=new Float32Array(pixels*4),depth=new Float32Array(pixels*4),normal=new Float32Array(pixels*4),roughness=new Float32Array(pixels*4),albedo=new Float32Array(pixels*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;position.set([(2*(x+.5)/width)-1,1-(2*(y+.5)/height),0,1],i);
    depth.set([1,0,0,1],i);normal.set([0,0,1,1],i);roughness.set([.5,0,0,1],i);albedo.set([.5,.5,.5,1],i);
  }
  const identity=new Float32Array(16);identity[0]=identity[5]=identity[10]=identity[15]=1;
  const metadata={viewProjection:identity,projection:identity,apertureRadius:0,focusDistance:1};
  const motion=new Float32Array(pixels*4);for(let i=0;i<pixels;i++)motion.set([0,0,1,3],i*4);
  const arrays=(objectId:number,color:[number,number,number])=>{
    const id=new Uint32Array(pixels*4),hdr=new Float32Array(pixels*4);
    for(let i=0;i<pixels;i++){id.set([objectId,2,3,0],i*4);hdr.set([...color,1],i*4);}
    return {centerPosition:position,centerDepth:depth,centerNormal:normal,motion,roughness,albedo,id,hdr};
  };
  const window=await createTestWindow(device, width, height, 2);
  try{
    await window.upload(0,metadata,arrays(1,[0,1,0]));
    await window.upload(1,metadata,arrays(65537,[1,0,0]));
    const output=new Float32Array(await window.read(await window.filter(1,[0],false)));
    let maximumError=0;
    for(let i=0;i<pixels;i++)for(let c=0;c<3;c++)maximumError=Math.max(maximumError,Math.abs(output[i*4+c]-(c===0?1:0)));
    check(maximumError===0,`32-bit temporal IDs aliased: ${maximumError}`);
    return {ids:[1,65537],maximumError};
  }finally{window.dispose();}
}

async function exerciseFullOverflow(device: GPUDevice) {
  const width=65,height=64,pixels=width*height;
  const position=new Float32Array(pixels*4),depth=new Float32Array(pixels*4),normal=new Float32Array(pixels*4),roughness=new Float32Array(pixels*4),albedo=new Float32Array(pixels*4),id=new Uint32Array(pixels*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;position.set([(2*(x+.5)/width)-1,1-(2*(y+.5)/height),0,1],i);
    depth.set([1,0,0,1],i);normal.set([0,0,1,1],i);roughness.set([.5,0,0,1],i);albedo.set([.5,.5,.5,1],i);id.set([7,8,9,0],i);
  }
  const identity=new Float32Array(16);identity[0]=identity[5]=identity[10]=identity[15]=1;
  const metadata={viewProjection:identity,projection:identity,apertureRadius:0,focusDistance:1};
  const motion=new Float32Array(pixels*4);for(let i=0;i<pixels;i++)motion.set([0,0,1,3],i*4);
  const arrays=(color:[number,number,number])=>{
    const hdr=new Float32Array(pixels*4);for(let i=0;i<pixels;i++)hdr.set([...color,1],i*4);
    return {centerPosition:position,centerDepth:depth,centerNormal:normal,motion,roughness,albedo,id,hdr};
  };
  const window=await createTestWindow(device, width, height, 2);
  try{
    await window.upload(0,metadata,arrays([0,100000,0]));
    await window.upload(1,metadata,arrays([100000,0,0]));
    const output=new Float32Array(await window.read(await window.filter(1,[0],false)));
    let fallbackPixels=0;
    for(let i=0;i<pixels;i++){
      check(Number.isFinite(output[i*4])&&Number.isFinite(output[i*4+1])&&Number.isFinite(output[i*4+2]),'Overflow fallback produced non-finite HDR');
      if(output[i*4+1]===0){check(output[i*4]>0,'Overflow fallback lost current HDR');fallbackPixels++;}
    }
    check(fallbackPixels >= pixels - 4096 && fallbackPixels < pixels,
      `Expected overlapping valid HDR and at least ${pixels - 4096} current-only pixels, got ${fallbackPixels}`);
    return {pixels,tableEntries:4096,fallbackPixels};
  }finally{window.dispose();}
}

async function exerciseFloatingPostCodes(device: GPUDevice) {
  const width=8,height=8,pixels=width*height,linear=.5;
  const input=new Float32Array(pixels*4);for(let i=0;i<pixels;i++)input.set([linear,linear,linear,1],i*4);
  const buffer=device.createBuffer({size:input.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(buffer,0,input);
  const history = await TemporalHistoryGPU.create(device, width, height, 1, 1, false);
  const post = await TemporalPostGPU.create(history, 1);
  try{
    await post.setDisplayBuffer(0,buffer);await post.filter(0,[]);
    const output=new Float32Array(await post.read());
    const expected=(1.055*Math.pow(linear,1/2.4)-.055)*255;
    check(Math.abs(output[0]-expected)<.1,`Post code lost float precision: ${output[0]} vs ${expected}`);
    check(output[0]!==Math.round(output[0]),'Post code was rounded to an integer');
    return {linear,expected,stored:output[0]};
  }finally{post.dispose();history.dispose();buffer.destroy();}
}

async function exerciseMaterialAcceptance(device: GPUDevice) {
  const width=8,height=8,pixels=width*height;
  const centerPosition=new Float32Array(pixels*4),centerDepth=new Float32Array(pixels*4),centerNormal=new Float32Array(pixels*4),motion=new Float32Array(pixels*4),id=new Uint32Array(pixels*4),hdr=new Float32Array(pixels*4),albedo=new Float32Array(pixels*4),normal=new Float32Array(pixels*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;centerPosition.set([(2*(x+.5)/width)-1,1-(2*(y+.5)/height),0,1],i);
    centerDepth.set([1,0,0,1],i);centerNormal.set([0,0,1,1],i);motion.set([0,0,1,3],i);id.set([1,2,212,0],i);hdr.set([1,1,1,1],i);albedo.set([.5,.5,.5,1],i);normal.set([.5,.5,1,1],i);
  }
  const identity=new Float32Array(16);identity[0]=identity[5]=identity[10]=identity[15]=1;
  const meta={viewProjection:identity,projection:identity,apertureRadius:0,focusDistance:1};
  const window = await createTestWindow(device, width, height, 2);
  try{
    const upload=async(frame:number,rough:number,metal:number)=>{
      const roughness=new Float32Array(pixels*4);for(let i=0;i<pixels;i++)roughness.set([rough,metal,0,1],i*4);
      await window.upload(frame,meta,{centerPosition,centerDepth,centerNormal,roughness,motion,id,hdr,albedo,normal});
    };
    await upload(0,.5,0); await upload(1,.5,0); await window.filter(1, [0], false);
    const diffuse = new Uint32Array(await window.read(window.rejects, 4))[0];
    await upload(0,.1,.5); await upload(1,.1,.5); await window.filter(1, [0], false);
    const metal = new Uint32Array(await window.read(window.rejects, 4))[0];
    check(diffuse === pixels, 'Material 212 was scene-specifically rejected');
    check(metal === 0, 'Smooth-metal roughness rule was lost');
    return {materialId: 212, diffuseAccepted: diffuse, smoothMetalRejected: pixels - metal};
  } finally { window.dispose(); }
}

async function exerciseForwardMotionSeed(device: GPUDevice) {
  const width = 16;
  const height = 8;
  const pixels = width * height;
  const identity = new Float32Array(16);
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  const metadata = {viewProjection: identity, projection: identity, apertureRadius: 0, focusDistance: 1};
  const window = await createTestWindow(device, width, height, 3, true);

  async function upload(frame: number, start: number, brightness: number, visible: boolean) {
    const depth = new Float32Array(pixels * 4);
    const position = new Float32Array(pixels * 4);
    const normal = new Float32Array(pixels * 4);
    const guideNormal = new Float32Array(pixels * 4);
    const albedo = new Float32Array(pixels * 4);
    const roughness = new Float32Array(pixels * 4);
    const motion = new Float32Array(pixels * 4);
    const hdr = new Float32Array(pixels * 4);
    const id = new Uint32Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      const x = i % width;
      const inside = x >= start && x < start + 2;
      const at = i * 4;
      position.set([0, 0, 0, 1], at);
      depth.set([1, 0, 0, 1], at);
      normal.set([0, 0, 1, 1], at);
      // The white row represents fully covered glass. A neighboring
      // background pixel has a different guide from the moving footprint.
      const grey = inside ? brightness / 4 : 0;
      albedo.set(i < width ? [1, 1, 1, 1] : [grey, grey, grey, brightness === 1 ? .5 : 1], at);
      guideNormal.set(inside ? [0.5, 0.5, 0.5 + grey / 2, 1] : [0, 0, 0, 0], at);
      roughness.set([.5, 0, 0, 1], at);
      if (inside && visible) motion.set([-3, 0, 1, 3], at);
      hdr.set([brightness, brightness, brightness, 1], at);
      id.set([inside ? 1 : 9, 0, 1, 0], at);
    }
    await window.upload(frame, metadata, {
      centerPosition: position, centerDepth: depth, centerNormal: normal,
      albedo, normal: guideNormal, roughness, motion, hdr, id,
    });
  }

  try {
    await upload(0, 4, 1, true);
    await upload(1, 7, 3, true);
    const pixel = (3 * width + 4) * 4;
    const accumulated = await window.filter(0, [1], true);
    const accepted = new Float32Array(await window.read(accumulated));
    const expected = (1 + 3 * 8 / 9) / (1 + 8 / 9);
    check(Math.abs(accepted[pixel] - expected) < 1e-6,
      'A visible forward solution was lost because the earlier coordinate fell off the later surface');

    const guides = window.guides!;
    const albedo = new Float32Array(await window.read(guides.albedo));
    const normal = new Float32Array(await window.read(guides.normal));
    check(Math.abs(albedo[pixel] - expected / 4) < 1e-6, 'Albedo used a different landing point or weight from beauty');
    check(Math.abs(normal[pixel + 2] - expected / 4) < 1e-6, 'Guide normals lost their accumulated length');
    check(albedo[4 * 4] === 1, 'The window changed neutral glass albedo');
    const packed = await readPackedWindowGuides(device, window, accumulated, [4, 3]);
    check(Math.abs(packed.albedo[0] - expected / 2) < 1e-6 && packed.albedo[3] === 1,
      'Packing lost the averaged albedo or changed current coverage');
    check(Math.abs(packed.normal[2] - expected / 2) < 1e-6 && packed.normal[3] === 2,
      'Packing changed the weighted normal or sample count');
    await upload(1, 7, 3, false);
    await upload(2, 10, 9, true);
    const occluded = new Float32Array(await window.read(await window.filter(0, [2], true)));
    check(occluded[pixel] === 1, 'The predictor used history beyond invalid intermediate motion');
    const occludedAlbedo = new Float32Array(await window.read(guides.albedo))[pixel];
    check(occludedAlbedo === .25, 'Guides used rejected history beyond invalid intermediate motion');
    return {visible: accepted[pixel], occluded: occluded[pixel], albedo: albedo[pixel], normal: normal[pixel + 2], packed};
  } finally {
    window.dispose();
  }
}

async function readPackedWindowGuides(device: GPUDevice, window: Awaited<ReturnType<typeof createTestWindow>>,
  accumulated: GPUBuffer, [x, y]: [number, number]) {
  const {history, guides} = window;
  const {width, height} = history;
  const params = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  const outputs = Array.from({length: 3}, () => device.createBuffer({
    size: history.bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  }));
  try {
    const module = device.createShaderModule({code: createComposePackWGSL(true)});
    const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
    device.queue.writeBuffer(params, 0, new Uint32Array([width, height, 2, history.guideSlot(0)]));
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
      entries: [params, accumulated, history.guides, ...outputs, guides!.albedo, guides!.normal]
        .map((value, binding) => ({binding, resource: value instanceof GPUBuffer
          ? {buffer: value} : value.createView({dimension: '2d-array'})}))});
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
    const offset = ((height - 1 - y) * width + x) * 4;
    const read = async (buffer: GPUBuffer) =>
      Array.from(new Float32Array(await window.read(buffer)).subarray(offset, offset + 4));
    return {albedo: await read(outputs[1]), normal: await read(outputs[2])};
  } finally {
    params.destroy();
    for (const output of outputs) output.destroy();
  }
}

async function blobPixels(blob:Blob){const image=await createImageBitmap(blob);const canvas=new OffscreenCanvas(image.width,image.height);const context=canvas.getContext('2d')!;context.drawImage(image,0,0);return context.getImageData(0,0,image.width,image.height).data;}

Object.assign(window, {runTemporalDenoiseTests: run});
