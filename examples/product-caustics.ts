// Product shot for caustics: a perfume bottle, a tumbler of water, a cut gem and
// a gold ring on a studio backdrop under a hard spotlight. Each piece covers one
// caustic path: refraction onto the backdrop (bottle, gem with dispersion), a
// receiver seen through glass and water (tumbler) and metal reflection (the
// cardioid inside the ring).
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {Engine, RenderLoop, THREESync, type CausticSettings} from '@meimu/mutracer';
import {showStatus} from './shared/status';

const canvas = document.querySelector<HTMLCanvasElement>('#main')!;
const statusElement = document.querySelector<HTMLElement>('#status')!;
const modeInput = document.querySelector<HTMLSelectElement>('#mode')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0, 0, 0);

/** Revolves a closed (radius, height) profile around Y. Short bevels at corners keep the smooth normals local. */
function lathe(points: [number, number][], segments = 128) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/** Infinity cove: floor from z = depth curving into a back wall at z = 0. */
function createCove(width: number, depth: number, height: number, radius: number) {
  const profile: [number, number][] = [[depth, 0], [radius, 0]];
  for (let i = 1; i < 16; i++) {
    const a = i / 16 * Math.PI / 2;
    profile.push([radius * (1 - Math.sin(a)), radius * (1 - Math.cos(a))]);
  }
  profile.push([0, radius], [0, height]);
  const geometry = new THREE.PlaneGeometry(width, 1, 8, profile.length - 1);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    // PlaneGeometry rows run from top (y = 0.5) to bottom.
    const row = Math.round((0.5 - position.getY(i)) * (profile.length - 1));
    const [z, y] = profile[profile.length - 1 - row];
    position.setXYZ(i, position.getX(i), y, z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

const backdrop = new THREE.Mesh(
  createCove(8, 4, 4, 1.2),
  new THREE.MeshStandardMaterial({color: 0xd8d4cc, roughness: 0.7})
);
backdrop.position.z = -1.6;
scene.add(backdrop);

const glass = (params: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial({
  color: 0xffffff, metalness: 0, roughness: 0, transmission: 1, ior: 1.5, thickness: 0.1, ...params
});
const gold = new THREE.MeshPhysicalMaterial({color: 0xffc56b, metalness: 1, roughness: 0.03});

// Perfume bottle: solid amber glass with a gold cap.
const bottle = new THREE.Group();
bottle.add(new THREE.Mesh(lathe([
  [0, 0], [0.27, 0], [0.295, 0.008], [0.305, 0.03], [0.305, 0.6], [0.29, 0.65], [0.24, 0.69],
  [0.1, 0.73], [0.075, 0.75], [0.07, 0.78], [0.05, 0.79], [0, 0.79]
]), glass({attenuationColor: new THREE.Color(1, 0.62, 0.25), attenuationDistance: 0.35, dispersion: 0.3})));
const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 8), gold);
cap.position.y = 0.792 + 0.11;
bottle.add(cap);
bottle.position.set(-0.55, 0.001, -0.05);
bottle.rotation.y = Math.PI / 8;
scene.add(bottle);

// Tumbler: a thick glass shell with a water column inside it, separated by a
// small gap so no surfaces coincide.
const tumbler = new THREE.Group();
tumbler.add(new THREE.Mesh(lathe([
  [0, 0], [0.24, 0], [0.255, 0.01], [0.26, 0.03], [0.28, 0.72], [0.275, 0.725], [0.27, 0.72],
  [0.25, 0.08], [0.245, 0.065], [0.23, 0.06], [0, 0.06]
]), glass({})));
tumbler.add(new THREE.Mesh(lathe([
  [0, 0.062], [0.228, 0.062], [0.243, 0.068], [0.247, 0.08], [0.259, 0.45], [0, 0.45]
]), glass({ior: 1.33, attenuationColor: new THREE.Color(0.75, 0.95, 1), attenuationDistance: 1.5})));
tumbler.position.set(0.32, 0.001, -0.55);
scene.add(tumbler);

// Gem: an eight-sided cut resting on its table, with strong dispersion.
const gemGeometry = lathe([[0, 0], [0.09, 0], [0.15, 0.035], [0.15, 0.05], [0, 0.19]], 8).toNonIndexed();
gemGeometry.computeVertexNormals();
const gem = new THREE.Mesh(gemGeometry, glass({ior: 2.42, dispersion: 1}));
gem.position.set(0.05, 0.001, 0.45);
gem.rotation.y = 0.3;
scene.add(gem);

// Ring lying flat: its inner wall focuses the key light into a cardioid.
const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.028, 48, 192), gold);
ring.rotation.x = Math.PI / 2;
ring.position.set(0.75, 0.029, 0.25);
scene.add(ring);

// Hard key from behind (small radius keeps caustics sharp) and a soft front fill.
const key = new THREE.SpotLight(0xfff4e6, 60, 0, THREE.MathUtils.degToRad(28), 0.2);
key.position.set(-1.6, 2.2, -2.4);
key.target.position.set(0.1, 0, 0.1);
key.userData.mutracerRadius = 0.005;
scene.add(key, key.target);
const fill = new THREE.RectAreaLight(0xe6eeff, 1.2, 2.5, 1.5);
fill.position.set(1.8, 1.6, 2.6);
fill.lookAt(0, 0.3, 0);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
camera.position.set(0.9, 1.35, 3.6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0.05, 0.3, -0.05);
controls.update();

const modes: Record<string, CausticSettings | undefined> = {
  off: undefined,
  lightTracing: {lightTracing: true},
  photonMapping: {photonMapping: true},
  both: {lightTracing: true, photonMapping: true}
};
const engine = new Engine({canvas, backend: new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'auto'});
const sync = new THREESync(engine, {scene, camera, controls});
const loop = new RenderLoop(engine, {sync, final: {bounces: 12, maxSamples: 1024, caustics: modes[modeInput.value]}});
modeInput.onchange = () => { loop.final.caustics = modes[modeInput.value]; };

function resize() {
  const ratio = Math.min(devicePixelRatio, 2);
  engine.display.setSize(canvas.clientWidth * ratio, canvas.clientHeight * ratio);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
function frame() { showStatus(statusElement, engine, loop.final, loop.tick()); requestAnimationFrame(frame); }
frame();
addEventListener('pagehide', () => { loop.dispose(); sync.dispose(); controls.dispose(); engine.dispose(); });
