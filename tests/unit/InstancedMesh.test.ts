import {expect, it, vi} from 'vitest';
import InstancedMesh from '../../src/scene/InstancedMesh';
import Mesh from '../../src/scene/Mesh';
import Geometry, {Attribute} from '../../src/scene/Geometry';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry, createPlaneGeometry} from '../../src/util/commonGeometry';
import {renderFixture} from '../helpers/renderPipeline';
import {updateMeshInstances, updateMeshInstanceTransforms} from '../../src/renderer/prepareMeshBVH';
import {PackedMeshInstances, meshInstanceTransform, readMeshInstance, sameInstanceMembership} from '../../src/renderer/meshInstances';
import {buildTLAS, refitTLAS} from '../../src/renderer/bvhAccel';
import {MeshMembershipCache} from '../../src/renderer/meshMembership';
import {collectEmissiveTriangles, EmissiveTriangleCache} from '../../src/renderer/lightSampling';
import {mergeMeshesToGeometry} from '../../src/renderer/mergeMeshesToGeometry';

const material = () => new OpenPBRMaterial({baseColor: [.3,.5,.7]});
function batch(count = 3) {
  const mesh = new InstancedMesh(createCubeGeometry(), material(), {count});
  for (let i = 0; i < count; i++) mesh.transforms[i * 16 + 12] = i * 3;
  mesh.transform = Array.from(mesh.transform); mesh.transform[12] = .123456789123;
  return mesh;
}
function expanded(mesh: InstancedMesh) {
  return Array.from({length: mesh.count}, (_, i) => {
    const single = new Mesh(mesh.geometry, mesh.materials);
    single.transform = meshInstanceTransform(mesh, i, Array(16).fill(0)); return single;
  });
}
it('initializes identities, retains storage and validates notification ranges/counts', () => {
  const mesh = batch();
  expect([...mesh.transforms.slice(0,16)]).toEqual([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  const supplied = new Float32Array(mesh.transforms);
  expect(new InstancedMesh(mesh.geometry, mesh.materials, {count: 2, transforms: supplied}).transforms).toBe(supplied);
  expect(mesh.markTransformsUpdated(1,1)).toBe(mesh); expect(mesh.version).toBe(1);
  expect(() => mesh.markTransformsUpdated(-1)).toThrow(RangeError);
  expect(() => mesh.markTransformsUpdated(2,2)).toThrow(RangeError);
  expect(() => new InstancedMesh(mesh.geometry, mesh.materials, {count: 3, transforms: new Float32Array(32)})).toThrow(RangeError);
  expect(() => new InstancedMesh(mesh.geometry, mesh.materials, {count: 1.5})).toThrow(RangeError);
});
it('commits notified matrices once, isolates edits and keeps snapshots stable during unrelated commits', () => {
  const {engine, pipeline} = renderFixture(); const mesh = batch();
  engine.scene = {meshes: [mesh], lights: []}; engine.update();
  const committed = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0] as InstancedMesh;
  expect(committed).toBeInstanceOf(InstancedMesh); expect(committed.transforms).not.toBe(mesh.transforms);
  const storage = committed.transforms, set = vi.spyOn(storage, 'set');
  mesh.transforms[28] = 8;
  expect(engine.update()).toBe(false); expect(storage[28]).toBe(3); expect(set).not.toHaveBeenCalled();
  mesh.materials[0].baseColor = [.8,.1,.2];  engine.update();
  expect(storage[28]).toBe(3); expect(set).not.toHaveBeenCalled();
  mesh.markTransformsUpdated(1,1); expect(engine.update()).toBe(true);
  expect(committed.transforms).toBe(storage); expect(storage[28]).toBe(8); expect(set).toHaveBeenCalledOnce();
  expect(engine.update()).toBe(false);
  // Full membership capture must also leave unnotified instance elements alone.
  mesh.transforms[28] = 9; engine.scene.meshes.push(new Mesh(mesh.geometry, mesh.materials)); engine.update();
  expect(storage[28]).toBe(8); expect(set).toHaveBeenCalledOnce();
  mesh.count = 2; expect(engine.update()).toBe(true); expect(committed.count).toBe(2);
  mesh.count = 4; expect(() => engine.update()).toThrow(RangeError);
  engine.dispose();
});
it('commits both matrices and colors with one general notification', () => {
  const {engine, pipeline} = renderFixture(); const mesh = batch();
  mesh.colors = new Float32Array(mesh.count * 3).fill(1);
  engine.scene = {meshes: [mesh], lights: []}; engine.update();
  const committed = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0] as InstancedMesh;
  mesh.transforms[28] = 8; mesh.colors[3] = .2;
  expect(engine.update()).toBe(false);
  expect(mesh.markUpdated()).toBe(mesh); expect(mesh.version).toBe(1);
  expect(engine.update()).toBe(true);
  expect(committed.transforms[28]).toBe(8); expect(committed.colors![3]).toBeCloseTo(.2);
  expect(pipeline.setMeshes).toHaveBeenLastCalledWith(expect.anything(),
    expect.objectContaining({transforms:[committed], colors:[committed], geometries:[], materials:[]}));
  expect(engine.update()).toBe(false);
  engine.dispose();
});
it('supports general notifications without colors or active instances and validates before marking', () => {
  for (const count of [0, 2]) {
    const mesh = batch(count);
    expect(mesh.markUpdated()).toBe(mesh); expect(mesh.version).toBe(1);
    expect(mesh.transformsVersion).toBe(1); expect(mesh.colorsVersion).toBe(1);
    mesh.count = count + 1;
    expect(() => mesh.markUpdated()).toThrow(RangeError);
    expect(mesh.version).toBe(1); expect(mesh.transformsVersion).toBe(1); expect(mesh.colorsVersion).toBe(1);
  }
});
it('stores one binding per batch and produces exactly the expanded TLAS and flattened geometry', () => {
  const mesh = batch(7), singles = expanded(mesh);
  const packed = updateMeshInstances([mesh]), reference = updateMeshInstances(singles);
  expect(packed.instances).toBeInstanceOf(PackedMeshInstances); expect(packed.instanceBindings).toHaveLength(1);
  expect(packed.geometries).toHaveLength(1); expect(packed.instances.length).toBe(7);
  const a = buildTLAS(packed.instances, packed.blases), b = buildTLAS(reference.instances, reference.blases);
  expect(a.buffer).toEqual(b.buffer); expect(a.instancesBuffer).toEqual(b.instancesBuffer);
  const merged = mergeMeshesToGeometry([mesh]), old = mergeMeshesToGeometry(singles);
  expect(merged.geometry.position.array).toEqual(old.geometry.position.array);
  mesh.transforms[28] = 14; mesh.markTransformsUpdated(1,1);
  const next = updateMeshInstanceTransforms(packed.instanceBindings);
  refitTLAS(a, next, packed.blases);
  const rebuilt = buildTLAS(next, packed.blases);
  // Refit preserves topology; compare source record matrices to fresh preparation.
  expect(readMeshInstance(next, 1).transform[12]).toBe(14 + mesh.transform[12]);
  expect(new Float32Array(a.instancesBuffer!).every(Number.isFinite)).toBe(true);
  expect(new Float32Array(rebuilt.instancesBuffer!).every(Number.isFinite)).toBe(true);
});
it('keeps geometry materialIndex selection shared across instances', () => {
  const geometry = new Geometry({position: new Attribute(new Float32Array([0,0,0,1,0,0,0,1,0,2,0,0,3,0,0,2,1,0]),3),
    materialIndex: new Attribute(new Int32Array([0,0,0,1,1,1]),1)});
  const mesh = new InstancedMesh(geometry, [material(), material()], {count: 4});
  const prepared = updateMeshInstances([mesh]);
  expect(prepared.geometries).toHaveLength(1); expect(prepared.instances.length).toBe(4);
  expect([...prepared.geometry.materialIndex!.array.slice(0,24)]).toEqual([255,0,0,0,255,0,0,0,255,0,0,0,511,0,0,0,511,0,0,0,511,0,0,0]);
});
it('reuses BLAS/vertices when a batch shrinks, disappears and returns', () => {
  const mesh = batch(), resident = updateMeshInstances([mesh]), cache = new MeshMembershipCache(); cache.capture(resident);
  mesh.count = 1; const small = cache.update(resident, [mesh])!;
  expect(small.instances.length).toBe(1); expect(small.blases).toBe(resident.blases); expect(small.geometry).toBe(resident.geometry);
  const empty = cache.update(small, [])!; expect(empty.instances.length).toBe(0);
  mesh.count = 3; const restored = cache.update(empty, [mesh])!; expect(restored.instances.length).toBe(3);
  expect(restored.blases).toBe(resident.blases);
});
it('excludes invalid world matrices and notices source membership changes even at equal length', () => {
  const mesh = batch(); mesh.transforms[12] = NaN;
  const prepared = updateMeshInstances([mesh]); expect(prepared.instances.length).toBe(2);
  mesh.transforms[12] = 0; mesh.transforms[28] = NaN; mesh.markTransformsUpdated();
  const next = updateMeshInstanceTransforms(prepared.instanceBindings);
  expect(next.length).toBe(2); expect(sameInstanceMembership(next, prepared.instances)).toBe(false);
});
it('samples all emissive instances and invalidates the batch cache on matrix/count edits', () => {
  const mesh = new InstancedMesh(createPlaneGeometry(), new OpenPBRMaterial({emissionLuminance: 2}), {count: 2});
  mesh.transforms[28] = 3;
  const binding = {mesh, geometry: mesh.geometry, materialIndices: [0]}, cache = new EmissiveTriangleCache();
  const actual = collectEmissiveTriangles([binding], mesh.materials);
  const reference = collectEmissiveTriangles(expanded(mesh).map(single => ({...binding, mesh: single})), mesh.materials);
  expect(actual).toEqual(reference.map((triangle,i)=>({...triangle,instanceIndex:Math.floor(i/2)}))); expect(actual).toHaveLength(4);
  const first = cache.collect([binding], mesh.materials)[0];
  mesh.colors = new Float32Array(6).fill(.2); mesh.markColorsUpdated();
  expect(cache.collect([binding], mesh.materials)[0]).toBe(first);
  mesh.transforms[12] = 8; mesh.markTransformsUpdated(0,1);
  expect(cache.collect([binding], mesh.materials)[0]).not.toBe(first);
  mesh.count = 1; expect(cache.collect([binding], mesh.materials)).toHaveLength(2);
});

