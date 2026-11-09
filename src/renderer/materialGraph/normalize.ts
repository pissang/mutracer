import type MaterialGraph from '../../scene/MaterialGraph.js';
import type { MaterialGraphDiagnostic as Diagnostic, MaterialGraphInput as Input, MaterialGraphNode as Node, MaterialGraphType as Type } from '../../scene/MaterialGraph.js';
import Texture from '../../scene/Texture.js';
import { nodeInputs, outputType, terminalTypes, terminalAliases, validNodeType, width } from './nodes.js';
export interface GraphNode {
    id: string;
    category: string;
    type: Type;
    inputs: Record<string, GraphInput>;
}
export interface GraphInput {
    type: Type;
    node?: number;
    output?: string;
    slot?: number;
    geometry?: string;
}
export interface NormalizedGraph {
    key: string;
    hash: string;
    nodes: GraphNode[];
    terminal: Record<string, {
        node: number;
        output: string;
    }>;
    parameters: Input['value'][];
    diagnostics: Diagnostic[];
}
export const GRAPH_IMPLEMENTATION_VERSION = 'mx-1.39.4-web-3';
export function graphHash(key: string) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++)
        hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
}
/** Canonical port-ordered DFS removes author IDs, declaration order and dead nodes.
 * Exact canonical keys accompany the short hash to avoid cache collisions. */
