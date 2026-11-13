// MaterialX 1.39.4 stdlib semantics; see THIRD_PARTY_NOTICES.md and LICENSES/MaterialX-*.txt.
import {varyingCategory} from './fold.js';
import {width} from './types.js';
import {terminalTypes} from './nodes.js';
import {GraphSource, graphCategories, graphGeometry, graphOutputs, graphPorts, graphTerminals, graphTypes, type GraphIR} from './ir.js';

/** Fixed register file of the WGSL interpreter. Structures needing more live
 * values than this keep the specialized path. */
export const GRAPH_INTERPRETER_REGISTERS = 8;
/** Operand slots per instruction record (three vec4 rows after the header). */
export const GRAPH_INTERPRETER_OPERANDS = 12;
/** Floats per instruction: header vec4 plus operand codes. */
export const GRAPH_INSTRUCTION_FLOATS = 4 + GRAPH_INTERPRETER_OPERANDS;

export enum GraphOp {
    Store = 0, Unary, Binary, Mix, Clamp, Copy, Combine, Extract, If, Remap, Smoothstep, Affine,
    Luminance, Blend, Ramp, Place2d, Rotate, Hsv, Noise, Image, Geometry, Transform, Normalmap
}
type Ports = readonly (string | null)[];
const op = (o: GraphOp, sub: number, ports: Ports) => ({op: o, sub, ports});
const family = (o: GraphOp, names: readonly string[], ports: Ports | ((name: string) => Ports)) =>
    Object.fromEntries(names.map((name, sub) => [name, op(o, sub, typeof ports === 'function' ? ports(name) : ports)]));
