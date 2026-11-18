/**
 * MaterialX import, a practical subset rather than a shader generator.
 *
 * Reads a `surfacematerial` and its `standard_surface`, `open_pbr_surface`,
 * `gltf_pbr` or `UsdPreviewSurface` shader. Node graphs are evaluated on the
 * CPU: constant nodes and math on constants fold to values, and `image`
 * nodes become texture slots. Affine math on a texture (`mix(min, max, tex)`,
 * `multiply`, `add`, `remap`, `invert`, ...) is kept as gain and bias: a pure
 * gain becomes the material factor, anything else is baked into a new map by
 * the importer. Other nodes are reported and their inputs keep the shader
 * default. No DOM APIs here, so the parser also runs in tests.
 */
import type { MaterialValues, TextureKey } from './materialParams';

import {parseXml, type XmlElement} from '../../../src/materialx/xml';
export {parseXml, type XmlElement} from '../../../src/materialx/xml';

// ------------------------------------------------------------ Evaluation

/** An image read through an affine remap: `gain * image[channel] + bias`, per component. */
export interface TextureRef {
  file: string;
  srgb: boolean;
  /** The extracted channel, or `null` for the whole image. */
  channel: number | null;
  uvScale: [number, number];
  gain: number[];
  bias: number[];
  /** Read through a `normalmap` node. */
  normal?: boolean;
}

type Result =
  | { kind: 'value'; value: number[] }
  | { kind: 'texture'; texture: TextureRef }
  /** Unconnected geometric data such as `normal`; the shader uses its default. */
  | { kind: 'default' }
  | { kind: 'unsupported' };

const value = (v: number[]): Result => ({ kind: 'value', value: v });
const DEFAULT: Result = { kind: 'default' };
const UNSUPPORTED: Result = { kind: 'unsupported' };

const at = (v: number[], i: number) => v[v.length === 1 ? 0 : i] ?? v[v.length - 1];
const width = (...vs: number[][]) => Math.max(...vs.map((v) => v.length));
const zip = (a: number[], b: number[], f: (x: number, y: number) => number) =>
  Array.from({ length: width(a, b) }, (_, i) => f(at(a, i), at(b, i)));

const sameImage = (a: TextureRef, b: TextureRef) =>
  a.file === b.file && a.channel === b.channel && a.uvScale[0] === b.uvScale[0] && a.uvScale[1] === b.uvScale[1] && !a.normal && !b.normal;

function add(a: Result, b: Result): Result {
  if (a.kind === 'value' && b.kind === 'value') return value(zip(a.value, b.value, (x, y) => x + y));
  if (a.kind === 'texture' && b.kind === 'value') return { kind: 'texture', texture: { ...a.texture, bias: zip(a.texture.bias, b.value, (x, y) => x + y) } };
  if (a.kind === 'value' && b.kind === 'texture') return add(b, a);
  if (a.kind === 'texture' && b.kind === 'texture' && sameImage(a.texture, b.texture)) {
    return { kind: 'texture', texture: { ...a.texture, gain: zip(a.texture.gain, b.texture.gain, (x, y) => x + y), bias: zip(a.texture.bias, b.texture.bias, (x, y) => x + y) } };
  }
  return UNSUPPORTED;
}

function multiply(a: Result, b: Result): Result {
  if (a.kind === 'value' && b.kind === 'value') return value(zip(a.value, b.value, (x, y) => x * y));
  if (a.kind === 'texture' && b.kind === 'value') {
    const scale = (v: number[]) => zip(v, b.value, (x, y) => x * y);
    return { kind: 'texture', texture: { ...a.texture, gain: scale(a.texture.gain), bias: scale(a.texture.bias) } };
  }
  if (a.kind === 'value' && b.kind === 'texture') return multiply(b, a);
  return UNSUPPORTED;
}

const negate = (a: Result) => multiply(a, value([-1]));
const subtract = (a: Result, b: Result) => add(a, negate(b));

/** Default values of node inputs that are commonly left unconnected. */
const NODE_DEFAULTS: Record<string, Record<string, number[]>> = {
  multiply: { in1: [0], in2: [1] },
  divide: { in1: [0], in2: [1] },
  add: { in1: [0], in2: [0] },
  subtract: { in1: [0], in2: [0] },
  mix: { fg: [0], bg: [0], mix: [0] },
  remap: { in: [0], inlow: [0], inhigh: [1], outlow: [0], outhigh: [1] },
  invert: { in: [0], amount: [1] },
  clamp: { in: [0], low: [0], high: [1] },
  power: { in1: [0], in2: [1] },
  max: { in1: [0], in2: [0] },
  min: { in1: [0], in2: [0] }
};

