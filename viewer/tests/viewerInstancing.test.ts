import * as THREE from 'three';
import {expect, it, vi, afterAll} from 'vitest';
import {Engine, InstancedMesh} from '@meimu/mutracer';
import { THREESync } from '@meimu/mutracer/three';
vi.hoisted(() => {vi.stubGlobal('location', {hash: '', href: 'https://viewer.example.com/'});});
afterAll(() => vi.unstubAllGlobals());

import {MaterialEditor} from '../src/engine/materialEditor';
import {undo} from '../src/history';

it('edits native colored instances as one source material and preserves edits through color changes', () => {
  const source = new THREE.Scene(), material = new THREE.MeshStandardMaterial({roughness: .7});
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 4);
  for (let i = 0; i < instances.count; i++) instances.setColorAt(i, new THREE.Color(i % 2 ? .5 : 1, .3, .8));
  source.add(instances);
  const editor = new MaterialEditor(() => {}); editor.setModel(source, null);
  const engine = new Engine({canvas: {width: 1,height: 1} as HTMLCanvasElement});
  const sync = new THREESync(engine, {scene: source, onMeshConverted: (batch, mesh, group) => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    editor.onConverted(materials[group.materialIndex ?? 0], batch.materials[0], mesh.uuid);
  }});
  try {
    sync.update(); const batches = sync.scene!.meshes as InstancedMesh[];
    expect(batches).toHaveLength(1); expect(batches[0].count).toBe(4);
    expect(batches[0].colors).toEqual(instances.instanceColor!.array);
    expect(editor.describe(material.uuid)?.users).toBe(1); expect(editor.firstMesh(material.uuid)).toBe(instances.uuid);
    editor.setValues(material.uuid, {specularRoughness: .25}, 'Roughness');
    for (const batch of batches) expect(batch.materials[0].specularRoughness).toBe(.25);
    instances.setColorAt(3, new THREE.Color(.2,.7,.4)); instances.instanceColor!.needsUpdate = true;
    sync.update(); expect(sync.scene!.meshes).toHaveLength(1);
    expect(sync.scene!.meshes[0]).toBe(batches[0]);
    expect(batches[0].colors).toEqual(instances.instanceColor!.array);
    for (const batch of sync.scene!.meshes) expect(batch.materials[0].specularRoughness).toBe(.25);
    undo();
    for (const batch of sync.scene!.meshes) expect(batch.materials[0].specularRoughness).toBeCloseTo(.7);
  } finally {editor.setModel(null,null);sync.dispose();engine.dispose();}
});
