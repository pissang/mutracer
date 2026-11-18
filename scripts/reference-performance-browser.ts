import * as THREE from '/node_modules/three/build/three.module.js';
import {GLTFExporter} from '/node_modules/three/examples/jsm/exporters/GLTFExporter.js';
import {GLTFLoader} from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import {Engine, Render} from '/lib/main.js';
import { THREESync } from '/lib/util/fromTHREE.js';

const backend = new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'webgpu';
const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
async function run() {
  const source = new THREE.Scene();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({color: 0x808080, roughness: .6}));
  ground.rotation.x = -Math.PI / 2;
  source.add(ground);
  for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) {
    const color = new THREE.Color().setHSL((x + z * 6) / 36, .6, .5);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(.35, 64, 32),
      new THREE.MeshStandardMaterial({color, metalness: x % 2, roughness: .1 + z * .13}));
    mesh.position.set((x - 2.5) * .9, .35, (z - 2.5) * .9);
    source.add(mesh);
  }
  const asset = await new GLTFExporter().parseAsync(source, {binary: false});
  const loaded = await new GLTFLoader().parseAsync(JSON.stringify(asset), '');
  const scene = new THREE.Scene();
  scene.add(loaded.scene);
  const light = new THREE.RectAreaLight(0xffe6cc, 6, 3, 3);
  light.position.set(-2, 6, 3);
  light.lookAt(0, 0, 0);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(40, 640 / 360, .1, 100);
  camera.position.set(0, 6.5, 9);
  camera.lookAt(0, 0, 0);
  const engine = new Engine({canvas: document.querySelector('canvas'), backend});
  engine.display.setSize(640, 360);
  engine.display.bloomIntensity = .2;
  const render = new Render(engine, {width: 640, height: 360, bounces: 3, bevel: false, maxSamples: 512});
  const sync = new THREESync(engine, {scene, camera});
  sync.update();
  engine.update();
  const errors = [];
  engine.on('error', event => errors.push(event.message));
  const observe = () => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) throw new Error('Foreground lost');
  };
  try {
    await engine.init();
    engine.device?.addEventListener('uncapturederror', event => errors.push(event.error.message));
    await render.converge({samples: 32, sampleSequenceOffset: 19, timeoutMs: 120000});
    await render.setDenoiser({type: 'jnlm', iterations: 2, schedule: 'every-sample'});
    const durations = [];
    for (let i = 0; i < 180; i++) {
      observe();
      const start = performance.now();
      render.refine();
      engine.display.present(render);
      const duration = performance.now() - start;
      if (i >= 30) durations.push(duration);
      await raf();
    }
    if (engine.device) await engine.device.queue.onSubmittedWorkDone();
    else engine._webglRenderer.gl.finish();
    if (errors.length) throw new Error(errors.join('\n'));
    window.benchmarkResult = {backend, samples: render.samples,
      activeFrameCPUms: durations.reduce((a, b) => a + b, 0) / durations.length};
    // Retain the live renderer while the controller forces GC and measures it.
    await new Promise(resolve => {window.finishBenchmark = resolve;});
  } finally {sync.dispose(); render.dispose(); engine.dispose();}
}
window.runBenchmark = run;
