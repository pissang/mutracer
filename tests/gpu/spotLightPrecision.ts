import {Camera, Engine, Mesh, OpenPBRMaterial, Render, SpotLight, createPlaneGeometry} from '../../src/main.js';

// Compare a small spherical emitter with the point-source limit at equal candela.
// The diffuse receiver stays inside the full-intensity cone and sees the entire
// emitter above its horizon, so its irradiance is identical for every radius.
async function capture() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {bounces: 1, bevel: false});
  try {
    const info = await engine.init(); engine.display.setSize(128, 96);
    const camera = new Camera({projection: 'orthographic', left: -2, right: 2, top: 1.5, bottom: -1.5});
    camera.position = [0, 5, 0]; camera.lookAt([0, 0, 0]); engine.camera = camera;
    const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({baseColor: [.6, .6, .6], specularWeight: 0, baseDiffuseRoughness: 0}));
    floor.transform[0] = floor.transform[10] = 10;
    const light = new SpotLight({intensity: 60, radius: 0, innerAngle: 80, outerAngle: 85});
    light.position = [-1.6, 2.2, -2.4]; light.lookAt([0, 0, 0]); engine.scene = {meshes: [floor], lights: [light], background: [0, 0, 0, 1]};
    const captures: Record<string, number[]> = {};
    const results: {radius: number; relativeRms: number; maxRelativeError: number; passed: boolean}[] = [];
    let reference: Float32Array | undefined;
    for (const radius of [0, .05, .005, .001]) {
      light.radius = radius; engine.update(); render.restart();
      await render.converge({samples: 128, sampleSequenceOffset: 19, timeoutMs: 120_000});
      const pixels = (await render.readPixels('hdr')).data;
      if (!pixels.every(Number.isFinite)) throw new Error('Non-finite HDR pixels');
      captures[String(radius)] = Array.from(pixels);
      if (!reference) { reference = new Float32Array(pixels); continue; }
      let squaredError = 0, squaredReference = 0, maxRelativeError = 0;
      for (let i = 0; i < pixels.length; i++) {
        if (i % 4 === 3) continue;
        const delta = pixels[i] - reference[i];
        squaredError += delta * delta; squaredReference += reference[i] * reference[i];
        maxRelativeError = Math.max(maxRelativeError, Math.abs(delta) / Math.max(reference[i], 1e-6));
      }
      const relativeRms = Math.sqrt(squaredError / squaredReference);
      results.push({radius, relativeRms, maxRelativeError, passed: relativeRms < .002 && maxRelativeError < .01});
    }
    return {info, width: 128, height: 96, results, captures};
  } finally { render.dispose(); engine.dispose(); canvas.remove(); }
}
Object.assign(window, {spotLightPrecision: {capture}});
