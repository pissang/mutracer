import {
  Camera, Engine, Mesh, OpenPBRMaterial, RectLight, Render, SphereLight,
  createPlaneGeometry
} from '../../src/main.js';

type Backend = 'webgpu' | 'webgl';
const backend: Backend = location.search.includes('webgl') ? 'webgl' : 'webgpu';

async function capture() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend});
  const render = new Render(engine, {bounces: 1, bevel: false, samplingPattern: 'sobol'});
  try {
    await engine.init(); engine.display.setSize(32, 32);
    const camera = new Camera({projection: 'orthographic', left: -2, right: 2, top: 2, bottom: -2});
    camera.position = [0, 1, 4]; camera.lookAt([0, 0, 0]); engine.camera = camera;
    const material = new OpenPBRMaterial({baseColor: [1, 1, 1], specularWeight: 0, baseDiffuseRoughness: 0});
    const floor = new Mesh(createPlaneGeometry(), material); floor.transform[0] = floor.transform[10] = 8;
    const lights = Array.from({length: 24}, (_, index) => {
      const position: [number, number, number] = [
        ((index % 6) - 2.5) * 0.45,
        1.5 + (index % 3) * 0.2,
        (Math.floor(index / 6) - 1.5) * 0.4
      ];
      if (index % 2) {
        const light = new SphereLight({radius: 0.06, intensity: 2 + index / 24});
        light.position = position; return light;
      }
      const light = new RectLight({size: [0.12, 0.1], intensity: 2 + index / 24});
      light.position = position; light.lookAt([0, 0, 0]); return light;
    });
    engine.scene = {meshes: [floor], lights, background: [0, 0, 0, 1]}; engine.update(); render.restart();
    await render.converge({samples: 128, sampleSequenceOffset: 4242, timeoutMs: 180_000});
    return {backend, width: 32, height: 32, pixels: Array.from((await render.readPixels('hdr')).data)};
  } finally { render.dispose(); engine.dispose(); canvas.remove(); }
}

Object.assign(window, {ordinaryLightBaseline: {capture}});
