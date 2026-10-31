import {vi} from 'vitest';

const usage = (names: string[]) => Object.fromEntries(names.map((name, index) => [name, 1 << index]));

/** Runs the real renderer on Node. Compilation and queue fences finish only through `settle`, in any order. */
export function installFakeGPU() {
  vi.stubGlobal('GPUBufferUsage', usage(['MAP_READ', 'MAP_WRITE', 'COPY_SRC', 'COPY_DST', 'INDEX', 'VERTEX', 'UNIFORM', 'STORAGE', 'INDIRECT', 'QUERY_RESOLVE']));
  vi.stubGlobal('GPUTextureUsage', usage(['COPY_SRC', 'COPY_DST', 'TEXTURE_BINDING', 'STORAGE_BINDING', 'RENDER_ATTACHMENT']));
  vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});
  vi.stubGlobal('GPUMapMode', {READ: 1, WRITE: 2});
  vi.stubGlobal('GPUColorWrite', {RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15});

  const pending: (() => void)[] = [];
  const state = {compiles: 0, traceRunning: 0, maxTraceRunning: 0, failNextCompile: false, submits: 0, losses: 0};
  const encoderPass = () => new Proxy({}, {get: (_target, key) => key === 'end' ? () => {} : () => {}});
  const bindGroupLayout = () => ({});
  const pipeline = () => ({label: 'fake', getBindGroupLayout: bindGroupLayout});
  const texture = (descriptor: GPUTextureDescriptor) => {
    const size = descriptor.size as number[] | {width: number; height?: number; depthOrArrayLayers?: number};
    const [width, height = 1, depthOrArrayLayers = 1] = Array.isArray(size) ? size : [size.width, size.height, size.depthOrArrayLayers];
    return {...descriptor, width, height, depthOrArrayLayers, format: descriptor.format, usage: descriptor.usage,
      mipLevelCount: descriptor.mipLevelCount ?? 1, createView: () => ({}), destroy() {}};
  };
  const buffer = (descriptor: GPUBufferDescriptor) => {
    const bytes = new ArrayBuffer(Math.min(descriptor.size, 1 << 24));
    return {size: descriptor.size, usage: descriptor.usage, label: descriptor.label, mapState: 'unmapped',
      getMappedRange: () => bytes, unmap() { this.mapState = 'unmapped'; }, destroy() {},
      mapAsync() { return new Promise<void>(resolve => pending.push(() => { this.mapState = 'mapped'; resolve(); })); }};
  };

  function createDevice(limits: Record<string, number>, features: Iterable<string>) {
    let lose!: (info: {reason: string; message: string}) => void;
    const lost = new Promise(resolve => { lose = resolve; });
    const device = {
      limits, features: new Set(features), lost, label: 'fake',
      addEventListener() {}, removeEventListener() {}, destroy() {},
      pushErrorScope() {}, popErrorScope: async () => null,
      createBuffer: buffer, createTexture: texture, createSampler: () => ({}),
      createBindGroup: () => ({}), createBindGroupLayout: bindGroupLayout, createPipelineLayout: () => ({}),
      createQuerySet: (descriptor: GPUQuerySetDescriptor) => ({...descriptor, destroy() {}}),
      createShaderModule: () => ({getCompilationInfo: async () => ({messages: []})}),
      createComputePipeline: pipeline, createRenderPipeline: pipeline,
      createRenderPipelineAsync: async () => pipeline(),
      createComputePipelineAsync: (descriptor: GPUComputePipelineDescriptor) => {
        const failed = state.failNextCompile; state.failNextCompile = false;
        const trace = descriptor.label === 'Ray Trace';
        state.compiles++;
        if (trace) { state.traceRunning++; state.maxTraceRunning = Math.max(state.maxTraceRunning, state.traceRunning); }
        return new Promise((resolve, reject) => pending.push(() => {
          if (trace) state.traceRunning--;
          failed ? reject(new Error('Fake compilation failure')) : resolve(pipeline());
        }));
      },
      createCommandEncoder: () => ({
        beginComputePass: encoderPass, beginRenderPass: encoderPass,
        finish: () => ({}), copyBufferToBuffer() {}, copyTextureToBuffer() {}, copyBufferToTexture() {},
        copyTextureToTexture() {}, clearBuffer() {}, resolveQuerySet() {}, writeTimestamp() {}
      }),
      queue: {
        submit() { state.submits++; }, writeBuffer() {}, writeTexture() {}, copyExternalImageToTexture() {},
        onSubmittedWorkDone: () => new Promise<void>(resolve => pending.push(resolve))
      }
    };
    return {device: device as unknown as GPUDevice, lose};
  }

  const limits = {
    maxStorageBuffersPerShaderStage: 16, maxStorageBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 31,
    maxSampledTexturesPerShaderStage: 32, maxStorageTexturesPerShaderStage: 8, maxComputeWorkgroupStorageSize: 32768,
    maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 256,
    maxComputeInvocationsPerWorkgroup: 1024, maxBindGroups: 4, maxTextureDimension2D: 8192, maxTextureDimension3D: 2048,
    maxTextureArrayLayers: 256, maxComputeWorkgroupsPerDimension: 65535, maxUniformBufferBindingSize: 65536,
    maxSamplersPerShaderStage: 16, maxUniformBuffersPerShaderStage: 12, maxBindingsPerBindGroup: 1000,
    maxColorAttachments: 8, minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 256
  };
  const devices: {device: GPUDevice; lose: (info: {reason: string; message: string}) => void}[] = [];
  const adapter = {limits, features: new Set<string>(), info: {vendor: 'fake', description: 'fake'},
    requestDevice: async () => { const created = createDevice(limits, []); devices.push(created); return created.device; }};
  vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm'}});

  const canvas = {
    width: 256, height: 192, addEventListener() {}, removeEventListener() {},
    getContext: () => ({configure() {}, unconfigure() {}, getCurrentTexture: () => texture({size: [canvas.width, canvas.height], format: 'bgra8unorm', usage: 16})})
  } as unknown as HTMLCanvasElement;

  return {
    canvas, state, devices,
    /** Completes one outstanding GPU event, or all of them. */
    settle(all = true, pick = 0) {
      const events = all ? pending.splice(0) : pending.length ? pending.splice(pick % pending.length, 1) : [];
      for (const event of events) event();
      return events.length;
    },
    get outstanding() { return pending.length; },
    loseDevice() { state.losses++; devices.at(-1)?.lose({reason: 'unknown', message: 'Fake device loss'}); }
  };
}
