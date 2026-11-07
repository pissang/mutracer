import {
  Camera, CylinderLight, DiskLight, Engine, Mesh, OpenPBRMaterial, RectLight,
  Render, SphereLight, createPlaneGeometry
} from '../../src/main.js';

type Backend = 'webgpu' | 'webgl';
const backend: Backend = location.search.includes('webgl') ? 'webgl' : 'webgpu';

function receiver() {
  const material = new OpenPBRMaterial({baseColor: [1, 1, 1], specularWeight: 0, baseDiffuseRoughness: 0});
  const floor = new Mesh(createPlaneGeometry(), material);
  floor.transform[0] = floor.transform[10] = 8;
  return floor;
}

function camera(extent = 2) {
  const result = new Camera({projection: 'orthographic', left: -extent, right: extent, top: extent, bottom: -extent});
  result.position = [0, 1, 4]; result.lookAt([0, 0, 0]);
  return result;
}

async function context(size: number, extent = 2) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend});
  const render = new Render(engine, {bounces: 1, bevel: false, samplingPattern: 'sobol'});
  await engine.init(); engine.display.setSize(size, size); engine.camera = camera(extent);
  return {canvas, engine, render, dispose() { render.dispose(); engine.dispose(); canvas.remove(); }};
}

function meanRgb(data: Float32Array) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
  return sum / (data.length / 4 * 3);
}

function cylinderReference(radius: number, length: number, height: number, radiance: number) {
  // Independent midpoint quadrature of L cos(receiver) cos(emitter) / r² dA.
  const nx = 2048, np = 8192;
  let integral = 0;
  for (let ix = 0; ix < nx; ix++) {
    const x = ((ix + 0.5) / nx - 0.5) * length;
    for (let ip = 0; ip < np; ip++) {
      const phi = (ip + 0.5) / np * 2 * Math.PI;
      const c = Math.cos(phi), s = Math.sin(phi);
      const y = height + radius * c, z = radius * s;
      const r2 = x * x + y * y + z * z, distance = Math.sqrt(r2);
      const receiverCosine = y / distance;
      const emitterCosine = -(c * y + s * z) / distance;
      if (receiverCosine > 0 && emitterCosine > 0) integral += receiverCosine * emitterCosine / r2;
    }
  }
  return radiance * integral * radius * length * 2 * Math.PI / (nx * np);
}

async function reference() {
  const c = await context(1, 1e-4);
  try {
    const floor = receiver(), height = 2, radius = 0.5, length = 1, intensity = 12;
    const rows: Record<string, unknown>[] = [];
    const capture = async (name: string, light: DiskLight | CylinderLight, expected: number) => {
      c.engine.scene = {meshes: [floor], lights: [light], background: [0, 0, 0, 1]};
      c.engine.update(); c.render.restart();
      await c.render.converge({samples: 16384, sampleSequenceOffset: 37, timeoutMs: 180_000});
      const actual = meanRgb((await c.render.readPixels('hdr')).data);
      rows.push({name, expected, actual, relativeError: Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12)});
    };
    for (const normalize of [false, true]) {
      const disk = new DiskLight({radius, intensity, normalize}); disk.position = [0, height, 0]; disk.lookAt([0, 0, 0]);
      const area = Math.PI * radius * radius, radiance = intensity / (normalize ? area : 1);
      await capture(`disk-${normalize ? 'normalized' : 'radiance'}`, disk, radiance * radius * radius / (height * height + radius * radius));
    }
    const back = new DiskLight({radius, intensity}); back.position = [0, height, 0]; back.lookAt([0, 4, 0]);
    await capture('disk-backside', back, 0);
    for (const normalize of [false, true]) {
      const cylinder = new CylinderLight({radius, length, intensity, normalize}); cylinder.position = [0, height, 0];
      const area = 2 * Math.PI * radius * length, radiance = intensity / (normalize ? area : 1);
      await capture(`cylinder-${normalize ? 'normalized' : 'radiance'}`, cylinder,
        cylinderReference(radius, length, height, radiance) / Math.PI);
    }
    return {backend, rows};
  } finally { c.dispose(); }
}

async function matrix() {
  const c = await context(16, 1.5);
  try {
    const floor = receiver(), totalIntensity = 64;
    const rows = [];
    for (const count of [64, 256, 1024]) {
      const lights = Array.from({length: count}, () => {
        const light = new DiskLight({radius: 0.08, intensity: totalIntensity / count});
        light.position = [0, 2, 0]; light.lookAt([0, 0, 0]); return light;
      });
      c.engine.scene = {meshes: [floor], lights, background: [0, 0, 0, 1]}; c.engine.update();
      c.render.restart(); await c.render.converge({samples: 32, sampleSequenceOffset: 9000, timeoutMs: 180_000});
      const timings = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        c.render.restart(); const start = performance.now();
        await c.render.converge({samples: 128, sampleSequenceOffset: 10000 + repeat * 128, timeoutMs: 180_000});
        timings.push(performance.now() - start);
      }
      c.render.restart(); await c.render.converge({samples: 4096, sampleSequenceOffset: 20000, timeoutMs: 180_000});
      const referencePixels = (await c.render.readPixels('hdr')).data;
      const seeds = [];
      for (let seed = 0; seed < 6; seed++) {
        c.render.restart(); await c.render.converge({samples: 32, sampleSequenceOffset: seed * 32, timeoutMs: 180_000});
        const pixels = (await c.render.readPixels('hdr')).data; let squared = 0, referenceSquared = 0;
        for (let i = 0; i < pixels.length; i++) { const delta = pixels[i] - referencePixels[i]; squared += delta * delta; referenceSquared += referencePixels[i] * referencePixels[i]; }
        seeds.push({seed, mean: meanRgb(pixels), relativeRmsError: Math.sqrt(squared / referenceSquared)});
      }
      timings.sort((a, b) => a - b); const medianMs = timings[2];
      rows.push({count, totalIntensity, referenceMean: meanRgb(referencePixels), seeds, timingsMs: timings,
        medianMs, samplesPerSecond: 128 * 16 * 16 / (medianMs / 1000)});
    }
    return {backend, rows};
  } finally { c.dispose(); }
}

async function baseline() {
  const c = await context(32, 2);
  try {
    const floor = receiver();
    const lights = Array.from({length: 24}, (_, index) => {
      if (index % 2) {
        const light = new SphereLight({radius: 0.06, intensity: 2 + index / 24});
        light.position = [((index % 6) - 2.5) * 0.45, 1.5 + (index % 3) * 0.2, (Math.floor(index / 6) - 1.5) * 0.4]; return light;
      }
      const light = new RectLight({size: [0.12, 0.1], intensity: 2 + index / 24});
      light.position = [((index % 6) - 2.5) * 0.45, 1.5 + (index % 3) * 0.2, (Math.floor(index / 6) - 1.5) * 0.4]; light.lookAt([0, 0, 0]); return light;
    });
    c.engine.scene = {meshes: [floor], lights, background: [0, 0, 0, 1]}; c.engine.update(); c.render.restart();
    await c.render.converge({samples: 128, sampleSequenceOffset: 4242, timeoutMs: 180_000});
    return {backend, width: 32, height: 32, pixels: Array.from((await c.render.readPixels('hdr')).data)};
  } finally { c.dispose(); }
}

Object.assign(window, {usdLuxLights: {reference, matrix, baseline}});
