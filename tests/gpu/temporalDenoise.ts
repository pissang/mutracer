import {Camera, Engine, Render, getRecommendedDeviceDescriptor} from '../../src/main';
import {TemporalDenoiser} from '../../src/temporal';

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
  engine.scene = {meshes: [], lights: [], background: [0.2, 0.4, 0.7, 1]};
  engine.camera = new Camera({projection: 'perspective'}); engine.update();
  const render = new Render(engine, {width: 64, height: 64, maxSamples: 1});
  const temporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false, denoiser: null});
  temporal.attach(render);
  try {
    await render.converge({samples: 1}); const source = (await render.readPixels('hdr')).data; await temporal.push(render);
    const frames = []; let accumulated: Float32Array | undefined;
    for await (const frame of temporal.flush()) { check(engine.display.present(frame) === frame, 'Temporal frame was not presented'); frames.push(await frame.readPixels()); accumulated = (await frame.readPixels('accumulated')).data; }
    check(frames.length === 1, 'Flush did not yield one frame');
    check(frames[0].width === 64 && frames[0].data.every(Number.isFinite), 'Invalid temporal output');
    let max = 0; for (let i = 0; i < source.length; i++) max = Math.max(max, Math.abs(source[i] - accumulated![i]));
    check(max <= 1e-3, `Radius-zero accumulated identity failed: ${max}`);
    temporal.dispose();
    const sequence = new TemporalDenoiser(engine, {historyRadius: 2, postRadius: 1, stabilizeSparkle: true, denoiser: null});
    sequence.attach(render); let outputs = 0;
    for (let i = 0; i < 8; i++) {
      await render.converge({samples: 1, sampleSequenceOffset: i}); await sequence.push(render);
      for await (const frame of sequence.drain()) { check(frame.index === outputs, 'Drain order changed'); outputs++; }
    }
    for await (const frame of sequence.flush()) { check(frame.index === outputs, 'Flush order changed'); outputs++; }
    check(outputs === 8, 'Sequence did not flush every frame'); sequence.dispose();
    const oidnRender = new Render(engine, {width: 64, height: 64, maxSamples: 1,
      denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
    const oidnTemporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false,
      denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
    oidnTemporal.attach(oidnRender); await oidnRender.converge({samples: 1});
    const builtIn = (await oidnRender.readPixels('denoised')).data; await oidnTemporal.push(oidnRender);
    let temporalOIDN: Float32Array | undefined; for await (const frame of oidnTemporal.flush()) temporalOIDN = (await frame.readPixels()).data;
    let oidnMax = 0; for (let i = 0; i < builtIn.length; i++) if (i % 4 !== 3) oidnMax = Math.max(oidnMax, Math.abs(builtIn[i] - temporalOIDN![i]));
    check(oidnMax <= 1e-6, `OIDN identity failed: ${oidnMax}`); oidnTemporal.dispose(); oidnRender.dispose();
    let receivedRoughness = false;
    const custom = {async denoise(input: Parameters<import('../../src/Render').Denoiser['denoise']>[0]) {
      receivedRoughness = !!input.aovs?.roughness;
      const encoder = input.device.createCommandEncoder(); encoder.copyBufferToBuffer(input.color, 0, input.output, 0, input.color.size);
      input.device.queue.submit([encoder.finish()]);
    }};
    const customTemporal = new TemporalDenoiser(engine, {historyRadius: 0, postRadius: 0, stabilizeSparkle: false,
      denoiser: {type: 'custom', denoiser: custom, aovs: ['roughness']}});
    customTemporal.attach(render); await render.converge({samples: 1, sampleSequenceOffset: 99}); await customTemporal.push(render);
    for await (const _frame of customTemporal.flush()) { /* release */ }
    check(receivedRoughness, 'Custom temporal denoiser did not receive its declared AOV'); customTemporal.dispose();
    await device.queue.onSubmittedWorkDone();
    check(uncaptured.length === 0, `Uncaptured WebGPU errors: ${uncaptured.join(' | ')}`);
    return {identity: true, max, sequence: true, oidnMax, customAov: receivedRoughness, uncapturedErrors: uncaptured.length, plan: temporal.plan};
  } finally { temporal.dispose(); render.dispose(); engine.dispose(); device.destroy(); }
}

Object.assign(window, {runTemporalDenoiseTests: run});
