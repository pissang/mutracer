import type { GraphNode, NormalizedGraph } from './normalize.js';
import { width } from './nodes.js';
import Texture from '../../scene/Texture.js';
export type Numeric = number[];
export interface GraphContext {
    uv?: Numeric;
    uv1?: Numeric;
    position?: Numeric;
    normal?: Numeric;
    tangent?: Numeric;
    bitangent?: Numeric;
    objectPosition?: Numeric;
    objectNormal?: Numeric;
    objectTangent?: Numeric;
    objectBitangent?: Numeric;
    sample?: (texture: Texture, uv: Numeric) => Numeric;
}
export function numeric(value: unknown): Numeric { return Array.isArray(value) ? [...value] : [value === 'world' ? 1 : typeof value === 'string' ? 0 : Number(value ?? 0)]; }
const zip = (a: Numeric, b: Numeric, f: (a: number, b: number) => number) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => f(a[i % a.length], b[i % b.length]));
const normalize = (a: Numeric) => { const length = Math.hypot(...a); return a.map(v => v / length); };
export function evaluateNode(node: GraphNode, a: Record<string, Numeric>, context: GraphContext = {}, texture?: Texture): Numeric {
    const c = node.category, v = a.in, first = a.in1, second = a.in2;
    switch (c) {
        case 'constant': return a.value;
        case 'texcoord': return a.index[0] === 1 ? (context.uv1 ?? [0, 0]) : (context.uv ?? [0, 0]);
        case 'position': return (a.space[0] === 0 ? context.objectPosition : undefined) ?? context.position ?? [0, 0, 0];
        case 'normal': return (a.space[0] === 0 ? context.objectNormal : undefined) ?? context.normal ?? [0, 0, 1];
        case 'tangent': return (a.space[0] === 0 ? context.objectTangent : undefined) ?? context.tangent ?? [1, 0, 0];
        case 'bitangent': return (a.space[0] === 0 ? context.objectBitangent : undefined) ?? context.bitangent ?? [0, 1, 0];
        case 'image':
        case 'tiledimage': {
            let uv = a.texcoord;
            if (c === 'tiledimage')
                uv = zip(zip(zip(uv, a.uvtiling, (x, y) => x * y), a.uvoffset, (x, y) => x - y), zip(a.realworldimagesize, a.realworldtilesize, (x, y) => x / y), (x, y) => x / y);
            const sampled = texture && context.sample?.(texture, uv);
            if (!sampled)
                return a.default;
            return sampled.slice(0, width(node.type));
        }
        case 'place2d': {
            let uv = zip(a.texcoord, a.pivot, (x, y) => x - y);
            const rotate = (p: Numeric) => { const angle = a.rotate[0] * Math.PI / 180, s = Math.sin(angle), c = Math.cos(angle); return [c * p[0] - s * p[1], s * p[0] + c * p[1]]; };
            if (a.operationorder[0] === 0)
                uv = zip(rotate(zip(uv, a.scale, (x, y) => x / y)), a.offset, (x, y) => x - y);
            else
                uv = zip(rotate(zip(uv, a.offset, (x, y) => x - y)), a.scale, (x, y) => x / y);
            return zip(uv, a.pivot, (x, y) => x + y);
        }
        case 'normalmap': {
            const decoded = v.every(x => x === 0) ? [0, 0, 1] : v.map(x => x * 2 - 1);
            const scale = a.scale.length === 1 ? [a.scale[0], a.scale[0]] : a.scale;
            return normalize(a.normal.map((n, i) => a.tangent[i] * decoded[0] * scale[0] + a.bitangent[i] * decoded[1] * scale[1] + n * decoded[2]));
        }
        case 'convert': {
            const n = width(node.type);
            if (node.type === 'boolean')
                return [v[0] !== 0 ? 1 : 0];
            if (node.type === 'integer')
                return [Math.trunc(v[0])];
            if (v.length === 1)
                return Array(n).fill(v[0]);
            return Array.from({ length: n }, (_, i) => v[i] ?? (i === 3 ? 1 : 0));
        }
        case 'add': return zip(first, second, (x, y) => x + y);
        case 'subtract': return zip(first, second, (x, y) => x - y);
        case 'multiply': return zip(first, second, (x, y) => x * y);
        case 'divide': return zip(first, second, (x, y) => x / y);
        case 'modulo': return zip(first, second, (x, y) => x - y * Math.floor(x / y));
        case 'power': return zip(first, second, (x, y) => Math.pow(x, y));
        case 'min': return zip(first, second, Math.min);
        case 'max': return zip(first, second, Math.max);
        case 'mix': return zip(zip(a.fg, a.bg, (x, y) => x - y), a.mix, (x, y) => x * y).map((x, i) => x + a.bg[i % a.bg.length]);
        case 'clamp': return zip(zip(v, a.low, Math.max), a.high, Math.min);
        case 'ifgreater': return a.value1[0] > a.value2[0] ? a.in1 : a.in2;
        case 'ifequal': return a.value1[0] === a.value2[0] ? a.in1 : a.in2;
        case 'separate2':
        case 'separate3':
        case 'separate4': return v;
        case 'combine2':
        case 'combine3':
        case 'combine4': return Array.from({ length: width(node.type) }, (_, i) => a[`in${i + 1}`][0]);
        case 'dotproduct': return [zip(first, second, (x, y) => x * y).reduce((s, x) => s + x, 0)];
        case 'crossproduct': return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
        case 'hsvtorgb': {
            if (v[1] < 0.0001)
                return [v[2], v[2], v[2]];
            const hue = v[0] - Math.floor(v[0]);
            return [0, 4, 2].map(offset => {
                const wave = Math.abs(((hue * 6 + offset) % 6) - 3) - 1;
                return v[2] * (1 - v[1] + v[1] * Math.max(0, Math.min(1, wave)));
            });
        }
        case 'rgbtohsv': {
            const high = Math.max(...v), low = Math.min(...v), delta = high - low, saturation = high > 0 ? delta / high : 0;
            if (saturation <= 0)
                return [0, saturation, high];
            const index = v.indexOf(high), channels = [(v[1] - v[2]) / delta, 2 + (v[2] - v[0]) / delta, 4 + (v[0] - v[1]) / delta];
            const hue = channels[index] / 6;
            return [hue < 0 ? hue + 1 : hue, saturation, high];
        }
        case 'normalize': return normalize(v);
        default: {
            const unary: Record<string, (x: number) => number> = { abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: x => { const n = Math.floor(x), f = x - n; return f === 0.5 ? (n % 2 === 0 ? n : n + 1) : Math.floor(x + 0.5); }, sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, exp: Math.exp, ln: Math.log, sign: Math.sign };
            if (unary[c])
                return v.map(unary[c]);
            throw new Error(`Cannot evaluate ${c}`);
        }
    }
}
export function outputValue(values: Numeric[], node: number, output = 'out') {
    return output === 'out' ? values[node] : [values[node]['xyzwrgba'.indexOf(output.slice(3)) % 4]];
}
export function evaluateGraph(graph: NormalizedGraph, context: GraphContext = {}): Record<string, Numeric> {
    if (graph.diagnostics.length)
        throw new Error(graph.diagnostics.map(d => d.message).join('\n'));
    const values: Numeric[] = [];
    for (const node of graph.nodes) {
        const a: Record<string, Numeric> = {};
        let texture: Texture | undefined;
        for (const [port, input] of Object.entries(node.inputs)) {
            if (input.node !== undefined)
                a[port] = outputValue(values, input.node, input.output);
            else if (input.geometry)
                a[port] = context[input.geometry as keyof GraphContext] as Numeric ?? (input.geometry === 'texcoord' ? (context.uv ?? [0, 0]) : input.geometry === 'normal' ? [0, 0, 1] : input.geometry === 'tangent' ? [1, 0, 0] : [0, 1, 0]);
            else {
                const value = graph.parameters[input.slot!];
                if (value instanceof Texture)
                    texture = value;
                a[port] = numeric(value);
            }
        }
        values.push(evaluateNode(node, a, context, texture));
    }
    return Object.fromEntries(Object.entries(graph.terminal).map(([port, edge]) => [port, outputValue(values, edge.node, edge.output)]));
}
