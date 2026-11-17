import type {MaterialGraphTerminalName, MaterialGraphType} from './MaterialGraph.js';
import {graphCategories, graphOutputs, graphTypes} from '../renderer/materialGraph/ir.js';
import {nodeInputs, outputType, validNodeType, nodeTypeDiagnostic, terminalTypes, terminalAliases, type DefinitionNode} from '../renderer/materialGraph/nodes.js';

/** Supported MaterialX node categories. */
export type MaterialGraphCategory = typeof graphCategories[number];
/** Supported categories, in stable catalog order. */
export const materialGraphCategories: readonly MaterialGraphCategory[] = Object.freeze([...graphCategories]);
/** One accepted type of a node input. */
export interface MaterialGraphNodeInputOption {
    /** Input type. */
    readonly type: MaterialGraphType;
    /** Value used when the input is omitted or has no value. Default undefined for geometry and unbound textures. */
    readonly default?: number | boolean | string | readonly number[];
}
/** The inputs and outputs of one node output type. */
export interface MaterialGraphNodeSignature {
    /** Node type; separate nodes use the source type. */
    readonly type: MaterialGraphType;
    /** Accepted types of each input, default first. Inputs choose their types
     * independently; types that constrain each other are split into separate signatures. */
    readonly inputs: Readonly<Record<string, readonly MaterialGraphNodeInputOption[]>>;
    /** Named outputs and their types. */
    readonly outputs: Readonly<Record<string, MaterialGraphType>>;
}
/** All supported overloads of a node category. */
export interface MaterialGraphNodeDefinition {
    /** MaterialX category. */
    readonly category: MaterialGraphCategory;
    /** Signatures by output type; the first signature of each type holds the default overload. */
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

type Assignment = Record<string, {type: MaterialGraphType; value?: MaterialGraphNodeInputOption['default']}>;
const assignmentKey = (inputs: Assignment) => JSON.stringify(Object.entries(inputs).map(([port, input]) => [port, input.type]));
/** Splits accepted input assignments into signatures whose inputs vary independently.
 * A group that is not the product of its per-input types is split on its first varying input. */
function signaturesOf(type: MaterialGraphType, outputs: Readonly<Record<string, MaterialGraphType>>, assignments: Assignment[]): MaterialGraphNodeSignature[] {
    const ports = Object.keys(assignments[0]);
    const options = Object.fromEntries(ports.map(port => {
        const seen = new Map<MaterialGraphType, MaterialGraphNodeInputOption>();
        for (const inputs of assignments) {
            const {type, value} = inputs[port];
            if (!seen.has(type)) seen.set(type, Object.freeze({type, ...(value === undefined ? {} : {default: Array.isArray(value) ? Object.freeze([...value]) : value})}));
        }
        return [port, [...seen.values()]];
    }));
    const sameShape = assignments.every(inputs => Object.keys(inputs).join() === ports.join());
    const product = ports.reduce((count, port) => count * options[port].length, 1);
    if (sameShape && product === new Set(assignments.map(assignmentKey)).size)
        return [Object.freeze({type, inputs: Object.freeze(Object.fromEntries(ports.map(port => [port, Object.freeze(options[port])]))), outputs})];
    const split = sameShape ? ports.find(port => options[port].length > 1)! : undefined;
    const groups = new Map<string, Assignment[]>();
    for (const inputs of assignments) {
        const key = split ? inputs[split].type : Object.keys(inputs).join();
        groups.set(key, [...(groups.get(key) ?? []), inputs]);
    }
    return [...groups.values()].flatMap(group => signaturesOf(type, outputs, group));
}

const cache = new Map<string, MaterialGraphNodeDefinition>();
/** Read-only node inputs, accepted types, defaults and outputs; unknown categories return undefined. */
export function describeMaterialGraphNode(category: string): MaterialGraphNodeDefinition | undefined {
    if (!materialGraphCategories.includes(category as MaterialGraphCategory)) return undefined;
    if (cache.has(category)) return cache.get(category);
    const signatures: MaterialGraphNodeSignature[] = [];
    for (const type of graphTypes) {
        const node: DefinitionNode = {category, type};
        if (!validNodeType(node) || !nodeInputs(node)) continue;
        // Discover every accepted assignment under single-input type probes, default first.
        // Probing a coupled input changes the whole assignment, preserving its constraints.
        const pending: Assignment[] = [nodeInputs(node)!], seen = new Set<string>(), accepted: Assignment[] = [];
        while (pending.length) {
            const inputs = pending.shift()!, key = assignmentKey(inputs);
            if (seen.has(key)) continue;
            seen.add(key);
            if (nodeTypeDiagnostic({...node, inputs})) continue;
            accepted.push(inputs);
            for (const port of Object.keys(inputs)) for (const alternative of graphTypes) {
                if (alternative !== inputs[port].type) pending.push(nodeInputs({...node, inputs: {...inputs, [port]: {type: alternative}}})!);
            }
        }
        const outputs = Object.freeze(Object.fromEntries(graphOutputs.flatMap(port => {
            const output = outputType(node, port);
            return output ? [[port, output]] : [];
        })));
        signatures.push(...signaturesOf(type, outputs, accepted));
    }
    const definition = Object.freeze({category: category as MaterialGraphCategory, signatures: Object.freeze(signatures)});
    cache.set(category, definition);
    return definition;
}