const COMPONENTS: Record<string, number> = { r: 0, g: 1, b: 2, a: 3, x: 0, y: 1, z: 2, w: 3 };

function parseValue(text: string | undefined, type: string | undefined): number[] | null {
  if (text === undefined) return null;
  if (type === 'boolean') return [text.trim() === 'true' ? 1 : 0];
  const numbers = text.split(',').map((s) => Number(s.trim()));
  return numbers.length && numbers.every(Number.isFinite) ? numbers : null;
}

const typeWidth = (type: string | undefined) => {
  const match = /(\d)$/.exec(type ?? '');
  return match ? Number(match[1]) : 1;
};

class Evaluator {
  readonly warnings = new Set<string>();
  private cache = new Map<XmlElement, Result>();
  private active = new Set<XmlElement>();

  constructor(private readonly root: XmlElement) {}

  /** Finds a named child of `scope`, then of its enclosing scopes. */
  find(scope: XmlElement, name: string): XmlElement | undefined {
    for (let s: XmlElement | null = scope; s; s = s.parent) {
      const found = s.children.find((c) => c.attrs.name === name && c.tag !== 'input' && c.tag !== 'output');
      if (found) return found;
    }
    return undefined;
  }

  graph(name: string) {
    return this.root.children.find((c) => c.tag === 'nodegraph' && c.attrs.name === name);
  }

  /** Evaluates an `<input>` (or nodegraph `<output>`) element. */
  input(element: XmlElement | undefined, fallback: number[] | null = null): Result {
    if (!element) return fallback ? value(fallback) : DEFAULT;
    const scope = element.parent?.tag === 'nodegraph' && element.tag === 'output' ? element.parent : scopeOf(element);
    const { nodename, nodegraph, output, interfacename } = element.attrs;
    if (nodegraph) {
      const graph = this.graph(nodegraph);
      if (!graph) return this.unsupported(`missing nodegraph "${nodegraph}"`);
      const out = graph.children.find((c) => c.tag === 'output' && (!output || c.attrs.name === output));
      return out ? this.input(out) : this.unsupported(`missing output "${output}" in "${nodegraph}"`);
    }
    if (nodename) {
      const node = this.find(scope, nodename);
      if (!node) return this.unsupported(`missing node "${nodename}"`);
      return this.node(node, output);
    }
    if (interfacename) {
      const graph = closest(element, 'nodegraph');
      const declared = graph?.children.find((c) => c.tag === 'input' && c.attrs.name === interfacename);
      return this.input(declared, fallback);
    }
    if (output && element.tag === 'input') {
      // An output of the enclosing node graph.
      const graph = closest(element, 'nodegraph');
      const out = graph?.children.find((c) => c.tag === 'output' && c.attrs.name === output);
      return out ? this.input(out) : DEFAULT;
    }
    const parsed = parseValue(element.attrs.value, element.attrs.type);
    if (parsed) return value(parsed);
    return fallback ? value(fallback) : DEFAULT;
  }

  private unsupported(reason: string): Result {
    this.warnings.add(reason);
    return UNSUPPORTED;
  }

  private node(node: XmlElement, output?: string): Result {
    const key = node;
    if (!output) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    if (this.active.has(node)) return this.unsupported(`cycle at node "${node.attrs.name}"`);
    this.active.add(node);
    let result: Result;
    try {
      result = this.evaluate(node, output);
    } finally {
      this.active.delete(node);
    }
    if (!output) this.cache.set(key, result);
    return result;
  }

  private arg(node: XmlElement, name: string) {
    const element = node.children.find((c) => c.tag === 'input' && c.attrs.name === name);
    return this.input(element, NODE_DEFAULTS[node.tag]?.[name] ?? null);
  }

