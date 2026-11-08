// MaterialX 1.39.4 stdlib semantics: https://github.com/AcademySoftwareFoundation/MaterialX/tree/v1.39.4/libraries/stdlib
// See THIRD_PARTY_NOTICES.md and LICENSES/MaterialX-*.txt for node/HSV attributions.
import type { GraphNode, NormalizedGraph } from './normalize.js';
import { width } from './nodes.js';
import {evaluateNoise} from './noise.js';
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
    objectToWorld?: Numeric;
    worldToObject?: Numeric;
    sample?: (texture: Texture, uv: Numeric) => Numeric;
}
export function numeric(value: unknown): Numeric { return Array.isArray(value) ? [...value] : [value === 'world' ? 1 : value === '' ? -1 : typeof value === 'string' ? 0 : Number(value ?? 0)]; }
const zip = (a: Numeric, b: Numeric, f: (a: number, b: number) => number) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => f(a[i % a.length], b[i % b.length]));
const normalize = (a: Numeric) => { const length = Math.hypot(...a); return a.map(v => v / length); };
export function evaluateNode(node: GraphNode, a: Record<string, Numeric>, context: GraphContext = {}, texture?: Texture): Numeric {
    const c = node.category, v = a.in, first = a.in1, second = a.in2;
    switch (c) {
        case 'noise2d': case 'noise3d': case 'fractal3d': case 'cellnoise2d': case 'cellnoise3d': case 'worleynoise2d': case 'worleynoise3d':
            return evaluateNoise(c,a.texcoord??a.position,width(node.type),a);
        // Point-sampled limit of MaterialX's derivative-filtered aastep.
        case 'splitlr': return a.texcoord[0] >= a.center[0] ? a.valuer : a.valuel;
        case 'splittb': return a.texcoord[1] >= a.center[0] ? a.valueb : a.valuet;
        case 'ramplr': case 'ramptb': case 'ramp4': {
            const x=Math.max(0,Math.min(1,a.texcoord[0])),y=Math.max(0,Math.min(1,a.texcoord[1]));
            const mix=(b:Numeric,f:Numeric,t:number)=>zip(b,f,(b,f)=>b*(1-t)+f*t);
            return c==='ramplr'?mix(a.valuel,a.valuer,x):c==='ramptb'?mix(a.valuet,a.valueb,y):mix(mix(a.valuetl,a.valuetr,x),mix(a.valuebl,a.valuebr,x),y);
        }
        case 'burn': case 'dodge': case 'screen': case 'overlay': case 'difference': case 'plus': case 'minus':
            return zip(a.fg,a.bg,(fg,bg)=>{
                if(c==='burn'&&Math.abs(fg)<1e-8 || c==='dodge'&&Math.abs(1-fg)<1e-8)return 0;
                const blend=c==='burn'?1-(1-bg)/fg:c==='dodge'?bg/(1-fg):c==='screen'?1-(1-fg)*(1-bg):c==='overlay'?(bg>=0.5?1-2*(1-fg)*(1-bg):2*fg*bg):c==='difference'?Math.abs(bg-fg):c==='plus'?bg+fg:bg-fg;
                return blend*a.mix[0]+bg*(1-a.mix[0]);
            });
        case 'dot': return v;
        case 'extract': return [v[Math.trunc(a.index[0])]];
        case 'invert': return zip(a.amount, v, (x, y) => x - y);
        case 'remap':
        case 'range': {
            let result = zip(zip(v, a.inlow, (x,y) => x-y), zip(a.inhigh, a.inlow, (x,y) => x-y), (x,y) => x/y);
            if (c === 'range') result = zip(result, a.gamma, (x,y) => Math.sign(x) * Math.pow(Math.abs(x), 1/y));
            result = zip(result, zip(a.outhigh, a.outlow, (x,y) => x-y), (x,y) => x*y);
            result = zip(result, a.outlow, (x,y) => x+y);
            return c === 'range' && a.doclamp[0] ? zip(zip(result, a.outlow, Math.max), a.outhigh, Math.min) : result;
        }
        case 'smoothstep': return v.map((x,i) => { const low=a.low[i%a.low.length], high=a.high[i%a.high.length]; if(x>=high)return 1; if(x<=low)return 0; const t=(x-low)/(high-low); return t*t*(3-2*t); });
        case 'contrast': return zip(zip(zip(v, a.pivot, (x,y) => x-y), a.amount, (x,y) => x*y), a.pivot, (x,y) => x+y);
        case 'luminance': { const l=v.slice(0,3).reduce((sum,x,i) => sum+x*a.lumacoeffs[i],0); return width(node.type) === 4 ? [l,l,l,v[3]] : [l,l,l]; }
        case 'atan2': return zip(a.iny, a.inx, Math.atan2);
        case 'rotate2d': { const t=a.amount[0]*Math.PI/180; return [Math.cos(t)*v[0]+Math.sin(t)*v[1], -Math.sin(t)*v[0]+Math.cos(t)*v[1]]; }
        case 'rotate3d': {
            const axis=normalize(a.axis), t=a.amount[0]*Math.PI/180, cs=Math.cos(t), sn=Math.sin(t), dot=v.reduce((s,x,i)=>s+x*axis[i],0);
            const cross=[axis[1]*v[2]-axis[2]*v[1],axis[2]*v[0]-axis[0]*v[2],axis[0]*v[1]-axis[1]*v[0]];
            return v.map((x,i)=>x*cs-cross[i]*sn+axis[i]*dot*(1-cs));
        }
        case 'transformpoint':
        case 'transformvector':
        case 'transformnormal': {
            if(!((a.fromspace[0]===0&&a.tospace[0]===1)||(a.fromspace[0]===1&&a.tospace[0]===0)))return c==='transformnormal'?normalize(v):v;
            const inverse=a.fromspace[0]===1, normal=c==='transformnormal';
            const m=(inverse !== normal ? context.worldToObject : context.objectToWorld) ?? [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
            const result=[0,1,2].map(i=>v.reduce((sum,x,j)=>sum+x*m[normal ? i*4+j : j*4+i], c==='transformpoint' ? m[12+i] : 0));
            return normal?normalize(result):result;
        }
        case 'constant': return a.value;
        case 'texcoord': return a.index[0] === 1 ? (context.uv1 ?? [0, 0]) : (context.uv ?? [0, 0]);
        case 'position': return (a.space[0] === 0 ? context.objectPosition : undefined) ?? context.position ?? [0, 0, 0];
        case 'normal': return (a.space[0] === 0 ? context.objectNormal : undefined) ?? context.normal ?? [0, 0, 1];
        case 'tangent': return (a.space[0] === 0 ? context.objectTangent : undefined) ?? context.tangent ?? [1, 0, 0];
        case 'bitangent': return (a.space[0] === 0 ? context.objectBitangent : undefined) ?? context.bitangent ?? [0, 1, 0];
        case 'gltf_image': case 'gltf_colorimage': case 'gltf_normalmap': {
            const uv=zip(a.texcoord,a.pivot,(x,y)=>x-y), angle=-a.rotate[0]*Math.PI/180;
            const rotate=(p:Numeric)=>[Math.cos(angle)*p[0]-Math.sin(angle)*p[1],Math.sin(angle)*p[0]+Math.cos(angle)*p[1]];
            const offset=[-a.offset[0],a.offset[1]];
            const placed=zip((c==='gltf_colorimage'||a.operationorder[0]===0)?zip(rotate(zip(uv,a.scale,(x,y)=>x*y)),offset,(x,y)=>x-y):zip(rotate(zip(uv,offset,(x,y)=>x-y)),a.scale,(x,y)=>x*y),a.pivot,(x,y)=>x+y);
            let sampled=(texture&&context.sample?.(texture,placed))?.slice(0,width(node.type))??a.default;
            if(c==='gltf_colorimage')sampled=zip(zip(sampled,a.color,(x,y)=>x*y),a.geomcolor,(x,y)=>x*y);
            if(a.factor)sampled=zip(sampled,a.factor,(x,y)=>x*y);
            if(c==='gltf_normalmap')return evaluateNode({...node,category:'normalmap'},{in:sampled,scale:[1],normal:context.normal??[0,0,1],tangent:context.tangent??[1,0,0],bitangent:context.bitangent??[0,1,0]},context);
            return sampled;
        }
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
        // MaterialX 1.39.4 stdlib_ng.mtlx NG_hsvadjust_color3/4:
        // add hue, scale saturation/value, and retain alpha unchanged.
        case 'hsvadjust': {
            const hsv=evaluateNode({...node,category:'rgbtohsv'},{in:v});
            hsv[0]+=a.amount[0];hsv[1]*=a.amount[1];hsv[2]*=a.amount[2];
            return evaluateNode({...node,category:'hsvtorgb'},{in:hsv});
        }
        case 'hsvtorgb': {
            const alpha=width(node.type)===4?[v[3]]:[];
            if (v[1] < 0.0001)
                return [v[2], v[2], v[2],...alpha];
            const hue = v[0] - Math.floor(v[0]);
            return [0, 4, 2].map(offset => {
                const wave = Math.abs(((hue * 6 + offset) % 6) - 3) - 1;
                return v[2] * (1 - v[1] + v[1] * Math.max(0, Math.min(1, wave)));
            }).concat(alpha);
        }
        case 'rgbtohsv': {
            const alpha=width(node.type)===4?[v[3]]:[];
            const high = Math.max(...v.slice(0,3)), low = Math.min(...v.slice(0,3)), delta = high - low, saturation = high > 0 ? delta / high : 0;
            if (saturation <= 0)
                return [0, saturation, high,...alpha];
            const index = v.indexOf(high), channels = [(v[1] - v[2]) / delta, 2 + (v[2] - v[0]) / delta, 4 + (v[0] - v[1]) / delta];
            const hue = channels[index] / 6;
            return [hue < 0 ? hue + 1 : hue, saturation, high,...alpha];
        }
        case 'normalize': return normalize(v);
        default: {
            const unary: Record<string, (x: number) => number> = { abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: x => { const n = Math.floor(x), f = x - n; return f === 0.5 ? (n % 2 === 0 ? n : n + 1) : Math.floor(x + 0.5); }, tan: Math.tan, asin: Math.asin, acos: Math.acos, sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, exp: Math.exp, ln: Math.log, sign: Math.sign };
            if (unary[c])
                return v.map(unary[c]);
            throw new Error(`Cannot evaluate ${c}`);
        }
    }
}
export function outputValue(values: Numeric[], node: number, output = 'out') {
    if(output==='outcolor')return values[node].slice(0,3);
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
                a[port] = context[input.geometry as keyof GraphContext] as Numeric ?? (input.geometry === 'texcoord' ? (context.uv ?? [0, 0]) : input.geometry === 'objectPosition' ? (context.objectPosition ?? context.position ?? [0,0,0]) : input.geometry === 'normal' ? [0, 0, 1] : input.geometry === 'tangent' ? [1, 0, 0] : [0, 1, 0]);
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
