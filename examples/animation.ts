// Procedural skinning and a relative morph target, evaluated by THREESync.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Engine, RenderLoop } from '@meimu/mutracer';
import { THREESync } from '@meimu/mutracer/three';
import { showStatus } from './shared/status';

const canvas = document.getElementById('main') as HTMLCanvasElement;
const statusElement = document.getElementById('status')!;
const animateInput = document.getElementById('animate') as HTMLInputElement;
const morphInput = document.getElementById('morph') as HTMLInputElement;
const source = new THREE.Scene(); source.background = new THREE.Color(0x18202c);
const height = 3, boneCount = 6;
const geometry = new THREE.CylinderGeometry(.3,.3,height,32,40,true);
const position = geometry.attributes.position;
const indices = new Uint16Array(position.count * 4), weights = new Float32Array(position.count * 4);
const morph = new Float32Array(position.count * 3);
for (let vertex = 0; vertex < position.count; vertex++) {
  const fraction = (position.getY(vertex) + height / 2) / height * (boneCount - 1);
  const bone = Math.min(Math.floor(fraction), boneCount - 2), weight = fraction - bone;
  indices.set([bone,bone+1,0,0],vertex*4); weights.set([1-weight,weight,0,0],vertex*4);
  morph[vertex*3] = .18 * Math.sin(position.getY(vertex)*3);
}
geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));
geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(morph,3)];
geometry.morphTargetsRelative = true;
const bones = Array.from({length:boneCount},()=>new THREE.Bone());
bones[0].position.y = -height/2;
for (let i=1;i<boneCount;i++) { bones[i].position.y = height/(boneCount-1); bones[i-1].add(bones[i]); }
const mesh = new THREE.SkinnedMesh(geometry,new THREE.MeshStandardMaterial({color:0x64a8db,roughness:.35,side:THREE.DoubleSide}));
mesh.position.y = height/2; mesh.add(bones[0]); source.add(mesh); mesh.bind(new THREE.Skeleton(bones));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(12,12),new THREE.MeshStandardMaterial({color:0x777777,roughness:.7}));
floor.rotation.x = -Math.PI/2; source.add(floor,new THREE.AmbientLight(0xffffff,.3));
const light = new THREE.PointLight(0xffe8cc,30); light.position.set(2,5,3); source.add(light);
const threeCamera = new THREE.PerspectiveCamera(40,1,.1,100); threeCamera.position.set(4,2.7,6);
const orbit = new OrbitControls(threeCamera,canvas); orbit.target.set(0,1.5,0); orbit.update();
const engine = new Engine({canvas, backend: new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'auto'});
const sync = new THREESync(engine, {scene: source, camera: threeCamera, controls: orbit});
const loop = new RenderLoop(engine, {sync, final: {bounces: 4, maxSamples: 256}});
const final = loop.final;

function resize() {
  const ratio = Math.min(devicePixelRatio,2);
  engine.display.setSize(canvas.clientWidth*ratio,canvas.clientHeight*ratio);
  threeCamera.aspect = canvas.clientWidth/canvas.clientHeight; threeCamera.updateProjectionMatrix();
}
window.addEventListener('resize',resize); resize();
window.addEventListener('pagehide',()=>{loop.dispose();sync.dispose();orbit.dispose();engine.dispose()});
function frame(time: number) {
  if (animateInput.checked) for (let i=1;i<boneCount;i++) bones[i].rotation.z = .15*Math.sin(time/1000+i*.4);
  mesh.morphTargetInfluences![0] = Number(morphInput.value);
  showStatus(statusElement, engine, final, loop.tick()); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
