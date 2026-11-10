import { MaterialGraph, type MaterialGraphConnection as Edge, type MaterialGraphInput as Input, type MaterialGraphNode as Node, type MaterialGraphTerminal, type MaterialGraphType as Type } from '@meimu/mutracer';
import { graphCategories, graphOutputs, graphTypes } from '../../../src/renderer/materialGraph/ir';
import { nodeInputs, outputType, terminalAliases, terminalTypes, validNodeType, width } from '../../../src/renderer/materialGraph/nodes';

/**
 * Pure edits of a MaterialGraph for the node editor. The graph stays the single
 * source of truth: every edit returns a new graph and never mutates its input.
 * Node definitions, port types and outputs come from the engine's tables.
 */

/** Where a connection lands: a node input, or an OpenPBR terminal of the surface. */
export type Target = { node: string; port: string } | { terminal: string };

export interface PaletteEntry {
  category: string;
  types: Type[];
  group: string;
}

const GROUPS: [string, RegExp][] = [
  ['Noise', /noise|fractal/],
  ['Pattern', /^(ramp|split)/],
  ['Image', /image|normalmap/],
  ['Geometry', /^(texcoord|position|normal|tangent|bitangent|place2d|transform|rotate)/],
  ['Channel', /^(separate|combine|extract|convert|constant|dot)$|^(separate|combine)\d/],
  ['Blend', /^(burn|dodge|screen|overlay|difference|plus|minus|mix)$/],
  ['Adjust', /^(remap|range|clamp|smoothstep|invert|contrast|luminance|rgbtohsv|hsvtorgb|hsvadjust|ifgreater|ifequal)$/]
];
const groupOf = (category: string) => GROUPS.find(([, re]) => re.test(category))?.[0] ?? 'Math';

/** Output types a category supports, in the engine's type order. */
export function categoryTypes(category: string): Type[] {
  return graphTypes.filter(type => validNodeType({ category, type }) && !!nodeInputs({ category, type }));
}

/** Every node category the engine implements, with its types and a palette group. */
export const PALETTE: PaletteEntry[] = graphCategories
  .map(category => ({ category, types: categoryTypes(category), group: groupOf(category) }))
  .filter(entry => entry.types.length > 0)
  .sort((a, b) => a.category.localeCompare(b.category));

/** The default output type of a new node. */
export const defaultType = (types: readonly Type[]): Type =>
  types.includes('float') ? 'float' : types.includes('color3') ? 'color3' : types[0];

/** The node's inputs with their effective types and defaults; authored-only inputs for unknown categories. */
export function nodePorts(node: Node): Record<string, Input> {
  return nodeInputs({ category: node.category, type: node.type, inputs: node.inputs as Record<string, { type: Type }> }) as Record<string, Input> | undefined
    ?? { ...node.inputs };
}

/** Output port names of a node. */
export function nodeOutputs(node: Node): string[] {
  return graphOutputs.filter(port => outputType(node, port));
}

/** OpenPBR terminal names the engine accepts, without aliases, and their types. */
export const TERMINALS = Object.entries(terminalTypes) as [string, Type][];
/** The canonical terminal name of an authored terminal key. */
export const canonicalTerminal = (name: string) => terminalAliases[name] ?? name;

const byId = (graph: MaterialGraph) => new Map(graph.nodes.map(node => [node.id, node]));

/** IDs upstream of `start`, including `start`. */
export function upstream(graph: MaterialGraph, start: string, nodes = byId(graph), seen = new Set<string>()) {
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const input of Object.values(nodes.get(id)?.inputs ?? {})) if (input.connection) stack.push(input.connection.node);
  }
  return seen;
}

/** Nodes that terminals reach; the engine compiles only these. */
export function reachable(graph: MaterialGraph) {
  const nodes = byId(graph), seen = new Set<string>();
  for (const edge of Object.values(graph.terminal)) if (edge) upstream(graph, edge.node, nodes, seen);
  return seen;
}

