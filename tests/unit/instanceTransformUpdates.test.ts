import {expect, it, vi} from 'vitest';
import InstancedMesh from '../../src/scene/InstancedMesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import {renderFixture} from '../helpers/renderPipeline';
import {updateMeshInstances, updateMeshInstanceTransforms, dirtyMeshInstanceIndices} from '../../src/renderer/prepareMeshBVH';
import {invalidateInstanceTransformRanges} from '../../src/renderer/instanceTransformChanges';
import {buildWebTLAS, copyTLASForRefit, refitTLAS} from '../../src/renderer/bvhAccel';

function fixture() {
  const {engine, pipeline} = renderFixture();
  const mesh = new InstancedMesh(createCubeGeometry(), new OpenPBRMaterial(), {count: 1024});
  for (let i = 0; i < mesh.count; i++) mesh.transforms[i * 16 + 12] = i * 3;
  engine.scene = {meshes: [mesh], lights: []}; engine.update();
  const mirror = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0] as InstancedMesh;
  const prepared = updateMeshInstances([mirror]);
  return {engine, pipeline, mesh, mirror, prepared};
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

it.each([1, 64, 128, 512, 1024])('dense and sparse refits produce identical buffers after %i changes', count => {
  const {engine, pipeline, mesh, mirror, prepared} = fixture();
  const initial = buildWebTLAS(prepared.instances, prepared.blases);
  const sparse = copyTLASForRefit(initial), dense = copyTLASForRefit(initial);
  for (let i = 0; i < count; i++) mesh.transforms[i * 16 + 13] = (i % 11) * .05;
  mesh.markTransformsUpdated(0, count); engine.update();
  expect(pipeline.setMeshes).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({transforms: [mirror], geometries: []}));
  expect(prepared.instanceBindings[0].mesh).toBe(mirror);
  const dirty = dirtyMeshInstanceIndices(prepared.instanceBindings, new Set([mirror]), prepared.instances);
  const next = updateMeshInstanceTransforms(prepared.instanceBindings, prepared.instances, dirty);
  refitTLAS(sparse, next, prepared.blases, dirty);
  const uploads = refitTLAS(dense, next, prepared.blases, dirty, true);
  expect(dense.buffer).toEqual(sparse.buffer); expect(dense.instancesBuffer).toEqual(sparse.instancesBuffer);
  expect(initial.buffer).not.toBe(dense.buffer);
  if (count >= 512) { expect(uploads.tlasRanges).toHaveLength(1); expect(uploads.instanceRanges).toHaveLength(1); }
  engine.dispose();
});

it.each(['webgpu', 'webgl'] as const)('%s restores a batch when all its matrices were excluded', async backend => {
  const {default: WGPURayTracePass} = await import('../../src/renderer/WGPURayTracePass');
  const {default: WebGLRayTracePass} = await import('../../src/renderer/WebGLRayTracePass');
  const mesh = new InstancedMesh(createCubeGeometry(), new OpenPBRMaterial(), {count: 3});
  const identities = mesh.transforms.slice(); mesh.transforms.fill(NaN); mesh.markTransformsUpdated();
  const prepared = updateMeshInstances([mesh]); expect(prepared.instances.length).toBe(0);
  const pass = Object.create((backend === 'webgpu' ? WGPURayTracePass : WebGLRayTracePass).prototype) as any;
  const upload = vi.fn(() => false), membership = vi.fn();
  Object.assign(pass, {_preparedMeshData: prepared, _tlas: buildWebTLAS(prepared.instances, prepared.blases),
    _dirtyTransformMeshes: new Set([mesh]), _needsRefitTLAS: true, _bvhBuffer: {}, _instancesBuffer: {},
    _uploadBVH: upload, _updateMeshMembership: membership, _emissiveCache: {collect: () => []},
    _rtUniform: {views: {isEmpty: new Uint32Array([1])}}});
  mesh.transforms.set(identities); mesh.markTransformsUpdated(); pass._refitMeshInstances();
  expect(prepared.instances.length).toBe(3); expect(pass._needsRefitTLAS).toBe(false);
  expect(backend === 'webgpu' ? upload : membership).toHaveBeenCalledOnce();
});
