import type {TemporalHistoryGPU} from './WGPUTemporalHistory.js';
import {mixedWindowWGSL} from './temporalWindowShader.js';
export {directGeometryWGSL, directWindowWGSL} from './temporalWindowShader.js';
export class DirectWindowGPU {
  readonly rejects: GPUBuffer;
  readonly total: GPUBuffer;
  readonly output: GPUBuffer;
  private readonly params: GPUBuffer;
  private pipeline!: GPUComputePipeline;

  private constructor(private readonly history: TemporalHistoryGPU, private readonly adaptiveRadius: boolean) {
    const d = history.device;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.total = d.createBuffer({label: 'Direct window weighted sum', size: history.bytes, usage});
    this.output = d.createBuffer({label: 'Direct window normalized output', size: history.bytes, usage});
    this.rejects = d.createBuffer({label: 'Direct window validation counts', size: 64, usage});
    this.params = d.createBuffer({label: 'Direct window parameters', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  }

  static async create(history: TemporalHistoryGPU, adaptiveRadius = false) {
    const window = new DirectWindowGPU(history, adaptiveRadius);
    const device = history.device;
    try {
      const module = device.createShaderModule({label: 'Direct temporal window', code: mixedWindowWGSL});
      window.pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
      return window;
    } catch (error) { window.dispose(); throw error; }
  }

  get capacity() { return this.history.capacity; }

  async dispatch(current: number, source: number, symmetric: boolean, stage: number,
    radiusMin: number, radiusMax: number, includeMaterialRevisions = true) {
    const h = this.history, d = h.device;
    const mode = Number(this.adaptiveRadius) | 2 | (Number(includeMaterialRevisions) << 2);
    d.queue.writeBuffer(this.params, 0, new Uint32Array([h.width, h.height, h.slot(current), h.slot(source),
      source - current, Number(symmetric), stage, mode, radiusMin, radiusMax]));
    const resources = [this.params, h.surface, h.id, h.raw, h.meta, this.total, this.output, h.overflow, this.rejects, h.motion];
    const group = d.createBindGroup({layout: this.pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({
      binding, resource: resource instanceof GPUBuffer ? {buffer: resource} : resource.createView({dimension: '2d-array'}),
    }))});
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(h.width / 8), Math.ceil(h.height / 8));
    pass.end();
    d.queue.submit([encoder.finish()]);
  }

  async filter(current: number, neighbors: number[], symmetric: boolean,
    radiusMin = symmetric ? 8 : 17, radiusMax = this.adaptiveRadius ? 16 : radiusMin) {
    const frames = this.history.frames;
    if (frames.get(this.history.slot(current)) !== current) throw Error('Current frame is missing.');
    for (const source of neighbors) {
      if (frames.get(this.history.slot(source)) !== source) throw Error('Neighbor frame is missing: ' + source);
    }
    this.history.device.queue.writeBuffer(this.rejects, 0, new Uint32Array(16));
    await this.dispatch(current, current, symmetric, 0, radiusMin, radiusMax);
    for (const source of neighbors) await this.dispatch(current, source, symmetric, 1, radiusMin, radiusMax);
    await this.dispatch(current, current, symmetric, 2, radiusMin, radiusMax);
    return this.output;
  }

  async read(buffer = this.output, size = buffer.size) {
    const d = this.history.device;
    const staging = d.createBuffer({size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      const encoder = d.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
      d.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      return staging.getMappedRange().slice(0);
    } finally { staging.destroy(); }
  }

  memory() {
    return {total: this.total.size + this.output.size + this.rejects.size + this.params.size};
  }

  dispose() {
    this.total.destroy();
    this.output.destroy();
    this.rejects.destroy();
    this.params.destroy();
  }
}
