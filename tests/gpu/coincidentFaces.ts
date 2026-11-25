import * as THREE from 'three';
import {Engine, Render} from '../../src/main.js';
import {fromTHREECamera, THREESync} from '../../src/three.js';

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

export function firstSourceOverlapFixture(catcherFirst = false) {
  const {scene, camera} = fixture(0, 1, 1, false);
  scene.clear();
  const positions = [0, 0, -2, -2, 0, 2, 2, 0, 2];
  const triangle = (material: THREE.Material) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex([0, 1, 2]);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  };
  const receiver = new THREE.MeshBasicMaterial({color: 0x00ff00});
  const other = catcherFirst ? new THREE.MeshStandardMaterial() : new THREE.MeshBasicMaterial({color: 0xff0000});
  if (catcherFirst) other.userData.mutracerShadowCatcher = true;
  scene.add(...(catcherFirst ? [triangle(other), triangle(receiver)] : [triangle(receiver), triangle(other)]));
  return {scene, camera};
}

export function reflectedCatcherFixture() {
  const {scene, camera} = fixture(0, 1, 1, false);
  scene.clear();
  const mirror = plane(0, new THREE.MeshStandardMaterial({color: 0xffffff, metalness: 1, roughness: 0}));
  const ground = plane(0, new THREE.MeshBasicMaterial({color: 0x00ff00}));
  const catcherMaterial = new THREE.MeshStandardMaterial();
  catcherMaterial.userData.mutracerShadowCatcher = true;
  const catcher = plane(0, catcherMaterial, 5);
  // The camera starts between the mirror and the downward-facing receivers.
  for (const receiver of [ground, catcher]) {
    receiver.rotation.x = Math.PI;
    receiver.position.y = 4;
  }
  scene.add(mirror, catcher, ground);
  scene.updateMatrixWorld(true);
  return {scene, camera};
}

interface CoincidentCase {
  name: string;
  gap: number;
  scale: number;
  subdivisions: number;
  grazing: boolean;
  reverse?: boolean;
  reportOnly?: boolean;
}

export const cases: CoincidentCase[] = [
  // The exit face and the ground are coplanar only in the contact case.
  {name: 'glass-contact', gap: 0, scale: 1, subdivisions: 0, grazing: false, reportOnly: true},
  {name: 'glass-0.1mm', gap: .0001, scale: 1, subdivisions: 0, grazing: false},
  {name: 'glass-1mm', gap: .001, scale: 1, subdivisions: 0, grazing: false},
  {name: 'glass-small', gap: .0001, scale: .001, subdivisions: 0, grazing: false},
  {name: 'glass-large', gap: .0001, scale: 1000, subdivisions: 0, grazing: false},
  ...[false, true].flatMap(grazing => [[0, 1], [.00001, 1], [0, 5]].map(([gap, subdivisions]) => ({
    name: `catcher-${gap ? '0.01mm' : subdivisions === 1 ? 'contact' : 'tessellated'}-${grazing ? 'grazing' : 'normal'}`,
    gap, scale: 1, subdivisions, grazing
  }))),
  {name: 'catcher-reversed', gap: 0, scale: 1, subdivisions: 5, grazing: true, reverse: true},
  {name: 'first-source-overlap', gap: 0, scale: 1, subdivisions: 1, grazing: false},
  {name: 'first-source-overlap-catcher', gap: 0, scale: 1, subdivisions: 1, grazing: false},
  {name: 'reflected-catcher', gap: 0, scale: 1, subdivisions: 0, grazing: false, reportOnly: true}
];

export function sceneForCase(entry: CoincidentCase) {
  if (entry.name === 'reflected-catcher') return reflectedCatcherFixture();
  if (entry.name.startsWith('first-source-overlap')) return firstSourceOverlapFixture(entry.name.endsWith('-catcher'));
  return fixture(entry.gap, entry.scale, entry.subdivisions, entry.grazing, entry.reverse);
}

async function checkPrimaryOutputs(engine: Engine, render: Render) {
  const scene = new THREE.Scene();
  const catcher = new THREE.MeshStandardMaterial();
  catcher.userData.mutracerShadowCatcher = true;
  const ground = new THREE.MeshStandardMaterial({color: 0x00ff00, emissive: 0x00ff00});
  scene.add(plane(0, catcher, 5), plane(0, ground));
  const camera = new THREE.PerspectiveCamera(35, 1, .001, 40);
  camera.position.set(0, 2, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  const sync = new THREESync(engine, {scene, camera});
  try {
    sync.update();
    const groundMesh = sync.scene!.meshes[1];
    groundMesh.aovId = 23;
    engine.camera = fromTHREECamera(camera, {fStop: .7, focusDistance: 2});
    engine.update();
    render.aovs = ['id', 'depth'];
    await render.converge({samples, sampleSequenceOffset: 17, timeoutMs: 60000});
    const [hdr, albedo, normal, id, depth] = await Promise.all([
      render.readPixels('hdr'), render.readPixels('albedo'), render.readPixels('normal'),
      render.readPixels('id'), render.readPixels('depth')
    ]);
    const depthQuery = await engine.readDepthSamples({x: .5, y: .5, size: .4});
    if ([hdr, albedo, normal, id, depth].some(output => output.data.length !== width * height * 4)
        || depthQuery?.length !== 49) throw Error('Incomplete primary outputs');
    const misses = {hdr: 0, albedo: 0, normal: 0, id: 0, depth: 0,
      depthQuery: depthQuery.filter(v => !(Math.abs(v - 2) < .001)).length};
    for (let i = 0; i < hdr.data.length; i += 4) {
      for (const [kind, output] of [['hdr', hdr], ['albedo', albedo]] as const) {
        const [r, g, b] = output.data.subarray(i, i + 3);
        if (!(Math.abs(r) < .02 && g >= .98 && Math.abs(b) < .02)) misses[kind]++;
      }
      const [nx, ny, nz, valid] = normal.data.subarray(i, i + 4);
      if (!(Math.abs(nx - .5) < .02 && ny >= .98 && Math.abs(nz - .5) < .02 && valid >= .98)) misses.normal++;
      if (id.data[i] !== groundMesh.aovId) misses.id++;
      if (!(Math.abs(depth.data[i] - 2) < .001)) misses.depth++;
    }
    if (engine.lastError || render.samples !== samples || Object.values(misses).some(n => n !== 0)) {
      throw Error(`Primary outputs disagree: ${JSON.stringify(misses)} ${engine.lastError ?? ''}`);
    }
    return misses;
  } finally {sync.dispose();}
}

export async function captureCoincidentFaces(backend: 'webgpu' | 'webgl', verify = true) {
  const engine = new Engine({canvas: document.createElement('canvas'), backend});
  const render = new Render(engine, {width, height, bounces: 5, bevel: false, denoiser: null});
  const results = [];
  try {
    const info = await engine.init();
    if (engine.backend !== backend) throw Error(`Expected ${backend}, got ${engine.backend}`);
    for (const entry of cases) {
      const sync = new THREESync(engine, sceneForCase(entry));
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
        if (verify && !entry.reportOnly && incorrect) throw Error(`${backend} ${entry.name}: ${incorrect}/${checked} pixels missed the ground`);
        results.push({name: entry.name, reportOnly: !!entry.reportOnly, incorrect, checked, pixels});
      } finally {sync.dispose();}
    }
    const primaryOutputs = verify ? await checkPrimaryOutputs(engine, render) : undefined;
    return {backend, adapter: info.adapterName, width, height, samples, results, primaryOutputs};
  } finally {render.dispose(); engine.dispose();}
}
