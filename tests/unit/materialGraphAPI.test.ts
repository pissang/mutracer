import {describe, expect, it} from 'vitest';
import {MaterialGraph, Texture, describeMaterialGraphNode, materialGraphCategories, materialGraphTerminals,
    type MaterialGraphInput, type MaterialGraphNode, type MaterialGraphType} from '../../src/main.js';
import {graphCategories, graphTypes, graphOutputs} from '../../src/renderer/materialGraph/ir.js';
import {nodeInputs, outputType, validNodeType, nodeTypeDiagnostic} from '../../src/renderer/materialGraph/nodes.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {evaluateGraph} from '../../src/renderer/materialGraph/evaluate.js';
import {generateGraph} from '../../src/renderer/materialGraph/codegen.js';
import {flattenGraph} from '../../src/renderer/materialGraph/flatten.js';
import {validateGraphIR} from '../../src/renderer/materialGraph/validate.js';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';

function rooted(node: MaterialGraphNode, output = 'out') {
    const type = outputType(node, output)!;
    return new MaterialGraph({nodes: [node, {id: 'surface', category: 'convert', type: 'color3', inputs: {in: {type, connection: {node: node.id, output}}}}], terminal: {baseColor: {node: 'surface'}}});
}
const roughness = (inputs?: Record<string, MaterialGraphInput>, category: MaterialGraphNode['category'] = 'multiply', type: MaterialGraphType = 'float') =>
    new MaterialGraph({nodes: [{id: 'n', category, type, inputs}], terminal: {[type === 'color3' ? 'baseColor' : 'specularRoughness']: {node: 'n'}}});

describe('public MaterialGraph catalog', () => {
    it('enumerates exactly the accepted category and output-type pairs', () => {
        expect(materialGraphCategories).toEqual(graphCategories);
        expect(describeMaterialGraphNode('not-a-node')).toBeUndefined();
        for (const category of graphCategories) {
            const definition = describeMaterialGraphNode(category)!;
            expect(definition.category).toBe(category);
            for (const type of graphTypes) {
                const accepted = validNodeType({category, type}) && !!nodeInputs({category, type});
                expect(definition.signatures.some(s => s.type === type), `${category}/${type}`).toBe(accepted);
            }
            for (const signature of definition.signatures) {
                const inputs = Object.fromEntries(Object.entries(signature.inputs).map(([port, input]) => [port, {type: input.types[0]}]));
                const node = {id: 'n', category, type: signature.type, inputs};
                const defaults = nodeInputs(node)!;
                expect(nodeTypeDiagnostic(node)).toBeUndefined();
                expect(Object.keys(signature.inputs)).toEqual(Object.keys(defaults));
                for (const [port, input] of Object.entries(defaults)) {
                    expect(signature.inputs[port].types).toEqual([input.type]);
                    expect(signature.inputs[port].default).toEqual(input.value);
                }
                expect(signature.outputs).toEqual(Object.fromEntries(graphOutputs.flatMap(port => {
                    const type = outputType(node, port);
                    return type ? [[port, type]] : [];
                })));
                // The interpreter's parameter defaults must agree, including non-default overloads.
                const output = Object.keys(signature.outputs)[0];
                const authored = {...node, inputs: Object.fromEntries(Object.entries(inputs).filter(([port]) => defaults[port].value !== undefined || defaults[port].type === 'filename'))};
                const normalized = normalizeGraph(rooted(authored, output));
                expect(normalized.diagnostics, `${category}/${signature.type}`).toEqual([]);
                expect(validateGraphIR(flattenGraph(normalized))).toEqual([]);
                for (const [port, input] of Object.entries(normalized.nodes[0].inputs)) {
                    if (input.slot !== undefined) expect(normalized.parameters[input.slot]).toEqual(signature.inputs[port].default);
                }
                // Every accepted single-port type probe is represented, including coupled ports.
                for (const port of Object.keys(inputs)) for (const type of graphTypes) {
                    const probe = {category, type: signature.type, inputs: {...inputs, [port]: {type}}};
                    const resolved = nodeInputs(probe)!;
                    if (nodeTypeDiagnostic({...probe, inputs: resolved})) continue;
                    expect(definition.signatures.some(s => s.type === signature.type && Object.keys(resolved).every(p => s.inputs[p].types.includes(resolved[p].type))), `${category}.${port}/${type}`).toBe(true);
                }
            }
        }
    });
    it('preserves coupled input constraints and freezes nested data', () => {
        const definition = describeMaterialGraphNode('dotproduct')!;
        expect(definition.signatures.map(s => s.inputs.in1.types[0])).toEqual(['vector3', 'vector2', 'vector4']);
        for (const s of definition.signatures) expect(s.inputs.in2.types).toEqual(s.inputs.in1.types);
        expect(() => (materialGraphCategories as string[]).push('bad')).toThrow();
        expect(() => (definition.signatures[0].inputs.in1.types as string[]).push('bad')).toThrow();
        const defaults = describeMaterialGraphNode('multiply')!.signatures.find(s => s.type === 'color3')!.inputs.in2.default as number[];
        expect(() => { defaults[0] = 10; }).toThrow();
        expect(materialGraphTerminals.geometryNormal).toEqual({name: 'normal', type: 'vector3'});
    });
});

