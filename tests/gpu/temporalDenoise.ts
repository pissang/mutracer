import {Engine, Render, getRecommendedDeviceDescriptor} from '../../src/main';
import {TemporalDenoiser} from '../../src/temporal';
import Camera from '../../src/scene/Camera';
import {DirectWindowGPU} from '../../src/renderer/WGPUTemporalWindow';
import {TemporalGPU} from '../../src/renderer/WGPUTemporalHistory';
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
    const frames = []; let accumulated: Float32Array | undefined;
    for await (const frame of temporal.flush()) { check(engine.display.present(frame) === frame, 'Temporal frame was not presented'); await engine.display.toBlob(frame); frames.push(await frame.readPixels()); accumulated = (await frame.readPixels('accumulated')).data; }
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
    const sequence = new TemporalDenoiser(engine, {historyRadius: 2, postRadius: 1, stabilizeSparkle: true, denoiser: null});
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
    const oidnRender = new Render(engine, {width: 64, height: 64, maxSamples: 3,
      denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
    const oidnTemporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false,
      denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
    oidnTemporal.attach(oidnRender); await oidnRender.converge({samples: 3});
    const builtIn = (await oidnRender.readPixels('denoised')).data;
    const baseline=await blobPixels(await engine.display.toBlob(oidnRender)); await oidnTemporal.push(oidnRender);
    let temporalOIDN: Float32Array | undefined, presentationIdentity=0, vignetteChange=0;
    for await (const frame of oidnTemporal.flush()) {
      temporalOIDN=(await frame.readPixels()).data; check(engine.display.present(frame)===frame,'OIDN temporal frame was not presented');
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
    for await(const frame of narrowTemporal.flush()){await frame.readPixels();}narrowTemporal.dispose();narrowRender.dispose();
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
  const window=await DirectWindowGPU.create(device,width,height,2,false,true,'veto');
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
  const window=await DirectWindowGPU.create(device,width,height,2,false,true,'veto');
  try{
    await window.upload(0,metadata,arrays([0,100000,0]));
    await window.upload(1,metadata,arrays([100000,0,0]));
    const output=new Float32Array(await window.read(await window.filter(1,[0],false)));
    let fallbackPixels=0;
    for(let i=0;i<pixels;i++){
      check(Number.isFinite(output[i*4])&&Number.isFinite(output[i*4+1])&&Number.isFinite(output[i*4+2]),'Overflow fallback produced non-finite HDR');
      if(output[i*4+1]===0){check(output[i*4]>0,'Overflow fallback lost current HDR');fallbackPixels++;}
    }
    check(fallbackPixels===pixels-4096,`Expected ${pixels-4096} current-only overflow pixels, got ${fallbackPixels}`);
    return {pixels,tableEntries:4096,fallbackPixels};
  }finally{window.dispose();}
}

async function exerciseFloatingPostCodes(device: GPUDevice) {
  const width=8,height=8,pixels=width*height,linear=.5;
  const input=new Float32Array(pixels*4);for(let i=0;i<pixels;i++)input.set([linear,linear,linear,1],i*4);
  const buffer=device.createBuffer({size:input.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(buffer,0,input);
  const post=await TemporalGPU.create(device,width,height,'post',1);
  try{
    await post.setDisplayBuffer(0,buffer);await post.filter(0,[]);
    const output=new Float32Array(await post.read());
    const expected=(1.055*Math.pow(linear,1/2.4)-.055)*255;
    check(Math.abs(output[0]-expected)<.1,`Post code lost float precision: ${output[0]} vs ${expected}`);
    check(output[0]!==Math.round(output[0]),'Post code was rounded to an integer');
    return {linear,expected,stored:output[0]};
  }finally{post.dispose();buffer.destroy();}
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
  const history=await TemporalGPU.create(device,width,height,'pre',2);
  try{
    const upload=async(frame:number,rough:number,metal:number)=>{
      const roughness=new Float32Array(pixels*4);for(let i=0;i<pixels;i++)roughness.set([rough,metal,0,1],i*4);
      history.upload(frame,meta,{centerPosition,centerDepth,centerNormal,roughness,motion,id,hdr,albedo,normal});
    };
    await upload(0,.5,0);await upload(1,.5,0);const diffuse=await history.mapping(1,0,true).then(()=>history.read(history.counts,80)).then(x=>new Uint32Array(x));
    await upload(0,.1,.5);await upload(1,.1,.5);const smoothMetal=await history.mapping(1,0,true).then(()=>history.read(history.counts,80)).then(x=>new Uint32Array(x));
    check(diffuse[9]===pixels&&diffuse[6]===0,`Material 212 was scene-specifically rejected: ${diffuse[6]}`);
    check(smoothMetal[6]===pixels,`Smooth-metal roughness rule was lost: ${smoothMetal[6]}`);
    return {materialId:212,diffuseAccepted:diffuse[9],smoothMetalRejected:smoothMetal[6]};
  }finally{history.dispose();}
}

async function exerciseForwardMotionSeed(device: GPUDevice) {
  const width = 16;
  const height = 8;
  const pixels = width * height;
  const identity = new Float32Array(16);
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  const metadata = {viewProjection: identity, projection: identity, apertureRadius: 0, focusDistance: 1};
  const window = await DirectWindowGPU.create(device, width, height, 3, false, true, 'veto');

  async function upload(frame: number, start: number, brightness: number, visible: boolean) {
    const depth = new Float32Array(pixels * 4);
    const position = new Float32Array(pixels * 4);
    const normal = new Float32Array(pixels * 4);
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
      albedo.set([.5, .5, .5, 1], at);
      roughness.set([.5, 0, 0, 1], at);
      if (inside && visible) motion.set([-3, 0, 1, 3], at);
      hdr.set([brightness, brightness, brightness, 1], at);
      id.set([inside ? 1 : 9, 0, 1, 0], at);
    }
    await window.upload(frame, metadata, {
      centerPosition: position, centerDepth: depth, centerNormal: normal,
      albedo, roughness, motion, hdr, id,
    });
  }

  try {
    await upload(0, 4, 1, true);
    await upload(1, 7, 3, true);
    const pixel = (3 * width + 4) * 4;
    const accepted = new Float32Array(await window.read(await window.filter(0, [1], true)));
    const expected = (1 + 3 * 8 / 9) / (1 + 8 / 9);
    check(Math.abs(accepted[pixel] - expected) < 1e-6,
      'A visible forward solution was lost because the earlier coordinate fell off the later surface');

    await upload(1, 7, 3, false);
    await upload(2, 10, 9, true);
    const occluded = new Float32Array(await window.read(await window.filter(0, [2], true)));
    check(occluded[pixel] === 1, 'The predictor used history beyond invalid intermediate motion');
    return {visible: accepted[pixel], occluded: occluded[pixel]};
  } finally {
    window.dispose();
  }
}

async function blobPixels(blob:Blob){const image=await createImageBitmap(blob);const canvas=new OffscreenCanvas(image.width,image.height);const context=canvas.getContext('2d')!;context.drawImage(image,0,0);return context.getImageData(0,0,image.width,image.height).data;}

Object.assign(window, {runTemporalDenoiseTests: run});
