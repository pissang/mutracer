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
    const ref = (i: number, output = 'out') => output === 'out' ? refs[i] : `(${refs[i]}).${(output === 'outcolor' ? 'rgb' : output.slice(3)).replace('r', 'x').replace('g', 'y').replace('b', 'z').replace('a', 'w')}`;
    for (const [i, node] of graph.nodes.entries()) {
        const a: Record<string, string> = {}, u: Record<string, Numeric> = {};
        let isUniform = !['gltf_image','gltf_colorimage','gltf_normalmap','image', 'tiledimage', 'texcoord', 'position', 'normal', 'tangent', 'bitangent', 'transformpoint', 'transformvector', 'transformnormal'].includes(node.category);
        for (const [port, input] of Object.entries(node.inputs)) {
            if (input.node !== undefined) {
                a[port] = ref(input.node, input.output);
                if (uniform[input.node])
                    u[port] = outputValue(uniform as Numeric[], input.node, input.output);
                else
                    isUniform = false;
            }
            else if (input.geometry) {
                a[port] = input.geometry === 'texcoord' ? 'uv' : input.geometry === 'objectPosition' ? `(mx_w2l * ${vec(4,'mx_position, 1.0')}).xyz` : `mx_${input.geometry}`;
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
            case 'noise2d': case 'noise3d': case 'fractal3d': case 'cellnoise2d': case 'cellnoise3d': case 'worleynoise2d': case 'worleynoise3d': {
                const n=width(node.type), dim=c.endsWith('2d')?2:3, p=dim===2?vec(3,`${a.texcoord}, 0.0`):a.position;
                const swizzle = (count:number) => n===count?'':`.${'xyzw'.slice(0,n)}`;
                if(c.startsWith('cellnoise'))expr=`mx_cell(${p},${dim},-1)`;
                else if(c.startsWith('worley'))expr=`mx_worley(${p},${dim},${n},${a.jitter},${wg?'i32':'int'}(${a.style}))${swizzle(3)}`;
                else {
                    const value=c==='fractal3d'?`mx_fractal(${p},${n},${wg?'i32':'int'}(${a.octaves}),${a.lacunarity},${a.diminish})`:`mx_noise(${p},${dim},${n},false)`;
                    expr=`(${value}${swizzle(4)} * ${fit('amplitude')}${c==='fractal3d'?'':` + ${width(node.type)===1?a.pivot:vec(n,a.pivot)}`})`;
                }
                break;
            }
            case 'splitlr': expr=select(`(${a.texcoord}).x >= ${a.center}`, a.valuer, a.valuel);break;
            case 'splittb': expr=select(`(${a.texcoord}).y >= ${a.center}`, a.valueb, a.valuet);break;
            case 'ramplr': case 'ramptb': case 'ramp4': {
                const x=`clamp((${a.texcoord}).x,0.0,1.0)`,y=`clamp((${a.texcoord}).y,0.0,1.0)`;
                expr=c==='ramplr'?`mix(${a.valuel},${a.valuer},${x})`:c==='ramptb'?`mix(${a.valuet},${a.valueb},${y})`:`mix(mix(${a.valuetl},${a.valuetr},${x}),mix(${a.valuebl},${a.valuebr},${x}),${y})`;
                break;
            }
            case 'burn': case 'dodge': case 'screen': case 'overlay': case 'difference': case 'plus': case 'minus': {
                const component=(p:string,i:number)=>width(node.type)===1?a[p]:`(${a[p]}).${'xyzw'[i]}`;
                const terms=Array.from({length:width(node.type)},(_,i)=>{
                    const f=component('fg',i),b=component('bg',i);
                    const blended=c==='burn'?`(1.0-(1.0-${b})/${f})`:c==='dodge'?`(${b}/(1.0-${f}))`:c==='screen'?`(1.0-(1.0-${f})*(1.0-${b}))`:c==='overlay'?select(`${b}>=0.5`,`(1.0-2.0*(1.0-${f})*(1.0-${b}))`,`(2.0*${f}*${b})`):c==='difference'?`abs(${b}-${f})`:c==='plus'?`(${b}+${f})`:`(${b}-${f})`;
                    const value=`(${a.mix}*${blended}+(1.0-${a.mix})*${b})`;
                    return c==='burn'||c==='dodge'?select(`abs(${c==='burn'?f:`1.0-${f}`})<1e-8`,'0.0',value):value;
                });
                expr=terms.length===1?terms[0]:vec(terms.length,terms.join(', '));break;
            }
            case 'dot': expr = a.in; break;
            case 'extract': expr = `(${a.in})[${wg ? 'i32' : 'int'}(${a.index})]`; break;
            case 'invert': expr = `(${fit('amount')} - ${a.in})`; break;
            case 'remap':
            case 'range': {
                const unit = width(node.type) === 1 ? '1.0' : vec(width(node.type), '1.0');
                let value = `((${a.in} - ${fit('inlow')}) / (${fit('inhigh')} - ${fit('inlow')}))`;
                if(c === 'range') value = `(sign(${value}) * pow(abs(${value}), ${unit} / ${fit('gamma')}))`;
                value = `(${fit('outlow')} + ${value} * (${fit('outhigh')} - ${fit('outlow')}))`;
                expr = c === 'range' ? select(`${a.doclamp} > 0.5`, `clamp(${value}, ${fit('outlow')}, ${fit('outhigh')})`, value) : value; break;
            }
            case 'smoothstep': {
                const component = (x: string, i: number) => width(node.type) === 1 ? x : `(${x}).${'xyzw'[i]}`;
                const terms = Array.from({length:width(node.type)}, (_,i) => {
                    const x=component(a.in,i), lo=component(fit('low'),i), hi=component(fit('high'),i);
                    return select(`${x} >= ${hi}`, '1.0', select(`${x} <= ${lo}`, '0.0', `smoothstep(${lo}, ${hi}, ${x})`));
                });
                expr=terms.length===1?terms[0]:vec(terms.length,terms.join(', ')); break;
            }
            case 'contrast': expr = `((${a.in} - ${fit('pivot')}) * ${fit('amount')} + ${fit('pivot')})`; break;
            case 'luminance': { const l = `dot((${a.in}).rgb, ${a.lumacoeffs})`; expr=vec(width(node.type), width(node.type)===4 ? `${vec(3,l)}, (${a.in}).a` : l); break; }
            case 'atan2': expr = `${wg ? 'atan2' : 'atan'}(${a.iny}, ${a.inx})`; break;
            case 'rotate2d': expr = `mx_rotate(${a.in}, -${a.amount})`; break;
            case 'rotate3d': expr = `mx_rotate3d(${a.in}, ${a.amount}, ${a.axis})`; break;
            case 'transformpoint':
            case 'transformvector':
            case 'transformnormal': {
                const normal=c==='transformnormal';
                const toWorld=normal?'transpose(mx_w2l)':'mx_l2w', toObject=normal?'transpose(mx_l2w)':'mx_w2l';
                const transform = (m:string) => `(${m} * ${vec(4, `${a.in}, ${c==='transformpoint'?'1.0':'0.0'}`)}).xyz`;
                expr = select(`${a.fromspace} == 0.0 && ${a.tospace} == 1.0`, transform(toWorld), select(`${a.fromspace} == 1.0 && ${a.tospace} == 0.0`, transform(toObject), a.in));
                if(normal)expr=`normalize(${expr})`;break;
            }
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
            case 'gltf_image': case 'gltf_colorimage': case 'gltf_normalmap':
            case 'image':
            case 'tiledimage': {
                let uv = a.texcoord;
                if(c.startsWith('gltf_'))uv=`mx_place2d(${uv},${a.pivot},${vec(2,'1.0')} / ${a.scale},-${a.rotate},${a.offset} * ${vec(2,'-1.0,1.0')},${c==='gltf_colorimage'?'0.0':a.operationorder})`;
                if (c === 'tiledimage')
                    uv = `((${uv} * ${a.uvtiling} - ${a.uvoffset}) / ${a.realworldimagesize} * ${a.realworldtilesize})`;
                expr = `mx_image(${wg ? 'i32' : 'int'}(${a.file}), ${uv}, ${vec(4, `${a.default}${width(node.type) === 4 ? '' : `, ${Array(4 - width(node.type)).fill('0.0').join(', ')}`}`)}, ${node.type.startsWith('color') ? 'true' : 'false'})${width(node.type) === 4 ? '' : `.${'xyzw'.slice(0, width(node.type))}`}`;
                if(c==='gltf_colorimage')expr=`(${expr} * ${a.color} * ${a.geomcolor})`;
                if(a.factor)expr=`(${expr} * ${a.factor})`;
                if(c==='gltf_normalmap')expr=`mx_normalmap(${expr}, ${vec(2,'1.0')}, mx_normal, mx_tangent, mx_bitangent)`;
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
                expr = `mx_${c}(${width(node.type)===4?`(${a.in}).rgb`:a.in})`;
                if(width(node.type)===4)expr=vec(4,`${expr}, (${a.in}).a`);
                break;
            case 'hsvadjust': {
                const hsv=`(mx_rgbtohsv((${a.in}).rgb) + ${vec(3,`(${a.amount}).x, 0.0, 0.0`)}) * ${vec(3,`1.0, (${a.amount}).y, (${a.amount}).z`)}`;
                expr=`mx_hsvtorgb(${hsv})`;
                if(width(node.type)===4)expr=vec(4,`${expr}, (${a.in}).a`);
                break;
            }
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
