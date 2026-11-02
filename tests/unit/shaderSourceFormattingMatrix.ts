import {afterEach, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {renameShaderIdentifiers} from '../../scripts/shader-identifiers.mjs';
import {makeRayTraceUniform} from '../../src/renderer/WGPURayTracePass';
import {shaderIdentifierMap} from './shaderSourceLoader';
import {rayTrace, compactRayTrace, tokens, gpu} from './shaderSourceFormattingFixture';

afterEach(() => { vi.unstubAllGlobals(); });

// Keep the full matrix in separate files so parsing can run on several workers.
export function testBlasFormatting(masks: number[]) {
  it.each(masks)('preserves tokens, entry points and uniform contracts for BLAS mask %i', blasLayoutMask => {
    gpu();
    for (const hasDisplacement of [false, true]) for (const hasAlpha of [false, true]) for (const hasSceneAlpha of [false, true]) {
      const options = {hasDisplacement, hasAlpha, hasSceneAlpha, blasLayoutMask};
      const source = rayTrace(options);
      const compact = compactRayTrace(options);
      expect(tokens(compact)).toEqual(tokens(source));
      // No selected name may be left behind by a dynamic code path.
      expect(renameShaderIdentifiers(compact, shaderIdentifierMap)).toBe(compact);
      const parsed = makeShaderDataDefinitions(compact);
      expect(Object.keys(parsed.entryPoints).sort()).toEqual(['aovTrace', 'aovTraceCenter', 'depthQuery', 'main']);
      const {buffer, views} = makeRayTraceUniform();
      expect(parsed.uniforms.rtUniform.size).toBe(buffer.byteLength);
      for (const [name, view] of Object.entries(views)) expect(parsed.structs.RayTraceUniform.fields[name]?.offset, name).toBe(view.byteOffset);
      expect(views.loopUnrollGuard[0]).toBe(4);
    }
  }, 30000);
}