  private evaluate(node: XmlElement, output?: string): Result {
    const arg = (name: string) => this.arg(node, name);
    switch (node.tag) {
      case 'constant': return arg('value');
      case 'dot': return arg('in');
      case 'convert': {
        const input = arg('in');
        if (input.kind !== 'value' || input.value.length !== 1) return input;
        return value(new Array(typeWidth(node.attrs.type)).fill(input.value[0]));
      }
      case 'extract': {
        const index = this.arg(node, 'index');
        return index.kind === 'value' ? channel(arg('in'), index.value[0]) : this.unsupported('extract with a connected index');
      }
      case 'separate2': case 'separate3': case 'separate4': {
        const component = COMPONENTS[(output ?? 'outr').slice(-1)];
        return component === undefined ? UNSUPPORTED : channel(arg('in'), component);
      }
      case 'swizzle': {
        const channels = node.children.find((c) => c.attrs.name === 'channels')?.attrs.value ?? '';
        const input = arg('in');
        if (input.kind === 'value') return value([...channels].map((c) => at(input.value, COMPONENTS[c] ?? 0)));
        return channels.length === 1 ? channel(input, COMPONENTS[channels] ?? 0) : this.unsupported('swizzle of a texture');
      }
      case 'add': return this.check(node, add(arg('in1'), arg('in2')));
      case 'subtract': return this.check(node, subtract(arg('in1'), arg('in2')));
      case 'multiply': return this.check(node, multiply(arg('in1'), arg('in2')));
      case 'divide': {
        const divisor = arg('in2');
        if (divisor.kind !== 'value') return this.unsupported('divide by a texture');
        return this.check(node, multiply(arg('in1'), value(divisor.value.map((d) => (d ? 1 / d : 0)))));
      }
      case 'mix': {
        // bg + (fg - bg) * mix
        const bg = arg('bg');
        return this.check(node, add(bg, multiply(subtract(arg('fg'), bg), arg('mix'))));
      }
      case 'remap': {
        const [inlow, inhigh, outlow, outhigh] = ['inlow', 'inhigh', 'outlow', 'outhigh'].map(arg);
        if ([inlow, inhigh, outlow, outhigh].some((r) => r.kind !== 'value')) return this.unsupported('remap with connected ranges');
        const v = (r: Result) => (r as { value: number[] }).value;
        const scale = zip(zip(v(outhigh), v(outlow), (a, b) => a - b), zip(v(inhigh), v(inlow), (a, b) => a - b), (a, b) => (b ? a / b : 0));
        return this.check(node, add(multiply(subtract(arg('in'), inlow), value(scale)), outlow));
      }
      case 'invert': return this.check(node, subtract(arg('amount'), arg('in')));
      case 'clamp': {
        const input = arg('in');
        const [low, high] = [arg('low'), arg('high')];
        if (input.kind === 'value' && low.kind === 'value' && high.kind === 'value') {
          return value(zip(zip(input.value, low.value, Math.max), high.value, Math.min));
        }
        // Images are already in range; the clamp only matters for their remaps.
        return input;
      }
      case 'power': case 'max': case 'min': {
        const [a, b] = [arg('in1'), arg('in2')];
        if (a.kind !== 'value' || b.kind !== 'value') return this.unsupported(`${node.tag} of a texture`);
        const f = node.tag === 'power' ? Math.pow : node.tag === 'max' ? Math.max : Math.min;
        return value(zip(a.value, b.value, f));
      }
      case 'image': case 'tiledimage': return this.image(node);
      case 'normalmap': {
        const input = arg('in');
        if (input.kind !== 'texture') return input;
        const scale = this.arg(node, 'scale');
        if (scale.kind === 'value' && Math.abs(scale.value[0] - 1) > 1e-6) this.warnings.add('normal map strength (uses 1)');
        return { kind: 'texture', texture: { ...input.texture, normal: true } };
      }
      case 'normal': case 'tangent': case 'bitangent': case 'texcoord': case 'position': return DEFAULT;
      default:
        return this.unsupported(`"${node.tag}" node`);
    }
  }

  private check(node: XmlElement, result: Result) {
    return result.kind === 'unsupported' ? this.unsupported(`"${node.tag}" combining textures`) : result;
  }

