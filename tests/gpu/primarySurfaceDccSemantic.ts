import * as THREE from 'three';
import {Engine, Render, THREESync, fromTHREECamera, type AovKind} from '../../src/main.js';
import MaterialData from '../../src/renderer/MaterialData.js';
import {MATERIAL_FLOAT_COUNT, materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';
const primary: AovKind[] = ['centerNormal', 'centerDepth', 'centerPosition'];
const legacy: AovKind[] = ['depth', 'position', 'roughness', 'id', 'motion', 'diffuseAlbedo', 'specularAlbedo'];
const check = (ok: boolean, message: string) => {if (!ok) throw Error(message);};
const equal = (a: ArrayBufferView, b: ArrayBufferView) => {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
export async function runBenchmark() {
  const baseline = location.search.includes('baseline');
  const canvas = document.querySelector('canvas')!;
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const root = new THREE.Scene();
  const texture = new THREE.DataTexture(new Uint8Array([204, 128, 230, 255]), 1, 1);
  texture.needsUpdate = true;
  for (let i = 0; i < 3; i++) {
    const material = new THREE.MeshStandardMaterial({side: i === 0 ? THREE.FrontSide : THREE.DoubleSide, roughness: .4, normalMap: i === 2 ? texture : null});
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.2), material);
    mesh.position.set((i - 1) * 1.6, 0, i * .5);
    if (i > 0) mesh.rotation.y = Math.PI;
    root.add(mesh);
  }
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshStandardMaterial({transparent: true, opacity: .25}));
  veil.position.z = 2; root.add(veil, new THREE.AmbientLight());
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshStandardMaterial());
  catcher.position.z = 1.8; root.add(catcher);
  const camera = new THREE.PerspectiveCamera(45, 1.5, .1, 100);
  camera.position.z = 6; camera.updateMatrixWorld();
  const sync = new THREESync(engine, {scene: root}); sync.update();
  sync.scene!.meshes.forEach((mesh, i) => {mesh.aovId = 100 + i; mesh.materials[0].aovId = 200 + i;});
  sync.scene!.meshes[4].materials[0].shadowCatcher = true;
  engine.scene = sync.scene; engine.camera = fromTHREECamera(camera); engine.update();
  const render = new Render(engine, {width: 48, height: 32, bounces: 1, bevel: false, aovs: legacy});
  const failures: string[] = []; engine.on('error', e => failures.push(e.message));
  const captureEvidence = location.pathname === '/reference' || location.search.includes('evidence');
  const upload = async (name: string, data: ArrayBufferView) => {
    if (!captureEvidence) return;
    await fetch('/evidence/' + engine.backend + '-' + name + '.bin', {method: 'POST', body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)});
  };

  try {
    const info = await engine.init();
  if (captureEvidence) {
    const meshes = root.children.filter((object): object is THREE.Mesh => (object as THREE.Mesh).isMesh);
    const input = meshes.map(mesh => {
      const material = mesh.material as THREE.MeshStandardMaterial;
      const map = material.normalMap;
      const image = map?.image as {data?: Uint8Array,width?:number,height?:number}|undefined;
      return {positions:Array.from(mesh.geometry.attributes.position.array), normals:Array.from(mesh.geometry.attributes.normal.array),
        uv:Array.from(mesh.geometry.attributes.uv.array), tangents:mesh.geometry.attributes.tangent ? Array.from(mesh.geometry.attributes.tangent.array) : null,
        indices:Array.from(mesh.geometry.index!.array), matrixWorld:mesh.matrixWorld.toArray(), side:material.side,
        doubleSided:material.side===THREE.DoubleSide, normalScale:material.normalScale.toArray(),
        normalMap:map ? {rgba:Array.from(image?.data ?? []),width:image?.width,height:image?.height,colorSpace:map.colorSpace,flipY:map.flipY,
          wrapS:map.wrapS,wrapT:map.wrapT,repeat:map.repeat.toArray(),offset:map.offset.toArray(),rotation:map.rotation,
          channel:map.channel,format:map.format,type:map.type} : null};
      });
      const converted = sync.scene!.meshes.slice(0,3).map(mesh => {
        const material = mesh.materials[0];
        return {positions:Array.from(mesh.geometry.position.array), indices:Array.from(mesh.geometry.indices.array),
          normals:Array.from(mesh.geometry.normal.array), uv:Array.from(mesh.geometry.uv!.array),
          tangents:mesh.geometry.tangent ? Array.from(mesh.geometry.tangent.array) : null,
          transform:Array.from(mesh.transform), visible:mesh.visible, aovId:mesh.aovId,
          instanceCount:mesh.instanceData?.count ?? 1, doubleSided:material.doubleSided,
          materialAovId:material.aovId, alphaMode:material.alphaMode,
          normalScale:Array.from(material.normalScale), texture:material.normalMap ? {flipY:material.normalMap.flipY,
            uvScale:material.normalMap.uvScale,uvOffset:material.normalMap.uvOffset,wrapS:material.normalMap.wrapS,
            wrapT:material.normalMap.wrapT,colorSpace:material.normalMap.colorSpace,uvChannel:material.normalMap.uvChannel} : null};
      });
      const actualMaterials = sync.scene!.meshes.flatMap(mesh => mesh.materials);
      const packedMaterialData = new MaterialData(actualMaterials, [], () => 0).getBufferArray();
      const doubleSidedOffset = materialLayoutFields().find(field => field.name === 'doubleSided')!.offset / 4;
      const packedDoubleSided = actualMaterials.map((_, i) => packedMaterialData[i * MATERIAL_FLOAT_COUNT + doubleSidedOffset]);
      await upload('input-json', new TextEncoder().encode(JSON.stringify({meshes:input,converted,packedDoubleSided,
      camera:{matrixWorld:camera.matrixWorld.toArray(),fov:camera.fov,aspect:camera.aspect,near:camera.near,far:camera.far},size:[48,32]})));
  }
    engine.device?.addEventListener('uncapturederror', e => failures.push((e as GPUUncapturedErrorEvent).error.message));
    for (const dof of [false, true]) {
      engine.camera!.fStop = dof ? .15 : 0; engine.camera!.focusDistance = 3; engine.update();
      render.aovs = legacy; render.restart();
      await render.converge({samples: 4, sampleSequenceOffset: 17});
      const old = new Map<string, Float32Array | Uint32Array>();
      for (const kind of ['hdr', 'normal', 'albedo', ...legacy] as const) {
        const image = await render.readPixels(kind); old.set(kind, image.data);
        await upload(`${dof ? 'dof' : 'pinhole'}-${kind}`, image.data);
      }
      if (baseline) continue;
      // Establish static history before changing the requested storage layout.
      render.restart(); await render.converge({samples: 4, sampleSequenceOffset: 17});
      old.set('motion', (await render.readPixels('motion')).data);
      render.aovs = [...legacy, ...primary]; render.restart();
      await render.converge({samples: 4, sampleSequenceOffset: 17});
      for (const [kind, data] of old) {
        const image = await render.readPixels(kind as 'hdr');
        check(equal(data, image.data), `Enabling primary changed ${kind} (${dof})`);
      }
      const normal = await render.readPixels('centerNormal'), depth = await render.readPixels('centerDepth'), position = await render.readPixels('centerPosition'), id = await render.readPixels('id');
      let hits = 0, misses = 0, mapped = 0, back = 0;
      for (let o = 0; o < id.data.length; o += 4) {
        const object = id.data[o], valid = object !== 0xffffffff;
        for (const image of [normal, depth, position]) {
          check(image.data[o + 3] === +valid, 'Binary validity differs from ID');
          if (!valid) check(image.data.slice(o, o + 4).every(v => v === 0), 'Nonzero background');
        }
        if (!valid) {misses++; continue;}
        hits++;
        check(object >= 100 && object <= 102 && id.data[o + 2] === object + 100 && id.data[o + 3] < 2, 'Wrong selected surface through veil/catcher');
        const z = (object - 100) * .5;
        check(Math.abs(position.data[o + 2] - z) < 1e-5 && Math.abs(depth.data[o] - (6 - z)) < 1e-5, 'ID/depth/position surface mismatch');
        const pixel = o / 4, x = pixel % 48, y = Math.floor(pixel / 48), scale = 2 * Math.tan(Math.PI / 8) * (6 - z) / 32;
        check(Math.abs(position.data[o] - (x + .5 - 24) * scale) < 1e-5 && Math.abs(position.data[o + 1] - (15.5 - y) * scale) < 1e-5, 'Position is not pixel-center pinhole');
        const n = normal.data.slice(o, o + 3);
        check(Math.abs(Math.hypot(...n) - 1) < 1e-5, 'Normal is not unit length');
        if (object === 100) check(n[2] > .9999, 'Front normal incorrect');
        if (object === 101) {check(n[2] < -.9999, 'Backface normal was face-forwarded'); back++;}
        if (object === 102) {check(n[0] < -.5 && n[2] < -.7 && n[2] > -.9, 'Backface normal map missing or flipped'); mapped++;}
      }
      check(hits > 200 && misses > 100 && mapped > 30 && back > 30, 'Fixture coverage insufficient');
      for (const kind of primary) {
        const image = await render.readPixels(kind);
        await upload(`${dof ? 'dof' : 'pinhole'}-${kind}`, image.data);
        engine.display.channel = kind; engine.display.present(render);
        const png = await engine.display.toBlob(render); check(!!png?.size, `No display export for ${kind}`);
        const bitmap = await createImageBitmap(png, {colorSpaceConversion: 'none'});
        const exported = new OffscreenCanvas(bitmap.width, bitmap.height), context = exported.getContext('2d')!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        check(exported.width === image.width && exported.height === image.height, 'Display export dimensions');
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        for (let o = 0; o < image.data.length; o += 4) {
          check(pixels[o + 3] === image.data[o + 3] * 255, 'Display validity mismatch');
          if (pixels[o + 3] === 0) continue;
          for (let c = 0; c < 3; c++) {
            const value = kind === 'centerDepth' ? image.data[o] / 10 : image.data[o + c] * .5 + .5;
            check(Math.abs(pixels[o + c] - Math.round(Math.max(0, Math.min(1, value)) * 255)) <= 2, `Display mapping incorrect: ${kind}`);
          }
        }
        if (captureEvidence) await fetch('/evidence/' + engine.backend + '-' + kind + '.png', {method: 'POST', body: png});
      }
      engine.display.channel = 'final';
      if (dof) break;
    }
    if (!baseline) {
      const expected = await Promise.all(primary.map(kind => render.readPixels(kind)));
      // Different jitter stream and cap cannot affect any center output.
      render.restart(); await render.converge({samples: 8, sampleSequenceOffset: 133});
      for (let i = 0; i < primary.length; i++) check(equal((await render.readPixels(primary[i])).data, expected[i].data), 'Jitter stream changed center output');
      for (let i = 0; i < primary.length; i++) {
        render.aovs = [primary[i]]; render.restart(); await render.converge({samples: 1});
        const standalone = await render.readPixels(primary[i]); await upload(`standalone-${primary[i]}`, standalone.data); check(equal(standalone.data, expected[i].data), 'Standalone center output differs');
      }
      render.aovs = [...legacy, ...primary];
      const ortho = new THREE.OrthographicCamera(-3, 3, 2, -2, .1, 100); ortho.position.z = 6; ortho.updateMatrixWorld();
      engine.camera = fromTHREECamera(ortho); engine.update();
      await render.converge({samples: 4});
      const ids = await render.readPixels('id'), point = await render.readPixels('centerPosition'), normal = await render.readPixels('centerNormal'), depth = await render.readPixels('centerDepth');
      await upload('orthographic-id', ids.data); await upload('orthographic-centerPosition', point.data); await upload('orthographic-centerNormal', normal.data); await upload('orthographic-centerDepth', depth.data);
      let hits = 0;
      for (let o = 0; o < ids.data.length; o += 4) {
        const object = ids.data[o]; if (object === 0xffffffff) continue;
        const pixel = o / 4, z = (object - 100) * .5; hits++;
        check(Math.abs(point.data[o] - (pixel % 48 + .5 - 24) / 8) < 1e-5 && Math.abs(point.data[o + 1] - (15.5 - Math.floor(pixel / 48)) / 8) < 1e-5, 'Orthographic center position');
        check(Math.abs(point.data[o + 2] - z) < 1e-5 && Math.abs(depth.data[o] - (6 - z)) < 1e-5, 'Orthographic depth/ID mismatch');
        check(normal.data[o + 3] === 1 && (object === 100 ? normal.data[o + 2] > .99 : normal.data[o + 2] < -.7), 'Orthographic normal mismatch');
      }
      check(hits > 200, 'Orthographic fixture has too few hits');
      engine.camera = fromTHREECamera(camera); engine.camera.fStop = .15; engine.camera.focusDistance = 3; engine.update();
      await render.converge({samples: 4, sampleSequenceOffset: 17});
    }
    if (!baseline && engine.backend === 'webgpu') {
      let calls = 0;
      const expected = await Promise.all(primary.map(kind => render.readPixels(kind)));
      await render.setDenoiser({type: 'custom', aovs: primary, denoiser: {async denoise(input) {
        const bytes = input.width * input.height * 16;
        const staging = input.device.createBuffer({size: bytes * 3, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        const encoder = input.device.createCommandEncoder(); encoder.copyBufferToBuffer(input.color, 0, input.output, 0, bytes);
        primary.forEach((kind, i) => encoder.copyBufferToBuffer(input.aovs![kind]!, 0, staging, bytes * i, bytes));
        input.device.queue.submit([encoder.finish()]); await staging.mapAsync(GPUMapMode.READ);
        const mapped = staging.getMappedRange();
        primary.forEach((kind, i) => check(equal(new Float32Array(mapped, bytes * i, bytes / 4), expected[i].data), `Custom ${kind} differs`));
        staging.unmap(); staging.destroy(); calls++;
      }}});
      await render.converge({samples: 4, sampleSequenceOffset: 17}); check(calls > 0, 'Custom denoiser did not run');
      await render.setDenoiser(null);
      // Full-resolution center outputs on a reduced-resolution beauty render.
      engine.display.setSize(48, 32);
      const scaled = new Render(engine, {resolutionScale: .5, aovResolution: 'display', aovs: ['id', ...primary], bounces: 1});
      try {
        await scaled.converge({samples: 4});
        for (const kind of primary) {
          const image = await scaled.readPixels(kind);
          check(image.width === 48 && image.height === 32, 'Display dimensions incorrect');
          check((await scaled.readPixels('hdr')).width < image.width, 'Beauty was not reduced');
          check(equal(image.data, expected[primary.indexOf(kind)].data), `Display resolution ${kind} mismatch`);
        }
      } finally {scaled.dispose();}
    }
    check(failures.length === 0, failures.join('\n'));
    return {backend: engine.backend, adapter: info.adapterName, baseline, passed: true};
  } finally {render.dispose(); engine.dispose(); sync.dispose(); texture.dispose();}
}
Object.assign(window, {runBenchmark});
