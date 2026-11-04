// Offline command recorder, NOT a GPU implementation or validation substitute.
// Fail on unknown operations; native wgpu must validate and execute the capture.
export class CaptureDevice {
  resources = [];
  limits = { maxTextureArrayLayers: 256, maxTextureDimension2D: 8192 };
  features = new Set();
  queue = {
    writeBuffer: (buffer, offset, data, dataOffset = 0, size) => {
      const bytesPerElement = ArrayBuffer.isView(data) ? data.BYTES_PER_ELEMENT ?? 1 : 1;
      const source = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      const start = dataOffset * bytesPerElement;
      const count = size === undefined ? source.length - start : size * bytesPerElement;
      buffer.data.set(source.subarray(start, start + count), offset);
    },
    writeTexture: (destination, data, layout, size) => {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      destination.texture.writes.push({ origin: destination.origin ?? [0, 0, 0], layout,
        size, data: Buffer.from(bytes) });
    },
    onSubmittedWorkDone: () => Promise.resolve()
  };
  add(kind, descriptor, extra = {}) {
    const object = { id: this.resources.length, kind, descriptor, ...extra };
    this.resources.push(object);
    return object;
  }
  createBuffer(descriptor) {
    const data = new Uint8Array(descriptor.size);
    let mapped = !!descriptor.mappedAtCreation;
    return this.add('buffer', descriptor, { size: descriptor.size, data,
      getMappedRange(offset = 0, size = descriptor.size) {
        if (!mapped || offset !== 0 || size !== descriptor.size) throw new Error('Recorder requires a whole mapped buffer');
        return data.buffer;
      },
      unmap() { mapped = false; }, destroy() {} });
  }
  createTexture(descriptor) {
    const size = descriptor.size;
    const width = size.width ?? size[0], height = size.height ?? size[1] ?? 1;
    const depth = size.depthOrArrayLayers ?? size[2] ?? 1;
    const texture = this.add('texture', descriptor, { width, height, depthOrArrayLayers: depth,
      format: descriptor.format, writes: [], destroy() {},
      createView: (options = {}) => ({ kind: 'view', texture, options }) });
    return texture;
  }
  createSampler(descriptor) { return this.add('sampler', descriptor); }
  createShaderModule(descriptor) { return this.add('shader', descriptor); }
  createBindGroupLayout(descriptor) { return this.add('bind-group-layout', descriptor); }
  createPipelineLayout(descriptor) { return this.add('pipeline-layout', descriptor); }
  createBindGroup(descriptor) { return this.add('bind-group', descriptor); }
  async createComputePipelineAsync(descriptor) {
    return this.add('pipeline', descriptor, {
      getBindGroupLayout: index => descriptor.layout.descriptor.bindGroupLayouts[index]
    });
  }
  // These only record descriptor construction, not compilation success.
  pushErrorScope() {}
  async popErrorScope() { return null; }
  createCommandEncoder() {
    return {
      clearBuffer() {},
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} })
    };
  }
}

export function installWebGPUConstants() {
  globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
    INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
  globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
}