  private image(node: XmlElement): Result {
    const fileInput = node.children.find((c) => c.tag === 'input' && c.attrs.name === 'file');
    let file = fileInput?.attrs.value?.trim();
    if (fileInput?.attrs.interfacename) {
      const graph = closest(node, 'nodegraph');
      file = graph?.children.find((c) => c.tag === 'input' && c.attrs.name === fileInput.attrs.interfacename)?.attrs.value?.trim();
    }
    if (!file) return this.unsupported(`image "${node.attrs.name}" without a file`);
    const prefix = inherited(fileInput!, 'fileprefix') ?? '';
    const colorspace = fileInput!.attrs.colorspace ?? inherited(node, 'colorspace') ?? '';
    let uvScale: [number, number] = [1, 1];
    const texcoord = node.children.find((c) => c.tag === 'input' && c.attrs.name === 'texcoord');
    if (texcoord) {
      const scale = this.uv(texcoord);
      if (scale) uvScale = scale;
      else this.warnings.add(`texture coordinates of "${node.attrs.name}" (uses the mesh UVs)`);
    }
    if (node.tag === 'tiledimage') {
      const tiling = this.arg(node, 'uvtiling');
      if (tiling.kind === 'value') uvScale = [uvScale[0] * at(tiling.value, 0), uvScale[1] * at(tiling.value, 1)];
    }
    return {
      kind: 'texture',
      texture: { file: prefix + file, srgb: /srgb/i.test(colorspace), channel: null, uvScale, gain: [1], bias: [0] }
    };
  }

  /** The UV repeat of a texcoord chain, or `null` when it is not a plain scale. */
  private uv(element: XmlElement): [number, number] | null {
    const { nodename, nodegraph, interfacename } = element.attrs;
    if (nodegraph || interfacename) return null;
    if (!nodename) return [1, 1];
    const node = this.find(scopeOf(element), nodename);
    if (!node) return null;
    const input = (name: string) => node.children.find((c) => c.tag === 'input' && c.attrs.name === name);
    switch (node.tag) {
      case 'texcoord': return [1, 1];
      case 'dot': case 'convert': return input('in') ? this.uv(input('in')!) : [1, 1];
      case 'multiply': case 'divide': {
        const [a, b] = [input('in1'), input('in2')];
        for (const [uv, factor] of [[a, b], [b, a]] as const) {
          if (!uv || !factor) continue;
          const scale = uv.attrs.nodename ? this.uv(uv) : null;
          const amount = this.input(factor);
          if (!scale || amount.kind !== 'value') continue;
          const f = (i: number) => (node.tag === 'divide' ? 1 / at(amount.value, i) : at(amount.value, i));
          if (node.tag === 'divide' && uv === b) return null;
          return [scale[0] * f(0), scale[1] * f(1)];
        }
        return null;
      }
      case 'place2d': {
        const scale = this.arg(node, 'scale');
        const base = input('texcoord') ? this.uv(input('texcoord')!) : [1, 1];
        if (!base || scale.kind === 'unsupported' || scale.kind === 'texture') return null;
        for (const name of ['offset', 'rotate', 'pivot']) {
          const r = this.arg(node, name);
          if (r.kind === 'value' && r.value.some((x) => x !== 0)) this.warnings.add(`place2d ${name} (ignored)`);
        }
        const s = scale.kind === 'value' ? scale.value : [1];
        return [base[0] / at(s, 0), base[1] / at(s, 1)];
      }
      default: return null;
    }
  }
}

function channel(input: Result, index: number): Result {
  if (input.kind === 'value') return value([at(input.value, index)]);
  if (input.kind !== 'texture') return input;
  if (input.texture.channel !== null) return UNSUPPORTED;
  const t = input.texture;
  return { kind: 'texture', texture: { ...t, channel: index, gain: [at(t.gain, index)], bias: [at(t.bias, index)] } };
}

/** The element whose children a node name resolves against: its nodegraph or the document. */
function scopeOf(element: XmlElement) {
  let scope = element.parent;
  while (scope && scope.tag !== 'nodegraph' && scope.tag !== 'materialx') scope = scope.parent;
  return scope ?? element;
}

function closest(element: XmlElement, tag: string) {
  let e: XmlElement | null = element.parent;
  while (e && e.tag !== tag) e = e.parent;
  return e;
}

function inherited(element: XmlElement, attribute: string) {
  for (let e: XmlElement | null = element; e; e = e.parent) if (e.attrs[attribute] !== undefined) return e.attrs[attribute];
  return undefined;
}

// --------------------------------------------------------------- Mapping

/** Copies `channel` of `file`, remapped by `gain * x + bias`, into `target` of a baked map. */
export interface ChannelBake {
  target: number;
  file: string;
  channel: number;
  gain: number;
  bias: number;
}

/** A texture slot: an image used as is, or a map baked from image channels. */
export interface MapPlan {
  file: string;
  srgb?: boolean;
  /** Present when the map must be baked; `file` then sets its size. */
  bake?: ChannelBake[];
}

export interface MaterialXMaterial {
  name: string;
  shader: string;
  values: MaterialValues;
  maps: Partial<Record<TextureKey, MapPlan>>;
  uvScale: [number, number];
  warnings: string[];
}

