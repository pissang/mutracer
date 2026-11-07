import {GeometryAttribute as Attribute, Camera, Engine, InstancedMesh, Mesh, OpenPBRMaterial, Render, SphereLight, Texture, createPlaneGeometry, createSphereGeometry} from '../../src/main.js';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass.js';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass.js';

/**
 * Mesh visibility, membership and texture-reference edits on a real GPU.
 * `measure` records update, preparation and first-sample latency per edit;
 * `parity` compares HDR pixels of an incrementally edited scene with a fresh
 * engine that prepares the edited scene from scratch.
 */
type Backend = 'webgpu' | 'webgl';
type Stage = {calls: number; ms: number};
const stages = new Map<string, Stage>();
const capacityEvents: {backend: Backend; before: number; after: number}[] = [];
function wrap(prototype: object, owner: string, names: string[]) {
  for (const name of names) {
    const original = (prototype as Record<string, unknown>)[name];
    if (typeof original !== 'function') continue;
    (prototype as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      const start = performance.now();
      try { return (original as (...a: unknown[]) => unknown).apply(this, args); } finally {
        const key = owner + '.' + name, stage = stages.get(key) ?? {calls: 0, ms: 0};
        stage.calls++; stage.ms += performance.now() - start; stages.set(key, stage);
      }
    };
  }
}
wrap(WGPURayTracePass.prototype, 'wgpu', ['_updateMeshData', '_updateMeshMembership', '_updateMaterialData', '_updateTextures', '_refitMeshInstances', '_updateLightSamplingData']);
wrap(WebGLRayTracePass.prototype, 'webgl', ['_updateMeshData', '_updateMeshMembership', '_updateMaterialData', '_refitMeshInstances']);
function wrapCapacity(prototype: object, backend: Backend) {
  const target = prototype as Record<string, any>, original = target._uploadBVH;
  target._uploadBVH = function(this: any, ...args: unknown[]) {
    const before = backend === 'webgpu' ? this._bvhBuffer?.size ?? 0 : (this._bvhData?.length ?? 0) * 4;
    const result = original.apply(this, args);
    const after = backend === 'webgpu' ? this._bvhBuffer?.size ?? 0 : (this._bvhData?.length ?? 0) * 4;
    if (after !== before) capacityEvents.push({backend, before, after});
    return result;
  };
}
wrapCapacity(WGPURayTracePass.prototype, 'webgpu'); wrapCapacity(WebGLRayTracePass.prototype, 'webgl');

const place = (mesh: Mesh, matrix: ArrayLike<number>) => { for (let i = 0; i < 16; i++) mesh.transform[i] = matrix[i]; };
const hasVisibility = 'visible' in new Mesh(createPlaneGeometry(), new OpenPBRMaterial());

function texture(size: number, seed: number) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = Math.floor(i / size), checker = ((x >> 4) + (y >> 4) + seed) & 1;
    data.set([checker ? 220 : 40 + seed * 30, (x * 255 / size + seed * 50) & 255, (y * 255 / size) & 255, 255], i * 4);
  }
  return new Texture({width: size, height: size, data});
}

