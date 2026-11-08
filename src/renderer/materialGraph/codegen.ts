import type { NormalizedGraph } from './normalize.js';
import type { MaterialGraphType as Type } from '../../scene/MaterialGraph.js';
import { width } from './nodes.js';
import { evaluateNode, numeric, outputValue, type Numeric } from './evaluate.js';
export type Backend = 'webgpu' | 'webgl';
export interface GeneratedGraph {
    source: string;
    parameters: NormalizedGraph['parameters'];
    foldedNodes: number;
    commonExpressions: number;
}
/** A deterministic expression emitter; numeric author parameters are never literals. */
export function generateGraph(graph: NormalizedGraph, backend: Backend, name = 'mx_eval'): GeneratedGraph {
    if (graph.diagnostics.length)
        throw new Error(graph.diagnostics.map(d => d.message).join('\n'));
    const wg = backend === 'webgpu', parameters = [...graph.parameters], types = (type: Type) => width(type) === 1 ? 'f32' : `vec${width(type)}${wg ? 'f' : ''}`;
    const vec = (n: number, x: string) => `${wg ? `vec${n}f` : `vec${n}`}(${x})`;
    const cast = (x: string, from: Type, to: Type) => width(from) === width(to) ? x : width(from) === 1 ? vec(width(to), x) : width(to) < width(from) ? `(${x}).${'xyzw'.slice(0, width(to))}` : vec(width(to), [x, ...Array.from({ length: width(to) - width(from) }, (_, i) => i + width(from) === 3 ? '1.0' : '0.0')].join(', '));
    const refs: string[] = [], uniform: (Numeric | undefined)[] = [], lines: string[] = [], cse = new Map<string, string>();
    let foldedNodes = 0, commonExpressions = 0;
    const param = (slot: number, type: Type) => `mx_parameter(base, ${slot})${width(type) === 4 ? '' : `.${'xyzw'.slice(0, width(type))}`}`;
    const ref = (i: number, output = 'out') => output === 'out' ? refs[i] : `(${refs[i]}).${output.slice(3).replace('r', 'x').replace('g', 'y').replace('b', 'z').replace('a', 'w')}`;
    for (const [i, node] of graph.nodes.entries()) {
        const a: Record<string, string> = {}, u: Record<string, Numeric> = {};
        let isUniform = !['image', 'tiledimage', 'texcoord', 'position', 'normal', 'tangent', 'bitangent'].includes(node.category);
        for (const [port, input] of Object.entries(node.inputs)) {
            if (input.node !== undefined) {
                a[port] = ref(input.node, input.output);
                if (uniform[input.node])
                    u[port] = outputValue(uniform as Numeric[], input.node, input.output);
                else
                    isUniform = false;
            }
            else if (input.geometry) {
                a[port] = input.geometry === 'texcoord' ? 'uv' : `mx_${input.geometry}`;
                isUniform = false;
            }
            else {
                a[port] = param(input.slot!, input.type);
                u[port] = numeric(parameters[input.slot!]);
            }
        }
        let expr = '', c = node.category;
        if (isUniform) {
            const value = evaluateNode(node, u);
            uniform[i] = value.map(Math.fround);
            refs[i] = param(parameters.length, node.type);
            parameters.push(uniform[i]);
            foldedNodes++;
            continue;
        }
        const fit = (port: string) => cast(a[port], node.inputs[port].type, node.type);
        const select = (condition: string, yes: string, no: string) => wg ? `select(${no}, ${yes}, ${condition})` : `((${condition}) ? (${yes}) : (${no}))`;
        switch (c) {
            case 'constant':
                expr = a.value;
                break;
            case 'texcoord':
                expr = select(`${a.index} > 0.5`, 'uv1', 'uv');
                break;
            case 'position':
            case 'normal':
            case 'tangent':
            case 'bitangent':
                expr = select(`${a.space} > 0.5`, `mx_${c}`, c === 'normal' ? `normalize((transpose(mx_l2w) * ${vec(4, 'mx_normal, 0.0')}).xyz)` : c === 'position' ? `(mx_w2l * ${vec(4, 'mx_position, 1.0')}).xyz` : `normalize((mx_w2l * ${vec(4, `mx_${c}, 0.0`)}).xyz)`);
                break;
            case 'image':
            case 'tiledimage': {
                let uv = a.texcoord;
                if (c === 'tiledimage')
                    uv = `((${uv} * ${a.uvtiling} - ${a.uvoffset}) / ${a.realworldimagesize} * ${a.realworldtilesize})`;
                expr = `mx_image(${wg ? 'i32' : 'int'}(${a.file}), ${uv}, ${vec(4, `${a.default}${width(node.type) === 4 ? '' : `, ${Array(4 - width(node.type)).fill('0.0').join(', ')}`}`)}, ${node.type.startsWith('color') ? 'true' : 'false'})${width(node.type) === 4 ? '' : `.${'xyzw'.slice(0, width(node.type))}`}`;
                break;
            }
            case 'place2d':
                expr = `mx_place2d(${a.texcoord}, ${a.pivot}, ${a.scale}, ${a.rotate}, ${a.offset}, ${a.operationorder})`;
                break;
            case 'normalmap':
                expr = `mx_normalmap(${a.in}, ${cast(a.scale, node.inputs.scale.type, 'vector2')}, ${a.normal}, ${a.tangent}, ${a.bitangent})`;
                break;
            case 'convert':
                expr = node.type === 'boolean' ? select(`${a.in} != 0.0`, '1.0', '0.0') : node.type === 'integer' ? `trunc(${a.in})` : cast(a.in, node.inputs.in.type, node.type);
                break;
            case 'add':
            case 'subtract':
            case 'multiply':
            case 'divide':
                expr = `(${fit('in1')} ${{ add: '+', subtract: '-', multiply: '*', divide: '/' }[c]} ${fit('in2')})`;
                break;
            case 'modulo':
                expr = `(${fit('in1')} - ${fit('in2')} * floor(${fit('in1')} / ${fit('in2')}))`;
                break;
            case 'power':
            case 'min':
            case 'max':
                expr = `${c === 'power' ? 'pow' : c}(${fit('in1')}, ${fit('in2')})`;
                break;
            case 'mix':
                expr = `mix(${a.bg}, ${a.fg}, ${cast(a.mix, node.inputs.mix.type, node.type)})`;
                break;
            case 'clamp':
                expr = `clamp(${a.in}, ${fit('low')}, ${fit('high')})`;
                break;
            case 'ifgreater':
            case 'ifequal':
                expr = select(`${a.value1} ${c === 'ifgreater' ? '>' : '=='} ${a.value2}`, a.in1, a.in2);
                break;
            case 'separate2':
            case 'separate3':
            case 'separate4':
                expr = a.in;
                break;
            case 'combine2':
            case 'combine3':
            case 'combine4':
                expr = vec(width(node.type), Array.from({ length: width(node.type) }, (_, i) => a[`in${i + 1}`]).join(', '));
                break;
            case 'rgbtohsv':
            case 'hsvtorgb':
                expr = `mx_${c}(${a.in})`;
                break;
            case 'dotproduct':
                expr = `dot(${a.in1}, ${a.in2})`;
                break;
            case 'crossproduct':
                expr = `cross(${a.in1}, ${a.in2})`;
                break;
            default: expr = `${c === 'ln' ? 'log' : c === 'round' && !wg ? 'roundEven' : c}(${a.in})`;
        }
        const key = `${node.type}:${expr}`, prior = cse.get(key);
        if (prior) {
            refs[i] = prior;
            commonExpressions++;
            continue;
        }
        refs[i] = `mx_n${i}`;
        cse.set(key, refs[i]);
        lines.push(wg ? `  let ${refs[i]} = ${expr};` : `  ${types(node.type).replace('f32', 'float')} ${refs[i]} = ${expr};`);
    }
    for (const [port, edge] of Object.entries(graph.terminal))
        lines.push(`  result.${port} = ${ref(edge.node, edge.output)};`);
    const source = wg ? `fn ${name}(base: i32, uv: vec2f, uv1: vec2f, mx_position: vec3f, mx_normal: vec3f, mx_tangent: vec3f, mx_bitangent: vec3f, mx_w2l: mat4x4f, mx_l2w: mat4x4f, initial: MXResult) -> MXResult {\n  var result = initial;\n${lines.join('\n')}\n  return result;\n}` : `MXResult ${name}(int base, vec2 uv, vec2 uv1, vec3 mx_position, vec3 mx_normal, vec3 mx_tangent, vec3 mx_bitangent, mat4 mx_w2l, mat4 mx_l2w, MXResult initial) {\n  MXResult result = initial;\n${lines.join('\n')}\n  return result;\n}`;
    return { source, parameters, foldedNodes, commonExpressions };
}