type ScalarSlot = 'roughness' | 'metalness' | 'transmission' | 'displacement';
/** The channel each scalar slot reads. */
const SLOT_CHANNEL: Record<ScalarSlot, number> = { roughness: 1, metalness: 2, transmission: 0, displacement: 0 };
const SLOT_KEY: Record<ScalarSlot, TextureKey> = {
  roughness: 'roughnessMap', metalness: 'metalnessMap', transmission: 'transmissionMap', displacement: 'displacementMap'
};

type Key = keyof MaterialValues;
type Color = [number, number, number];

class Mapper {
  readonly values: MaterialValues = {};
  readonly maps: Partial<Record<TextureKey, MapPlan>> = {};
  private scalarMaps: Partial<Record<ScalarSlot, TextureRef>> = {};
  private uvScales: [number, number][] = [];
  readonly warnings: Set<string>;

  constructor(private readonly evaluator: Evaluator, private readonly shader: XmlElement) {
    this.warnings = evaluator.warnings;
  }

  get(name: string, fallback: number[]): Result {
    const element = this.shader.children.find((c) => c.tag === 'input' && c.attrs.name === name);
    const result = this.evaluator.input(element, fallback);
    return result.kind === 'unsupported' || result.kind === 'default' ? value(fallback) : result;
  }

  /** A constant input; textures fall back to the default with a warning. */
  number(name: string, fallback: number): number {
    const result = this.get(name, [fallback]);
    if (result.kind === 'value') return result.value.reduce((a, b) => a + b, 0) / result.value.length;
    this.warnings.add(`texture on ${name} (uses ${fallback})`);
    return fallback;
  }

  color(name: string, fallback: number[]): Color {
    const result = this.get(name, fallback);
    if (result.kind === 'value') return [0, 1, 2].map((i) => at(result.value, i)) as Color;
    this.warnings.add(`texture on ${name}`);
    return [0, 1, 2].map((i) => at(fallback, i)) as Color;
  }

  /** A scalar that may be textured through `slot`. `scale` converts units. */
  scalar(key: Key, name: string, fallback: number, slot?: ScalarSlot, scale = 1) {
    const result = this.get(name, [fallback]);
    if (result.kind === 'texture' && slot && !result.texture.normal) {
      this.scalarMaps[slot] = result.texture;
      this.uvScales.push(result.texture.uvScale);
      this.values[key] = scale;
      return;
    }
    this.values[key] = this.number(name, fallback) * scale;
  }

  /** A color that may be textured through `slot`; `weight` multiplies it. */
  colorMap(key: Key, name: string, fallback: Color, slot: TextureKey | null, weight = 1) {
    const result = this.get(name, fallback);
    if (result.kind === 'texture' && slot && !result.texture.normal) {
      const t = result.texture;
      if (t.bias.some((b) => Math.abs(b) > 1e-4)) this.warnings.add(`offset on the ${name} texture (ignored)`);
      if (t.channel !== null) this.warnings.add(`single channel on the ${name} texture (uses the color image)`);
      if (slot === 'map' && !t.srgb) this.warnings.add(`${name} texture is read as sRGB`);
      this.maps[slot] = { file: t.file, srgb: t.srgb };
      this.uvScales.push(t.uvScale);
      this.values[key] = [0, 1, 2].map((i) => at(t.gain, i) * weight) as Color;
      return;
    }
    this.values[key] = this.color(name, fallback).map((c) => c * weight) as Color;
  }

  normal(name: string) {
    const element = this.shader.children.find((c) => c.tag === 'input' && c.attrs.name === name);
    const result = this.evaluator.input(element);
    if (result.kind === 'texture') {
      this.maps.normalMap = { file: result.texture.file };
      this.uvScales.push(result.texture.uvScale);
    }
  }

  displacement(material: XmlElement) {
    const input = material.children.find((c) => c.tag === 'input' && c.attrs.name === 'displacementshader');
    if (!input) return;
    const node = input.attrs.nodename ? this.evaluator.find(scopeOf(input), input.attrs.nodename) : undefined;
    if (!node || node.tag !== 'displacement') {
      if (input.attrs.nodename || input.attrs.nodegraph) this.warnings.add('displacement shader (only "displacement" nodes)');
      return;
    }
    const height = this.evaluator.input(node.children.find((c) => c.tag === 'input' && c.attrs.name === 'displacement'));
    const scaleResult = this.evaluator.input(node.children.find((c) => c.tag === 'input' && c.attrs.name === 'scale'), [1]);
    const scale = scaleResult.kind === 'value' ? scaleResult.value[0] : 1;
    if (height.kind !== 'texture') return;
    const t = height.texture;
    this.scalarMaps.displacement = { ...t, gain: [1], bias: [0] };
    this.values.displacementScale = at(t.gain, 0) * scale;
    this.values.displacementBias = at(t.bias, 0) * scale;
  }

