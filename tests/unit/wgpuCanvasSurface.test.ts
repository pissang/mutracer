import {afterEach, expect, it, vi} from 'vitest';
import {WGPUCanvasSurface} from '../../src/renderer/WGPUCanvasSurface';
afterEach(() => {vi.unstubAllGlobals();});
it('probes HDR separately and reconfigures the real canvas only for presentation', () => {
  const configure = vi.fn(), unconfigure = vi.fn(); const context = {configure, unconfigure};
  const probe = {configure: vi.fn(), getConfiguration: () => ({format: 'rgba16float', toneMapping: {mode: 'extended'}}), unconfigure: vi.fn()};
  vi.stubGlobal('document', {createElement: () => ({getContext: () => probe})});
  const surface = new WGPUCanvasSurface({getContext: () => context} as unknown as HTMLCanvasElement, {} as GPUDevice, 'bgra8unorm');
  expect(surface.supportsHDR).toBe(true); expect(configure).toHaveBeenCalledOnce(); expect(surface.hdr).toBe(false);
  surface.configure(true); surface.configure(true); expect(configure).toHaveBeenCalledTimes(2); expect(surface.format).toBe('rgba16float');
  surface.configure(false); expect(surface.format).toBe('bgra8unorm'); expect(configure).toHaveBeenCalledTimes(3); surface.dispose(); expect(unconfigure).toHaveBeenCalledOnce();
});
it('keeps standard presentation when HDR capability detection fails', () => {
  const configure = vi.fn(); vi.stubGlobal('document', {createElement: () => ({getContext: () => null})});
  const surface = new WGPUCanvasSurface({getContext: () => ({configure})} as unknown as HTMLCanvasElement, {} as GPUDevice, 'bgra8unorm');
  surface.configure(true); expect(surface.hdr).toBe(false); expect(configure).toHaveBeenCalledOnce(); surface.dispose();
});
it('leaves the canvas configured when a replaced surface is disposed late', () => {
  const configure = vi.fn(), unconfigure = vi.fn(); const context = {configure, unconfigure};
  const canvas = {getContext: () => context} as unknown as HTMLCanvasElement;
  const first = new WGPUCanvasSurface(canvas, {} as GPUDevice, 'bgra8unorm');
  const second = new WGPUCanvasSurface(canvas, {} as GPUDevice, 'bgra8unorm');
  first.dispose(); expect(unconfigure).not.toHaveBeenCalled();
  second.dispose(); expect(unconfigure).toHaveBeenCalledOnce();
});
