import {Camera, Engine, Render, getRecommendedDeviceDescriptor} from '../../src/main';
import {createOIDNFilter, type OIDNFilterInput, type OIDNFilterOptions} from '../../src/oidn';
import type {DisplayParityTarget} from '../../src/renderer/displayParityDiagnostics';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function rejects(promise: Promise<unknown>, expected: RegExp) {
  try { await promise; }
  catch (error) { if (expected.test(String(error))) return; throw error; }
  throw new Error('Expected rejection: ' + expected);
}

const width = 256, height = 128, bytes = width * height * 16;
const bufferUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
async function read(device: GPUDevice, output: GPUBuffer) {
  const buffer = device.createBuffer({size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(output, 0, buffer, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    return new Float32Array(buffer.getMappedRange().slice(0));
  } finally { buffer.destroy(); }
}

async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  check(adapter, 'WebGPU adapter unavailable');
  const device = await adapter.requestDevice(getRecommendedDeviceDescriptor(adapter));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const engine = new Engine({canvas, device});
  const errors: string[] = [];
  engine.on('error', error => errors.push(String(error)));
  device.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
  let replacement: GPUDevice | undefined;
  const results = [];
  try {
    engine.scene = {meshes: [], lights: [], background: [0.2, 0.4, 0.7, 1]};
    engine.camera = new Camera({projection: 'perspective'});
    await engine.init();
    engine.update();
    const render = new Render(engine, {width, height});
    await render.converge({samples: 1});
    const target = render._output as unknown as DisplayParityTarget & NonNullable<Render['_output']>;
    const diagnostics = target._displayParity();
    const color = new Float32Array(width * height * 4);
    const albedo = color.slice(), normal = color.slice();
    // Asymmetric, high-contrast nonconstant color and guide fixtures reveal
    // row flips, color transfer errors and fixed-tile seams.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      color.set([0.02 + x / width * 3, 0.07 + y / height * 1.5, (x ^ y) / 255, 1], i);
      albedo.set([x / width, y / height, 0.4, 1], i);
      normal.set([0.2 * Math.sin(x / 16), 0.4 * Math.sin(y / 11), 0.8, 1], i);
    }
    const cases: OIDNFilterOptions[] = [
      {model: 'standard', weightsBaseUrl: '/oidn/weights/'},
      {model: 'cleanAuxLarge', weightsBaseUrl: '/oidn/weights/', dynamicTile: false, maxTileSize: 128}
    ];
    const output = device.createBuffer({size: bytes, usage: bufferUsage});
    for (const options of cases) {
      await render.setDenoiser({type: 'oidn', ...options});
      // Use the normal Render lease and built-in pipeline on the fixture's
      // accumulation, then compare the public API on its exact OIDN inputs.
      render.restart();
      await render.converge({samples: 1});
      engine.display._configure(render);
      target.activate();
      if (options.dynamicTile === false) {
        const upload = (values: Float32Array) => {
          const buffer = device.createBuffer({size: bytes, usage: bufferUsage});
          device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
          return buffer;
        };
        const gpu = {color: upload(color), albedo: upload(albedo), normal: upload(normal)};
        diagnostics.loadGPU!({width, height, samples: 1, ...gpu});
        for (const buffer of Object.values(gpu)) buffer.destroy();
      } else {
        diagnostics.load({width, height, samples: 1, catcher: false, color, albedo, normal,
          shadow: new Float32Array(width * height * 8), moments: new Float32Array(width * height * 4)});
      }
      target.drawPostProcess();
      const {oidnDenoiserKey} = await import('../../src/oidnOptions');
      const filterHandle = await engine._acquireDenoiser(oidnDenoiserKey(options), async () => {throw new Error('Render network was not cached');});
      try {
        await engine._enqueueDenoise(() => target.performDenoise!(filterHandle, undefined, 'converged'));
        const builtIn = (await render.readPixels('denoised')).data;
        const buffers = diagnostics.oidnInputs!();
        const filter = await createOIDNFilter(engine, options);
        try {
          await filter.denoise({width, height, ...buffers, output});
          const actual = await read(device, output);
          let max = 0;
          for (let i = 0; i < actual.length; i++) {
            if (i % 4 === 3) continue;
            check(Number.isFinite(actual[i]) && Number.isFinite(builtIn[i]), 'Nonfinite OIDN output');
            max = Math.max(max, Math.abs(actual[i] - builtIn[i]));
          }
          check(max <= 1e-6, `OIDN parity failed: ${max}`);
          results.push({options, max, runtime: filterHandle.denoiser.getRuntimeInfo?.()});
        } finally { filter.dispose(); }
      } finally { engine._releaseDenoiser(filterHandle); }
    }

    const filter = await createOIDNFilter(engine, cases[0]);
    let enter!: () => void, proceed!: () => void;
    const entered = new Promise<void>(resolve => {enter = resolve;});
    const hold = new Promise<void>(resolve => {proceed = resolve;});
    const custom = new Render(engine, {width, height, denoiser: {type: 'custom', denoiser: {
      async denoise(input, {signal}) {
        enter();
        await hold;
        await filter.denoise(input, {signal});
      }
    }}});
    const rendering = custom.converge({samples: 1});
    await entered;
    const makeInput = (gpu: GPUDevice) => {
      const make = () => gpu.createBuffer({size: bytes, usage: bufferUsage});
      return {width, height, color: make(), albedo: make(), normal: make(), output: make()} satisfies OIDNFilterInput;
    };
    const external = makeInput(device);
    const cancelled = new AbortController();
    const waitingAbort = rejects(filter.denoise(external, {signal: cancelled.signal}), /AbortError/);
    cancelled.abort();
    let finished = false;
    const waiting = filter.denoise(external).then(() => {finished = true;});
    await new Promise(resolve => setTimeout(resolve, 50));
    check(!finished, 'External call ran while the custom Render held the lease');
    proceed();
    await rendering;
    check(custom._output?.presentationDenoised, 'Nested OIDN did not publish');
    await Promise.all([waiting, waitingAbort]);
    custom.dispose();

    const lost = new Promise<void>(resolve => {
      const off = engine.on('devicelost', () => {off(); resolve();});
    });
    const inFlight = filter.denoise(external);
    const lostJob = rejects(inFlight, /lost|destroy|unavailable/i);
    device.destroy();
    await Promise.all([lost, lostJob]);
    const nextAdapter = await navigator.gpu.requestAdapter();    check(nextAdapter, 'Replacement WebGPU adapter unavailable');    replacement = await nextAdapter.requestDevice(getRecommendedDeviceDescriptor(nextAdapter));
    await engine.setDevice(replacement);
    const recovered = makeInput(replacement);
    await filter.denoise(recovered);
    filter.dispose();
    await rejects(filter.denoise(recovered), /disposed/);
    for (const data of [external, recovered]) {
      data.color.destroy(); data.albedo.destroy(); data.normal.destroy(); data.output.destroy();
    }
    output.destroy();
    check(errors.every(error => /device lost/i.test(error)), errors.join('\n'));
    results.push({customNested: true, standaloneWaited: true, queuedAbort: true, deviceLoss: true});
  } finally {
    engine.dispose();
    device.destroy();
    replacement?.destroy();
  }
  const webgl = new Engine({canvas: document.createElement('canvas'), backend: 'webgl'});
  try {
    await rejects(createOIDNFilter(webgl), /requires a WebGPU engine/);
    check(webgl.backend === 'webgl', 'WebGL engine did not initialize');
    results.push({webgl: 'rejected'});
  } finally { webgl.dispose(); }
  return results;
}

Object.assign(window, {runOIDNBufferTests: run});
