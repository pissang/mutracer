// Real-GPU regression: both generated shapes run the same scenes and sample stream.
import {AmbientLight, Camera, CylinderLight, DirectionalLight, DiskLight, Engine, MaterialGraph, Mesh, OpenPBRMaterial, RectLight, Render, SphereLight, SpotLight, Texture, createCubeGeometry, createPlaneGeometry, createSphereGeometry} from '../../src/main.js';
import type {SceneLight} from '../../src/scene/Scene.js';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass.js';
import {freezeMaterialGraphPolicy, setMaterialGraphPlanner} from '../../src/renderer/materialGraph/state.js';
import {generateVertexTangents} from '../../src/util/geometry.js';
import {runEditingTextureSampling} from './editingTextureSampling.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const graph = (opacity = false) => new MaterialGraph({nodes: [
  {id: 'uv', category: 'texcoord', type: 'vector2'},
  {id: 'color', category: 'convert', type: 'color3', inputs: {in: {type: 'vector2', connection: {node: 'uv'}}}},
  {id: 'rough', category: 'extract', type: 'float', inputs: {in: {type: 'vector2', connection: {node: 'uv'}}, index: {type: 'integer', value: 0}}}
], terminal: {baseColor: {node: 'color'}, specularRoughness: {node: 'rough'}, ...(opacity ? {opacity: {node: 'rough'}} : {})}});

