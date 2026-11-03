import * as THREE from 'three';
import {Engine, Render, THREESync, GeometryAttribute, OpenPBRMaterial} from '../../src/main.js';

/** Small real-GPU check for compact material records, color fallback and region updates. */
export async function captureCompactVertices() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  engine.display.setSize(32, 32);
  const render = new Render(engine, {width: 32, height: 32, bounces: 1, bevel: false});
  const scene = new THREE.Scene(); scene.background = new THREE.Color(.1, .2, .3);
  const material = new THREE.MeshBasicMaterial({color: 0xff0000});
  const source = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), material); scene.add(source);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 2;
  const sync = new THREESync(engine, {scene, camera});
  const errors: string[] = [], results: {name: string; maxError: number}[] = [];
  engine.on('error', event => errors.push(event.message));
  const pixels = async () => {
    engine.update(); await render.converge({samples: 1, sampleSequenceOffset: 17, timeoutMs: 30000});
    return (await render.readPixels('hdr')).data;
  };
  const compare = (name: string, a: Float32Array, b: Float32Array, tolerance = 2e-5) => {
    let maxError = 0; for (let i = 0; i < a.length; i++) maxError = Math.max(maxError, Math.abs(a[i] - b[i]));
    results.push({name, maxError}); if (!(maxError <= tolerance)) throw Error(`${name}: ${maxError} > ${tolerance}`);
  };
  try {
    await engine.init(); engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    sync.update();
    const mesh = sync.scene!.meshes[0], geometry = mesh.geometry, red = mesh.materials[0];
    const redImage = await pixels();
    // Zero-opacity fallback must not hide the explicitly selected opaque material.
    const blue = new OpenPBRMaterial({unlit: true, baseColor: [0, 0, 1], emissionColor: [0, 0, 1], emissionLuminance: 1});
    mesh.materials = [blue]; const blueImage = await pixels();
    mesh.materials = [blue, red];
    geometry.materialIndex = new GeometryAttribute(new Int32Array(geometry.vertexCount).fill(1), 1);
    geometry.markUpdated(); compare('explicit triangle materials', await pixels(), redImage);
    geometry.materialIndex.array.fill(0); geometry.markUpdated();
    compare('material-index region update', await pixels(), blueImage);
    blue.geometryOpacity = 0; blue.alphaMode = 'blend';
    geometry.materialIndex.array.fill(1); geometry.markUpdated();
    compare('opaque triangles override transparent fallback', await pixels(), redImage);
    geometry.materialIndex = undefined; mesh.materials = [red]; geometry.markUpdated();
    const beforeDeformation = await pixels();
    geometry.position.array[0] -= .1; geometry.markVerticesUpdated();
    compare('position/normal refit retains static attributes', await pixels(), beforeDeformation);
    geometry.color = new GeometryAttribute(new Float32Array(geometry.vertexCount * 3).fill(.5), 3);
    geometry.markUpdated(); await pixels();
    // Promote a resident unorm plane when an ordinary attribute edit adds HDR RGB.
    for (let i = 0; i < geometry.vertexCount; i++) geometry.color.array.set([2, .5, .25], i * 3);
    geometry.markVerticesUpdated(); const promoted = await pixels();
    if (!(promoted[0] > 1.9 && promoted[0] < 2.01)) throw Error(`HDR color was clamped: ${promoted[0]}`);
    geometry.color = new GeometryAttribute(geometry.color.array.slice(), 3); geometry.markUpdated();
    compare('HDR color after rebuilding', await pixels(), promoted);
    if (errors.length) throw Error(errors.join('\n'));
    return {passed: true, backend: engine.backend, results};
  } finally {sync.dispose(); render.dispose(); engine.dispose(); canvas.remove();}
}