export function normalizeGraph(graph: MaterialGraph, capabilities = 'atlas'): NormalizedGraph {
    const diagnostics: Diagnostic[] = [], nodes: GraphNode[] = [], parameters: Input['value'][] = [];
    const source = new Map<string, Node>(), indices = new Map<string, number>(), visiting = new Set<string>();
    const report = (code: string, message: string, node?: string, port?: string) => diagnostics.push({ code, message, node, port });
    for (const node of graph.nodes) {
        if (source.has(node.id))
            report('duplicate-node', `Duplicate node ID ${node.id}`, node.id);
        source.set(node.id, node);
    }
    const visit = (id: string): number => {
        if (indices.has(id))
            return indices.get(id)!;
        const node = source.get(id);
        if (!node) {
            report('missing-node', `Unknown source node ${id}`, id);
            return -1;
        }
        if (visiting.has(id)) {
            report('cycle', 'Material graphs must be acyclic', id);
            return -1;
        }
        visiting.add(id);
        const defaults = nodeInputs(node);
        if (!defaults)
            report('unsupported-node', `Unsupported MaterialX category ${node.category}`, id);
        if (node.category === 'convert' && node.inputs?.in && ((width(node.inputs.in.type) > 1 && width(node.type) === 1) || ['filename', 'string'].includes(node.inputs.in.type)))
            report('unsupported-conversion', `Unsupported convert ${node.inputs.in.type} to ${node.type}`, id, 'in');
        if(node.category==='dotproduct' && !['vector2','vector3','vector4'].includes(node.inputs?.in1?.type ?? 'vector3'))report('unsupported-type','dotproduct requires vector inputs',id,'in1');
        if (node.category === 'extract' && !['color3','color4','vector2','vector3','vector4'].includes(node.inputs?.in?.type ?? 'color3')) report('unsupported-type','extract requires a color or vector',id,'in');
        if (!validNodeType(node))
            report('unsupported-type', `Unsupported ${node.category}/${node.type}`, id);
        const inputs: Record<string, GraphInput> = {};
        for (const port of Object.keys(node.inputs ?? {}))
            if (!defaults || !(port in defaults))
                report('unsupported-input', `Unsupported input ${port}`, id, port);
        for (const port of Object.keys(defaults ?? {}).sort()) {
            const expected = defaults![port], authored = node.inputs?.[port], value = authored ?? expected;
            if (value.type !== expected.type)
                report('input-type', `Expected ${expected.type}, got ${value.type}`, id, port);
            if (value.connection) {
                const edge = value.connection, index = visit(edge.node), parent = source.get(edge.node), output = edge.output ?? 'out';
                const type = parent && outputType(parent, output);
                if (type !== value.type)
                    report('connection-type', `Expected ${value.type}, got ${type ?? 'unknown output'}`, id, port);
                inputs[port] = { type: value.type, node: index, output };
            }
            else if (!authored && expected.value === undefined && expected.type !== 'filename') {
                inputs[port] = { type: expected.type, geometry: port === 'position' ? 'objectPosition' : port };
            }
            else {
                const parameter = value.value ?? expected.value;
                if (value.type === 'filename') {
                    if (parameter !== undefined && !(parameter instanceof Texture))
                        report('parameter-type', 'Image file must be a loaded Texture', id, port);
                }
                else if (value.type === 'string') {
                    if (['space', 'fromspace', 'tospace'].includes(port)) {
                        if (!(port === 'space' ? ['world', 'object'] : ['', 'world', 'object']).includes(String(parameter)))
                            report('unsupported-space', 'Only object/world geometry spaces are supported', id, port);
                    }
                    else if (node.category === 'dot' && port === 'note') { /* Author annotation, no rendering effect. */ }
                    else if (parameter !== expected.value)
                        report('unsupported-sampling', `Only ${expected.value} is supported for ${port}; use Texture sampling options`, id, port);
                }
                else {
                    const values = Array.isArray(parameter) ? parameter : [parameter];
                    if (values.length !== width(value.type) || values.some(v => typeof v !== 'boolean' && (typeof v !== 'number' || !Number.isFinite(v))))
                        report('parameter-value', `Expected finite ${value.type} parameter`, id, port);
                    if (value.type === 'boolean' && typeof parameter !== 'boolean')
                        report('parameter-value', 'Expected boolean parameter', id, port);
                    if(value.type==='integer' && Math.abs(Number(parameter))>16777216)report('unsupported-integer-range','Integer parameters must be exactly representable in Float32',id,port);
                    if (node.category === 'extract' && port === 'index' && (Number(parameter) < 0 || Number(parameter) >= width(node.inputs?.in?.type ?? 'color3'))) report('parameter-value', 'extract index is outside the input vector', id, port);
                    if (value.type === 'integer' && !Number.isInteger(parameter))
                        report('parameter-value', 'Expected integer parameter', id, port);
                    if (['tangent', 'bitangent'].includes(node.category) && port === 'index' && parameter !== 0)
                        report('unsupported-frame', 'Only the primary tangent frame is supported', id, port);
                    if (node.category === 'texcoord' && parameter !== 0 && parameter !== 1)
                        report('unsupported-uv', 'Only UV0 and UV1 are supported', id, port);
                    if (node.category === 'place2d' && port === 'operationorder' && parameter !== 0 && parameter !== 1)
                        report('parameter-value', 'operationorder must be 0 or 1', id, port);
                }
                inputs[port] = { type: value.type, slot: parameters.length };
                parameters.push(parameter);
            }
        }
        visiting.delete(id);
        const index = nodes.length;
        indices.set(id, index);
        nodes.push({ id, category: node.category, type: node.type, inputs });
        return index;
    };
    const terminal: NormalizedGraph['terminal'] = {};
    for (const [authored, edge] of Object.entries(graph.terminal).sort(([a], [b]) => (terminalAliases[a] ?? a) < (terminalAliases[b] ?? b) ? -1 : 1)) {
        const port = terminalAliases[authored] ?? authored;
        if (terminal[port])
            report('duplicate-terminal', `Multiple connections to ${port}`, edge.node, authored);
        const index = visit(edge.node), output = edge.output ?? 'out', parent = source.get(edge.node);
        if (!terminalTypes[port])
            report('unsupported-terminal', `Unsupported OpenPBR graph input ${port}`, edge.node, port);
        else if (!parent || outputType(parent, output) !== terminalTypes[port])
            report('terminal-type', `Expected ${terminalTypes[port]} terminal`, edge.node, port);
        terminal[port] = { node: index, output };
    }
    const key = JSON.stringify([GRAPH_IMPLEMENTATION_VERSION, 'webgpu', capabilities, nodes.map(({ category, type, inputs }) => ({ category, type, inputs })), terminal]);
    return { key, hash: graphHash(key), nodes, terminal, parameters, diagnostics };
}
