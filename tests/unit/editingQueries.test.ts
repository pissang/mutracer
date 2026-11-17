import {afterEach, describe, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {original, stripped, tokens, gpu} from './shaderSourceFormattingFixture';
import {terminalTypes} from '../../src/renderer/materialGraph/nodes';
import {GraphOp} from '../../src/renderer/materialGraph/interpreter';
import {universalEditingConstants} from '../../src/renderer/wgpuEditingVariant';
import {makeRayTraceUniform} from '../../src/renderer/wgpuSceneUniform';

afterEach(() => { vi.unstubAllGlobals(); });

function generate(loader: typeof original, hasDisplacement: boolean, maxPathEvents = 50, unifiedEditingQueries = true, bevel = false, samplingPattern = 0): string {
    gpu();
    const families = new Set(Object.values(GraphOp).filter((op): op is GraphOp => typeof op === 'number'));
    const hooks = loader('src/renderer/materialGraph/specialize.ts').materialGraphShaderIR([], true,
        {terminals: Object.keys(terminalTypes), families, opacity: families, emission: families, operandLoop: true, vectorCells: true, flatPerlin: true}, true);
    hooks.graph.textureLoop = true;
    return loader('src/renderer/wgpuShaderSource.ts').wgpuShaderSource(universalEditingConstants({HAS_BEVEL: bevel, SAMPLING_PATTERN: samplingPattern}), {
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
          expect(values.structs.MaterialQueryState.size).toBe(96);
          expect(values.structs.ScatteringWork.size).toBe(48);
          expect(values.structs.PendingSceneQuery.size).toBe(80);
          expect(values.structs.CatcherQueryState.size).toBe(16);
        }
        const direct = makeShaderDataDefinitions(generate(original, displacement, 50, false, bevel));
        expect(parsed.uniforms).toEqual(direct.uniforms);
        expect(parsed.storages).toEqual(direct.storages);
      });
    }

    it.each([false, true])('preserves complete value contracts across query storage forms (displacement=%s)', displacement => {
      const definitions = (unified: boolean) => makeShaderDataDefinitions(
        generate(original, displacement, 50, unified, true).replace(/struct\s+\w+\s*\{[^}]*\}/g,
          text => text.replace(/\bbool\b/g, 'u32')));
      const direct = definitions(false), editing = definitions(true);
      for (const name of ['SurfaceInteraction', 'OpenPbrResolvedMaterial', 'OpenPbrPreparedBsdf', 'Path']) {
        expect(editing.structs[name], name).toEqual(direct.structs[name]);
      }
      expect(editing.uniforms).toEqual(direct.uniforms);
      expect(editing.storages).toEqual(direct.storages);
    });

    it.each([0, 1, 2])('preserves sampler %i continuation layouts and production bindings', samplingPattern => {
      const full = generate(original, true, 50, true, true, samplingPattern);
      const compact = generate(stripped, true, 50, true, true, samplingPattern);
      expect(tokens(compact)).toEqual(tokens(full));
      const definitions = (source: string) => makeShaderDataDefinitions(source.replace(
        /struct\s+\w+\s*\{[^}]*\}/g, text => text.replace(/\bbool\b/g, 'u32')));
      const values = definitions(full);
      expect(values.structs.MaterialQueryState.size).toBe(samplingPattern === 2 ? 768 : 96);
      expect(values.structs.ScatteringWork.size).toBe(48);
      expect(values.structs.OpenPbrPreparedBsdf.size).toBe(736);
      const direct = definitions(generate(original, true, 50, false, true, samplingPattern));
      expect(values.uniforms).toEqual(direct.uniforms);
      expect(values.storages).toEqual(direct.storages);
    });

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
