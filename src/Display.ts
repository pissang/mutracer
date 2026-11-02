import {displayAovKind, validateAovDisplay, type AovIdComponent} from './renderer/aovDisplay.js';
export type {AovIdComponent} from './renderer/aovDisplay.js';
import {createCanvas} from './util/canvas.js';
import type Engine from './Engine.js';
import type Render from './Render.js';
import type { ToneMapping, DisplayChannel } from './renderer/RenderingPipeline.js';
import type { ColorRGB } from './types.js';
import { displaySettingsKey, displayFilterSettingsKey, applyDisplaySettings } from './settings/display.js';
/** Display image channels. Default final. */
export type {DisplayChannel} from './renderer/RenderingPipeline.js';
/** Image encoding options for Display.toBlob. */
export interface BlobOptions {
  /** Browser image MIME type. Default image/png. */ type?: string;
  /** Encoder quality in 0–1. Default undefined uses the browser default. */ quality?: number;
}
/** Optional shared display settings; defaults match Display. */
export interface DisplaySettings {
  /** Tone mapping transform. Default agx. */ toneMapping?: ToneMapping;
  /** Linear exposure multiplier. Default 1. */ toneMappingExposure?: number;
  /** Contrast multiplier. Default 1. */ contrast?: number;
  /** Saturation multiplier. Default 1. */ saturation?: number;
  /** White balance temperature shift in -1–1. Default 0. */ temperature?: number;
  /** Green/magenta tint in -1–1. Default 0. */ tint?: number;
  /** Vignette strength in 0–1. Default 0. */ vignette?: number;
  /** Bloom intensity; 0 disables it. Default 0. */ bloomIntensity?: number;
  /** Bloom luminance threshold. Default 1. */ bloomThreshold?: number;
  /** Bloom radius in 0–1. Default 0.6. */ bloomRadius?: number;
  /** Extended-range WebGPU presentation, ignored on WebGL. Default false. */ hdrOutputEnabled?: boolean;
  /** Display image channel. Default final. AOV channels require explicit Render.aovs. */ channel?: DisplayChannel;
  /** Finite float32 scene-unit depths mapped to black/white; 0 <= near < far. Default [0, 10]. */ aovDepthRange?: readonly [number, number];
  /** Finite positive float32 scene-unit half-range around the origin for position RGB. Default 1. */ aovPositionScale?: number;
  /** Finite positive float32 input-pixel displacement mapped to full motion brightness. Default 16. */ aovMotionScale?: number;
  /** Stable ID lane to colorize. Default object. */ aovIdComponent?: AovIdComponent;
  /** Linear shadow-catcher color. Default black. */ shadowCatcherColor?: ColorRGB;
  /** Shadow-catcher opacity multiplier. Default 1. */ shadowCatcherAlpha?: number;
}
/** Borrowed WebGPU images for one synchronous display pass. */
export interface PostProcessContext {
  /** Engine device; may change after recovery. */ device: GPUDevice;
  /** Record commands here; the library finishes and submits it. */ encoder: GPUCommandEncoder;
  /** Read-only composed display image, top row first; no additional color conversion. */ input: GPUTexture;
  /** Fully write this image. Same format and dimensions as input; supports render, storage and copy writes. */ output: GPUTexture;
  /** Actual render width. */ width: number;
  /** Actual render height. */ height: number;
  /** Selected complete render, including a selected fallback. */ render: Render;
}
/** Synchronous display pass. Images and encoder are borrowed only during the call; do not retain or destroy them. */
export type PostProcess = (context: PostProcessContext) => void;
/** Canvas presentation and shared display settings; obtained from engine.display. */
export default class Display {
  /** Display canvas. Default the supplied Engine canvas, or a new canvas (OffscreenCanvas without document). */ readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Tone mapping transform. Default agx. */ toneMapping: ToneMapping = 'agx';
  /** Linear exposure multiplier. Default 1. */ toneMappingExposure = 1;
  /** Contrast multiplier. Default 1. */ contrast = 1;
  /** Saturation multiplier. Default 1. */ saturation = 1;
  /** White balance temperature shift in -1–1. Default 0. */ temperature = 0;
  /** Green/magenta tint in -1–1. Default 0. */ tint = 0;
  /** Vignette strength in 0–1. Default 0. */ vignette = 0;
  /** Bloom intensity; 0 disables it. Default 0. */ bloomIntensity = 0;
  /** Bloom luminance threshold. Default 1. */ bloomThreshold = 1;
  /** Bloom radius in 0–1. Default 0.6. */ bloomRadius = 0.6;
  /** Extended-range WebGPU presentation, ignored on WebGL. Default false. */ hdrOutputEnabled = false;
  /** Display image channel. Default final. AOV channels require explicit Render.aovs. */ channel: DisplayChannel = 'final';
  /** Finite float32 scene-unit depths mapped to black/white; 0 <= near < far. Default [0, 10]. */ aovDepthRange: readonly [number, number] = [0, 10];
  /** Finite positive float32 scene-unit half-range around the origin for position RGB. Default 1. */ aovPositionScale = 1;
  /** Finite positive float32 input-pixel displacement mapped to full motion brightness. Default 16. */ aovMotionScale = 16;
  /** Stable ID lane to colorize. Default object. */ aovIdComponent: AovIdComponent = 'object';
  /** Linear shadow-catcher color. Default black. */ shadowCatcherColor: ColorRGB = [0, 0, 0];
  /** Shadow-catcher opacity multiplier. Default 1. */ shadowCatcherAlpha = 1;
  private constructor(private readonly engine: Engine, canvas: HTMLCanvasElement | OffscreenCanvas) { this.canvas = canvas; }
  /** @internal */ static _create(engine: Engine, canvas: HTMLCanvasElement | OffscreenCanvas) { return new Display(engine, canvas); }
  /** Resizes the drawing buffer; scale-based renders resize at their next refine. */
  setSize(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('Display dimensions must be positive.');
    width = Math.round(width); height = Math.round(height);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }
  private readonly _filterSettings = new WeakMap<Render, string>();
  private readonly settings = new WeakMap<Render, string>();
  /** @internal */ _configure(render: Render) {
    if (render._engine !== this.engine) throw new Error('Render belongs to another engine.');
    const target = render._output;
    if (!target) return;
    const kind = displayAovKind(this.channel);
    if (!kind && !['final','normal','albedo','shadow','shadowCatcher'].includes(this.channel)) throw new RangeError('Unknown display channel');
    if (kind && !render.aovs.includes(kind)) throw new Error(`AOV ${kind} is not enabled on the selected render`);
    validateAovDisplay({depthRange: this.aovDepthRange, positionScale: this.aovPositionScale, motionScale: this.aovMotionScale, idComponent: this.aovIdComponent});
    const key = displaySettingsKey(this);
    const filterKey = displayFilterSettingsKey(this);
    const previous = this.settings.get(render);
    if (previous !== key) {
      this.settings.set(render, key);
      if (previous !== undefined && this._filterSettings.get(render) !== filterKey) render._displayChanged();
      this._filterSettings.set(render, filterKey);
    }
    target.activate();
    applyDisplaySettings(this, target);
  }
  private readonly _postProcesses: {pass: PostProcess}[] = [];
  private _warnedPostProcess = false;
  /** Registers a display pass in order and returns an idempotent removal function. Default no passes. WebGPU only; WebGL skips passes with one warning. Runs after composition on every present/toBlob, without tracing or invalidating denoising. A thrown error discards the whole chain, presents the original image and emits engine error. */
  addPostProcess(pass: PostProcess): () => void {
    const entry = {pass};
    this._postProcesses.push(entry);
    if (this.engine.backend === 'webgl') this.warnPostProcess();
    return () => { const index = this._postProcesses.indexOf(entry); if (index >= 0) this._postProcesses.splice(index, 1); };
  }
  private warnPostProcess() {
    if (!this._warnedPostProcess) { this._warnedPostProcess = true; console.warn('Display post-processing requires WebGPU; passes are ignored on WebGL.'); }
  }
  private compose(render: Render) {
    if (render._engine !== this.engine) throw new Error('Render belongs to another engine.');
    const target = render._output;
    if (!target) return;
    const kind = displayAovKind(this.channel);
    if (!kind && !target.presentationComplete) return;
    if (kind && !render.aovs.includes(kind)) throw new Error(`AOV ${kind} is not enabled on the selected render`);
    if (kind && target.aovReady && !target.aovReady(kind)) return;
    this._configure(render);
    target.drawPostProcess();
    if (this._postProcesses.length && this.engine.backend === 'webgl') this.warnPostProcess();
    try { target.applyPostProcesses?.(this._postProcesses.map(entry => entry.pass), render); }
    catch (error) { this.engine._notifyError(error); }
    return target;
  }
  /** Presents a complete image or fallback. Keeps fallback visible until the first intermediate filter finishes. Does not trace. */
  present(render: Render): Render | undefined {
    if (render._engine !== this.engine) throw new Error('Render belongs to another engine.');
    const ready = this.channel === 'final' && render.fallback ? render._presentable : render._completeFor(this.channel);
    const fallback = render.fallback;
    const selected = ready ? render : fallback && (this.channel === 'final' ? fallback._presentable : fallback._completeFor(this.channel)) ? fallback : undefined;
    if (!selected) return;
    const target = this.compose(selected);
    if (!target) return;
    this.engine._present(target);
    return selected;
  }
  /** Encodes this render at its actual dimensions using these settings; leaves the display canvas unchanged. */
  async toBlob(render: Render, options: BlobOptions = {}): Promise<Blob> {
    const target = this.compose(render);
    if (!target) throw new Error('Render has no complete image.');
    const image = render._cropOutput(await target.readPresentation());
    const canvas = createCanvas(image.width, image.height, 'convertToBlob' in this.canvas);
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('The image encoding context is not available.');
    const bytes = new Uint8ClampedArray(image.data.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, image.data[i])) * 255);
    context.putImageData(new ImageData(bytes, image.width, image.height), 0, 0);
    if ('convertToBlob' in canvas) return canvas.convertToBlob({type: options.type ?? 'image/png', quality: options.quality});
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be encoded')), options.type ?? 'image/png', options.quality));
  }
}
