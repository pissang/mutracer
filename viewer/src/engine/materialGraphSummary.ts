import { MaterialGraph, Texture, type MaterialGraphNode, type MaterialGraphTerminal } from '@meimu/mutracer';
import { terminalAliases, terminalTypes } from '../../../src/renderer/materialGraph/nodes';

/** A surface input driven by the graph. */
export interface GraphInputSummary {
  /** Terminal name as authored in the graph. */
  terminal: string;
  /** Canonical OpenPBR name, matching the panel's material keys. */
  key: string;
  /** Direct node category and upstream image names, e.g. `multiply ← Skin_Color.png`. */
  source: string;
  /** IDs of every node upstream of the terminal, including missing ones. */
  nodes: string[];
}

/** An image read by the graph. */
export interface GraphImageSummary {
  node: string;
  port: string;
  texture?: Texture;
  name: string;
  /** Canonical names of the inputs this image reaches. */
  feeds: string[];
}

export interface MaterialGraphSummary {
  inputs: GraphInputSummary[];
  images: GraphImageSummary[];
}

const imagePort = (node: MaterialGraphNode) =>
  Object.entries(node.inputs ?? {}).find(([, input]) => input.type === 'filename')?.[0];

/** Node IDs upstream of a node, depth first, including the node itself. */
function upstream(nodes: Map<string, MaterialGraphNode>, start: string, seen = new Set<string>()) {
  if (seen.has(start)) return seen;
  seen.add(start);
  for (const input of Object.values(nodes.get(start)?.inputs ?? {})) {
    if (input.connection) upstream(nodes, input.connection.node, seen);
  }
  return seen;
}

/**
 * Describes which surface inputs a graph drives, where their values come from
 * and which images feed them. `nameOf` names an image texture, else the node ID is used.
 */
export function summarizeMaterialGraph(graph: MaterialGraph, nameOf: (texture: Texture) => string | undefined): MaterialGraphSummary {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const imageName = (node: MaterialGraphNode) => {
    const port = imagePort(node), value = port ? node.inputs?.[port].value : undefined;
    return (value instanceof Texture ? nameOf(value) : undefined) ?? node.id;
  };
  const feeds = new Map<string, string[]>();
  const inputs = Object.entries(graph.terminal).map(([terminal, edge]): GraphInputSummary => {
    const key = terminalAliases[terminal] ?? terminal;
    const reached = [...upstream(nodes, edge!.node)];
    // `dot` nodes only pass their input through; name the node behind them.
    let direct = nodes.get(edge!.node);
    for (let hops = 0; direct?.category === 'dot' && direct.inputs?.in?.connection && hops < nodes.size; hops++) {
      direct = nodes.get(direct.inputs.in.connection.node) ?? direct;
    }
    const images = reached.flatMap(id => {
      const node = nodes.get(id);
      if (!node || !imagePort(node)) return [];
      feeds.set(id, [...new Set([...(feeds.get(id) ?? []), key])]);
      return [imageName(node)];
    });
    const names = [...new Set(images)].join(', ');
    const source = !direct ? `missing ${edge!.node}`
      : imagePort(direct) ? names
        : names ? `${direct.category} ← ${names}` : direct.category;
    return { terminal, key, source, nodes: reached };
  });
  const images = graph.nodes.flatMap((node): GraphImageSummary[] => {
    const port = imagePort(node);
    if (!port) return [];
    const value = node.inputs![port].value;
    return [{ node: node.id, port, texture: value instanceof Texture ? value : undefined, name: imageName(node), feeds: feeds.get(node.id) ?? [] }];
  });
  return { inputs, images };
}

/**
 * A copy of the graph without one terminal input, keeping only nodes that the
 * remaining inputs still reach; `null` when no input remains.
 */
export function disconnectGraphInput(graph: MaterialGraph, terminal: string): MaterialGraph | null {
  const rest: Record<string, NonNullable<MaterialGraphTerminal[keyof MaterialGraphTerminal]>> = {};
  for (const [name, edge] of Object.entries(graph.terminal)) if (name !== terminal && edge) rest[name] = edge;
  if (!Object.keys(rest).length) return null;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const keep = new Set<string>();
  for (const edge of Object.values(rest)) upstream(nodes, edge.node, keep);
  return new MaterialGraph({ nodes: graph.nodes.filter(node => keep.has(node.id)), terminal: rest as MaterialGraphTerminal });
}

/** A copy of the graph with one input replaced; a parameter edit when the input type is unchanged. */
export function withGraphInput(graph: MaterialGraph, node: string, port: string, value: Texture) {
  return new MaterialGraph({ nodes: graph.nodes, terminal: graph.terminal }).setInput(node, port, { type: 'filename', value });
}

