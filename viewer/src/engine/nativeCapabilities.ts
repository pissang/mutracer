export interface NativeCapabilities {
    adapterName: string;
    maxImageDimension: number;
    hwrt: boolean;
    dlssRR: boolean;
    gpuSelection: boolean;
    hdrWindow: boolean;
    layout: 'overlay' | 'split';
    adapters: string[];
    backend: 'hardware' | 'software';
}
let change: ((options: {
    gpu?: string;
    backend?: 'hardware' | 'software';
}) => Promise<void>) | undefined;
export function bindNativeDeviceChange(callback: typeof change) { change = callback; }
export function changeNativeDevice(options: {
    gpu?: string;
    backend?: 'hardware' | 'software';
}) { return change?.(options); }