export function createScene(count: number, materialCount: number, segments = 12, extras = false) {
  const textures = [texture(256, 0), texture(256, 1), texture(256, 2), texture(256, 3)];
  const materials = Array.from({length: materialCount}, (_, i) => new OpenPBRMaterial({
    baseColor: [0.2 + 0.6 * ((i * 37) % 11) / 10, 0.2 + 0.6 * ((i * 17) % 7) / 6, 0.4],
    specularRoughness: 0.2 + 0.6 * ((i * 13) % 5) / 4,
    map: i % 3 === 0 ? textures[(i / 3) % textures.length] : undefined
  }));
  const emissive = new OpenPBRMaterial({baseColor: [0, 0, 0], emissionColor: [1, 0.8, 0.5], emissionLuminance: 8});
  const side = Math.ceil(Math.sqrt(count));
  const meshes: Mesh[] = [];
  for (let i = 0; i < count; i++) {
    const mesh = new Mesh(createSphereGeometry(segments, segments), i === 0 ? emissive : materials[i % materialCount]);
    const x = (i % side) - side / 2, z = Math.floor(i / side) - side / 2, s = 0.4;
    place(mesh, [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, i === 0 ? 1.5 : 0.4, z, 1]);
    meshes.push(mesh);
  }
  if (extras) {
    // A batch and a two-material mesh exercise packed instances and per-triangle materials.
    const batch = new InstancedMesh(createSphereGeometry(segments, segments), materials[2 % materialCount], {count: 6});
    for (let i = 0; i < 6; i++) batch.transforms.set([0.25, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0.25, 0, i - 3, 1.1, 1, 1], i * 16);
    batch.markTransformsUpdated();
    const split = createSphereGeometry(segments, segments);
    split.materialIndex = new Attribute(new Int32Array(split.vertexCount).map((_, v) => v < split.vertexCount / 2 ? 0 : 1), 1);
    const multi = new Mesh(split, [materials[4 % materialCount], emissive]);
    place(multi, [0.6, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0.6, 0, 1.5, 1.2, -1, 1]);
    meshes.push(batch, multi);
  }
  const floor = new Mesh(createPlaneGeometry(), materials[1 % materialCount]);
  floor.transform[0] = floor.transform[10] = side * 1.2;
  meshes.push(floor);
  // Fixed IDs make ID AOVs and picks comparable across engines.
  meshes.forEach((mesh, i) => { mesh.aovId = i + 1; });
  [...materials, emissive].forEach((material, i) => { material.aovId = 10000 + i; });
  const light = new SphereLight({intensity: 40, radius: 0.5});
  light.position = [side * 0.3, side * 0.6, side * 0.2];
  const camera = new Camera({projection: 'perspective', aspect: 16 / 9, fov: 50});
  camera.position = [0, side * 0.55, side * 0.75]; camera.lookAt([0, 0, 0]);
  return {meshes, materials, textures, emissive, camera, scene: {meshes, lights: [light], background: [0.05, 0.06, 0.08, 1] as [number, number, number, number]}};
}
type Fixture = ReturnType<typeof createScene>;

function setVisible(fixture: Fixture, mesh: Mesh, visible: boolean, forceRemoval = false) {
  if (hasVisibility && !forceRemoval) { (mesh as Mesh & {visible: boolean}).visible = visible; return; }
  const index = fixture.meshes.indexOf(mesh);
  const meshes = fixture.scene.meshes.filter(item => item !== mesh);
  if (visible) meshes.splice(index, 0, mesh);
  fixture.scene.meshes = meshes;
}

/** Each edit returns its inverse; both are measured. */
function edits(fixture: Fixture): Record<string, () => [string, () => void]> {
  const {meshes, materials, textures} = fixture;
  const target = meshes[Math.floor(meshes.length / 2)];
  const textured = materials[3 % materials.length];
  const same = texture(256, 4), larger = texture(512, 5);
  return {
    noop: () => ['noop', () => {}],
    hide: () => { setVisible(fixture, target, false); return ['show', () => setVisible(fixture, target, true)]; },
    hideEmissive: () => { setVisible(fixture, meshes[0], false); return ['showEmissive', () => setVisible(fixture, meshes[0], true)]; },
    remove: () => { setVisible(fixture, target, false, true); return ['readd', () => setVisible(fixture, target, true, true)]; },
    addShared: () => {
      const mesh = new Mesh(target.geometry, target.materials[0]); place(mesh, target.transform); mesh.transform[13] += 1;
      fixture.scene.meshes = [...fixture.scene.meshes, mesh];
      return ['removeShared', () => { fixture.scene.meshes = fixture.scene.meshes.filter(item => item !== mesh); }];
    },
    addNewGeometry: () => {
      const mesh = new Mesh(createSphereGeometry(12, 12), target.materials[0]); place(mesh, target.transform); mesh.transform[13] += 1;
      fixture.scene.meshes = [...fixture.scene.meshes, mesh];
      return ['removeNewGeometry', () => { fixture.scene.meshes = fixture.scene.meshes.filter(item => item !== mesh); }];
    },
    textureResident: () => { const previous = textured.map; textured.map = textures[(textures.indexOf(previous!) + 1) % textures.length]; return ['textureResidentBack', () => { textured.map = previous; }]; },
    textureSameSize: () => { const previous = textured.map; textured.map = same; return ['textureSameSizeBack', () => { textured.map = previous; }]; },
    textureLarger: () => { const previous = textured.map; textured.map = larger; return ['textureLargerBack', () => { textured.map = previous; }]; }
  };
}

