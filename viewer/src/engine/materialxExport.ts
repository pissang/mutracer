import { Texture, type MaterialGraph, type MaterialGraphInput as Input, type MaterialGraphNode as Node, type MaterialGraphType as Type } from '@meimu/mutracer';
import { parseXml } from './materialx';
import { camel, fields } from './materialxGraph';
import standardSurface from './materialxStandardSurface';
import { canonicalTerminal } from './graphEdit';
import type { MaterialValues } from './materialParams';

/** OpenPBR surface inputs, taken from the outputs of the standard_surface translation graph the importer uses. */
const OPENPBR_INPUTS: { name: string; property: string; type: Type }[] = (() => {
  const graph = parseXml(standardSurface).children.find(e => e.tag === 'nodegraph')!;
  const inputs = graph.children.filter(e => e.tag === 'output').map(e => {
    const name = e.attrs.name.replace(/_out$/, ''), key = camel(name);
    return { name, property: fields[key] ?? key, type: e.attrs.type as Type };
  });
  return [...inputs, { name: 'geometry_normal', property: 'normal', type: 'vector3' }];
})();

const WRAPS: Record<string, string> = { repeat: 'periodic', 'clamp-to-edge': 'clamp', 'mirrored-repeat': 'mirror' };
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attrs = (record: Record<string, string | undefined>) =>
  Object.entries(record).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${escape(v!)}"`).join('');
const number = (value: number) => String(Number.isFinite(value) ? value : 0);
const valueText = (value: Input['value']) =>
  Array.isArray(value) ? value.map(number).join(', ') : typeof value === 'number' ? number(value) : typeof value === 'boolean' ? String(value) : String(value);

/** A MaterialX element name: letters, digits and underscores, starting with a letter. */
const sanitize = (id: string) => {
  const name = id.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
  return /^[A-Za-z]/.test(name) ? name : `n_${name}`;
};

/** One image the exported document references. */
export interface ExportedImage {
  /** Path written in the document. */
  path: string;
  texture: Texture;
}

export interface MaterialXExport {
  text: string;
  images: ExportedImage[];
}

/**
 * Writes a material graph and its uniform material values as a MaterialX 1.39
 * document with an `open_pbr_surface`, which the viewer's importer reads back to
 * the same graph structure and parameters. `imageName` names image files.
 */
export function exportMaterialX(graph: MaterialGraph, values: MaterialValues, name: string, imageName: (texture: Texture) => string | undefined = () => undefined): MaterialXExport {
  const used = new Set<string>(), names = new Map<string, string>();
  const unique = (base: string) => {
    let candidate = base;
    for (let i = 2; used.has(candidate); i++) candidate = `${base}_${i}`;
    used.add(candidate);
    return candidate;
  };
  const materialName = unique(sanitize(name || 'Material'));
  const graphName = unique(`NG_${materialName}`), shaderName = unique(`SR_${materialName}`);
  for (const node of graph.nodes) names.set(node.id, unique(sanitize(node.id.slice(node.id.lastIndexOf('/') + 1))));
  const images: ExportedImage[] = [], paths = new Map<Texture, string>(), imagePaths = new Set<string>();
  const imagePath = (texture: Texture, node: string) => {
    if (paths.has(texture)) return paths.get(texture)!;
    const remembered = imageName(texture)?.replace(/[\\/:*?"<>|]+/g, '_');
    const base = remembered || `${node}.png`, dot = base.lastIndexOf('.');
    let path = base;
    for (let i = 2; imagePaths.has(path); i++) path = dot > 0 ? `${base.slice(0, dot)}_${i}${base.slice(dot)}` : `${base}_${i}`;
    imagePaths.add(path);
    paths.set(texture, path);
    images.push({ path, texture });
    return path;
  };

  const lines: string[] = ['<?xml version="1.0"?>', '<materialx version="1.39" colorspace="lin_rec709">', `  <nodegraph name="${graphName}">`];
  for (const node of graph.nodes) lines.push(...nodeLines(node, names, imagePath));
  const outputs: Record<string, string> = {};
  for (const [terminal, edge] of Object.entries(graph.terminal)) {
    if (!edge) continue;
    const key = canonicalTerminal(terminal), input = OPENPBR_INPUTS.find(item => item.property === key);
    if (!input || !names.has(edge.node)) continue;
    const output = `${input.name}_out`;
    outputs[input.name] = output;
    lines.push(`    <output${attrs({ name: output, type: input.type, nodename: names.get(edge.node), output: edge.output && edge.output !== 'out' ? edge.output : undefined })} />`);
  }
  lines.push('  </nodegraph>', `  <open_pbr_surface name="${shaderName}" type="surfaceshader">`);
  for (const input of OPENPBR_INPUTS) {
    if (outputs[input.name]) {
      lines.push(`    <input${attrs({ name: input.name, type: input.type, nodegraph: graphName, output: outputs[input.name] })} />`);
      continue;
    }
    const value = (values as Record<string, unknown>)[input.property];
    if (value === undefined || !(typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value))) continue;
    lines.push(`    <input${attrs({ name: input.name, type: input.type, value: valueText(value as Input['value']) })} />`);
  }
  lines.push('  </open_pbr_surface>', `  <surfacematerial name="${materialName}" type="material">`,
    `    <input name="surfaceshader" type="surfaceshader" nodename="${shaderName}" />`, '  </surfacematerial>', '</materialx>', '');
  return { text: lines.join('\n'), images };
}

function nodeLines(node: Node, names: Map<string, string>, imagePath: (texture: Texture, node: string) => string) {
  const name = names.get(node.id)!;
  const multioutput = node.category === 'gltf_colorimage' || (/^separate[234]$/.test(node.category) && node.inputs?.in?.type === node.type);
  // `abs` is the importer's spelling of the MaterialX `absval` category.
  const category = node.category === 'abs' ? 'absval' : node.category;
  const lines = [`    <${category}${attrs({ name, type: multioutput ? 'multioutput' : node.type })}>`];
  const texture = Object.values(node.inputs ?? {}).find(input => input.value instanceof Texture)?.value as Texture | undefined;
  for (const [port, input] of Object.entries(node.inputs ?? {})) {
    const record: Record<string, string | undefined> = { name: port, type: input.type };
    if (input.connection) {
      const source = names.get(input.connection.node);
      if (!source) continue;
      record.nodename = source;
      if (input.connection.output && input.connection.output !== 'out') record.output = input.connection.output;
    } else if (input.value instanceof Texture) {
      record.value = imagePath(input.value, name);
      if (node.type.startsWith('color')) record.colorspace = input.value.colorSpace === 'linear' ? 'lin_rec709' : 'srgb_texture';
    } else if ((port === 'uaddressmode' || port === 'vaddressmode') && texture) {
      record.value = WRAPS[port === 'uaddressmode' ? texture.wrapS : texture.wrapT] ?? valueText(input.value);
    } else if (input.value !== undefined) record.value = valueText(input.value);
    else continue;
    lines.push(`      <input${attrs(record)} />`);
  }
  lines.push(`    </${category}>`);
  return lines;
}
