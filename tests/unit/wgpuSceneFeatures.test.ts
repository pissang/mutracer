import { samplingPatternCode, type SamplingPattern } from '../../src/renderer/sampling';
import { describe, expect, it, vi } from 'vitest';
import { makeShaderDataDefinitions } from 'webgpu-utils';
import { WGPU_SCENE_FEATURE_BITS, wgpuSceneFeatureFlags } from '../../src/renderer/WGPUSceneFeatures';
import { makeRayTraceUniform } from '../../src/renderer/WGPURayTracePass';
import rayTraceCompute from '../../src/renderer/wgsl/rayTrace.compute';

describe('WebGPU ray-trace uniforms', () => {
  it('updates independently addressable scene feature bits', () => {
    const features = Object.keys(WGPU_SCENE_FEATURE_BITS);
    const all = Object.fromEntries(features.map(name => [name, true]));
    const enabled = wgpuSceneFeatureFlags(all);
    for (const name of features) {
      const disabled = wgpuSceneFeatureFlags({ ...all, [name]: false });
      expect(enabled ^ disabled).toBe(WGPU_SCENE_FEATURE_BITS[name]);
    }
    expect(wgpuSceneFeatureFlags({})).toBe(0);
  });

  it.each(['sobol', 'zsobol', 'random'] as SamplingPattern[])('matches CPU uniforms for the generated %s WGSL shader', pattern => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    try {
      const definitions = makeShaderDataDefinitions(
        `override SAMPLING_PATTERN: u32 = ${samplingPatternCode(pattern)}u;\n` +
        rayTraceCompute({ hasDisplacement: false })
      );
      const struct = definitions.structs.RayTraceUniform;
      const { buffer, views } = makeRayTraceUniform();
      expect(definitions.uniforms.rtUniform.size).toBe(buffer.byteLength);
      for (const [name, view] of Object.entries(views)) {
        expect(struct.fields[name]?.offset, name).toBe(view.byteOffset);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
