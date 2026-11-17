import type {MaterialGraphInput, MaterialGraphNode, MaterialGraphType} from '../../scene/MaterialGraph.js';
import Texture from '../../scene/Texture.js';
import {graphTypes} from './ir.js';
import {nodeInputs, nodeTypeDiagnostic, outputType, width} from './nodes.js';

export type ResolvedInput = MaterialGraphInput & {type: MaterialGraphType};
export interface ResolvedNode {
    node: MaterialGraphNode & {inputs: Record<string, ResolvedInput>};
    /** Value-only inputs whose value selects no single accepted type, with the reason. */
    issues: ReadonlyMap<string, string>;
}

/** Resolve authored types once, before normalization feeds any execution path.
 * Explicit types win, then connected output types; a value keeps the default
 * overload when it fits, otherwise selects the only accepted type its shape fits.
 * Output types do not depend on input types, so cycles need no recursive inference. */
export function resolveNodeInputs(node: MaterialGraphNode, source: ReadonlyMap<string, MaterialGraphNode>): ResolvedNode {
    const inputs: Record<string, ResolvedInput> = {}, issues = new Map<string, string>();
    const authored = Object.entries(node.inputs ?? {});
    for (const [port, input] of authored) {
        const parent = input.connection && source.get(input.connection.node);
        const type = input.type ?? (parent && outputType(parent, input.connection?.output));
        if (type) inputs[port] = {...input, type};
    }
    for (const [port, input] of authored.filter(([port]) => !inputs[port]).sort(([a], [b]) => a < b ? -1 : 1)) {
        const fallback = nodeInputs({...node, inputs})?.[port]?.type ?? node.type;
        let type = fallback;
        if (input.value !== undefined && !input.connection && !inputValueMatches(fallback, input.value)) {
            const fits = graphTypes.filter(candidate => acceptsType(node, inputs, port, candidate) && inputValueMatches(candidate, input.value));
            if (fits.length === 1) type = fits[0];
            else issues.set(port, fits.length
                ? `Value fits several ${port} types (${fits.join(', ')}); specify type`
                : `Value fits no accepted ${port} type`);
        }
        inputs[port] = {...input, type};
    }
    return {node: {...node, inputs}, issues};
}

/** Whether a port accepts a type, given the other inputs already resolved. */
function acceptsType(node: MaterialGraphNode, inputs: Readonly<Record<string, {type: MaterialGraphType}>>, port: string, type: MaterialGraphType) {
    const probe = {...node, inputs: {...inputs, [port]: {type}}};
    const resolved = nodeInputs(probe);
    return resolved?.[port]?.type === type && !nodeTypeDiagnostic({...probe, inputs: resolved});
}

export function inputValueMatches(type: MaterialGraphType, value: MaterialGraphInput['value']) {
    if (type === 'filename') return value instanceof Texture;
    if (type === 'string') return typeof value === 'string';
    if (type === 'boolean') return typeof value === 'boolean';
    if (width(type) === 1) return typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value));
    return Array.isArray(value) && value.length === width(type) && value.every(v => typeof v === 'number' && Number.isFinite(v));
}
