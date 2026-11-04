import {expect, it} from 'vitest';
import {decodeGeometry} from '../../native/src/scene-records.js';
import {GEOMETRY as G} from '../../native/src/layout.js';

it('preserves descriptor spans in full preparation and isolates mutable sync geometry', () => {
  // Include a nonzero descriptor byteOffset and unrelated words around payloads.
  const storage = new Uint32Array(200), u = storage.subarray(7, 190);
  const f = new Float32Array(u.buffer, u.byteOffset, u.length);
  u[G.VERTEX_COUNT] = u[G.INDEX_COUNT] = 3;
  let at = G.WORDS;
  for (const [field, data] of [
    [G.POSITION, [0,0,0, 1,0,0, 0,1,0]], [G.NORMAL, [0,0,1, 0,0,1, 0,0,1]],
    [G.UV, [0,0, 1,0, 0,1]], [G.UV1, [0,1, 1,1, 0,0]],
    [G.COLOR, [1,0,0, 0,1,0, 0,0,1]], [G.TANGENT, [1,0,0,1, 1,0,0,1, 1,0,0,1]],
  ] as [number, number[]][]) {u[field] = at; f.set(data, at); at += data.length;}
  u[G.INDICES] = at; u.set([0,1,2], at); at += 3;
  u[G.MATERIAL_INDEX] = at; u.set([0,1,2], at);
  const retained = decodeGeometry(u, f, 0, undefined, true);
  const synced = decodeGeometry(u, f, 0, undefined);
  for (const key of ['position','normal','uv','uv1','color','tangent','materialIndex','indices'] as const) {
    expect(retained[key]?.array).toEqual(synced[key]?.array);
  }
  expect(retained.position.array.byteOffset).toBe(u.byteOffset + u[G.POSITION] * 4);
  expect(retained.position.array.length).toBe(9);
  expect(retained.indexArray.byteLength).toBe(12);
  f[u[G.POSITION]] = 7;
  expect(retained.position.array[0]).toBe(7);
  expect(synced.position.array[0]).toBe(0);
  synced.position.array[0] = -2;
  expect(f[u[G.POSITION]]).toBe(7);
});
