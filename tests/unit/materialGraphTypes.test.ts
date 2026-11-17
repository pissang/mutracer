import {expect, it} from 'vitest';
import {MaterialGraph, type MaterialGraphTerminal, type MaterialGraphTerminalName, type MaterialGraphDiagnosticCode} from '../../src/main.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';

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
