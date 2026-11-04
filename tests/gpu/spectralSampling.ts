// Real-GPU contract: spectral channels share the RGB light reservoir.
// Compare scalar-proportional targets to isolate channel dependence from the
// intentional change of target norm in multi-candidate spectral rendering.
import * as THREE from 'three';
import {Engine, Render, THREESync} from '../../src/main.js';

async function run() {
  const backend = location.search.includes('webgl') ? 'webgl' : 'webgpu';
  const engine = new Engine({canvas: document.createElement('canvas'), backend});
  const render = new Render(engine, {width: 16, height: 16, bounces: 4, bevel: false});
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 0);
  const camera = new THREE.PerspectiveCamera(45, 1, .1, 100);
  camera.position.set(0, 0, 3);
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(10, 10),
    new THREE.MeshPhysicalMaterial({color: new THREE.Color(.2, .8, .05), roughness: .65}));
  const glass = new THREE.MeshPhysicalMaterial({transmission: 1, ior: 1.5});
  const marker = new THREE.Mesh(new THREE.SphereGeometry(.1, 8, 4), glass);
  marker.position.x = 100;
  const lights = [[4, 0, 0], [0, 4, 0], [0, 0, 4], [.1, 2, .4]].map((color, i) => {
    const light = new THREE.RectAreaLight(new THREE.Color(color[0], color[1], color[2]), 1, 1, 1);
    light.position.set((i - 1.5) * .8, 1, 2); light.lookAt(0, 0, 0);
    return light;
  });
  scene.add(receiver, marker, ...lights);
  const sync = new THREESync(engine, {scene, camera});
  try {
    const capture = async (dispersive: boolean) => {
      glass.dispersion = dispersive ? 1 : 0;
      sync.update(); engine.update();
      await render.converge({samples: 32, sampleSequenceOffset: 0, timeoutMs: 60_000});
      return (await render.readPixels('hdr')).data;
    };
    const results: {directLightCandidates: number; maxError: number}[] = [];
    const compare = async (directLightCandidates: number) => {
      render.directLightCandidates = directLightCandidates;
      const expected = await capture(false), actual = await capture(true);
      let maxError = 0;
      for (let i = 0; i < actual.length; i++) maxError = Math.max(maxError, Math.abs(actual[i] - expected[i]));
      if (!Number.isFinite(maxError) || maxError > 1e-5) {
        throw new Error(`Spectral light sampling changed ordinary RGB transport (${directLightCandidates} candidates): ${maxError}`);
      }
      results.push({directLightCandidates, maxError});
    };
    // With one proposal, target normalization cannot affect the result.
    await compare(1);
    // On a neutral diffuse receiver these colored lights have the same ratio
    // between RGB mean and luminance. The two scalar targets therefore select
    // the same reservoir, while a channel-filtered target would not.
    receiver.material.color.setRGB(1, 1, 1);
    receiver.material.specularIntensity = 0;
    const redGreen = (1 / 3 - .2126) / (.7152 - 1 / 3);
    const blueGreen = (1 / 3 - .0722) / (.7152 - 1 / 3);
    for (const [i, [red, blue]] of [[4, 0], [0, 4], [2, 2], [.1, .4]].entries()) {
      lights[i].color.setRGB(red, red * redGreen + blue * blueGreen, blue);
    }
    await compare(4);
    return {backend, passed: true, results};
  } finally {
    render.dispose(); sync.dispose(); engine.dispose();
    receiver.geometry.dispose(); marker.geometry.dispose(); receiver.material.dispose(); glass.dispose();
  }
}
run().then(result => {document.querySelector('#summary')!.textContent = JSON.stringify(result);})
  .catch(error => {document.querySelector('#summary')!.textContent = JSON.stringify({passed: false, error: String(error?.stack ?? error)});});
