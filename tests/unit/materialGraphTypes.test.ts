import {expect, it} from 'vitest';
import {MaterialGraph, type MaterialGraphTerminal, type MaterialGraphTerminalName, type MaterialGraphDiagnosticCode} from '../../src/main.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';

it('exposes read-only snapshots and accepts edits through graph methods', () => {
    const graph = new MaterialGraph({
        nodes: [{id: 'n', category: 'constant', type: 'float', inputs: {value: {value: 0.5}}}],
        terminal: {specularRoughness: {node: 'n'}}
    });
    expect(() => {
        // @ts-expect-error The returned node is frozen.
        graph.nodes[0].id = 'other';
    }).toThrow(TypeError);
    expect(() => {
        // @ts-expect-error The returned input is frozen.
        graph.nodes[0].inputs!.value.value = 1;
    }).toThrow(TypeError);
    expect(() => {
        // @ts-expect-error The returned connection is frozen.
        graph.terminal.specularRoughness!.node = 'other';
    }).toThrow(TypeError);
    graph.setInput('n', 'value', {value: 1});
    expect(graph.nodes[0].inputs!.value.value).toBe(1);
});

it('accepts typed terminal names and aliases while preserving dynamic-data diagnostics', () => {
    const name: MaterialGraphTerminalName = 'geometryNormal';
    const terminal: MaterialGraphTerminal = {[name]: {node: 'normal'}, specularRoughnessAnisotropy: {node: 'roughness'}};
    const graph = new MaterialGraph({terminal});
    graph.setTerminal({geometryOpacity: {node: 'opacity'}, baseColor: {node: 'color'}});
    // @ts-expect-error A misspelled terminal is rejected by the constructor.
    new MaterialGraph({terminal: {baseColour: {node: 'c'}}});
    // @ts-expect-error A misspelled terminal is rejected by setTerminal.
    graph.setTerminal({specularRougness: {node: 'c'}});
    const code: MaterialGraphDiagnosticCode = 'unsupported-terminal';
    // @ts-expect-error Diagnostic categories are closed literals.
    const invalidCode: MaterialGraphDiagnosticCode = 'typo';
    expect(invalidCode).toBe('typo');
    expect(normalizeGraph(graph).diagnostics).toContainEqual(expect.objectContaining({code}));
});
