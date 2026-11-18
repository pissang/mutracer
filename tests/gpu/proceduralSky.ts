import * as THREE from 'three';
import { Engine, Render, ProceduralSky } from '../../src/main.js';
import { THREESync } from '../../src/three.js';
import { WGPUSkyBaker } from '../../src/renderer/WGPUSkyBaker.js';
import { WebGLSkyBaker } from '../../src/renderer/WebGLSkyBaker.js';
import type { ProceduralEnvironmentSource } from '../../src/renderer/envMapDistribution.js';

async function readTexture(device: GPUDevice, texture: GPUTexture) {
  const bytesPerRow = Math.ceil(texture.width * 16 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [texture.width, texture.height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Float32Array(buffer.getMappedRange());
  const data = new Float32Array(texture.width * texture.height * 4);
  for (let y = 0; y < texture.height; y++) data.set(mapped.subarray(y * bytesPerRow / 4, y * bytesPerRow / 4 + texture.width * 4), y * texture.width * 4);
  buffer.unmap(); buffer.destroy(); return data;
}
function compare(expected: ArrayLike<number>, actual: ArrayLike<number>) {
  let maxError = 0, squared = 0, energy = 0;
  for (let i = 0; i < actual.length; i++) {
    if (!Number.isFinite(actual[i])) throw new Error('Non-finite sky radiance');
    const difference = actual[i] - expected[i];
    maxError = Math.max(maxError, Math.abs(difference)); squared += difference * difference; energy += expected[i] * expected[i];
  }
  return { maxError, normalizedRMSE: Math.sqrt(squared / Math.max(energy, 1e-12)) };
}

export async function runProceduralSkyChecks() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU required');
  const device = await adapter.requestDevice();
  const validation: string[] = [];
  device.addEventListener('uncapturederror', event => validation.push((event as GPUUncapturedErrorEvent).error.message));
  const gpu = new WGPUSkyBaker(device), gl = new WebGLSkyBaker();
  const comparisons = [];
  try {
    for (const time of [0, 5.5, 6, 9, 12, 15, 18, 18.5, 24]) {
      const width = 512, height = 256;
      const output = device.createTexture({ label: 'Sky probe', size: [width, height], format: 'rgba32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
      const source: ProceduralEnvironmentSource = { sky: { type: 'ProceduralSky', width, height, time }, width, height, intensity: 1, ambient: [0, 0, 0] };
      gpu.bake(source, output);
      const result = compare(gl.bake(time, width, height).data, await readTexture(device, output));
      comparisons.push({ time, ...result }); output.destroy();
      if (result.normalizedRMSE > .003) throw new Error(JSON.stringify(comparisons.at(-1)));
    }
    const pipeline = [];
    for (const backend of ['webgpu', 'webgl'] as const) {
      const sky = new ProceduralSky({ resolution: [512, 256], time: 12 });
      const source = new THREE.Scene();
      source.add(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshStandardMaterial({ color: 0x886644, roughness: .5 })));
      const camera = new THREE.PerspectiveCamera(45, 1, .1, 20); camera.position.set(0, 1, 4); camera.lookAt(0, 0, 0);
      const engine = new Engine({ canvas: document.createElement('canvas'), ...(backend === 'webgpu' ? { device } : { backend }) });
      engine.display.setSize(32, 32);
      const render = new Render(engine, { bounces: 2 });
      const options = { scene: source, camera, environment: sky as import('../../src/scene/Texture.js').default | undefined };
      const sync = new THREESync(engine, options);
      const writes: string[] = [];
      const originalWrite = device.queue.writeTexture.bind(device.queue);
      device.queue.writeTexture = (destination, ...args) => {
        if (['Env', 'Background'].includes(destination.texture.label)) writes.push(destination.texture.label);
        originalWrite(destination, ...args);
      };
      try {
        sync.update(); engine.update();
        await render.converge({ samples: 32, sampleSequenceOffset: 0, timeoutMs: 60_000 });
        const actual = (await render.readPixels('hdr')).data;
        if (backend === 'webgpu' && writes.length) throw new Error(`Unexpected sky pixel upload: ${writes}`);
        const initialWrites = writes.length;
        sky.time = 15;
        source.userData.mutracerGroundedSkybox = { texture: sky, height: 1.6, radius: 30 };
        sync.update(); engine.update();
        await render.converge({ samples: 1, sampleSequenceOffset: 0, timeoutMs: 60_000 });
        if (backend === 'webgpu' && writes.length !== initialWrites) throw new Error('Time edit uploaded sky pixels');
        sky.resolution = [256, 128]; sync.update(); engine.update();
        await render.converge({ samples: 1, sampleSequenceOffset: 0, timeoutMs: 60_000 });
        if (backend === 'webgpu' && writes.length !== initialWrites) throw new Error('Sky resizing uploaded pixels');
        source.userData.mutracerGroundedSkybox = undefined;
        const reference = gl.bake(12, 512, 256);
        const texture = new THREE.DataTexture(reference.data, 512, 256, THREE.RGBAFormat, THREE.FloatType); texture.flipY = true;
        source.environment = texture; options.environment = undefined;
        sync.update(); engine.update();
        await render.converge({ samples: 32, sampleSequenceOffset: 0, timeoutMs: 60_000 });
        const difference = compare((await render.readPixels('hdr')).data, actual);
        pipeline.push({ backend, skyUploads: initialWrites, ...difference });
        texture.dispose();
        if (difference.normalizedRMSE > .01) throw new Error(JSON.stringify(pipeline.at(-1)));
      } finally { device.queue.writeTexture = originalWrite; render.dispose(); sync.dispose(); engine.dispose(); }
    }
    await device.queue.onSubmittedWorkDone();
    if (validation.length) throw new Error(validation.join('\n'));
    return { comparisons, pipeline };
  } finally { gpu.dispose(); gl.dispose(); device.destroy(); }
}

if (document.querySelector('#summary')) runProceduralSkyChecks().then(results => {
  document.querySelector('#summary')!.textContent = JSON.stringify({ passed: true, ...results });
}).catch(error => { document.querySelector('#summary')!.textContent = String(error.stack ?? error); });
