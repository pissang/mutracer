import {
  Camera, Engine, Mesh, OpenPBRMaterial, Render, SphereLight,
  createPlaneGeometry, createSphereGeometry
} from '@meimu/mutracer';
import { TemporalDenoiser } from '@meimu/mutracer/temporal';

const canvas = document.querySelector<HTMLCanvasElement>('#main')!;
const start = document.querySelector<HTMLButtonElement>('#start')!;
const status = document.querySelector<HTMLElement>('#status')!;
const mode = document.querySelector<HTMLSelectElement>('#mode')!;
const width = 320, height = 180, samples = 16, frameCount = 32;

const camera = new Camera({ projection: 'perspective', fov: 37 });
camera.position = [0, 1.9, 5.7];
camera.lookAt([0, .62, 0]);

const sphere = new Mesh(createSphereGeometry(48, 24), new OpenPBRMaterial({
  baseColor: [.05, .35, .52], baseMetalness: .2, specularRoughness: .32
}));
sphere.transform[0] = sphere.transform[5] = sphere.transform[10] = .72;
const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({
  baseColor: [.55, .43, .31], specularRoughness: .75
}));
floor.transform[0] = floor.transform[10] = 12;

const key = new SphereLight({ color: [1, .81, .55], intensity: 40, radius: .45 });
key.position = [-2.4, 3.8, 2.7];
const fill = new SphereLight({ color: [.57, .74, 1], intensity: 14, radius: .65 });
fill.position = [2.4, 2.3, -1.7];

const engine = new Engine({
  canvas, backend: new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'auto'
});
engine.camera = camera;
engine.scene = { meshes: [floor, sphere], lights: [key, fill], background: [.035, .05, .07, 1] };
engine.display.setSize(width, height);

async function renderShot() {
  start.disabled = mode.disabled = true;
  status.textContent = 'Preparing WebGPU and OIDN…';
  let render: Render | undefined;
  let denoiser: TemporalDenoiser | undefined;
  try {
    await engine.init();
    if (engine.backend !== 'webgpu') {
      status.textContent = 'Temporal denoising requires WebGPU.';
      return;
    }
    render = new Render(engine, { width, height, maxSamples: samples, bounces: 5 });
    denoiser = new TemporalDenoiser(engine, {
      mode: mode.value === 'interactive' ? 'interactive' : 'offline',
      historyRadius: 4,
      denoiser: { type: 'oidn', model: 'cleanAuxLarge', weightsBaseUrl: '/oidn/weights/' }
    });
    denoiser.attach(render);

    for (let i = 0; i < frameCount; i++) {
      const angle = 2 * Math.PI * i / frameCount;
      sphere.position = [1.2 * Math.sin(angle), .72, .22 * Math.cos(angle)];
      engine.update();
      await render.converge({ samples, sampleSequenceOffset: i * samples });
      await denoiser.push(render);
      status.textContent = `Rendering frame ${i + 1} / ${frameCount}`;
      for await (const frame of denoiser.drain()) engine.display.present(frame);
    }
    for await (const frame of denoiser.flush()) engine.display.present(frame);
    status.textContent = `Finished ${frameCount} frames.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    denoiser?.dispose();
    render?.dispose();
    start.disabled = mode.disabled = false;
  }
}

start.addEventListener('click', () => { void renderShot(); });
