import * as THREE from 'three';
import { Engine, Render, RenderLoop, type AovKind } from '../../src/main.js';
import { THREESync, fromTHREECamera } from '../../src/three.js';
async function capture() {
  const mark = (stage: string) => { document.querySelector('#result')!.textContent = `Running: ${stage}`; };
  const engine = new Engine({ canvas: document.createElement('canvas'), backend: location.search.includes('webgl') ? 'webgl' : 'webgpu' });
  const render = new Render(engine, { width: 48, height: 32, bounces: 1 });
  const root = new THREE.Scene(), mesh = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ roughness: .4, metalness: .2 }));
  mesh.rotation.z = .17;
  root.add(mesh, new THREE.AmbientLight());
  const camera = new THREE.PerspectiveCamera(45, 1.5, .1, 100);
  camera.position.z = 4;
  camera.updateMatrixWorld();
  const sync = new THREESync(engine, { scene: root });
  sync.update();
  engine.scene = sync.scene;
  engine.camera = fromTHREECamera(camera);
  engine.update();
  const srgb = (v: number) => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055;
  const errors: string[] = [];
  engine.on('error', e => errors.push(e.message));
  const check = (yes: boolean, msg: string) => { if (!yes)
    throw Error(msg); };
  try {
    mark("initializing");
    await engine.init();
    engine.device?.addEventListener('uncapturederror', e => errors.push((e as GPUUncapturedErrorEvent).error.message));
    mark(`converging ${engine.display.channel}`);
    await render.converge({ samples: 4 });
    const baseline = await render.readPixels('hdr');
    engine.display.channel = 'depth';
    let missing = false;
    try {
      engine.display.present(render);
    }
    catch {
      missing = true;
    }
    check(missing, 'Missing AOV must reject');
    engine.display.channel = 'final';
    const source = sync.scene!.meshes[0];
    source.aovId = 0xfffffffe;
    source.materials[0].aovId = 0x800001ff;
    engine.update();
    const kinds: AovKind[] = ['depth', 'position', 'roughness', 'diffuseAlbedo', 'specularAlbedo', 'id', 'motion'];
    render.aovs = kinds;
    mark(`converging ${engine.display.channel}`);
    await render.converge({ samples: 4 });
    const hdr = await render.readPixels('hdr');
    check(hdr.data.every((v, i) => Object.is(v, baseline.data[i])), 'Enabling AOV changed HDR');
    const raw = new Map<AovKind, Float32Array | Uint32Array>();
    for (const kind of kinds)
      raw.set(kind, (await render.readPixels(kind)).data);
    const shown: Record<string, number[]> = {};
    const sampleCount = render.samples;
    for (const kind of kinds) {
      mark(`displaying ${kind}`);
      engine.display.channel = kind;
      engine.display.present(render);
      const image = await render._output!.readPresentation();
      shown[kind] = Array.from(image.data.slice(0, 4));
      check(image.data.every(Number.isFinite), `Nonfinite ${kind}`);
      if (kind === 'position' || kind === 'diffuseAlbedo' || kind === 'specularAlbedo') {
        const data = raw.get(kind)!;
        for (let o=0;o<data.length;o+=4) for (let c=0;c<3;c++) {
          const value = kind === 'position' ? Math.min(1,Math.max(0,data[o+c]/2+.5)) : srgb(Math.min(1,Math.max(0,data[o+c])));
          check(Math.abs(image.data[o+c]-(data[o+3]>0?value:0))<.005, `${kind} initial color mapping`);
        }
      }
      if (kind === 'depth')
        check(Math.abs(image.data[0] - .4) < .005 && image.data[3] === 1, 'Depth mapping');
      if (kind === 'roughness')
        check(Math.abs(image.data[0] - .4) < .005 && Math.abs(image.data[1] - .2) < .005 && image.data[2] === 0, 'Roughness mapping');
      if (kind === 'motion')
        check(image.data.every(v => v === 0), 'First motion must be transparent');
      check((await render.readPixels(kind)).data.every((v, i) => Object.is(v, raw.get(kind)![i])), `Display changed raw ${kind}`);
    }
    check(render.samples === sampleCount, 'Channel selection changed sample count');
    engine.display.channel = 'depth';
    engine.display.aovDepthRange = [0, 8];
    engine.display.toneMappingExposure = 12;
    engine.display.bloomIntensity = 2;
    engine.display.vignette = 1;
    engine.display.present(render);
    check(Math.abs((await render._output!.readPresentation()).data[0] - .5) < .005, 'Depth range or effect bypass');
    const blob = await engine.display.toBlob(render), bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    check(Math.abs(context.getImageData(0, 0, 1, 1).data[0] - 128) <= 1, 'PNG AOV export');
    engine.display.channel = 'id';
    engine.display.aovIdComponent = 'primitive';
    engine.display.present(render);
    const primitive = await render._output!.readPresentation();
    const colors = new Set<string>();
    for (let o = 0; o < primitive.data.length; o += 4)
      colors.add(Array.from(primitive.data.slice(o, o + 3)).join(','));
    check(colors.size === 2, 'Primitive ID component');
    engine.display.aovIdComponent = 'object';
    engine.display.present(render);
    const objects = await render._output!.readPresentation();
    check(objects.data.every((v, i) => Math.abs(v - shown.id[i % 4]) < .005), 'Stable object palette');
    camera.position.x = .25;
    camera.updateMatrixWorld();
    engine.camera = fromTHREECamera(camera);
    engine.update();
    mark(`converging ${engine.display.channel}`);
    await render.converge({ samples: 4 });
    engine.display.channel = 'motion';
    engine.display.present(render);
    const motion = await render._output!.readPresentation();
    check(motion.data.some((v, i) => i % 4 === 0 && v > .1), 'Motion magnitude missing');
    check(motion.data.every((v, i) => i % 4 === 0 || i % 4 === 3 || Math.abs(v) < .005), 'Positive X motion should be red');
    engine.display.channel = 'final';
    source.materials[0].coatWeight = .5;
    engine.update();
    mark(`converging ${engine.display.channel}`);
    await render.converge({ samples: 4 });
    engine.display.channel = 'diffuseAlbedo';
    engine.display.present(render);
    check((await render._output!.readPresentation()).data.every(v => v === 0), 'Unsupported reflectance must be transparent');
    mesh.scale.setScalar(.1);
    sync.update();
    engine.update();
    mark(`converging ${engine.display.channel}`);
    await render.converge({ samples: 4 });
    engine.display.channel = 'depth';
    engine.display.aovDepthRange = [0, 10];
    engine.display.present(render);
    const edges = await render.readPixels('depth'), edgeDisplay = await render._output!.readPresentation();
    let background = 0, partial = 0;
    for (let o = 0; o < edges.data.length; o += 4) {
      const a = edges.data[o + 3], expected = a > 0 ? edges.data[o] / 10 : 0;
      check(Math.abs(edgeDisplay.data[o] - expected) < .005 && Math.abs(edgeDisplay.data[o + 3] - a) < .005, 'Coverage/straight-alpha mapping');
      if (a === 0)
        background++;
      else if (a < 1)
        partial++;
    }
    check(background > 0 && partial > 0, 'Coverage fixture needs empty and partially covered pixels');
    const close = (a: number, b: number) => Math.abs(a - b) < .005;
    for (const kind of ['position', 'diffuseAlbedo', 'specularAlbedo'] as const) {
      engine.display.channel = kind;
      engine.display.present(render);
      const image = await render._output!.readPresentation(), data = (await render.readPixels(kind)).data;
      for (let o = 0; o < data.length; o += 4) {
        for (let c = 0; c < 3; c++) {
          const value = kind === 'position' ? Math.min(1, Math.max(0, data[o + c] / 2 + .5)) : srgb(Math.min(1, Math.max(0, data[o + c])));
          check(close(image.data[o + c], data[o + 3] > 0 ? value : 0), `${kind} color mapping`);
        }
        check(close(image.data[o + 3], data[o + 3]), `${kind} validity`);
      }
    }
    engine.display.channel = 'position';
    engine.display.aovPositionScale = 3e38;
    engine.display.present(render);
    const large = (await render._output!.readPresentation()).data;
    check(large.every(Number.isFinite), 'Large finite position scale');
    engine.display.channel = 'depth';
    engine.display.hdrOutputEnabled = true;
    engine.display.present(render);
    const hdrExport = (await render._output!.readPresentation()).data;
    for (let o = 0; o < edges.data.length; o += 4)
      check(close(hdrExport[o], edges.data[o + 3] > 0 ? edges.data[o] / 10 : 0), 'HDR/SDR AOV color consistency');
    // Generate newly selected AOVs without retracing beauty or dropping a
    // completed filter. Include both reflection components independently.
    source.materials[0].coatWeight = 0;
    engine.update();
    mark("loading JNLM");
    await render.setDenoiser({type: 'jnlm'});
    mark("converging JNLM");
    await render.converge({samples: 4});
    render.maxSamples = render.samples;
    const retainedSamples = render.samples;
    const retainedHdr = (await render.readPixels('hdr')).data;
    const retainedDenoised = (await render.readPixels('denoised')).data;
    const combinedDiffuse = (await render.readPixels('diffuseAlbedo')).data;
    const combinedSpecular = (await render.readPixels('specularAlbedo')).data;
    for (const channel of ['id', 'final', 'depth', 'diffuseAlbedo', 'specularAlbedo'] as const) {
      mark(`demand ${channel}`);
      render.aovs = channel === 'final' ? [] : [channel];
      engine.display.channel = channel;
      const start = performance.now();
      for (;;) {
        check(render.refine() !== 'error', 'Retired AOV selection broke refinement');
        if (engine.display.present(render)) break;
        check(performance.now() - start < 30000, 'Timed out generating selected AOV');
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      check(render.samples === retainedSamples, 'AOV selection retraced beauty');
      check((await render.readPixels('hdr')).data.every((v, i) => Object.is(v, retainedHdr[i])), 'AOV selection changed beauty');
      check((await render.readPixels('denoised')).data.every((v, i) => Object.is(v, retainedDenoised[i])), 'AOV selection changed completed denoising');
      if (channel === 'diffuseAlbedo' || channel === 'specularAlbedo') {
        const expected = channel === 'diffuseAlbedo' ? combinedDiffuse : combinedSpecular;
        check((await render.readPixels(channel)).data.every((v, i) => Math.abs(v - expected[i]) < 1e-5), 'Individual reflectance differs from combined output');
      }
      check((await render._output!.readPresentation()).data.every(Number.isFinite), 'Reduced AOV preview was not finite');
    }
    mark('standalone AOV loop');
    engine.display.hdrOutputEnabled = false;
    const loop = new RenderLoop(engine, {preview: false, final: {width: 48, height: 32, bounces: 1, maxSamples: 2, aovSamples: 2,
      samplingPattern: 'sobol', aovs: ['depth','position','roughness','diffuseAlbedo','specularAlbedo','id','motion']}});
    const reference = new Render(engine, {width: 48, height: 32, bounces: 1, maxSamples: 2, samplingPattern: 'sobol', aovs: loop.final.aovs});
    const createTarget = engine._createTarget.bind(engine);
    let beautyCalls = 0;
    engine._createTarget = () => {
      const target = createTarget();
      if (target) {const trace = target.trace.bind(target); target.trace = (...args) => {if (target === loop.final._output) beautyCalls++; return trace(...args);};}
      return target;
    };
    const finish = async () => {
      const start = performance.now();
      while (loop.tick() !== 'finished') {
        check(loop.status !== 'error', errors.join('\n'));
        check(performance.now() - start < 30000, 'Standalone AOV loop timed out');
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    };
    try {
      for (const kind of loop.final.aovs) {
        engine.display.channel = kind; await finish();
        check(loop.final.samples === 0 && beautyCalls === 0, 'AOV view traced beauty');
        check(!!engine.display.present(loop.final), 'Standalone AOV did not present');
        const actual = await loop.final.readPixels(kind);
        check(actual.data.every(Number.isFinite), 'Standalone AOV not finite');
        await reference.converge({samples: loop.final.aovSamplesRendered});
        if (kind !== 'motion') {
          const expected = await reference.readPixels(kind);
          check(actual.data.every((v,i) => kind === 'id' ? v === expected.data[i] : Math.abs(v-expected.data[i]) < 1e-5), `Standalone ${kind} differs from beauty path`);
        }
      }
      engine.display.channel = 'depth';
      check((await engine.display.toBlob(loop.final)).size > 0, 'Standalone AOV PNG failed');
      check((await loop.final.readPixels('hdr')).data.length === 0, 'AOV-only HDR must be unavailable');
      camera.position.x += .25; camera.updateMatrixWorld(); engine.camera = fromTHREECamera(camera); engine.update();
      engine.display.channel = 'motion'; await finish();
      await reference.converge({samples: 1});
      const actual = (await loop.final.readPixels('motion')).data, expected = (await reference.readPixels('motion')).data;
      check(actual.every((v,i) => Math.abs(v-expected[i]) < 1e-5), `Standalone motion history mismatch: ${JSON.stringify(Array.from(actual).map((v,i)=>({i,a:v,b:expected[i]})).filter(x=>Math.abs(x.a-x.b)>1e-5).slice(0,8))}`);
      check(beautyCalls === 0 && loop.final.samples === 0, 'Moving AOV view traced beauty');
      engine.display.channel = 'final'; await finish();
      check(beautyCalls > 0 && loop.final.samples === 2, 'Final did not resume beauty');
      await reference.converge({samples: 2});
      const resumed = (await loop.final.readPixels('hdr')).data, expectedHdr = (await reference.readPixels('hdr')).data;
      check(resumed.every((v,i) => Object.is(v,expectedHdr[i])), 'Resuming Final changed beauty');
      engine.display.channel = 'motion'; await finish(); loop.tick();
      check(loop.final.samples === 2, 'Settling motion discarded beauty samples');
      check((await loop.final.readPixels('hdr')).data.every((v,i) => Object.is(v,resumed[i])), 'Settling motion changed beauty pixels');
    } finally {engine._createTarget = createTarget; loop.dispose(); reference.dispose();}
    check(errors.length === 0, errors.join('\n'));
    return { backend: engine.backend, hdr: Array.from(hdr.data), shown, primitiveColors: colors.size, missingRejected: missing, samplesUnchanged: true, png: true, reducedAovPreview: true, partialCoverage: partial, transparentPixels: background, standaloneAovLoop: true };
  }
  finally {
    render.dispose();
    sync.dispose();
    engine.dispose();
  }
}
capture().then(async (result) => { if (location.search.includes('evidence'))
  await fetch(`http://localhost:3015/${result.backend}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) }); document.querySelector('#result')!.textContent = JSON.stringify(result); }).catch(e => { document.querySelector('#result')!.textContent = String(e); console.error(e); });