describe('MaterialGraph input inference and validation', () => {
    it('matches explicit equivalents through canonicalization, compilation and interpretation', () => {
        const explicit = new MaterialGraph({nodes: [
            {id: 'color', category: 'constant', type: 'color3', inputs: {value: {type: 'color3', value: [.2, .4, .6]}}},
            {id: 'gain', category: 'constant', type: 'float', inputs: {value: {type: 'float', value: 2}}},
            {id: 'product', category: 'multiply', type: 'color3', inputs: {in1: {type: 'color3', connection: {node: 'color'}}, in2: {type: 'float', connection: {node: 'gain'}}}}
        ], terminal: {baseColor: {node: 'product'}}});
        const inferred = new MaterialGraph({nodes: explicit.nodes.map(n => ({...n, inputs: Object.fromEntries(Object.entries(n.inputs ?? {}).map(([p, {type: _type, ...input}]) => [p, input]))})), terminal: explicit.terminal});
        const a = normalizeGraph(explicit), b = normalizeGraph(inferred);
        expect(b).toEqual(a);
        expect(inferred.validate()).toEqual([]);
        expect(evaluateGraph(b).baseColor).toEqual([.4, .8, 1.2]);
        expect(generateGraph(b)).toEqual(generateGraph(a));
        expect(flattenGraph(b)).toEqual(flattenGraph(a));
    });
    it('infers numeric connections for every catalog overload', () => {
        for (const category of materialGraphCategories) for (const signature of describeMaterialGraphNode(category)!.signatures) {
            const parents: MaterialGraphNode[] = [], explicit: Record<string, MaterialGraphInput> = {}, inferred: Record<string, MaterialGraphInput> = {};
            for (const [port, input] of Object.entries(signature.inputs)) {
                const type = input.types[0];
                if (type === 'filename' || type === 'string') continue;
                const id = `source/${port}`;
                parents.push({id, category: 'constant', type});
                explicit[port] = {type, connection: {node: id}};
                inferred[port] = {connection: {node: id}};
            }
            const a = rooted({id: 'n', category, type: signature.type, inputs: explicit}, Object.keys(signature.outputs)[0]);
            const b = rooted({id: 'n', category, type: signature.type, inputs: inferred}, Object.keys(signature.outputs)[0]);
            parents.forEach(node => { a.setNode(node); b.setNode(node); });
            const normalized = normalizeGraph(b);
            expect(normalized.diagnostics, `${category}/${signature.type}`).toEqual([]);
            expect(normalized).toEqual(normalizeGraph(a));
            expect(generateGraph(normalized)).toEqual(generateGraph(normalizeGraph(a)));
        }
    });
    it('uses output-port types and resolves coupled defaults independently of declaration order', () => {
        const nodes: MaterialGraphNode[] = [
            {id: 'dot', category: 'dotproduct', type: 'float', inputs: {in1: {connection: {node: 'uv'}}, in2: {}}},
            {id: 'uv', category: 'texcoord', type: 'vector2'}
        ];
        const graph = new MaterialGraph({nodes, terminal: {specularRoughness: {node: 'dot'}}});
        expect(graph.validate()).toEqual([]);
        expect(normalizeGraph(graph).nodes[1].inputs.in2.type).toBe('vector2');
        const separated = new MaterialGraph({nodes: [{id: 'rgba', category: 'gltf_colorimage', type: 'color4'}, {id: 'n', category: 'multiply', type: 'float', inputs: {in1: {connection: {node: 'rgba', output: 'outa'}}}}], terminal: {specularRoughness: {node: 'n'}}});
        expect(separated.validate()).toEqual([]);
        separated.setInput('n', 'in1', {connection: {node: 'rgba', output: 'missing'}});
        expect(separated.validate()).toContainEqual(expect.objectContaining({code: 'connection-type', port: 'in1'}));
    });
    it('uses default overloads for empty inputs and diagnoses values requiring another overload', () => {
        expect(normalizeGraph(roughness({in1: {}, in2: {}}))).toEqual(normalizeGraph(roughness()));
        const geometry = rooted({id: 'n', category: 'noise3d', type: 'float', inputs: {position: {}}});
        expect(normalizeGraph(geometry)).toEqual(normalizeGraph(rooted({id: 'n', category: 'noise3d', type: 'float'})));
        const graph = roughness({in2: {value: .5}}, 'multiply', 'color3');
        expect(graph.validate()).toContainEqual(expect.objectContaining({code: 'input-type', port: 'in2'}));
        graph.setInput('n', 'in2', {type: 'float', value: .5});
        expect(graph.validate()).toEqual([]);
        const mix = roughness({mix: {value: [.1, .2, .3]}}, 'mix', 'color3');
        expect(mix.validate()).toContainEqual(expect.objectContaining({code: 'input-type', port: 'mix'}));
        mix.setInput('n', 'mix', {type: 'color3', value: [.1, .2, .3]});
        expect(mix.validate()).toEqual([]);
    });
    it('keeps explicit types authoritative and returns engine diagnostics without mutating the graph', () => {
        const graph = roughness({in1: {type: 'color3', connection: {node: 'n'}}});
        const revision = graph.revision, before = graph.toJSON();
        expect(graph.validate()).toEqual(expect.arrayContaining([expect.objectContaining({code: 'cycle'}), expect.objectContaining({code: 'input-type'}), expect.objectContaining({code: 'connection-type'})]));
        const state = new MaterialGraphState();
        state.request([new OpenPBRMaterial({graph})]);
        for (const diagnostic of graph.validate()) expect(state.diagnostics).toContainEqual(expect.objectContaining(diagnostic));
        expect(graph.revision).toBe(revision);
        expect(graph.toJSON()).toEqual(before);
        const unknown = MaterialGraph.fromJSON({version: 1, nodes: [{id: 'bad', category: 'unknown', type: 'float'}], terminal: {baseColor: {node: 'bad'}}});
        expect(unknown.validate()).toContainEqual(expect.objectContaining({code: 'unsupported-node'}));
        unknown.setTerminal({opacity: {node: 'missing'}});
        expect(unknown.validate()).toContainEqual(expect.objectContaining({code: 'missing-node'}));
        unknown.setTerminal({});
        expect(unknown.validate()).toEqual([]);
    });
});