/** An editable constant input of a graph node. */
export interface GraphParameterSummary {
  node: string;
  port: string;
  type: 'float' | 'integer' | 'boolean' | 'color3' | 'color4' | 'vector2' | 'vector3' | 'vector4';
  value: number | boolean | readonly number[];
  /** Author's name for a MaterialX interface input; absent for other node inputs. */
  label?: string;
  /** Canonical names of the surface inputs this value reaches, in terminal order. */
  affects: string[];
}

export interface GraphParameterList {
  /** `authored`: the inputs the MaterialX author exposed. `ranked`: the most relevant node inputs. */
  source: 'authored' | 'ranked';
  /** Parameters to show first: every authored one, or at most `limit` ranked ones. */
  primary: GraphParameterSummary[];
  /** The remaining ranked parameters. */
  more: GraphParameterSummary[];
}

const PARAMETER_TYPES = new Set<string>(['float', 'integer', 'boolean', 'color3', 'color4', 'vector2', 'vector3', 'vector4']);
// Interface constants made by the MaterialX importer; see `INTERFACE_SEGMENT` in materialxGraph.ts.
const isInterface = (node: MaterialGraphNode) => node.category === 'constant' && node.id.includes('/interface/');
// Plumbing whose literals select channels or convert types rather than shape the look.
const PLUMBING = new Set(['extract', 'convert', 'dot', 'swizzle', 'combine2', 'combine3', 'combine4', 'separate2', 'separate3', 'separate4']);
// Nodes the importer adds to map a surface onto OpenPBR, other than authored surface constants.
const generated = (id: string) => id.startsWith('surface/') && !id.startsWith('surface/value/') || /\/(extract\d|channels|decode|bias|cross|bitangent)$/.test(id);

/**
 * Editable values of a graph. Graphs imported from MaterialX nodegraphs list
 * the inputs their author exposed. Other graphs list authored numeric, boolean
 * and color inputs of the nodes the surface reaches, without type and channel
 * plumbing, ranked by surface constants, then colors, then graph order, and
 * keep at most `limit` in `primary`.
 */
export function graphParameters(graph: MaterialGraph, limit = 10): GraphParameterList {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const order = new Set<string>();
  const affects = new Map<string, string[]>();
  for (const [terminal, edge] of Object.entries(graph.terminal)) {
    if (!edge) continue;
    const key = terminalAliases[terminal] ?? terminal;
    for (const id of upstream(nodes, edge.node)) {
      order.add(id);
      const list = affects.get(id) ?? [];
      if (!list.includes(key)) affects.set(id, [...list, key]);
    }
  }
  const terminals = Object.keys(terminalTypes);
  for (const [id, list] of affects) affects.set(id, list.sort((a, b) => (terminals.indexOf(a) >>> 0) - (terminals.indexOf(b) >>> 0)));
  const reached = [...order].map(id => nodes.get(id)).filter(node => !!node);
  // Authored parameters keep their declaration order.
  const authored = graph.nodes.filter(node => order.has(node.id) && isInterface(node));
  if (authored.length) {
    return { source: 'authored', more: [], primary: authored.flatMap(node => {
      const input = node.inputs?.value;
      if (!input || input.connection || input.value === undefined || !PARAMETER_TYPES.has(input.type)) return [];
      return [{ node: node.id, port: 'value', type: input.type as GraphParameterSummary['type'], value: input.value as GraphParameterSummary['value'],
        label: node.id.slice(node.id.lastIndexOf('/') + 1), affects: affects.get(node.id) ?? [] }];
    }) };
  }
  const candidates = reached.flatMap(node => {
    if (PLUMBING.has(node.category) || generated(node.id)) return [];
    return Object.entries(node.inputs ?? {}).flatMap(([port, input]): GraphParameterSummary[] => {
      if (input.connection || input.value === undefined || input.value instanceof Texture || !PARAMETER_TYPES.has(input.type) || input.type === 'integer') return [];
      return [{ node: node.id, port, type: input.type as GraphParameterSummary['type'], value: input.value as GraphParameterSummary['value'], affects: affects.get(node.id) ?? [] }];
    });
  });
  const rank = (param: GraphParameterSummary) => param.node.startsWith('surface/value/') ? 0 : param.type.startsWith('color') ? 1 : 2;
  const ranked = candidates.map((param, index) => ({ param, index })).sort((a, b) => rank(a.param) - rank(b.param) || a.index - b.index).map(item => item.param);
  return { source: 'ranked', primary: ranked.slice(0, limit), more: ranked.slice(limit) };
}
