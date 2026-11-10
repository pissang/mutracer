import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/' }); vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' }); vi.stubGlobal('window', {}); });
import { MaterialGraph, Texture } from '@meimu/mutracer';
import { MATERIALX_SAMPLES } from '../src/engine/materialxSamples';
import { parseMaterialXGraph } from '../src/engine/materialxGraph';
import { exportMaterialX } from '../src/engine/materialxExport';
import {
  PALETTE, addConnectedNode, nodeChoices, copyNodes, pasteNodes, sameNode, addNode, connect, connectionError, disconnect, layoutGraph, nodeOutputs, nodePorts, reachable, reconnect,
  removeNodes, removeUnused, setNodeType, setParameter
} from '../src/engine/graphEdit';
import { normalizeGraph } from '../../src/renderer/materialGraph/normalize';
import { graphCategories } from '../../src/renderer/materialGraph/ir';
import { redo, undo, pushHistory } from '../src/history';

const graphOf = (id: string) => {
  const sample = MATERIALX_SAMPLES.find(s => s.id === id)!;
  return parseMaterialXGraph(sample.text);
};

/** A small graph: constant color → multiply → baseColor, noise → roughness. */
const small = () => new MaterialGraph({
  nodes: [
    { id: 'tint', category: 'constant', type: 'color3', inputs: { value: { type: 'color3', value: [0.8, 0.2, 0.1] } } },
    { id: 'scale', category: 'multiply', type: 'color3', inputs: { in1: { type: 'color3', connection: { node: 'tint' } }, in2: { type: 'float', value: 0.5 } } },
    { id: 'pos', category: 'position', type: 'vector3' },
    { id: 'grain', category: 'noise3d', type: 'float', inputs: { position: { type: 'vector3', connection: { node: 'pos' } } } }
  ],
  terminal: { baseColor: { node: 'scale' }, specularRoughness: { node: 'grain' } }
});

describe('node palette', () => {
  it('offers every engine category that has a valid type, with engine port and output lists', () => {
    const categories = PALETTE.map(entry => entry.category);
    expect(categories).toEqual(expect.arrayContaining(['noise3d', 'multiply', 'mix', 'image', 'separate3', 'hsvadjust']));
    for (const category of categories) expect(graphCategories).toContain(category);
    const separate = { id: 's', category: 'separate3', type: 'color3' as const };
    expect(nodeOutputs(separate)).toEqual(['outr', 'outg', 'outb']);
    expect(Object.keys(nodePorts({ id: 'n', category: 'noise3d', type: 'float' }))).toEqual(['position', 'amplitude', 'pivot']);
  });
});

describe('connection validation', () => {
  it('accepts matching and polymorphic port types and rejects others', () => {
    const graph = small();
    expect(connectionError(graph, { node: 'grain' }, { node: 'scale', port: 'in2' })).toBeNull();
    expect(connectionError(graph, { node: 'pos' }, { node: 'scale', port: 'in2' })).toMatch(/takes/);
    expect(connectionError(graph, { node: 'grain' }, { terminal: 'baseColor' })).toMatch(/color3/);
    expect(connectionError(graph, { node: 'grain' }, { terminal: 'specularRoughness' })).toBeNull();
    expect(connectionError(graph, { node: 'grain' }, { node: 'scale', port: 'nope' })).toMatch(/no input/);
  });

  it('rejects cycles, including self connections', () => {
    const graph = small();
    expect(connectionError(graph, { node: 'scale' }, { node: 'scale', port: 'in1' })).toMatch(/cycle/);
    const { graph: withMix, id } = addNode(graph, 'multiply', 'color3');
    const linked = connect(withMix, { node: 'scale' }, { node: id, port: 'in1' });
    expect(connectionError(linked, { node: id }, { node: 'scale', port: 'in1' })).toMatch(/cycle/);
    expect(() => connect(linked, { node: id }, { node: 'scale', port: 'in1' })).toThrow(/cycle/);
  });
});

