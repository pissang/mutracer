import {archiveGraph,restoreGraph} from './materialxGraphArchive';
import * as THREE from 'three';
import { Texture, type MaterialGraph, type OpenPBRMaterial } from '@meimu/mutracer';
import { useViewer } from '../store';
import {
  TEXTURE_KEYS, readMaterial, sameValue, textureSlots, writeMaterial,
  type MaterialValues, type TextureKey
} from './materialParams';
import { readMaterialEdits, saveMaterialEdits, type MaterialEdit as StoredEdit, type TextureTransform, type TextureSampling } from './modelCache';
import { discardHistory, pushHistory, type HistoryItem } from '../history';

/** Values and textures to set; `null` empties a texture slot. */
export interface MaterialPatch {
  graph?: MaterialGraph | null;
  values: MaterialValues;
  textures: Partial<Record<TextureKey, Texture | null>>;
}

interface Entry {
  name: string;
  /** Traversal order in the model; the persistent identity across reloads. */
  index: number;
  converted: Set<OpenPBRMaterial>;
  meshes: Set<string>;
  needsDisplacementProjection?: boolean;
  initial?: MaterialPatch;
}

/** An undo step of one material. */
class MaterialEdit implements HistoryItem {
  readonly scope = 'material';
  constructor(
    private readonly replay: (materialId: string, patch: MaterialPatch) => void,
    readonly materialId: string, readonly label: string,
    private readonly before: MaterialPatch, private after: MaterialPatch,
    readonly mergeKey?: string, readonly mergeMs?: number
  ) {}
  undo() { this.replay(this.materialId, this.before); }
  redo() { this.replay(this.materialId, this.after); }
  merge(next: HistoryItem) {
    if (!(next instanceof MaterialEdit) || next.materialId !== this.materialId) return true;
    this.after = merge(this.after, next.after);
    return !isEmpty(diff(this.before, this.after));
  }
}

/** A stored edit with its textures decoded, waiting for its material to be converted. */
interface PendingEdit {
  graph?:MaterialGraph|null;
  name: string;
  values: MaterialValues;
  sampling?: StoredEdit['sampling'];
  textures: Partial<Record<TextureKey, { image: ImageBitmap; file: Blob; transform?: TextureTransform } | null>>;
}

export type PendingEdits = Map<number, PendingEdit>;

const SAVE_DELAY_MS = 300;
const THUMB_SIZE = 64;

const get = useViewer.getState;
const set = useViewer.setState;

/** Reads the stored edits of a model and decodes their textures. */
export async function readPendingEdits(modelId: string): Promise<PendingEdits | null> {
  const edits = await readMaterialEdits();
  if (!edits || edits.modelId !== modelId) return null;
  const pending: PendingEdits = new Map();
  await Promise.all(edits.materials.map(async (edit) => {
    const textures: PendingEdit['textures'] = {};
    await Promise.all(edit.textures.map(async ({ slot, file, transform }) => {
      if (!file) {
        textures[slot] = null;
        return;
      }
      try {
        textures[slot] = { image: await decodeImage(file), file, transform };
      } catch {
        // An unreadable image drops only that slot.
      }
    }));
    const graph=edit.graph?await restoreGraph(edit.graph):undefined;
    pending.set(edit.index, { graph, name: edit.name, values: edit.values, textures, sampling:edit.sampling });
  }));
  return pending;
}