export const graphUnary = ['abs', 'acos', 'asin', 'ceil', 'cos', 'exp', 'floor', 'ln', 'round', 'sign', 'sin', 'sqrt', 'tan', 'normalize'] as const;
const binaryNames = ['add', 'subtract', 'multiply', 'divide', 'modulo', 'power', 'min', 'max', 'dotproduct', 'crossproduct', 'atan2'] as const;
const blendNames = ['burn', 'dodge', 'screen', 'overlay', 'difference', 'plus', 'minus'] as const;
const noiseNames = ['noise2d', 'noise3d', 'fractal3d', 'cellnoise2d', 'cellnoise3d', 'worleynoise2d', 'worleynoise3d'] as const;
const gltfPorts = ['file', 'default', 'texcoord', 'pivot', 'scale', 'rotate', 'offset', 'operationorder', 'color', 'geomcolor', 'factor'];
/** Category → opcode family, sub-operation and operand port order. */
export const graphInstructions: Readonly<Record<string, {op: GraphOp; sub: number; ports: Ports}>> = {
    ...family(GraphOp.Unary, graphUnary, ['in']),
    ...family(GraphOp.Binary, binaryNames, name => name === 'atan2' ? ['iny', 'inx'] : ['in1', 'in2']),
    mix: op(GraphOp.Mix, 0, ['bg', 'fg', 'mix']),
    clamp: op(GraphOp.Clamp, 0, ['in', 'low', 'high']),
    ...family(GraphOp.Copy, ['convert', 'constant', 'dot', 'separate2', 'separate3', 'separate4'], name => [name === 'constant' ? 'value' : 'in']),
    ...family(GraphOp.Combine, ['combine2', 'combine3', 'combine4'], ['in1', 'in2', 'in3', 'in4']),
    extract: op(GraphOp.Extract, 0, ['in', 'index']),
    ...family(GraphOp.If, ['ifgreater', 'ifequal'], ['value1', 'value2', 'in1', 'in2']),
    ...family(GraphOp.Remap, ['remap', 'range'], ['in', 'inlow', 'inhigh', 'outlow', 'outhigh', 'gamma', 'doclamp']),
    smoothstep: op(GraphOp.Smoothstep, 0, ['in', 'low', 'high']),
    ...family(GraphOp.Affine, ['contrast', 'invert'], ['in', 'amount', 'pivot']),
    luminance: op(GraphOp.Luminance, 0, ['in', 'lumacoeffs']),
    ...family(GraphOp.Blend, blendNames, ['fg', 'bg', 'mix']),
    splitlr: op(GraphOp.Ramp, 0, ['texcoord', 'center', 'valuel', 'valuer']),
    splittb: op(GraphOp.Ramp, 1, ['texcoord', 'center', 'valuet', 'valueb']),
    ramplr: op(GraphOp.Ramp, 2, ['texcoord', null, 'valuel', 'valuer']),
    ramptb: op(GraphOp.Ramp, 3, ['texcoord', null, 'valuet', 'valueb']),
    ramp4: op(GraphOp.Ramp, 4, ['texcoord', null, 'valuetl', 'valuetr', 'valuebl', 'valuebr']),
    place2d: op(GraphOp.Place2d, 0, ['texcoord', 'pivot', 'scale', 'rotate', 'offset', 'operationorder']),
    ...family(GraphOp.Rotate, ['rotate2d', 'rotate3d'], ['in', 'amount', 'axis']),
    ...family(GraphOp.Hsv, ['rgbtohsv', 'hsvtorgb', 'hsvadjust'], ['in', 'amount']),
    ...family(GraphOp.Noise, noiseNames, name => [name.endsWith('2d') ? 'texcoord' : 'position', 'amplitude', 'pivot', 'octaves', 'lacunarity', 'diminish', 'jitter', 'style']),
    image: op(GraphOp.Image, 0, ['file', 'default', 'texcoord']),
    tiledimage: op(GraphOp.Image, 1, ['file', 'default', 'texcoord', 'uvtiling', 'uvoffset', 'realworldimagesize', 'realworldtilesize']),
    gltf_image: op(GraphOp.Image, 2, gltfPorts),
    gltf_colorimage: op(GraphOp.Image, 3, gltfPorts),
    gltf_normalmap: op(GraphOp.Image, 4, gltfPorts),
    ...family(GraphOp.Geometry, ['texcoord', 'position', 'normal', 'tangent', 'bitangent'], name => [name === 'texcoord' ? 'index' : 'space']),
    ...family(GraphOp.Transform, ['transformpoint', 'transformvector', 'transformnormal'], ['in', 'fromspace', 'tospace']),
    normalmap: op(GraphOp.Normalmap, 0, ['in', 'scale', 'normal', 'tangent', 'bitangent']),
};
const categoryOf = new Map(Object.entries(graphInstructions).map(([name, i]) => [i.op * 64 + i.sub, name]));

/** Operand code: ((index * 4 + kind) * 8 + selector) * 8 + width; -1 is absent.
 * Kinds: 0 parameter slot, 1 register, 2 geometry. Selector 0 is the whole value
 * at `width`, 1–4 one component (splat), 5 the RGB components. */
export enum OperandKind { Parameter = 0, Register = 1, Geometry = 2 }
export function operandCode(kind: OperandKind, index: number, selector: number, w: number) { return ((index * 4 + kind) * 8 + selector) * 8 + w; }
export function decodeOperand(code: number) {
    return {width: code & 7, selector: (code >> 3) & 7, kind: ((code >> 6) & 3) as OperandKind, index: code >> 8};
}
function selector(output: string) { return output === 'out' ? 0 : output === 'outcolor' ? 5 : 'xyzwrgba'.indexOf(output.slice(3)) % 4 + 1; }
const geometryWidth = (name: string) => name === 'texcoord' ? 2 : 3;

/** One entry point: instructions plus the terminals it writes. */
export interface GraphProgramEntry { instructions: number[]; terminals: string[] }
export interface GraphProgram {
    surface: GraphProgramEntry;
    opacity: GraphProgramEntry;
    emission: GraphProgramEntry;
    /** Highest register count over the three entries. */
    registers: number;
}
const emissionTerminals = ['emissionColor', 'emissionLuminance', 'coatWeight', 'coatColor'];
/** Why a structure cannot use the interpreter, or undefined when it can. */
export type GraphProgramResult = {program: GraphProgram; reason?: undefined} | {program?: undefined; reason: string};

