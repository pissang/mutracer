import type { PostProcess, PostProcessContext, PostProcessOptions } from '../Display.js';
import {textureBytes} from './gpuMemory.js';

type Size = {width: number; height: number};
/** Target-owned images. A failed chain never replaces the composed image. */
export class DisplayPostProcess {
  private textures = new Map<string, GPUTexture[]>();
  private image?: GPUTexture;
  constructor(private readonly device: GPUDevice) {}
  get output() { return this.image; }
  reset() { this.image = undefined; }
  getMemoryBytes() { return [...this.textures.values()].flat().reduce((sum, texture) => sum + textureBytes(texture), 0); }
  private retire(textures: GPUTexture[]) {
    if (!textures.length) return;
    void this.device.queue.onSubmittedWorkDone().catch(() => {}).then(() => textures.forEach(texture => texture.destroy()));
  }
  dispose() { this.reset(); this.retire([...this.textures.values()].flat()); this.textures.clear(); }
  run(input: GPUTexture, passes: readonly PostProcess[], render: PostProcessContext['render'], display: Size = input,
    options: readonly PostProcessOptions[] = [], crop?: Size) {
    this.reset();
    const cropped = crop && (crop.width !== input.width || crop.height !== input.height);
    if (!passes.length && !cropped) return;
    const validate = (size: Size) => {
      const limit = this.device.limits.maxTextureDimension2D;
      if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > limit || size.height > limit) {
        throw new RangeError('Post-process output dimensions must be positive integers within maxTextureDimension2D.');
      }
      return {width: size.width, height: size.height};
    };
    // Evaluate the entire size chain before recording user commands.
    let size: Size = cropped ? validate(crop) : {width: input.width, height: input.height};
    const sizes = passes.map((_, index) => size = validate(options[index]?.outputSize ? options[index].outputSize!({...size}, {width: display.width, height: display.height}) : size));
    const active = new Set<string>();
    const acquire = (size: Size, previous: GPUTexture) => {
      const key = `${size.width}:${size.height}:${input.format}`;
      active.add(key);
      // Allocate the second image of a size only when consecutive passes need to ping-pong.
      const pair = this.textures.get(key) ?? [];
      this.textures.set(key, pair);
      const index = pair[0] === previous ? 1 : 0;
      pair[index] ??= this.device.createTexture({
        label: `Display post-process ${index}`, size, format: input.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
      });
      return pair[index];
    };
    const actual = render._output?.getMemory() ?? input;
    const encoder = this.device.createCommandEncoder();
    let previous = input;
    try {
      if (cropped) {
        const output = acquire(crop, previous);
        encoder.copyTextureToTexture({texture: input, origin: {x: Math.floor((input.width-crop.width)/2), y: Math.floor((input.height-crop.height)/2)}}, {texture: output}, crop);
        previous = output;
      }
      for (let index = 0; index < passes.length; index++) {
        const output = acquire(sizes[index], previous);
        passes[index]({device: this.device, encoder, input: previous, output, width: actual.width, height: actual.height, render});
        previous = output;
      }
      this.device.queue.submit([encoder.finish()]);
      this.image = previous;
    } finally {
      for (const [key, pair] of this.textures) if (!active.has(key)) { this.textures.delete(key); this.retire(pair); }
    }
  }
}
