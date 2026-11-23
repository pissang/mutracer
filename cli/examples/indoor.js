export const output = {
  duration: 2,
  fps: 24,
  spp: 32,
  render: {bounces: 8, caustics: {lightTracing: true, photonMapping: true}},
  display: {toneMapping: 'agx', toneMappingExposure: 1.25},
  sampleSequence: 'frame',
};

export function setup({THREE, load}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(44, 1, 0.05, 50);

  const wallPixels = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const stripe = x % 4 === 0 ? [125, 157, 152, 255] : [166, 188, 180, 255];
      wallPixels.set(stripe, (y * 8 + x) * 4);
    }
  }
  const wallpaper = load.pixels(8, 8, wallPixels);
  wallpaper.wrapS = THREE.RepeatWrapping;
  wallpaper.repeat.set(5, 1);

  const plaster = new THREE.MeshStandardMaterial({color: 0xe2d9cb});
  const wall = new THREE.MeshStandardMaterial({map: wallpaper, roughness: 0.85});
  const wood = new THREE.MeshStandardMaterial({color: 0x704c33, roughness: 0.48});
  const fabric = new THREE.MeshPhysicalMaterial({
    color: 0x416a65, roughness: 0.9, sheen: 0.85, sheenRoughness: 0.65, sheenColor: 0xb8e0d7,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    roughness: 0.025, transmission: 1, ior: 1.5, thickness: 0.25,
    attenuationColor: new THREE.Color(0xfaf3df), attenuationDistance: 0.8,
  });

  function box(material, size, position) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    scene.add(mesh);
    return mesh;
  }

  box(wood, [7, 0.15, 7], [0, -0.1, 0]);
  box(wall, [7, 3, 0.15], [0, 1.5, -3]);
  // Four wall sections leave an opening for the directional light.
  box(plaster, [0.15, 0.9, 6], [-3, 0.45, 0]);
  box(plaster, [0.15, 0.55, 6], [-3, 2.73, 0]);
  box(plaster, [0.15, 1.55, 1.65], [-3, 1.675, -2.175]);
  box(plaster, [0.15, 1.55, 1.65], [-3, 1.675, 2.175]);
  box(wood, [1.7, 0.075, 0.85], [0, 0.68, -0.45]);
  for (const x of [-0.68, 0.68]) {
    for (const z of [-0.74, -0.16]) box(wood, [0.09, 0.67, 0.09], [x, 0.33, z]);
  }
  box(fabric, [1.35, 0.028, 0.45], [0, 0.73, -0.46]);
  const subject = new THREE.Mesh(new THREE.SphereGeometry(0.18, 48, 24), glass);
  subject.name = 'Glass';
  subject.position.set(0.25, 0.91, -0.42);
  scene.add(subject);

  const sun = new THREE.DirectionalLight(0xffdfae, 4);
  sun.position.set(-6, 3.2, -0.4);
  sun.target.position.set(0, 0.7, -0.45);
  scene.add(sun, sun.target);
  const fill = new THREE.RectAreaLight(0xd8e7ff, 3, 2, 1.2);
  fill.position.set(0.8, 2.35, 1.6);
  fill.lookAt(0, 0.65, -0.4);
  scene.add(fill);
  scene.background = new THREE.Color(0x87949c);

  camera.userData.mutracerLens = {fStop: 3.5, focusDistance: 'Glass', sensorHeight: 24};
  return {scene, camera};
}

export function frame({t, camera}) {
  camera.position.set(1.8 - 0.5 * t, 1.35, 2.35 - 0.25 * t);
  camera.lookAt(0.09, 0.8, -0.45);
}
