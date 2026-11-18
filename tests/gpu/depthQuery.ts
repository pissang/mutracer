// Run npm run dev and open /tests/gpu/depthQuery.html on a real GPU.
import * as THREE from 'three';
import { Engine, Render } from '../../src/main.js';
import { THREESync, fromTHREECamera } from '../../src/three.js';
import { measureAreaDepth, pickFocusDepth } from '../../viewer/src/engine/areaFocus.js';

async function fixture(webgl: boolean, layout: Engine['bvhLayout'] = 'bvh2') {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const renderer = new Engine({ canvas, backend: webgl ? 'webgl' : 'auto' });
  renderer.bvhLayout = layout;
  renderer.display.setSize(48, 32);
  const final = new Render(renderer);
  const root = new THREE.Scene();
  root.add(new THREE.AmbientLight(0xffffff, 1));
  const material = new THREE.MeshStandardMaterial({ color: 0x7799aa });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), material);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), material);
  wall.position.z = -5;
  root.add(box, wall);
  const camera = new THREE.PerspectiveCamera(35, 1.5, 0.1, 100);
  camera.position.set(0, 0, 4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const sync = new THREESync(renderer, {scene: root});
  sync.update();
  renderer.scene = sync.scene; renderer.camera = fromTHREECamera(camera); renderer.update();
  await final.converge({samples: 8});
  return { renderer, final, sync, camera, box, root, material, canvas };
}

async function baseline(webgl: boolean) {
  const { renderer, final, sync, canvas } = await fixture(webgl);
  try {
    const { data } = await final.readPixels('hdr');
    const { adapterName: adapterInfo } = await renderer.init();
    return { backend: renderer.backend, adapterInfo, data: Array.from(data) };
  } finally {
    renderer.dispose(); sync.dispose(); canvas.remove();
  }
}

