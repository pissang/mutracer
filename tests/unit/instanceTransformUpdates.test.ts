import {expect, it, vi} from 'vitest';
import InstancedMesh from '../../src/scene/InstancedMesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import {renderFixture} from '../helpers/renderPipeline';
import {updateMeshInstances, updateMeshInstanceTransforms, dirtyMeshInstanceIndices} from '../../src/renderer/prepareMeshBVH';
import {invalidateInstanceTransformRanges} from '../../src/renderer/instanceTransformChanges';

function fixture() {
  const {engine, pipeline} = renderFixture();
  const mesh = new InstancedMesh(createCubeGeometry(), new OpenPBRMaterial(), {count: 1024});
  for (let i = 0; i < mesh.count; i++) mesh.transforms[i * 16 + 12] = i * 3;
  engine.scene = {meshes: [mesh], lights: []}; engine.update();
  const mirror = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0] as InstancedMesh;
  const prepared = updateMeshInstances([mirror]);
  return {engine, mesh, mirror, prepared};
}

it('selects actual changed matrix records, including edits outside the notification hint', () => {
  const {engine, mesh, mirror, prepared} = fixture();
  mesh.transforms[12] += .1; mesh.transforms[16 * 900 + 12] += .2;
  mesh.markTransformsUpdated(0, 1); engine.update();
  expect(dirtyMeshInstanceIndices(prepared.instanceBindings, new Set([mirror]), prepared.instances)).toEqual(new Set([0, 900]));
  expect(mirror.transforms[16 * 900 + 12]).toBe(mesh.transforms[16 * 900 + 12]);
  prepared.instances = updateMeshInstanceTransforms(prepared.instanceBindings, prepared.instances, new Set([0, 900]));
  mesh.markTransformsUpdated(); engine.update();
  expect(dirtyMeshInstanceIndices(prepared.instanceBindings, new Set([mirror]), prepared.instances).size).toBe(0);
  engine.dispose();
});

it('combines deferred commits, retains each engine snapshot and falls back after history eviction', () => {
  const {engine, mesh, mirror, prepared} = fixture();
  for (const index of [12, 64, 901]) { mesh.transforms[index * 16 + 13] = 1; mesh.markTransformsUpdated(index, 1); engine.update(); }
  expect(dirtyMeshInstanceIndices(prepared.instanceBindings, new Set([mirror]), prepared.instances)).toEqual(new Set([12, 64, 901]));
  for (let i = 0; i < 18; i++) { mesh.transforms[i * 16 + 14] = i + 1; mesh.markTransformsUpdated(i, 1); engine.update(); }
  expect(dirtyMeshInstanceIndices(prepared.instanceBindings, new Set([mirror]), prepared.instances).size).toBe(mesh.count);
  engine.dispose();
});

it('updates the entire batch for parent matrices, geometry bounds and replaced storage', () => {
  for (const kind of ['parent', 'geometry', 'storage']) {
    const {engine, mesh, mirror, prepared} = fixture();
    mesh.transforms[12] += .1; mesh.markTransformsUpdated(0, 1);
    if (kind === 'parent') mesh.transform[13] += 1;
    if (kind === 'storage') mesh.transforms = mesh.transforms.slice();
    if (kind === 'geometry') { mesh.geometry.position.array[0] += .1; mesh.geometry.markVerticesUpdated(); }
    engine.update();
    if (kind === 'geometry') invalidateInstanceTransformRanges(prepared.instances);
    expect(dirtyMeshInstanceIndices(prepared.instanceBindings, new Set([mirror]), prepared.instances).size).toBe(mesh.count);
    engine.dispose();
  }
});

