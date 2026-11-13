import {describe, expect, it} from 'vitest';
import MaterialGraph from '../../src/scene/MaterialGraph.js';
import {normalizeGraph, type NormalizedGraph} from '../../src/renderer/materialGraph/normalize.js';
import {flattenGraph} from '../../src/renderer/materialGraph/flatten.js';
import {generateGraph} from '../../src/renderer/materialGraph/codegen.js';
import {evaluateGraph, evaluateNode, numeric, type GraphContext} from '../../src/renderer/materialGraph/evaluate.js';
import {buildGraphProgram, decodeOperand, GraphOp, GRAPH_INSTRUCTION_FLOATS, GRAPH_INTERPRETER_REGISTERS, OperandKind, runGraphProgram, type GraphProgramEntry} from '../../src/renderer/materialGraph/interpreter.js';
import type {GraphType} from '../../src/renderer/materialGraph/types.js';
import {materialGraphFixtures} from '../../native/validation/material-graph-fixtures.js';
import {MaterialGraphState, setMaterialGraphTier} from '../../src/renderer/materialGraph/state.js';
import {materialGraphShader} from '../../src/renderer/materialGraph/shader.js';
import {MATERIAL_FLOAT_COUNT, materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';

const context: GraphContext = {
    uv: [0.3, 0.7], uv1: [0.6, 0.2], position: [0.4, -0.2, 1.3], objectPosition: [0.1, 0.5, -0.3],
    normal: [0, 0.6, 0.8], tangent: [1, 0, 0], bitangent: [0, 0.8, -0.6]
};
function geometry(name: string) {
    return (context[name as keyof GraphContext] as number[] | undefined) ?? (name === 'texcoord' ? context.uv! : name === 'objectPosition' ? context.objectPosition! : [0, 0, 1]);
}
/** Parameter slots as packed for the GPU, including folded uniform subtrees. */
function slots(graph: NormalizedGraph) {
    return generateGraph(graph).parameters.map(value => value === undefined || value === '' ? [-1] : numeric(value));
}
function run(graph: NormalizedGraph, entry: GraphProgramEntry) {
    const parameters = slots(graph);
    return runGraphProgram(entry, slot => parameters[slot], geometry,
        (category, type, inputs) => evaluateNode({id: '', category, type: type as GraphType, inputs: {}}, inputs, context));
}
function expectClose(actual: Record<string, number[]>, expected: Record<string, number[]>, label: string) {
    expect(Object.keys(actual).sort(), label).toEqual(Object.keys(expected).sort());
    for (const [name, value] of Object.entries(expected)) value.forEach((x, i) => {
        const y = actual[name][i];
        if (Number.isNaN(x)) expect(y, `${label} ${name}[${i}]`).toBeNaN();
        else if (!Number.isFinite(x)) expect(y, `${label} ${name}[${i}]`).toBe(x);
        else expect(Math.abs(y - x), `${label} ${name}[${i}] ${y} vs ${x}`).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(x)));
    });
}

