import {expect, it} from 'vitest';
import {meshMembershipChanged, mergeMaterialUpdate, snapshotMeshes, snapshotsByMesh} from '../../src/renderer/meshMembership.js';
import Mesh from '../../src/scene/Mesh.js';
import InstancedMesh from '../../src/scene/InstancedMesh.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';

it('detects membership edits but not transform-only edits', () => {
  const material = new OpenPBRMaterial();
  const mesh = new Mesh(createPlaneGeometry(), material);
  const batch = new InstancedMesh(createPlaneGeometry(), material, {count: 2});
  const before = snapshotMeshes([mesh, batch]);
  expect(before[1].instanceCount).toBe(2);
  expect(snapshotsByMesh(before).get(batch)).toBe(before[1]);

  mesh.transform[12] = 1;
  expect(meshMembershipChanged(snapshotMeshes([mesh, batch]), before)).toBe(false);
  mesh.visible = false;
  expect(meshMembershipChanged(snapshotMeshes([mesh, batch]), before)).toBe(true);
  mesh.visible = true;
  batch.count = 1;
  expect(meshMembershipChanged(snapshotMeshes([mesh, batch]), before)).toBe(true);
  expect(meshMembershipChanged(snapshotMeshes([batch, mesh]), before)).toBe(true);
});

it('keeps texture-level material updates until they are consumed', () => {
  const a = new OpenPBRMaterial(), b = new OpenPBRMaterial();
  const textures = mergeMaterialUpdate(undefined, {level: 'textures', emission: false, emissiveMap: true}, [a]);
  const merged = mergeMaterialUpdate(textures, {level: 'params', emission: true, emissiveMap: false}, [b]);
  expect(merged).toEqual({level: 'textures', emission: true, emissiveMap: true, materials: new Set([a, b])});
  expect(mergeMaterialUpdate(undefined, {level: 'params', emission: false, emissiveMap: false}, [a]).level).toBe('params');
});