async function run(webgl: boolean, layout: Engine['bvhLayout'] = 'bvh2') {
  const { renderer, final, sync, canvas, root, camera, box } = await fixture(webgl, layout);
  const lines: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
    lines.push(message);
  };
  const query = async (x: number, y: number, size: number) => {
    let samples: Float32Array | undefined;
    for (let i = 0; i < 10 && !samples; i++) samples = await renderer.readDepthSamples({ x, y, size });
    check(!!samples && samples.length === 49, '49 depth samples');
    return samples!;
  };
  const render = async (samples = 1) => {
    sync.update();
    renderer.scene = sync.scene; renderer.camera = fromTHREECamera(camera); renderer.update(); await final.converge({samples});
  };
  try {
    const before = (await final.readPixels('hdr')).data;
    for (const area of [{ x: 0.5, y: 0.5, size: 0.03 }, { x: 0.85, y: 0.3, size: 0.05 }]) {
      const samples = await query(area.x, area.y, area.size);
      const depth = pickFocusDepth(Array.from(samples).filter(d => d > 0), 49);
      const expected = measureAreaDepth(root, camera, area, 1.5);
      check(depth !== null && expected !== null && Math.abs(depth - expected) < 0.001,
        `GPU matches CPU: ${depth?.toFixed(5)} vs ${expected?.toFixed(5)}`);
    }
    const after = (await final.readPixels('hdr')).data;
    check(before.every((v, i) => v === after[i]), 'Query leaves raw beauty pixels unchanged');
    box.position.z = 1;
    sync.update();
    renderer.scene = sync.scene; renderer.camera = fromTHREECamera(camera); renderer.update();
  await final.converge({samples: 8});
    const moved = await query(0.5, 0.5, 0.03);
    check(Math.abs(moved[24] - 2.8) < 0.001, 'Updated GPU transforms: 2.8');
    root.remove(...root.children);
    const planeMaterial = new THREE.MeshBasicMaterial();
    const subject = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), planeMaterial);
    subject.position.set(0.5, 0.4, 1);
    root.add(subject);
    await render();
    const projected = subject.position.clone().project(camera);
    const x = (projected.x + 1) / 2, y = (1 - projected.y) / 2;
    check(Math.abs((await query(x, y, 0))[24] - 3) < 0.001, 'Off-center point uses top-left coordinates');
    check((await query(x, 1 - y, 0)).every(d => d === 0), 'Empty area misses');
    check((await query(0, 0, 0.1))[0] === 0, 'Out-of-viewport samples miss');

    // A cutout and an invisible catcher between the camera and subject must
    // both be traversed without stealing focus.
    const cutoutMaterial = new THREE.MeshBasicMaterial({ alphaTest: 0.5 });
    cutoutMaterial.map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
    cutoutMaterial.map.needsUpdate = true;
    const cutout = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), cutoutMaterial);
    cutout.position.z = 2;
    const catcherMaterial = new THREE.MeshStandardMaterial();
    catcherMaterial.userData.mutracerShadowCatcher = true;
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), catcherMaterial);
    catcher.position.z = 2.5;
    root.add(cutout, catcher);
    await render();
    check(Math.abs((await query(x, y, 0))[24] - 3) < 0.001, 'Skips alpha holes and invisible shadow catchers');
    root.remove(cutout, catcher, subject);

    const geometry = new THREE.PlaneGeometry(2, 2, 8, 8);
    const morph = geometry.attributes.position.clone();
    for (let i = 0; i < morph.count; i++) morph.setZ(i, 2);
    geometry.morphAttributes.position = [morph];
    const animated = new THREE.Mesh(geometry, planeMaterial);
    animated.morphTargetInfluences![0] = 0.5;
    root.add(animated);
    await render();
    const morphDepth = await query(0.5, 0.5, 0.03);
    check(morphDepth.every(d => Math.abs(d - 3) < 0.001), 'All grid rays hit the flat animated mesh, including shared edges');
    animated.morphTargetInfluences![0] = 1;
    await render();
    check(Math.abs((await query(0.5, 0.5, 0.03))[24] - 2) < 0.001, 'Updated animation pose is queried');
    root.remove(animated);

    const instanced = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), planeMaterial, 2);
    instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(100, 0, 0));
    instanced.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, 1));
    root.add(instanced);
    await render();
    check(Math.abs((await query(0.5, 0.5, 0.03))[24] - 3) < 0.001, 'GPU depth follows instances');
    root.remove(instanced);

    const detailed = new THREE.Mesh(new THREE.SphereGeometry(1, 512, 256), planeMaterial);
    root.add(detailed);
    await render();
    await query(0.5, 0.5, 0.07); // Warm shader compilation separately.
    const area = { x: 0.5, y: 0.5, size: 0.07 };
    const cpuStart = performance.now();
    const cpuDepth = measureAreaDepth(root, camera, area, 1.5);
    const cpuMs = performance.now() - cpuStart;
    const gpuStart = performance.now();
    const pending = renderer.readDepthSamples(area);
    const gpuCallMs = performance.now() - gpuStart;
    const gpuSamples = await pending;
    const gpuWallMs = performance.now() - gpuStart;
    const gpuDepth = pickFocusDepth(Array.from(gpuSamples!).filter(d => d > 0), 49);
    check(cpuDepth !== null && gpuDepth !== null && Math.abs(cpuDepth - gpuDepth) < 0.001,
      'Detailed mesh GPU depth matches CPU');
    lines.push(`${detailed.geometry.index!.count / 3} triangles: CPU ${cpuMs.toFixed(2)} ms, GPU call ${gpuCallMs.toFixed(2)} ms, asynchronous completion ${gpuWallMs.toFixed(2)} ms`);
    document.querySelector('#result')!.textContent = lines.join('\n');
    const { adapterName: adapterInfo } = await renderer.init();
    return { backend: renderer.backend, layout,
      adapter: adapterInfo, lines };
  } finally {
    renderer.dispose(); sync.dispose(); canvas.remove();
  }
}

Object.assign(window, { depthQueryTests: { baseline, run } });
document.querySelector('#result')!.textContent = 'Ready';
for (const backend of ['webgpu', 'webgl']) {
  document.querySelector(`#${backend}`)!.addEventListener('click', () => {
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    document.querySelector('#result')!.textContent = 'Running…';
    void run(backend === 'webgl').catch(error => {
      document.querySelector('#result')!.textContent = `FAIL: ${error}`;
    }).finally(() => {
      document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    });
  });
}
