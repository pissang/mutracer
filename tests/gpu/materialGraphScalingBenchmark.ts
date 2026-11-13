import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {FBXLoader} from 'three/examples/jsm/loaders/FBXLoader.js';
import {Engine, Render, Camera, Mesh, OpenPBRMaterial, AmbientLight, SphereLight, Texture, THREESync, createSphereGeometry, createPlaneGeometry, type Geometry} from '../../src/main.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {evaluateGraph} from '../../src/renderer/materialGraph/evaluate.js';
import {flattenGraphUnchecked} from '../../src/renderer/materialGraph/flatten.js';
import {GraphOp, buildGraphProgram, graphProgramFamilies} from '../../src/renderer/materialGraph/interpreter.js';
import {DEFAULT_GRAPH_TIER_BUDGET} from '../../src/renderer/materialGraph/planner.js';
import {freezeMaterialGraphPolicy, setMaterialGraphPlanner, type GraphInstallEvent, type GraphTierPolicy, type GraphUpgradeEvent} from '../../src/renderer/materialGraph/state.js';
import type {GraphCompileObservation, GraphCompilerBackend} from '../../src/renderer/materialGraph/tierPolicy.js';
import {scalingGraph, type GraphClass} from './materialGraphScalingScene.js';

/** Material-graph scaling harness: one fixed 32×32 sphere grid, N distinct graph
 * structures assigned round-robin, rendered as graphs, as their exact UV bakes,
 * or as constants. Timings report rather than gate. */
type Mode = 'constant' | 'baked' | 'graph' | 'interpreter' | 'auto';
const GRID = 32, WIDTH = 640, HEIGHT = 400;
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const median = (values: number[]) => { const s = values.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : undefined; };
const encode = (x: number) => { x = Math.min(1, Math.max(0, x)); return Math.round(255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)); };

// A different first index yields new structures, hence new shader source that no
// driver cache has seen. Baked/constant kernels have fixed source and can hit caches.
function structures(count: number, graphClass: GraphClass, firstIndex: number) {
  const keys = new Set<string>(), indices: number[] = [];
  for (let i = firstIndex; indices.length < count; i++) {
    const key = normalizeGraph(scalingGraph(i, graphClass)).key;
    if (!keys.has(key)) { keys.add(key); indices.push(i); }
  }
  return indices;
}

function bake(index: number, graphClass: GraphClass, size: number) {
  const graph = normalizeGraph(scalingGraph(index, graphClass));
  const color = new Uint8Array(size * size * 4), mr = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Rows are top-first and the textures use flipY, as the viewer bake does.
    const out = evaluateGraph(graph, {uv: [(x + 0.5) / size, 1 - (y + 0.5) / size], uv1: [0, 0]});
    const p = (y * size + x) * 4, base = out.baseColor as number[];
    color.set([encode(base[0]), encode(base[1]), encode(base[2]), 255], p);
    const roughness = (out.specularRoughness as number[])[0], metal = (out.baseMetalness as number[])[0];
    mr.set([0, Math.round(255 * Math.min(1, Math.max(0, roughness))), Math.round(255 * Math.min(1, Math.max(0, metal))), 255], p);
  }
  const texture = (data: Uint8Array, colorSpace: 'srgb' | 'linear') => {
    const t = new Texture({width: size, height: size, data}); t.colorSpace = colorSpace; t.flipY = true; return t;
  };
  return {map: texture(color, 'srgb'), metallicRoughnessMap: texture(mr, 'linear')};
}

// Scene materials are replaced, so FBX texture requests resolve to one opaque pixel.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
/** Loads a glTF (or FBX) scene through THREESync and assigns `materials` round-robin to every
 * converted mesh. Each geometry's UV0 is rescaled into [0, 1] so UV bakes stay exact;
 * the camera is fixed inside the scene bounds. */
