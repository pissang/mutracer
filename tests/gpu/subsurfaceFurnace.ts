import {
  Camera, Engine, EnvironmentLight, Mesh, OpenPBRMaterial, Render, Texture,
  createCubeGeometry, createSphereGeometry
} from '../../src/main.js';
import {packMaterialParams} from '../../src/renderer/materialParams.js';

// Index-matched boundaries remove Fresnel/IOR compensation from this test.
// For a conservative medium the infinite-depth white-furnace answer is one.
// Gray references integrate E[albedo^collisionCount] for a unit sphere with
// sigma_t=2, cosine entry and isotropic free flights, independently of the GPU.
const sphereReferences = [[1, 1], [.5, .348787], [.8, .628136], [.95, .879886]];
// Unit cube, same extinction, with entry points averaged over the 12x12
// interior image cells of this camera. Gray media expose incorrect early escapes
// even when a conservative white medium still returns unit radiance.
const cubeReferences = [[1, 1], [.5, .522192], [.8, .756659]];

export async function captureSubsurfaceFurnace(backend: 'webgpu' | 'webgl') {
  const results = [];
  for (const shape of ['sphere', 'cube']) for (const [albedo, expected] of shape === 'sphere' ? sphereReferences : cubeReferences) {
    const material = new OpenPBRMaterial({subsurfaceWeight: 1, subsurfaceRadius: .5,
      subsurfaceRadiusScale: [1, 1, 1], subsurfaceColor: [1, 1, 1], specularIor: 1, specularRoughness: .15});
    // Invert the public color mapping; the tested quantity is the physical
    // single-scattering albedo, rather than the artist-facing color.
    if (albedo < 1) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2; material.subsurfaceColor = [mid, mid, mid];
        const packed = packMaterialParams([material]);
        if (packed.mediumScattering[0][0] / packed.mediumExtinction[0][0] < albedo) lo = mid; else hi = mid;
      }
      const color = (lo + hi) / 2; material.subsurfaceColor = [color, color, color];
    }
    const engine = new Engine({canvas: document.createElement('canvas'), backend});
    engine.display.setSize(32, 32);
    const render = new Render(engine, {width: 32, height: 32, bounces: 20, bevel: false,
      maxTiles: 1, aovs: ['id'], directLightCandidates: 4});
    try {
      const info = await engine.init();
      const camera = new Camera({projection: 'perspective', fov: 35});
      camera.position = [0, 0, 4]; camera.lookAt([0, 0, 0]); engine.camera = camera;
      const map = new Texture({width: 256, height: 128, data: new Float32Array(256 * 128 * 4).fill(1)});
      engine.scene = {meshes: [new Mesh(shape === 'sphere' ? createSphereGeometry(96, 48) : createCubeGeometry(), material)],
        lights: [new EnvironmentLight({map})]};
      engine.update();
      await render.converge({samples: 4096, timeoutMs: 120_000, onProgress() {
        // Bound queued WebGL work in headless runs; this does not change samples.
        (engine as unknown as {_webglRenderer?: {gl: WebGL2RenderingContext}})._webglRenderer?.gl.finish();
        if (engine.lastError) throw engine.lastError;
      }});
      const pixels = (await render.readPixels('hdr')).data;
      const ids = (await render.readPixels('id')).data;
      if (engine.backend !== backend || engine.lastError || !pixels.every(Number.isFinite)) throw new Error('Invalid furnace capture');
      let sum = 0, count = 0;
      for (let y = 1; y < 31; y++) for (let x = 1; x < 31; x++) {
        const i = y * 32 + x, id = ids[i * 4 + 2];
        if (id === 0xffffffff || [-33, -32, -31, -1, 1, 31, 32, 33].some(k => ids[(i + k) * 4 + 2] !== id)) continue;
        sum += (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3; count++;
      }
      const mean = sum / count;
      // Finite depth can lose a small positive tail. It cannot create energy.
      const passed = count > 0 && (albedo === 1 ? mean >= .985 && mean <= 1.005 : Math.abs(mean - expected) < .006);
      results.push({shape, albedo, expected, mean, count, passed, info});
      if (!passed) throw new Error(`${backend} ${shape} albedo=${albedo}: ${mean}, expected ${expected}`);
    } finally {render.dispose(); engine.dispose();}
  }
  return results;
}
Object.assign(window, {captureSubsurfaceFurnace});