/** Checks node-local rules the normalizer applies beyond input types. */
function nodeError(node: Node): string | null {
  if (!validNodeType(node)) return `${node.category} has no ${node.type} variant`;
  const inType = node.inputs?.in?.type;
  if (node.category === 'convert' && inType && ((width(inType) > 1 && width(node.type) === 1) || inType === 'filename' || inType === 'string'))
    return `Cannot convert ${inType} to ${node.type}`;
  if (node.category === 'extract' && inType && !['color3', 'color4', 'vector2', 'vector3', 'vector4'].includes(inType)) return 'extract needs a color or vector';
  const in1 = node.inputs?.in1?.type;
  if (node.category === 'dotproduct' && in1 && !['vector2', 'vector3', 'vector4'].includes(in1)) return 'dotproduct needs vectors';
  return null;
}

/**
 * Why `source` cannot connect to `target`, or `null` when it can. Ports accept
 * the types the engine resolves when that port is authored with the source type,
 * so polymorphic inputs (e.g. a float `in2` on a vector multiply) work.
 */
export function connectionError(graph: MaterialGraph, source: Edge, target: Target): string | null {
  const nodes = byId(graph), from = nodes.get(source.node);
  if (!from) return `Unknown node ${source.node}`;
  const type = outputType(from, source.output ?? 'out');
  if (!type) return `${source.node} has no output ${source.output}`;
  if ('terminal' in target) {
    const expected = terminalTypes[canonicalTerminal(target.terminal)];
    if (!expected) return `Unsupported surface input ${target.terminal}`;
    return type === expected ? null : `${target.terminal} takes ${expected}, not ${type}`;
  }
  const to = nodes.get(target.node);
  if (!to) return `Unknown node ${target.node}`;
  const defaults = nodeInputs(to);
  if (!defaults?.[target.port]) return `${to.category} has no input ${target.port}`;
  const candidate: Node = { ...to, inputs: { ...to.inputs, [target.port]: { type } } };
  const resolved = nodeInputs(candidate)?.[target.port]?.type;
  if (resolved !== type) return `${target.port} takes ${defaults[target.port].type}, not ${type}`;
  const local = nodeError(candidate);
  if (local) return local;
  if (upstream(graph, source.node, nodes).has(target.node)) return 'Connection would create a cycle';
  return null;
}

/** Drops authored inputs whose type no longer matches what the node resolves. */
function reconcile(node: Node): Node {
  let current = node;
  for (let pass = 0; pass < 3; pass++) {
    const defaults = nodeInputs(current);
    if (!defaults) return current;
    const inputs = Object.fromEntries(Object.entries(current.inputs ?? {}).filter(([port, input]) => !defaults[port] || defaults[port].type === input.type));
    if (Object.keys(inputs).length === Object.keys(current.inputs ?? {}).length) return current;
    current = { ...current, inputs };
  }
  return current;
}

/** Rebuilds a graph from node and terminal lists. */
const build = (nodes: readonly Node[], terminal: MaterialGraphTerminal) => new MaterialGraph({ nodes, terminal });

/** A new graph with `edit` applied to a mutable copy of the node list and terminal. */
function edit(graph: MaterialGraph, change: (nodes: Map<string, Node>, terminal: Record<string, Edge>) => void) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const terminal = Object.fromEntries(Object.entries(graph.terminal).filter((entry): entry is [string, Edge] => !!entry[1]));
  change(nodes, terminal);
  return build([...nodes.values()], terminal as MaterialGraphTerminal);
}

/** Re-checks every connection from `id` after its type changed; keeps valid ones and drops the rest. */
function revalidateConsumers(nodes: Map<string, Node>, terminal: Record<string, Edge>, id: string) {
  const source = nodes.get(id);
  for (const [name, edge] of Object.entries(terminal)) {
    if (edge.node !== id) continue;
    const type = source && outputType(source, edge.output ?? 'out');
    if (type !== terminalTypes[canonicalTerminal(name)]) delete terminal[name];
  }
  for (const node of [...nodes.values()]) {
    let next = node;
    for (const [port, input] of Object.entries(node.inputs ?? {})) {
      if (input.connection?.node !== id) continue;
      const type = source && outputType(source, input.connection.output ?? 'out');
      const inputs = { ...next.inputs };
      if (type) inputs[port] = { type, connection: input.connection };
      else delete inputs[port];
      let candidate: Node = { ...next, inputs };
      if (!type || nodeInputs(candidate)?.[port]?.type !== type || nodeError(candidate)) {
        const rest = { ...next.inputs };
        delete rest[port];
        candidate = { ...next, inputs: rest };
      }
      next = reconcile(candidate);
    }
    if (next !== node) nodes.set(node.id, next);
  }
}