  /** Turns the scalar textures into map plans, sharing a packed map where possible. */
  finish(): [number, number] {
    const { roughness, metalness } = this.scalarMaps;
    const plain = (t: TextureRef, channel: number) =>
      (t.channel === null || t.channel === channel) && t.bias.every((b) => Math.abs(b) < 1e-6);
    const bake = (target: number, t: TextureRef): ChannelBake =>
      ({ target, file: t.file, channel: t.channel ?? 0, gain: at(t.gain, 0), bias: at(t.bias, 0) });

    if (roughness && metalness && roughness.file === metalness.file) {
      // One packed map, as in ORM textures.
      if (plain(roughness, 1) && plain(metalness, 2) && roughness.channel !== null && metalness.channel !== null) {
        this.maps.metallicRoughnessMap = { file: roughness.file };
        this.values.specularRoughness = Number(this.values.specularRoughness) * at(roughness.gain, 0);
        this.values.baseMetalness = Number(this.values.baseMetalness) * at(metalness.gain, 0);
      } else {
        this.maps.metallicRoughnessMap = { file: roughness.file, bake: [bake(1, roughness), bake(2, metalness)] };
      }
      delete this.scalarMaps.roughness;
      delete this.scalarMaps.metalness;
    }
    for (const [slot, t] of Object.entries(this.scalarMaps) as [ScalarSlot, TextureRef][]) {
      const target = SLOT_CHANNEL[slot];
      const key = SLOT_KEY[slot];
      if (slot === 'displacement') {
        this.maps[key] = t.channel === null || t.channel === target ? { file: t.file } : { file: t.file, bake: [bake(target, { ...t, gain: [1], bias: [0] })] };
        continue;
      }
      const factor = slot === 'roughness' ? 'specularRoughness' : slot === 'metalness' ? 'baseMetalness' : 'transmissionWeight';
      const gain = at(t.gain, 0);
      if (plain(t, target) && gain >= 0 && gain <= 1) {
        this.maps[key] = { file: t.file };
        this.values[factor] = Number(this.values[factor]) * gain;
      } else {
        this.maps[key] = { file: t.file, bake: [bake(target, t)] };
      }
    }
    if (this.maps.metallicRoughnessMap?.bake) {
      this.values.specularRoughness = 1;
      this.values.baseMetalness = 1;
    }

    const [first] = this.uvScales;
    if (first && this.uvScales.some((s) => s[0] !== first[0] || s[1] !== first[1])) {
      this.warnings.add('textures with different UV scales (uses the first)');
    }
    return first ?? [1, 1];
  }
}

