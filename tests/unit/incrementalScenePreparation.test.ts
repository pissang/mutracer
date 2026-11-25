import {expect, it} from 'vitest';
import Geometry, {Attribute} from '../../src/scene/Geometry.js';
import MeshState from '../../src/scene/MeshState.js';
import InstanceState from '../../src/scene/InstanceState.js';
import MaterialState from '../../src/scene/MaterialState.js';
import {prepareSceneMeshes, updateMeshInstanceTransforms, dirtyPreparedInstanceIndices} from '../../src/renderer/scenePreparation.js';
import {computeGeometryBounds} from '../../src/renderer/geometryBvhBounds.js';
import {PackedMeshInstances} from '../../src/renderer/packedMeshInstances.js';
import {buildBLAS, buildTLAS, buildWebTLAS, copyTLASForRefit, refitTLAS, packLinearInstances, refitLinearInstances, refitBLAS} from '../../src/renderer/bvhAccel.js';
import {setGeometryBvh} from '../../src/renderer/geometryBvh.js';
import {updatePreparedGeometries} from '../../src/renderer/geometryUpdates.js';
import {quantizeDisplacementRange} from '../../src/renderer/displacementRange.js';

function scene(software = true) {
  const geometry = new Geometry({position: new Attribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]),3)});
  const material = new MaterialState(), batch = new MeshState(geometry,material), other = new MeshState(geometry,material);
  const instances = new InstanceState({count:3}); batch.setInstanceState(instances); other.transform[12]=10;
  if(software)setGeometryBvh(geometry,buildBLAS(geometry));
  const prepared = prepareSceneMeshes([batch,other],mesh=>({geometry:mesh.geometry,displacementScale:0}),computeGeometryBounds,software);
  return {geometry,batch,other,instances,prepared};
}
it('scans shared geometry once per preparation and keeps retained bounds independent', () => {
  const {geometry,batch,other}=scene(false);
  let scans=0;
  const prepare=()=>prepareSceneMeshes([batch,other],mesh=>({geometry:mesh.geometry,displacementScale:0}),g=>{
    scans++;
    return computeGeometryBounds(g);
  },false);
  const first=prepare();
  expect(scans).toBe(1);
  first.instanceBindings[0].bvhBounds[0][0]=-100;
  expect(first.instanceBindings[1].bvhBounds[0][0]).toBe(0);
  geometry.position.array[0]=-.5;geometry.markVerticesUpdated();
  const next=prepare();
  expect(scans).toBe(2);
  expect(next.instanceBindings.every(b=>b.bvhBounds[0][0]===-.5)).toBe(true);
});
it('recomputes only dirty packed transforms and preserves the previous candidate',()=>{
  const {batch,instances,prepared} = scene();
  const before=prepared.instances as PackedMeshInstances, saved=before.transforms.slice();
  instances.transforms[16+12]=4;
  const allDirty=dirtyPreparedInstanceIndices(prepared.instanceBindings,new Set([batch]),before);
  expect([...allDirty]).toEqual([0,1,2]);
  const next=updateMeshInstanceTransforms(prepared.instanceBindings,before,new Set([1])) as PackedMeshInstances;
  const full=updateMeshInstanceTransforms(prepared.instanceBindings) as PackedMeshInstances;
  expect(next.transforms).toEqual(full.transforms);expect(next.bounds).toEqual(full.bounds);
  expect(before.transforms).toEqual(saved);expect(next.bindingSlots).toBe(before.bindingSlots);
  instances.count=2;
  const removed=updateMeshInstanceTransforms(prepared.instanceBindings,next,new Set([1])) as PackedMeshInstances;
  expect(removed.length).toBe(3);expect([...removed.sourceIndices.subarray(0,removed.length)]).toEqual([0,1,2]);
});
it('writes the same linear instance bytes from dirty spans as full packing',()=>{
  const {prepared,instances} = scene(false);
  const buffer=packLinearInstances(prepared.instances,[0],[0]), previous=new Uint8Array(buffer).slice();
  instances.transforms[16+12]=4;
  const next=updateMeshInstanceTransforms(prepared.instanceBindings,prepared.instances,new Set([1]));
  const ranges=refitLinearInstances(buffer,next,[0],[0],new Set([1]));
  expect(ranges).toEqual([{offset:160,size:160}]);expect(buffer).toEqual(packLinearInstances(next,[0],[0]));
  expect(new Uint8Array(buffer).subarray(0,160)).toEqual(previous.subarray(0,160));
});
it.each([buildTLAS, buildWebTLAS])('refits a transactional TLAS using dirty slots and preserves its accepted buffers (%s)',build=>{
  const {prepared,instances}=scene();
  const accepted=build(prepared.instances,prepared.blases), before=new Uint8Array(accepted.buffer).slice();
  instances.transforms[16+12]=4;
  const next=updateMeshInstanceTransforms(prepared.instanceBindings,prepared.instances,new Set([1]));
  const candidate=copyTLASForRefit(accepted), full=copyTLASForRefit(accepted);
  const writes=refitTLAS(candidate,next,prepared.blases,new Set([1]));refitTLAS(full,next,prepared.blases);
  expect(candidate.buffer).toEqual(full.buffer);expect(candidate.instancesBuffer).toEqual(full.instancesBuffer);
  expect(new Uint8Array(accepted.buffer)).toEqual(before);expect(writes.instanceRanges.reduce((n,r)=>n+r.size,0)).toBe(160);
});
it('copies changed hardware attributes and bounds without requiring software BLAS data',()=>{
  const {geometry,prepared}=scene(false), merged=prepared.geometry;
  geometry.position.array[0]=-.5;geometry.markVerticesUpdated();
  const update=updatePreparedGeometries(prepared,new Set([geometry]),{softwareBvhs:false});
  expect(prepared.geometry).toBe(merged);expect(merged.position.array[0]).toBe(-.5);
  expect(update.blases).toEqual([]);expect(update.vertices).toHaveLength(1);
  expect(prepared.instanceBindings.every(b=>b.bvhBounds[0][0]===-.5)).toBe(true);
});
it('refits displacement leaf bounds and packed ranges without changing primitive identities',()=>{
  const {geometry}=scene(false), original=buildBLAS(geometry,.5,new Float32Array([0,1]));
  const bvh={...original,buffer:original.buffer.slice(0)}, words=new Int32Array(bvh.buffer);
  const identity=Array.from(words.subarray(8,11));
  geometry.position.array[0]=-.25;
  expect(refitBLAS(bvh,geometry,{normal:geometry.normal.array,scale:.5,ranges:new Float32Array([.25,.75])})).toBe(true);
  expect(Array.from(words.subarray(8,11))).toEqual(identity);expect(words[11]).toBe(quantizeDisplacementRange(.25,.75));
  const bounds=new Float32Array(bvh.buffer);expect(bounds[0]).toBe(-.25);expect(bounds[2]).toBe(.125);expect(bounds[6]).toBe(.375);
});

it('keeps distinct displacement ranges for duplicate source triangles', () => {
  const {geometry} = scene(false);
  geometry.indices = new Attribute(new Uint32Array([0,1,2, 0,1,2]), 1);
  const bvh = buildBLAS(geometry, .5, new Float32Array([0,.25, .75,1]));
  const ranges = new Float32Array([.125,.375, .625,.875]);
  expect(refitBLAS(bvh, geometry, {normal:geometry.normal.array, 
    scale:.5, ranges})).toBe(true);
  const words = new Int32Array(bvh.buffer), ids = bvh.triangleIds!;
  expect(ids.length).toBe(4);
  for (let i = 0; i < ids.length; i += 2) {
    const source = ids[i + 1];
    expect(words[ids[i] * 4 + 3]).toBe(quantizeDisplacementRange(ranges[source * 2], ranges[source * 2 + 1]));
  }
});
