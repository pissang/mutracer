import {
  Camera, Engine, EnvironmentLight, Mesh, OpenPBRMaterial, Render,
  SphereLight, SpotLight, Texture, createPlaneGeometry
} from '../../src/main.js';

// A light below a thin sheet must retain its analytic identity, so transmission
// uses its radiance rather than substituting the separately displayed background.
export async function captureAnalyticTransmission(backend: 'webgpu' | 'webgl', kind = 'sphere') {
  const engine = new Engine({canvas: document.createElement('canvas'), backend});
  const render = new Render(engine, {width: 16, height: 16, bounces: 1, bevel: false,
    samplingPattern: 'sobol', directLightCandidates: 1});
  try {
    const info = await engine.init();
    const camera = new Camera({projection: 'orthographic', left: -.25, right: .25, top: .25, bottom: -.25});
    camera.position = [0, 3, 0]; camera.lookAt([0, 0, 0]); engine.camera = camera;
    const sheet = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({
      baseColor: [1, 1, 1], transmissionWeight: 1, thinWalled: true, specularRoughness: 1
    }));
    const light = kind === 'spot'
      ? new SpotLight({intensity: 50, radius: 0, innerAngle: 70, outerAngle: 80})
      : new SphereLight({intensity: 50, radius: 0});
    light.position = [0, -3, 0]; light.lookAt([0, 0, 0]);
    const map = new Texture({width: 1, height: 1, data: new Float32Array([.001, .001, .001, 1])});
    engine.scene = {meshes: [sheet], lights: [light, new EnvironmentLight({map})], background: [.001, .001, .001, 1]};
    const captures = [];
    for (const radius of [0, .2]) {
      light.radius = radius;
      // Sphere intensity is radiance for finite area, candela at radius zero.
      light.intensity = kind === 'sphere' && radius > 0 ? 50 / (Math.PI * radius * radius) : 50;
      engine.update(); render.restart();
      await render.converge({samples: 1024, sampleSequenceOffset: 17, timeoutMs: 120_000});
      const pixels = (await render.readPixels('hdr')).data;
      if (!pixels.every(Number.isFinite)) throw new Error(`${kind}: non-finite transmission`);
      const rgb = pixels.filter((_, i) => i % 4 !== 3);
      captures.push({radius, mean: rgb.reduce((a, b) => a + b, 0) / rgb.length, data: Array.from(pixels)});
    }
    const ratio = captures[1].mean / captures[0].mean;
    if (ratio < .8 || ratio > 1.2) throw new Error(`${kind}: area/point transmission ratio ${ratio}`);
    return {info, kind, captures, ratio};
  } finally {render.dispose(); engine.dispose();}
}
Object.assign(window, {captureAnalyticTransmission});
