import {describe, expect, it} from 'vitest';
import {original, stripped, gpu} from './shaderSourceFormattingFixture';
import {materialGraphShaderIR} from '../../src/renderer/materialGraph/specialize.js';

describe('empty material shader hooks', () => {
  it.each([original, stripped])('preserves default ray-tracing bytes across feature combinations (%#)', loader => {
    gpu();
    const generate = loader('src/renderer/wgsl/rayTrace.compute.ts').default;
    for (let bits = 0; bits < 256; bits++) {
      const [compactVertices, hasAnisotropyDirections, hasCoatNormals, hasAlpha, hasSceneAlpha, spectral, shareSpectralPrefix, displayAovStorage] =
        Array.from({length: 8}, (_, i) => !!(bits & (1 << i)));
      const options = {hasDisplacement: false, compactVertices, hasAnisotropyDirections, hasCoatNormals,
        hasAlpha, hasSceneAlpha, spectral, shareSpectralPrefix, displayAovStorage};
      const source = generate(options);
      expect(generate({...options, materialHooks: {}})).toBe(source);
      expect(generate({...options, materialHooks: materialGraphShaderIR([])})).toBe(source);
    }
  });
  it.each([original, stripped])('preserves default emitter bytes across feature combinations (%#)', loader => {
    gpu();
    const {causticLightCompute} = loader('src/renderer/wgsl/causticLight.compute.ts');
    for (const mode of ['lightTracing', 'photonMapping']) for (let bits = 0; bits < 64; bits++) {
      const [compact, frames, coat, independent, bounds, displacement] = Array.from({length: 6}, (_, i) => !!(bits & (1 << i)));
      const constants = {NUM_MAPS: 1, NUM_UNIFORM_LIGHTS: 1, TLAS_STACK_SIZE: 8, BLAS_STACK_SIZE: 32,
        USE_ANISOTROPY_DIRECTIONS: frames, USE_COAT_NORMAL_FRAMES: coat};
      const args = [constants, 15, displacement, mode, '', true, bounds, compact, independent, true];
      expect(causticLightCompute(...args, {})).toBe(causticLightCompute(...args));
      expect(causticLightCompute(...args, materialGraphShaderIR([]))).toBe(causticLightCompute(...args));
    }
  });
});
