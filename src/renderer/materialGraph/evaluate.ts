// MaterialX 1.39.4 stdlib semantics: https://github.com/AcademySoftwareFoundation/MaterialX/tree/v1.39.4/libraries/stdlib
// See THIRD_PARTY_NOTICES.md and LICENSES/MaterialX-*.txt for node/HSV attributions.
import type { GraphNode, NormalizedGraph } from './normalize.js';
import { width } from './nodes.js';
import {evaluateNumericNode} from './numeric.js';
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
    const c = node.category, v = a.in;
    switch(c) {
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
        default: return evaluateNumericNode(c, node.type, a);
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
