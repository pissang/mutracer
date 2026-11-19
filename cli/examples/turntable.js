import {studio} from './studio.js';

export const output = {size: [1280, 720], fps: 24, duration: 1, spp: 32};

export async function setup({THREE, load}) {
  const {scene, camera} = studio(THREE);
  const {scene: model} = await load.gltf('../../examples/assets/chess.glb');
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 1.5 / (bounds.max.y - bounds.min.y);
  const turntable = new THREE.Group();
  turntable.name = 'Turntable';
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, 0.02 - bounds.min.y * scale, -center.z * scale);
  turntable.add(model);
  scene.add(turntable);
  camera.position.set(0, 2.3, 5.2);
  camera.lookAt(0, 0.42, 0);
  return {scene, camera};
}

export function frame({t, scene}) {
  scene.getObjectByName('Turntable').rotation.y = 0.35 + 2 * t / output.duration;
}