describe('graph edits', () => {
  it('maps edits to MaterialGraph inputs and terminals without mutating the source', () => {
    const graph = small();
    const before = JSON.stringify(graph.nodes);
    const edited = setParameter(graph, 'scale', 'in2', 0.25);
    expect(edited).not.toBe(graph);
    expect(JSON.stringify(graph.nodes)).toBe(before);
    expect(edited.nodes.find(n => n.id === 'scale')!.inputs!.in2).toEqual({ type: 'float', value: 0.25 });
    expect(normalizeGraph(edited).key).toBe(normalizeGraph(graph).key);
    const restored = setParameter(edited, 'scale', 'in2', undefined);
    expect(restored.nodes.find(n => n.id === 'scale')!.inputs!.in2).toBeUndefined();

    const wired = connect(graph, { node: 'grain' }, { node: 'scale', port: 'in2' });
    expect(wired.nodes.find(n => n.id === 'scale')!.inputs!.in2).toEqual({ type: 'float', connection: { node: 'grain' } });
    expect(normalizeGraph(wired).diagnostics).toEqual([]);
    expect(normalizeGraph(wired).key).not.toBe(normalizeGraph(graph).key);
    const unwired = disconnect(wired, { node: 'scale', port: 'in2' });
    expect(unwired.nodes.find(n => n.id === 'scale')!.inputs!.in2).toBeUndefined();

    const moved = reconnect(graph, { node: 'grain' }, { terminal: 'specularRoughness' }, { terminal: 'baseMetalness' });
    expect(moved.terminal).toEqual({ baseColor: { node: 'scale' }, baseMetalness: { node: 'grain' } });
  });

  it('adds and deletes nodes, resetting inputs and terminals that read them', () => {
    const { graph, id } = addNode(small(), 'noise3d');
    expect(id).toBe('noise3d1');
    expect(graph.nodes.find(n => n.id === id)).toMatchObject({ category: 'noise3d', type: 'float' });
    expect(reachable(graph).has(id)).toBe(false);
    expect(normalizeGraph(graph).diagnostics).toEqual([]);
    const removed = removeNodes(small(), ['tint', 'grain']);
    expect(removed.nodes.map(n => n.id)).toEqual(['scale', 'pos']);
    expect(removed.nodes[0].inputs!.in1).toBeUndefined();
    expect(removed.terminal).toEqual({ baseColor: { node: 'scale' } });
    expect(removeUnused(removed).nodes.map(n => n.id)).toEqual(['scale']);
  });

  it('changes node types, dropping values and connections that no longer type-check', () => {
    const graph = setNodeType(small(), 'scale', 'float');
    const scale = graph.nodes.find(n => n.id === 'scale')!;
    expect(scale.type).toBe('float');
    expect(scale.inputs!.in1).toBeUndefined();
    expect(scale.inputs!.in2).toEqual({ type: 'float', value: 0.5 });
    expect(graph.terminal.baseColor).toBeUndefined();
    expect(normalizeGraph(graph).diagnostics).toEqual([]);
  });

  it('undoes and redoes graph replacements through the viewer history', () => {
    let current = small();
    const apply = (next: MaterialGraph, label: string) => {
      const before = current;
      current = next;
      pushHistory({ label, scope: 'material', undo: () => { current = before; }, redo: () => { current = next; } });
    };
    const original = current;
    apply(addNode(current, 'noise3d').graph, 'Add node');
    const added = current;
    apply(removeNodes(current, ['noise3d1']), 'Delete node');
    undo();
    expect(current).toBe(added);
    undo();
    expect(current).toBe(original);
    redo();
    expect(current).toBe(added);
  });

  it('offers only compatible node ports in either wire direction and adds with one graph replacement', () => {
    const graph = small();
    const downstream = nodeChoices(graph, { source: { node: 'tint' } });
    expect(downstream).toContainEqual({ category: 'multiply', type: 'color3', port: 'in1' });
    expect(downstream).not.toContainEqual({ category: 'multiply', type: 'float', port: 'in1' });
    const choice = downstream.find(c => c.category === 'multiply' && c.type === 'color3' && c.port === 'in1')!;
    const added = addConnectedNode(graph, choice, { source: { node: 'tint' } });
    expect(added.graph.nodes.find(n => n.id === added.id)!.inputs!.in1.connection).toEqual({ node: 'tint' });
    expect(graph.nodes).toHaveLength(4);
    expect(normalizeGraph(added.graph).diagnostics).toEqual([]);
    const anchor = { target: { terminal: 'baseColor' } } as const;
    const upstream = nodeChoices(graph, anchor);
    expect(upstream).toContainEqual({ category: 'constant', type: 'color3', port: 'out' });
    for (const candidate of upstream) {
      const result = addConnectedNode(graph, candidate, anchor);
      expect(result.graph.terminal.baseColor!.node).toBe(result.id);
      expect(normalizeGraph(result.graph).diagnostics).toEqual([]);
    }
    const multiOutput = nodeChoices(graph, { target: { terminal: 'specularRoughness' } })
      .find(c => c.category === 'separate3' && c.type === 'color3' && c.port === 'outg')!;
    const separated = addConnectedNode(graph, multiOutput, { target: { terminal: 'specularRoughness' } });
    expect(separated.graph.terminal.specularRoughness).toEqual({ node: separated.id, output: 'outg' });
  });

  it('copies and pastes a closed subgraph with fresh IDs, internal wires and no terminal changes', () => {
    const graph = small();
    const copied = copyNodes(graph, ['tint', 'scale']);
    const pasted = pasteNodes(graph, copied);
    const scale = pasted.graph.nodes.find(n => n.id === pasted.mapping.get('scale'))!;
    expect(scale.inputs!.in1.connection).toEqual({ node: pasted.mapping.get('tint') });
    expect(scale.inputs!.in2.value).toBe(0.5);
    expect(pasted.graph.terminal).toEqual(graph.terminal);
    expect(new Set(pasted.graph.nodes.map(n => n.id)).size).toBe(6);
    expect(graph.nodes).toHaveLength(4);
    expect(pasteNodes(pasted.graph, copied).graph.nodes).toHaveLength(8);
    expect(copyNodes(graph, ['scale'])[0].inputs!.in1).toBeUndefined();
    const isolated = pasteNodes(new MaterialGraph(), copied).graph;
    expect(isolated.nodes).toHaveLength(2);
    expect(normalizeGraph(connect(isolated, { node: isolated.nodes[1].id }, { terminal: 'baseColor' })).diagnostics).toEqual([]);
  });

  it('retains image references and named outputs while remapping pasted wires', () => {
    const texture = new Texture({ width: 1, height: 1 } as ImageBitmap);
    const graph = new MaterialGraph({ nodes: [
      { id: 'image', category: 'image', type: 'color3', inputs: { file: { type: 'filename', value: texture } } },
      { id: 'split', category: 'separate3', type: 'color3', inputs: { in: { type: 'color3', connection: { node: 'image' } } } },
      { id: 'math', category: 'multiply', type: 'float', inputs: { in1: { type: 'float', connection: { node: 'split', output: 'outg' } } } }
    ] });
    const pasted = pasteNodes(graph, copyNodes(graph, graph.nodes.map(n => n.id)));
    expect(pasted.graph.nodes.find(n => n.id === pasted.mapping.get('image'))!.inputs!.file.value).toBe(texture);
    expect(pasted.graph.nodes.find(n => n.id === pasted.mapping.get('math'))!.inputs!.in1.connection)
      .toEqual({ node: pasted.mapping.get('split'), output: 'outg' });
  });

  it('recognizes unchanged snapshots without overlooking value, type or connection edits', () => {
    const graph = small();
    const copy = new MaterialGraph({ nodes: graph.nodes, terminal: graph.terminal });
    graph.nodes.forEach((n, i) => expect(sameNode(n, copy.nodes[i])).toBe(true));
    const edited = setParameter(graph, 'scale', 'in2', 0.7);
    expect(sameNode(graph.nodes[0], edited.nodes[0])).toBe(true);
    expect(sameNode(graph.nodes[1], edited.nodes[1])).toBe(false);
    expect(sameNode(graph.nodes[0], { ...graph.nodes[0], type: 'vector3' })).toBe(false);
    expect(sameNode(graph.nodes[0], { ...graph.nodes[0], inputs: { value: { type: 'color3', value: [0.7, 0.2, 0.1] } } })).toBe(false);
    expect(sameNode(graph.nodes[1], connect(graph, { node: 'grain' }, { node: 'scale', port: 'in2' }).nodes[1])).toBe(false);
  });

  it('lays out nodes left of the surface, unused nodes below the used ones', () => {
    const { graph } = addNode(small(), 'noise3d');
    const { positions, surface } = layoutGraph(graph);
    expect(positions.size).toBe(5);
    expect(positions.get('scale')!.x).toBeLessThan(surface.x);
    expect(positions.get('tint')!.x).toBeLessThan(positions.get('scale')!.x);
    const usedBottom = Math.max(...['tint', 'scale', 'pos', 'grain'].map(id => positions.get(id)!.y));
    expect(positions.get('noise3d1')!.y).toBeGreaterThan(usedBottom);
  });
});

