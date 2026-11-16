import {afterEach, describe, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {original, stripped, tokens, gpu} from './shaderSourceFormattingFixture';
import {terminalTypes} from '../../src/renderer/materialGraph/nodes';
import {GraphOp} from '../../src/renderer/materialGraph/interpreter';
import {universalEditingConstants} from '../../src/renderer/wgpuEditingVariant';
import {makeRayTraceUniform} from '../../src/renderer/wgpuSceneUniform';

afterEach(() => { vi.unstubAllGlobals(); });

function generate(loader: typeof original, hasDisplacement: boolean, maxPathEvents = 50, unifiedEditingQueries = true, bevel = false): string {
    gpu();
    const families = new Set(Object.values(GraphOp).filter((op): op is GraphOp => typeof op === 'number'));
    const hooks = loader('src/renderer/materialGraph/specialize.ts').materialGraphShaderIR([], true,
        {terminals: Object.keys(terminalTypes), families, opacity: families, emission: families, operandLoop: true}, true);
    hooks.graph.textureLoop = true;
    return loader('src/renderer/wgpuShaderSource.ts').wgpuShaderSource(universalEditingConstants({HAS_BEVEL: bevel}), {
        materialHooks: {...hooks, materialXNormals: true}, hasDisplacement, maxPathEvents,
        hasAnisotropyDirections: true, hasCoatNormals: true, hasAlpha: false, hasSceneAlpha: true,
        blasLayoutMask: 1, compactVertices: true, runtimeVertexLayout: true,
        perInstanceBounds: true, cameraProjectionInverse: true, analyticLightStorage: true, emissiveInstanceIndices: true, unifiedEditingQueries
    }, true);
}

describe('unified editing query generation', () => {
    for (const unified of [false, true]) for (const bevel of [false, true]) for (const displacement of [false, true]) {
      it(`preserves production generation (queries=${unified}, bevel=${bevel}, displacement=${displacement})`, () => {
        const full = generate(original, displacement, 50, unified, bevel), compact = generate(stripped, displacement, 50, unified, bevel);
        expect(tokens(compact)).toEqual(tokens(full));
        const parsed = makeShaderDataDefinitions(compact);
        expect(Object.keys(parsed.entryPoints).sort()).toEqual(['aovTrace', 'aovTraceCenter', 'depthQuery', 'main']);
        expect(parsed.uniforms.rtUniform.size).toBe(makeRayTraceUniform(true).buffer.byteLength);
        expect(parsed.uniforms.cameraUniform.size).toBe(208);
        const values = makeShaderDataDefinitions(full.replace(/struct\s+\w+\s*\{[^}]*\}/g, text => text.replace(/\bbool\b/g, 'u32')));
        expect(values.structs.SurfaceInteraction.size).toBe(272);
        expect(values.structs.OpenPbrPreparedBsdf.size).toBe(736);
        expect(values.structs.Path.size).toBe(96);
        if (unified) {
          expect(values.structs.MaterialQueryState.size).toBe(768);
          expect(values.structs.PendingSceneQuery.size).toBe(80);
          expect(values.structs.CatcherQueryState.size).toBe(16);
        }
        const direct = makeShaderDataDefinitions(generate(original, displacement, 50, false, bevel));
        expect(parsed.uniforms).toEqual(direct.uniforms);
        expect(parsed.storages).toEqual(direct.storages);
      });
    }

    it.each([false, true].flatMap(unified => [0, 1, 20].map(max => ({unified, max}))))('respects host path-event bound $max (queries=$unified) without changing bindings', ({unified, max}) => {
        const compact = generate(stripped, true, max, unified);
        expect(makeShaderDataDefinitions(compact).entryPoints.main).toBeDefined();
        // A separate bound must generate a different program, without changing bindings.
        const full = generate(stripped, true, 50, unified);
        expect(compact).not.toEqual(full);
        expect(makeShaderDataDefinitions(compact).uniforms).toEqual(makeShaderDataDefinitions(full).uniforms);
    });

    it('keeps only scene-dependent bevel in the universal source contract', () => {
      const base = universalEditingConstants({HAS_BEVEL: false, BEVEL_SAMPLES: 4});
      expect(base.HAS_BEVEL).toBe(false);
      expect(universalEditingConstants({HAS_BEVEL: true, BEVEL_SAMPLES: 4})).toEqual({...base, HAS_BEVEL: true});
      expect(universalEditingConstants({BEVEL_SAMPLES: 16})).toEqual({...base, BEVEL_SAMPLES: 16});
      expect(base.HAS_ALPHA).toBe(true);
      expect(base.HAS_SHADOW_CATCHER).toBe(true);
      expect(base.USE_COAT_NORMAL_FRAMES).toBe(true);
    });
});