it('keeps explicit single-material vertex indices distinct across batches with different materials', () => {
  const geometry = createPlaneGeometry(); geometry.materialIndex = new Attribute(new Int32Array(geometry.vertexCount),1);
  const first = new InstancedMesh(geometry,material(),{count:2});
  const second = new InstancedMesh(geometry,material(),{count:2});
  const prepared = updateMeshInstances([first,second]);
  expect(prepared.geometries).toHaveLength(2); expect(prepared.instances.length).toBe(4);
  const [a,b] = prepared.geometries;
  expect(prepared.geometryRegions.get(a)!.materialIndices).toEqual([0]);
  expect(prepared.geometryRegions.get(b)!.materialIndices).toEqual([1]);
  const same = new InstancedMesh(geometry,first.materials,{count:2});
  expect(updateMeshInstances([first,same]).geometries).toHaveLength(1);
});

it('isolates separately notified batches even when they share an external transforms array', () => {
  const {engine,pipeline} = renderFixture(), a = batch();
  const b = new InstancedMesh(a.geometry,a.materials,{count:a.count,transforms:a.transforms});
  engine.scene = {meshes:[a,b],lights:[]}; engine.update();
  const committed = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0] as InstancedMesh[];
  expect(committed[0].transforms).not.toBe(committed[1].transforms);
  a.transforms[12] = 7; a.markTransformsUpdated(0,1); engine.update();
  expect(committed[0].transforms[12]).toBe(7); expect(committed[1].transforms[12]).toBe(0);
  b.markTransformsUpdated(0,1); engine.update(); expect(committed[1].transforms[12]).toBe(7);
  engine.dispose();
});