async function createEngine(backend: Backend, fixture: Fixture, width: number, height: number, textureBinding: 'atlas' | 'auto' = 'atlas', aovs: 'id'[] = []) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const engine = new Engine({canvas, backend, textureBinding});
  const errors: string[] = [];
  engine.on('error', error => errors.push(error.message));
  engine.display.setSize(width, height);
  engine.scene = fixture.scene; engine.camera = fixture.camera;
  await engine.init();
  const render = new Render(engine, {width, height, maxSamples: 1, bounces: 4, aovs});
  let bvhEvents = 0;
  engine.on('progress', progress => { if (progress.stage === 'bvh') bvhEvents++; });
  return {engine, render, errors, bvhEvents: () => bvhEvents};
}

async function timed(context: Awaited<ReturnType<typeof createEngine>>, apply: () => void) {
  stages.clear();
  const events = context.bvhEvents();
  const start = performance.now();
  apply();
  context.engine.update();
  const update = performance.now() - start;
  await context.render.converge({samples: 1, timeoutMs: 180000});
  const first = performance.now() - start;
  return {update_ms: update, first_sample_ms: first, bvh_events: context.bvhEvents() - events,
    stages: Object.fromEntries([...stages].map(([key, value]) => [key, {calls: value.calls, ms: +value.ms.toFixed(3)}]))};
}

export async function measure(backend: Backend, count = 1000, materialCount = 100, repeats = 5, only?: string[], textureBinding: 'atlas' | 'auto' = 'atlas') {
  const fixture = createScene(count, materialCount);
  const context = await createEngine(backend, fixture, 640, 360, textureBinding);
  const rows: Record<string, unknown>[] = [];
  try {
    const initial = await timed(context, () => {});
    rows.push({edit: 'initial', round: 0, ...initial});
    const list = edits(fixture);
    for (const [name, edit] of Object.entries(list)) {
      if (only && !only.includes(name)) continue;
      for (let round = 0; round <= repeats; round++) {
        let inverse: [string, () => void] = ['', () => {}];
        rows.push({edit: name, round, ...await timed(context, () => { inverse = edit(); })});
        rows.push({edit: inverse[0], round, ...await timed(context, inverse[1])});
      }
    }
    if (context.errors.length) throw new Error(context.errors.join('\n'));
    return {backend, textureBinding, hasVisibility, count, materialCount, adapter: context.engine.info?.adapterName, userAgent: navigator.userAgent, rows};
  } finally { context.render.dispose(); context.engine.dispose(); }
}

async function capture(backend: Backend, fixture: Fixture, prepare?: (context: Awaited<ReturnType<typeof createEngine>>) => Promise<void>, textureBinding: 'atlas' | 'auto' = 'atlas') {
  const context = await createEngine(backend, fixture, 256, 144, textureBinding, ['id']);
  try {
    context.engine.update();
    await context.render.converge({samples: 1, timeoutMs: 180000});
    if (prepare) await prepare(context);
    await context.render.converge({samples: 16, sampleSequenceOffset: 3, timeoutMs: 180000});
    const pixels = await context.render.readPixels('hdr');
    const ids = await context.render.readPixels('id');
    const picks = [];
    for (const [x, y] of [[0.5, 0.5], [0.25, 0.4], [0.75, 0.6], [0.5, 0.2]]) {
      picks.push(await context.engine._pick(x, y));
    }
    if (context.errors.length) throw new Error(context.errors.join('\n'));
    return {pixels: pixels.data, ids: ids.data, picks: JSON.stringify(picks)};
  } finally { context.render.dispose(); context.engine.dispose(); }
}

