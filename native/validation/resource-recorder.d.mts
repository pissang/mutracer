interface CaptureBuffer {
  data: Uint8Array; size: number;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
export class CaptureDevice {
  createBuffer(descriptor: { size: number; mappedAtCreation?: boolean }): CaptureBuffer;
  queue: {
    writeBuffer(buffer: CaptureBuffer, offset: number, data: ArrayBuffer | ArrayBufferView,
      dataOffset?: number, size?: number): void;
  };
}
export function installWebGPUConstants(): void;
