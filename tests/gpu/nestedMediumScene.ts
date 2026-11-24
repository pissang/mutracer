import * as THREE from 'three';

// At normal incidence, a 60 mm liquid column transmits one reference depth.
const color: [number, number, number] = [.8, .5, .2];
export const expected = {
  liquid: color, contact: color, narrow: color, gap: color, thin: color,
  'tinted-contact': [.4, .4, .18], 'reordered-contact': [.4, .4, .18],
  'surface-contact': color.map(channel => channel * .8 ** 4),
  clear: [1, 1, 1], opaque: [1, 1, 1]
};
export function makeScene(layout: string) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-.01, .01, .01, -.01, .001, 1);
  camera.position.z = .1;
  const glass = new THREE.MeshPhysicalMaterial({transmission: 1, ior: 1, roughness: 0});
  const liquid = glass.clone();
  liquid.attenuationDistance = .06;
  liquid.attenuationColor.setRGB(...color);
  const slab = (center: number, depth: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, depth), material);
    mesh.position.z = center;
    scene.add(mesh);
  };
  if (layout !== 'opaque') slab(0, .06, layout === 'clear' ? glass : liquid);
  if (layout.endsWith('contact') || ['narrow', 'gap', 'thin'].includes(layout)) {
    const gap = layout.endsWith('contact') ? 0 : layout === 'narrow' ? .0003 : .002;
    if (layout === 'tinted-contact' || layout === 'reordered-contact') {
      glass.attenuationColor.setRGB(.5, .8, .9);
      glass.attenuationDistance = .004;
    }
    // Four surface tints count the crossings, including the primary continuation.
    if (layout === 'surface-contact') glass.attenuationColor.setRGB(.8, .8, .8);
    if (layout === 'thin') glass.userData.mutracerOpenPBR = {geometryThinWalled: true};
    for (const sign of [-1, 1]) slab(sign * (.031 + gap), .002, glass);
  }
  if (layout === 'reordered-contact') scene.children.reverse();
  const light = new THREE.Mesh(new THREE.PlaneGeometry(.2, .2), new THREE.MeshBasicMaterial({color: 0xffffff}));
  light.position.z = -.05;
  scene.add(light);
  return {scene, camera};
}