const SHADERS: Record<string, (m: Mapper) => void> = {
  standard_surface(m) {
    const base = m.number('base', 0.8);
    m.colorMap('baseColor', 'base_color', [1, 1, 1], 'map', base);
    m.scalar('baseDiffuseRoughness', 'diffuse_roughness', 0);
    m.scalar('baseMetalness', 'metalness', 0, 'metalness');
    m.scalar('specularWeight', 'specular', 1);
    m.colorMap('specularColor', 'specular_color', [1, 1, 1], null);
    m.scalar('specularRoughness', 'specular_roughness', 0.2, 'roughness');
    m.scalar('specularIor', 'specular_IOR', 1.5);
    m.scalar('specularAnisotropy', 'specular_anisotropy', 0);
    m.scalar('transmissionWeight', 'transmission', 0, 'transmission');
    m.colorMap('transmissionColor', 'transmission_color', [1, 1, 1], null);
    m.scalar('transmissionDepth', 'transmission_depth', 0);
    const abbe = m.number('transmission_dispersion', 0);
    // Standard Surface gives an Abbe number; the dispersion scale is relative to Abbe 20.
    m.values.transmissionDispersionScale = abbe > 0 ? Math.min(1, 20 / abbe) : 0;
    if (m.color('transmission_scatter', [0, 0, 0]).some((c) => c > 0)) m.warnings.add('transmission_scatter (ignored)');
    m.scalar('subsurfaceWeight', 'subsurface', 0);
    m.colorMap('subsurfaceColor', 'subsurface_color', [1, 1, 1], null);
    m.values.subsurfaceRadiusScale = m.color('subsurface_radius', [1, 1, 1]);
    m.scalar('subsurfaceRadius', 'subsurface_scale', 1);
    m.scalar('fuzzWeight', 'sheen', 0);
    m.colorMap('fuzzColor', 'sheen_color', [1, 1, 1], null);
    m.scalar('fuzzRoughness', 'sheen_roughness', 0.3);
    m.scalar('coatWeight', 'coat', 0);
    m.colorMap('coatColor', 'coat_color', [1, 1, 1], null);
    m.scalar('coatRoughness', 'coat_roughness', 0.1);
    m.scalar('coatIor', 'coat_IOR', 1.5);
    // Thin-film thickness is in nanometres here and micrometres in OpenPBR.
    const thickness = m.number('thin_film_thickness', 0);
    m.values.thinFilmWeight = thickness > 0 ? 1 : 0;
    if (thickness > 0) m.values.thinFilmThickness = thickness / 1000;
    m.scalar('thinFilmIor', 'thin_film_IOR', 1.5);
    m.values.emissionLuminance = m.number('emission', 0);
    m.colorMap('emissionColor', 'emission_color', [1, 1, 1], 'emissiveMap');
    const opacity = m.color('opacity', [1, 1, 1]);
    m.values.opacity = (opacity[0] + opacity[1] + opacity[2]) / 3;
    m.values.thinWalled = m.number('thin_walled', 0) > 0;
    m.normal('normal');
  },
  open_pbr_surface(m) {
    m.colorMap('baseColor', 'base_color', [0.8, 0.8, 0.8], 'map', m.number('base_weight', 1));
    m.scalar('baseDiffuseRoughness', 'base_diffuse_roughness', 0);
    m.scalar('baseMetalness', 'base_metalness', 0, 'metalness');
    m.scalar('specularWeight', 'specular_weight', 1);
    m.colorMap('specularColor', 'specular_color', [1, 1, 1], null);
    m.scalar('specularRoughness', 'specular_roughness', 0.3, 'roughness');
    m.scalar('specularIor', 'specular_ior', 1.5);
    m.scalar('specularAnisotropy', 'specular_roughness_anisotropy', 0);
    m.scalar('transmissionWeight', 'transmission_weight', 0, 'transmission');
    m.colorMap('transmissionColor', 'transmission_color', [1, 1, 1], null);
    m.scalar('transmissionDepth', 'transmission_depth', 0);
    m.scalar('transmissionDispersionScale', 'transmission_dispersion_scale', 0);
    m.scalar('subsurfaceWeight', 'subsurface_weight', 0);
    m.colorMap('subsurfaceColor', 'subsurface_color', [0.8, 0.8, 0.8], null);
    m.scalar('subsurfaceRadius', 'subsurface_radius', 1);
    m.values.subsurfaceRadiusScale = m.color('subsurface_radius_scale', [1, 0.5, 0.25]);
    m.scalar('fuzzWeight', 'fuzz_weight', 0);
    m.colorMap('fuzzColor', 'fuzz_color', [1, 1, 1], null);
    m.scalar('fuzzRoughness', 'fuzz_roughness', 0.5);
    m.scalar('coatWeight', 'coat_weight', 0);
    m.colorMap('coatColor', 'coat_color', [1, 1, 1], null);
    m.scalar('coatRoughness', 'coat_roughness', 0);
    m.scalar('coatIor', 'coat_ior', 1.6);
    m.scalar('thinFilmWeight', 'thin_film_weight', 0);
    m.scalar('thinFilmThickness', 'thin_film_thickness', 0.5);
    m.scalar('thinFilmIor', 'thin_film_ior', 1.4);
    m.scalar('emissionLuminance', 'emission_luminance', 0);
    m.colorMap('emissionColor', 'emission_color', [1, 1, 1], 'emissiveMap');
    m.scalar('opacity', 'geometry_opacity', 1);
    m.values.thinWalled = m.number('geometry_thin_walled', 0) > 0;
    m.normal('geometry_normal');
  },
  gltf_pbr(m) {
    m.colorMap('baseColor', 'base_color', [1, 1, 1], 'map');
    m.scalar('baseMetalness', 'metallic', 1, 'metalness');
    m.scalar('specularRoughness', 'roughness', 1, 'roughness');
    m.scalar('specularIor', 'ior', 1.5);
    m.scalar('specularWeight', 'specular', 1);
    m.scalar('transmissionWeight', 'transmission', 0, 'transmission');
    const distance = m.number('attenuation_distance', Infinity);
    if (Number.isFinite(distance)) {
      m.values.transmissionColor = m.color('attenuation_color', [1, 1, 1]);
      m.values.transmissionDepth = distance;
    }
    m.scalar('opacity', 'alpha', 1);
    m.colorMap('emissionColor', 'emissive', [0, 0, 0], 'emissiveMap');
    m.values.emissionLuminance = m.number('emissive_strength', 1);
    m.scalar('coatWeight', 'clearcoat', 0);
    m.scalar('coatRoughness', 'clearcoat_roughness', 0);
    m.values.coatIor = 1.5;
    m.colorMap('fuzzColor', 'sheen_color', [0, 0, 0], null);
    m.values.fuzzWeight = (m.values.fuzzColor as Color).some((c) => c > 0) ? 1 : 0;
    m.scalar('fuzzRoughness', 'sheen_roughness', 0);
    m.scalar('thinFilmWeight', 'iridescence', 0);
    m.scalar('thinFilmIor', 'iridescence_ior', 1.3);
    m.scalar('thinFilmThickness', 'iridescence_thickness', 100, undefined, 1 / 1000);
    m.normal('normal');
  },
  UsdPreviewSurface(m) {
    m.colorMap('baseColor', 'diffuseColor', [0.18, 0.18, 0.18], 'map');
    m.scalar('baseMetalness', 'metallic', 0, 'metalness');
    m.scalar('specularRoughness', 'roughness', 0.5, 'roughness');
    m.scalar('specularIor', 'ior', 1.5);
    m.scalar('coatWeight', 'clearcoat', 0);
    m.scalar('coatRoughness', 'clearcoatRoughness', 0.01);
    m.colorMap('emissionColor', 'emissiveColor', [0, 0, 0], 'emissiveMap');
    m.values.emissionLuminance = 1;
    m.scalar('opacity', 'opacity', 1);
    m.normal('normal');
  }
};

