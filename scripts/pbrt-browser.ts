import * as THREE from 'three';
import { Engine, Render, THREESync } from '../src/main';
import { buildScene } from '../tools/pbrt/scene';
import { convert } from '../tools/pbrt/convert';
import { urlResolver } from '../tools/pbrt/source';
import { decodeImage } from '../tools/pbrt/image-browser';

const save = async (name: string, body: BodyInit) => { const response = await fetch('/evidence/' + name, { method: 'POST', body }); if (!response.ok) throw new Error(`Failed to save ${name}`); };
async function run(sequenceOffset = 0, prefix = '') {
  const q = new URLSearchParams(location.search), started = performance.now();
  const width = Number(q.get('width')), height = Number(q.get('height')), samples = Number(q.get('spp'));
  const checkpoint = async (stage: string) => save(prefix + 'stage.json', JSON.stringify({ stage, elapsedMs: performance.now() - started }));
  let lastProgress = 0;
  const onProgress = (progress: { stage: string; samples: number; targetSamples: number }) => {
    const now = performance.now();
    if (now - lastProgress < 1000 && progress.samples !== progress.targetSamples) return;
    lastProgress = now;
    void save(prefix + 'progress.json', JSON.stringify({ ...progress, elapsedMs: now - started })).catch(() => {});
  };
  await checkpoint('parse');
  const baseResolver = urlResolver(); let downloadBytes = 0;
  const resolver = { async read(path: string) { const data = await baseResolver.read(path); downloadBytes += data.byteLength; return data; } };
  let peakJSHeapBytes = 0;
  const memoryTimer = setInterval(() => { peakJSHeapBytes = Math.max(peakJSHeapBytes, (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0); }, 50);
  const parsed = await buildScene(new URL('/asset/' + q.get('scene'), location.href).href, resolver);
  if (parsed.film) for (const [name, value] of [['xresolution', width], ['yresolution', height]] as const) parsed.film.params[name] = { type: 'integer', name, values: [value], loc: parsed.film.loc };
  await checkpoint('convert');
  const model = await convert(parsed, resolver, decodeImage, undefined, undefined, q.has('webgl') ? 'webgl' : 'webgpu');
  await save(prefix + 'import.json', JSON.stringify({ settings: model.settings, warnings: parsed.warnings, downloadBytes, elapsedMs: performance.now() - started }));
  const scene = new THREE.Scene(); scene.add(model.root);
  if (model.environment) {
    const image = model.environment, map = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat, THREE.FloatType);
    map.flipY = true; map.needsUpdate = true; scene.environment = map;
  }
  if (!model.environment) scene.background = new THREE.Color(0, 0, 0);
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined;
  model.root.traverse(o => { if ((o as THREE.Camera).isCamera) camera = o as typeof camera; });
  if (!camera) throw new Error('Scene has no camera');
  const approximate = new Set<number>();
  const engine = new Engine({ canvas: document.querySelector('canvas')!, backend: q.has('webgl') ? 'webgl' : 'webgpu' });
  engine.display.setSize(width, height); engine.display.toneMappingExposure = 1; engine.display.bloomIntensity = 0; engine.display.toneMapping = 'reinhard';
  const render = new Render(engine, { width, height, maxSamples: samples, bounces: model.settings.bounces, bevel: false, aovs: ['id'] });
  const sync = new THREESync(engine, { scene, camera, onMeshConverted(mesh, source) {
    const m = Array.isArray(source.material) ? source.material[0] : source.material;
    if (m.userData.pbrtComparable === false) approximate.add(mesh.materials[0].aovId);
  } });
  const errors: string[] = [];
  engine.on('error', event => errors.push(event.message));
  try {
    sync.update(); if (!engine.camera) throw new Error('PBRT camera synchronization failed'); engine.camera.fStop = model.settings.fStop; engine.camera.focusDistance = model.settings.focusDistance; engine.camera.metersPerUnit = 1; engine.update();
    await checkpoint('device-and-pipelines');
    await engine.init();
    const adapter = engine.info;
    const loadedMs = performance.now() - started;
    await checkpoint('render');
    await render.converge({ samples, sampleSequenceOffset: sequenceOffset, timeoutMs: 600000, onProgress });
    const hdr = await render.readPixels('hdr'), ids = await render.readPixels('id');
    await save(prefix + 'mutracer.f32', hdr.data as unknown as BodyInit); await save(prefix + 'ids.u32', ids.data as unknown as BodyInit);
    await save(prefix + 'mutracer.png', await engine.display.toBlob(render));
    let oidnMs: number | undefined;
    if (q.has('oidn') && !q.has('webgl')) {
      await checkpoint('oidn');
      const start = performance.now();
      await render.setDenoiser({ type: 'oidn', model: 'standard', weightsBaseUrl: new URL('/oidn/weights/', location.href).href });
      // refine at the completed cap filters the existing accumulation; converge
      // starts a new render, which would charge a second beauty pass to OIDN.
      onProgress({ stage: 'denoising', samples, targetSamples: samples });
      while (true) {
        const status = render.refine();
        if (status === 'error') throw new Error(errors.at(-1) ?? 'OIDN failed');
        if (render.samples !== samples) throw new Error('Denoising changed the completed sample count');
        if (status === 'finished') break;
        if (performance.now() - start > 600000) throw new Error('OIDN timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const after = await render.readPixels('hdr');
      if (!hdr.data.every((value, i) => value === after.data[i])) throw new Error('Denoising changed linear HDR samples');
      await save(prefix + 'mutracer-oidn.png', await engine.display.toBlob(render)); oidnMs = performance.now() - start;
    }
    return { sceneComparable: model.root.userData.pbrtComparable !== false, loadedMs, downloadBytes, oidnMs, peakJSHeapBytes, elapsedMs: performance.now() - started, samples: render.samples, width, height, warnings: parsed.warnings, approximateMaterialIds: [...approximate], errors, adapter, exposure: model.settings.exposure,
      memory: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize };
  } finally { clearInterval(memoryTimer); sync.dispose(); render.dispose(); engine.dispose(); }
}
(window as unknown as { runBenchmark: typeof run }).runBenchmark = run;
