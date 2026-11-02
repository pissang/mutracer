import { describe, expect, it } from 'vitest';
import createRayTraceFragmentShader from '../../src/renderer/glsl/rayTrace.frag';
import { aovTraceFragment } from '../../src/renderer/glsl/aovTrace.frag';
import shadowCatcherFrag from '../../src/renderer/glsl/shadowCatcher.frag';
import depthQueryFrag from '../../src/renderer/glsl/depthQuery.frag';
import type { FragmentShader } from '../../src/renderer/shader';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import { packVertexAttributes, vertexAttributeDefines, vertexAttributeLayout } from '../../src/renderer/webglVertexAttributes';

// WebGL 2 guarantees 16 fragment texture units. Keep two in reserve for new features.
const SAMPLER_BUDGET = 14;

// Samplers referenced anywhere in the source, ignoring preprocessor conditions,
// bound the active samplers of every define combination.
function referencedSamplers(shader: FragmentShader) {
  const source = shader.main + shader.functions.map((fn) => fn()).join('\n');
  return Object.entries(shader.uniforms)
    .filter(([, uniform]) => uniform.type.includes('sampler'))
    .map(([name]) => name)
    .filter((name) => new RegExp(`\\b${name}\\b`).test(source));
}

describe('WebGL trace pass sampler budget', () => {
  it.each([
    ['rayTrace', createRayTraceFragmentShader()],
    ['AOV accumulation', aovTraceFragment(false)],
    ['AOV center', aovTraceFragment(true)],
    ['shadow catcher', shadowCatcherFrag],
    ['depth query', depthQueryFrag]
  ] as [string, FragmentShader][])('%s fits with every feature enabled', (_, shader) => {
    expect(referencedSamplers(shader).length).toBeLessThanOrEqual(SAMPLER_BUDGET);
  });
});

describe('WebGL vertex attribute packing', () => {
  const geometry = (optional: boolean) => new Geometry({
    position: new Attribute(new Float32Array(6), 3),
    normal: new Attribute(new Float32Array([0, 0, 1, 0, 1, 0]), 3),
    uv: new Attribute(new Float32Array([0.25, 0.5, 0.75, 1]), 2),
    materialIndex: new Attribute(new Int32Array([1, 2, 3, 0, 4, 5, 6, 0]), 4),
    ...(optional ? {
      tangent: new Attribute(new Float32Array([1, 0, 0, -1, 0, 0, 1, 1]), 4),
      color: new Attribute(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), 3),
      uv1: new Attribute(new Float32Array([2, 3, 4, 5]), 2)
    } : {})
  });

  it('interleaves the base attributes in two texels', () => {
    const base = geometry(false), layout = vertexAttributeLayout(base);
    expect(vertexAttributeDefines(layout)).toMatchObject({ VERTEX_ATTRIBUTE_STRIDE: 2, USE_UV1: false });
    expect(Array.from(packVertexAttributes(base, layout, new Float32Array(16)))).toEqual([
      0, 0, 1, 1, 0.25, 0.5, 2, 3,
      0, 1, 0, 4, 0.75, 1, 5, 6
    ]);
  });

  it('appends optional attributes and repacks a vertex range', () => {
    const full = geometry(true), layout = vertexAttributeLayout(full);
    expect(layout).toEqual({ stride: 5, tangent: 2, color: 3, uv1: 4 });
    const out = packVertexAttributes(full, layout, new Float32Array(40));
    expect(Array.from(out.subarray(20, 40))).toEqual([
      0, 1, 0, 4, 0.75, 1, 5, 6,
      0, 0, 1, 1, Math.fround(0.4), Math.fround(0.5), Math.fround(0.6), 0, 4, 5, 0, 0
    ]);
    full.uv1!.array[2] = 9;
    out.fill(-1, 0, 20);
    packVertexAttributes(full, layout, out, 1, 1);
    expect(out[36]).toBe(9);
    expect(out[0]).toBe(-1);
  });
});