it('retains optional colors and validates color storage and notification ranges', () => {
  const mesh = batch(); expect(mesh.colors).toBeUndefined();
  const colors = new Float32Array(12);
  const colored = new InstancedMesh(mesh.geometry, mesh.materials, {count:3,colors}); expect(colored.colors).toBe(colors);
  for (const invalid of [new Float32Array(8),new Float64Array(9),[1,1,1]]) {
    expect(() => new InstancedMesh(mesh.geometry,mesh.materials,{count:3,colors:invalid as Float32Array})).toThrow(RangeError);
  }
  expect(colored.markColorsUpdated(1,2)).toBe(colored); expect(colored.version).toBe(1);
  expect(colored.transformsVersion).toBe(0); expect(colored.colorsVersion).toBe(1);
  colored.markTransformsUpdated(); expect(colored.version).toBe(2); expect(colored.colorsVersion).toBe(1);
  colored.markColorsUpdated(3,0); expect(colored.version).toBe(3);
  for (const [start,count] of [[-1,1],[1,3],[.5,1],[0,-1],[NaN,0],[0,Infinity]]) expect(() => colored.markColorsUpdated(start,count)).toThrow(RangeError);
  // Values are retained verbatim, including HDR multipliers and nonfinite values.
  colors.set([-1,2,NaN]); expect(() => colored.validate()).not.toThrow();
});