export async function runEditingQueryTests(cases = ['surface', 'alpha', 'alpha-mask', 'medium', 'catcher', 'bevel', 'displacement', 'lights', 'cube', 'zsobol', 'alpha-zsobol'], identifiers?: readonly (readonly [string, string])[]) {
  // Tests inspect installation, so a passing comparison cannot silently use lean twice.
  const prototype = WGPURayTracePass.prototype as any, start = prototype._startTraceVariant;
  const passes: any[] = [];
  prototype._startTraceVariant = function (...args: any[]) { if (!passes.includes(this)) passes.push(this); return start.apply(this, args); };
  setMaterialGraphPlanner({compileBackend: 'd3d12', policy: {maxUpgradeCompileMs: 1e9}});
  const rows = [];
  const make = async (prefetch: 'off' | 'editing', kind: string) => {
    const engine = new Engine({canvas: document.createElement('canvas'), backend: 'webgpu', shaderPrefetch: prefetch});
    engine.bvhBuilder = 'builtin'; engine.display.setSize(48, 40);
    const material = new OpenPBRMaterial({baseColor: [.6, .3, .1], specularRoughness: .35});
    const geometry = kind === 'bevel' || kind === 'cube' ? createCubeGeometry() : createSphereGeometry(24, 12);
    const mesh = new Mesh(geometry, material), meshes = [mesh];
    if (kind === 'bevel') material.bevelSize = .08;
    if (kind === 'alpha' || kind === 'catcher' || kind === 'alpha-zsobol') material.alphaMode = 'blend';
    if (kind === 'alpha-mask') { material.alphaMode = 'mask'; material.alphaCutoff = .55; }
    if (kind === 'medium') Object.assign(material, {transmissionWeight: 1, transmissionDepth: .6, transmissionColor: [.6, .8, .9], transmissionScatter: [.6, .5, .3]});
    if (kind === 'displacement') {
      generateVertexTangents(geometry);
      material.displacementMap = new Texture({width: 2, height: 2, data: new Float32Array([.2,.2,.2,1,.8,.8,.8,1,.8,.8,.8,1,.2,.2,.2,1])});
      material.displacementScale = .08;
    }
    if (kind === 'catcher') { const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({shadowCatcher: true})); floor.position = [0, -1.05, 0]; floor.transform[0] = floor.transform[10] = 6; meshes.push(floor); }
    const sphere = new SphereLight({intensity: 20, radius: 1}); sphere.position = [-2, 3, 3];
    const lights: SceneLight[] = [new AmbientLight({intensity: .3}), sphere];
    if (kind === 'lights') {
      const sun = new DirectionalLight({intensity: .5}); sun.position = [2, 4, 3]; sun.lookAt([0, 0, 0]);
      const rect = new RectLight({intensity: 3, size: [1, 1]}); rect.position = [1, 3, 2]; rect.lookAt([0, 0, 0]);
      const spot = new SpotLight({intensity: 10, radius: .1}); spot.position = [-2, 3, 2]; spot.lookAt([0, 0, 0]);
      const disk = new DiskLight({intensity: 3, radius: .5}); disk.position = [2, 3, -1]; disk.lookAt([0, 0, 0]);
      const cylinder = new CylinderLight({intensity: 3, radius: .2, length: 1}); cylinder.position = [-1, 2, -2];
      const point = new SphereLight({intensity: 5, radius: 0}); point.position = [0, 3, 1];
      lights.push(sun, rect, spot, disk, cylinder, point);
    }
    engine.scene = {meshes, lights, background: [.3, .4, .5, 1]};
    const camera = new Camera({projection: 'perspective', fov: 40}); camera.position = [2, 1.2, 4]; camera.lookAt([0, 0, 0]); engine.camera = camera;
    const render = new Render(engine, {width: 64, height: 64, maxSamples: 16, denoiser: null, samplingPattern: kind.endsWith('zsobol') ? 'zsobol' : 'sobol', bounces: 6, directLightCandidates: 3, bevel: kind === 'bevel'});
    engine.update(); return {engine, render, material};
  };
  const drive = async (s: Awaited<ReturnType<typeof make>>, done: () => boolean, pass?: any) => {
    for (const end = performance.now() + 300000; performance.now() < end;) {
      s.render.refine(); if (pass?._leanRequest) pass._leanRequest.since = Infinity;
      if (done()) return;
      if (s.render.status === 'error') throw Error(JSON.stringify(s.engine.getDiagnostics()));
      await pause(5);
    }
    throw Error('Editing query regression timed out');
  };
  try {
    rows.push(await runEditingTextureSampling(identifiers));
    for (const kind of cases) {
      const editing = await make('editing', kind), lean = await make('off', kind);
      try {
        await drive(editing, () => editing.render.samples > 0);
        const pass = passes.findLast(p => p._device === editing.engine.device && p.shaderPrefetch === 'editing');
        await drive(editing, () => pass._traceVariants.get(pass._editingRequest.signature)?.status === 'ready', pass);
        await drive(lean, () => lean.render.samples > 0);
        freezeMaterialGraphPolicy(true);
        for (const s of [lean, editing]) {
          const before = s.engine.getDiagnostics()?.materialGraphs?.revision ?? 0;
          s.material.graph = graph(kind === 'alpha' || kind === 'alpha-mask' || kind === 'catcher' || kind === 'alpha-zsobol'); s.engine.update();
          await drive(s, () => { const g = s.engine.getDiagnostics()?.materialGraphs; return !!g && g.revision > before && g.revision === g.installedRevision && g.status !== 'compiling'; }, pass);
        }
        if (!pass.graphs.editingInstalled) throw Error('Comparison did not install the editing program');
        const images = [];
        for (const s of [lean, editing]) { await s.render.converge({samples: 64, sampleSequenceOffset: 0, timeoutMs: 300000}); images.push((await s.render.readPixels('hdr')).data); }
        if (!pass.graphs.editingInstalled) throw Error('Comparison left the editing program');
        if (images.some(image => image.length !== 64 * 64 * 4)) throw Error('Missing HDR readback');
        let catcherDifferent = 0;
        if (kind === 'catcher') {
          const signals = [];
          for (const scene of [lean, editing]) {
            const p = passes.findLast(p => p._device === scene.engine.device && p.shaderPrefetch === (scene === lean ? 'off' : 'editing'));
            const source: GPUBuffer = p.getOutputBuffer().shadowCatcher;
            const device = scene.engine.device!;
            const read = device.createBuffer({size: source.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
            const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, read, 0, source.size); device.queue.submit([encoder.finish()]);
            await read.mapAsync(GPUMapMode.READ); signals.push(new Uint32Array(read.getMappedRange()).slice()); read.unmap(); read.destroy();
          }
          // Compare coverage, visibility counts and the separate background.
          // Denoising variance moments are a different numerical contract.
          for (let i = 0; i < 64 * 64 * 12; i++) if (i % 12 !== 4 && i % 12 !== 5 && signals[0][i] !== signals[1][i]) catcherDifferent++;
        }
        const a = new Uint32Array(images[0].buffer), b = new Uint32Array(images[1].buffer);
        const bitDifferent = a.reduce((n, value, i) => n + Number(value !== b[i]), 0);
        const nonfinite = images.flatMap(v => [...v]).some(v => !Number.isFinite(v));
        const row = {kind, samples: 64, sampleSequenceOffset: 0, bitDifferent, nonfinite, catcherDifferent}; rows.push(row);
        if (bitDifferent || nonfinite || catcherDifferent) throw Error(JSON.stringify(row));
      } finally { freezeMaterialGraphPolicy(false); editing.render.dispose(); editing.engine.dispose(); lean.render.dispose(); lean.engine.dispose(); }
    }
    return rows;
  } finally { prototype._startTraceVariant = start; setMaterialGraphPlanner(); }
}

Object.assign(window, {runEditingQueryTests});
