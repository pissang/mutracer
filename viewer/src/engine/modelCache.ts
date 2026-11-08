import type {GraphArchive} from './materialxGraphArchive';
import type { TextureWrapMode } from '@meimu/mutracer';
import type { ModelSource } from './loadModel';
import { DISPLACEMENT_PROJECTIONS, MATERIAL_KEYS, TEXTURE_KEYS, type MaterialValues, type TextureKey } from './materialParams';

export interface ModelMeta {
  name: string;
  presetId: string | null;
  credit: string | null;
  sourceUrl: string | null;
}

export interface CachedModel {
  id: string;
  meta: ModelMeta;
  /** Procedural presets have no files. */
  source?: ModelSource;
}

const DIRECTORY = 'mutracer-model-v1';
const CURRENT = 'current.model';
// One archive keeps replacement atomic and avoids retaining old dependencies.
// Serialize reads/writes within this viewer so an earlier write cannot win.
let pending: Promise<unknown> = Promise.resolve();
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = pending.then(run, run);
  pending = next.catch(() => {});
  return next;
}

async function directory() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create: true });
}

/** Storage failures are optional; they never stop model loading. */
export function saveModelCache(model: CachedModel): Promise<void> {
  return enqueue(async () => {
    let dir: FileSystemDirectoryHandle | null = null;
    let writable: FileSystemWritableFileStream | undefined;
    try {
      dir = await directory();
      if (!dir) return;
      const source = model.source;
      const header = new TextEncoder().encode(JSON.stringify({
        version: 1, id: model.id, meta: model.meta,
        source: source && {
          mainPath: source.mainPath, base: source.base,
          files: source.files.map(({ file, path }) => ({ path, name: file.name, type: file.type, size: file.size, lastModified: file.lastModified }))
        }
      }));
      const length = new ArrayBuffer(4);
      new DataView(length).setUint32(0, header.byteLength, true);
      const handle = await dir.getFileHandle(CURRENT, { create: true });
      writable = await handle.createWritable();
      await writable.write(new Blob([length, header, ...(source?.files.map(({ file }) => file) ?? [])]));
      await writable.close();
    } catch {
      await writable?.abort().catch(() => {});
      // Never restore the previous model after a replacement failed to persist.
      await dir?.removeEntry(CURRENT).catch(() => {});
    }
  });
}

export function readModelCache(): Promise<CachedModel | null> {
  return enqueue(async () => {
    try {
      const dir = await directory();
      if (!dir) return null;
      const file = await (await dir.getFileHandle(CURRENT)).getFile();
      const length = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
      if (length > 4 * 1024 * 1024 || length + 4 > file.size) return null;
      const header = JSON.parse(await file.slice(4, 4 + length).text());
      if (header.version !== 1 || typeof header.id !== 'string' || typeof header.meta?.name !== 'string') return null;
      for (const key of ['presetId', 'credit', 'sourceUrl']) {
        if (header.meta[key] !== null && typeof header.meta[key] !== 'string') return null;
      }
      let source: ModelSource | undefined;
      let offset = 4 + length;
      if (header.source) {
        const data = header.source;
        if (typeof data.mainPath !== 'string' || typeof data.base !== 'string' || !Array.isArray(data.files)) return null;
        source = { mainPath: data.mainPath, base: data.base, files: [] };
        for (const entry of data.files) {
          if (typeof entry.path !== 'string' || typeof entry.name !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 || offset + entry.size > file.size) return null;
          source.files.push({
            path: entry.path,
            file: new File([file.slice(offset, offset + entry.size)], entry.name, { type: entry.type, lastModified: entry.lastModified })
          });
          offset += entry.size;
        }
        if (!source.files.some(({ path }) => path === source!.mainPath)) return null;
      } else if (!header.meta.presetId) return null;
      if (offset !== file.size) return null;
      return { id: header.id, meta: header.meta, source };
    } catch {
      return null;
    }
  });
}

export function clearModelCache(): Promise<void> {
  return enqueue(async () => {
    try { await (await directory())?.removeEntry(CURRENT); } catch { /* Best effort. */ }
  });
}

/** Material edits of the cached model; uploaded textures keep their original files. */
export interface MaterialEdit {
  graph?:GraphArchive|null;
  /** Position of the material in the model's traversal order. */
  index: number;
  name: string;
  values: MaterialValues;
  /** `null` removes the loaded texture from the slot. */
  textures: { slot: TextureKey; file: Blob | null; transform?: TextureTransform }[];
  sampling?: Partial<Record<TextureKey, TextureSampling>>;
}

export interface TextureSampling {
  uvScale: [number, number];
  wrapS: TextureWrapMode;
  wrapT: TextureWrapMode;
}

/** UV repeat and orientation of an imported texture; uploads otherwise follow the texture they replace. */
export interface TextureTransform {
  uvScale: [number, number];
  flipY: boolean;
}

function readTransform(value: unknown): TextureTransform | undefined {
  const t = value as Partial<TextureTransform> | undefined;
  if (!t || !Array.isArray(t.uvScale) || t.uvScale.length !== 2 || !t.uvScale.every(Number.isFinite) ||
    typeof t.flipY !== 'boolean') return undefined;
  return { uvScale: [t.uvScale[0], t.uvScale[1]], flipY: t.flipY };
}