describe('MaterialGraph editing and JSON', () => {
    it('replaces nodes in place and edits a single terminal across aliases', () => {
        const graph = roughness().setNode({id: 'second', category: 'constant', type: 'float'});
        graph.setInput('n', 'in2', {value: 2}).setNode({id: 'second', category: 'constant', type: 'float'});
        expect(graph.nodes.map(n => n.id)).toEqual(['n', 'second']);
        graph.setTerminal({geometryOpacity: {node: 'n'}, opacity: {node: 'second'}, baseMetalness: {node: 'n'}});
        const before = graph.revision;
        graph.setTerminalInput('geometryOpacity', {node: 'second'});
        expect(graph.terminal).toEqual({opacity: {node: 'second'}, baseMetalness: {node: 'n'}});
        graph.setTerminalInput('opacity');
        expect(graph.terminal).toEqual({baseMetalness: {node: 'n'}});
        expect(graph.revision).toBe(before + 2);
    });
    it('round-trips authored inputs, defaults, dead nodes and aliases without revision', () => {
        const graph = roughness({in1: {value: 2}, in2: {type: 'float', value: .25}}).setNode({id: 'unused', category: 'constant', type: 'float'});
        graph.setTerminalInput('geometryOpacity', {node: 'n'});
        const json = JSON.parse(JSON.stringify({graph})).graph;
        expect(json.version).toBe(1);
        expect(json.revision).toBeUndefined();
        const restored = MaterialGraph.fromJSON(json);
        expect(restored.nodes).toEqual(graph.nodes);
        expect(restored.terminal).toEqual(graph.terminal);
        expect(restored.revision).toBe(0);
        expect(normalizeGraph(restored)).toEqual(normalizeGraph(graph));
        json.nodes[0].inputs.in1.value = 100;
        expect(restored.nodes[0].inputs!.in1.value).toBe(2);
    });
    it('uses explicit texture IDs and rejects missing or unresolved mappers', () => {
        const texture = new Texture({data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1});
        const graph = rooted({id: 'image', category: 'image', type: 'color3', inputs: {file: {value: texture}}});
        expect(() => JSON.stringify(graph)).toThrow(/textureId/);
        expect(() => JSON.stringify({graph})).toThrow(/textureId/);
        const json = graph.toJSON({textureId: t => { expect(t).toBe(texture); return 'albedo'; }});
        expect(json.nodes[0].inputs!.file.value).toEqual({texture: 'albedo'});
        expect(() => MaterialGraph.fromJSON(json)).toThrow(/resolveTexture/);
        expect(() => MaterialGraph.fromJSON(json, {resolveTexture: () => undefined})).toThrow(/unresolved texture/);
        const restored = MaterialGraph.fromJSON(JSON.parse(JSON.stringify(json)), {resolveTexture: id => id === 'albedo' ? texture : undefined});
        expect(restored.nodes[0].inputs!.file.value).toBe(texture);
        expect(normalizeGraph(restored)).toEqual(normalizeGraph(graph));
    });
    it('rejects malformed format data while preserving semantic errors for validate', () => {
        for (const json of [null, [], {}, {version: 2}, {version: 1, nodes: {}, terminal: {}}, {version: 1, nodes: [null], terminal: {}},
            {version: 1, nodes: [{id: 'n', category: 'constant', type: 'float', inputs: {value: {value: null}}}], terminal: {}},
            {version: 1, nodes: [], terminal: {baseColor: {node: 7}}}]) expect(() => MaterialGraph.fromJSON(json)).toThrow(/MaterialGraph.fromJSON/);
        const graph = MaterialGraph.fromJSON({version: 1, nodes: [{id: 'n', category: 'constant', type: 'not-a-type'}], terminal: {bad: {node: 'n'}}});
        expect(graph.validate()).toEqual(expect.arrayContaining([expect.objectContaining({code: 'unsupported-type'}), expect.objectContaining({code: 'unsupported-terminal'})]));
    });
});
