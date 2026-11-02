import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {Engine, RenderLoop, THREESync, Mesh, OpenPBRMaterial, SpotLight, AmbientLight,
  createPlaneGeometry, createCubeGeometry, createSphereGeometry, type SceneVolume} from '@meimu/mutracer';
import {showStatus} from './shared/status';

const canvas = document.querySelector<HTMLCanvasElement>('#main')!;
const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'auto'});
const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({baseColor: [.18, .2, .24], specularRoughness: .65}));
floor.transform[0] = floor.transform[10] = 12;
const meshes = [floor];
const stone = new OpenPBRMaterial({baseColor: [.35, .38, .43], specularRoughness: .5});
for (const x of [-2.4, 0, 2.4]) {
  const pillar = new Mesh(createCubeGeometry(), stone);
  pillar.transform[0] = pillar.transform[10] = .3; pillar.transform[5] = 2.5;
  pillar.position = [x, 1.25, -1.5]; meshes.push(pillar);
}
const sphere = new Mesh(createSphereGeometry(48, 24), new OpenPBRMaterial({baseColor: [.25, .4, .55], baseMetalness: .75, specularRoughness: .2}));
sphere.position = [0, .7, .8]; sphere.transform[0] = sphere.transform[5] = sphere.transform[10] = .7;
meshes.push(sphere);
const warm = new SpotLight({color: [1, .72, .4], intensity: 160, radius: .08, innerAngle: 12, outerAngle: 22});
warm.position = [-2.5, 4, -2]; warm.lookAt([.8, 0, 1]);
const cool = new SpotLight({color: [.35, .6, 1], intensity: 120, radius: .06, innerAngle: 15, outerAngle: 25});
cool.position = [2.7, 3.5, -2]; cool.lookAt([-.8, 0, 1]);
const volumes: SceneVolume[] = [
  {density: .18, bounds: {min: [-6, 0, -5], max: [6, 5, 5]}, heightFalloff: .65, anisotropy: .35, noise: {size: [3, .7, 3], coverage: .6, offset: [0, 0, 0]}, edgeFade: .2},
  {density: .35, bounds: {min: [-1, -1, -1], max: [1, 1, 1]}, shape: 'ellipsoid',
    transform: [1.5, 0, 0, 0, 0, .45, 0, 0, 0, 0, .85, 0, 1.5, .6, 1.2, 1], color: [.7, .85, 1], noise: {size: [1.4, .7, 1.4]}, edgeFade: .4}
];
engine.scene = {meshes, lights: [warm, cool, new AmbientLight({intensity: .015})], background: [.005, .008, .015, 1], volumes};
const camera = new THREE.PerspectiveCamera(45, 1, .1, 100);
camera.position.set(6, 3.2, 7);
const controls = new OrbitControls(camera, canvas); controls.target.set(0, 1.1, 0); controls.update();
const sync = new THREESync(engine, {camera, controls});
const loop = new RenderLoop(engine, {sync, final: {bounces: 12, maxSamples: 1024}});
document.querySelector<HTMLInputElement>('#volumes')!.onchange = event => {
  engine.scene!.volumes = (event.target as HTMLInputElement).checked ? volumes : [];
};
document.querySelector<HTMLInputElement>('#density')!.oninput = event => {
  volumes[0].density = Number((event.target as HTMLInputElement).value);
};
function resize() {
  engine.display.setSize(canvas.clientWidth, canvas.clientHeight);
  camera.aspect = canvas.clientWidth / canvas.clientHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
let previousTime = performance.now();
function frame(time = performance.now()) {
  const elapsed = Math.min((time - previousTime) / 1000, .1); previousTime = time;
  if (document.querySelector<HTMLInputElement>('#drift')!.checked) volumes[0].noise!.offset![0] += elapsed * .15;
  showStatus(document.querySelector('#status')!, engine, loop.final, loop.tick());
  requestAnimationFrame(frame);
}
frame();
addEventListener('pagehide', () => {loop.dispose(); sync.dispose(); controls.dispose(); engine.dispose();});
