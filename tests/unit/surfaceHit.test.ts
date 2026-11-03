import {expect, it, vi} from 'vitest';
import {resolveSurfaceHit} from '../../src/renderer/surfaceHit';
import {renderFixture} from '../helpers/renderPipeline';
import {buildWebTLAS} from '../../src/renderer/bvhAccel';
import {updateMeshInstances} from '../../src/renderer/prepareMeshBVH';
import {aovInstanceOrder} from '../../src/renderer/aovScene';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import Engine from '../../src/Engine';
import {getGeometryBvh, setGeometryBvh} from '../../src/renderer/geometryBvh';

it('resolves reordered TLAS instances to exact uint32 source IDs and distinguishes background/invalid data', () => {
  const geometry = createCubeGeometry(), materials = [new OpenPBRMaterial(), new OpenPBRMaterial()];
  const meshes = Array.from({length: 12}, (_, i) => {
    const mesh = new Mesh(geometry, materials[i % 2]); mesh.position = [12 - i, 0, 0]; mesh.aovId = 0xfffffffe - i; return mesh;
  });
  materials[0].aovId = 0xfffffff0;
  const prepared = updateMeshInstances(meshes, {mergeAttributes: false}), tlas = buildWebTLAS(prepared.instances, prepared.blases);
  const order = aovInstanceOrder(tlas);
  for (let gpu = 0; gpu < meshes.length; gpu++) {
    const hit = resolveSurfaceHit(prepared, tlas, new Float32Array([gpu + 1, 0, 1, 0]));
    expect(hit).toEqual({object: meshes[order[gpu]].aovId, material: materials[0].aovId, instance: 0});
  }
  expect(resolveSurfaceHit(prepared, tlas, new Float32Array(4))).toBeNull();
  for (const values of [[65536, 0, 1, 0], [0, 1, 1, 0], [NaN, 0, 0, 0]]) {
    expect(resolveSurfaceHit(prepared, tlas, new Float32Array(values))).toBeUndefined();
  }
});

it('serializes picking with depth queries and rejects stale camera results', async () => {
  const {engine, camera, pipeline} = renderFixture();
  let finishDepth!: (value: Float32Array) => void, finishPick!: (value: {object: number; material: number; instance: number}) => void;
  pipeline.readDepthSamples = vi.fn(() => new Promise(resolve => {finishDepth = resolve;}));
  const pick = vi.fn(() => new Promise<{object: number; material: number; instance: number}>(resolve => {finishPick = resolve;})); pipeline.pickSurface = pick;
  const depths = engine.readDepthSamples({x: .5, y: .5, size: .1}), selection = engine._pick(.5, .5);
  expect(pick).not.toHaveBeenCalled(); finishDepth(new Float32Array(49)); await depths;
  await Promise.resolve(); expect(pick).toHaveBeenCalledOnce();
  camera.position = [1, 0, 3]; engine.update();
  finishPick({object: 42, material: 84, instance: 0}); expect(await selection).toBeUndefined();
  pipeline.pickSurface = vi.fn(async () => null); expect(await engine._pick(.5, .5)).toBeNull();
  await expect(engine._pick(-1, .5)).rejects.toThrow(RangeError);
  engine.dispose();
});

it('loads prepared BLASes without rebuilding and tolerates cache failures', async () => {
  const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement});
  const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial()), scene = {meshes: [mesh], lights: []};
  const stored: unknown[] = [];
  engine._bvhCache = {load: vi.fn(async () => undefined), store: vi.fn(async (...args) => {stored.push(args[2]);})};
  await engine.prepare(scene); const bvh = getGeometryBvh(mesh.geometry)!;
  expect(stored).toEqual([bvh]); setGeometryBvh(mesh.geometry, undefined);
  engine._bvhCache.load = vi.fn(async () => bvh);
  await engine.prepare(scene); expect(getGeometryBvh(mesh.geometry)).toBe(bvh);
  expect(engine.getDiagnostics()!.bvh!.lastBuild!.bvhTimeMs).toBe(0);
  setGeometryBvh(mesh.geometry, undefined);
  engine._bvhCache.load = vi.fn(async () => {throw Error('Unavailable');});
  engine._bvhCache.store = vi.fn(async () => {throw Error('Quota');});
  await engine.prepare(scene); expect(getGeometryBvh(mesh.geometry)!.buffer.byteLength).toBeGreaterThan(0);
  engine.dispose();
});
