import { describe, it, expect } from 'vitest';
import MaterialGraph, { type MaterialGraphNode, type MaterialGraphInput } from '../../src/scene/MaterialGraph.js';
import { normalizeGraph } from '../../src/renderer/materialGraph/normalize.js';
import { evaluateGraph } from '../../src/renderer/materialGraph/evaluate.js';
import { generateGraph } from '../../src/renderer/materialGraph/codegen.js';
import { materialGraphShader } from '../../src/renderer/materialGraph/shader.js';
import { MaterialGraphState } from '../../src/renderer/materialGraph/state.js';
import {MATERIAL_FLOAT_COUNT} from '../../src/renderer/materialLayoutSchema.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
const f = (value: number): MaterialGraphInput => ({ type: 'float', value });
const v = (value: number[]): MaterialGraphInput => ({ type: value.length === 2 ? 'vector2' : value.length === 3 ? 'vector3' : 'vector4', value });
function run(category: string, inputs: Record<string, MaterialGraphInput>, type: MaterialGraphNode['type'] = 'float', output = 'out') {
    const nodes: MaterialGraphNode[] = [{ id: 'test', category, type, inputs }];
    if (type === 'vector2') {
        nodes.push({id:'converted',category:'convert',type:'color3',inputs:{in:{type:'vector2',connection:{node:'test',output}}}});
        return normalizeGraph(new MaterialGraph({nodes,terminal:{baseColor:{node:'converted'}}}));
    }
    return normalizeGraph(new MaterialGraph({ nodes, terminal: { [type === 'vector3' ? 'normal' : 'specularRoughness']: { node: 'test', output } } }));
}
describe('MaterialX numeric semantics', () => {
    it.each([
        ['add', { in1: f(0.2), in2: f(0.6) }, 0.8], ['subtract', { in1: f(0.8), in2: f(0.6) }, 0.2],
        ['multiply', { in1: f(2), in2: f(3) }, 6], ['divide', { in1: f(8), in2: f(4) }, 2],
        ['modulo', { in1: f(-1.5), in2: f(1) }, 0.5], ['power', { in1: f(2), in2: f(3) }, 8],
        ['min', { in1: f(2), in2: f(3) }, 2], ['max', { in1: f(2), in2: f(3) }, 3],
        ['mix', { fg: f(4), bg: f(2), mix: f(0.25) }, 2.5], ['clamp', { in: f(4), low: f(1), high: f(2) }, 2],
        ['ifgreater', { value1: f(2), value2: f(1), in1: f(5), in2: f(8) }, 5],
        ['ifequal', { value1: f(2), value2: f(2), in1: f(5), in2: f(8) }, 5],
        ['sin', { in: f(Math.PI / 2) }, 1], ['cos', { in: f(Math.PI) }, -1], ['sqrt', { in: f(9) }, 3],
        ['abs', { in: f(-2) }, 2], ['floor', { in: f(-1.2) }, -2], ['ceil', { in: f(-1.2) }, -1],
        ['round', { in: f(0.7) }, 1], ['sign', { in: f(-2) }, -1], ['exp', { in: f(0) }, 1], ['ln', { in: f(1) }, 0],
    ] as const)('%s follows stdlib arithmetic', (category, inputs, expected) => {
        const graph = run(category, inputs);
        expect(graph.diagnostics).toEqual([]);
        expect(evaluateGraph(graph).specularRoughness[0]).toBeCloseTo(expected, 10);
        for (const backend of ['webgpu', 'webgl'] as const) {
            const generated = generateGraph(graph, backend);
            expect(generated.foldedNodes).toBe(1);
            expect(generated.parameters.at(-1)).toBeDefined();
        }
    });
    it('uses divide/rotate/subtract placement, including TRS', () => {
        const graph = run('place2d', { texcoord: v([4, 2]), scale: v([2, 1]), rotate: f(90), offset: v([1, 0]) }, 'vector2');
        const result = evaluateGraph(graph).baseColor;
        expect(result[0]).toBeCloseTo(-3);
        expect(result[1]).toBeCloseTo(2);
        graph.parameters[graph.nodes[0].inputs.operationorder.slot!] = 1;
        expect(evaluateGraph(graph).baseColor[0]).toBeCloseTo(-1);
        expect(evaluateGraph(graph).baseColor[1]).toBeCloseTo(3);
    });
    it('normalmap black uses the geometric normal; scale affects XY only', () => {
        const black = run('normalmap', { in: v([0, 0, 0]) }, 'vector3');
        expect(evaluateGraph(black).normal).toEqual([0, 0, 1]);
        const tilted = run('normalmap', { in: v([1, 0.5, 1]), scale: f(2) }, 'vector3');
        const normal = evaluateGraph(tilted).normal;
        expect(normal[0]).toBeCloseTo(2 / Math.sqrt(5));
        expect(normal[2]).toBeCloseTo(1 / Math.sqrt(5));
    });
    it('emits deterministic sources independent of parameter values', () => {
        const graph = run('multiply', { in1: f(0.4), in2: f(0.5) });
        const changed = { ...graph, parameters: [2, 3] };
        for (const backend of ['webgpu', 'webgl'] as const)
            expect(generateGraph(graph, backend).source).toBe(generateGraph(changed, backend).source);
        const division=run('divide',{in1:f(1),in2:f(2)});
        const singular={...division,parameters:[1,0]};
        for(const backend of ['webgpu','webgl'] as const)expect(generateGraph(division,backend).source).toBe(generateGraph(singular,backend).source);
        expect(materialGraphShader('unchanged', { key: '', graphs: [], structures: [] }, 'webgpu')).toBe('unchanged');
    });
    it('merges repeated expressions without aliasing independent parameters',()=>{
        const input={type:'float' as const,connection:{node:'parts',output:'outx'}};
        const graph=normalizeGraph(new MaterialGraph({nodes:[
            {id:'uv',category:'texcoord',type:'vector2'},
            {id:'parts',category:'separate2',type:'vector2',inputs:{in:{type:'vector2',connection:{node:'uv'}}}},
            {id:'a',category:'multiply',type:'float',inputs:{in1:input,in2:input}},
            {id:'b',category:'multiply',type:'float',inputs:{in1:input,in2:input}}
        ],terminal:{specularRoughness:{node:'a'},fuzzRoughness:{node:'b'}}}));
        expect(graph.diagnostics).toEqual([]);
        for(const backend of ['webgpu','webgl'] as const)expect(generateGraph(graph,backend).commonExpressions).toBeGreaterThan(0);
        expect(evaluateGraph(graph,{uv:[0.4,0.6]}).specularRoughness[0]).toBeCloseTo(0.16);
    });
    it('locates unsupported emissive-surface semantics while preserving fallback',()=>{
        const graph=new MaterialGraph({nodes:[{id:'color',category:'constant',type:'color3'}],terminal:{emissionColor:{node:'color'}}});
        const state=new MaterialGraphState('webgpu');state.request([new OpenPBRMaterial({graph})]);
        expect(state.status).toBe('failed');expect(state.diagnostics[0].code).toBe('unsupported-emission-graph');expect(state.active.key).toBe('');
    });
    it('installs valid materials even when another material graph is unsupported',()=>{
        const valid=new MaterialGraph({nodes:[{id:'a',category:'constant',type:'float'}],terminal:{specularRoughness:{node:'a'}}});
        const invalid=new MaterialGraph({nodes:[{id:'bad',category:'noise3d',type:'float'}],terminal:{specularRoughness:{node:'bad'}}});
        const state=new MaterialGraphState('webgpu');state.request([new OpenPBRMaterial({graph:valid}),new OpenPBRMaterial({graph:invalid})]);
        expect(state.status).toBe('compiling');expect(state.requested.structures).toHaveLength(1);
        expect(state.install(state.requested,state.revision)).toBe(true);expect(state.active.graphs[0]).toBeDefined();expect(state.active.graphs[1]).toBeUndefined();expect(state.status).toBe('failed');
    });
    it('does not report a rejected authored graph as installed',()=>{
        const graph=new MaterialGraph({nodes:[{id:'a',category:'constant',type:'float'}],terminal:{specularRoughness:{node:'a'}}});
        const material=new OpenPBRMaterial({graph}),state=new MaterialGraphState('webgpu');
        state.request([material]);state.install(state.requested,state.revision);const installed=state.installedRevision;
        graph.setNode({id:'a',category:'noise3d',type:'float'});state.request([material]);
        expect(state.status).toBe('failed');expect(state.installedRevision).toBe(installed);expect(state.revision).toBeGreaterThan(installed);expect(state.diagnostics[0].materialId).toBe(material.aovId);
    });
    it('uses constants when a previously valid graph enters an unsupported material context',()=>{
        const graph=new MaterialGraph({nodes:[{id:'c',category:'constant',type:'color3'}],terminal:{emissionColor:{node:'c'}}});
        const material=new OpenPBRMaterial({graph,unlit:true}),state=new MaterialGraphState('webgpu');state.request([material]);state.install(state.requested,state.revision);
        expect(state.pack(new Float32Array(MATERIAL_FLOAT_COUNT),[]).length).toBeGreaterThan(MATERIAL_FLOAT_COUNT);
        material.unlit=false;state.request([material]);
        expect(state.requested.graphs[0]).toBeUndefined();expect(state.diagnostics[0].code).toBe('unsupported-emission-graph');
        expect(state.pack(new Float32Array(MATERIAL_FLOAT_COUNT),[])).toEqual(new Float32Array(MATERIAL_FLOAT_COUNT));
    });
    it('keeps old parameters through compilation and rejects obsolete revisions', () => {
        const state = new MaterialGraphState('webgpu'), a = new MaterialGraph({ nodes: [{ id: 'a', category: 'constant', type: 'float', inputs: { value: f(0.2) } }], terminal: { specularRoughness: { node: 'a' } } });
        const material = new OpenPBRMaterial({ graph: a });
        state.request([material]);
        const first = state.requested, revision = state.revision;
        expect(state.active.key).toBe('');
        expect(state.install(first, revision)).toBe(true);
        a.setNode({ id: 'b', category: 'multiply', type: 'float', inputs: { in1: { type: 'float', connection: { node: 'a' } }, in2: f(0.5) } }).setTerminal({ specularRoughness: { node: 'b' } });
        state.request([material]);
        expect(state.active.graphs[0]!.parameters[0]).toBe(0.2);
        expect(state.install(first, revision)).toBe(false);
        state.fail(state.revision, new Error('driver error'));
        expect(state.status).toBe('failed');
        expect(state.active.key).toBe(first.key);
    });
});