function readSampling(value: unknown): MaterialEdit['sampling'] {
  if (!value || typeof value !== 'object') return undefined;
  const sampling: NonNullable<MaterialEdit['sampling']> = {};
  const wraps = ['repeat','clamp-to-edge','mirrored-repeat'];
  for (const [slot, raw] of Object.entries(value)) {
    const item = raw as TextureSampling | undefined;
    if (!TEXTURE_KEYS.includes(slot as TextureKey) || !item || !Array.isArray(item.uvScale) ||
      item.uvScale.length !== 2 || !item.uvScale.every(Number.isFinite) || !wraps.includes(item.wrapS) || !wraps.includes(item.wrapT)) continue;
    sampling[slot as TextureKey] = {uvScale:[...item.uvScale], wrapS:item.wrapS, wrapT:item.wrapT};
  }
  return Object.keys(sampling).length ? sampling : undefined;
}

export interface MaterialEdits {
  modelId: string;
  materials: MaterialEdit[];
}

const EDITS = 'materials.edits';

export function saveMaterialEdits(edits: MaterialEdits): Promise<void> {
  return enqueue(async () => {
    let dir: FileSystemDirectoryHandle | null = null;
    let writable: FileSystemWritableFileStream | undefined;
    try {
      dir = await directory();
      if (!dir) return;
      if (!edits.materials.length) {
        await dir.removeEntry(EDITS).catch(() => {});
        return;
      }
      const blobs: Blob[] = [];
      const header = new TextEncoder().encode(JSON.stringify({
        version: 1, modelId: edits.modelId,
        materials: edits.materials.map(({ index, name, values, textures, sampling, graph }) => ({
          index, name, values, sampling,
          graph:graph&&{nodes:graph.nodes,terminal:graph.terminal,images:graph.images.map(image=>{blobs.push(image.file);return {...image,file:{type:image.file.type,size:image.file.size}};})},
          textures: textures.map(({ slot, file, transform }) => {
            if (file) blobs.push(file);
            return { slot, file: file && { type: file.type, size: file.size }, transform };
          })
        }))
      }));
      const length = new ArrayBuffer(4);
      new DataView(length).setUint32(0, header.byteLength, true);
      writable = await (await dir.getFileHandle(EDITS, { create: true })).createWritable();
      await writable.write(new Blob([length, header, ...blobs]));
      await writable.close();
    } catch {
      await writable?.abort().catch(() => {});
      await dir?.removeEntry(EDITS).catch(() => {});
    }
  });
}

export function readMaterialEdits(): Promise<MaterialEdits | null> {
  return enqueue(async () => {
    try {
      const dir = await directory();
      if (!dir) return null;
      const file = await (await dir.getFileHandle(EDITS)).getFile();
      const length = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
      if (length > 4 * 1024 * 1024 || length + 4 > file.size) return null;
      const header = JSON.parse(await file.slice(4, 4 + length).text());
      if (header.version !== 1 || typeof header.modelId !== 'string' || !Array.isArray(header.materials)) return null;
      let offset = 4 + length;
      const materials: MaterialEdit[] = [];
      for (const entry of header.materials) {
        if (!Number.isSafeInteger(entry.index) || typeof entry.name !== 'string' || typeof entry.values !== 'object' ||
          !Array.isArray(entry.textures)) return null;
        const values: MaterialValues = {};
        for (const key of MATERIAL_KEYS) {
          const value = entry.values?.[key];
          if ((key === 'alphaMode' && ['auto','opaque','mask','blend'].includes(value)) || (key === 'displacementUvProjection' && DISPLACEMENT_PROJECTIONS.some((p) => p === value)) ||
            typeof value === 'number' || typeof value === 'boolean' ||
            (Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === 'number'))) values[key] = value as MaterialValues[typeof key];
        }
        let graph:GraphArchive|undefined;
        if(entry.graph){
          if(!Array.isArray(entry.graph.nodes)||!entry.graph.terminal||!Array.isArray(entry.graph.images))return null;
          const images:GraphArchive['images']=[];
          for(const image of entry.graph.images){
            const {size,type}=image.file??{};
            if(!Number.isSafeInteger(size)||size<0||offset+size>file.size||typeof type!=='string'||typeof image.node!=='string'||typeof image.port!=='string')return null;
            images.push({...image,file:new Blob([await file.slice(offset,offset+size).arrayBuffer()],{type})});offset+=size;
          }
          graph={nodes:entry.graph.nodes,terminal:entry.graph.terminal,images};
        }
        const textures: MaterialEdit['textures'] = [];
        for (const texture of entry.textures) {
          if (!TEXTURE_KEYS.includes(texture.slot)) return null;
          if (!texture.file) {
            textures.push({ slot: texture.slot, file: null });
            continue;
          }
          const { size, type } = texture.file;
          if (!Number.isSafeInteger(size) || size < 0 || offset + size > file.size || typeof type !== 'string') return null;
          // Copy into memory: OPFS snapshots become unreadable once the file is rewritten.
          textures.push({
            slot: texture.slot, file: new Blob([await file.slice(offset, offset + size).arrayBuffer()], { type }),
            transform: readTransform(texture.transform)
          });
          offset += size;
        }
        const sampling = readSampling(entry.sampling);
        materials.push({ index: entry.index, name: entry.name, values, textures, ...(graph?{graph}:{}), ...(sampling ? {sampling} : {}) });
      }
      if (offset !== file.size) return null;
      return { modelId: header.modelId, materials };
    } catch {
      return null;
    }
  });
}

export function clearMaterialEdits(): Promise<void> {
  return enqueue(async () => {
    try { await (await directory())?.removeEntry(EDITS); } catch { /* Best effort. */ }
  });
}
