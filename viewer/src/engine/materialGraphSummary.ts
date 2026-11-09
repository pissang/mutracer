import { MaterialGraph, Texture, type MaterialGraphNode, type MaterialGraphTerminal } from '@meimu/mutracer';
import { terminalAliases } from '../../../src/renderer/materialGraph/nodes';

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
