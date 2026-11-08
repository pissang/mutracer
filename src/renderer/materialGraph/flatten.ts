import type {NormalizedGraph} from './normalize.js';
import {numeric} from './evaluate.js';
import {emptyGraphIR, graphCategories, graphPorts, graphTerminals, graphTypes, graphOutputs, graphGeometry, GraphSource} from './ir.js';

/** Lower a validated canonical graph without retaining browser objects in the IR. */
export function flattenGraph(graph: NormalizedGraph) {
    if (graph.diagnostics.length) throw new Error(graph.diagnostics.map(d => d.message).join('\n'));
    return flattenGraphUnchecked(graph);
}
/** Context validation can inspect reachable inputs even after author validation fails. */
export function flattenGraphUnchecked(graph: NormalizedGraph) {
    const ir = emptyGraphIR();
    for (const value of graph.parameters) {
        const n = typeof value === 'object' && !Array.isArray(value) ? [-1] : numeric(value);
        ir.parameters.push(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0);
    }
    for (const node of graph.nodes) {
        const first = ir.inputs.length / 5;
        for (const [port, input] of Object.entries(node.inputs)) {
            const kind = input.node !== undefined ? GraphSource.Node : input.geometry ? GraphSource.Geometry : GraphSource.Parameter;
            if(input.type==='filename' && input.slot!==undefined && graph.parameters[input.slot]===undefined)ir.parameters[input.slot*4]=-1;
            ir.inputs.push(graphPorts.indexOf(port), graphTypes.indexOf(input.type), kind,
                input.node ?? (input.geometry ? graphGeometry.indexOf(input.geometry) : input.slot!), graphOutputs.indexOf(input.output ?? 'out'));
        }
        ir.nodes.push(graphCategories.indexOf(node.category), 1, graphTypes.indexOf(node.type), first, ir.inputs.length / 5 - first);
    }
    for (const [port, edge] of Object.entries(graph.terminal)) ir.terminal.push(graphTerminals.indexOf(port), edge.node, graphOutputs.indexOf(edge.output));
    return ir;
}