/** Shader node types that can be imported. */
export const MATERIALX_SHADERS = Object.keys(SHADERS);

/**
 * Reads the first `surfacematerial` of a MaterialX document (or the one named
 * `materialName`) into viewer material values and texture plans. Values cover
 * every shader input, so they replace the whole material.
 */
export function parseMaterialX(text: string, materialName?: string): MaterialXMaterial {
  const root = parseXml(text);
  if (root.tag !== 'materialx') throw new Error('Not a MaterialX document');
  const materials = root.children.filter((c) => c.tag === 'surfacematerial');
  const material = materials.find((m) => !materialName || m.attrs.name === materialName);
  if (!material) throw new Error(materialName ? `No material named "${materialName}"` : 'The document has no surfacematerial');
  const evaluator = new Evaluator(root);
  const input = material.children.find((c) => c.tag === 'input' && c.attrs.name === 'surfaceshader');
  const shader = input?.attrs.nodename ? evaluator.find(root, input.attrs.nodename) : undefined;
  if (!shader) throw new Error(`Material "${material.attrs.name}" has no surface shader`);
  const map = SHADERS[shader.tag];
  if (!map) throw new Error(`Unsupported shader "${shader.tag}"; supported: ${MATERIALX_SHADERS.join(', ')}`);
  const mapper = new Mapper(evaluator, shader);
  map(mapper);
  mapper.displacement(material);
  const uvScale = mapper.finish();
  return {
    name: material.attrs.name || 'MaterialX',
    shader: shader.tag,
    values: mapper.values,
    maps: mapper.maps,
    uvScale,
    warnings: [...mapper.warnings]
  };
}

/**
 * Applies channel bakes to RGBA pixels. `sources` holds the decoded pixels of
 * each file at the output size; untouched channels stay 0, alpha 255.
 */
export function bakeChannels(bakes: ChannelBake[], sources: Map<string, Uint8ClampedArray>, pixels: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (const { target, file, channel, gain, bias } of bakes) {
    const source = sources.get(file);
    if (!source) continue;
    for (let p = 0; p < pixels; p++) {
      out[p * 4 + target] = Math.round(Math.min(1, Math.max(0, gain * (source[p * 4 + channel] / 255) + bias)) * 255);
    }
  }
  return out;
}
