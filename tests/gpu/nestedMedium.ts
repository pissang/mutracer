import {Engine, Render} from '../../src/main.js';
import {THREESync} from '../../src/three.js';
import {expected, makeScene} from './nestedMediumScene.js';

export async function capture(backend: 'webgpu' | 'webgl', layout: string, samples = 256) {
  const engine = new Engine({canvas: document.createElement('canvas'), backend});
  engine.display.setSize(16, 16);
  const render = new Render(engine, {width: 16, height: 16, bounces: 12, bevel: false, denoiser: null});
  const sync = new THREESync(engine, makeScene(layout));
  try {
    const info = await engine.init();
    sync.update(); engine.update();
    await render.converge({samples, sampleSequenceOffset: 17, timeoutMs: 120000});
    const pixels = Array.from((await render.readPixels('hdr')).data);
    if (engine.backend !== backend || engine.lastError || !pixels.every(Number.isFinite)) throw Error('Invalid capture');
    return {info, pixels};
  } finally {render.dispose(); sync.dispose(); engine.dispose();}
}


export async function nestedMediumContract(backend: 'webgpu' | 'webgl') {
  const rows = [];
  for (const [layout, reference] of Object.entries(expected)) {
    const {info, pixels} = await capture(backend, layout);
    const rgb = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c++) rgb[c] += pixels[i + c] / (pixels.length / 4);
    }
    if (rgb.some((value, c) => Math.abs(value - reference[c]) > .007)) {
      throw Error(JSON.stringify({backend, layout, rgb, reference}));
    }
    rows.push({backend: info.adapterName, layout, rgb});
  }
  return rows;
}
