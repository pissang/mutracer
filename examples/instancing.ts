import {mat4} from 'gl-matrix';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {Engine, InstancedMesh, Mesh, OpenPBRMaterial, RectLight, AmbientLight, RenderLoop, createCubeGeometry, createPlaneGeometry} from '@meimu/mutracer';
import { THREESync } from '@meimu/mutracer/three';
import {showStatus} from './shared/status';

const canvas = document.querySelector('canvas')!;
const batch = new InstancedMesh(createCubeGeometry(), new OpenPBRMaterial({baseColor: [.2,.5,.8]}), {count: 100, colors: new Float32Array(300)});
for (let i = 0; i < batch.count; i++) {
  batch.colors!.set([.2 + .8 * (i % 10) / 9, .3 + .7 * Math.floor(i / 10) / 9, 1], i * 3);
  const matrix = batch.transforms.subarray(i * 16, (i + 1) * 16);
  mat4.fromTranslation(matrix, [(i % 10 - 4.5) * .7, .2, (Math.floor(i / 10) - 4.5) * .7]);
  mat4.scale(matrix, matrix, [.2,.2,.2]);
}
batch.markTransformsUpdated();
batch.markColorsUpdated();
const floor = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({baseColor: [.4,.4,.4]}));
mat4.fromScaling(floor.transform, [5,1,5]);
const light = new RectLight({size: [3,3], intensity: 8}); light.position = [0,5,0]; light.lookAt([0,0,0]);
const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'auto'});
engine.scene = {meshes: [floor,batch], lights: [light,new AmbientLight({intensity: .2})]};
const camera = new THREE.PerspectiveCamera(40,1,.1,100); camera.position.set(6,6,9);
const controls = new OrbitControls(camera,canvas); controls.target.set(0,0,0); controls.update();
const sync = new THREESync(engine,{camera,controls}), loop = new RenderLoop(engine,{sync});
function resize() {engine.display.setSize(canvas.clientWidth,canvas.clientHeight); camera.aspect = canvas.clientWidth / canvas.clientHeight; camera.updateProjectionMatrix();}
window.addEventListener('resize',resize); resize();
let raised = false;
document.querySelector('button')!.addEventListener('click', () => {
  raised = !raised; batch.transforms[13] = raised ? 1 : .2;
  batch.markTransformsUpdated(0,1);
  batch.colors!.set(raised ? [1,.2,.1] : [.2,.3,1], 0);
  batch.markColorsUpdated(0,1);
});
loop.on('status', ({status}) => showStatus(document.querySelector('#status')!,engine,loop.final,status));
loop.start();
window.addEventListener('pagehide', () => {loop.dispose();sync.dispose();controls.dispose();engine.dispose();});
