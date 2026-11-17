import type {MaterialGraphTerminalName, MaterialGraphType} from './MaterialGraph.js';
import {graphCategories, graphOutputs, graphTypes} from '../renderer/materialGraph/ir.js';
import {nodeInputs, outputType, validNodeType, nodeTypeDiagnostic, terminalTypes, terminalAliases, type DefinitionNode} from '../renderer/materialGraph/nodes.js';

/** Supported MaterialX node categories. */
export type MaterialGraphCategory = typeof graphCategories[number];
/** Supported categories, in stable catalog order. */
export const materialGraphCategories: readonly MaterialGraphCategory[] = Object.freeze([...graphCategories]);
/** One exact overload. The first signature for each output type supplies omitted-input defaults. */
export interface MaterialGraphNodeSignature {
    /** Node type; separate nodes use the source type. */
    readonly type: MaterialGraphType;
    /** Input types and defaults for this overload. Omitted defaults use geometry or an unbound texture. */
    readonly inputs: Readonly<Record<string, {
        /** Accepted types, with the default first. Coupled overloads have separate signatures. */
        readonly types: readonly MaterialGraphType[];
        /** Value used when omitted. Default undefined for geometry and unbound textures. */
        readonly default?: number | boolean | string | readonly number[];
    }>>;
    /** Named outputs and their types. */
    readonly outputs: Readonly<Record<string, MaterialGraphType>>;
}
/** All supported overloads of a node category. */
export interface MaterialGraphNodeDefinition {
    /** MaterialX category. */
    readonly category: MaterialGraphCategory;
    /** Exact overloads, ordered with the default first for each output type. */
    readonly signatures: readonly MaterialGraphNodeSignature[];
}
interface TerminalDefinition {
    /** Required connected output type. */
    readonly type: MaterialGraphType;
    /** Canonical terminal name used by validation and rendering. */
    readonly name: MaterialGraphTerminalName;
}
/** OpenPBR terminal types and canonical names, including compatibility aliases. */
export const materialGraphTerminals: Readonly<Record<MaterialGraphTerminalName, TerminalDefinition>> = Object.freeze(Object.fromEntries([...Object.keys(terminalTypes), ...Object.keys(terminalAliases)].map(key => {
    const name = terminalAliases[key] ?? key;
    return [key, Object.freeze({name, type: terminalTypes[name]})];
}))) as Readonly<Record<MaterialGraphTerminalName, TerminalDefinition>>;

const cache = new Map<string, MaterialGraphNodeDefinition>();
/** Read-only node overloads, defaults and outputs; unknown categories return undefined. */
export function describeMaterialGraphNode(category: string): MaterialGraphNodeDefinition | undefined {
    if (!materialGraphCategories.includes(category as MaterialGraphCategory)) return undefined;
    if (cache.has(category)) return cache.get(category);
    const signatures: MaterialGraphNodeSignature[] = [];
    for (const type of graphTypes) {
        const node: DefinitionNode = {category, type};
        if (!validNodeType(node) || !nodeInputs(node)) continue;
        // Discover the closure of definitions under single-port type probes.
        // Probing a coupled port changes the whole definition, preserving its constraints.
        const pending = [nodeInputs(node)!], seen = new Set<string>();
        while (pending.length) {
            const inputs = pending.shift()!;
            const key = JSON.stringify(Object.entries(inputs).map(([port, input]) => [port, input.type]));
            if (seen.has(key)) continue;
            seen.add(key);
            const candidate = {...node, inputs};
            if (nodeTypeDiagnostic(candidate)) continue;
            const outputs = Object.fromEntries(graphOutputs.flatMap(port => {
                const output = outputType(node, port);
                return output ? [[port, output]] : [];
            }));
            signatures.push(Object.freeze({type, inputs: Object.freeze(Object.fromEntries(Object.entries(inputs).map(([port, input]) => [port, Object.freeze({
                types: Object.freeze([input.type]),
                ...(input.value === undefined ? {} : {default: Array.isArray(input.value) ? Object.freeze([...input.value]) : input.value})
            })]))), outputs: Object.freeze(outputs)}));
            for (const port of Object.keys(inputs)) for (const alternative of graphTypes) {
                if (alternative === inputs[port].type) continue;
                pending.push(nodeInputs({...node, inputs: {...inputs, [port]: {type: alternative}}})!);
            }
        }
    }
    const definition = Object.freeze({category: category as MaterialGraphCategory, signatures: Object.freeze(signatures)});
    cache.set(category, definition);
    return definition;
}
