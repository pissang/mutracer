import {studio} from './studio.js';

export async function setup({THREE, rng}) {
  const {scene, camera} = studio(THREE);
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.56, 0.18, 192, 32),
    new THREE.MeshPhysicalMaterial({metalness: 0.7, clearcoat: 0.38}),
  );
  knot.name = 'Knot';
  knot.position.y = 1.07;
  knot.rotation.set(0.22, 0.34, 0.25 + rng() * 0.1);
  scene.add(knot);
  camera.position.set(0.25, 1.62, 4);
  camera.lookAt(0, 0.92, 0);
  return {scene, camera};
}

export const output = {size: [1280, 720], fps: 24, duration: 1, spp: 32};

export function frame({t, scene}) {
  const {material} = scene.getObjectByName('Knot');
  const u = t / output.duration;
  material.color.setHSL(0.54 + 0.55 * u, 0.63, 0.5);
  material.roughness = 0.13 + 0.57 * u;
  material.clearcoatRoughness = 0.08 + 0.3 * u;
}
