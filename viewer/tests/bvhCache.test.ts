import {webcrypto} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import {ViewerBvhCache} from '../src/engine/bvhCache';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import {buildBLAS} from '../../src/renderer/bvhAccel';
import type {BvhBuildConfig} from '../../src/renderer/geometryBvh';
vi.stubGlobal('crypto', webcrypto);
const config: BvhBuildConfig = {builder: 'builtin', layout: 'bvh2', spatialSplits: false};
afterEach(() => vi.restoreAllMocks());

function filesystem() {
  const files = new Map<string, Blob>(); let fail = false;
  const dir = {
    async getFileHandle(name: string, options?: {create?: boolean}) {
      if (!files.has(name) && !options?.create) throw Error('Missing');
      return {kind: 'file', getFile: async () => files.get(name), createWritable: async () => {
        const chunks: BlobPart[] = [];
        return {write: async (data: BlobPart) => {if (fail) throw Error('Quota'); chunks.push(data instanceof ArrayBuffer ? data.slice(0) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : data);},
          close: async () => {files.set(name, new Blob(chunks));}, abort: async () => {}};
      }};
    },
    async *entries() {for (const name of files.keys()) yield [name, await dir.getFileHandle(name)] as const;},
    async removeEntry(name: string) {files.delete(name);}
  };
  return {files, fail: () => {fail = true;}, open: async () => dir as unknown as FileSystemDirectoryHandle};
}
function input(x = 0) {
  const geometry = createCubeGeometry();
  for (let i = 0; i < geometry.position.array.length; i += 3) geometry.position.array[i] += x;
  return {geometry, displacementScale: 0, trianglesDisplacement: undefined};
}

it('restores exact BLAS metadata/bytes across cache instances and distinguishes geometry/configuration', async () => {
  const fs = filesystem(), original = input(), bvh = buildBLAS(original.geometry);
  bvh.triangleIds = new Uint32Array([2, 1]);
  await new ViewerBvhCache(undefined, fs.open).store(original, config, bvh);
  const cache = new ViewerBvhCache(undefined, fs.open), restored = await cache.load(input(), config);
  expect(restored).toEqual(bvh); expect(cache.hits).toBe(1);
  expect(await cache.load(input(1), config)).toBeUndefined();
  expect(await cache.load(input(), {...config, spatialSplits: true})).toBeUndefined();
  expect(await cache.load(original, {...config, spatialSplits: true})).toBeUndefined();
  original.geometry.position.array[0] += .1; original.geometry.markUpdated();
  expect(await cache.load(original, config)).toBeUndefined();
  expect(await cache.load(input(), {...config, builder: 'tinybvh'})).toBeUndefined();
});

it('keys displacement height, ranges and normal changes while ignoring shading-only normals', async () => {
  const fs = filesystem(), cache = new ViewerBvhCache(undefined, fs.open), a = input();
  await cache.store(a, config, buildBLAS(a.geometry));
  const normalEdit = input(); normalEdit.geometry.normal.array.fill(0);
  expect(await cache.load(normalEdit, config)).toBeDefined();
  const displaced = {...input(), displacementScale: .2, trianglesDisplacement: new Float32Array(24).fill(.5)};
  await cache.store(displaced, config, buildBLAS(displaced.geometry, displaced.displacementScale, displaced.trianglesDisplacement));
  expect(await cache.load({...input(), displacementScale: .2, trianglesDisplacement: displaced.trianglesDisplacement.slice()}, config)).toBeDefined();
  expect(await cache.load({...input(), displacementScale: .3, trianglesDisplacement: displaced.trianglesDisplacement.slice()}, config)).toBeUndefined();
  const n = input(); n.geometry.normal.array.fill(0);
  expect(await cache.load({...n, displacementScale: .2, trianglesDisplacement: displaced.trianglesDisplacement.slice()}, config)).toBeUndefined();
});

it('rejects truncated and corrupted payloads and treats storage failures as optional', async () => {
  const fs = filesystem(), a = input(), bvh = buildBLAS(a.geometry), cache = new ViewerBvhCache(undefined, fs.open);
  await cache.store(a, config, bvh);
  const [name, blob] = [...fs.files][0];
  fs.files.set(name, blob.slice(0, blob.size - 1));
  expect(await cache.load(input(), config)).toBeUndefined();
  const bytes = new Uint8Array(await blob.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
  fs.files.set(name, new Blob([bytes])); expect(await cache.load(input(), config)).toBeUndefined();
  fs.fail(); await expect(cache.store(input(1), config, bvh)).resolves.toBeUndefined();
  const absent = new ViewerBvhCache(undefined, async () => {throw Error('Denied');});
  await expect(absent.store(input(), config, bvh)).resolves.toBeUndefined();
  expect(await absent.load(input(), config)).toBeUndefined();
});

it('serializes writes and evicts old BLASes within the persistent budget', async () => {
  const fs = filesystem(), first = input(), bvh = buildBLAS(first.geometry);
  await new ViewerBvhCache(undefined, fs.open).store(first, config, bvh);
  const budget = [...fs.files.values()][0].size + 64;
  const cache = new ViewerBvhCache(budget, fs.open);
  await Promise.all([1, 2, 3].map(x => {const a = input(x); return cache.store(a, config, buildBLAS(a.geometry));}));
  expect([...fs.files.values()].reduce((sum, blob) => sum + blob.size, 0)).toBeLessThanOrEqual(budget);
  expect(await cache.load(input(), config)).toBeUndefined();
  expect(await cache.load(input(3), config)).toBeDefined();
});
