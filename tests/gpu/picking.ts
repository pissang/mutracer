import * as THREE from 'three';
import {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {Engine, Render, THREESync} from '../../src/main.js';

/** One-sample GPU picking probe; no full-frame ID AOV is enabled. */
export async function capturePicking() {
  const source = new THREE.Scene();
  for (const [name, x, color] of [['left', -.65, 0xff0000], ['right', .65, 0x0000ff]] as const) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 2), new THREE.MeshBasicMaterial({color}));
    plane.name = name; plane.position.x = x; source.add(plane);
  }
  const data = await new GLTFExporter().parseAsync(source, {binary: false});
  const loaded = await new GLTFLoader().parseAsync(JSON.stringify(data), '');
  const scene = new THREE.Scene(); scene.add(loaded.scene);
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  engine.display.setSize(32, 32);
  const render = new Render(engine, {width: 32, height: 32, bounces: 1, bevel: false});
  const camera = new THREE.OrthographicCamera(-1.5, 1.5, 1, -1, .1, 10); camera.position.z = 4;
  const converted = new Map<string, {object: number; material: number}>();
  const sync = new THREESync(engine, {scene, camera, onMeshConverted(mesh, source) {
    if (source.name === 'left') {mesh.aovId = 0xfffffffe; mesh.materials[0].aovId = 0xfffffffd;}
    converted.set(source.name, {object: mesh.aovId, material: mesh.materials[0].aovId});
  }});
  sync._shareStaticGeometry = true;
  const errors: string[] = [], results: {name: string; hit: unknown}[] = [];
  const frame = async () => {sync.update(); engine.update(); await render.converge({samples: 1, sampleSequenceOffset: 17, timeoutMs: 30000});};
  const pick = async (name: string, x: number, y: number, expected: unknown) => {
    const hit = await engine._pick(x, y); results.push({name, hit});
    if (JSON.stringify(hit) !== JSON.stringify(expected)) throw Error(`${name}: ${JSON.stringify(hit)} != ${JSON.stringify(expected)}`);
  };
  try {
    engine.on('error', event => errors.push(event.message));
    await engine.init();
    engine.device?.addEventListener('uncapturederror', e => errors.push((e as GPUUncapturedErrorEvent).error.message));
    await frame();
    const expected = (name: string, instance = 0) => ({...converted.get(name)!, instance});
    await pick('left with uint32 source IDs', .25, .5, expected('left'));
    await pick('right', .75, .5, expected('right'));
    await pick('background', .5, .5, null);
    const mask = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1); mask.needsUpdate = true;
    const hole = new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(new THREE.PlaneGeometry(1, 2), new THREE.MeshBasicMaterial({map: mask, alphaTest: .5}));
    hole.name = 'hole'; hole.position.set(-.65, 0, .5); scene.add(hole);
    await frame(); await pick('alpha cutout', .25, .5, expected('left'));
    (hole.material as THREE.MeshBasicMaterial).map = null; (hole.material as THREE.MeshBasicMaterial).alphaTest = 0;
    await frame(); await pick('opaque foreground', .25, .5, expected('hole'));
    const depths = await engine.readDepthSamples({x: .25, y: .5, size: 0});
    if (!depths || depths.some(d => Math.abs(d - 3.5) > .001)) throw Error(`Depth regression: ${depths?.[0]}`);
    const height = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); height.needsUpdate = true;
    hole.material = new THREE.MeshStandardMaterial({displacementMap: height, displacementScale: .25, displacementBias: .1});
    await frame(); await pick('displaced foreground', .25, .5, expected('hole'));
    const displacedDepth = await engine.readDepthSamples({x: .25, y: .5, size: 0});
    // WebGL renders the original surface; WebGPU marches at height / 32 by default.
    const expectedDepth = engine.backend === 'webgl' ? 3.5 : 3.15;
    if (!displacedDepth || displacedDepth.some(d => Math.abs(d - expectedDepth) > .25 / 32 + .001)) throw Error(`Displaced depth: ${displacedDepth?.[0]}`);
    results.push({name: 'displacement depth', hit: {actual: displacedDepth[0], expected: expectedDepth}});
    scene.remove(hole, loaded.scene);
    const instances = new THREE.InstancedMesh(new THREE.PlaneGeometry(.6, .6), new THREE.MeshBasicMaterial({color: 0x00ff00}), 2);
    instances.name = 'instances'; instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-.5, -.5, 0));
    instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(.5, -.5, 0)); scene.add(instances);
    await frame(); await pick('instance 0', 1 / 3, .75, expected('instances', 0));
    await pick('instance 1', 2 / 3, .75, expected('instances', 1));
    if (errors.length) throw Error(errors.join('\n'));
    return {passed: true, backend: engine.backend, results};
  } finally {sync.dispose(); render.dispose(); engine.dispose(); canvas.remove();}
}
