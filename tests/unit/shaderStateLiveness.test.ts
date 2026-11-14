import {afterEach, describe, expect, it, vi} from 'vitest';
import Engine from '../../src/Engine';
import RenderLoop from '../../src/RenderLoop';
import Render from '../../src/Render';
import Camera from '../../src/scene/Camera';
import Mesh from '../../src/scene/Mesh';
import MaterialGraph, {type MaterialGraphNode} from '../../src/scene/MaterialGraph';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass';
import {createPlaneGeometry, createSphereGeometry} from '../../src/main';
import {SpotLight} from '../../src/main';
import {installFakeGPU} from '../helpers/fakeGPU';

const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));
let active: ReturnType<typeof installFakeGPU> | undefined;
afterEach(async () => { active?.loseDevice(); await macrotask(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Distinct graph structures: a chain of k unary nodes over UV driving `terminal`. */
function chain(k: number, terminal: 'specularRoughness' | 'baseColor' | 'emissionColor' = 'specularRoughness') {
  const nodes: MaterialGraphNode[] = [
    {id: 'uv', category: 'texcoord', type: 'vector2'},
    {id: 'n0', category: 'extract', type: 'float', inputs: {in: {type: 'vector2', connection: {node: 'uv'}}, index: {type: 'integer', value: 0}}}
  ];
  for (let i = 1; i <= k; i++) nodes.push({id: `n${i}`, category: i % 3 === 0 ? 'clamp' : i % 2 ? 'sin' : 'cos', type: 'float', inputs: {in: {type: 'float', connection: {node: `n${i - 1}`}}}});
  if (terminal === 'specularRoughness') return new MaterialGraph({nodes, terminal: {specularRoughness: {node: `n${k}`}}});
  nodes.push({id: 'c', category: 'convert', type: 'color3', inputs: {in: {type: 'float', connection: {node: `n${k}`}}}});
  return new MaterialGraph({nodes, terminal: {[terminal]: {node: 'c'}}});
}

function setup(seed: number) {
  let random = seed * 2654435761 + 7 >>> 0;
  const pick = (limit: number) => { random = random * 1664525 + 1013904223 >>> 0; return (random >>> 8) % limit; };
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const gpu = active = installFakeGPU();
  const engine = new Engine({canvas: gpu.canvas, backend: 'webgpu', shaderPrefetch: pick(4) ? 'editing' : 'off'});
  const camera = new Camera({projection: 'perspective', aspect: 4 / 3, fov: 50});
  camera.position = [3, 2, 4]; camera.lookAt([0, 0, 0]);
  engine.camera = camera;
  const materials = [new OpenPBRMaterial({baseColor: [.6, .6, .6]}), new OpenPBRMaterial({specularRoughness: .3})];
  const floor = new Mesh(createPlaneGeometry(), materials[0]);
  const ball = new Mesh(createSphereGeometry(8, 6), materials[1]);
  const spot = new SpotLight({intensity: 50, radius: 0, innerAngle: 25, outerAngle: 35});
  spot.position = [0, 3, 0]; spot.lookAt([0, 0, 0]);
  engine.scene = {meshes: [floor, ball], lights: [spot], background: [0, 0, 0, 1]} as NonNullable<Engine['scene']>;
  const final = new Render(engine, {maxSamples: 1 + pick(3), batchSamples: !!pick(2)});
  const loop = new RenderLoop(engine, {final, preview: pick(2) ? {maxSamples: 1} : false});
  const other = pick(3) ? undefined : new Render(engine, {width: 32, height: 32, maxSamples: 2, bounces: 2});
  const graphs = [chain(2), chain(4), chain(5, 'baseColor'), chain(7, 'emissionColor'), chain(3, 'baseColor')];
  return {gpu, engine, final, loop, other, materials, graphs, pick, advance: (ms: number) => { now += ms; }};
}

type Fixture = ReturnType<typeof setup>;
const lobes = ['coatWeight', 'fuzzWeight', 'thinFilmWeight', 'transmissionWeight', 'subsurfaceWeight'] as const;
const edits: ((f: Fixture) => void)[] = [
  f => { const m = f.materials[f.pick(2)]; m[lobes[f.pick(lobes.length)]] = f.pick(2); },
  f => { const m = f.materials[f.pick(2)]; m.graph = f.pick(4) ? f.graphs[f.pick(f.graphs.length)] : undefined; },
  f => { const m = f.materials[f.pick(2)]; m.baseColor = [f.pick(10) / 10, .5, .5]; },
  f => { const m = f.materials[f.pick(2)]; m.graph = f.graphs[f.pick(f.graphs.length)]; m[lobes[f.pick(lobes.length)]] = f.pick(2); },
  f => { f.graphs[f.pick(f.graphs.length)].setNode({id: 'n1', category: f.pick(2) ? 'sin' : 'abs', type: 'float', inputs: {in: {type: 'float', connection: {node: 'n0'}}}}); },
  f => {
    // Scene replacement while prefetches are in flight.
    const materials = f.materials.map(m => new OpenPBRMaterial({graph: m.graph, coatWeight: m.coatWeight, transmissionWeight: m.transmissionWeight}));
    f.materials.splice(0, 2, ...materials);
    f.engine.scene = {...f.engine.scene!, meshes: [new Mesh(createPlaneGeometry(), materials[0]), new Mesh(createSphereGeometry(8, 6), materials[1])]};
  },
  f => { f.final.aovs = f.pick(2) ? ['depth'] : []; f.engine.display.channel = f.final.aovs.length && f.pick(2) ? 'depth' : 'final'; },
  f => { f.final.maxSamples = 1 + f.pick(3); },
  f => { if (!f.pick(4)) f.gpu.loseDevice(); },
];

describe('shader variant liveness', () => {
  // The refine that completes a target used to report finished while a graph
  // structure edit still waited to install, and the loop left it idle for good.
  it('installs a graph edit that is pending when the image converges', async () => {
    let pass: any;
    const update = WGPURayTracePass.prototype.updatePipeline;
    vi.spyOn(WGPURayTracePass.prototype, 'updatePipeline').mockImplementation(function (this: WGPURayTracePass) { pass = this; return update.call(this); });
    const f = setup(0), {gpu, engine, final, loop} = f;
    final.maxSamples = 1;
    await engine.init();
    const run = async () => {
      let status = loop.status;
      for (let frame = 0; frame < 50 && status !== 'finished'; frame++) { status = loop.tick(); gpu.settle(); await macrotask(); f.advance(16); }
      return status;
    };
    expect(await run()).toBe('finished');
    f.materials[1].graph = f.graphs[1];
    // Converges within the graph debounce, before the new structure installs.
    expect(loop.tick()).toBe('compiling');
    expect(await run()).toBe('finished');
    expect(pass.graphs.active.key).toBe(pass.graphs.requested.key);
    expect(pass.graphs.active.key).not.toBe('');
    loop.dispose(); engine.dispose();
  });

  it.each(Array.from({length: 300}, (_, seed) => seed))('installs the requested variant after random edits (seed %i)', async seed => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let pass: any;
    const update = WGPURayTracePass.prototype.updatePipeline;
    vi.spyOn(WGPURayTracePass.prototype, 'updatePipeline').mockImplementation(function (this: WGPURayTracePass) { pass = this; return update.call(this); });
    const f = setup(seed);
    const {gpu, engine, final, loop, pick} = f;
    engine.on('error', () => {});
    await engine.init();
    const history: string[] = [];
    for (let step = 0; step < 80; step++) {
      const action = pick(6);
      if (action <= 1) {
        history.push(loop.tick());
        // Finished means the latest request is installed; a pending one keeps it compiling.
        if (history.at(-1) === 'finished' && !gpu.state.losses) expect({graphs: pass.graphs.status, pending: pass.isCompilingShader(), step}).toMatchObject({graphs: expect.not.stringMatching('compiling'), pending: false});
      }
      else if (action === 2) { const edit = pick(edits.length); history.push(`edit${edit}`); edits[edit](f); }
      else if (action === 3) { gpu.settle(false, pick(1000)); await macrotask(); }
      else if (action === 4) f.advance(pick(3) ? 16 : 1500);
      else if (!pick(4)) gpu.state.failNextCompile = true;
      else f.other?.refine();
    }
    gpu.state.failNextCompile = false;
    let status = loop.status, frames = 0;
    for (; frames < 300; frames++) {
      status = loop.tick(); f.other?.refine(); gpu.settle(); await macrotask(); f.advance(16);
      if (!gpu.outstanding && (status === 'finished' || status === 'error') && !final.denoising) break;
    }
    expect({status, frames: frames < 300, tail: history.slice(-8)}).toMatchObject({frames: true});
    expect(['finished', 'error']).toContain(status);
    if (status !== 'finished' || gpu.state.losses) { loop.dispose(); f.other?.dispose(); engine.dispose(); return; }
    // A finished image must be the latest one: probing the pass again must not
    // install another variant or graph plan, and nothing it needs may be pending.
    const generation = pass.graphs.generation, variant = pass._activeVariant;
    expect(pass.graphs.status).not.toBe('compiling');
    pass.updatePipeline();
    expect({generation: pass.graphs.generation, same: pass._activeVariant === variant, requested: pass._requestedVariant === pass._activeVariant, tail: history.slice(-8)})
      .toEqual({generation, same: true, requested: true, tail: history.slice(-8)});
    loop.dispose(); f.other?.dispose(); engine.dispose();
  });
});
