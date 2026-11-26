import type {TemporalHistoryGPU} from './WGPUTemporalHistory.js';
import {createMixedWindowWGSL} from './temporalWindowShader.js';
import type {OfflineSampleTiles} from './OfflineAdaptiveSampling.js';
export {directGeometryWGSL, directWindowWGSL} from './temporalWindowShader.js';
export class DirectWindowGPU {
  readonly rejects: GPUBuffer;
  readonly total: GPUBuffer;
  readonly output: GPUBuffer;
  readonly guides?: {albedo: GPUBuffer; normal: GPUBuffer};
  private readonly params: GPUBuffer;
  private pipeline!: GPUComputePipeline;
  private cameraCutPipeline?: GPUComputePipeline;
  private readonly reflectionSum?: GPUBuffer;
  private readonly experimentBuffer?: GPUBuffer;
  private readonly tilesPerFrame: number;

  private constructor(private readonly history: TemporalHistoryGPU, private readonly adaptiveRadius: boolean,
    accumulateGuides: boolean, private readonly sampleTileSize?: number, private readonly opticalMotion = true) {
    const d = history.device;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.total = d.createBuffer({label: 'Direct window weighted sum', size: history.bytes, usage});
    this.output = d.createBuffer({label: 'Direct window normalized output', size: history.bytes, usage});
    if (accumulateGuides) {
      this.guides = {
        albedo: d.createBuffer({label: 'Direct window albedo', size: history.bytes, usage}),
        normal: d.createBuffer({label: 'Direct window normal', size: history.bytes, usage}),
      };
    }
    if (history.reflections) this.reflectionSum = d.createBuffer({label: 'Reflected radiance weighted sum', size: history.bytes, usage});
    this.tilesPerFrame = sampleTileSize
      ? Math.ceil(history.width / sampleTileSize) * Math.ceil(history.height / sampleTileSize) : 0;
    if (sampleTileSize) this.experimentBuffer = d.createBuffer({label: 'Offline temporal sampling',
      size: history.capacity * this.tilesPerFrame * 4, usage});
    this.rejects = d.createBuffer({label: 'Direct window validation counts', size: 64, usage});
    this.params = d.createBuffer({label: 'Direct window parameters', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  }

  static async create(history: TemporalHistoryGPU, adaptiveRadius = false, accumulateGuides = false, sampleTileSize?: number, opticalMotion = true) {
    const window = new DirectWindowGPU(history, adaptiveRadius, accumulateGuides, sampleTileSize, opticalMotion);
    const device = history.device;
    try {
      const createPipeline = (code: string) => {
        const module = device.createShaderModule({label: 'Direct temporal window', code});
        return device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
      };
      window.pipeline = await createPipeline(createMixedWindowWGSL(accumulateGuides, !!history.reflections, sampleTileSize));
      if (history.reflections || sampleTileSize) window.cameraCutPipeline = await createPipeline(createMixedWindowWGSL(accumulateGuides));
      return window;
    } catch (error) { window.dispose(); throw error; }
  }

  get capacity() { return this.history.capacity; }
  get experimentBytes() { return this.experimentBuffer?.size ?? 0; }

  setSampleTiles(frame: number, plan: OfflineSampleTiles) {
    const h = this.history;
    if (!this.experimentBuffer || plan.tileSize !== this.sampleTileSize || plan.width !== h.width || plan.height !== h.height ||
      plan.targets.length !== this.tilesPerFrame) throw new Error('Temporal sample tiles do not match the window.');
    h.device.queue.writeBuffer(this.experimentBuffer, h.slot(frame) * this.tilesPerFrame * 4, plan.targets);
  }

  async dispatch(current: number, source: number, symmetric: boolean, stage: number,
    radiusMin: number, radiusMax: number, includeMaterialRevisions = true) {
    const h = this.history, d = h.device;
    // Camera-cut validation uses stage 1 without a preceding window initialization.
    const mode = Number(this.adaptiveRadius) | 2 | (Number(includeMaterialRevisions) << 2) |
      (Number(!!this.guides && includeMaterialRevisions) << 3) | (Number(!this.opticalMotion) << 4);
    d.queue.writeBuffer(this.params, 0, new Uint32Array([h.width, h.height, h.slot(current), h.slot(source),
      source - current, Number(symmetric), stage, mode, radiusMin, radiusMax]));
    const resources = [this.params, h.surface, h.id, h.raw, h.meta, this.total, this.output, h.overflow, this.rejects, h.motion, h.material];
    if (this.guides) resources.push(h.guides, this.guides.albedo, this.guides.normal);
    if (h.reflections && includeMaterialRevisions) {
      resources.push(h.reflections.radiance, h.reflections.endpoint, this.reflectionSum!);
    }
    if (this.experimentBuffer && includeMaterialRevisions) resources.push(this.experimentBuffer);
    const pipeline = includeMaterialRevisions ? this.pipeline : this.cameraCutPipeline ?? this.pipeline;
    const group = d.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({
      binding, resource: resource instanceof GPUBuffer ? {buffer: resource} : resource.createView({dimension: '2d-array'}),
    }))});
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
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
    return {total: this.total.size + this.output.size + this.rejects.size + this.params.size + this.experimentBytes + (this.reflectionSum?.size ?? 0) + (this.guides ? this.guides.albedo.size + this.guides.normal.size : 0)};
  }

  dispose() {
    this.experimentBuffer?.destroy();
    this.reflectionSum?.destroy();
    this.guides?.albedo.destroy();
    this.guides?.normal.destroy();
    this.total.destroy();
    this.output.destroy();
    this.rejects.destroy();
    this.params.destroy();
  }
}
