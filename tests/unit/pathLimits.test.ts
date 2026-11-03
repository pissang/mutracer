import { describe, expect, it, vi } from 'vitest';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
import {writeTraceQuality} from '../../src/renderer/sceneAssembly';
import {makeRayTraceUniform} from '../../src/renderer/wgpuSceneUniform';
import { MAX_PATH_EVENTS_WGPU, MAX_PATH_EVENTS_WEBGL, normalizeBounces } from '../../src/renderer/pathLimits';

describe('backend path depth normalization', () => {
  it.each([[0, 1], [-3, 1], [2.5, 3], [NaN, 1], [64, 20], [Infinity, 20], [-Infinity, 1],
    [1, 1], [3, 3], [6, 6], [7, 7], [20, 20], [21, 20], [49, 20], [50, 20]])('normalizes %s to %s in both backend setters and preview quality', (input, expected) => {
    const gpuExpected = Math.min(50, Math.max(1, Number.isNaN(input!) ? 1 : Math.round(input!)));
    expect(normalizeBounces(input!, MAX_PATH_EVENTS_WGPU)).toBe(gpuExpected);
    expect(normalizeBounces(input!, MAX_PATH_EVENTS_WEBGL)).toBe(expected);
    const gpu = Object.create(WGPURayTracePass.prototype) as any;
    gpu._bounces = -1;
    gpu._rtUniform = { views: { bounces: new Int32Array(1), bevel: new Int32Array(1),
      dispersionWavelengths: new Int32Array(1), directLightCandidates: new Int32Array(1) } };
    const gl = Object.create(WebGLRayTracePass.prototype) as any;
    gl._bounces = -1;
    const pass = { setUniform: vi.fn() };
    gl._tracePasses = [pass];
    expect(gpu.setBounce(input)).toBe(true);
    expect(gl.setBounce(input)).toBe(true);
    expect(gpu._bounces).toBe(gpuExpected);
    expect(gl._bounces).toBe(expected);
    expect(gpu.setBounce(input)).toBe(false);
    expect(gl.setBounce(input)).toBe(false);
    const quality = { bounces: input, bevel: false, dispersionWavelengths: 1, directLightCandidates: 4 };
    gpu.setQuality(quality);
    gl.setQuality(quality);
    expect(gpu._rtUniform.views.bounces[0]).toBe(gpuExpected);
    expect(pass.setUniform).toHaveBeenCalledWith('bounceLimit', expected);
  });
});

it('keeps the shared AOT quality default at 20 while WebGPU opts into 50', () => {
  const {views} = makeRayTraceUniform();
  const quality = {bounces: 100, bevel: false, dispersionWavelengths: 3 as const, directLightCandidates: 4};
  expect(normalizeBounces(100)).toBe(20);
  writeTraceQuality(views, quality);
  expect(views.bounces[0]).toBe(20);
  writeTraceQuality(views, quality, MAX_PATH_EVENTS_WGPU);
  expect(views.bounces[0]).toBe(50);
  expect(views.loopUnrollGuard[0]).toBe(4);
});
