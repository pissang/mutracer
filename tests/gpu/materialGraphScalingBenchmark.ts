import {Engine, Render, Camera, Mesh, OpenPBRMaterial, AmbientLight, SphereLight, Texture, createSphereGeometry, createPlaneGeometry} from '../../src/main.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {evaluateGraph} from '../../src/renderer/materialGraph/evaluate.js';
import {setMaterialGraphTier} from '../../src/renderer/materialGraph/state.js';
import {scalingGraph, type GraphClass} from './materialGraphScalingScene.js';

/** Material-graph scaling harness: one fixed 32×32 sphere grid, N distinct graph
 * structures assigned round-robin, rendered as graphs, as their exact UV bakes,
 * or as constants. Timings report rather than gate. */
type Mode = 'constant' | 'baked' | 'graph' | 'interpreter';
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

async function run(options: {structures: number; mode: Mode; graphClass?: GraphClass; bakeSize?: number; perfSamples?: number; textureBinding?: 'atlas' | 'auto'; hdr?: boolean; firstIndex?: number; closeUp?: boolean; hdrBlock?: number; swap?: boolean}) {
  const {structures: count, mode, graphClass = 'simple', bakeSize = 128, perfSamples = 50, textureBinding = 'auto', firstIndex = 0} = options;
  // 'interpreter' renders the same graphs as 'graph' on the shared interpreter tier.
  setMaterialGraphTier(mode === 'interpreter' ? 'interpreter' : 'specialized');
  const graphs = mode === 'graph' || mode === 'interpreter';
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
  const sphere = createSphereGeometry(32, 16), meshes: Mesh[] = [];
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
  const render = new Render(engine, {bounces: 6, directLightCandidates: 1, samplingPattern: 'sobol', maxSamples: 64, denoiser: null});
  const prepareMs = performance.now() - prepareStart;
  try {
    const start = performance.now();
    engine.update();
    let graphReadyMs: number | undefined, graphState: {status: string; topologyCount: number} | undefined;
    await render.converge({samples: 1, sampleSequenceOffset: 0, timeoutMs: 900000});
    const firstFrameMs = performance.now() - start;
    const waitGraphs = async (revision = 0) => {
      for (const deadline = performance.now() + 900000; performance.now() < deadline;) {
        const state = engine.getDiagnostics()?.materialGraphs as {status: string; topologyCount: number; revision: number} | undefined;
        if (state && state.topologyCount > 0 && state.revision > revision && (state.status === 'ready' || state.status === 'failed')) return state;
        render.refine(); await pause();
      }
    };
    if (graphs && count) {
      // Graph state exists only once the pipeline has seen the scene; keep sampling while it compiles.
      graphState = await waitGraphs();
      graphReadyMs = performance.now() - start;
      await render.converge({samples: 1, sampleSequenceOffset: 0, timeoutMs: 900000});
    }
    const firstCorrectFrameMs = performance.now() - start;
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
    for (let i = 0; i < perfSamples; i++) { render.refine(); await pause(); const t = render.gpuSampleTimeMs; if (t !== undefined) gpuSampleTimesMs.push(t); }
    // Swap to a disjoint structure set of the same size: measures a structure-set
    // change after the first graph variant is installed.
    let swap: {readyMs: number; firstFrameMs: number; pipelineMs?: number; sourceBytes?: number; status?: string} | undefined;
    if (options.swap && graphs && count) {
      const before = engine.getDiagnostics()?.materialGraphs as {revision: number} | undefined;
      const next = structures(count, graphClass, firstIndex + 500000);
      meshes.forEach((mesh, i) => { if (i < GRID * GRID) mesh.material = new OpenPBRMaterial({graph: scalingGraph(next[i % next.length], graphClass)}); });
      const swapStart = performance.now();
      engine.update();
      const state = await waitGraphs(before?.revision ?? 0);
      const readyMs = performance.now() - swapStart;
      await render.converge({samples: 1, sampleSequenceOffset: 0, timeoutMs: 900000});
      const compiled = engine.getDiagnostics()?.shaderCompilation;
      swap = {readyMs, firstFrameMs: performance.now() - swapStart, pipelineMs: compiled?.pipelineCompilationTimeMs, sourceBytes: compiled?.sourceBytes, status: state?.status};
    }
    return {
      swap,
      structures: count, mode, graphClass, firstIndex, bakeSize: mode === 'baked' ? bakeSize : undefined, width: WIDTH, height: HEIGHT, spheres: GRID * GRID,
      prepareMs, bakeMs: mode === 'baked' ? bakeMs : undefined, firstFrameMs, graphReadyMs, firstCorrectFrameMs,
      gpuSampleTimeMs: median(gpuSampleTimesMs) ?? null, gpuSampleTimesMs,
      shaderCompilation: diagnostics?.shaderCompilation, materialGraphs: graphState ?? diagnostics?.materialGraphs,
      materialTextures: diagnostics?.materialTextures, textureAtlas: (diagnostics as {textureAtlas?: unknown} | undefined)?.textureAtlas, lastError: engine.getDiagnostics()?.lastError, adapter: diagnostics?.adapterName, userAgent: navigator.userAgent, hdr
    };
  } finally { render.dispose(); engine.dispose(); }
}
Object.assign(window, {runMaterialGraphScaling: run});
