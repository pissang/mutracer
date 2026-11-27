import type Engine from '../Engine.js';
import type {OIDNFilter, OIDNFilterInput} from '../oidn.js';
import {OIDN_OPTION_KEYS, oidnDenoiserKey, snapshotOIDNOptions, validateOIDNOptions, type OIDNFilterOptions} from '../oidnOptions.js';
import type {OIDNWeb, OIDNWebGPUData, OIDNWebGPUOutputData} from './denoiser.js';
import type {OwnedDenoiser} from './ownedDenoiser.js';
import {loadOIDNNetwork} from './oidnNetwork.js';

type Network = Extract<OwnedDenoiser, {kind: 'oidn'}>;
/** Longer than any expected OIDN wait behind a normal queued job at interactive sizes. */
export const NESTED_CALL_WARNING_MS = 5000;

function infer(network: OIDNWeb, input: {color: OIDNWebGPUData; albedo?: OIDNWebGPUData; normal?: OIDNWebGPUData}, signal: AbortSignal) {
  return new Promise<OIDNWebGPUOutputData>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = network.tileExecute({...input, scheduling: 'event-loop',
      done(output) { signal.removeEventListener('abort', abort); resolve(output); },
      error(error) { signal.removeEventListener('abort', abort); reject(error); }
    });
    function abort() {
      cancel();
      reject(signal.reason);
    }
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once: true});
  });
}

function validateInput(input: OIDNFilterInput, needsGuides: boolean, device: GPUDevice) {
  const {width, height} = input;
  const bytes = width * height * 16;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !Number.isSafeInteger(bytes) || bytes > device.limits.maxStorageBufferBindingSize) {
    throw new Error('OIDN dimensions must be positive integers within the device storage buffer limit.');
  }
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  for (const key of ['color', 'output', 'albedo', 'normal'] as const) {
    const buffer = input[key];
    if (!needsGuides && buffer === undefined && (key === 'albedo' || key === 'normal')) continue;
    if (!buffer || buffer.size < bytes || (buffer.usage & usage) !== usage || buffer.mapState !== 'unmapped') {
      throw new Error(`OIDN ${key} requires an unmapped rgba32float GPU buffer with STORAGE, COPY_SRC and COPY_DST usage.`);
    }
  }
}

async function prefilter(
  engine: Engine, device: GPUDevice, auxiliary: NonNullable<OIDNWeb['auxiliaryDenoisers']>,
  size: {width: number; height: number}, albedo: GPUBuffer, normal: GPUBuffer, signal: AbortSignal
) {
  const {albedoEncode, albedoDecode, normalSanitize} = engine._oidnBufferGuides();
  for (const pass of [albedoEncode, albedoDecode, normalSanitize]) {
    pass.setSize(size.width, size.height);
    pass.setUniform('imageSize', [size.width, size.height]);
  }
  const rawAlbedo = {buffer: albedo, channels: 4};
  const rawNormal = {buffer: normal, channels: 4};
  const encode = device.createCommandEncoder();
  albedoEncode.createPass(encode, {albedo: rawAlbedo});
  device.queue.submit([encode.finish()]);

  const filteredAlbedo = await infer(auxiliary.albedo, {color: {data: albedoEncode.getOutput('albedo'), ...size}}, signal);
  signal.throwIfAborted();
  const decode = device.createCommandEncoder();
  albedoDecode.createPass(decode, {albedo: {buffer: filteredAlbedo.data, channels: 4}, rawAlbedo, rawNormal});
  device.queue.submit([decode.finish()]);

  const filteredNormal = await infer(auxiliary.normal, {color: {data: normal, ...size}}, signal);
  signal.throwIfAborted();
  const sanitize = device.createCommandEncoder();
  normalSanitize.createPass(sanitize, {normal: {buffer: filteredNormal.data, channels: 4}});
  device.queue.submit([sanitize.finish()]);
  return {albedo: albedoDecode.getOutput('albedo'), normal: normalSanitize.getOutput('normal')};
}