/** A unique node ID derived from `base`. */
export function uniqueId(graph: Pick<MaterialGraph, 'nodes'>, base: string) {
  const ids = new Set(graph.nodes.map(node => node.id));
  for (let i = 1; ; i++) if (!ids.has(`${base}${i}`)) return `${base}${i}`;
}

/** Adds a node with default inputs; returns the graph and the new ID. */
export function addNode(graph: MaterialGraph, category: string, type?: Type) {
  const types = categoryTypes(category);
  if (!types.length) throw Error(`Unsupported node category ${category}`);
  const id = uniqueId(graph, category);
  return { graph: edit(graph, nodes => { nodes.set(id, { id, category, type: type && types.includes(type) ? type : defaultType(types), inputs: {} }); }), id };
}

/** A wire dragged from an output, or backwards from an input. */
export type AddAnchor = { source: Edge } | { target: Target };
export interface NodeChoice { category: string; type: Type; port?: string }

/** Compatible node variants; the named port is the input/output joined on creation. */
export function nodeChoices(graph: MaterialGraph, anchor?: AddAnchor): NodeChoice[] {
  const choices: NodeChoice[] = [];
  for (const entry of PALETTE) {
    const types = [defaultType(entry.types), ...entry.types.filter(t => t !== defaultType(entry.types))];
    if (!anchor) { choices.push({ category: entry.category, type: types[0] }); continue; }
    for (const type of types) {
      const added = addNode(graph, entry.category, type);
      const node = added.graph.nodes.find(n => n.id === added.id)!;
      const ports = 'source' in anchor ? Object.keys(nodePorts(node)) : nodeOutputs(node);
      for (const port of ports) {
        const source = 'source' in anchor ? anchor.source : { node: added.id, output: port };
        const target = 'target' in anchor ? anchor.target : { node: added.id, port };
        if (!connectionError(added.graph, source, target)) choices.push({ category: entry.category, type, port });
      }
    }
  }
  return choices;
}

/** Adds and optionally wires a node as a single graph replacement / undo step. */
export function addConnectedNode(graph: MaterialGraph, choice: NodeChoice, anchor?: AddAnchor) {
  const added = addNode(graph, choice.category, choice.type);
  if (!anchor) return added;
  if (!choice.port) throw Error('Choose a compatible port');
  const source = 'source' in anchor ? anchor.source : { node: added.id, output: choice.port };
  const target = 'target' in anchor ? anchor.target : { node: added.id, port: choice.port };
  return { id: added.id, graph: connect(added.graph, source, target) };
}

/** Copies a closed selection: internal wires and values, with external inputs reset. */
export function copyNodes(graph: MaterialGraph, ids: Iterable<string>): readonly Node[] {
  const selected = new Set(ids);
  return new MaterialGraph({ nodes: graph.nodes.filter(n => selected.has(n.id)).map(n => ({
    ...n, inputs: Object.fromEntries(Object.entries(n.inputs ?? {}).filter(([, input]) => !input.connection || selected.has(input.connection.node)))
  })) }).nodes;
}

/** Inserts a copied selection with fresh IDs and remapped internal wires, leaving terminals alone. */
export function pasteNodes(graph: MaterialGraph, copied: readonly Node[]) {
  const mapping = new Map<string, string>();
  const next = edit(graph, nodes => {
    for (const node of copied) {
      const id = uniqueId({ nodes: [...nodes.values()] }, node.category);
      mapping.set(node.id, id);
      nodes.set(id, { ...node, id, inputs: {} });
    }
    for (const node of copied) {
      const id = mapping.get(node.id)!;
      const inputs = Object.fromEntries(Object.entries(node.inputs ?? {}).flatMap(([port, input]) => {
        if (!input.connection) return [[port, input]];
        const source = mapping.get(input.connection.node);
        return source ? [[port, { ...input, connection: { ...input.connection, node: source } }]] : [];
      }));
      nodes.set(id, { ...node, id, inputs });
    }
  });
  return { graph: next, mapping };
}