describe('MaterialX export', () => {
  it.each(MATERIALX_SAMPLES.map(s => [s.id]))('round-trips %s through the importer', (id) => {
    const imported = graphOf(id);
    const exported = exportMaterialX(imported.graph!, imported.values, imported.name);
    const again = parseMaterialXGraph(exported.text);
    expect(again.warnings).toEqual([]);
    const a = normalizeGraph(imported.graph!), b = normalizeGraph(again.graph!);
    expect(b.diagnostics).toEqual([]);
    expect(b.key).toBe(a.key);
    expect(b.parameters).toEqual(a.parameters);
    for (const [key, value] of Object.entries(imported.values)) {
      if (Array.isArray(value)) (again.values as Record<string, number[]>)[key].forEach((v, i) => expect(v, key).toBeCloseTo(value[i] as number, 6));
      else if (typeof value === 'number') expect((again.values as Record<string, number>)[key], key).toBeCloseTo(value, 6);
      else expect((again.values as Record<string, unknown>)[key], key).toEqual(value);
    }
    expect(exported.images).toEqual([]);
  });

  it('round-trips connected and pasted nodes after making the copy drive a terminal', () => {
    const imported = graphOf('cobblestone');
    const choice = nodeChoices(imported.graph!, { target: { terminal: 'specularRoughness' } })
      .find(c => c.category === 'noise3d' && c.type === 'float')!;
    const added = addConnectedNode(imported.graph!, choice, { target: { terminal: 'specularRoughness' } });
    const pasted = pasteNodes(added.graph, copyNodes(added.graph, [added.id]));
    const graph = connect(pasted.graph, { node: pasted.mapping.get(added.id)! }, { terminal: 'specularRoughness' });
    const again = parseMaterialXGraph(exportMaterialX(graph, imported.values, 'Copied stone').text);
    expect(normalizeGraph(again.graph!).key).toBe(normalizeGraph(graph).key);
    expect(normalizeGraph(again.graph!).parameters).toEqual(normalizeGraph(graph).parameters);
  });

  it('round-trips an edited graph, and writes images with their names and color spaces', () => {
    const imported = graphOf('cobblestone');
    let graph = setParameter(imported.graph!, imported.graph!.nodes[0].id, 'index', 1);
    const added = addNode(graph, 'noise3d');
    graph = connect(added.graph, { node: added.id }, { terminal: 'baseMetalness' });
    const again = parseMaterialXGraph(exportMaterialX(graph, imported.values, 'Edited / stone').text);
    expect(normalizeGraph(again.graph!).key).toBe(normalizeGraph(graph).key);
    expect(normalizeGraph(again.graph!).parameters).toEqual(normalizeGraph(graph).parameters);

    const texture = new Texture({ width: 1, height: 1 } as ImageBitmap);
    texture.colorSpace = 'srgb';
    const image = new MaterialGraph({
      nodes: [{ id: 'albedo', category: 'image', type: 'color3', inputs: { file: { type: 'filename', value: texture } } }],
      terminal: { baseColor: { node: 'albedo' } }
    });
    const result = exportMaterialX(image, {}, 'Tex', () => 'wood albedo.png');
    expect(result.images).toEqual([{ path: 'wood albedo.png', texture }]);
    expect(result.text).toContain('<input name="file" type="filename" value="wood albedo.png" colorspace="srgb_texture" />');
    const read = parseMaterialXGraph(result.text);
    expect([...read.images.values()]).toEqual([expect.objectContaining({ file: 'wood albedo.png', srgb: true })]);
  });
});