async function gltfScene(engine: Engine, url: string, materials: OpenPBRMaterial[]) {
  let root: THREE.Object3D;
  if (url.endsWith('.fbx')) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(item => item.endsWith('.fbx') ? item : PIXEL);
    root = await new FBXLoader(manager).loadAsync(url);
    // Authored FBX lights differ per file; keep the harness's own sun and ambient.
    const lights: THREE.Object3D[] = [];
    root.traverse(object => { if ((object as THREE.Light).isLight) lights.push(object); });
    for (const light of lights) light.removeFromParent();
  } else root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url)).scene;
  const loaded = {scene: root};
  const scene = new THREE.Scene();
  scene.add(loaded.scene);
  scene.background = new THREE.Color(0.7, 0.8, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 6);
  scene.add(new THREE.AmbientLight(0xffffff, 0.3), sun, sun.target);
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(loaded.scene), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  sun.position.set(center.x + size.x * 0.1, box.max.y + size.y, center.z + size.z * 0.2); sun.target.position.copy(center);
  // The FBX interior (Bistro) is closed to the sun; light it from inside.
  if (url.endsWith('.fbx')) { const lamp = new THREE.PointLight(0xffffff, 2000 * size.y * size.y, 0, 2); lamp.position.set(center.x, box.min.y + size.y * 0.7, center.z); scene.add(lamp); }
  const rescaled = new Set<Geometry>();
  let assigned = 0, triangles = 0, noUv = 0;
  // Every source material converts to a placeholder that onMeshConverted replaces.
  const sync = new THREESync(engine, {scene, convertMaterial: () => materials[0], onMeshConverted(mesh) {
    mesh.materials = mesh.materials.map(() => materials[assigned++ % materials.length]);
    const geometry = mesh.geometry;
    if (rescaled.has(geometry)) return;
    rescaled.add(geometry);
    triangles += (geometry.indices?.array.length ?? geometry.position.array.length / 3) / 3;
    const uv = geometry.uv?.array;
    if (!uv) { noUv++; return; }
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (let i = 0; i < uv.length; i += 2) { u0 = Math.min(u0, uv[i]); u1 = Math.max(u1, uv[i]); v0 = Math.min(v0, uv[i + 1]); v1 = Math.max(v1, uv[i + 1]); }
    for (let i = 0; i < uv.length; i += 2) { uv[i] = (uv[i] - u0) / Math.max(u1 - u0, 1e-6); uv[i + 1] = (uv[i + 1] - v0) / Math.max(v1 - v0, 1e-6); }
  }});
  sync.update();
  const camera = new Camera({projection: 'perspective', fov: 60});
  camera.position = [box.min.x + size.x * 0.2, box.min.y + size.y * 0.2, center.z];
  camera.lookAt([box.max.x, box.min.y + size.y * 0.3, center.z]);
  engine.camera = camera;
  return {info: {meshes: assigned, geometries: rescaled.size, triangles, noUv, bounds: [box.min.toArray(), box.max.toArray()], camera: [camera.position, [box.max.x, box.min.y + size.y * 0.3, center.z]], distinctMaterials: Math.min(assigned, materials.length)}};
}

