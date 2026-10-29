import {causticDiagnostics} from './causticDiagnostics.js';
import {WGPUCausticLightPass} from './WGPUCausticLightPass.js';
import {PHOTON_BYTES, PHOTON_GRID_SIZE, photonLayout, photonGridCompute} from './wgsl/photonMap.compute.js';
interface Batch {
  grid: GPUBuffer;
  uniform: GPUBuffer;
  data: GPUTexture;
  headers: GPUTexture;
  count: number;
  buckets: number;
  group: GPUBindGroup;
}
/** Batch-local spatial hash; accumulated estimates live in the camera path target. */
export class WGPUPhotonMap {
  readonly placeholder: GPUTexture;
  readonly emission: WGPUCausticLightPass;
  private readonly targets = new Map<object, Batch>();
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines: GPUComputePipeline[];
  constructor(private readonly device: GPUDevice) {
    this.placeholder = device.createTexture({
      label: 'Inactive photon binding',
      size: [1, 1],
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING
    });
    this.emission = new WGPUCausticLightPass(device, true);
    this.layout = device.createBindGroupLayout({
      entries: [
        {binding: 0, visibility: 4, texture: {sampleType: 'uint'}},
        {binding: 1, visibility: 4, buffer: {type: 'storage'}},
        {binding: 2, visibility: 4, buffer: {type: 'uniform'}},
        {binding: 4, visibility: 4, storageTexture: {access: 'write-only', format: 'r32uint'}}
      ]
    });
    const module = device.createShaderModule({label: 'Photon hash grid', code: photonGridCompute}),
      layout = device.createPipelineLayout({bindGroupLayouts: [this.layout]});
    this.pipelines = ['count', 'scanBlocks', 'scanSums', 'scatter'].map((entryPoint) =>
      device.createComputePipeline({label: 'Photon ' + entryPoint, layout, compute: {module, entryPoint}})
    );
  }
  ensure(target: object, requested: number) {
    const device = this.device,
      limit = device.limits.maxTextureDimension2D;
    const budget = causticDiagnostics.photonBudgetBytes ?? 128 * 1024 * 1024;
    let count = Math.max(
      1,
      Math.min(
        Math.round(requested),
        Math.floor(device.limits.maxStorageBufferBindingSize / PHOTON_BYTES),
        Math.floor((limit * limit - PHOTON_GRID_SIZE * 4 - 8) / 3),
        Math.floor(((causticDiagnostics.photonBudgetBytes ?? 128 * 1024 * 1024) - 13 * 1024 * 1024) / 28)
      )
    );
    // Include row padding instead of assuming every texture is tightly packed.
    const allocationBytes = (n: number) => {
      const {buckets, texels} = photonLayout(n);
      const capacity = (texels: number) => Math.min(texels, limit) * Math.ceil(texels / limit);
      return (buckets + buckets / 256) * 32 + capacity(n) * 16 + capacity(texels) * 4 + 32;
    };
    while (count > 1 && allocationBytes(count) > budget) {
      count = Math.max(1, count - Math.ceil((allocationBytes(count) - budget) / 28));
    }
    const existing = this.targets.get(target);
    if (existing?.count === count) return existing;
    this.release(target);
    const {buckets, texels: headerTexels} = photonLayout(count),
      texels = count,
      width = Math.min(texels, limit),
      height = Math.ceil(texels / width);
    // One rgba32uint texel holds position and flux. Direction words live after
    // both sorted indices in the integer grid texture: 20 B payload + 8 B indices.
    const batch = {
      count,
      buckets,
      grid: device.createBuffer({
        label: 'Photon hash buckets',
        size: (buckets + buckets / 256) * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      }),
      uniform: device.createBuffer({
        label: 'Photon grid parameters',
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }),
      data: device.createTexture({
        label: 'Packed photon positions and flux',
        size: [width, height],
        format: 'rgba32uint',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      }),
      headers: device.createTexture({
        label: 'Photon grid headers',
        size: [
          Math.min(headerTexels, limit),
          Math.ceil((headerTexels) / limit)
        ],
        format: 'r32uint',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      })
    } as Batch;
    batch.group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        {binding: 0, resource: batch.data.createView()},
        {binding: 1, resource: {buffer: batch.grid}},
        {binding: 2, resource: {buffer: batch.uniform}},
        {binding: 4, resource: batch.headers.createView()}
      ]
    });
    this.targets.set(target, batch);
    return batch;
  }
  get(target: object) {
    return this.targets.get(target);
  }
  encode(
    encoder: GPUCommandEncoder,
    groups: GPUBindGroup[],
    target: object,
    radius: number,
    options: Parameters<WGPUCausticLightPass['encode']>[3]
  ) {
    const batch = this.targets.get(target)!;
    if (causticDiagnostics.capturePhotons)
      causticDiagnostics.photonBatch = {
        device: this.device,
        data: batch.headers,
        emitted: batch.count,
        packed: true
      };
    encoder.clearBuffer(batch.grid);
    this.emission.emit(encoder, groups, batch.data, {
      ...options,
      photons: batch.count,
      photonMapping: true,
      photonDirections: batch.headers
    });
    const bytes = new ArrayBuffer(32);
    new Float32Array(bytes)[0] = radius;
    new Uint32Array(bytes)[1] = batch.count;
    new Float32Array(bytes)[2] =
      causticDiagnostics.photonScreenRadius !== false ? (causticDiagnostics.photonScreenPixels ?? 2) : 0;
    new Float32Array(bytes)[3] = causticDiagnostics.photonSkipQuery
      ? 1
      : causticDiagnostics.photonSkipVisible
        ? 2
        : 0;
    new Uint32Array(bytes)[4] = batch.buckets;
    new Float32Array(bytes)[5] = photonVisibleRadius(radius, options, new Float32Array(bytes)[2]);
    this.device.queue.writeBuffer(batch.uniform, 0, bytes);
    const group = batch.group;
    // Dispatch boundaries synchronize storage accesses. Offline batches share one
    // compute pass; timestamp profiling keeps separate passes for stage timings.
    const combined = options.querySet ? undefined : encoder.beginComputePass({label: 'Photon grid'});
    this.pipelines.forEach((pipeline, index) => {
      const pass =
        combined ??
        encoder.beginComputePass({
          label: ['Photon count', 'Photon scan blocks', 'Photon scan sums', 'Photon scatter'][index],
          timestampWrites: {
            querySet: options.querySet!,
            beginningOfPassWriteIndex: 8 + index * 2,
            endOfPassWriteIndex: 9 + index * 2
          }
        });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      const groups =
        index === 1
          ? batch.buckets / 256
          : index === 2
            ? 1
            : Math.ceil((index === 3 ? Math.max(batch.count, batch.buckets) : batch.count) / 64);
      pass.dispatchWorkgroups(Math.min(groups, 65535), index === 1 || index === 2 ? 2 : Math.ceil(groups / 65535));
      if (!combined) pass.end();
    });
    combined?.end();
  }
  release(target: object) {
    const b = this.targets.get(target);
    if (!b) return;
    b.grid.destroy();
    b.uniform.destroy();
    b.data.destroy();
    b.headers.destroy();
    this.targets.delete(target);
  }
  bytes(target: object) {
    const b = this.targets.get(target);
    return b
      ? b.grid.size +
          b.uniform.size +
          b.data.width * b.data.height * 16 +
          b.headers.width * b.headers.height * 4
      : 0;
  }
  dispose() {
    for (const target of this.targets.keys()) this.release(target);
    this.emission.dispose();
    this.placeholder.destroy();
  }
}
/** Knaus & Zwicker's probabilistic radius schedule; default alpha = 2/3. */
export function photonRadius(initial: number, batch: number, alpha = 2 / 3) {
  return initial * Math.pow(Math.max(1, batch), (alpha - 1) / 2);
}

/** Typical first-receiver footprint at the caster center; query disks stay exact. */
export function photonVisibleRadius(radius: number, options: {viewProjection: ArrayLike<number>; casterSphere: readonly number[]; width: number; orthographic?: boolean}, screenPixels = 2) {
  const m = options.viewProjection, p = options.casterSphere;
  const depth = options.orthographic ? 1 : Math.abs(m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15]);
  const projection = Math.hypot(m[0], m[4], m[8]);
  const footprint = 2 * depth / (options.width * projection) * screenPixels;
  return screenPixels > 0 && Number.isFinite(footprint) && footprint > 0 ? Math.min(radius, Math.max(1e-8, footprint)) : radius;
}