it('commits colors independently and detects replacement/removal without leaking unnotified edits', () => {
  const {engine,pipeline} = renderFixture(), a = batch(); a.colors = new Float32Array(9).fill(.5);
  const b = new InstancedMesh(a.geometry,a.materials,{count:3,colors:a.colors});
  engine.scene = {meshes:[a,b],lights:[]}; engine.update();
  const [ca,cb] = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0] as InstancedMesh[];
  const colorStorage = ca.colors!, transformStorage = ca.transforms, copyTransform = vi.spyOn(transformStorage,'set');
  expect(ca.colors).not.toBe(cb.colors); a.colors[3] = .2; a.transforms[12] = 20;
  expect(engine.update()).toBe(false);
  a.materials[0].baseColor[0] = .4; engine.update(); expect(ca.colors![3]).toBe(.5);
  engine.scene.meshes.push(new Mesh(a.geometry,a.materials)); engine.update(); expect(ca.colors![3]).toBe(.5);
  a.markColorsUpdated(1,1); engine.update();
  expect(ca.colors).toBe(colorStorage); expect(ca.colors![3]).toBeCloseTo(.2); expect(cb.colors![3]).toBe(.5);
  expect(ca.transforms[12]).toBe(0); expect(copyTransform).not.toHaveBeenCalled();
  expect(pipeline.setMeshes).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({transforms:[],colors:[ca],geometries:[],materials:[]}));
  b.markColorsUpdated(); engine.update(); expect(cb.colors![3]).toBeCloseTo(.2);
  a.colors = new Float32Array(9).fill(.8); engine.update(); expect(ca.colors![0]).toBeCloseTo(.8);
  expect(ca.colors).not.toBe(colorStorage);
  const replaced = ca.colors;
  a.colors = new Float32Array(9).fill(.3); engine.scene.meshes = [...engine.scene.meshes]; engine.update();
  expect(ca.colors).not.toBe(replaced); expect(ca.colors![0]).toBeCloseTo(.3);
  expect(ca.colorsVersion).toBe(a.colorsVersion);
  a.colors = undefined; engine.update(); expect(ca.colors).toBeUndefined();
  a.markTransformsUpdated(); engine.update(); expect(ca.transforms[12]).toBe(20); expect(ca.colors).toBeUndefined();
  engine.dispose();
});

it('packs vec4 9 as colors and uploads only color ranges without refitting either BVH', async () => {
  const {INSTANCE_VEC4_STRIDE,INSTANCE_WORD_STRIDE,updateTLASInstanceColors} = await import('../../src/renderer/bvhAccel');
  const {updateMeshInstanceColors} = await import('../../src/renderer/prepareMeshBVH');
  const a = batch(), plain = new Mesh(a.geometry,a.materials), uncolored = batch(1);
  a.colors = new Float32Array([.2,.3,.4,.5,.6,.7,.8,.9,1]);
  a.transforms[12] = NaN; // Packed slots must still map to source instance indices.
  const prepared = updateMeshInstances([plain,a,uncolored]), packed = prepared.instances as PackedMeshInstances;
  expect(INSTANCE_VEC4_STRIDE).toBe(10); expect(INSTANCE_WORD_STRIDE).toBe(40);
  expect(packed.colors.slice(0,packed.length * 3)).toEqual(new Float32Array([1,1,1,.5,.6,.7,.8,.9,1,1,1,1]));
  const tlas = buildTLAS(packed,prepared.blases), before = new Uint8Array(tlas.instancesBuffer!).slice();
  const bounds = tlas.buffer.slice(0), blas = prepared.blases.map(b=>b.bvh.buffer.slice(0)), matrices=packed.transforms.slice();
  a.colors[3] = .1;
  const dirty = updateMeshInstanceColors(prepared.instanceBindings,packed,new Set([a])); expect([...dirty]).toEqual([1,2]);
  const ranges=updateTLASInstanceColors(tlas,packed,dirty);
  expect(ranges).toHaveLength(2); expect(ranges.every(r=>r.size===16 && r.offset%160===144)).toBe(true);
  const after=new Uint8Array(tlas.instancesBuffer!);
  for(let i=0;i<after.length;i++) if(!ranges.some(r=>i>=r.offset&&i<r.offset+r.size)) expect(after[i]).toBe(before[i]);
  expect(after).not.toEqual(before); expect(tlas.buffer).toEqual(bounds); expect(packed.transforms).toEqual(matrices);
  prepared.blases.forEach((b,i)=>expect(b.bvh.buffer).toEqual(blas[i]));
  a.colors = undefined; updateMeshInstanceColors(prepared.instanceBindings,packed,new Set([a]));
  updateTLASInstanceColors(tlas,packed,dirty);
  const data=new Float32Array(tlas.instancesBuffer!);
  for(let i=0;i<packed.length;i++) expect([...data.slice(i*40+36,i*40+40)]).toEqual([1,1,1,0]);
});