interface RunOptions {
  structures: number; mode: Mode; graphClass?: GraphClass; bakeSize?: number; perfSamples?: number; textureBinding?: 'atlas' | 'auto'; hdr?: boolean; firstIndex?: number;
  closeUp?: boolean; hdrBlock?: number; swap?: boolean; sceneUrl?: string; interim?: boolean; budgetMs?: number;
  /** Render target while the tier policy decides (auto mode). Default 2048 (Render's default). */ targetSamples?: number;
  /** Longest wait for the policy to settle. Default 60000. */ settleMs?: number;
  /** Structural edits, one per `editIntervalMs`, after the first correct frame; each replaces one material's
   * graph with an unseen structure, alternating the simple and noise classes (new opcode families). Default 0. */ edits?: number; editIntervalMs?: number;
  /** `parameter` edits change only parameter values of the same structure. Default structure. */ editKind?: 'structure' | 'parameter';
  /** Debug compile speed factor (slow device simulation). */ compileSpeed?: number;
  /** Debug compile-cost shape, e.g. 'd3d12' on a Mac. */ compileBackend?: GraphCompilerBackend;
  policy?: Partial<GraphTierPolicy>;
  /** Concurrency probe (auto mode): `contended` starts a fully specialized upgrade, then makes a
   * structural edit that needs its own compile (new opcode families, no prefetch) `probeDelayMs`
   * after the upgrade starts; `solo` makes the same edit with no upgrade. Records how long the
   * edit waits. */ probe?: 'contended' | 'solo'; probeDelayMs?: number;
}
async function run(options: RunOptions) {
  const {structures: count, mode, graphClass = 'simple', bakeSize = 128, perfSamples = 50, textureBinding = 'auto', firstIndex = 0} = options;
  // 'graph' forces specialized code, 'interpreter' the shared interpreter tier and
  // 'auto' lets the planner mix them. A per-run salt keeps the fixed interpreter
  // source cold in the shared Metal cache.
  const installs: GraphInstallEvent[] = [], upgrades: GraphUpgradeEvent[] = [], compiles: GraphCompileObservation[] = [], compiledAt: number[] = [];
  // The probe forces a fully specialized upgrade right after the debounce (contended) or none (solo).
  const probePolicy: Partial<GraphTierPolicy> | undefined = options.probe && {margin: 0, prefetch: false, maxUpgradeCompileMs: options.probe === 'contended' ? Infinity : 0};
  const budgetMs = options.probe ? 1e9 : options.budgetMs;
  setMaterialGraphPlanner({tier: mode === 'interpreter' ? 'interpreter' : mode === 'auto' ? 'auto' : 'specialized', salt: 1 + Math.floor(Math.random() * 1e9),
    interim: options.interim ?? true, budget: budgetMs ? {...DEFAULT_GRAPH_TIER_BUDGET, budgetMs} : undefined, compileSpeed: options.compileSpeed, compileBackend: options.compileBackend,
    policy: {...options.policy, ...probePolicy},
    onInstall: event => installs.push(event), onUpgrade: event => upgrades.push(event), onCompile: event => { compiles.push(event); compiledAt.push(performance.now()); }});
  const graphs = mode === 'graph' || mode === 'interpreter' || mode === 'auto';
  const engine = new Engine({canvas: document.createElement('canvas'), backend: 'webgpu', textureBinding});
  engine.display.setSize(WIDTH, HEIGHT); engine.bvhBuilder = 'builtin';
  const prepareStart = performance.now();
  const indices = structures(count, graphClass, firstIndex);
  let bakeMs = 0;
  const materials = indices.map((index, i) => {
    if (graphs) return new OpenPBRMaterial({graph: scalingGraph(index, graphClass)});
    if (mode === 'baked') {
      const start = performance.now(), maps = bake(index, graphClass, bakeSize); bakeMs += performance.now() - start;
      return new OpenPBRMaterial({baseColor: [1, 1, 1], specularRoughness: 1, baseMetalness: 1, ...maps});
    }
    const h = (i * 0.618034) % 1;
    return new OpenPBRMaterial({baseColor: [0.3 + 0.5 * h, 0.5, 0.8 - 0.5 * h], specularRoughness: 0.2 + 0.6 * h, baseMetalness: h > 0.7 ? 1 : 0});
  });
  const fallback = new OpenPBRMaterial({baseColor: [0.6, 0.6, 0.6], specularRoughness: 0.5});
  const complex = options.sceneUrl ? await gltfScene(engine, options.sceneUrl, materials.length ? materials : [fallback]) : undefined;
  const sphere = createSphereGeometry(32, 16), meshes: Mesh[] = [];
  if (!complex) {
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    const mesh = new Mesh(sphere, materials.length ? materials[(z * GRID + x) % materials.length] : fallback);
    mesh.transform[0] = mesh.transform[5] = mesh.transform[10] = 0.45;
    mesh.transform[12] = x - (GRID - 1) / 2; mesh.transform[14] = z - (GRID - 1) / 2; meshes.push(mesh);
  }
  const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({baseColor: [0.7, 0.7, 0.7], specularRoughness: 0.8}));
  floor.transform[0] = floor.transform[10] = GRID * 1.5; floor.transform[13] = -0.45; meshes.push(floor);
  const light = new SphereLight({radius: 3, intensity: 400}); light.position = [-8, 20, 10];
  engine.scene = {meshes, lights: [new AmbientLight({intensity: 0.3}), light], background: [0.7, 0.8, 1, 1]};
  const camera = new Camera({projection: 'perspective', fov: 40});
  // closeUp frames one sphere for visual baked/graph equivalence checks.
  if (options.closeUp) { camera.position = [-15.5, 1.2, -13.0]; camera.lookAt([-15.5, 0, -15.5]); }
  else { camera.position = [0, 22, 26]; camera.lookAt([0, 0, -1]); }
  engine.camera = camera;
  }
  const render = new Render(engine, {bounces: 6, directLightCandidates: 1, samplingPattern: 'sobol', maxSamples: 64, denoiser: null});
  const prepareMs = performance.now() - prepareStart;
  try {
    const start = performance.now();
    engine.update();
    let graphReadyMs: number | undefined, graphState: {status: string; topologyCount: number} | undefined;
    await render.converge({samples: 1, sampleSequenceOffset: 0, timeoutMs: 900000});
    const firstFrameMs = performance.now() - start;
    const waitGraphs = async (revision = 0, timeoutMs = 900000) => {
      let state: {status: string; topologyCount: number; revision: number} | undefined;
      for (const deadline = performance.now() + timeoutMs; performance.now() < deadline;) {
        state = engine.getDiagnostics()?.materialGraphs as typeof state;
        if (state && state.topologyCount > 0 && state.revision > revision && (state.status === 'ready' || state.status === 'failed')) return state;
        render.refine(); await pause();
      }
      return {...state!, status: `timeout:${state?.status}:${state?.revision}`};
    };
    if (graphs && count) {
      // Graph state exists only once the pipeline has seen the scene; keep sampling while it compiles.
      graphState = await waitGraphs();
      graphReadyMs = performance.now() - start;
      await render.converge({samples: 1, sampleSequenceOffset: 0, timeoutMs: 900000});
    }
    const firstCorrectFrameMs = performance.now() - start;
    let probe: {upgradeStartMs?: number; editAtMs: number; editReadyMs?: number; editCompile?: unknown; upgradeCompile?: unknown} | undefined;
    if (options.probe && graphs && count) {
      render.maxSamples = 1e6; render.restart();
      const waitFor = async (done: () => boolean, ms: number) => { for (const deadline = performance.now() + ms; !done() && performance.now() < deadline;) { render.refine(); await pause(); } };
      // contended: the gate starts the upgrade after its debounce; solo: the gate refuses it (ceiling).
      await waitFor(() => upgrades.some(e => e.type === (options.probe === 'contended' ? 'start' : 'hold')), 120000);
      const started = upgrades.find(e => e.type === 'start');
      await waitFor(() => false, options.probeDelayMs ?? 1000);
      // A noise-class structure whose program uses the noise family, which no simple-class
      // structure needs: the edit needs its own interpreter compile.
      const noisy = (index: number) => { const program = buildGraphProgram(flattenGraphUnchecked(normalizeGraph(scalingGraph(index, 'noise')))).program, families = new Set<GraphOp>();
        if (program) graphProgramFamilies(program, families); return families.has(GraphOp.Noise); };
      let editIndex = firstIndex + 800000;
      while (!noisy(editIndex)) editIndex++;
      const slot = 0, compiled = compiles.length, before = (engine.getDiagnostics()?.materialGraphs as {revision: number}).revision;
      materials[slot].graph = scalingGraph(editIndex, 'noise');
      const editStart = performance.now();
      engine.update();
      let editReadyMs: number | undefined;
      await waitFor(() => {
        const state = engine.getDiagnostics()?.materialGraphs as {revision: number; installedRevision: number};
        if (state.revision > before && state.installedRevision >= state.revision) editReadyMs = performance.now() - editStart;
        return editReadyMs !== undefined;
      }, options.settleMs ?? 300000);
      const editCompileIndex = compiles.findIndex((c, i) => i >= compiled && !c.specializedBytes && c.interpreterBytes > 0);
      // The (now stale) upgrade compile still finishes; its duration tells whether the two overlapped.
      if (options.probe === 'contended') await waitFor(() => compiles.some(c => c.specializedBytes > 0), options.settleMs ?? 300000);
      const upgradeIndex = compiles.findIndex(c => c.specializedBytes > 0);
      probe = {upgradeStartMs: started && started.at - start, editAtMs: editStart - start, editReadyMs,
        editCompile: editCompileIndex >= 0 ? {...compiles[editCompileIndex], finishedMs: compiledAt[editCompileIndex] - start} : undefined,
        upgradeCompile: upgradeIndex >= 0 ? {...compiles[upgradeIndex], finishedMs: compiledAt[upgradeIndex] - start} : undefined};
    }
    // Structural edits: each replaces one material's graph by an unseen structure.
    const edits: {atMs: number; readyMs?: number; installs: number; shaderKeyChanged: boolean; compiledKB?: number}[] = [];
    // Settled: the last decision is final, or the gate refused under the render target.
    const settled = (since: number) => { const last = upgrades.at(-1); return !!last && (['keep', 'rollback', 'failed', 'skip'].includes(last.type) || last.type === 'hold' && last.at >= since && last.maxSamples === render.maxSamples); };
    if (graphs && count && options.edits) {
      let next = firstIndex + 700000;
      for (let e = 0; e < options.edits; e++) {
        const editClass: GraphClass = e % 2 ? 'noise' : 'simple';
        const slot = e % materials.length, before = (engine.getDiagnostics()?.materialGraphs as {revision: number}).revision;
        if (options.editKind === 'parameter') materials[slot].graph = scalingGraph(indices[slot], graphClass, 1e6 + e);
        else { const index = structures(1, editClass, next)[0]; next = index + 1; materials[slot].graph = scalingGraph(index, editClass); }
        const editStart = performance.now(), installed = installs.length, compiled = compiles.length;
        const key = installs.at(-1)?.shaderKey;
        engine.update();
        let readyMs: number | undefined;
        for (const deadline = editStart + Math.max(options.editIntervalMs ?? 1000, 30000); performance.now() < deadline;) {
          const state = engine.getDiagnostics()?.materialGraphs as {revision: number; installedRevision: number; status: string};
          if (readyMs === undefined && state.revision > before && state.installedRevision >= state.revision) readyMs = performance.now() - editStart;
          if (readyMs !== undefined && performance.now() - editStart >= (options.editIntervalMs ?? 1000)) break;
          render.refine(); await pause();
        }
        edits.push({atMs: editStart - start, readyMs, installs: installs.length - installed, shaderKeyChanged: installs.at(-1)?.shaderKey !== key,
          compiledKB: compiles.length > compiled ? compiles.slice(compiled).reduce((n, c) => n + c.totalBytes / 1024, 0) : undefined});
      }
    }
    // Let the tier policy decide on an upgrade for a render of `targetSamples` (auto mode).
    const settleStart = performance.now();
    if (mode === 'auto' && graphs && count && !options.probe) {
      render.maxSamples = options.targetSamples ?? 2048; render.restart();
      for (const deadline = settleStart + (options.settleMs ?? 60000); !settled(settleStart) && performance.now() < deadline;) { render.refine(); await pause(); }
    }
    const settleMs = performance.now() - settleStart;
    // Where the policy stood at the end of the settle window: decided, or still compiling or
    // verifying an upgrade at the deadline (no final upgrade conclusion for such a row).
    const lastUpgrade = upgrades.at(-1);
    const settleOutcome = mode !== 'auto' || !graphs || !count || options.probe ? undefined : settled(settleStart) ? 'decided'
      : lastUpgrade?.type === 'start' ? 'compiling-at-deadline' : lastUpgrade?.type === 'installed' ? 'verifying-at-deadline' : 'undecided-at-deadline';
    // Fixed tiers for the measurements below.
    freezeMaterialGraphPolicy(true);
    render.maxSamples = 64;
    const optimizedMs = installs.length ? installs[installs.length - 1].at - start : undefined;
    const tiers = installs.map(e => ({atMs: e.at - start, interim: e.interim, role: e.role, specialized: e.specialized, interpreted: e.interpreted, coverage: e.coverage}));
    const diagnostics = engine.getDiagnostics();
    for (let i = 0; i < 2; i++) await render.converge({samples: 16, sampleSequenceOffset: 0, timeoutMs: 900000});
    let hdr: number[] | undefined;
    if (options.hdr) {
      await render.converge({samples: 64, sampleSequenceOffset: 0, timeoutMs: 900000});
      // Box-downsampled RGB keeps rows small while exposing material mismatches.
      const block = options.hdrBlock ?? 8, image = (await render.readPixels('hdr')).data as Float32Array, w = WIDTH / block, h = HEIGHT / block;
      hdr = new Array(w * h * 3).fill(0);
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) for (let c = 0; c < 3; c++)
        hdr[(Math.floor(y / block) * w + Math.floor(x / block)) * 3 + c] += image[(y * WIDTH + x) * 4 + c] / (block * block);
    }
    render.maxSamples = 4096; render.restart();
    const gpuSampleTimesMs: number[] = [];
    // Timestamps are read back asynchronously and not for every sample. Slow complex
    // scenes keep refining longer and record each new readback once.
    const refines = complex ? perfSamples * 4 : perfSamples;
    for (let i = 0, last: number | undefined; i < refines; i++) {
      render.refine(); await pause(); const t = render.gpuSampleTimeMs;
      if (t !== undefined && (!complex || t !== last)) gpuSampleTimesMs.push(t);
      last = t;
    }
    // Wall-clock throughput over 64 samples; GPU-bound scenes approach GPU time per sample.
    const wallSamplesMs: number[] = [];
    // The first block absorbs warm-up after the restart; complex scenes drop it.
    for (let i = 0; i < (complex ? 4 : 1); i++) {
      render.restart(); const wallStart = performance.now();
      await render.converge({samples: 64, sampleSequenceOffset: 0, timeoutMs: 900000});
      wallSamplesMs.push((performance.now() - wallStart) / 64);
    }
    // Swap to a disjoint structure set of the same size: measures a structure-set
    // change after the first graph variant is installed.
    let swap: {readyMs: number; optimizedMs?: number; firstFrameMs: number; pipelineMs?: number; sourceBytes?: number; status?: string} | undefined;
    if (options.swap && graphs && count && !complex) {
      const before = engine.getDiagnostics()?.materialGraphs as {revision: number} | undefined;
      const next = structures(count, graphClass, firstIndex + 500000);
      meshes.forEach((mesh, i) => { if (i < GRID * GRID) mesh.materials = [new OpenPBRMaterial({graph: scalingGraph(next[i % next.length], graphClass)})]; });
      const swapStart = performance.now();
      engine.update();
      const installed = installs.length;
      const state = await waitGraphs(before?.revision ?? 0, 120000);
      const readyMs = performance.now() - swapStart;
      for (const deadline = performance.now() + 120000; installs.length === installed && performance.now() < deadline;) { render.refine(); await pause(); }
      const optimizedMs = installs.length > installed ? installs[installs.length - 1].at - swapStart : undefined;
      await render.converge({samples: 1, sampleSequenceOffset: 0, timeoutMs: 900000});
      const compiled = engine.getDiagnostics()?.shaderCompilation;
      swap = {readyMs, optimizedMs, firstFrameMs: performance.now() - swapStart, pipelineMs: compiled?.pipelineCompilationTimeMs, sourceBytes: compiled?.sourceBytes, status: state?.status};
    }
    return {
      swap, scene: complex?.info, edits, settleMs, settleOutcome, probe,
      upgrades: upgrades.map(e => ({...e, atMs: e.at - start, key: undefined})),
      compiles: compiles.map(c => ({totalKB: c.totalBytes / 1024, specializedKB: c.specializedBytes / 1024, interpreterKB: c.interpreterBytes / 1024, ms: c.ms, overlapMs: c.overlapMs, kind: c.kind, referenceMs: c.referenceMs, ratio: c.ratio, speed: c.speed, specializedFactor: c.specializedFactor})),
      structures: count, mode, graphClass, firstIndex, bakeSize: mode === 'baked' ? bakeSize : undefined, width: WIDTH, height: HEIGHT, spheres: GRID * GRID,
      prepareMs, bakeMs: mode === 'baked' ? bakeMs : undefined, firstFrameMs, graphReadyMs, firstCorrectFrameMs, optimizedMs, tiers,
      gpuSampleTimeMs: median(gpuSampleTimesMs) ?? null, gpuSampleTimesMs, wallSampleMs: median(complex ? wallSamplesMs.slice(1) : wallSamplesMs), wallSamplesMs,
      shaderCompilation: diagnostics?.shaderCompilation, materialGraphs: graphState ?? diagnostics?.materialGraphs,
      materialTextures: diagnostics?.materialTextures, textureAtlas: (diagnostics as {textureAtlas?: unknown} | undefined)?.textureAtlas, lastError: engine.getDiagnostics()?.lastError, adapter: diagnostics?.adapterName, userAgent: navigator.userAgent, hdr
    };
  } finally { freezeMaterialGraphPolicy(false); render.dispose(); engine.dispose(); }
}
Object.assign(window, {runMaterialGraphScaling: run});
