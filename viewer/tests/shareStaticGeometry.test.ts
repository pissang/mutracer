import * as THREE from 'three';
import {Engine, THREESync} from '@meimu/mutracer';
import {expect, it} from 'vitest';

function setup(source: THREE.Mesh) {
  const scene = new THREE.Scene(); scene.add(source);
  const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement});
  const sync = new THREESync(engine, {scene});
  sync._shareStaticGeometry = true;
  sync.update();
  return {engine, sync, geometry: sync.scene!.meshes[0].geometry};
}

it('shares static attributes, retains picking and reuses synchronization until source edits', () => {
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(source.geometry.index!.array), 1));
  const {engine, sync, geometry} = setup(source);
  try {
    expect(geometry.position.array).toBe(source.geometry.attributes.position.array);
    expect(geometry.normal.array).toBe(source.geometry.attributes.normal.array);
    expect(geometry.uv!.array).toBe(source.geometry.attributes.uv.array);
    expect(geometry.indices.array).toBe(source.geometry.index!.array);
    sync.update(); expect(sync.scene!.meshes[0].geometry).toBe(geometry);
    const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(source).length).toBeGreaterThan(0);
    source.geometry.attributes.position.setX(0, .75); source.geometry.attributes.position.needsUpdate = true;
    sync.update();
    const next = sync.scene!.meshes[0].geometry;
    expect(next).not.toBe(geometry);
    expect(next.position.array[0]).toBe(.75);
    expect(next.position.array).toBe(source.geometry.attributes.position.array);
  } finally {sync.dispose(); engine.dispose();}
});

it('preserves reversed winding/normals and deforming geometry ownership', () => {
  for (const kind of ['back', 'morph']) {
    const original = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial({side: kind === 'back' ? THREE.BackSide : THREE.FrontSide});
    if (kind === 'morph') original.morphAttributes.position = [original.attributes.position.clone()];
    const source = new THREE.Mesh(original, material), {engine, sync, geometry} = setup(source);
    try {
      if (kind === 'back') expect(geometry.position.array).toBe(original.attributes.position.array);
      else expect(geometry.position.array).not.toBe(original.attributes.position.array);
      expect(geometry.normal.array).not.toBe(original.attributes.normal.array);
      if (kind === 'back') {
        expect([...geometry.indices.array.slice(0, 3)]).toEqual([original.index!.array[0], original.index!.array[2], original.index!.array[1]]);
        expect(geometry.normal.array[0]).toBe(-original.attributes.normal.array[0]);
      }
    } finally {sync.dispose(); engine.dispose();}
  }
});

it('keeps normalized/interleaved attributes decoded and partial index ranges independent', () => {
  const original = new THREE.BoxGeometry(), positions = original.attributes.position;
  const interleaved = new THREE.InterleavedBuffer(new Float32Array(positions.array), 3);
  original.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
  original.setAttribute('color', new THREE.Uint8BufferAttribute(new Uint8Array(positions.count * 3).fill(128), 3, true));
  original.clearGroups(); original.addGroup(0, 6, 0); original.addGroup(6, 30, 1);
  const source = new THREE.Mesh(original, [new THREE.MeshStandardMaterial({vertexColors: true}), new THREE.MeshStandardMaterial()]);
  const {engine, sync, geometry} = setup(source);
  try {
    expect(geometry.position.array).not.toBe(interleaved.array);
    expect(geometry.color!.array[0]).toBeCloseTo(128 / 255);
    expect(geometry.indices.array).not.toBe(original.index!.array);
    expect(geometry.indices.array.length).toBe(6);
  } finally {sync.dispose(); engine.dispose();}
});

it('keeps converted Uint32 indices for Uint16 input to avoid duplicate canonical caches', () => {
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const {engine, sync, geometry} = setup(source);
  try {
    expect(source.geometry.index!.array).toBeInstanceOf(Uint16Array);
    expect(geometry.indices.array).toBeInstanceOf(Uint32Array);
    expect(geometry.indices.array).not.toBe(source.geometry.index!.array);
    expect([...geometry.indexArray]).toEqual([...source.geometry.index!.array]);
  } finally {sync.dispose(); engine.dispose();}
});

it('keeps default library conversion storage independent', () => {
  const scene = new THREE.Scene(), source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  scene.add(source);
  const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement});
  const sync = new THREESync(engine, {scene});
  try {
    sync.update();
    expect(sync.scene!.meshes[0].geometry.position.array).not.toBe(source.geometry.attributes.position.array);
    expect(sync.scene!.meshes[0].geometry.normal.array).not.toBe(source.geometry.attributes.normal.array);
  } finally {sync.dispose(); engine.dispose();}
});
