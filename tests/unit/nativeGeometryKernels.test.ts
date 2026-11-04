import {expect, it} from 'vitest';
import {generateVertexNormals, generateVertexTangents} from '../../src/util/geometry.js';
import Geometry, {Attribute} from '../../src/scene/Geometry.js';
import {encodeGeometryKernelHints, receiveGeometryKernelHints, takeGeometryKernelHints,
  geometryKernelBounds, rememberKernelBounds} from '../../native/src/geometry-kernel-hints.js';
import {GEOMETRY_KERNEL_HEADER as H, GEOMETRY_KERNEL_ENTRY as E} from '../../native/src/layout.js';

it('owns kernel results, consumes each token once, and rejects overlapping payloads', () => {
  const bounds = new Float32Array([-1, -2, -3, 4, 5, 6]);
  const tangents = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const packet = encodeGeometryKernelHints([{vertexCount: 3, bounds, tangents}], [3]);
  expect(new Uint32Array(receiveGeometryKernelHints(packet, 72).buffer)[0]).toBe(1);
  packet.fill(0);
  const result = takeGeometryKernelHints(72)!;
  expect(result[0].bounds).toEqual(bounds);
  expect(result[0].tangents).toEqual(tangents);
  expect(takeGeometryKernelHints(72)).toBeUndefined();
  const invalid = encodeGeometryKernelHints([{vertexCount: 3, bounds, tangents}], [3]);
  const u = new Uint32Array(invalid.buffer);
  u[H.WORDS + E.TANGENTS] = u[H.WORDS + E.BOUNDS];
  expect(new Uint32Array(receiveGeometryKernelHints(invalid, 72).buffer)[0]).toBe(2);
  expect(takeGeometryKernelHints(72)).toBeUndefined();
});

it('invalidates initial kernel bounds after a vertex notification', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const geometry = new Geometry({position: new Attribute(positions, 3)});
  rememberKernelBounds(geometry, new Float32Array([0, 0, 0, 1, 1, 0]));
  expect([...geometryKernelBounds(geometry)[1]]).toEqual([1, 1, 0]);
  positions[0] = -5;
  geometry.markVerticesUpdated();
  expect([...geometryKernelBounds(geometry)[0]]).toEqual([-5, 0, 0]);
});

it('retains public index identity and refreshes the Uint32 copy on topology changes', () => {
  const source = new Uint16Array([0, 1, 2]);
  const geometry = new Geometry({position: new Attribute(new Float32Array(9), 3), indices: new Attribute(source, 1)});
  const first = geometry.indexArray;
  expect(geometry.indices.array).toBe(source);
  expect(first).toBeInstanceOf(Uint32Array);
  expect(geometry.indexArray).toBe(first);
  geometry.markVerticesUpdated();
  expect(geometry.indexArray).toBe(first);
  source.set([2, 1, 0]);
  geometry.markUpdated();
  expect([...geometry.indexArray]).toEqual([2, 1, 0]);
  expect(geometry.indexArray).not.toBe(first);
  const direct = new Uint32Array([1, 0, 2]);
  geometry.indices = new Attribute(direct, 1);
  expect(geometry.indexArray).toBe(direct);
});

it('uses edited Uint16 indices in public normal/tangent helpers before renderer notification', () => {
  const position = new Attribute(new Float32Array([0,0,0, 1,0,0, 0,1,0, 1,1,1]), 3);
  const source = new Uint16Array([0,1,2]);
  const geometry = new Geometry({position, indices:new Attribute(source,1)});
  void geometry.indexArray;
  source.set([0,2,1]);
  generateVertexNormals(geometry);
  expect(geometry.normal.array[2]).toBe(-1);
  const normal = new Attribute(new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]),3);
  const uv = new Attribute(new Float32Array([0,0, 1,0, 0,1, 1,0]),2);
  geometry.normal=normal; geometry.uv=uv;
  source.set([0,3,2]);
  generateVertexTangents(geometry);
  const reference=new Geometry({position,normal,uv,indices:new Attribute(new Uint32Array(source),1)});
  generateVertexTangents(reference);
  expect(geometry.tangent!.array).toEqual(reference.tangent!.array);
  expect(geometry.tangent!.array[1]).toBeGreaterThan(.7);
  expect(geometry.topologyVersion).toBe(0);
});


it('accepts kernel hints for scenes beyond the old 4096 geometry ceiling', () => {
  const count = 7626;
  const packet = encodeGeometryKernelHints(Array.from({length: count}, () => ({vertexCount: 3,
    bounds: new Float32Array([0, 0, 0, 1, 1, 0]), tangents: undefined})), new Array(count).fill(3));
  expect(new Uint32Array(receiveGeometryKernelHints(packet, 73).buffer)[0]).toBe(1);
  const hints = takeGeometryKernelHints(73)!;
  expect(hints).toHaveLength(count);
  expect(hints[count - 1].bounds).toEqual(new Float32Array([0, 0, 0, 1, 1, 0]));
});

it('retains owned AOT tangent views after consuming their hint token', () => {
  const values = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
  let packet = encodeGeometryKernelHints([{vertexCount:3, bounds:undefined, tangents:values}], [3]);
  expect(new Uint32Array(receiveGeometryKernelHints(packet, 74, true).buffer)[0]).toBe(1);
  const hint = takeGeometryKernelHints(74)![0];
  expect(hint.tangents!.buffer).toBe(packet.buffer);
  packet = new Uint8Array(0);
  expect(hint.tangents).toEqual(values);
  expect(takeGeometryKernelHints(74)).toBeUndefined();
});
