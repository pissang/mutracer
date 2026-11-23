import {studio} from './studio.js';

export const output = {duration: 2, fps: 24, size: [384, 216], spp: 16,
  denoise: 'temporal', sampleSequence: 'frame', temporal: {historyRadius: 4, postRadius: 2}};

export function setup({THREE}) {
  const {scene, camera} = studio(THREE);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 20),
    new THREE.MeshStandardMaterial({color: 0xb85e24, roughness: 0.28}));
  ball.position.y = 0.6;
  scene.add(ball);
  return {scene, camera};
}

export function frame({t, camera}) {
  camera.position.set(3 * Math.sin(t), 1.6, 3 * Math.cos(t));
  camera.lookAt(0, 0.6, 0);
}
