import {describe, expect, it} from 'vitest';
import {AovPrimitiveCache} from '../../src/renderer/AovPrimitiveCache.js';
import {AOV_BACKGROUND_ID} from '../../src/renderer/aov.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';

function fixture() {
  const geometry = createPlaneGeometry();
  const a = Array.from(geometry.indexArray.slice(0, 3)), b = Array.from(geometry.indexArray.slice(3, 6));
  const bvh = {buffer: new Uint32Array([...b, 0, ...a, 0]).buffer, maxDepth: 0, triangleIds: undefined as Uint32Array | undefined};
  const blas = {bvh, trainglesCount: 2, verticesCount: 4};
  return {geometry, a, b, bvh, source: {blases: [blas], geometries: [geometry]}, tlas: {buffer: new ArrayBuffer(16), maxDepth: 0}};
}

const cache = () => new AovPrimitiveCache();

describe('AOV primitive identity cache', () => {
  it('preserves source triangle order and reuses the map across camera, instance and vertex updates', () => {
    const {source, tlas, geometry, bvh} = fixture(), cache = new AovPrimitiveCache();
    const first = cache.get(source, tlas);
    expect(Array.from(first)).toEqual([AOV_BACKGROUND_ID, 1, 0]);
    expect(cache.get(source, {...tlas, buffer: new ArrayBuffer(16)})).toBe(first);
    geometry.position.array[0] += .1;
    geometry.markVerticesUpdated();
    new Uint32Array(bvh.buffer)[3] = 99; // refit can edit non-index payload
    expect(cache.get(source, tlas)).toBe(first);
    expect(Array.from(cache.get(source, {...tlas, buffer: new ArrayBuffer(32)})))
      .toEqual([AOV_BACKGROUND_ID, AOV_BACKGROUND_ID, 1, 0]);
  });
  it('invalidates topology changes and replaced traversal buffers', () => {
    const {source, tlas, geometry, a, b, bvh} = fixture(), cache = new AovPrimitiveCache();
    const first = cache.get(source, tlas);
    geometry.indices!.array.set([...b, ...a]);
    geometry.markUpdated();
    const changed = cache.get(source, tlas);
    expect(changed).not.toBe(first);
    expect(Array.from(changed)).toEqual([AOV_BACKGROUND_ID, 0, 1]);
    bvh.buffer = new Uint32Array([...a, 0, ...b, 0]).buffer;
    expect(Array.from(cache.get(source, tlas))).toEqual([AOV_BACKGROUND_ID, 1, 0]);
  });
  it('uses explicit builder identities to disambiguate duplicate triangles', () => {
    const {source, tlas, geometry, a, bvh} = fixture(), cache = new AovPrimitiveCache();
    geometry.indices!.array.set([...a, ...a]); geometry.markUpdated();
    bvh.buffer = new Uint32Array([...a, 0, ...a, 0]).buffer;
    bvh.triangleIds = new Uint32Array([0, 0, 1, 1]);
    expect(Array.from(cache.get(source, tlas))).toEqual([AOV_BACKGROUND_ID, 0, 1]);
    bvh.triangleIds = new Uint32Array([0, 1, 1, 0]);
    expect(Array.from(cache.get(source, tlas))).toEqual([AOV_BACKGROUND_ID, 1, 0]);
  });
  it('matches shuffled leaf records like an exact index-triple lookup', () => {
    let seed = 7;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) >>> 0) % n;
    const triangles = 3000, indices = new Uint32Array(triangles * 3).map(() => random(400));
    indices.copyWithin(30, 0, 30); // duplicate triples keep the last source triangle
    const records = Array.from({length: triangles + 500}, (_, r) => r < triangles ? r : -1).sort(() => random(3) - 1);
    const words = new Uint32Array(records.length * 4);
    records.forEach((t, r) => words.set(t < 0 ? [random(1000), random(1000), random(1000), 0] : [...indices.subarray(t*3, t*3+3), 0], r*4));
    const geometry = createPlaneGeometry();
    geometry.indices!.array = indices; geometry.markUpdated();
    const source = {blases: [{bvh: {buffer: words.buffer, maxDepth: 0}, trainglesCount: triangles, verticesCount: 400}], geometries: [geometry]};
    const expected = new Map<string, number>();
    for (let t = 0; t < triangles; t++) expected.set(Array.from(indices.subarray(t*3, t*3+3)).join(), t);
    const ids = cache().get(source, {buffer: new ArrayBuffer(16), maxDepth: 0});
    expect(Array.from(ids.subarray(1))).toEqual(records.map((_, r) => expected.get(Array.from(words.subarray(r*4, r*4+3)).join()) ?? AOV_BACKGROUND_ID));
  });
});