/** Snapshot equality for retaining unchanged React Flow node views across immutable graph copies. */
export function sameNode(a: Node, b: Node) {
  if (a === b) return true;
  if (a.id !== b.id || a.category !== b.category || a.type !== b.type) return false;
  const left = Object.entries(a.inputs ?? {}), right = b.inputs ?? {};
  if (left.length !== Object.keys(right).length) return false;
  return left.every(([port, input]) => {
    const other = right[port];
    if (!other || input.type !== other.type || input.connection?.node !== other.connection?.node || input.connection?.output !== other.connection?.output) return false;
    return input.value === other.value || (Array.isArray(input.value) && Array.isArray(other.value) &&
      input.value.length === other.value.length && input.value.every((v, i) => v === (other.value as readonly number[])[i]));
  });
}

/** Removes nodes; inputs and terminals that read them return to their defaults. */
export function removeNodes(graph: MaterialGraph, ids: Iterable<string>) {
  const removed = new Set(ids);
  return edit(graph, (nodes, terminal) => {
    for (const id of removed) nodes.delete(id);
    for (const [name, edge] of Object.entries(terminal)) if (removed.has(edge.node)) delete terminal[name];
    for (const node of [...nodes.values()]) {
      const entries = Object.entries(node.inputs ?? {});
      if (!entries.some(([, input]) => input.connection && removed.has(input.connection.node))) continue;
      nodes.set(node.id, reconcile({ ...node, inputs: Object.fromEntries(entries.filter(([, input]) => !(input.connection && removed.has(input.connection.node)))) }));
    }
  });
}

/** Removes nodes that no terminal reaches. */
export function removeUnused(graph: MaterialGraph) {
  const keep = reachable(graph);
  return removeNodes(graph, graph.nodes.filter(node => !keep.has(node.id)).map(node => node.id));
}

/** Connects `source` to `target`, replacing what the target had. Throws when {@link connectionError} rejects it. */
export function connect(graph: MaterialGraph, source: Edge, target: Target) {
  const error = connectionError(graph, source, target);
  if (error) throw Error(error);
  const connection: Edge = source.output && source.output !== 'out' ? { node: source.node, output: source.output } : { node: source.node };
  return edit(graph, (nodes, terminal) => {
    if ('terminal' in target) {
      const name = canonicalTerminal(target.terminal);
      for (const key of Object.keys(terminal)) if (canonicalTerminal(key) === name) delete terminal[key];
      terminal[name] = connection;
      return;
    }
    const from = nodes.get(source.node)!, node = nodes.get(target.node)!;
    const type = outputType(from, source.output ?? 'out')!;
    nodes.set(node.id, reconcile({ ...node, inputs: { ...node.inputs, [target.port]: { type, connection } } }));
  });
}

/** Removes the connection into `target`; a node input returns to its default value. */
export function disconnect(graph: MaterialGraph, target: Target) {
  return edit(graph, (nodes, terminal) => {
    if ('terminal' in target) {
      const name = canonicalTerminal(target.terminal);
      for (const key of Object.keys(terminal)) if (canonicalTerminal(key) === name) delete terminal[key];
      return;
    }
    const node = nodes.get(target.node);
    if (!node?.inputs?.[target.port]) return;
    const inputs = { ...node.inputs };
    delete inputs[target.port];
    nodes.set(node.id, reconcile({ ...node, inputs }));
  });
}

/** Moves a connection: removes `from` and connects its source to `to`, as one edit. */
export function reconnect(graph: MaterialGraph, source: Edge, from: Target, to: Target) {
  const detached = disconnect(graph, from);
  return connect(detached, source, to);
}

/** Sets an unconnected parameter. `undefined` restores the node default. */
export function setParameter(graph: MaterialGraph, id: string, port: string, value: Input['value'] | undefined) {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) throw Error(`Unknown node ${id}`);
  const type = nodePorts(node)[port]?.type ?? node.inputs?.[port]?.type;
  if (!type) throw Error(`${node.category} has no input ${port}`);
  return edit(graph, nodes => {
    const inputs = { ...node.inputs };
    if (value === undefined) delete inputs[port];
    else inputs[port] = { type, value };
    nodes.set(id, { ...node, inputs });
  });
}

