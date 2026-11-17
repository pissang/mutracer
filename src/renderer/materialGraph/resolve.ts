import type {MaterialGraphInput, MaterialGraphNode, MaterialGraphType} from '../../scene/MaterialGraph.js';
import Texture from '../../scene/Texture.js';
import {nodeInputs, outputType, width} from './nodes.js';

/** Resolve authored types once, before normalization feeds any execution path.
 * Output types do not depend on input types, so cycles need no recursive inference. */
export function resolveNodeInputs(node: MaterialGraphNode, source: ReadonlyMap<string, MaterialGraphNode>) {
    const inputs: Record<string, MaterialGraphInput & {type: MaterialGraphType}> = {};
    for (const [port, input] of Object.entries(node.inputs ?? {})) {
        const parent = input.connection && source.get(input.connection.node);
        const type = input.type ?? (parent && outputType(parent, input.connection?.output));
        if (type) inputs[port] = {...input, type};
    }
    const defaults = nodeInputs({...node, inputs});
    for (const [port, input] of Object.entries(node.inputs ?? {})) {
        if (!inputs[port]) inputs[port] = {...input, type: defaults?.[port]?.type ?? node.type};
    }
    return {...node, inputs};
}

/** Only implicit values get the stricter shape check; preserve explicit graphs. */
export function inputValueMatches(type: MaterialGraphType, value: MaterialGraphInput['value']) {
    if (type === 'filename') return value instanceof Texture;
    if (type === 'string') return typeof value === 'string';
    if (type === 'boolean') return typeof value === 'boolean';
    if (width(type) === 1) return typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value));
    return Array.isArray(value) && value.length === width(type) && value.every(v => typeof v === 'number' && Number.isFinite(v));
}