describe('material graph interpreter programs', () => {
    it('matches evaluateGraph for every supported category/type combination', () => {
        const fixtures = materialGraphFixtures();
        expect(fixtures.length).toBeGreaterThan(150);
        for (const {label, graph} of fixtures) {
            const built = buildGraphProgram(flattenGraph(graph));
            expect(built.reason, label).toBeUndefined();
            const program = built.program!;
            const expected = evaluateGraph(graph, context);
            const surface = Object.fromEntries(Object.entries(expected).filter(([name]) => name !== 'opacity'));
            expectClose(run(graph, program.surface), surface, label);
            if ('opacity' in expected) expectClose(run(graph, program.opacity), {opacity: expected.opacity}, label);
        }
    });

    it('prunes entries and folds uniform subtrees into the codegen parameter slots', () => {
        const graph = normalizeGraph(new MaterialGraph({nodes: [
            {id: 'uv', category: 'texcoord', type: 'vector2'},
            {id: 'x', category: 'extract', type: 'float', inputs: {in: {type: 'vector2', connection: {node: 'uv'}}, index: {type: 'integer', value: 0}}},
            {id: 'k', category: 'multiply', type: 'float', inputs: {in1: {type: 'float', value: 2}, in2: {type: 'float', value: 3}}},
            {id: 'scaled', category: 'multiply', type: 'float', inputs: {in1: {type: 'float', connection: {node: 'x'}}, in2: {type: 'float', connection: {node: 'k'}}}},
            {id: 'glow', category: 'multiply', type: 'color3', inputs: {in1: {type: 'color3', value: [1, 0.5, 0.25]}, in2: {type: 'float', connection: {node: 'x'}}}}
        ], terminal: {opacity: {node: 'scaled'}, emissionColor: {node: 'glow'}, specularRoughness: {node: 'k'}}}));
        const {program} = buildGraphProgram(flattenGraph(graph));
        const ops = (entry: GraphProgramEntry) => Array.from({length: entry.instructions.length / GRAPH_INSTRUCTION_FLOATS}, (_, i) => entry.instructions[i * GRAPH_INSTRUCTION_FLOATS]);
        expect(program!.opacity.terminals).toEqual(['opacity']);
        expect(program!.emission.terminals).toEqual(['emissionColor']);
        expect(program!.surface.terminals.sort()).toEqual(['emissionColor', 'specularRoughness']);
        // texcoord, extract, multiply + store; the folded constant is not an instruction.
        expect(ops(program!.opacity)).toEqual([GraphOp.Geometry, GraphOp.Extract, GraphOp.Binary, GraphOp.Store]);
        const foldedStore = program!.surface.instructions.slice(0, GRAPH_INSTRUCTION_FLOATS);
        expect(foldedStore[0]).toBe(GraphOp.Store);
        const operand = decodeOperand(foldedStore[4]);
        expect(operand.kind).toBe(OperandKind.Parameter);
        expect(slots(graph)[operand.index]).toEqual([6]);
        expectClose(run(graph, program!.surface), {emissionColor: evaluateGraph(graph, context).emissionColor, specularRoughness: [6]}, 'surface');
    });

    it('reuses registers by liveness and rejects structures beyond the register file', () => {
        // A chain needs one register regardless of its length.
        const nodes = [{id: 'n0', category: 'texcoord', type: 'vector2' as const}];
        for (let i = 1; i < 40; i++) nodes.push({id: `n${i}`, category: 'multiply', type: 'vector2', inputs: {in1: {type: 'vector2', connection: {node: `n${i - 1}`}}, in2: {type: 'float', value: 1.01}}} as never);
        const chain = normalizeGraph(new MaterialGraph({nodes: [...nodes, {id: 'c', category: 'convert', type: 'color3', inputs: {in: {type: 'vector2', connection: {node: 'n39'}}}}], terminal: {baseColor: {node: 'c'}}}));
        expect(buildGraphProgram(flattenGraph(chain)).program!.registers).toBe(1);
        // A balanced sum tree of 2^k leaves keeps k + 1 values live.
        const leaves = 2 ** (GRAPH_INTERPRETER_REGISTERS + 1);
        const tree = [{id: 'uv', category: 'texcoord', type: 'vector2'}] as never[];
        for (let i = 0; i < leaves; i++) tree.push({id: `l0_${i}`, category: 'extract', type: 'float', inputs: {in: {type: 'vector2', connection: {node: 'uv'}}, index: {type: 'integer', value: i % 2}}} as never);
        let width = leaves, level = 0;
        for (; width > 1; level++, width /= 2) for (let i = 0; i < width / 2; i++)
            tree.push({id: `l${level + 1}_${i}`, category: 'add', type: 'float', inputs: {in1: {type: 'float', connection: {node: `l${level}_${2 * i}`}}, in2: {type: 'float', connection: {node: `l${level}_${2 * i + 1}`}}}} as never);
        const wide = normalizeGraph(new MaterialGraph({nodes: tree, terminal: {specularRoughness: {node: `l${level}_0`}}}));
        expect(wide.diagnostics).toEqual([]);
        const result = buildGraphProgram(flattenGraph(wide));
        expect(result.reason).toMatch(/registers/);
        expect(buildGraphProgram(flattenGraph(wide), 64).program!.registers).toBeLessThanOrEqual(level + 2);
    });

    it('packs programs behind negative topology IDs and keeps one shader key across structure sets', () => {
        const field = (name: string) => materialLayoutFields().find(f => f.name === name)!.offset / 4;
        const graph = (k: number, unary: string) => new MaterialGraph({nodes: [
            {id: 'uv', category: 'texcoord', type: 'vector2'},
            {id: 'x', category: 'extract', type: 'float', inputs: {in: {type: 'vector2', connection: {node: 'uv'}}, index: {type: 'integer', value: 0}}},
            {id: 'f', category: unary, type: 'float', inputs: {in: {type: 'float', connection: {node: 'x'}}}},
            {id: 'r', category: 'multiply', type: 'float', inputs: {in1: {type: 'float', connection: {node: 'f'}}, in2: {type: 'float', value: k}}}
        ], terminal: {specularRoughness: {node: 'r'}}});
        setMaterialGraphTier('interpreter');
        try {
            const state = new MaterialGraphState();
            const first = [new OpenPBRMaterial({graph: graph(0.5, 'sin')}), new OpenPBRMaterial({graph: graph(0.25, 'cos')}), new OpenPBRMaterial()];
            state.request(first);
            state.install(state.requested, state.revision);
            const plan = state.active, shaderKey = plan.shaderKey;
            expect(plan.programs?.size).toBe(2);
            expect(plan.specialized).toEqual([]);
            const source = materialGraphShader(plan).graph!;
            expect(source.interpreter).toBe(true);
            expect(source.declarations).not.toContain('mx_eval_');
            const packed = state.pack(new Float32Array(3 * MATERIAL_FLOAT_COUNT), []);
            const id = (i: number) => packed[i * MATERIAL_FLOAT_COUNT + field('_padding1')];
            expect(id(0)).toBeLessThan(0);
            expect(id(1)).toBeLessThan(0);
            expect(id(0)).not.toBe(id(1));
            expect(id(2)).toBe(0);
            // The header counts surface instructions; its records follow it.
            const header = -id(0) * MATERIAL_FLOAT_COUNT;
            const count = packed[header + field('color')];
            expect(count).toBe(plan.programs!.get(plan.graphs[0]!.key)!.surface.instructions.length / GRAPH_INSTRUCTION_FLOATS);
            expect(packed[header + field('color') + 1]).toBe(0);
            const last = header + count * MATERIAL_FLOAT_COUNT;
            expect(packed[last + field('color')]).toBe(GraphOp.Store);
            expect(packed.length).toBeGreaterThanOrEqual(last + MATERIAL_FLOAT_COUNT);
            // A different structure set with the same terminals needs no new shader.
            state.request([new OpenPBRMaterial({graph: graph(0.5, 'abs')}), new OpenPBRMaterial({graph: graph(0.5, 'floor')})]);
            expect(state.requested.key).not.toBe(plan.key);
            expect(state.requested.shaderKey).toBe(shaderKey);
        } finally { setMaterialGraphTier('specialized'); }
    });

    it('keeps specialized variants unchanged by default', () => {
        const state = new MaterialGraphState();
        state.request([new OpenPBRMaterial({graph: new MaterialGraph({nodes: [{id: 'uv', category: 'texcoord', type: 'vector2'}, {id: 'x', category: 'extract', type: 'float', inputs: {in: {type: 'vector2', connection: {node: 'uv'}}, index: {type: 'integer', value: 0}}}], terminal: {specularRoughness: {node: 'x'}}})})]);
        expect(state.requested.programs?.size).toBe(0);
        expect(state.requested.shaderKey).toBe(state.requested.key);
        const source = materialGraphShader(state.requested).graph!;
        expect(source.interpreter).toBeUndefined();
        expect(source.declarations).not.toContain('mx_run');
    });
});
