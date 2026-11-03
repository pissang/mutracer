// Open vertexColors.html and vertexColors.html?webgl on a real GPU.
import * as THREE from 'three';
import { Engine, Render, THREESync } from '../../src/main.js';

async function run() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({ canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu' });
  engine.display.setSize(32, 24);
  const render = new Render(engine);
  const source = new THREE.Scene();
  source.add(new THREE.AmbientLight(0xffffff, 1));
  const camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, .1, 10);
  camera.position.z = 2;
  const geometry = new THREE.PlaneGeometry(8, 8);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(geometry, material); source.add(mesh);
  const sync = new THREESync(engine, { scene: source, camera });
  const capture = async () => {
    sync.update(); engine.update();
    await render.converge({ samples: 16, sampleSequenceOffset: 0, timeoutMs: 60_000 });
    return (await render.readPixels('hdr')).data;
  };
  const results: { name: string; maxError: number; tolerance: number; reference: number[]; actual: number[] }[] = [];
  const compare = (name: string, actual: Float32Array, expected: Float32Array, tolerance = 2e-5) => {
    const maxError = Math.max(...actual.map((value, i) => Math.abs(value - expected[i])));
    results.push({ name, maxError, tolerance, reference: [...expected.slice(0, 4)], actual: [...actual.slice(0, 4)] });
  };
  // Compare the same decoded RGB: quantization changes physical material
  // sampling as well as output values, so an output-only tolerance is insufficient.
  const decoded = (...rgb: [number, number, number]) => rgb.map(value => engine.backend === 'webgpu' ? Math.round(value * 255) / 255 : value) as [number, number, number];
  const rgb = [.25, .5, .75];
  const color = new THREE.Float32BufferAttribute(Array.from({ length: 4 }, () => rgb).flat(), 3);
  try {
    const adapter = await engine.init();
    for (const Material of [THREE.MeshBasicMaterial, THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial]) {
      const mat = new Material(); mesh.material = mat;
      if (mat instanceof THREE.MeshStandardMaterial) mat.emissive.setRGB(.1, .2, .3);
      mat.color.setRGB(...decoded(...rgb as [number, number, number]));
      const reference = await capture();
      mat.color.setRGB(1, 1, 1); mat.vertexColors = true; geometry.setAttribute('color', color);
      compare(`${mat.type}: vertex RGB equals material RGB`, await capture(), reference);
      geometry.deleteAttribute('color'); mat.dispose();
    }
    mesh.material = material;
    material.map = new THREE.DataTexture(new Uint8Array([128, 192, 255, 255]), 1, 1);
    material.map.needsUpdate = true; material.color.setRGB(...decoded(.25, .5, .75));
    const textured = await capture();
    material.color.setRGB(1, 1, 1); material.vertexColors = true; geometry.setAttribute('color', color);
    compare('vertex colors modulate base-color textures', await capture(), textured);
    material.map.dispose(); material.map = null;
    mesh.material = material; geometry.setAttribute('color', color); material.vertexColors = true;
    await capture();
    color.setXYZ(0, .75, .25, .5); color.setXYZ(1, .75, .25, .5);
    color.setXYZ(2, .75, .25, .5); color.setXYZ(3, .75, .25, .5); color.needsUpdate = true;
    const edited = await capture();
    material.vertexColors = false; material.color.setRGB(...decoded(.75, .25, .5));
    compare('sync propagates color edits', edited, await capture());

    // Colored and uncolored geometry share the packed attribute buffer.
    mesh.scale.set(.25, .25, 1); mesh.position.x = -1;
    material.color.setRGB(1, 1, 1); material.vertexColors = true;
    const plain = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
    plain.position.x = 1; source.add(plain);
    const mixed = await capture();
    material.vertexColors = false; material.color.setRGB(...decoded(.75, .25, .5));
    compare('mixed colored and uncolored meshes', mixed, await capture());

    source.remove(mesh, plain);
    const instanceMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
    const instance = new THREE.InstancedMesh(geometry, instanceMaterial, 1);
    instance.setColorAt(0, new THREE.Color(.5, .25, 1)); source.add(instance);
    const instanced = await capture();
    instanceMaterial.vertexColors = false; instanceMaterial.color.setRGB(...decoded(.75, .25, .5));
    compare('vertex and instance colors multiply', instanced, await capture());
    source.remove(instance); source.add(mesh); mesh.scale.set(1, 1, 1); mesh.position.x = 0;
    material.color.setRGB(1, 1, 1); material.vertexColors = true;
    for (let i = 0; i < color.count; i++) {
      const r = (geometry.attributes.position.getX(i) + 4) / 8;
      color.setXYZ(i, r, 1 - r, .5);
    }
    color.needsUpdate = true;
    const gradient = await capture(), expectedGradient = new Float32Array(gradient.length);
    for (let i = 0; i < gradient.length; i += 4) {
      const r = .25 + ((i / 4) % 32 + .5) / 64;
      expectedGradient.set([r, 1 - r, .5, 1], i);
    }
    // Jitter samples each pixel's footprint, rather than precisely its center.
    compare('barycentric interpolation preserves linear RGB', gradient, expectedGradient, .01);
    const result = { backend: engine.backend, adapter: adapter.adapterName, passed: results.every(r => Number.isFinite(r.maxError) && r.maxError < r.tolerance), results };
    document.querySelector('#result')!.textContent = JSON.stringify({ backend: result.backend, adapter: result.adapter, passed: result.passed });
    for (const row of results) {
      const output = document.createElement('pre'); output.textContent = JSON.stringify(row); document.body.append(output);
    }
  } finally {
    render.dispose(); sync.dispose(); engine.dispose();
  }
}
run().catch(error => { document.querySelector('#result')!.textContent = String(error?.stack ?? error); });
