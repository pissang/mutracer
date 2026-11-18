import * as THREE from 'three';
import {Engine, Render, RenderLoop} from '../../src/main.js';
import { THREESync, fromTHREECamera } from '../../src/three.js';

async function captureMotionLoop() {
  const engine = new Engine({canvas: document.createElement('canvas'), backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  engine.display.setSize(96, 64);
  engine.display.channel = 'motion';
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial());
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(45, 1.5, .1, 100);
  camera.position.z = 4;
  const sync = new THREESync(engine, {scene});
  sync.update(); engine.scene = sync.scene;
  const updateCamera = () => {camera.updateMatrixWorld(); engine.camera = fromTHREECamera(camera);};
  updateCamera(); engine.update();
  const info = await engine.init();
  const errors: string[] = [];
  engine.on('error', error => errors.push(error.message));
  engine.device?.addEventListener('uncapturederror', e => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const check = (ok: boolean, message: string) => {if (!ok) throw new Error(message);};
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const magnitude = (data: Float32Array) => {
    let max = 0, valid = 0;
    for (let o = 0; o < data.length; o += 4) if (data[o + 3] === 3) {
      max = Math.max(max, Math.hypot(data[o], data[o + 1])); valid++;
    }
    return {max, valid};
  };
  const cases = [];
  try {
    // Reproduce switching an already rendered viewer to Motion.
    const beauty = new Render(engine, {width: 48, height: 32, bounces: 1, maxSamples: 1});
    try {await beauty.converge({samples: 1});} finally {beauty.dispose();}
    for (const {preview, stopWithEdit} of [{preview: false, stopWithEdit: false}, {preview: true, stopWithEdit: false}, {preview: true, stopWithEdit: true}]) {
      const loop = new RenderLoop(engine, {idleMs: 0,
        preview: preview ? {resolutionScale: .5, aovs: ['motion'], adaptiveResolution: false} : false,
        final: {aovs: ['motion'], maxSamples: 4}});
      let moving = false;
      loop.select = () => moving && preview ? 'preview' : 'final';
      const finish = async () => {
        const start = performance.now();
        while (loop.tick() !== 'finished') {
          check(performance.now() - start < 30000 && loop.status !== 'error', `Motion loop timed out (preview=${preview}, status=${loop.status}, errors=${errors.join('; ')})`);
          await frame();
        }
      };
      try {
        await finish(); loop.tick();
        moving = true;
        for (let i = 0; i < 6; i++) {
          camera.position.x += .02; updateCamera(); loop.tick(); await frame();
        }
        const active = preview ? loop.preview! : loop.final;
        const lastMoving = magnitude((await active.readPixels('motion')).data);
        const presented: Promise<{max: number; final: boolean}>[] = [];
        const present = engine._present.bind(engine);
        engine._present = target => {
          present(target);
          // Enqueue readback at each presentation, before another frame can
          // replace it. Checking only the final image misses a one-frame flash.
          const final = target === loop.final._output;
          presented.push(target.readPresentation().then(image => ({final,
            max: image.data.reduce((max, value, i) => i % 4 === 3 ? max : Math.max(max, value), 0)})));
        };
        moving = false;
        if (stopWithEdit) {camera.position.x += .000001; updateCamera();}
        try {await finish();} finally {engine._present = present;}
        const stopPresentations = await Promise.all(presented);
        const firstFinal = magnitude((await loop.final.readPixels('motion')).data);
        for (let i = 0; i < 3; i++) loop.tick();
        const stopped = magnitude((await loop.final.readPixels('motion')).data);
        const shown = await loop.final._output!.readPresentation();
        const brightness = shown.data.reduce((max, value, i) => i % 4 === 3 ? max : Math.max(max, value), 0);
        cases.push({preview, stopWithEdit, lastMoving, firstFinal, stopped, brightness, stopPresentations});
        check(lastMoving.max > .1, 'Moving camera lost motion');
        check(stopped.valid > 100, 'Static motion history became invalid');
        if (!location.search.includes('baseline')) {
          check(stopped.max < .001 && brightness < .001, 'Stopped camera retained motion');
          if (preview) {
            check(firstFinal.max < .001, 'Final switch displayed stale motion');
            check(stopPresentations.every(image => !image.final || image.max < .001), 'Final switch flashed an intermediate frame');
          }
        }
        camera.position.x += .02; updateCamera(); loop.tick();
        const resumed = magnitude((await loop.final.readPixels('motion')).data);
        check(resumed.valid > 100 && resumed.max > .1 && resumed.max < .5, 'Motion did not resume from the new baseline');
        check(loop.final.samples === 0, 'Motion loop traced beauty');
      } finally {loop.dispose();}
    }
    check(errors.length === 0, errors.join('\n'));
    return {backend: engine.backend, adapter: info.adapterName, cases};
  } finally {sync.dispose(); engine.dispose();}
}

captureMotionLoop().then(result => {
  Object.assign(window, {motionLoopResult: result});
  document.querySelector('#result')!.textContent = JSON.stringify(result);
}).catch(error => {document.querySelector('#result')!.textContent = String(error); console.error(error);});
