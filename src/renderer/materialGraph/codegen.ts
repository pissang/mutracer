import type {NormalizedGraph} from './normalize.js';
import {flattenGraph} from './flatten.js';
import {generateGraphIR} from './generate.js';
export interface GeneratedGraph {
    source: string;
    parameters: NormalizedGraph['parameters'];
    foldedNodes: number;
    commonExpressions: number;
}
export function generateGraph(graph: NormalizedGraph, name = 'mx_eval'): GeneratedGraph {
    const generated = generateGraphIR(flattenGraph(graph), name);
    const parameters = graph.parameters.slice();
    for (let i=0; i<generated.foldedWidths.length; i++) {
        const start=(graph.parameters.length+i)*4;
        parameters.push(generated.parameters.slice(start,start+generated.foldedWidths[i]));
    }
    return {source: generated.source, parameters, foldedNodes: generated.foldedNodes, commonExpressions: generated.commonExpressions};
}
