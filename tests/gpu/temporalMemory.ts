import {Engine, Render, getRecommendedDeviceDescriptor} from '../../src/main';
import {TemporalDenoiser} from '../../src/temporal';
import {THREESync, fromTHREECamera} from '../../src/three';
import * as THREE from 'three';

async function run() {
  const params = new URLSearchParams(location.search);
  const width = Number(params.get('width')), height = Number(params.get('height'));
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Provide integer width and height query parameters.');
  const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw new Error('WebGPU adapter unavailable.');
  const device = await adapter.requestDevice(getRecommendedDeviceDescriptor(adapter));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const engine = new Engine({canvas, device});
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial({color: 0x8a8a8a, roughness: .6})));
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const camera3d = new THREE.PerspectiveCamera(45, width / height, .1, 100);
  camera3d.position.z = 3; camera3d.updateMatrixWorld();
  const sync = new THREESync(engine, {scene}); sync.update();
  engine.scene = sync.scene!; engine.camera = fromTHREECamera(camera3d); engine.update();
  const render = new Render(engine, {width, height, maxSamples: 1,
    denoiser: {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'}});
  const temporal = new TemporalDenoiser(engine, {denoiser: {type: 'oidn', model: 'cleanAuxLarge', weightsBaseUrl: '/oidn/weights/'}});
  temporal.attach(render);
  try {
    for (let index = 0; index < 23; index++) {
      await render.converge({samples: 1, sampleSequenceOffset: index});
      await temporal.push(render);
    }
    await device.queue.onSubmittedWorkDone();
    const internal = temporal as any;
    const baseTemporalBuffers = internal.history.memory().total + internal.window.memory().total + internal.post.memory().total +
      internal.motionCoverageCounts.size + internal.composeParams.size +
      Object.values(internal.composeBuffers as Record<string, GPUBuffer>).reduce((sum, buffer) => sum + buffer.size, 0) + 32;
    const queuedBytes = internal.finished.reduce((sum: number, frame: any) => sum + frame._buffer('denoised').size + frame._buffer('accumulated').size +
      frame.source.color.size + frame.source.albedo.size + frame.source.normal.size + (frame.source.baseline?.size ?? 0), 0);
    const pendingAccumulatedBytes = [...internal.accumulated.values()].reduce((sum: number, buffer: GPUBuffer) => sum + buffer.size, 0);
    if (internal.finished.length !== 4) throw new Error(`Expected four queued OIDN outputs, got ${internal.finished.length}.`);
    return {width, height, submittedFrames: 23, queuedFrames: internal.finished.length, plan: temporal.plan,
      baseTemporalBuffers, queuedBytes, pendingAccumulatedBytes, trackedPeakTemporalBytes: baseTemporalBuffers + queuedBytes + pendingAccumulatedBytes,
      rendererTargetBytes: (render as any)._output.getMemory().bytes,
      limits: {maxTextureDimension2D: device.limits.maxTextureDimension2D, maxTextureArrayLayers: device.limits.maxTextureArrayLayers,
        maxBufferSize: device.limits.maxBufferSize, maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize}};
  } finally { temporal.dispose(); render.dispose(); sync.dispose(); engine.dispose(); device.destroy(); }
}

(window as any).runTemporalMemoryTest = run;