export async function createBufferFilter(engine: Engine, options: OIDNFilterOptions): Promise<OIDNFilter> {
  if (!options || typeof options !== 'object') throw new Error('OIDN options must be an object.');
  for (const key of Object.keys(options)) if (!OIDN_OPTION_KEYS.includes(key)) throw new Error(`Unknown OIDN filter option ${key}.`);
  validateOIDNOptions(options);
  const {signal: downloadSignal, ...settings} = snapshotOIDNOptions(options);
  const key = oidnDenoiserKey(settings);
  const lifetime = new AbortController();
  let filter: Network | undefined;
  let generation = -1;
  let pending = 0;

  async function acquire(signal: AbortSignal, weightSignal?: AbortSignal) {
    signal.throwIfAborted();
    if (engine.backend !== 'webgpu' || !engine.device) throw new Error('OIDN requires a WebGPU engine.');
    if (!filter || generation !== engine._deviceGeneration) {
      // Device invalidation already force-released the previous network. Forget it
      // before loading, so a failed load cannot leave a disposed network marked current.
      filter = undefined;
      const current = engine._deviceGeneration;
      filter = await engine._acquireDenoiser(key, async () => ({
        kind: 'oidn', denoiser: await loadOIDNNetwork(engine, {...settings, signal: weightSignal}), sceneLinear: settings.hdr !== false
      }));
      generation = current;
    }
    signal.throwIfAborted();
    return filter.denoiser;
  }

  function release() {
    if (filter) engine._releaseDenoiser(filter);
    filter = undefined;
  }

  downloadSignal?.throwIfAborted();
  await engine.init();
  const initialSignal = engine._denoiseDeviceSignal;
  try {
    await acquire(downloadSignal ? AbortSignal.any([downloadSignal, initialSignal]) : initialSignal, downloadSignal);
  } catch (error) {
    release();
    throw error;
  }

  return {
    async denoise(input, {signal} = {}) {
      const cancellation = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
      cancellation.throwIfAborted();
      // Initialize before reserving the lease so recovery captures the new device.
      await engine.init();
      cancellation.throwIfAborted();
      const jobSignal = AbortSignal.any([cancellation, engine._denoiseDeviceSignal]);
      const device = engine.device!;
      const data = {...input};
      pending++;
      // A call from inside a custom denoiser that does not pass that callback's own
      // signal waits for the callback, which waits for this call. It cannot be told
      // apart from an ordinary queued call, so only warn when it stays blocked.
      const blocked = engine._customDenoiseActive && !engine._hasCustomDenoiseLease(signal)
        ? setTimeout(() => console.warn('OIDN filter is waiting for an active custom denoiser. ' +
          'Inside Denoiser.denoise, pass its context.signal itself (not a derived signal) to filter.denoise, or the engine deadlocks.'),
        NESTED_CALL_WARNING_MS)
        : undefined;
      try {
        await engine._enqueueDenoise(async () => {
          clearTimeout(blocked);
          jobSignal.throwIfAborted();
          const network = await acquire(jobSignal);
          const needsGuides = settings.aux !== false || network.auxiliaryDenoisers !== undefined;
          validateInput(data, needsGuides, device);
          const {width, height, color, output} = data;
          const size = {width, height};
          const guides = network.auxiliaryDenoisers
            ? await prefilter(engine, device, network.auxiliaryDenoisers, size, data.albedo!, data.normal!, jobSignal)
            : data;
          const filtered = await infer(network, {color: {data: color, ...size},
            albedo: guides.albedo && {data: guides.albedo, ...size},
            normal: guides.normal && {data: guides.normal, ...size}}, jobSignal);
          jobSignal.throwIfAborted();
          const encoder = device.createCommandEncoder({label: 'OIDN buffer result'});
          encoder.copyBufferToBuffer(filtered.data, 0, output, 0, width * height * 16);
          device.queue.submit([encoder.finish()]);
        }, jobSignal, signal);
        jobSignal.throwIfAborted();
      } finally {
        clearTimeout(blocked);
        pending--;
        if (lifetime.signal.aborted && pending === 0) release();
      }
    },
    dispose() {
      lifetime.abort(new Error('OIDN filter is disposed.'));
      if (pending === 0) release();
    }
  };
}
