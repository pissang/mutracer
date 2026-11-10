import {Engine} from '../../src/main.js';
import {WebEngine} from '../../viewer/src/engine/WebEngine';
import {createMaterialSpheres} from '../../viewer/src/engine/loadModel';
import {setSettings, useViewer, type TreeNode} from '../../viewer/src/store';
import {MATERIAL_PRESETS} from '../../viewer/src/engine/materialParams';

// Run with npm run dev, then open /tests/gpu/materialSwitchStress.html in Chrome.
// Exercise the actual viewer material-edit and cancellation paths at native
// canvas resolution. Instrumentation belongs here, rather than in the viewer.
const query = new URLSearchParams(location.search);
const iterations = Number(query.get('iterations') ?? 128);
const intervals = [50, 100, 250, 1200];
const report = document.querySelector<HTMLPreElement>('#report')!;
const run = document.querySelector<HTMLButtonElement>('#run')!;
const download = document.querySelector<HTMLButtonElement>('#download')!;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let result: Record<string, unknown> = {};

function firstMesh(nodes: TreeNode[]): TreeNode | undefined {
  for (const node of nodes) {
    if (node.materials.length) return node;
    const found = firstMesh(node.children); if (found) return found;
  }
}

run.onclick = async () => {
  run.disabled = download.disabled = true;
  let viewer: WebEngine | undefined;
  const events: unknown[] = [];
  const errors: string[] = [];
  const live = new Set<GPUBuffer | GPUTexture>();
  let submissions = 0, pendingGPUJobs = 0, peakPendingGPUJobs = 0, overlappingStarts = 0, submittedJobs = 0;
  const log = (event: unknown) => {
    events.push({time: new Date().toISOString(), event});
    report.textContent = JSON.stringify(event, null, 2);
  };
  let restore = () => {};
  let removePageHide = () => {};
  try {
    if (!Number.isInteger(iterations) || iterations < 1) throw new Error('iterations must be a positive integer');
    if (typeof GPUDevice === 'undefined' || typeof GPUQueue === 'undefined') throw new Error('This test requires WebGPU');
    const submit = GPUQueue.prototype.submit;
    const createBuffer = GPUDevice.prototype.createBuffer;
    const createTexture = GPUDevice.prototype.createTexture;
    const enqueue = Engine.prototype._enqueueDenoise;
    const track = <T extends GPUBuffer | GPUTexture>(item: T): T => {
      live.add(item);
      const destroy = item.destroy.bind(item);
      item.destroy = () => { live.delete(item); destroy(); };
      return item;
    };
    GPUQueue.prototype.submit = function(commands) { submissions++; return submit.call(this, commands); };
    GPUDevice.prototype.createBuffer = function(descriptor) { return track(createBuffer.call(this, descriptor)); };
    GPUDevice.prototype.createTexture = function(descriptor) { return track(createTexture.call(this, descriptor)); };
    Engine.prototype._enqueueDenoise = function<T>(work: () => Promise<T>): Promise<T> {
      return enqueue.call(this, async () => {
        if (pendingGPUJobs > 0) overlappingStarts++;
        const before = submissions;
        try { return await work(); }
        finally {
          // Aborted work can resolve while its submitted inference is still
          // running. Count only work that actually submitted GPU commands.
          if (this.device && submissions !== before) {
            submittedJobs++; pendingGPUJobs++;
            peakPendingGPUJobs = Math.max(peakPendingGPUJobs, pendingGPUJobs);
            const done = () => { pendingGPUJobs--; };
            void this.device.queue.onSubmittedWorkDone().then(done, done);
          }
        }
      }) as Promise<T>;
    };
    restore = () => {
      GPUQueue.prototype.submit = submit;
      GPUDevice.prototype.createBuffer = createBuffer;
      GPUDevice.prototype.createTexture = createTexture;
      Engine.prototype._enqueueDenoise = enqueue;
    };
    setSettings({resolutionScale: 1, maxSamples: 64, denoise: true, denoiseModel: 'standard', oidnModel: 'standard',
      denoiseWhileConverging: true, autoRotate: false});
    viewer = new WebEngine(document.querySelector('canvas')!);
    const current = viewer;
    const onPageHide = () => { current.dispose(); restore(); };
    window.addEventListener('pagehide', onPageHide, {once: true});
    removePageHide = () => window.removeEventListener('pagehide', onPageHide);
    current.engine.on('devicelost', () => errors.push(current.engine.lastError?.message ?? 'Device lost'));
    current.engine.on('error', error => errors.push(error.message));
    const model = query.get('model');
    if (model) await current.loadPreset(model);
    else await current.loadModel(createMaterialSpheres());
    await current.engine.init();
    if (current.engine.backend !== 'webgpu') throw new Error('This test requires the WebGPU backend');
    const mesh = firstMesh(useViewer.getState().tree);
    if (!mesh) throw new Error('Model has no editable material');
    const check = () => { if (errors.length || current.engine.lastError) throw new Error(errors[0] ?? current.engine.lastError!.message); };
    const finish = async () => {
      const deadline = performance.now() + 120000;
      while (current.final.status !== 'finished') {
        check(); if (performance.now() > deadline) throw new Error('Final convergence timed out');
        await wait(100);
      }
      await current.engine._awaitDevice(current.engine.device!.queue.onSubmittedWorkDone()); check();
    };
    // Warm up weights and pipelines so every timing phase can exercise OIDN.
    await finish();
    log({settings: useViewer.getState().settings, mesh: mesh.name,
      canvas: [current.engine.display.canvas.width, current.engine.display.canvas.height]});
    for (let i = 0; i < iterations; i++) {
      const preset = MATERIAL_PRESETS[i % MATERIAL_PRESETS.length];
      current.setMaterialValues(mesh.materials[0].id, preset.values, preset.label);
      const interval = intervals[Math.min(3, Math.floor(i * intervals.length / iterations))];
      await wait(interval); check();
      log({switch: i + 1, preset: preset.id, interval, samples: current.final.samples, status: current.final.status,
        resources: live.size, pendingGPUJobs, peakPendingGPUJobs, overlappingStarts});
    }
    await finish();
    const pixels = await current.final.readPixels('hdr');
    let nonFinite = 0;
    for (const value of pixels.data) if (!Number.isFinite(value)) nonFinite++;
    result = {passed: !errors.length && nonFinite === 0 && submittedJobs > 0 && peakPendingGPUJobs <= 1 && overlappingStarts === 0,
      iterations, intervals, samples: current.final.samples, status: current.final.status,
      pendingGPUJobs, peakPendingGPUJobs, overlappingStarts, submittedJobs, resources: live.size,
      hdr: {width: pixels.width, height: pixels.height, nonFinite}, diagnostics: current.engine.getDiagnostics(), errors, events};
  } catch (error) {
    result = {passed: false, error: String(error), errors, events};
  } finally {
    removePageHide(); viewer?.dispose(); restore();
    report.textContent = JSON.stringify({...result, events: undefined}, null, 2);
    run.disabled = download.disabled = false;
  }
};

download.onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'material-switch-stress.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
