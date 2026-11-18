// Open coatNormals.html and ?webgl on a real GPU. HDR comparisons use fixed
// samples and sequence offsets, without denoising or radiance clamping.
import * as THREE from 'three';
import {Engine, Render} from '../../src/main.js';
import { THREESync } from '../../src/three.js';

async function run() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  engine.display.setSize(32, 32);
  const render = new Render(engine, {bounces: 3, bevel: false});
  const scene = new THREE.Scene();
  const light = new THREE.RectAreaLight(0xffffff, 8, 3, 2);
  light.position.set(1, 1, 3); light.lookAt(0, 0, 0); scene.add(light);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 20); camera.position.z = 4;
  // A repeatable flake pattern, with substantial perturbation in both axes.
  const texels = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) texels.set([32 + (i * 73 % 192), 32 + (i * 137 % 192), 220, 255], i * 4);
  const normal = new THREE.DataTexture(texels, 8, 8);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping; normal.repeat.set(3, 3); normal.needsUpdate = true;
  const material = new THREE.MeshPhysicalMaterial({color: 0, normalMap: normal, clearcoat: 1, clearcoatRoughness: .18, side: THREE.DoubleSide});
  material.userData.mutracerOpenPBR = {baseWeight: 0, specularWeight: 0};
  const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>(new THREE.PlaneGeometry(8, 8), material);
  scene.add(mesh);
  const sync = new THREESync(engine, {scene, camera});
  const captures: Record<string, number[]> = {};
  const pngs: Record<string, string> = {};
  const results: {name: string; maxError: number; passed: boolean}[] = [];
  const capture = async (name: string, samples = 128, png = false) => {
    sync.update(); engine.update();
    await render.converge({samples, sampleSequenceOffset: 19, timeoutMs: 120_000});
    const pixels = Array.from((await render.readPixels('hdr')).data); captures[name] = pixels;
    if (!pixels.every(Number.isFinite)) throw new Error(`${name}: non-finite HDR pixels`);
    if (png) {
      const blob = await engine.display.toBlob(render);
      pngs[name] = await new Promise<string>(resolve => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(blob);
      });
    }
    return pixels;
  };
  const compare = (name: string, a: number[], b: number[], equal = true) => {
    const maxError = a.reduce((max, value, i) => Math.max(max, Math.abs(value - b[i])), 0);
    results.push({name, maxError, passed: equal ? maxError < 2e-5 : maxError > .001});
  };
  try {
    const info = await engine.init();
    for (const variant of ['front', 'back', 'no tangents', 'anisotropic'] as const) {
      mesh.rotation.y = variant === 'back' ? Math.PI : 0;
      material.userData.mutracerOpenPBR.thinWalled = variant === 'back';
      material.userData.mutracerOpenPBR.coatAnisotropy = variant === 'anisotropic' ? .65 : 0;
      if (variant === 'no tangents') mesh.geometry.deleteAttribute('tangent');
      else mesh.geometry.computeTangents();
      material.clearcoatNormalMap = normal; material.clearcoatNormalScale.set(0, 0);
      const flat = await capture(`${variant}: explicit flat coat`);
      material.clearcoatNormalMap = null;
      compare(`${variant}: missing coat map equals flat coat`, await capture(`${variant}: missing coat map`), flat);
      material.clearcoatNormalMap = normal; material.clearcoatNormalScale.set(.8, .8);
      compare(`${variant}: coat map still perturbs coat`, await capture(`${variant}: mapped coat`), flat, false);
    }
    mesh.rotation.y = 0; material.userData.mutracerOpenPBR.coatAnisotropy = 0;
    material.clearcoat = 0; material.clearcoatNormalMap = null;
    material.color.setRGB(.4, .1, .03); material.userData.mutracerOpenPBR = {};
    const base = await capture('uncoated mapped base');
    material.clearcoatNormalMap = normal; material.clearcoatNormalScale.set(.8, .8);
    compare('disabled coat ignores its normal map', await capture('uncoated with unused coat map'), base);
    material.clearcoatNormalMap = null;
    material.normalScale.set(0, 0);
    compare('base normal map remains active', await capture('uncoated flat base'), base, false);
    material.clearcoat = 1;
    const smooth = await capture('smooth base and coat');
    material.clearcoatNormalMap = normal; material.clearcoatNormalScale.set(0, 0);
    compare('smooth material agrees with explicit flat coat', await capture('smooth base explicit flat coat'), smooth);

    // Car-paint parameters from the issue's CC0 sample, on a small procedural
    // sphere so the regression has no network dependency or bundled model.
    mesh.geometry.dispose(); mesh.geometry = new THREE.SphereGeometry(.85, 64, 32);
    material.color.setRGB(.7, 0, 0); material.metalness = .3; material.roughness = .4;
    material.normalScale.set(.2, .2); material.clearcoatRoughness = 0;
    engine.display.setSize(192, 192);
    material.clearcoatNormalMap = null;
    const carPaint = await capture('car paint missing coat map', 256, true);
    material.clearcoatNormalMap = normal; material.clearcoatNormalScale.set(0, 0);
    compare('car paint missing map equals explicit flat coat', await capture('car paint explicit flat coat', 256, true), carPaint);
    return {backend: engine.backend, adapter: info.adapterName, samples: 128, sequenceOffset: 19,
      results, passed: results.every(row => row.passed), captures, pngs};
  } finally {render.dispose(); sync.dispose(); engine.dispose(); mesh.geometry.dispose(); material.dispose(); normal.dispose();}
}

const completion = run();
// Automation can save the exact raw HDR data used by the assertions.
Object.assign(window, {coatNormalsResult: completion});
completion.then(({captures, pngs, ...summary}) => {
  document.querySelector('#result')!.textContent = JSON.stringify(summary, null, 2);
  for (const [name, src] of Object.entries(pngs)) {
    const label = document.createElement('p'); label.textContent = name;
    const image = document.createElement('img'); image.src = src; document.body.append(label, image);
  }
}, error => {document.querySelector('#result')!.textContent = String(error?.stack ?? error);});
