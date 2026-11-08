import type Texture from './Texture.js';
/** MaterialX numeric ports, loaded Texture references and geometry-space strings. */
export type MaterialGraphType = 'float' | 'integer' | 'boolean' | 'color3' | 'color4' | 'vector2' | 'vector3' | 'vector4' | 'filename' | 'string';
/** A source output. The default output name is `out`. */
export interface MaterialGraphConnection {
    /** Stable source node ID. */ node: string;
    /** Source port. Default `out`; separate nodes also expose `outx/outy/outz/outw`. */ output?: string;
}
/** One typed input, either a parameter or a connection. */
export interface MaterialGraphInput {
    /** MaterialX input type. */ type: MaterialGraphType;
    /** Uniform value. Default is the node definition's default. */ value?: number | boolean | string | readonly number[] | Texture;
    /** Connected output; when present, value is ignored. Default undefined. */ connection?: MaterialGraphConnection;
}
/** An authored MaterialX node. Unsupported categories produce diagnostics. */
export interface MaterialGraphNode {
    /** Stable, unique ID used in connections and diagnostics. */ id: string;
    /** MaterialX category, for example `multiply` or `image`. */ category: string;
    /** Output type (the source vector type for separate2/3/4). */ type: MaterialGraphType;
    /** Authored inputs. Omitted inputs use node defaults. Default empty. */ inputs?: Readonly<Record<string, MaterialGraphInput>>;
}
/** OpenPBR camelCase surface inputs. Unconnected inputs retain the material's constants/maps. */
export type MaterialGraphTerminal = Readonly<Record<string, MaterialGraphConnection>>;
/** Initial graph description. */
export interface MaterialGraphOptions {
    /** Nodes. Default empty. */ nodes?: readonly MaterialGraphNode[];
    /** OpenPBR connections. Default empty. */ terminal?: MaterialGraphTerminal;
}
/** A located validation or compilation failure. The whole invalid graph falls back. */
export interface MaterialGraphDiagnostic {
    /** Stable machine-readable category. */ code: string;
    /** Human-readable cause. */ message: string;
    /** Authored node ID, if applicable. Default undefined. */ node?: string;
    /** Input/output/terminal port, if applicable. Default undefined. */ port?: string;
}
function copyNode(node: MaterialGraphNode): MaterialGraphNode {
    const inputs = Object.fromEntries(Object.entries(node.inputs ?? {}).map(([key, input]) => [key, Object.freeze({
            ...input, value: Array.isArray(input.value) ? Object.freeze([...input.value]) : input.value,
            connection: input.connection && Object.freeze({ ...input.connection })
        })]));
    return Object.freeze({ ...node, inputs: Object.freeze(inputs) });
}
/**
 * Editable MaterialX 1.39 surface graph. Attach to OpenPBRMaterial.graph and call
 * engine.update() after edits. Parameters do not require shader compilation;
 * new structures display the last compiled graph (initially material constants).
 */
export default class MaterialGraph {
    private _nodes: readonly MaterialGraphNode[];
    private _terminal: MaterialGraphTerminal;
    private _revision = 0;
    /** Creates an empty graph by default. */
    constructor(options: MaterialGraphOptions = {}) {
        this._nodes = Object.freeze((options.nodes ?? []).map(copyNode));
        this._terminal = Object.freeze(Object.fromEntries(Object.entries(options.terminal ?? {}).map(([key, value]) => [key, Object.freeze({ ...value })])));
    }
    /** Immutable authored nodes. Default empty. Use setNode/setInput to edit. */
    get nodes() { return this._nodes; }
    /** Immutable OpenPBR terminal connections. Default empty. */
    get terminal() { return this._terminal; }
    /** Monotonic edit revision, initially zero. Every edit advances it once. */
    get revision() { return this._revision; }
    /** Adds or replaces a node by ID and advances revision. */
    setNode(node: MaterialGraphNode) {
        const nodes = this._nodes.filter(item => item.id !== node.id);
        nodes.push(copyNode(node));
        this._nodes = Object.freeze(nodes);
        this._revision++;
        return this;
    }
    /** Removes a node. Dangling connections produce diagnostics on the next update. */
    removeNode(id: string) { this._nodes = Object.freeze(this._nodes.filter(node => node.id !== id)); this._revision++; return this; }
    /** Replaces one input. An undefined input restores the node default. */
    setInput(id: string, port: string, input?: MaterialGraphInput) {
        const node = this._nodes.find(item => item.id === id);
        if (!node)
            throw new Error(`MaterialGraph: unknown node ${id}`);
        const inputs = { ...node.inputs };
        if (input)
            inputs[port] = input;
        else
            delete inputs[port];
        return this.setNode({ ...node, inputs });
    }
    /** Replaces the OpenPBR terminal connections and advances revision. */
    setTerminal(terminal: MaterialGraphTerminal) {
        this._terminal = Object.freeze(Object.fromEntries(Object.entries(terminal).map(([key, value]) => [key, Object.freeze({ ...value })])));
        this._revision++;
        return this;
    }
}