/** Decodes like GLTFLoader: no premultiplication, no color space conversion. */
function decodeImage(file: Blob) {
  return createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/**
 * Edits the converted materials of the loaded model: values, uploaded
 * textures, undo steps, and persistence of the edits for the cached model.
 */
export class MaterialEditor {
  private entries = new Map<string, Entry>();
  private order = new Map<string, { index: number; name: string }>();
  private pending: PendingEdits = new Map();
  /** Original files of uploaded textures, for persistence. */
  private uploads = new WeakMap<Texture, Blob>();
  private transforms = new WeakMap<Texture, TextureTransform>();
  private thumbs = new WeakMap<Texture, string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the model is identified; edits are only saved for a known model. */
  modelId: string | null = null;

  constructor(private readonly onHistoryApplied: (materialId: string) => void) {}

  /** Starts editing a new model; drops the history and any unsaved edits of the previous one. */
  setModel(root: THREE.Object3D | null, pending: PendingEdits | null) {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.modelId = null;
    this.entries.clear();
    this.order.clear();
    this.pending = pending ?? new Map();
    discardHistory('material');
    root?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!this.order.has(material.uuid)) this.order.set(material.uuid, { index: this.order.size, name: material.name });
      }
    });
  }

  /** Conversions start over with a new scene sync. */
  clearConversions() {
    this.entries.clear();
  }

  onConverted(source: THREE.Material, converted: OpenPBRMaterial | undefined, meshId: string, hasUVs = true) {
    let entry = this.entries.get(source.uuid);
    if (!entry) {
      entry = { name: source.name || 'Material', index: this.order.get(source.uuid)?.index ?? -1, converted: new Set(), meshes: new Set() };
      this.entries.set(source.uuid, entry);
    }
    entry.meshes.add(meshId);
    if (!hasUVs) entry.needsDisplacementProjection = true;
    if (!converted || entry.converted.has(converted)) return;
    const first = entry.converted.values().next().value as OpenPBRMaterial | undefined;
    entry.converted.add(converted);
    if (!entry.initial) {
      entry.initial = readState(converted);
      const edit = this.pending.get(entry.index);
      this.pending.delete(entry.index);
      if (edit && edit.name === (source.name || '')) this.apply(entry, this.fromPending(edit, converted), [converted]);
    } else if (first) {
      // Variants (e.g. instance colors) get the edits made so far, not the full state.
      this.apply(entry, diff(entry.initial, readState(first)), [converted]);
    }
  }

  has(materialId: string) {
    return !!this.entries.get(materialId)?.converted.size;
  }

  firstMesh(materialId: string) {
    return this.entries.get(materialId)?.meshes.values().next().value as string | undefined;
  }

  describe(materialId: string) {
    const entry = this.entries.get(materialId);
    const material = entry?.converted.values().next().value as OpenPBRMaterial | undefined;
    if (!entry || !material) return null;
    const maps: Partial<Record<TextureKey, string>> = {};
    const sampling: Partial<Record<TextureKey, TextureSampling>> = {};
    const record = material as unknown as Record<string, Texture | undefined>;
    for (const key of TEXTURE_KEYS) {
      const texture = record[key];
      if (texture) { maps[key] = this.thumbnail(texture); sampling[key] = textureSampling(texture); }
    }
    return { name: entry.name, users: entry.meshes.size, values: readMaterial(material), textures: [...textureSlots(material)], maps, sampling };
  }

  setValues(materialId: string, values: MaterialValues, label: string, mergeKey?: string) {
    this.commit(materialId, { values, textures: {} }, label, mergeKey);
  }

  setTextureSampling(materialId: string, slot: TextureKey, patch: Partial<TextureSampling>, label: string, mergeKey?: string) {
    const material = this.entries.get(materialId)?.converted.values().next().value as OpenPBRMaterial | undefined;
    const texture = material?.[slot];
    if (!texture) return;
    const next = {...textureSampling(texture), ...patch};
    if (!next.uvScale.every(Number.isFinite)) return;
    if (sameSampling(texture, next)) return;
    this.commit(materialId, {values:{}, textures:{[slot]:this.withSampling(texture, next)}}, label, mergeKey);
  }

  private withSampling(texture: Texture, sampling: TextureSampling) {
    const copy = new Texture(texture.image);
    copy.source = texture.source; copy.flipY = texture.flipY; copy.colorSpace = texture.colorSpace;
    copy.uvOffset = [...texture.uvOffset]; copy.uvChannel = texture.uvChannel;
    copy.uvScale = [...sampling.uvScale]; copy.wrapS = sampling.wrapS; copy.wrapT = sampling.wrapT;
    const file = this.uploads.get(texture), transform = this.transforms.get(texture);
    if (file) this.uploads.set(copy, file);
    if (transform) this.transforms.set(copy, transform);
    return copy;
  }

  async setTexture(materialId: string, slot: TextureKey, file: Blob | null, label: string) {
    await this.setTextures(materialId, { [slot]: file }, {}, label);
  }

  /**
   * Replaces several texture slots and values as one undo step; `null` empties a slot.
   * New textures take `transform`, or else the UV transform of the texture they replace.
   */
  async setTextures(
    materialId: string, files: Partial<Record<TextureKey, Blob | null>>, values: MaterialValues, label: string,
    merge?: { key: string; ms?: number }, transform?: TextureTransform, graph?: MaterialGraph | null,
    transforms?:Partial<Record<TextureKey,TextureTransform>>, signal?: AbortSignal
  ) {
    const entry = this.entries.get(materialId);
    const material = entry?.converted.values().next().value as OpenPBRMaterial | undefined;
    if (!entry || !material) return false;
    signal?.throwIfAborted();
    const slots = Object.entries(files) as [TextureKey, Blob | null][];
    const images = await Promise.all(slots.map(([, file]) => (file ? decodeImage(file) : null)));
    // The material may have been replaced while decoding.
    if (this.entries.get(materialId) !== entry || signal?.aborted) {
      images.forEach(image => image?.close());
      return false;
    }
    const textures: MaterialPatch['textures'] = {};
    slots.forEach(([slot, file], i) => {
      const image = images[i];
      if (!file || !image) {
        textures[slot] = null;
        return;
      }
      textures[slot] = this.upload(image, file, material, slot, transforms?.[slot]??transform);
    });
    // Newly uploaded heights also work on meshes that had no textures or UVs when converted.
    if (textures.displacementMap && entry.needsDisplacementProjection &&
      (values.displacementUvProjection ?? material.displacementUvProjection) === 'none') {
      values = { ...values, displacementUvProjection: 'triplanar' };
    }
    this.commit(materialId, { values, textures, ...(graph !== undefined ? {graph} : {}) }, label, merge?.key, merge?.ms);
    return true;
  }

  reset(materialId: string) {
    const initial = this.entries.get(materialId)?.initial;
    if (initial) this.commit(materialId, initial, 'Reset material');
  }

  /** Resets every material, including stored edits of materials not converted yet. */
  resetAll() {
    for (const materialId of this.entries.keys()) this.reset(materialId);
    if (!this.pending.size) return;
    this.pending.clear();
    this.scheduleSave();
  }

  /** Writes pending edits now, e.g. when the page is hidden. */
  flush() {
    if (this.saveTimer === undefined) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    void this.save();
  }

  private replay = (materialId: string, patch: MaterialPatch) => {
    const entry = this.entries.get(materialId);
    if (entry) this.apply(entry, patch);
    this.changed(materialId);
    this.onHistoryApplied(materialId);
  };

  private commit(materialId: string, patch: MaterialPatch, label: string, mergeKey?: string, mergeMs?: number) {
    const entry = this.entries.get(materialId);
    const material = entry?.converted.values().next().value as OpenPBRMaterial | undefined;
    if (!entry || !material) return;
    const current = readState(material);
    const after = diff(current, patch);
    if (isEmpty(after)) return;
    const before = pick(current, after);
    this.apply(entry, after);
    pushHistory(new MaterialEdit(this.replay, materialId, label, before, after, mergeKey, mergeMs));
    this.changed(materialId);
  }

  private apply(entry: Entry, patch: MaterialPatch, targets: Iterable<OpenPBRMaterial> = entry.converted) {
    for (const material of targets) {
      const record = material as unknown as Record<string, unknown>;
      for (const [key, texture] of Object.entries(patch.textures)) record[key] = texture ?? undefined;
      if ('graph' in patch) material.graph = patch.graph ?? undefined;
      writeMaterial(material, patch.values);
    }
  }

  private fromPending(edit: PendingEdit, material: OpenPBRMaterial): MaterialPatch {
    const textures: MaterialPatch['textures'] = {};
    for (const [slot, upload] of Object.entries(edit.textures) as [TextureKey, PendingEdit['textures'][TextureKey]][]) {
      if (!upload) {
        textures[slot] = null;
        continue;
      }
      textures[slot] = this.upload(upload.image, upload.file, material, slot, upload.transform);
    }
    for (const [slot, sampling] of Object.entries(edit.sampling ?? {}) as [TextureKey, TextureSampling][]) {
      const texture = textures[slot] === null ? undefined : textures[slot] ?? material[slot];
      if (texture) textures[slot] = this.withSampling(texture, sampling);
    }
    return { values: edit.values, textures, ...(edit.graph?{graph:edit.graph}:{}) };
  }

  private upload(image: ImageBitmap, file: Blob, material: OpenPBRMaterial, slot: TextureKey, transform?: TextureTransform) {
    const texture = createTexture(image, material, slot);
    if (transform) {
      texture.uvScale = [...transform.uvScale];
      texture.uvOffset = [...(transform.uvOffset??[0,0])];
      texture.flipY = transform.flipY;
      if(transform.uvChannel!==undefined)texture.uvChannel=transform.uvChannel;
      if(transform.wrapS)texture.wrapS=transform.wrapS;
      if(transform.wrapT)texture.wrapT=transform.wrapT;
      this.transforms.set(texture, transform);
    }
    this.uploads.set(texture, file);
    return texture;
  }

  /** Refreshes the published selection and schedules saving. */
  private changed(materialId: string) {
    const selected = get().material;
    if (selected?.id === materialId) {
      const description = this.describe(materialId);
      if (description) set({ material: { ...selected, ...description } });
    }
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.modelId) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        void this.save();
      }, SAVE_DELAY_MS);
    }
  }

  private save() {
    if (!this.modelId) return Promise.resolve();
    const materials: StoredEdit[] = [];
    for (const [materialId, entry] of this.entries) {
      const material = entry.converted.values().next().value as OpenPBRMaterial | undefined;
      if (!entry.initial || !material || entry.index < 0) continue;
      const changes = diff(entry.initial, readState(material));
      if (isEmpty(changes)) continue;
      const textures: StoredEdit['textures'] = [];
      for (const [slot, texture] of Object.entries(changes.textures) as [TextureKey, Texture | null][]) {
        const file = texture ? this.uploads.get(texture) : null;
        if (file !== undefined) textures.push({ slot, file, transform: texture ? this.transforms.get(texture) : undefined });
      }
      const sampling: NonNullable<StoredEdit['sampling']> = {};
      for (const slot of TEXTURE_KEYS) {
        const texture = material[slot], original = entry.initial.textures[slot];
        if (texture && (!original || !sameSampling(texture, original))) sampling[slot] = textureSampling(texture);
      }
      materials.push({ index: entry.index, name: this.order.get(materialId)?.name ?? '', values: changes.values, textures, ...('graph' in changes?{graph:archiveGraph(changes.graph??undefined)}:{}),
        ...(Object.keys(sampling).length ? {sampling} : {}) });
    }
    // Keep stored edits of materials that have not been converted yet.
    for (const [index, edit] of this.pending) {
      materials.push({
        index, name: edit.name, values: edit.values, sampling:edit.sampling, ...(edit.graph?{graph:archiveGraph(edit.graph)}:{}),
        textures: Object.entries(edit.textures).map(([slot, upload]) =>
          ({ slot: slot as TextureKey, file: upload?.file ?? null, transform: upload?.transform }))
      });
    }
    return saveMaterialEdits({ modelId: this.modelId, materials });
  }

  private thumbnail(texture: Texture) {
    const cached = this.thumbs.get(texture);
    if (cached !== undefined) return cached;
    let url = '';
    const image = texture.image as unknown;
    if (image instanceof ImageBitmap || image instanceof HTMLImageElement || image instanceof HTMLCanvasElement) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = THUMB_SIZE;
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(image, 0, 0, THUMB_SIZE, THUMB_SIZE);
        url = canvas.toDataURL('image/png');
      }
    }
    this.thumbs.set(texture, url);
    return url;
  }
}

