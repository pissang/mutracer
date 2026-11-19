import {studio} from './studio.js';

export const output = {size:[1280,720],fps:24,duration:1,spp:32};

export async function setup({THREE, load}) {
  const {scene,camera} = studio(THREE);
  const gltf = await load.gltf('./animated-triangle.gltf');
  gltf.scene.position.y = 0.75;
  scene.add(gltf.scene);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(gltf.animations[0]);
  action.setLoop(THREE.LoopOnce,1);
  action.clampWhenFinished = true;
  action.play();
  gltf.scene.userData.mixer = mixer;
  gltf.scene.name = 'Animated card';
  camera.position.set(1,1.8,3);
  camera.lookAt(0,.88,0);
  return {scene,camera};
}

export function frame({t,scene}) {
  scene.getObjectByName('Animated card').userData.mixer.setTime(t);
}
