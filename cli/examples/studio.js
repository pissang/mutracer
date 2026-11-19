export function studio(THREE) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x232c3a);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({color: 0x465363, roughness: 0.72}),
  );
  floor.name = 'Studio floor';
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor, new THREE.AmbientLight(0xd9e7ff, 0.24));
  for (const [color, intensity, width, height, position] of [
    [0xffe5cd, 14, 2.8, 2.2, [-2.5, 3.6, 2.5]],
    [0x9ec4ff, 11, 1.8, 2.6, [2, 2.9, -2.8]],
  ]) {
    const light = new THREE.RectAreaLight(color, intensity, width, height);
    light.position.set(...position);
    light.lookAt(0, 0.85, 0);
    scene.add(light);
  }
  return {scene, camera: new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 100)};
}