function compare(a: Float32Array, b: Float32Array) {
  let different = 0, max = 0, sumA = 0, sumB = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) { different++; max = Math.max(max, Math.abs(a[i] - b[i])); }
    if (i % 4 !== 3) { sumA += a[i]; sumB += b[i]; }
  }
  return {different, max, meanA: sumA / (a.length * 0.75), meanB: sumB / (b.length * 0.75)};
}

/** Incremental edit chain versus a fresh engine preparing the resulting scene. */
export async function parity(backend: Backend, count = 64, materialCount = 12, textureBinding: 'atlas' | 'auto' = 'atlas') {
  const results: Record<string, unknown>[] = [];
  const cases: [string, (fixture: Fixture) => void, (fixture: Fixture) => void][] = [
    ['none', () => {}, () => {}],
    ['freshControl', () => {}, () => {}],
    // [name, edit applied incrementally after a first sample, the same edit before a fresh engine]
    ['hide', f => setVisible(f, f.meshes[Math.floor(f.meshes.length / 2)], false), f => setVisible(f, f.meshes[Math.floor(f.meshes.length / 2)], false, true)],
    ['hideShow', f => { const m = f.meshes[Math.floor(f.meshes.length / 2)]; setVisible(f, m, false); }, () => {}],
    ['hideEmissive', f => setVisible(f, f.meshes[0], false), f => setVisible(f, f.meshes[0], false, true)],
    ['hideFloorAndEmissive', f => { setVisible(f, f.meshes[0], false); setVisible(f, f.meshes[f.meshes.length - 1], false); },
      f => { f.scene.meshes = f.meshes.slice(1, -1); }],
    ['remove', f => setVisible(f, f.meshes[5], false, true), f => setVisible(f, f.meshes[5], false, true)],
    ['addShared', f => { const m = new Mesh(f.meshes[5].geometry, f.meshes[5].materials[0]); m.aovId = 5000; place(m, f.meshes[5].transform); m.transform[13] += 1; f.scene.meshes = [...f.scene.meshes, m]; },
      f => { const m = new Mesh(f.meshes[5].geometry, f.meshes[5].materials[0]); m.aovId = 5000; place(m, f.meshes[5].transform); m.transform[13] += 1; f.scene.meshes = [...f.scene.meshes, m]; }],
    ['addNewGeometry', f => { const m = new Mesh(createSphereGeometry(6, 6), f.meshes[5].materials[0]); m.aovId = 5001; place(m, f.meshes[5].transform); m.transform[12] += 1; f.scene.meshes = [...f.scene.meshes, m]; },
      f => { const m = new Mesh(createSphereGeometry(6, 6), f.meshes[5].materials[0]); m.aovId = 5001; place(m, f.meshes[5].transform); m.transform[12] += 1; f.scene.meshes = [...f.scene.meshes, m]; }],
    ['addEmissiveGeometry', f => { const m = new Mesh(createSphereGeometry(6, 6), f.emissive); m.aovId = 5002; place(m, f.meshes[5].transform); m.transform[13] += 2; f.scene.meshes = [...f.scene.meshes, m]; },
      f => { const m = new Mesh(createSphereGeometry(6, 6), f.emissive); m.aovId = 5002; place(m, f.meshes[5].transform); m.transform[13] += 2; f.scene.meshes = [...f.scene.meshes, m]; }],
    ['addInstanceBatch', f => { const m = new InstancedMesh(createSphereGeometry(5, 5), f.meshes[5].materials[0], {count: 3}); m.aovId = 5003; for (let i = 0; i < 3; i++) m.transforms.set([.3,0,0,0,0,.3,0,0,0,0,.3,0,i-1,1,0,1], i*16); m.markTransformsUpdated(); f.scene.meshes = [...f.scene.meshes, m]; },
      f => { const m = new InstancedMesh(createSphereGeometry(5, 5), f.meshes[5].materials[0], {count: 3}); m.aovId = 5003; for (let i = 0; i < 3; i++) m.transforms.set([.3,0,0,0,0,.3,0,0,0,0,.3,0,i-1,1,0,1], i*16); m.markTransformsUpdated(); f.scene.meshes = [...f.scene.meshes, m]; }],
    ['hiddenAtStart', f => setVisible(f, f.meshes[7], true), () => {}],
    ['hideInstanced', f => setVisible(f, f.meshes[count], false), f => setVisible(f, f.meshes[count], false, true)],
    ['hideMultiMaterial', f => setVisible(f, f.meshes[count + 1], false), f => setVisible(f, f.meshes[count + 1], false, true)],
    ['hideShowMultiMaterial', f => setVisible(f, f.meshes[count + 1], false), () => {}],
    ['textureResident', f => { f.materials[3].map = f.textures[2]; }, f => { f.materials[3].map = f.textures[2]; }],
    ['textureSameSize', f => { f.materials[3].map = texture(256, 4); }, f => { f.materials[3].map = texture(256, 4); }]
  ];
  for (const [name, incremental, fresh] of cases) {
    const edited = createScene(count, materialCount, 8, true);
    if (name === 'hiddenAtStart') setVisible(edited, edited.meshes[7], false);
    const a = await capture(backend, edited, name === 'freshControl' ? undefined : async context => {
      incremental(edited);
      if (name === 'hideShow' || name === 'hideShowMultiMaterial') {
        context.engine.update(); await context.render.converge({samples: 1, timeoutMs: 180000});
        setVisible(edited, name === 'hideShow' ? edited.meshes[Math.floor(edited.meshes.length / 2)] : edited.meshes[count + 1], true);
      }
      context.engine.update();
    }, textureBinding);
    const reference = createScene(count, materialCount, 8, true);
    fresh(reference);
    const b = await capture(backend, reference, undefined, textureBinding);
    let idDifferences = 0;
    const idComponents = [0, 0, 0, 0], idSamples: number[][] = [];
    for (let i = 0; i < a.ids.length; i++) if (a.ids[i] !== b.ids[i]) {
      idDifferences++; idComponents[i % 4]++;
      if (idSamples.length < 3) { const p = i - i % 4; idSamples.push([...a.ids.subarray(p, p + 4), ...b.ids.subarray(p, p + 4)]); }
    }
    results.push({name, ...compare(a.pixels, b.pixels), idDifferences, idComponents, idSamples, picksEqual: a.picks === b.picks, picks: a.picks});
  }
  return {backend, textureBinding, hasVisibility, results};
}

