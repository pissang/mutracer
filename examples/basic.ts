import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// Minimal MuTracer scene: procedural geometry, OpenPBR materials, an area light
// and an HDR environment. Drag to orbit, scroll to zoom.
import { mat4 } from 'gl-matrix';
import {
  EnvironmentLight,
  Mesh,
  OpenPBRMaterial, type OpenPBRMaterialParams,
  RectLight,
  Engine, RenderLoop, type Scene, type DisplaySettings,
  createCubeGeometry,
  createPlaneGeometry,
  createSphereGeometry
} from '@meimu/mutracer';
import { THREESync } from '@meimu/mutracer/three';
import { createSkyTexture } from './shared/sky';
import { showStatus } from './shared/status';
import { createCrosshairPass } from './shared/crosshairPass';

const canvas = document.getElementById('main') as HTMLCanvasElement;
const statusElement = document.getElementById('status')!;

// Floor: the plane is 2x2 in XZ, so scale it up.
const floor = new Mesh(
  createPlaneGeometry(),
  new OpenPBRMaterial({ baseColor: [0.55, 0.55, 0.55], specularRoughness: 0.6 })
);
mat4.fromScaling(floor.transform, [6, 1, 6]);

// Unit spheres placed with a translation and scale.
const sphere = createSphereGeometry(64, 32);
function addSphere(x: number, props: OpenPBRMaterialParams) {
  const mesh = new Mesh(sphere, new OpenPBRMaterial(props));
  mat4.fromTranslation(mesh.transform, [x, 0.5, 0]);
  mat4.scale(mesh.transform, mesh.transform, [0.5, 0.5, 0.5]);
  return mesh;
}
const spheres = [
  addSphere(-1.2, { baseColor: [0.8, 0.15, 0.1], specularRoughness: 0.4 }),
  addSphere(0, { baseColor: [0.95, 0.75, 0.35], baseMetalness: 1, specularRoughness: 0.2 }),
  addSphere(1.2, { transmissionWeight: 1, specularRoughness: 0 })
];

const cube = new Mesh(createCubeGeometry(), new OpenPBRMaterial({ baseColor: [0.2, 0.4, 0.8] }));
mat4.fromTranslation(cube.transform, [-0.6, 0.3, -1.3]);
mat4.scale(cube.transform, cube.transform, [0.3, 0.3, 0.3]);

// A rect light emits towards its local -Z; rotate it to face down.
const light = new RectLight({size: [1.5, 1.5], color: [1, 0.9, 0.8], intensity: 6});
mat4.fromTranslation(light.transform, [-1.5, 3, 1.5]);
mat4.rotateX(light.transform, light.transform, -Math.PI / 2);

const scene: Scene = {
  meshes: [floor, ...spheres, cube],
  lights: [light, new EnvironmentLight({map: createSkyTexture()})]
};

const camera = new THREE.PerspectiveCamera(40, 1, .1, 100);
camera.position.set(0, 2.4, 6); camera.lookAt(0, 0.3, -0.3);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, .3, -.3); controls.update();

// Uses WebGPU when available and WebGL 2 otherwise; add ?webgl to the URL to
// force the WebGL 2 backend.
const engine = new Engine({canvas, backend: new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'auto'});
const displaySettings: DisplaySettings = {toneMapping: 'agx', toneMappingExposure: 1};
Object.assign(engine.display, displaySettings);
// Add ?overlay to see a display-only GPU crosshair, also included in PNG export.
if (new URLSearchParams(location.search).has('overlay')) engine.display.addPostProcess(createCrosshairPass());
const sync = new THREESync(engine, {camera, controls});
const loop = new RenderLoop(engine, {sync, final: {bounces: 6, maxSamples: 1024}});
const final = loop.final;
engine.scene = scene;


function resize() {
  const ratio = Math.min(window.devicePixelRatio, 2);
  engine.display.setSize(canvas.clientWidth * ratio, canvas.clientHeight * ratio);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function frame() {
  showStatus(statusElement, engine, final, loop.tick());
  requestAnimationFrame(frame);
}
frame();

window.addEventListener('pagehide', () => {loop.dispose(); sync.dispose(); controls.dispose(); engine.dispose();});
