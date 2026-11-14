import {MaterialGraph, type MaterialGraphNode} from '../../src/main.js';

/** Seeded UV-only OpenPBR graphs with distinct normalized structures. Every
 * terminal depends only on UV0, so each graph has an exact baked equivalent. */
export type GraphClass = 'simple' | 'noise' | 'wide';

function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Operators stay finite on every input, so CPU bakes and GPU graphs agree.
const unary = ['sin', 'abs', 'cos', 'floor'] as const;
const binary = ['add', 'multiply', 'subtract', 'max', 'min'] as const;

/** Builds one graph; structure depends on (index, graphClass), values on valueSeed. */
export function scalingGraph(index: number, graphClass: GraphClass, valueSeed = index): MaterialGraph {
  const r = random(index * 7919 + (graphClass === 'noise' ? 104729 : 0) + 1), v = random(valueSeed * 31 + 17);
  const nodes: MaterialGraphNode[] = [];
  let next = 0;
  const add = (category: string, type: MaterialGraphNode['type'], inputs: MaterialGraphNode['inputs'] = {}) => {
    const id = `n${next++}`; nodes.push({id, category, type, inputs}); return id;
  };
  const f = (value: number) => ({type: 'float' as const, value});
  const c = (node: string, type: MaterialGraphNode['type'] = 'float', output?: string) => ({type, connection: output ? {node, output} : {node}});
  const uv = add('texcoord', 'vector2');
  const placed = add('place2d', 'vector2', {texcoord: c(uv, 'vector2'), scale: {type: 'vector2', value: [1 + v() * 4, 1 + v() * 4]}, rotate: f(v() * 90)});
  const split = add('separate2', 'vector2', {in: c(placed, 'vector2')});
  const pool: string[] = [];
  const pick = () => pool[Math.floor(r() * pool.length)];
  pool.push(add('multiply', 'float', {in1: c(split, 'float', 'outx'), in2: f(1 + v() * 8)}));
  pool.push(add('multiply', 'float', {in1: c(split, 'float', 'outy'), in2: f(1 + v() * 8)}));
  if (graphClass === 'noise') {
    const sources = ['noise2d', 'cellnoise2d', 'worleynoise2d'];
    const count = 1 + Math.floor(r() * 2);
    for (let i = 0; i < count; i++) {
      const category = sources[Math.floor(r() * sources.length)];
      pool.push(add(category, 'float', category === 'noise2d' ? {texcoord: c(placed, 'vector2'), amplitude: f(0.5 + v())} : {texcoord: c(placed, 'vector2')}));
    }
  }
  // The operation sequence encodes the index so that every structure is distinct.
  const steps = 6 + (index % 7);
  for (let i = 0, bits = index; i < steps; i++, bits = Math.floor(bits / 3)) {
    const choice = (bits % 3 + Math.floor(r() * 3)) % 3;
    if (choice === 0) pool.push(add(unary[Math.floor(r() * unary.length)], 'float', {in: c(pick())}));
    else if (choice === 1) pool.push(add(binary[Math.floor(r() * binary.length)], 'float', {in1: c(pick()), in2: c(pick())}));
    else pool.push(add('mix', 'float', {bg: c(pick()), fg: f(v()), mix: c(add('clamp', 'float', {in: c(pick())}))}));
  }
  const unit = (node: string) => add('clamp', 'float', {in: c(node)});
  const [a, b, d] = [unit(pool.at(-1)!), unit(pool.at(-2)!), unit(pool.at(-3)!)];
  const color = add('mix', 'color3', {
    bg: {type: 'color3', value: [v(), v(), v()]}, fg: {type: 'color3', value: [v(), v(), v()]}, mix: c(a)
  });
  const roughness = add('remap', 'float', {in: c(b), outlow: f(0.05 + v() * 0.2), outhigh: f(0.4 + v() * 0.5)});
  const metal = add('smoothstep', 'float', {in: c(d), low: f(0.4), high: f(0.6)});
  const terminal: Record<string, {node: string}> = {baseColor: {node: color}, specularRoughness: {node: roughness}, baseMetalness: {node: metal}};
  // `wide` drives as many terminals as the viewer's MaterialX samples do together.
  if (graphClass === 'wide') {
    for (const name of ['baseWeight', 'baseDiffuseRoughness', 'specularWeight', 'specularIor', 'fuzzRoughness', 'coatRoughness', 'coatIor', 'coatDarkening', 'thinFilmThickness', 'thinFilmIor'])
      terminal[name] = {node: add('remap', 'float', {in: c(b), outlow: f(0.1 + v() * 0.2), outhigh: f(0.5 + v() * 0.4)})};
    for (const name of ['specularColor', 'transmissionColor', 'fuzzColor'])
      terminal[name] = {node: add('mix', 'color3', {bg: {type: 'color3', value: [v(), v(), v()]}, fg: {type: 'color3', value: [v(), v(), v()]}, mix: c(d)})};
  }
  return new MaterialGraph({nodes, terminal});
}