function readState(material: OpenPBRMaterial): MaterialPatch {
  const record = material as unknown as Record<string, Texture | undefined>;
  const textures: MaterialPatch['textures'] = {};
  for (const key of TEXTURE_KEYS) textures[key] = record[key] ?? null;
  return { values: readMaterial(material), textures, graph:material.graph??null };
}

/** The parts of `next` that differ from `base`. */
function diff(base: MaterialPatch, next: MaterialPatch): MaterialPatch {
  const out: MaterialPatch = { values: {}, textures: {} };
  for (const [key, value] of Object.entries(next.values) as [keyof MaterialValues, MaterialValues[keyof MaterialValues]][]) {
    if (value !== undefined && !sameValue(base.values[key], value)) out.values[key] = Array.isArray(value) ? [...value] as [number, number, number] : value;
  }
  for (const [key, texture] of Object.entries(next.textures) as [TextureKey, Texture | null][]) {
    if ((base.textures[key] ?? null) !== (texture ?? null)) out.textures[key] = texture ?? null;
  }
  if ('graph' in next && next.graph !== base.graph) out.graph=next.graph;
  return out;
}

/** The values of `state` for the keys present in `keys`. */
function pick(state: MaterialPatch, keys: MaterialPatch): MaterialPatch {
  const out: MaterialPatch = { values: {}, textures: {} };
  for (const key of Object.keys(keys.values) as (keyof MaterialValues)[]) {
    const value = state.values[key];
    out.values[key] = Array.isArray(value) ? [...value] as [number, number, number] : value;
  }
  for (const key of Object.keys(keys.textures) as TextureKey[]) out.textures[key] = state.textures[key] ?? null;
  if ('graph' in keys) out.graph=state.graph??null;
  return out;
}

