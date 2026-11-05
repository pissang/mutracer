import {createCanvas} from '../util/canvas.js';
type HDRConfiguration = GPUCanvasConfiguration & {toneMapping: {mode: 'extended'}};
type InspectableContext = GPUCanvasContext & {getConfiguration?: () => GPUCanvasConfiguration & {toneMapping?: {mode?: string}}};
// A canvas returns the same context to every engine, and engine disposal defers
// releasing its surface until submitted GPU work finishes. Only the surface that
// configured the context last may unconfigure it, so a later engine on the same
// canvas keeps presenting.
const owners = new WeakMap<GPUCanvasContext, WGPUCanvasSurface>();
/** One canvas surface; composing or exporting an image never reconfigures it. */
export class WGPUCanvasSurface {
  readonly context: InspectableContext;
  hdr = false;
  private compatibleHDR?: boolean;
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, private readonly device: GPUDevice, private readonly standardFormat: GPUTextureFormat) {
    this.context = canvas.getContext('webgpu')! as InspectableContext;
    this.context.configure({device, format: standardFormat, alphaMode: 'premultiplied'});
    owners.set(this.context, this);
  }
  get format() {return this.hdr ? 'rgba16float' as const : this.standardFormat;}
  get supportsHDR() {
    if (this.compatibleHDR !== undefined) return this.compatibleHDR;
    this.compatibleHDR = false;
    let probe: InspectableContext | null = null;
    try {
      probe = createCanvas().getContext('webgpu') as InspectableContext | null;
      if (!probe) return false;
      probe.configure({device: this.device, format: 'rgba16float', alphaMode: 'premultiplied', colorSpace: 'srgb', toneMapping: {mode: 'extended'}} as HDRConfiguration);
      const applied = probe.getConfiguration?.();
      this.compatibleHDR = applied?.format === 'rgba16float' && applied.toneMapping?.mode === 'extended';
    } catch {this.compatibleHDR = false;}
    finally {probe?.unconfigure?.();}
    return this.compatibleHDR;
  }
  configure(enabled: boolean) {
    const active = enabled && this.supportsHDR;
    if (active === this.hdr) return;
    this.hdr = active;
    this.context.configure(active
      ? {device: this.device, format: 'rgba16float', alphaMode: 'premultiplied', colorSpace: 'srgb', toneMapping: {mode: 'extended'}} as HDRConfiguration
      : {device: this.device, format: this.standardFormat, alphaMode: 'premultiplied'});
  }
  dispose() {
    if (owners.get(this.context) !== this) return;
    owners.delete(this.context);
    this.context.unconfigure?.();
  }
}