type AppendOperation = (fixture: Fixture) => void;
function appendOperations(): [string, AppendOperation][] {
  const add = (segments: number, id: number, emissiveMaterial = false): AppendOperation => fixture => {
    const source = fixture.meshes[5], mesh = new Mesh(createSphereGeometry(segments, segments), emissiveMaterial ? fixture.emissive : source.materials[0]);
    mesh.aovId = id; place(mesh, source.transform); mesh.transform[12] += (id % 7) - 3; mesh.transform[13] += 1 + (id % 3);
    fixture.scene.meshes = [...fixture.scene.meshes, mesh];
  };
  return [
    ['small', add(4, 6001)], ['mediumEmissive', add(12, 6002, true)], ['large', add(32, 6003)],
    ['multiGeometry', fixture => { add(5, 6004)(fixture); add(7, 6005)(fixture); add(9, 6006)(fixture); }],
    ['instanceBatch', fixture => { const mesh = new InstancedMesh(createSphereGeometry(8, 8), fixture.meshes[5].materials[0], {count: 5}); mesh.aovId = 6007;
      for (let i = 0; i < 5; i++) mesh.transforms.set([.2,0,0,0,0,.2,0,0,0,0,.2,0,i-2,1.5,2,1], i*16); mesh.markTransformsUpdated(); fixture.scene.meshes = [...fixture.scene.meshes, mesh]; }],
    ['deleteAfterAppend', fixture => { fixture.scene.meshes = fixture.scene.meshes.filter(mesh => mesh.aovId !== 6002); }],
    ...Array.from({length: 8}, (_, i) => [`growth${i + 1}`, add(10 + i, 6100 + i)] as [string, AppendOperation]),
    ...Array.from({length: 4}, (_, i) => [`churnDelete${i + 1}`, (fixture: Fixture) => {
      const remove = 6100 + i * 2; fixture.scene.meshes = fixture.scene.meshes.filter(mesh => mesh.aovId !== remove); add(11 + i, 6200 + i)(fixture);
    }] as [string, AppendOperation])
  ];
}