/** Compile validated IR into interpreter programs. Uniform subtrees use the same
 * folded parameter slots as `generateGraphIR`, so one packed parameter block
 * serves both tiers. */
export function buildGraphProgram(graph: GraphIR, maxRegisters = GRAPH_INTERPRETER_REGISTERS): GraphProgramResult {
    const count = graph.nodes.length / 5, base = graph.parameters.length / 4;
    const folded: number[] = [];
    let foldedCount = 0;
    for (let i = 0; i < count; i++) {
        const category = graphCategories[graph.nodes[i * 5]];
        if (!graphInstructions[category]) return {reason: `unsupported category ${category}`};
        let uniform = !varyingCategory(category);
        for (let j = graph.nodes[i * 5 + 3]; j < graph.nodes[i * 5 + 3] + graph.nodes[i * 5 + 4]; j++) {
            const kind = graph.inputs[j * 5 + 2];
            if (kind === GraphSource.Geometry || kind === GraphSource.Node && folded[graph.inputs[j * 5 + 3]] < 0) uniform = false;
        }
        folded.push(uniform ? base + foldedCount++ : -1);
    }
    const terminals: {name: string; node: number; output: string}[] = [];
    for (let i = 0; i < graph.terminal.length; i += 3)
        terminals.push({name: graphTerminals[graph.terminal[i]], node: graph.terminal[i + 1], output: graphOutputs[graph.terminal[i + 2]]});
    const entry = (names: (name: string) => boolean): GraphProgramEntry | string => {
        const roots = terminals.filter(t => names(t.name));
        const reachable = new Array<boolean>(count).fill(false);
        const stack = roots.map(t => t.node);
        while (stack.length) {
            const n = stack.pop()!;
            if (reachable[n]) continue;
            reachable[n] = true;
            if (folded[n] >= 0) continue;
            for (let j = graph.nodes[n * 5 + 3]; j < graph.nodes[n * 5 + 3] + graph.nodes[n * 5 + 4]; j++)
                if (graph.inputs[j * 5 + 2] === GraphSource.Node) stack.push(graph.inputs[j * 5 + 3]);
        }
        const live = (n: number) => reachable[n] && folded[n] < 0;
        // Liveness: last instruction (node index) that reads each value; terminals are
        // stored right after their source, so they do not extend a lifetime.
        const lastUse = new Array<number>(count).fill(-1);
        for (let n = 0; n < count; n++) if (live(n))
            for (let j = graph.nodes[n * 5 + 3]; j < graph.nodes[n * 5 + 3] + graph.nodes[n * 5 + 4]; j++)
                if (graph.inputs[j * 5 + 2] === GraphSource.Node) lastUse[graph.inputs[j * 5 + 3]] = n;
        const nodeWidth = (n: number) => width(graphTypes[graph.nodes[n * 5 + 2]]);
        const registerOf = new Array<number>(count).fill(-1), free: number[] = [];
        let used = 0;
        const instructions: number[] = [];
        const source = (n: number, output: string, w: number) => folded[n] >= 0
            ? operandCode(OperandKind.Parameter, folded[n], selector(output), output === 'out' ? nodeWidth(n) : w)
            : operandCode(OperandKind.Register, registerOf[n], selector(output), output === 'out' ? nodeWidth(n) : w);
        const store = (t: typeof terminals[number]) => {
            const record = new Array<number>(GRAPH_INSTRUCTION_FLOATS).fill(-1);
            record[0] = GraphOp.Store; record[1] = graphTerminals.indexOf(t.name); record[2] = 0; record[3] = 0;
            record[4] = source(t.node, t.output, width(terminalTypes[t.name]));
            instructions.push(...record);
        };
        for (const t of roots) if (folded[t.node] >= 0) store(t);
        for (let n = 0; n < count; n++) {
            if (!live(n)) continue;
            const category = graphCategories[graph.nodes[n * 5]], typeId = graph.nodes[n * 5 + 2];
            const info = graphInstructions[category];
            const record = new Array<number>(GRAPH_INSTRUCTION_FLOATS).fill(-1);
            const inputs = new Map<string, number>();
            for (let j = graph.nodes[n * 5 + 3]; j < graph.nodes[n * 5 + 3] + graph.nodes[n * 5 + 4]; j++) inputs.set(graphPorts[graph.inputs[j * 5]], j);
            for (const [k, port] of info.ports.entries()) {
                const j = port === null ? undefined : inputs.get(port);
                if (j === undefined) continue;
                const w = width(graphTypes[graph.inputs[j * 5 + 1]]), kind = graph.inputs[j * 5 + 2], index = graph.inputs[j * 5 + 3];
                record[4 + k] = kind === GraphSource.Parameter ? operandCode(OperandKind.Parameter, index, 0, w)
                    : kind === GraphSource.Geometry ? operandCode(OperandKind.Geometry, index, 0, geometryWidth(graphGeometry[index]))
                    : source(index, graphOutputs[graph.inputs[j * 5 + 4]], w);
            }
            // Operands are read before the destination is written, so registers whose
            // last reader is this node can be reused as its destination.
            for (let j = graph.nodes[n * 5 + 3]; j < graph.nodes[n * 5 + 3] + graph.nodes[n * 5 + 4]; j++) {
                const parent = graph.inputs[j * 5 + 3];
                if (graph.inputs[j * 5 + 2] === GraphSource.Node && lastUse[parent] === n && registerOf[parent] >= 0 && !free.includes(registerOf[parent])) free.push(registerOf[parent]);
            }
            free.sort((a, b) => a - b);
            const dest = free.length ? free.shift()! : used++;
            if (used > maxRegisters) return `needs more than ${maxRegisters} registers`;
            registerOf[n] = dest;
            record[0] = info.op; record[1] = info.sub; record[2] = dest; record[3] = typeId * 16 + width(graphTypes[typeId]);
            instructions.push(...record);
            for (const t of roots) if (t.node === n) store(t);
            // A value nobody reads (terminal only) frees its register immediately.
            if (lastUse[n] < 0) free.push(dest);
        }
        return {instructions, terminals: roots.map(t => t.name)};
    };
    const surface = entry(name => name !== 'opacity'), opacity = entry(name => name === 'opacity'), emission = entry(name => emissionTerminals.includes(name));
    for (const e of [surface, opacity, emission]) if (typeof e === 'string') return {reason: e};
    const programs = [surface, opacity, emission] as GraphProgramEntry[];
    const registers = Math.max(0, ...programs.flatMap(p => {
        const r: number[] = [];
        for (let i = 0; i < p.instructions.length; i += GRAPH_INSTRUCTION_FLOATS) if (p.instructions[i] !== GraphOp.Store) r.push(p.instructions[i + 2] + 1);
        return r;
    }));
    return {program: {surface: programs[0], opacity: programs[1], emission: programs[2], registers}};
}

