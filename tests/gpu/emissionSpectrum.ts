// Real-GPU radiance contract; run with ?webgl for the second backend.
import * as THREE from 'three';
import { Engine, Render, THREESync } from '../../src/main.js';

async function run() {
  const backend = location.search.includes('webgl') ? 'webgl' : 'webgpu';
  const engine = new Engine({canvas: document.createElement('canvas'), backend});
  const render = new Render(engine, {width: 16, height: 16, bounces: 4, bevel: false});
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0, 0, 0);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10);
  camera.position.z = 2;
  const geometry = new THREE.PlaneGeometry(8, 8);
  const emitter = new THREE.MeshPhysicalMaterial({color: 0, emissive: new THREE.Color(2, .5, .25)});
  emitter.userData.mutracerOpenPBR = {specularWeight: 0};
  const unlit = new THREE.MeshBasicMaterial({color: new THREE.Color(2, .5, .25)});
  const mirror = new THREE.MeshPhysicalMaterial({metalness: 1, roughness: 0, color: 0xffffff});
  const glass = new THREE.MeshPhysicalMaterial({transmission: 1, roughness: 0, ior: 1, color: 0xffffff});
  glass.userData.mutracerOpenPBR = {specularIor: 1, transmissionDispersionAbbeNumber: 20};
  const markerMaterial = new THREE.MeshPhysicalMaterial({transmission: 1, ior: 1.5});
  const marker = new THREE.Mesh(new THREE.SphereGeometry(.1, 8, 4), markerMaterial);
  marker.position.x = 100;
  const surface = new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(geometry, emitter);
  const reflectedEmitter = new THREE.Mesh(geometry, emitter);
  reflectedEmitter.position.z = 4; reflectedEmitter.rotation.y = Math.PI;
  const window = new THREE.Mesh(geometry, glass); window.position.z = 1;
  scene.add(surface, marker);
  const texture = new THREE.DataTexture(new Float32Array([.5, 2, .25, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.colorSpace = THREE.LinearSRGBColorSpace; texture.needsUpdate = true;
  const sync = new THREESync(engine, {scene, camera});
  const results: {kind: string; wavelengths: number; maxError: number; mean: number[]}[] = [];
  const capture = async (dispersive: boolean, wavelengths: 1 | 3, samples = 32) => {
    markerMaterial.userData.mutracerOpenPBR = {transmissionDispersionScale: dispersive ? 1 : 0};
    glass.userData.mutracerOpenPBR.transmissionDispersionScale = dispersive ? 1 : 0;
    render.dispersionWavelengths = wavelengths;
    sync.update(); engine.update();
    await render.converge({samples, sampleSequenceOffset: 0, timeoutMs: 60_000});
    return (await render.readPixels('hdr')).data;
  };
  try {
    for (const kind of ['emissive', 'unlit', 'textured', 'reflected', 'transmitted']) {
      scene.remove(reflectedEmitter, window);
      surface.material = kind === 'unlit' ? unlit : kind === 'reflected' ? mirror : emitter;
      emitter.emissiveMap = kind === 'textured' ? texture : null;
      if (kind === 'reflected') scene.add(reflectedEmitter);
      if (kind === 'transmitted') scene.add(window);
      const expected = await capture(false, 3);
      for (const wavelengths of [1, 3] as const) {
        const hero = kind === 'transmitted' && wavelengths === 1;
        const actual = await capture(true, wavelengths, hero ? 1024 : 32);
        const mean = [0, 0, 0], expectedMean = [0, 0, 0];
        let maxError = 0;
        for (let i = 0; i < actual.length; i++) {
          if (i % 4 === 3) continue;
          mean[i % 4] += actual[i] / 256; expectedMean[i % 4] += expected[i] / 256;
          maxError = Math.max(maxError, Math.abs(actual[i] - expected[i]));
        }
        // A single hero channel is an estimator; compare frame means rather
        // than requiring each pixel's wavelength counts to be equal.
        if (hero) maxError = Math.max(...mean.map((v, c) => Math.abs(v - expectedMean[c])));
        results.push({kind, wavelengths, maxError, mean});
        if (!Number.isFinite(maxError) || maxError > (hero ? .015 : .002)) {
          throw new Error(`Surface emission changed with dispersion: ${JSON.stringify(results.at(-1))}`);
        }
      }
    }
    return {backend, passed: true, results};
  } finally {
    render.dispose(); sync.dispose(); engine.dispose();
    geometry.dispose(); marker.geometry.dispose(); texture.dispose();
    for (const material of [emitter, unlit, mirror, glass, markerMaterial]) material.dispose();
  }
}
run().then(result => {document.querySelector('#summary')!.textContent = JSON.stringify(result);})
  .catch(error => {document.querySelector('#summary')!.textContent = JSON.stringify({passed: false, error: String(error?.stack ?? error)});});
