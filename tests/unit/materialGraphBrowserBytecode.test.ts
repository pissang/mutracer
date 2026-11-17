import {afterEach, describe, expect, it, vi} from 'vitest';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import {MaterialGraphState, graphShaderKey, setMaterialGraphPlanner} from '../../src/renderer/materialGraph/state.js';
import {decodeOperand, GRAPH_INSTRUCTION_FLOATS, GRAPH_INTERPRETER_REGISTERS, OperandKind} from '../../src/renderer/materialGraph/interpreter.js';
import {MATERIAL_FLOAT_COUNT, materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';

afterEach(() => { setMaterialGraphPlanner(); vi.unstubAllGlobals(); });

describe('browser interpreter bytecode installation', () => {
    for (const windows of [false, true]) it(`preserves logical programs across natural/universal switches (Windows=${windows})`, () => {
        vi.stubGlobal('navigator', {userAgent: windows ? 'Windows' : 'Macintosh'});
        setMaterialGraphPlanner({policy: {maxUpgradeCompileMs: 1e9}});
        const state = new MaterialGraphState(); state.interpreterAvailable = true;
        const graph = new MaterialGraph({nodes: [
            {id: 'uvNoise', category: 'noise2d', type: 'color3'},
            {id: 'positionNoise', category: 'noise3d', type: 'float'},
            {id: 'frame', category: 'normalmap', type: 'vector3'}
        ], terminal: {baseColor: {node: 'uvNoise'}, specularRoughness: {node: 'positionNoise'}, normal: {node: 'frame'}}});
        state.request([new OpenPBRMaterial({graph})]);
        const natural = graphShaderKey(state.requested), editing = state.editingPlan()!;
        expect(editing).toBeDefined();
        expect(graphShaderKey(editing)).not.toBe(natural);
        // Even an equal family/terminal union must distinguish the two encodings.
        const sameUnion = (state as any).shape([], editing.shape!.interpreter, []);
        if (windows) expect(graphShaderKey(editing)).not.toBe(sameUnion.shaderKey);
        else expect(graphShaderKey(editing)).toBe(sameUnion.shaderKey);
        const programs = [...editing.programs!.values()];
        const logical = programs.flatMap(p => [p.surface, p.opacity, p.emission].flatMap(e => e.instructions));
        const saved = logical.slice(), field = (name: string) => materialLayoutFields().find(f => f.name === name)!.offset / 4;
        const base = new Float32Array(MATERIAL_FLOAT_COUNT);
        expect(state.installShader(natural)).toBe(true);
        const before = state.pack(base, []);
        expect(state.installShader(graphShaderKey(editing))).toBe(true);
        const packed = state.pack(base, []), header = -packed[field('_padding1')];
        expect(header).toBeGreaterThan(0);
        const rows = ['color', 'roughness', 'metallic', 'emission'].map(field);
        const geometry = new Set<number>();
        for (let at = 0; at < logical.length; at += GRAPH_INSTRUCTION_FLOATS) {
            const record = (header + 1 + at / GRAPH_INSTRUCTION_FLOATS) * MATERIAL_FLOAT_COUNT;
            for (let k = 0; k < GRAPH_INSTRUCTION_FLOATS; k++) {
                const code = logical[at + k], actual = packed[record + rows[k >> 2] + (k & 3)];
                if (k >= 4 && code >= 0 && decodeOperand(code).kind === OperandKind.Geometry) {
                    const source = decodeOperand(code), target = decodeOperand(actual); geometry.add(source.index);
                    expect(target).toEqual({...source, kind: windows ? OperandKind.Register : OperandKind.Geometry,
                        index: source.index + (windows ? GRAPH_INTERPRETER_REGISTERS : 0)});
                } else expect(actual).toBe(code);
            }
        }
        expect([...geometry].sort()).toEqual([0, 1, 2, 3, 4]);
        expect(state.installShader(natural)).toBe(true);
        expect(state.pack(base, [])).toEqual(before);
        expect(state.installShader(graphShaderKey(editing))).toBe(true);
        expect(state.pack(base, [])).toEqual(packed);
        expect(programs.flatMap(p => [p.surface, p.opacity, p.emission].flatMap(e => e.instructions))).toEqual(saved);
    });
});
