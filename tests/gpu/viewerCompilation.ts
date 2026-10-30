import {ViewerEngine} from '../../viewer/src/engine/ViewerEngine';
import {createMaterialSpheres} from '../../viewer/src/engine/loadModel';
import {setSettings, useViewer, type TreeNode} from '../../viewer/src/store';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass';
import type {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function firstMaterial(nodes: TreeNode[]): string | undefined {
  for (const node of nodes) {
    if (node.materials.length) return node.materials[0].id;
    const found = firstMaterial(node.children);
    if (found) return found;
  }
}

// Exercise actual material uploads, fallback presentation and emitter caches.
// Distinct bevel probe counts require different preview/final pipeline variants.
export async function capture(lightTracing = true, photonMapping = true, slot: 'map' | 'normalMap' = 'map') {
  setSettings({maxSamples: 2, resolutionScale: 1, denoise: false, autoRotate: false,
    envId: 'sky', caustics: true, causticLightTracing: lightTracing, causticPhotonMapping: photonMapping});
  useViewer.setState({paused: true});
  const viewer = new ViewerEngine(document.querySelector('canvas')!);
  const errors: string[] = [];
  viewer.engine.on('error', error => errors.push(error.message));
  const update = WGPURayTracePass.prototype.updatePipeline;
  let pending = Promise.resolve();
  WGPURayTracePass.prototype.updatePipeline = function() {
    return pending = update.call(this);
  };
  try {
    await viewer.loadModel(createMaterialSpheres());
    await viewer.engine.init();
    if (viewer.engine.backend !== 'webgpu') throw new Error('This test requires WebGPU');
    cancelAnimationFrame((viewer as unknown as {raf: number}).raf);
    viewer.engine.display.setSize(192, 128);
    // Keep sampling deterministic under the test's manual ticks. A generous
    // budget prevents fallback tracing from replacing the old preview variant.
    useViewer.setState({paused: true});
    viewer.final.batchSamples = false;
    viewer.final.timeBudgetMs = 1000;
    viewer.final.bevelSamples = 7;
    const until = async (done: () => boolean, label: string) => {
      const start = performance.now();
      while (!done()) {
        if (errors.length) throw new Error(errors[0]);
        if (performance.now() - start > 60000) throw new Error(`${label} timed out`);
        viewer.loop.tick();
        await wait(16);
      }
    };
    const select = viewer.loop.select;
    viewer.loop.select = () => 'preview';
    await until(() => viewer.preview._complete, 'Preview warmup');
    const material = firstMaterial(useViewer.getState().tree);
    if (!material) throw new Error('No editable material');
    const image = document.createElement('canvas');
    image.width = image.height = 16;
    const context = image.getContext('2d')!;
    context.fillStyle = slot === 'normalMap' ? '#8080ff' : '#ffaa33'; context.fillRect(0, 0, 16, 16);
    const blob = await new Promise<Blob>((resolve, reject) => image.toBlob(value =>
      value ? resolve(value) : reject(new Error('Unable to encode texture'))));
    await viewer.setMaterialTexture(material, slot, blob, 'Compilation test map');
    viewer.engine.update(); viewer.loop.tick();
    await until(() => viewer.preview._complete, 'Edited preview');
    viewer.loop.select = select;
    // Settle the final variant before bringing the old preview back. This
    // fixes the completion/presentation ordering instead of relying on timing.
    viewer.final.refine();
    await pending;
    viewer.engine.display.present(viewer.preview);
    const phases = new Set<string>();
    const start = performance.now();
    await until(() => {
      phases.add(viewer.final.status);
      return viewer.final.status === 'finished';
    }, 'Final convergence');
    const pixels = await viewer.final.readPixels('hdr');
    return {passed: errors.length === 0 && viewer.final.status === 'finished' && viewer.final.samples === 2 && pixels.data.every(Number.isFinite),
      samples: viewer.final.samples, status: viewer.final.status, phases: [...phases],
      elapsedMs: performance.now() - start, width: pixels.width, height: pixels.height,
      diagnostics: viewer.engine.getDiagnostics(), errors};
  } finally {
    WGPURayTracePass.prototype.updatePipeline = update;
    viewer.dispose();
  }
}

export async function stress(iterations = 32, denoise = false) {
  setSettings({maxSamples: 8, resolutionScale: 1, denoise, denoiseModel: 'standard', oidnModel: 'standard',
    denoiseWhileConverging: denoise, autoRotate: false,
    envId: 'sky', caustics: true, causticLightTracing: true, causticPhotonMapping: true});
  useViewer.setState({paused: false});
  const viewer = new ViewerEngine(document.querySelector('canvas')!);
  const errors: string[] = [], events: unknown[] = [];
  viewer.engine.on('error', error => errors.push(error.message));
  try {
    await viewer.loadModel(createMaterialSpheres());
    await viewer.engine.init();
    if (viewer.engine.backend !== 'webgpu') throw new Error('This test requires WebGPU');
    const material = firstMaterial(useViewer.getState().tree);
    if (!material) throw new Error('No editable material');
    let pendingCamera: number | undefined;
    const finish = async () => {
      const start = performance.now();
      let finishedAt: number | undefined;
      for (;;) {
        if (errors.length) throw new Error(errors[0]);
        if (performance.now() - start > 120000) throw new Error('Final convergence timed out');
        // An edit can precede the next scene commit. Do not accept its previous
        // completed image, and require completion to survive several frames.
        const committed = pendingCamera === undefined || viewer.engine._inputs.camera !== pendingCamera;
        if (committed && viewer.final.status === 'finished' && viewer.final.samples === 8) {
          finishedAt ??= performance.now();
          if (performance.now() - finishedAt >= 200) break;
        } else finishedAt = undefined;
        await wait(50);
      }
      pendingCamera = undefined;
      events.push({stage: 'finished', samples: viewer.final.samples});
    };
    const controls = (viewer as unknown as {controls: OrbitControls}).controls;
    const image = document.createElement('canvas');
    image.width = image.height = 16;
    const context = image.getContext('2d')!;
    const blob = async (color: string) => {
      context.fillStyle = color; context.fillRect(0, 0, 16, 16);
      return new Promise<Blob>((resolve, reject) => image.toBlob(value =>
        value ? resolve(value) : reject(new Error('Unable to encode texture'))));
    };
    const color = await blob('#ffaa33'), normal = await blob('#8080ff');
    await finish();
    const edits = async (edit: number) => {
      pendingCamera = viewer.engine._inputs.camera;
      setSettings({causticLightTracing: edit % 4 < 2, causticPhotonMapping: edit % 4 >= 1,
        samplingPattern: edit % 3 === 0 ? 'random' : edit % 3 === 1 ? 'zsobol' : 'sobol'});
      const slot = edit % 2 ? 'normalMap' : 'map';
      await viewer.setMaterialTexture(material, slot, edit % 5 === 0 ? null : slot === 'map' ? color : normal, 'Stress texture');
      viewer.setMaterialValues(material, {coatWeight: edit % 2, thinFilmWeight: edit % 3 === 0 ? 1 : 0}, 'Stress layers');
      controls.object.position.x += .03;
      controls.update();
      events.push({stage: 'edit', edit, status: viewer.final.status, samples: viewer.final.samples});
    };
    // Leave real asynchronous compilations in flight while further edits arrive.
    for (let edit = 0; edit < iterations; edit++) {
      await edits(edit);
      await wait([20, 50, 100, 250][edit % 4]);
    }
    await finish();
    // Also settle each estimator combination, then revisit it from the cache.
    for (let edit = iterations; edit < iterations + 8; edit++) {
      await edits(edit); await finish();
    }
    const pixels = await viewer.final.readPixels('hdr');
    return {passed: errors.length === 0 && viewer.final.status === 'finished' && viewer.final.samples === 8 && pixels.data.every(Number.isFinite), iterations,
      status: viewer.final.status, samples: viewer.final.samples, diagnostics: viewer.engine.getDiagnostics(), errors, events};
  } finally { viewer.dispose(); }
}

Object.assign(window, {viewerCompilationTests: {capture, stress}});
