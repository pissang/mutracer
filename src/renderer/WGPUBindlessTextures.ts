import { isProceduralSkyImage } from '../scene/skyParameters.js';
import type Texture from '../scene/Texture.js';
import {isTextureDataSource} from '../scene/Texture.js';
import {textureWrapIndex} from '../scene/TextureState.js';
import {createCanvas} from '../util/canvas.js';
import {writeRawAtlasPlacement} from './textureAtlasPixels.js';
import {float16Bits} from './float16.js';
import {textureColorLinear, textureFloatStorage} from './WGPUBindlessMaterialData.js';
import {isUdimTexture} from '../scene/UdimTexture.js';
import {bindlessLimitReason, createResourceTable, FIRST_TEXTURE_SLOT, RESOURCE_TABLE_LIMIT, type ResourceTable} from './wgpuBindless.js';

export interface TextureExtent {width: number; height: number;}
export function planIndependentTextures(textures: readonly Texture[], budget: number, dimension: number) {
  const floatStorage = textures.some(textureFloatStorage), bytesPerPixel = floatStorage ? 8 : 4;
  const indices = [...new Map(textures.map((t, i) => [t, i])).values()];
  for (const {image} of textures) if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1) {
    throw new Error('Material textures require positive integer dimensions.');
  }
  const extents = (scale: number) => textures.map(t => ({width: Math.max(1, Math.floor(t.image.width * scale)), height: Math.max(1, Math.floor(t.image.height * scale))}));
  const bytes = (sizes: TextureExtent[]) => indices.reduce((sum, i) => sum + sizes[i].width * sizes[i].height * bytesPerPixel, 0);
  if (indices.length * bytesPerPixel > budget) throw new Error('Material textures cannot fit the budget even at 1×1.');
  let scale = textures.reduce((s, t) => Math.min(s, dimension / Math.max(t.image.width, t.image.height)), 1);
  if (bytes(extents(scale)) > budget) {
    let low = 0, high = scale;
    for (let i = 0; i < 40; i++) {const mid = (low + high) / 2; if (bytes(extents(mid)) <= budget) low = mid; else high = mid;}
    scale = low;
  }
  const sizes = extents(scale);
  return {sizes, scale, floatStorage, bytesPerPixel, estimatedBytes: bytes(sizes)};
}
export function independentTexturePixels(texture: Texture, size: TextureExtent, floatStorage: boolean): Uint8Array | Uint16Array {
  const data = floatStorage ? new Uint16Array(size.width * size.height * 4) : new Uint8Array(size.width * size.height * 4);
  if (isTextureDataSource(texture.image)) {
    writeRawAtlasPlacement(data, size.width, {index: 0, layer: 0, x: 0, y: 0, ...size}, {image: texture.image, flipY: texture.flipY}, floatStorage);
  } else {
    const canvas = createCanvas(size.width, size.height), context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to prepare material texture pixels.');
    if (texture.flipY) {context.translate(0, size.height); context.scale(1, -1);}
    if (isProceduralSkyImage(texture.image)) throw new Error('ProceduralSky is only supported as an environment or background.');
    context.drawImage(texture.image, 0, 0, size.width, size.height);
    const pixels = context.getImageData(0, 0, size.width, size.height).data;
    for (let i = 0; i < pixels.length; i++) data[i] = floatStorage ? float16Bits(pixels[i] / 255) : pixels[i];
  }
  return data;
}
export function packIndependentTextureInfo(textures: readonly Texture[], sizes: TextureExtent[], capacity: number) {
  const data = new ArrayBuffer(capacity * 48), f32 = new Float32Array(data), u32 = new Uint32Array(data);
  textures.forEach((t, i) => {
    const base = i * 12;
    f32.set([...t.uvScale, ...t.uvOffset], base);
    u32.set([FIRST_TEXTURE_SLOT + i, 1 + textureWrapIndex(t.wrapS) * 3 + textureWrapIndex(t.wrapT), t.uvChannel, isUdimTexture(t) ? 2 + textureColorLinear(t) : textureColorLinear(t), sizes[i].width, sizes[i].height], base + 4);
  });
  return data;
}
interface TextureEntry {
  gpu: GPUTexture; image: Texture['image']; version: number; width: number; height: number;
  sourceWidth: number; sourceHeight: number; flipY: boolean; format: GPUTextureFormat;
}
/** Browser scene resources; callers wait for retirement before preparing another generation. */
export class WGPUBindlessTextures {
  table?: ResourceTable;
  metadata?: GPUBuffer;
  retirement?: Promise<void>;
  private entries = new Map<Texture, TextureEntry>();
  private logical: GPUTexture[] = [];
  private samplers: GPUSampler[];
  private fallback: GPUTexture;
  private disposed = false;
  private generation = 0;
  private metadataCapacity = 0;
  private retiredBytes = 0;
  private destroyRetired?: () => void;
  private stats = {textureCount: 0, estimatedBytes: 0, scale: 1};
  constructor(private device: GPUDevice) {
    const modes: GPUAddressMode[] = ['repeat', 'clamp-to-edge', 'mirror-repeat'];
    this.samplers = modes.flatMap(addressModeU => modes.map(addressModeV => device.createSampler({minFilter: 'linear', magFilter: 'linear', addressModeU, addressModeV})));
    this.fallback = device.createTexture({size: [1,1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture: this.fallback}, new Uint8Array([255,255,255,255]), {bytesPerRow: 4}, [1,1]);
  }
  get revision() { return this.generation; }
  get diagnostics() { return {...this.stats, metadataBytes: this.metadata?.size ?? 0, resourceTableCapacity: this.table?.size ?? 0, retiredBytes: this.retiredBytes}; }
  update(textures: Texture[], budget: number) {
    if (this.disposed) throw new Error('Bindless textures are disposed.');
    if (this.retirement) throw new Error('Previous resource-table generation has not retired.');
    const reason = bindlessLimitReason(this.device, textures.length);
    if (reason) throw new Error(reason);
    const plan = planIndependentTextures(textures, budget, this.device.limits.maxTextureDimension2D);
    const format = plan.floatStorage ? 'rgba16float' : 'rgba8unorm';
    const next = new Map<Texture, TextureEntry>(), created: GPUTexture[] = [];
    let newTable: ResourceTable | undefined, newBuffer: GPUBuffer | undefined;
    try {
      textures.forEach((texture, i) => {
        if (next.has(texture)) return;
        const size = plan.sizes[i], old = this.entries.get(texture);
        const reusable = old && old.width === size.width && old.height === size.height && old.format === format;
        const gpu = reusable ? old.gpu : this.device.createTexture({label: 'Material texture', size: [size.width, size.height], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
        if (!reusable) created.push(gpu);
        if (!reusable || old.image !== texture.image || old.version !== texture.version || old.flipY !== texture.flipY || old.sourceWidth !== texture.image.width || old.sourceHeight !== texture.image.height) {
          const pixels = independentTexturePixels(texture, size, plan.floatStorage);
          this.device.queue.writeTexture({texture: gpu}, pixels, {bytesPerRow: size.width * plan.bytesPerPixel}, [size.width, size.height]);
        }
        next.set(texture, {gpu, image: texture.image, version: texture.version, sourceWidth: texture.image.width, sourceHeight: texture.image.height, flipY: texture.flipY, format, ...size});
      });
      const logical = textures.map(t => next.get(t)!.gpu);
      const changed = !this.table || logical.length !== this.logical.length || logical.some((t, i) => t !== this.logical[i]);
      if (changed) {
        const size = Math.min(RESOURCE_TABLE_LIMIT, 2 ** Math.ceil(Math.log2(Math.max(16, textures.length + FIRST_TEXTURE_SLOT))));
        newTable = createResourceTable(this.device, size); newTable.update(0, this.fallback.createView());
        this.samplers.forEach((sampler, i) => newTable!.update(i + 1, sampler));
        logical.forEach((gpu, i) => newTable!.update(FIRST_TEXTURE_SLOT + i, gpu.createView()));
      }
      const maxCapacity = Math.floor(Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize) / 48);
      const capacity = Math.min(maxCapacity, Math.max(this.metadataCapacity, 2 ** Math.ceil(Math.log2(Math.max(1, textures.length)))));
      if (!this.metadata || capacity !== this.metadataCapacity) newBuffer = this.device.createBuffer({label: 'Material texture metadata', size: capacity * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
      this.device.queue.writeBuffer(newBuffer ?? this.metadata!, 0, packIndependentTextureInfo(textures, plan.sizes, capacity));
      const oldTable = newTable ? this.table : undefined, oldBuffer = newBuffer ? this.metadata : undefined;
      const retained = new Set(logical);
      const removed = [...new Set([...this.entries.values()].map(e => e.gpu))].filter(t => !retained.has(t));
      this.entries = next; this.logical = logical;
      if (newTable) this.table = newTable;
      if (newBuffer) this.metadata = newBuffer;
      this.metadataCapacity = capacity; this.generation++;
      this.stats = {textureCount: textures.length, estimatedBytes: [...new Set(logical)].reduce((n, t) => n + t.width * t.height * plan.bytesPerPixel, 0), scale: plan.scale};
      if (oldTable || oldBuffer || removed.length) {
        this.retiredBytes = (oldBuffer?.size ?? 0) + removed.reduce((n, t) => n + t.width * t.height * (t.format === 'rgba16float' ? 8 : 4), 0);
        const destroy = () => {oldTable?.destroy(); oldBuffer?.destroy(); removed.forEach(t => t.destroy()); this.retiredBytes = 0;};
        this.destroyRetired = destroy;
        this.retirement = this.device.queue.onSubmittedWorkDone().catch(() => {}).then(() => {
          if (this.destroyRetired === destroy) {destroy(); this.destroyRetired = undefined; this.retirement = undefined;}
        });
      }
    } catch (error) {newTable?.destroy(); newBuffer?.destroy(); created.forEach(t => t.destroy()); throw error;}
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    this.destroyRetired?.(); this.destroyRetired = undefined; this.retirement = undefined;
    this.table?.destroy(); this.metadata?.destroy(); this.fallback.destroy();
    new Set([...this.entries.values()].map(e => e.gpu)).forEach(t => t.destroy());
    this.entries.clear(); this.logical = [];
  }
}