function merge(a: MaterialPatch, b: MaterialPatch): MaterialPatch {
  return { values: { ...a.values, ...b.values }, textures: { ...a.textures, ...b.textures }, ...('graph' in b?{graph:b.graph}:'graph' in a?{graph:a.graph}:{}) };
}

function isEmpty(patch: MaterialPatch) {
  return !('graph' in patch) && !Object.keys(patch.values).length && !Object.keys(patch.textures).length;
}

/** glTF orientation; keeps the UV transform of the texture it replaces, or of the base color map. */
function createTexture(image: ImageBitmap, material: OpenPBRMaterial, slot: TextureKey) {
  const texture = new Texture(image as unknown as HTMLCanvasElement);
  const reference = (material as unknown as Record<string, Texture | undefined>)[slot] ?? material.map;
  if (reference) {
    texture.uvScale = [...reference.uvScale];
    texture.uvOffset = [...reference.uvOffset];
    texture.uvChannel = reference.uvChannel;
    texture.wrapS = reference.wrapS;
    texture.wrapT = reference.wrapT;
  }
  return texture;
}

function textureSampling(texture: Texture): TextureSampling {
  return {uvScale:[...texture.uvScale], wrapS:texture.wrapS, wrapT:texture.wrapT};
}

function sameSampling(a: TextureSampling, b: TextureSampling) {
  return a.uvScale[0] === b.uvScale[0] && a.uvScale[1] === b.uvScale[1]
    && a.wrapS === b.wrapS && a.wrapT === b.wrapT;
}