/** Terminal presence mask, split into two exactly representable floats. */
export function graphTerminalMask(names: readonly string[]) {
    let low = 0, high = 0;
    for (const name of names) {
        const bit = graphTerminals.indexOf(name);
        if (bit < 16) low |= 1 << bit; else high |= 1 << (bit - 16);
    }
    return [low, high];
}

type Numeric = number[];
/** Canonical register form: scalars splat, vectors zero-padded. */
export function canonical(value: Numeric, w: number): Numeric {
    if (w === 1) return [value[0], value[0], value[0], value[0]];
    return [0, 1, 2, 3].map(i => i < w ? value[i] ?? 0 : 0);
}
/** CPU reference of the WGSL interpreter loop. `evaluate` performs one node with
 * declared-width inputs; geometry supplies texcoord/objectPosition/normal/tangent/bitangent. */
export function runGraphProgram(entry: GraphProgramEntry, parameter: (slot: number) => Numeric,
    geometry: (name: string) => Numeric, evaluate: (category: string, type: string, inputs: Record<string, Numeric>) => Numeric): Record<string, Numeric> {
    const registers: Numeric[] = [], result: Record<string, Numeric> = {};
    const operand = (code: number) => {
        if (code < 0) return undefined;
        const {width: w, selector: s, kind, index} = decodeOperand(code);
        const value = kind === OperandKind.Parameter ? canonical(parameter(index), 4) : kind === OperandKind.Register ? registers[index] : canonical(geometry(graphGeometry[index]), 4);
        if (s === 0) return canonical(value, w).slice(0, w);
        if (s === 5) return value.slice(0, 3);
        return [value[s - 1]];
    };
    for (let i = 0; i < entry.instructions.length; i += GRAPH_INSTRUCTION_FLOATS) {
        const r = entry.instructions.slice(i, i + GRAPH_INSTRUCTION_FLOATS);
        if (r[0] === GraphOp.Store) { result[graphTerminals[r[1]]] = operand(r[4])!.slice(0, width(terminalTypes[graphTerminals[r[1]]])); continue; }
        const category = categoryOf.get(r[0] * 64 + r[1])!, type = graphTypes[r[3] >> 4], ports = graphInstructions[category].ports;
        const inputs: Record<string, Numeric> = {};
        ports.forEach((port, k) => { const value = port === null ? undefined : operand(r[4 + k]); if (port && value) inputs[port] = value; });
        registers[r[2]] = canonical(evaluate(category, type, inputs), r[3] & 15);
    }
    return result;
}