/** Changes a node's output type: mismatched values reset, connections that no longer type-check are removed. */
export function setNodeType(graph: MaterialGraph, id: string, type: Type) {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) throw Error(`Unknown node ${id}`);
  if (!categoryTypes(node.category).includes(type)) throw Error(`${node.category} has no ${type} variant`);
  return edit(graph, (nodes, terminal) => {
    nodes.set(id, reconcile({ ...node, type }));
    revalidateConsumers(nodes, terminal, id);
  });
}

/** Columns and rows for a layered left-to-right layout; the surface sits right of column 0. */
export interface GraphLayout {
  positions: Map<string, { x: number; y: number }>;
  surface: { x: number; y: number };
}

export const NODE_WIDTH = 280;
const COLUMN = NODE_WIDTH + 70, ROW = 32, HEADER = 44, GAP = 22;
/** Estimated rendered node height, for stacking. */
export const nodeHeight = (node: Node) => HEADER + ROW * (Object.keys(nodePorts(node)).length + nodeOutputs(node).length) + 8;

/**
 * Layered layout: a node's column is its longest path to the surface (or to a
 * sink for unused nodes); rows follow the mean row of the nodes they feed.
 * Unused nodes go into a separate band below.
 */
export function layoutGraph(graph: MaterialGraph): GraphLayout {
  const nodes = byId(graph), live = reachable(graph);
  const consumers = new Map<string, string[]>();
  for (const node of graph.nodes) for (const input of Object.values(node.inputs ?? {}))
    if (input.connection && nodes.has(input.connection.node)) consumers.set(input.connection.node, [...(consumers.get(input.connection.node) ?? []), node.id]);
  const terminalOrder = new Map<string, number>();
  TERMINALS.forEach(([name], i) => { for (const [key, edge] of Object.entries(graph.terminal)) if (edge && canonicalTerminal(key) === name && !terminalOrder.has(edge.node)) terminalOrder.set(edge.node, i); });
  const depth = new Map<string, number>(), visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 1;
    visiting.add(id);
    const next = (consumers.get(id) ?? []).filter(c => live.has(c) === live.has(id));
    const d = 1 + Math.max(0, ...next.map(depthOf));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const positions = new Map<string, { x: number; y: number }>();
  const rowKey = new Map<string, number>();
  let bottom = 0, wrap = 0;
  for (const band of [true, false]) {
    const members = graph.nodes.filter(node => live.has(node.id) === band);
    const columns: Node[][] = [];
    for (const node of members) (columns[depthOf(node.id)] ??= []).push(node);
    const top = band ? 0 : bottom + 80;
    let bandBottom = top;
    for (let c = 1; c < columns.length; c++) {
      const column = columns[c] ?? [];
      const key = (node: Node) => {
        const rows = (consumers.get(node.id) ?? []).map(id => rowKey.get(id)).filter((v): v is number => v !== undefined);
        if (rows.length) return rows.reduce((a, b) => a + b, 0) / rows.length;
        return (terminalOrder.get(node.id) ?? TERMINALS.length) * ROW;
      };
      const keys = new Map(column.map(node => [node.id, key(node)]));
      column.sort((a, b) => keys.get(a.id)! - keys.get(b.id)! || a.id.localeCompare(b.id));
      // Unused nodes wrap into extra columns so a long list stays compact.
      let y = top, x = -c * COLUMN;
      for (const node of column) {
        if (!band && y > top && y + nodeHeight(node) > top + wrap) { bandBottom = Math.max(bandBottom, y); y = top; x -= COLUMN * (columns.length - 1); }
        positions.set(node.id, { x, y });
        rowKey.set(node.id, y);
        y += nodeHeight(node) + GAP;
      }
      bandBottom = Math.max(bandBottom, y);
    }
    bottom = bandBottom;
    wrap = Math.max(bottom, 600);
  }
  return { positions, surface: { x: 70, y: 0 } };
}
