import {packCausticLightUniform} from './causticUniform.js';
export {packCausticLightUniform} from './causticUniform.js';
import {resourceTableLayout, setResourceTable, type ResourceTable} from './wgpuBindless.js';
import type {CasterSphere} from './caustics.js';
import {CAUSTIC_UNIFORM_BYTES, causticAccumulateCompute} from './wgsl/causticLight.compute.js';

interface Output {
  splats: GPUBuffer;
  accumulation: GPUBuffer;
  resolveGroup: GPUBindGroup;
}
/** Per-target photon splats and independent floating-point batch accumulation. */
export class WGPUCausticLightPass {
  private distribution?: GPUTexture;
  private emissionGroups = new WeakMap<GPUBuffer | GPUTexture, GPUBindGroup>();
  private casterCount = 0;
  private choiceCount = 0;
  private pipeline?: GPUComputePipeline;
  private key = '';
  private layoutKey?: object;
  private readonly outputs = new Map<object, Output>();
  private readonly uniform: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly accumulate: GPUComputePipeline;
  constructor(
    private readonly device: GPUDevice,
    private readonly photonMapping = false
  ) {
    this.uniform = device.createBuffer({
      label: 'Caustic light uniforms',
      size: CAUSTIC_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        {binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'uniform'}},
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          ...(photonMapping
            ? {storageTexture: {access: 'write-only' as const, format: 'rgba32uint' as const}}
            : {buffer: {type: 'storage' as const}})
        },
        {binding: 2, visibility: GPUShaderStage.COMPUTE, texture: {sampleType: 'unfilterable-float'}},
        ...(photonMapping
          ? [
              {
                binding: 3,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: {access: 'write-only' as const, format: 'r32uint' as const}
              }
            ]
          : [])
      ]
    });
    this.accumulate = device.createComputePipeline({
      label: 'Caustic batch accumulation',
      layout: 'auto',
      compute: {module: device.createShaderModule({code: causticAccumulateCompute}), entryPoint: 'main'}
    });
  }
  async prepare(source: string, groups: GPUBindGroupLayout[], bindless = false, layoutKey: object = groups) {
    if (this.key === source && this.layoutKey === layoutKey && this.pipeline) return;
    const module = this.device.createShaderModule({label: 'Caustic light tracing', code: source});
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length)
      throw Error(errors.map((m) => `Caustic WGSL ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    const pipeline = await this.device.createComputePipelineAsync({
      label: 'Caustic light tracing',
      layout: this.device.createPipelineLayout(
        bindless
          ? resourceTableLayout({bindGroupLayouts: [...groups, this.layout]})
          : {bindGroupLayouts: [...groups, this.layout]}
      ),
      compute: {module, entryPoint: 'main'}
    });
    this.pipeline = pipeline;
    this.key = source;
    this.layoutKey = layoutKey;
  }
  setDistribution(spheres: readonly CasterSphere[], lights: {data: Float32Array; count: number}) {
    this.choiceCount = lights.count;
    this.casterCount = spheres.length;
    this.distribution?.destroy();
    this.emissionGroups = new WeakMap();
    const texels = Math.max(1, spheres.length + lights.count * 2),
      width = Math.min(texels, this.device.limits.maxTextureDimension2D),
      height = Math.ceil(texels / width);
    this.distribution = this.device.createTexture({
      label: 'Caustic emission distribution',
      size: [width, height],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const data = new Float32Array(width * height * 4);
    spheres.forEach((sphere, i) => data.set(sphere, i * 4));
    data.set(lights.data, spheres.length * 4);
    this.device.queue.writeTexture({texture: this.distribution}, data, {bytesPerRow: width * 16}, [
      width,
      height
    ]);
  }
  get(target: object) {
    return this.outputs.get(target)?.accumulation;
  }
  bytes(target: object) {
    const o = this.outputs.get(target);
    return o ? o.splats.size + o.accumulation.size : 0;
  }
  release(target: object) {
    const o = this.outputs.get(target);
    o?.splats.destroy();
    o?.accumulation.destroy();
    this.outputs.delete(target);
  }
  encode(
    encoder: GPUCommandEncoder,
    groups: GPUBindGroup[],
    target: object,
    options: {
      photonMapping?: boolean;
      photonDirections?: GPUTexture;
      querySet?: GPUQuerySet;
      resourceTable?: ResourceTable;
      width: number;
      height: number;
      clear: boolean;
      run: boolean;
      photons: number;
      batch: number;
      viewProjection: Float32Array | Float64Array | number[];
      casterSphere: readonly number[];
      cameraScale: number;
      casterCount?: number;
      choiceCount?: number;
      orthographic?: boolean;
    }
  ) {
    const {width, height} = options;
    let output = this.outputs.get(target);
    if (output && output.accumulation.size !== width * height * 16) {
      this.release(target);
      output = undefined;
    }
    if (!output) {
      output = {
        splats: this.device.createBuffer({
          label: 'Caustic floating-point splats',
          size: width * height * 12,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        resolveGroup: undefined as unknown as GPUBindGroup,
        accumulation: this.device.createBuffer({
          label: 'Caustic batch accumulation',
          size: width * height * 16,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        })
      };
      output.resolveGroup = this.device.createBindGroup({
        layout: this.accumulate.getBindGroupLayout(0),
        entries: [
          {binding: 0, resource: {buffer: output.splats}},
          {binding: 1, resource: {buffer: output.accumulation}}
        ]
      });
      this.outputs.set(target, output);
    }
    if (options.clear) encoder.clearBuffer(output.accumulation);
    if (!options.run || !this.pipeline) return;
    encoder.clearBuffer(output.splats);
    this.emit(encoder, groups, output.splats, options);
    const resolve = encoder.beginComputePass({
      label: 'Caustic batch accumulation',
      ...(options.querySet
        ? {
            timestampWrites: {
              querySet: options.querySet,
              beginningOfPassWriteIndex: 4,
              endOfPassWriteIndex: 5
            }
          }
        : {})
    });
    resolve.setPipeline(this.accumulate);
    resolve.setBindGroup(0, output.resolveGroup);
    resolve.dispatchWorkgroups(Math.ceil((width * height) / 64));
    resolve.end();
  }
  emit(
    encoder: GPUCommandEncoder,
    groups: GPUBindGroup[],
    storage: GPUBuffer | GPUTexture,
    options: Parameters<WGPUCausticLightPass['encode']>[3]
  ) {
    if (!this.pipeline) return;
    const data = packCausticLightUniform({
      ...options,
      casterCount: this.casterCount,
      choiceCount: this.choiceCount
    });
    this.device.queue.writeBuffer(this.uniform, 0, data);
    const pass = encoder.beginComputePass({
      label: 'Caustic photons',
      ...(options.querySet
        ? {
            timestampWrites: {
              querySet: options.querySet,
              beginningOfPassWriteIndex: options.photonMapping ? 6 : 2,
              endOfPassWriteIndex: options.photonMapping ? 7 : 3
            }
          }
        : {})
    });
    pass.setPipeline(this.pipeline);
    if (options.resourceTable) setResourceTable(pass, options.resourceTable);
    groups.forEach((g, i) => pass.setBindGroup(i, g));
    let group = this.emissionGroups.get(storage);
    if (!group) {
      group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          {binding: 0, resource: {buffer: this.uniform}},
          {
            binding: 1,
            resource: this.photonMapping
              ? (storage as GPUTexture).createView()
              : {buffer: storage as GPUBuffer}
          },
          {binding: 2, resource: this.distribution!.createView()},
          ...(this.photonMapping ? [{binding: 3, resource: options.photonDirections!.createView()}] : [])
        ]
      });
      this.emissionGroups.set(storage, group);
    }
    pass.setBindGroup(groups.length, group);
    const groupsCount = Math.ceil(options.photons / 64);
    pass.dispatchWorkgroups(Math.min(groupsCount, 65535), Math.ceil(groupsCount / 65535));
    pass.end();
  }
  dispose() {
    for (const target of this.outputs.keys()) this.release(target);
    this.uniform.destroy();
    this.distribution?.destroy();
  }
}
