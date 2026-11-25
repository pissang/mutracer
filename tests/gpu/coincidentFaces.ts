import * as THREE from 'three';
import {Engine, Render} from '../../src/main.js';
import {THREESync} from '../../src/three.js';

const width = 48;
const height = 48;
const samples = 16;

function plane(y: number, material: THREE.Material, subdivisions = 1) {
  const geometry = new THREE.PlaneGeometry(4, 4, subdivisions, subdivisions);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) position.setXYZ(i, position.getX(i), y, -position.getY(i));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

export function fixture(gap: number, scale: number, subdivisions: number, grazing: boolean, reverse = false) {
  const scene = new THREE.Scene();
  const ground = plane(0, new THREE.MeshBasicMaterial({color: 0x00ff00}));
  if (subdivisions === 0) {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhysicalMaterial({transmission: 1, ior: 1, roughness: 0}));
    glass.position.y = .5 + gap;
    scene.add(glass, ground, plane(-.02, new THREE.MeshBasicMaterial({color: 0xff0000})));
  } else {
    const catcher = new THREE.MeshStandardMaterial();
    catcher.userData.mutracerShadowCatcher = true;
    const receiver = plane(-gap, catcher, subdivisions);
    scene.add(...(reverse ? [ground, receiver] : [receiver, ground]));
  }
  for (const mesh of scene.children) {
    mesh.scale.setScalar(scale);
    mesh.position.multiplyScalar(scale);
  }
  const camera = new THREE.OrthographicCamera(-.2 * scale, .2 * scale, .2 * scale, -.2 * scale, .001 * scale, 40 * scale);
  camera.position.set(0, grazing ? .12 : 2, grazing ? 8 : 0).multiplyScalar(scale);
  if (!grazing) camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  return {scene, camera};
}

export const cases = [
  {name: 'glass-contact', gap: 0, scale: 1, subdivisions: 0, grazing: false},
  {name: 'glass-0.1mm', gap: .0001, scale: 1, subdivisions: 0, grazing: false},
  {name: 'glass-1mm', gap: .001, scale: 1, subdivisions: 0, grazing: false},
  {name: 'glass-small', gap: .0001, scale: .001, subdivisions: 0, grazing: false},
  {name: 'glass-large', gap: .0001, scale: 1000, subdivisions: 0, grazing: false},
  ...[false, true].flatMap(grazing => [[0, 1], [.00001, 1], [0, 5]].map(([gap, subdivisions]) => ({
    name: `catcher-${gap ? '0.01mm' : subdivisions === 1 ? 'contact' : 'tessellated'}-${grazing ? 'grazing' : 'normal'}`,
    gap, scale: 1, subdivisions, grazing
  }))),
  {name: 'catcher-reversed', gap: 0, scale: 1, subdivisions: 5, grazing: true, reverse: true}
];

export async function captureCoincidentFaces(backend: 'webgpu' | 'webgl', verify = true) {
  const engine = new Engine({canvas: document.createElement('canvas'), backend});
  const render = new Render(engine, {width, height, bounces: 5, bevel: false, denoiser: null});
  const results = [];
  try {
    const info = await engine.init();
    if (engine.backend !== backend) throw Error(`Expected ${backend}, got ${engine.backend}`);
    for (const entry of cases) {
      const sync = new THREESync(engine, fixture(entry.gap, entry.scale, entry.subdivisions, entry.grazing, entry.reverse));
      try {
        sync.update(); engine.update();
        await render.converge({samples, sampleSequenceOffset: 17, timeoutMs: 60000});
        const pixels = Array.from((await render.readPixels('hdr')).data);
        if (engine.lastError || !pixels.every(Number.isFinite)) throw Error(`Invalid capture for ${entry.name}: ${engine.lastError}`);
        // At grazing angle only the center strip projects onto the finite receiver.
        let incorrect = 0, checked = 0;
        for (let y = entry.grazing ? 22 : 0; y < (entry.grazing ? 26 : height); y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (pixels[i + 1] < .98 || pixels[i] > .02 || pixels[i + 3] < .98) incorrect++;
            checked++;
          }
        }
        if (verify && incorrect) throw Error(`${backend} ${entry.name}: ${incorrect}/${checked} pixels missed the ground`);
        results.push({name: entry.name, incorrect, checked, pixels});
      } finally {sync.dispose();}
    }
    return {backend, adapter: info.adapterName, width, height, samples, results};
  } finally {render.dispose(); engine.dispose();}
}