/** Fixed WGSL interpreter. Its size depends only on the terminal set, never on
 * the number of structures. Requires `mx_parameter`, `mx_image`, `mx_w2l`,
 * `mx_l2w`, the math helpers and `MXResult` with `fields`. */
export function graphInterpreterShader(fields: readonly string[]) {
    const R = GRAPH_INTERPRETER_REGISTERS;
    const a = (k: number) => `mx_arg(rec,${k},base,ctx,regs)`;
    const store = fields.map(field => `    case ${graphTerminals.indexOf(field)}: { (*result).${field} = v${width(terminalTypes[field]) === 1 ? '.x' : '.xyz'}; }`).join('\n');
    const unary = graphUnary.map((name, i) => `      case ${i}: { return ${name === 'normalize' ? `select(normalize(x),sign(x),w==1)` : `${name === 'ln' ? 'log' : name}(x)`}; }`).join('\n');
    return /* wgsl */`
struct MXContext { uv: vec2f, uv1: vec2f, position: vec3f, instance: i32, normal: vec3f, tangent: vec3f, bitangent: vec3f, }
fn mx_canon(v: vec4f, w: i32) -> vec4f { if(w == 1) { return vec4f(v.x); } return select(vec4f(0.0), v, vec4i(1, 2, 3, 4) <= vec4i(w)); }
fn mx_code(rec: i32, k: i32) -> i32 {
  var row: vec4f;
  if(k < 4) { row = vec4f(materialsBuffer[rec].emission, materialsBuffer[rec].emissiveMapIndex); }
  else if(k < 8) { row = vec4f(materialsBuffer[rec].specularColor, materialsBuffer[rec].fuzzWeight); }
  else { row = vec4f(materialsBuffer[rec].transmissionColor, materialsBuffer[rec].transmissionDepth); }
  return i32(row[k & 3]);
}
fn mx_geometry(index: i32, ctx: MXContext) -> vec4f {
  switch index {
    case 0: { return vec4f(ctx.uv, 0.0, 0.0); }
    case 1: { return vec4f((mx_w2l(ctx.instance) * vec4f(ctx.position, 1.0)).xyz, 0.0); }
    case 2: { return vec4f(ctx.normal, 0.0); }
    case 3: { return vec4f(ctx.tangent, 0.0); }
    default: { return vec4f(ctx.bitangent, 0.0); }
  }
}
fn mx_arg(rec: i32, k: i32, base: i32, ctx: MXContext, regs: ptr<function, array<vec4f, ${R}>>) -> vec4f {
  let code = mx_code(rec, k);
  if(code < 0) { return vec4f(0.0); }
  let index = code >> 8u; let kind = (code >> 6u) & 3; let selector = (code >> 3u) & 7;
  var v: vec4f;
  if(kind == 0) { v = mx_parameter(base, index); } else if(kind == 1) { v = (*regs)[index]; } else { v = mx_geometry(index, ctx); }
  if(selector == 0) { return mx_canon(v, code & 7); }
  if(selector == 5) { return vec4f(v.xyz, 0.0); }
  return vec4f(v[selector - 1]);
}
fn mx_exec(rec: i32, op: i32, sub: i32, w: i32, color: bool, base: i32, ctx: MXContext, regs: ptr<function, array<vec4f, ${R}>>) -> vec4f {
  switch op {
    case ${GraphOp.Unary}: {
      let x = ${a(0)};
      switch sub {
${unary}
        default: { return x; }
      }
    }
    case ${GraphOp.Binary}: {
      let x = ${a(0)}; let y = ${a(1)};
      switch sub {
        case 0: { return x + y; } case 1: { return x - y; } case 2: { return x * y; } case 3: { return x / y; }
        case 4: { return x - y * floor(x / y); } case 5: { return pow(x, y); } case 6: { return min(x, y); } case 7: { return max(x, y); }
        case 8: { return vec4f(dot(x, y)); } case 9: { return vec4f(cross(x.xyz, y.xyz), 0.0); }
        default: { return atan2(x, y); }
      }
    }
    case ${GraphOp.Mix}: { return mix(${a(0)}, ${a(1)}, ${a(2)}); }
    case ${GraphOp.Clamp}: { return clamp(${a(0)}, ${a(1)}, ${a(2)}); }
    case ${GraphOp.Copy}: {
      var x = ${a(0)};
      // Widening a vector pads MaterialX-style (w = 1); scalars splat, narrowing truncates.
      let fw = mx_code(rec, 0) & 7;
      if(sub == 0 && fw > 1 && fw < 4 && w == 4) { x.w = 1.0; }
      return x;
    }
    case ${GraphOp.Combine}: { return vec4f(${a(0)}.x, ${a(1)}.x, ${a(2)}.x, ${a(3)}.x); }
    case ${GraphOp.Extract}: { let x = ${a(0)}; return vec4f(x[clamp(i32(${a(1)}.x), 0, 3)]); }
    case ${GraphOp.If}: {
      let c = ${a(0)}.x; let d = ${a(1)}.x;
      return select(${a(3)}, ${a(2)}, select(c == d, c > d, sub == 0));
    }
    case ${GraphOp.Remap}: {
      let lo = ${a(3)}; let hi = ${a(4)};
      var v = (${a(0)} - ${a(1)}) / (${a(2)} - ${a(1)});
      if(sub == 1) { v = sign(v) * pow(abs(v), vec4f(1.0) / ${a(5)}); }
      v = lo + v * (hi - lo);
      if(sub == 1 && ${a(6)}.x > 0.5) { v = clamp(v, lo, hi); }
      return v;
    }
    case ${GraphOp.Smoothstep}: {
      let x = ${a(0)}; let lo = ${a(1)}; let hi = ${a(2)};
      return select(select(smoothstep(lo, hi, x), vec4f(0.0), x <= lo), vec4f(1.0), x >= hi);
    }
    case ${GraphOp.Affine}: {
      let x = ${a(0)}; let amount = ${a(1)};
      if(sub == 1) { return amount - x; }
      let pivot = ${a(2)}; return (x - pivot) * amount + pivot;
    }
    case ${GraphOp.Luminance}: {
      let x = ${a(0)}; let l = dot(x.xyz, ${a(1)}.xyz);
      return select(vec4f(vec3f(l), 0.0), vec4f(vec3f(l), x.w), w == 4);
    }
    case ${GraphOp.Blend}: {
      let f = ${a(0)}; let b = ${a(1)}; let m = ${a(2)}.x;
      var blended: vec4f;
      switch sub {
        case 0: { blended = 1.0 - (1.0 - b) / f; } case 1: { blended = b / (1.0 - f); }
        case 2: { blended = 1.0 - (1.0 - f) * (1.0 - b); }
        case 3: { blended = select(2.0 * f * b, 1.0 - 2.0 * (1.0 - f) * (1.0 - b), b >= vec4f(0.5)); }
        case 4: { blended = abs(b - f); } case 5: { blended = b + f; } default: { blended = b - f; }
      }
      let value = m * blended + (1.0 - m) * b;
      if(sub == 0) { return select(value, vec4f(0.0), abs(f) < vec4f(1e-8)); }
      if(sub == 1) { return select(value, vec4f(0.0), abs(1.0 - f) < vec4f(1e-8)); }
      return value;
    }
    case ${GraphOp.Ramp}: {
      let t = ${a(0)};
      let x = clamp(t.x, 0.0, 1.0); let y = clamp(t.y, 0.0, 1.0);
      switch sub {
        case 0: { return select(${a(2)}, ${a(3)}, t.x >= ${a(1)}.x); }
        case 1: { return select(${a(2)}, ${a(3)}, t.y >= ${a(1)}.x); }
        case 2: { return mix(${a(2)}, ${a(3)}, x); }
        case 3: { return mix(${a(2)}, ${a(3)}, y); }
        default: { return mix(mix(${a(2)}, ${a(3)}, x), mix(${a(4)}, ${a(5)}, x), y); }
      }
    }
    case ${GraphOp.Place2d}: { return vec4f(mx_place2d(${a(0)}.xy, ${a(1)}.xy, ${a(2)}.xy, ${a(3)}.x, ${a(4)}.xy, ${a(5)}.x), 0.0, 0.0); }
    case ${GraphOp.Rotate}: {
      if(sub == 0) { return vec4f(mx_rotate(${a(0)}.xy, -${a(1)}.x), 0.0, 0.0); }
      return vec4f(mx_rotate3d(${a(0)}.xyz, ${a(1)}.x, ${a(2)}.xyz), 0.0);
    }
    case ${GraphOp.Hsv}: {
      let x = ${a(0)}; var h: vec3f;
      if(sub == 0) { h = mx_rgbtohsv(x.xyz); }
      else if(sub == 1) { h = mx_hsvtorgb(x.xyz); }
      else { let amount = ${a(1)}; h = mx_hsvtorgb((mx_rgbtohsv(x.xyz) + vec3f(amount.x, 0.0, 0.0)) * vec3f(1.0, amount.y, amount.z)); }
      return vec4f(h, x.w);
    }
    case ${GraphOp.Noise}: {
      let planar = sub == 0 || sub == 3 || sub == 5;
      let dim = select(3, 2, planar);
      let q = ${a(0)}; let p = select(q.xyz, vec3f(q.xy, 0.0), planar);
      switch sub {
        case 0, 1: { return mx_noise(p, dim, w, false) * ${a(1)} + vec4f(${a(2)}.x); }
        case 2: { return mx_fractal(p, w, i32(${a(3)}.x), ${a(4)}.x, ${a(5)}.x) * ${a(1)}; }
        case 3, 4: { return vec4f(mx_cell(p, dim, -1)); }
        default: { return vec4f(mx_worley(p, dim, w, ${a(6)}.x, i32(${a(7)}.x)), 0.0); }
      }
    }
    case ${GraphOp.Image}: {
      var uv = ${a(2)}.xy;
      if(sub == 1) { uv = (uv * ${a(3)}.xy - ${a(4)}.xy) / ${a(5)}.xy * ${a(6)}.xy; }
      if(sub >= 2) { uv = mx_place2d(uv, ${a(3)}.xy, vec2f(1.0) / ${a(4)}.xy, -${a(5)}.x, ${a(6)}.xy * vec2f(-1.0, 1.0), select(${a(7)}.x, 0.0, sub == 3)); }
      var v = mx_image(i32(${a(0)}.x), uv, ${a(1)}, color);
      if(sub == 3) { v = v * ${a(8)} * ${a(9)}; }
      if(sub >= 2 && mx_code(rec, 10) >= 0) { v = v * ${a(10)}; }
      if(sub == 4) { v = vec4f(mx_normalmap(v.xyz, vec2f(1.0), ctx.normal, ctx.tangent, ctx.bitangent), 0.0); }
      return v;
    }
    case ${GraphOp.Geometry}: {
      let s = ${a(0)}.x;
      switch sub {
        case 0: { return vec4f(select(ctx.uv, ctx.uv1, s > 0.5), 0.0, 0.0); }
        case 1: { return vec4f(select((mx_w2l(ctx.instance) * vec4f(ctx.position, 1.0)).xyz, ctx.position, s > 0.5), 0.0); }
        case 2: { return vec4f(select(normalize((transpose(mx_l2w(ctx.instance)) * vec4f(ctx.normal, 0.0)).xyz), ctx.normal, s > 0.5), 0.0); }
        case 3: { return vec4f(select(normalize((mx_w2l(ctx.instance) * vec4f(ctx.tangent, 0.0)).xyz), ctx.tangent, s > 0.5), 0.0); }
        default: { return vec4f(select(normalize((mx_w2l(ctx.instance) * vec4f(ctx.bitangent, 0.0)).xyz), ctx.bitangent, s > 0.5), 0.0); }
      }
    }
    case ${GraphOp.Transform}: {
      let x = ${a(0)}.xyz; let src = ${a(1)}.x; let dst = ${a(2)}.x;
      let l2w = mx_l2w(ctx.instance); let w2l = mx_w2l(ctx.instance);
      let h = select(0.0, 1.0, sub == 0);
      var r = x;
      if(src == 0.0 && dst == 1.0) { r = select((l2w * vec4f(x, h)).xyz, (transpose(w2l) * vec4f(x, h)).xyz, sub == 2); }
      else if(src == 1.0 && dst == 0.0) { r = select((w2l * vec4f(x, h)).xyz, (transpose(l2w) * vec4f(x, h)).xyz, sub == 2); }
      if(sub == 2) { r = normalize(r); }
      return vec4f(r, 0.0);
    }
    case ${GraphOp.Normalmap}: { return vec4f(mx_normalmap(${a(0)}.xyz, ${a(1)}.xy, ${a(2)}.xyz, ${a(3)}.xyz, ${a(4)}.xyz), 0.0); }
    default: { return vec4f(0.0); }
  }
}
fn mx_store(terminal: i32, v: vec4f, result: ptr<function, MXResult>) {
  switch terminal {
${store}
    default: {}
  }
}
/** Runs \`count\` instruction records starting at record \`program\`. */
fn mx_run(program: i32, count: i32, base: i32, ctx: MXContext, result: ptr<function, MXResult>) {
  var regs: array<vec4f, ${R}>;
  for(var pc = 0; pc < count; pc++) {
    let rec = program + pc;
    let header = vec4i(vec4f(materialsBuffer[rec].color, materialsBuffer[rec].matType));
    if(header.x == ${GraphOp.Store}) { mx_store(header.y, mx_arg(rec, 0, base, ctx, &regs), result); continue; }
    let w = header.w & 15; let tid = header.w >> 4u;
    var v = mx_exec(rec, header.x, header.y, w, tid == 3 || tid == 4, base, ctx, &regs);
    if(header.x == ${GraphOp.Copy} && header.y == 0) {
      if(tid == 2) { v = vec4f(select(0.0, 1.0, v.x != 0.0)); } else if(tid == 1) { v = vec4f(trunc(v.x)); }
    }
    regs[clamp(header.z, 0, ${R - 1})] = mx_canon(v, w);
  }
}
`;
}
