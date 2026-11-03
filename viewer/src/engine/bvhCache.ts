import type {StaticBvhCache, StaticBvhCacheInput} from '../../../src/renderer/staticBvhPreparation';
import type {BvhBuildConfig} from '../../../src/renderer/geometryBvh';
import type {FlattendBVH} from '../../../src/renderer/bvhAccel';

const DIRECTORY = 'mutracer-blas-v1';
const BUDGET = 4 * 1024 ** 3;
const CHUNK = 16 * 1024 ** 2;
const layouts = ['bvh2', 'bvh4', 'bvh-gpu', 'cwbvh'];

async function digest(data: ArrayBufferView) {
  const hashes: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += CHUNK) {
    hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset + offset, Math.min(CHUNK, data.byteLength - offset)))));
  }
  const bytes = new Uint8Array(hashes.length * 32);
  hashes.forEach((hash, i) => bytes.set(hash, i * 32));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Viewer-only disk cache; bounded hashing and writes avoid cloning complete geometry/BVH payloads. */
export class ViewerBvhCache implements StaticBvhCache {
  private directory?: Promise<FileSystemDirectoryHandle | null>;
  private index?: Promise<Map<string, number>>;
  private writes: Promise<void> = Promise.resolve();
  private keys = new WeakMap<StaticBvhCacheInput, Map<string, Promise<string>>>();
  hits = 0;
  constructor(private budget = BUDGET, private open = async () => {
    if (!navigator.storage?.getDirectory) return null;
    return (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY, {create: true});
  }) {}
  private dir() {return this.directory ??= this.open().catch(() => null);}
  private key(input: StaticBvhCacheInput, config: BvhBuildConfig) {
    const settings = {builder: config.builder, layout: config.layout, spatialSplits: config.spatialSplits};
    const signature = JSON.stringify([settings, input.geometry.version]);
    let keys = this.keys.get(input);
    if (!keys) {keys = new Map(); this.keys.set(input, keys);}
    let key = keys.get(signature);
    if (!key) {
      key = (async () => {
        const {geometry, displacementScale, trianglesDisplacement} = input;
        const hashes = [await digest(geometry.position.array), await digest(geometry.indices.array)];
        if (trianglesDisplacement) hashes.push(await digest(geometry.normal.array), await digest(trianglesDisplacement));
        const descriptor = {version: 1, config: settings, positionSize: geometry.position.itemSize,
          indexType: geometry.indices.array.constructor.name, normalSize: trianglesDisplacement ? geometry.normal.itemSize : 0,
          displacementScale, hashes};
        return digest(new TextEncoder().encode(JSON.stringify(descriptor)));
      })();
      keys.set(signature, key);
    }
    return key;
  }
  async load(input: StaticBvhCacheInput, config: BvhBuildConfig) {
    const dir = await this.dir(); if (!dir) return;
    try {
      const key = await this.key(input, config), file = await (await dir.getFileHandle(key)).getFile();
      if (file.size < 4 || file.size > this.budget) return;
      const size = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
      if (size > 4096 || size + 4 > file.size) return;
      const meta = JSON.parse(await file.slice(4, size + 4).text());
      if (meta.version !== 1 || meta.key !== key || meta.builder !== config.builder || !layouts.includes(meta.layout) ||
        config.builder === 'tinybvh' && meta.layout !== config.layout ||
        !Number.isSafeInteger(meta.bytes) || meta.bytes <= 0 || meta.bytes % 16 ||
        !Number.isSafeInteger(meta.ids) || meta.ids < 0 || meta.ids % 8 ||
        !Number.isSafeInteger(meta.maxDepth) || meta.maxDepth < 0 ||
        meta.maxLeafPrimitives != null && (!Number.isSafeInteger(meta.maxLeafPrimitives) || meta.maxLeafPrimitives < 0) ||
        meta.buildSurfaceArea != null && (!Number.isFinite(meta.buildSurfaceArea) || meta.buildSurfaceArea < 0) ||
        file.size !== 4 + size + meta.bytes + meta.ids) return;
      const buffer = await file.slice(4 + size, 4 + size + meta.bytes).arrayBuffer();
      const triangleIds = meta.ids ? new Uint32Array(await file.slice(4 + size + meta.bytes).arrayBuffer()) : undefined;
      if (meta.checksum !== await digest(new Uint8Array(buffer)) ||
        meta.idsChecksum !== (triangleIds ? await digest(triangleIds) : null)) return;
      this.hits++;
      if (this.index) {const index = await this.index; index.delete(key); index.set(key, file.size);}
      return {buffer, triangleIds, builder: meta.builder, layout: meta.layout, maxDepth: meta.maxDepth,
        maxLeafPrimitives: meta.maxLeafPrimitives, buildSurfaceArea: meta.buildSurfaceArea} as FlattendBVH;
    } catch {return;}
  }
  store(input: StaticBvhCacheInput, config: BvhBuildConfig, bvh: FlattendBVH) {
    const next = this.writes.then(() => this.write(input, config, bvh));
    this.writes = next.catch(() => {});
    return next;
  }
  private async write(input: StaticBvhCacheInput, config: BvhBuildConfig, bvh: FlattendBVH) {
    const dir = await this.dir();
    if (!dir || bvh.builder !== config.builder || !bvh.buffer.byteLength || bvh.buffer.byteLength > this.budget) return;
    let stream: FileSystemWritableFileStream | undefined;
    try {
      const key = await this.key(input, config);
      const header = new TextEncoder().encode(JSON.stringify({version: 1, key, builder: bvh.builder, layout: bvh.layout ?? 'bvh2',
        maxDepth: bvh.maxDepth, maxLeafPrimitives: bvh.maxLeafPrimitives, buildSurfaceArea: bvh.buildSurfaceArea,
        bytes: bvh.buffer.byteLength, ids: bvh.triangleIds?.byteLength ?? 0,
        checksum: await digest(new Uint8Array(bvh.buffer)), idsChecksum: bvh.triangleIds ? await digest(bvh.triangleIds) : null}));
      const total = 4 + header.byteLength + bvh.buffer.byteLength + (bvh.triangleIds?.byteLength ?? 0);
      if (total > this.budget) return;
      const index = await (this.index ??= (async () => {
        const entries = new Map<string, number>();
        for await (const [name, handle] of (dir as FileSystemDirectoryHandle & {entries(): AsyncIterableIterator<[string, FileSystemHandle]>}).entries()) if (handle.kind === 'file') entries.set(name, (await (handle as FileSystemFileHandle).getFile()).size);
        return entries;
      })());
      // Evict before writing so an almost-full origin can still replace old data.
      let used = [...index.values()].reduce((a, b) => a + b, 0) - (index.get(key) ?? 0);
      for (const [name, bytes] of index) {
        if (name === key) continue;
        if (used + total <= this.budget) break;
        await dir.removeEntry(name); index.delete(name); used -= bytes;
      }
      const length = new ArrayBuffer(4);
      new DataView(length).setUint32(0, header.byteLength, true);
      stream = await (await dir.getFileHandle(key, {create: true})).createWritable();
      await stream.write(length); await stream.write(header);
      for (const data of [new Uint8Array(bvh.buffer), ...(bvh.triangleIds ? [new Uint8Array(bvh.triangleIds.buffer, bvh.triangleIds.byteOffset, bvh.triangleIds.byteLength)] : [])]) {
        for (let offset = 0; offset < data.byteLength; offset += CHUNK) await stream.write(data.subarray(offset, offset + CHUNK));
      }
      await stream.close(); index.delete(key); index.set(key, total);
    } catch {await stream?.abort().catch(() => {});}
  }
}
