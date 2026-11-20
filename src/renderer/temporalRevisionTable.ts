/** Sorted material-ID/revision rows consumed by the temporal capture shaders. */
export class TemporalRevisionTable {
  readonly device: GPUDevice;
  readonly label: string;
  buffer: GPUBuffer;

  constructor(device: GPUDevice, label: string) {
    this.device = device; this.label = label;
    this.buffer = this.create(8);
    this.device.queue.writeBuffer(this.buffer, 0, new Uint32Array(2));
  }

  private create(size: number) {
    return this.device.createBuffer({label: this.label, size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
  }

  async write(entries: readonly (readonly [number, number])[]) {
    const size = Math.max(8, entries.length * 8);
    if (size > this.buffer.size) {
      await this.device.queue.onSubmittedWorkDone();
      const previous = this.buffer;
      this.buffer = this.create(size);
      previous.destroy();
    }
    const values = new Uint32Array(Math.max(2, entries.length * 2));
    for (let i = 0; i < entries.length; i++) {
      values[i * 2] = entries[i][0]; values[i * 2 + 1] = entries[i][1];
    }
    this.device.queue.writeBuffer(this.buffer, 0, values);
    return this.buffer;
  }

  dispose() { this.buffer.destroy(); }
}
