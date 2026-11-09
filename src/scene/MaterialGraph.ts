import type Texture from './Texture.js';
import type {MaterialGraphTerminalName} from '../renderer/materialGraph/nodes.js';
export type {MaterialGraphTerminalName} from '../renderer/materialGraph/nodes.js';
/** MaterialX numeric ports, loaded Texture references and geometry-space strings. */
export type MaterialGraphType = 'float' | 'integer' | 'boolean' | 'color3' | 'color4' | 'vector2' | 'vector3' | 'vector4' | 'filename' | 'string';
/** A source output. The default output name is `out`. */
export interface MaterialGraphConnection {
    /** Stable source node ID. */ node: string;
    /** Source port. Default `out`; separate nodes expose component ports and gltf_colorimage exposes `outcolor`/`outa`. */ output?: string;
}
/** One typed input, either a parameter or a connection. */
export interface MaterialGraphInput {
    /** MaterialX input type. */ type: MaterialGraphType;
    /** Uniform value; numbers, booleans, strings, numeric vectors or loaded textures. Default is the node definition's default. */ value?: number | boolean | string | readonly number[] | Texture;
    /** Connected output; when present, value is ignored. Default undefined. */ connection?: MaterialGraphConnection;
}
/** An authored MaterialX node. Unsupported categories produce diagnostics. */
export interface MaterialGraphNode {
    /** Stable, unique ID used in connections and diagnostics. */ id: string;
    /** MaterialX category, for example `multiply` or `image`. */ category: string;
    /** Output type (source type for separate2/3/4; color4 for gltf_colorimage). */ type: MaterialGraphType;
    /** Authored inputs. Omitted inputs use node defaults. Default empty. */ inputs?: Readonly<Record<string, MaterialGraphInput>>;
}
/** OpenPBR camelCase surface inputs. Unconnected inputs retain the material's constants/maps. */
export type MaterialGraphTerminal = Readonly<Partial<Record<MaterialGraphTerminalName, MaterialGraphConnection>>>;
/** Initial graph description. */
export interface MaterialGraphOptions {
    /** Nodes. Default empty. */ nodes?: readonly MaterialGraphNode[];
    /** OpenPBR connections. Default empty. */ terminal?: MaterialGraphTerminal;
}
/** Machine-readable graph validation, compilation or engine availability failure. */
export type MaterialGraphDiagnosticCode =
    | 'duplicate-node' | 'missing-node' | 'cycle' | 'unsupported-node'
    | 'unsupported-conversion' | 'unsupported-type' | 'unsupported-input'
    | 'input-type' | 'connection-type' | 'parameter-type' | 'unsupported-space'
    | 'unsupported-sampling' | 'parameter-value' | 'unsupported-integer-range'
    | 'unsupported-frame' | 'unsupported-uv' | 'duplicate-terminal'
    | 'unsupported-terminal' | 'terminal-type' | 'unsupported-emission-graph'
    | 'unsupported-opacity-context' | 'unsupported-opacity-projection'
    | 'unsupported-backend' | 'unsupported-transport' | 'shader-compilation'
    | 'engine-unavailable';
/** A located validation or compilation failure. The whole invalid graph falls back. */
export interface MaterialGraphDiagnostic {
    /** Stable machine-readable category. */ code: MaterialGraphDiagnosticCode;
    /** Human-readable cause. */ message: string;
    /** Material aovId when reported by an engine. Default undefined. */
    materialId?: number;
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
 * engine.update() after edits. Parameter edits reuse a compatible installed graph
 * or texture-slot plan. While new structures compile, the last successful result
 * remains visible (initially material constants/maps).
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
    /** Monotonic authored edit counter, initially zero; independent of engine compilation revisions. Every successful edit call advances it once, including no-ops. */
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
    /** Replaces one input. An omitted/undefined input removes the authored value or connection and restores the node default. Throws for an unknown node ID. */
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
