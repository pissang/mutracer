import Texture from './Texture.js';
import type {MaterialGraphConnection, MaterialGraphInput, MaterialGraphNode, MaterialGraphOptions, MaterialGraphTerminal, MaterialGraphType} from './MaterialGraph.js';

/** JSON-safe authored input. Texture references use a caller-defined ID. */
export interface MaterialGraphJSONInput {
    /** Authored overload. Default inferred from the connection or node definition. */
    type?: MaterialGraphType;
    /** Authored value. Default the node definition's default. */
    value?: number | boolean | string | readonly number[] | {texture: string};
    /** Source output. Default undefined. */
    connection?: MaterialGraphConnection;
}
/** Versioned authored graph; edit revisions and texture data are not included. */
export interface MaterialGraphJSON {
    /** Authored format version, currently 1. */
    version: 1;
    /** Authored nodes, including unused nodes. */
    nodes: (Omit<MaterialGraphNode, 'inputs'> & {inputs?: Readonly<Record<string, MaterialGraphJSONInput>>})[];
    /** Authored OpenPBR terminal connections. */
    terminal: MaterialGraphTerminal;
}
/** Texture ID mapping for graph serialization. */
export interface MaterialGraphSerializationOptions {
    /** Maps each loaded texture to a stable ID. Default undefined; texture values then throw. */
    textureId?: (texture: Texture) => string;
}
/** Texture lookup for graph loading. */
export interface MaterialGraphDeserializationOptions {
    /** Resolves serialized IDs to loaded textures. Default undefined; texture references then throw. An unresolved ID throws. */
    resolveTexture?: (id: string) => Texture | undefined;
}

export function serializeMaterialGraph(graph: MaterialGraphOptions, options: MaterialGraphSerializationOptions): MaterialGraphJSON {
    return {
        version: 1,
        nodes: (graph.nodes ?? []).map(node => ({...node, inputs: Object.fromEntries(Object.entries(node.inputs ?? {}).map(([port, input]) => {
            let value: MaterialGraphJSONInput['value'];
            if (input.value instanceof Texture) {
                if (!options.textureId) throw new Error('MaterialGraph.toJSON: texture values require a textureId mapper');
                const id = options.textureId(input.value);
                if (typeof id !== 'string') throw new Error('MaterialGraph.toJSON: textureId must return a string');
                value = {texture: id};
            } else value = Array.isArray(input.value) ? [...input.value] : input.value;
            return [port, {...(input.type === undefined ? {} : {type: input.type}), ...(value === undefined ? {} : {value}), ...(input.connection ? {connection: {...input.connection}} : {})}];
        }))})),
        terminal: Object.fromEntries(Object.entries(graph.terminal ?? {}).map(([port, edge]) => [port, {...edge}]))
    };
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function invalid(path: string): never { throw new Error(`MaterialGraph.fromJSON: invalid ${path}`); }
function connection(value: unknown, path: string): MaterialGraphConnection {
    if (!record(value) || typeof value.node !== 'string' || (value.output !== undefined && typeof value.output !== 'string')) invalid(path);
    return {node: value.node, ...(value.output === undefined ? {} : {output: value.output})};
}
export function deserializeMaterialGraph(json: unknown, options: MaterialGraphDeserializationOptions): MaterialGraphOptions {
    if (!record(json)) invalid('graph object');
    if (json.version !== 1) throw new Error(`MaterialGraph.fromJSON: unsupported version ${String(json.version)}`);
    if (!Array.isArray(json.nodes) || !record(json.terminal)) invalid('nodes or terminal');
    const nodes = json.nodes.map((node: unknown, i: number): MaterialGraphNode => {
        const path = `nodes[${i}]`;
        if (!record(node) || typeof node.id !== 'string' || typeof node.category !== 'string' || typeof node.type !== 'string' || (node.inputs !== undefined && !record(node.inputs))) invalid(path);
        const inputs: Record<string, MaterialGraphInput> = {};
        for (const [port, input] of Object.entries(node.inputs ?? {})) {
            if (!record(input) || (input.type !== undefined && typeof input.type !== 'string')) invalid(`${path}.inputs.${port}`);
            let value: MaterialGraphInput['value'];
            const raw = input.value;
            if (record(raw)) {
                if (typeof raw.texture !== 'string' || Object.keys(raw).length !== 1) invalid(`${path}.inputs.${port}.value`);
                if (!options.resolveTexture) throw new Error('MaterialGraph.fromJSON: texture references require a resolveTexture mapper');
                value = options.resolveTexture(raw.texture);
                if (!(value instanceof Texture)) throw new Error(`MaterialGraph.fromJSON: unresolved texture ${raw.texture}`);
            } else if (raw === undefined || typeof raw === 'string' || typeof raw === 'boolean' || typeof raw === 'number' && Number.isFinite(raw)) value = raw;
            else if (Array.isArray(raw) && raw.every(v => typeof v === 'number' && Number.isFinite(v))) value = [...raw];
            else invalid(`${path}.inputs.${port}.value`);
            inputs[port] = {
                ...(input.type === undefined ? {} : {type: input.type as MaterialGraphType}),
                ...(value === undefined ? {} : {value}),
                ...(input.connection === undefined ? {} : {connection: connection(input.connection, `${path}.inputs.${port}.connection`)})
            };
        }
        return {id: node.id, category: node.category as MaterialGraphNode['category'], type: node.type as MaterialGraphType, inputs};
    });
    return {nodes, terminal: Object.fromEntries(Object.entries(json.terminal).map(([port, edge]) => [port, connection(edge, `terminal.${port}`)]))};
}