async function renderState(context: Awaited<ReturnType<typeof createEngine>>) {
  await context.render.converge({samples: 16, sampleSequenceOffset: 3, timeoutMs: 180000});
  const pixels = (await context.render.readPixels('hdr')).data, ids = (await context.render.readPixels('id')).data;
  const picks = [];
  for (const [x, y] of [[.5,.5],[.25,.4],[.75,.6],[.5,.2]]) picks.push(await context.engine._pick(x, y));
  return {pixels, ids, picks: JSON.stringify(picks)};
}

/** Sequential append/growth/delete/churn versus a fresh full preparation after every step. */
export async function appendSequenceParity(backend: Backend, textureBinding: 'atlas' | 'auto' = 'atlas') {
  const fixture = createScene(24, 8), context = await createEngine(backend, fixture, 256, 144, textureBinding, ['id']);
  const operations = appendOperations(), results: Record<string, unknown>[] = [], persistentCapacityEvents: typeof capacityEvents = []; capacityEvents.length = 0;
  try {
    context.engine.update(); await context.render.converge({samples: 1, timeoutMs: 180000});
    for (let step = 0; step < operations.length; step++) {
      const [name, operation] = operations[step], beforeEvents = capacityEvents.length, start = performance.now();
      operation(fixture); context.engine.update(); const updateMs = performance.now() - start;
      const incremental = await renderState(context);
      const incrementalCapacityEvents = capacityEvents.slice(beforeEvents); persistentCapacityEvents.push(...incrementalCapacityEvents); capacityEvents.length = 0;
      const reference = createScene(24, 8); for (let i = 0; i <= step; i++) operations[i][1](reference);
      // Match WebGL's known extra-update sampling lifecycle while keeping the
      // reference geometry on the ordinary full-preparation path.
      const fresh = await capture(backend, reference, async freshContext => { freshContext.engine.update(); }, textureBinding);
      capacityEvents.length = 0;
      const hdr = compare(incremental.pixels, fresh.pixels); let idDifferences = 0;
      for (let i = 0; i < incremental.ids.length; i++) if (incremental.ids[i] !== fresh.ids[i]) idDifferences++;
      results.push({name, updateMs, ...hdr, idDifferences, picksEqual: incremental.picks === fresh.picks,
        activeMeshes: fixture.scene.meshes.length, capacityEvents: incrementalCapacityEvents});
    }
    return {backend, textureBinding, results, capacityEvents: persistentCapacityEvents};
  } finally { context.render.dispose(); context.engine.dispose(); }
}

/** Performance dimensions requested by P0-2f; each case uses a fresh engine. */
export async function appendPerformanceMatrix(backend: Backend, count: number, materialCount: number, textureBinding: 'atlas' | 'auto' = 'atlas') {
  const cases: [string, AppendOperation][] = [
    ['small', appendOperations()[0][1]], ['medium', appendOperations()[1][1]], ['large', appendOperations()[2][1]],
    ['multiGeometry', appendOperations()[3][1]], ['instanceBatch', appendOperations()[4][1]]
  ];
  const rows = [];
  for (const [name, operation] of cases) {
    const fixture = createScene(count, materialCount), context = await createEngine(backend, fixture, 640, 360, textureBinding);
    try { context.engine.update(); await context.render.converge({samples: 1, timeoutMs: 180000}); rows.push({name, ...await timed(context, () => operation(fixture))}); }
    finally { context.render.dispose(); context.engine.dispose(); }
  }
  return {backend, count, materialCount, textureBinding, rows};
}

Object.assign(window, {meshEditTests: {measure, parity, appendSequenceParity, appendPerformanceMatrix}});
