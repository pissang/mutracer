// Procedural GLTFLoader/THREESync fixture shared by cached reference captures.
import * as THREE from '/node_modules/three/build/three.module.js';
import {GLTFExporter} from '/node_modules/three/examples/jsm/exporters/GLTFExporter.js';
import {GLTFLoader} from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import {Engine, Render} from '/lib/main.js';
import { THREESync } from '/lib/util/fromTHREE.js';
import {WGPUJNLMDenoisePass} from '/lib/renderer/WGPUJNLMDenoiser.js';
import {WebGLJNLMDenoisePass} from '/lib/renderer/WebGLJNLMDenoiser.js';
import {createJNLMDenoiser} from '/lib/renderer/jnlm.js';

const backend = new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'webgpu';
const save = async (name, body) => {
  const response = await fetch('/evidence/' + backend + '-' + name, {method: 'POST', body});
  if (!response.ok) throw new Error('Failed to save ' + name);
};
export async function run() {
  const source = new THREE.Scene();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardMaterial({color: 0x808080, roughness: .6}));
  ground.rotation.x = -Math.PI / 2;
  source.add(ground);
  for (const [x, color, metalness, roughness] of [
    [-1.2, 0xcc2819, 0, .4], [0, 0xf2bf59, 1, .2], [1.2, 0x3399cc, 0, .05],
  ]) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(.5, 64, 32),
      new THREE.MeshStandardMaterial({color, metalness, roughness}));
    mesh.position.set(x, .5, 0);
    source.add(mesh);
  }
  const asset = await new GLTFExporter().parseAsync(source, {binary: false});
  const loaded = await new GLTFLoader().parseAsync(JSON.stringify(asset), '');
  const scene = new THREE.Scene();
  scene.add(loaded.scene);
  const light = new THREE.RectAreaLight(0xffe6cc, 6, 1.5, 1.5);
  light.position.set(-1.5, 3, 1.5);
  light.lookAt(0, 0, 0);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(40, 192 / 128, .1, 100);
  camera.position.set(0, 2.4, 6);
  camera.lookAt(0, .3, -.3);
  const engine = new Engine({canvas: document.querySelector('canvas'), backend});
  engine.display.setSize(192, 128);
  engine.display.bloomIntensity = .2;
  const render = new Render(engine, {width: 192, height: 128, bounces: 3, bevel: false});
  const sync = new THREESync(engine, {scene, camera});
  sync.update();
  engine.update();
  const errors = [];
  engine.on('error', event => errors.push(event.message));
  try {
    await engine.init();
    engine.device?.addEventListener('uncapturederror', event => errors.push(event.error.message));
    await render.converge({samples: 32, sampleSequenceOffset: 19, timeoutMs: 120000});
    for (const kind of ['hdr', 'normal', 'albedo']) {
      await save(kind + '.f32', (await render.readPixels(kind)).data);
    }
    await save('display.png', await engine.display.toBlob(render));
    await render.setDenoiser({type: 'jnlm', iterations: 2});
    await render.converge({samples: 32, sampleSequenceOffset: 19, timeoutMs: 120000});
    await save('jnlm.f32', (await render.readPixels('denoised')).data);
    await save('jnlm.png', await engine.display.toBlob(render));
    if (new URLSearchParams(location.search).has('diagnostics')) {
      const prototype = backend === 'webgl' ? WebGLJNLMDenoisePass.prototype : WGPUJNLMDenoisePass.prototype;
      const method = backend === 'webgl' ? 'render' : 'encode', original = prototype[method];
      let calls = 0;
      prototype[method] = function(...args) { calls++; return original.apply(this, args); };
      try {
        for (const channel of ['normal', 'albedo', 'shadowCatcher']) {
          engine.display.channel = channel; engine.display.present(render);
          await render._output.performDenoise({kind:'jnlm',denoiser:createJNLMDenoiser({})},undefined);
        }
        if (calls) throw Error('Diagnostic channels ran color inference '+calls+' times');
      } finally { prototype[method] = original; }
    }

    if (errors.length) throw new Error(errors.join('\n'));
    return {passed: true, backend, samples: render.samples};
  } finally {
    sync.dispose();
    render.dispose();
    engine.dispose();
  }
}
window.runBenchmark = run;
