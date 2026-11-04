import {nativeTangentRequirements} from './scene-tangents.js';
import {generateVertexTangents, hasGeneratedVertexTangents} from '../../src/util/geometry.js';
import {materialNeedsVertexTangents} from '../../src/renderer/tangentRequirements.js';
// Incremental scene sync: each commit's descriptor is compared record by record
// with the previous one, and changed records update retained scene objects the
// way a Web application edits its scene. The shared SceneChangeTracker then
// classifies the edits exactly as engine.update() does.
import {SceneChangeTracker, type SceneSnapshotAdapter, type SceneChangeSet} from '../../src/renderer/sceneChangeCore.js';
import {NativeMaterialSnapshot, captureNativeMaterial, nativeMaterialMatches, syncNativeMaterial} from './material-snapshot.generated.js';
import {decodeTexture, decodeMaterial, decodeGeometry, decodeMeshMaterials, decodeInstances, decodeLight} from './scene-records.js';
import {HEADER as H, TEXTURE as T, MATERIAL as MAT, GEOMETRY as G, MESH as M, BATCH as B, LIGHT as L, CAMERA as C, EXTENSION as E,
  VERSION} from './layout.js';
import Geometry from '../../src/scene/Geometry.js';
import MeshState from '../../src/scene/MeshState.js';
import MaterialState from '../../src/scene/MaterialState.js';
import type {TextureDataSource} from '../../src/scene/textureData.js';
import PixelTexture from '../../src/scene/PixelTexture.js';
import type TextureState from '../../src/scene/TextureState.js';
import type IESProfile from '../../src/scene/IESProfile.js';
import {RectLightState, SphereLight, DirectionalLight, SpotLight} from '../../src/renderer/lightCore.js';

type AnalyticLight = RectLightState | SphereLight | SpotLight | DirectionalLight;
/** The environment map lights the scene, as EnvironmentLight does in a browser scene. */
export class NativeEnvironment {
  texture: PixelTexture;
  constructor(texture: PixelTexture) { this.texture = texture; }
}
export type NativeLight = AnalyticLight | NativeEnvironment;
export class NativeBackground {
  color = new Float32Array(4);
  texture: PixelTexture | undefined = undefined;
  hidden = false;
  environmentSettings = new Float32Array([1, 0, 1, 0]);
  grounded = new Float32Array(6);
}

class NativeLightSnapshot {
  light: NativeLight;
  numbers: number[];
  texture: TextureState | undefined;
  textureVersion: number;
  ies: IESProfile | undefined;
  constructor(light: NativeLight, numbers: number[], texture: TextureState | undefined, ies: IESProfile | undefined) {
    this.light = light; this.numbers = numbers; this.texture = texture;
    this.textureVersion = texture ? texture.version : 0; this.ies = ies;
  }
}
class NativeBackgroundSnapshot {
  numbers: number[];
  texture: TextureState | undefined;
  textureVersion: number;
  constructor(numbers: number[], texture: TextureState | undefined) {
    this.numbers = numbers; this.texture = texture; this.textureVersion = texture ? texture.version : 0;
  }
}
function pushPair(out: number[], value: [number, number] | Float32Array) {
  if (value instanceof Float32Array) out.push(value[0], value[1]); else out.push(value[0], value[1]);
}
function pushMatrix(out: number[], value: Float32Array | number[]) {
  if (value instanceof Float32Array) for (let i = 0; i < 16; i++) out.push(value[i]);
  else for (let i = 0; i < 16; i++) out.push(value[i]);
}
function sameNumbers(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
function captureLight(light: NativeLight): NativeLightSnapshot {
  if (light instanceof NativeEnvironment) return new NativeLightSnapshot(light, [-1], light.texture, undefined);
  const numbers: number[] = [light.color[0], light.color[1], light.color[2], light.intensity];
  pushMatrix(numbers, light.transform);
  if (light instanceof RectLightState) {
    numbers.push(0); pushPair(numbers, light.size); numbers.push(light.spread);
    return new NativeLightSnapshot(light, numbers, light.texture, undefined);
  }
  if (light instanceof SphereLight) { numbers.push(1, light.radius); return new NativeLightSnapshot(light, numbers, undefined, undefined); }
  if (light instanceof SpotLight) {
    numbers.push(3, light.radius, light.innerAngle, light.outerAngle);
    return new NativeLightSnapshot(light, numbers, undefined, light.iesProfile);
  }
  numbers.push(2);
  return new NativeLightSnapshot(light, numbers, undefined, undefined);
}
function captureBackground(background: NativeBackground | undefined): NativeBackgroundSnapshot {
  if (!background) return new NativeBackgroundSnapshot([], undefined);
  const c = background.color;
  const values = [c[0], c[1], c[2], c[3], background.hidden ? 1 : 0, background.environmentSettings[0], background.environmentSettings[1], background.environmentSettings[2], background.environmentSettings[3]];
  for (let i=0;i<6;i++) values.push(background.grounded[i]);
  return new NativeBackgroundSnapshot(values, background.texture);
}
const nativeAdapter: SceneSnapshotAdapter<NativeLight, NativeBackground, NativeMaterialSnapshot, NativeLightSnapshot, NativeBackgroundSnapshot> = {
  validateMesh: (_mesh: MeshState) => {},
  captureMaterial: (material: MaterialState, _previous: NativeMaterialSnapshot | undefined, retired: NativeMaterialSnapshot | undefined) =>
    captureNativeMaterial(material, retired ?? new NativeMaterialSnapshot()),
  materialMatches: (material: MaterialState, snapshot: NativeMaterialSnapshot) => nativeMaterialMatches(material, snapshot),
  captureLight: (light: NativeLight) => captureLight(light),
  lightsEqual: (a: NativeLightSnapshot, b: NativeLightSnapshot) => a.light === b.light && sameNumbers(a.numbers, b.numbers) &&
    a.texture === b.texture && a.textureVersion === b.textureVersion && a.ies === b.ies,
  captureBackground: (background: NativeBackground | undefined) => captureBackground(background),
  backgroundsEqual: (a: NativeBackgroundSnapshot, b: NativeBackgroundSnapshot) => sameNumbers(a.numbers, b.numbers) &&
    a.texture === b.texture && a.textureVersion === b.textureVersion
};

function sameWords(a: Uint32Array, aOffset: number, b: Uint32Array, bOffset: number, count: number): boolean {
  for (let i = 0; i < count; i++) if (a[aOffset + i] !== b[bOffset + i]) return false;
  return true;
}
/** Same record, comparing the listed offset fields by the content of `count(field)` words they reference. */
function sameRecord(a: Uint32Array, ao: number, b: Uint32Array, bo: number, words: number, offsets: number[], counts: number[]): boolean {
  for (let i = 0; i < words; i++) {
    const field = offsets.indexOf(i);
    if (field < 0) { if (a[ao + i] !== b[bo + i]) return false; continue; }
    const count = counts[field];
    if ((a[ao + i] === 0) !== (b[bo + i] === 0)) return false;
    if (a[ao + i] !== 0 && !sameWords(a, a[ao + i], b, b[bo + i], count)) return false;
  }
  return true;
}
function copyFloats(target: Float32Array, source: Float32Array) { target.set(source); }

export class NativeSceneChanges {
  scene: SceneChangeSet;
  camera: boolean;
  resolution: boolean;
  quality: boolean;
  constructor(scene: SceneChangeSet, camera: boolean, resolution: boolean, quality: boolean) {
    this.scene = scene; this.camera = camera; this.resolution = resolution; this.quality = quality;
  }
}

/** Retained objects mirroring the last synced descriptor; indices identify records. */
export class SyncedScene {
  bytes: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  textures: PixelTexture[] = [];
  materials: MaterialState[] = [];
  geometries: Geometry[] = [];
  meshes: MeshState[] = [];
  lights: NativeLight[] = [];
  analyticLights: NativeLight[] = [];
  environment: NativeEnvironment | undefined = undefined;
  background = new NativeBackground();
  tracker = new SceneChangeTracker<NativeLight, NativeBackground, NativeMaterialSnapshot, NativeLightSnapshot, NativeBackgroundSnapshot>(nativeAdapter);

  /**
   * Applies the descriptor to the retained objects and returns the pending
   * changes. An `owned` descriptor is kept for the next comparison instead of
   * a copy; the caller must not modify it afterwards. `unchanged` holds one
   * byte per geometry, then per texture; 1 skips comparing that record because
   * the host found it identical to the previous descriptor.
   */
  sync(bytes: Uint8Array, owned = false, unchanged?: Uint8Array): NativeSceneChanges {
    const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    if (u[H.VERSION] !== VERSION.SCENE) throw new Error('Unsupported native scene version');
    const old = this.bytes, first = old.length === 0;
    const geometries = u[H.GEOMETRY_COUNT];
    const hints = !first && unchanged && old[H.GEOMETRY_COUNT] === geometries && old[H.TEXTURE_COUNT] === u[H.TEXTURE_COUNT] &&
      unchanged.length === geometries + u[H.TEXTURE_COUNT] ? unchanged : undefined;
    const replaced = this.syncTextures(bytes, u, f, old, first, hints, geometries);
    this.syncMaterials(u, f, old, first, replaced);
    this.syncGeometries(u, f, old, first, hints);
    this.syncMeshes(u, f, old, first);
    // Material-only edits can add the first tangent consumer. Capture the new
    // attribute identity before change detection, forcing a full preparation.
    for (const mesh of this.meshes) {
      if (!mesh.geometry.tangent && mesh.geometry.uv && mesh.materials.some(materialNeedsVertexTangents)) {
        generateVertexTangents(mesh.geometry);
      }
    }
    this.syncLights(bytes, u, f, old, first, replaced);
    this.syncBackground(u, f);
    const camera = first || !sameWords(old, old[H.CAMERA_OFFSET], u, u[H.CAMERA_OFFSET], C.WORDS);
    const resolution = first || old[H.WIDTH] !== u[H.WIDTH] || old[H.HEIGHT] !== u[H.HEIGHT];
    const quality = first || ((old[H.QUALITY_FLAGS] ^ u[H.QUALITY_FLAGS]) & 3) !== 0;
    this.bytes = owned ? u : u.slice();
    const changes = this.tracker.detect({meshes: this.meshes, lights: this.lights, background: this.background});
    return new NativeSceneChanges(changes, camera, resolution, quality);
  }
  /** Accepts the last detected changes once the host has applied them. */
  accept() { this.tracker.commit(); }

  private syncTextures(bytes: Uint8Array, u: Uint32Array, f: Float32Array, old: Uint32Array, first: boolean,
    unchanged: Uint8Array | undefined, hintOffset: number): Set<number> {
    const replaced = new Set<number>(), count = u[H.TEXTURE_COUNT];
    const images = new Map<string, TextureDataSource>();
    for (let i = 0; i < count; i++) {
      if (unchanged && unchanged[hintOffset + i]) continue;
      const off = u[H.TEXTURE_OFFSET] + i * T.WORDS;
      const pixels = u[off + T.WIDTH] * u[off + T.HEIGHT] * (u[off + T.STORAGE] === 0 ? 1 : 4);
      if (first || i >= old[H.TEXTURE_COUNT]) { this.textures[i] = decodeTexture(bytes, u, f, off, images); replaced.add(i); continue; }
      const prior = old[H.TEXTURE_OFFSET] + i * T.WORDS;
      if (old[prior + T.PIXELS] === u[off + T.PIXELS] && sameRecord(old, prior, u, off, T.WORDS, [T.PIXELS], [pixels])) continue;
      const texture = this.textures[i], fresh = decodeTexture(bytes, u, f, off, images);
      const sameShape = old[prior + T.WIDTH] === u[off + T.WIDTH] && old[prior + T.HEIGHT] === u[off + T.HEIGHT] &&
        old[prior + T.STORAGE] === u[off + T.STORAGE];
      if (!sameShape || old[prior + T.PIXELS] !== u[off + T.PIXELS] ||
        !sameWords(old, old[prior + T.PIXELS], u, u[off + T.PIXELS], pixels)) {
        this.textures[i] = fresh; replaced.add(i); continue;
      }
      if (texture.wrapS !== fresh.wrapS) texture.wrapS = fresh.wrapS;
      if (texture.wrapT !== fresh.wrapT) texture.wrapT = fresh.wrapT;
      if (texture.flipY !== fresh.flipY) texture.flipY = fresh.flipY;
      if (texture.uvChannel !== fresh.uvChannel) texture.uvChannel = fresh.uvChannel;
      if (!Object.is(texture.uvScale[0], fresh.uvScale[0]) || !Object.is(texture.uvScale[1], fresh.uvScale[1])) texture.uvScale = fresh.uvScale;
      if (!Object.is(texture.uvOffset[0], fresh.uvOffset[0]) || !Object.is(texture.uvOffset[1], fresh.uvOffset[1])) texture.uvOffset = fresh.uvOffset;
    }
    this.textures.length = count;
    return replaced;
  }

  private syncMaterials(u: Uint32Array, f: Float32Array, old: Uint32Array, first: boolean, replaced: Set<number>) {
    const count = u[H.MATERIAL_COUNT];
    for (let i = 0; i < count; i++) {
      const off = u[H.MATERIAL_OFFSET] + i * MAT.WORDS;
      if (first || i >= old[H.MATERIAL_COUNT]) { this.materials[i] = decodeMaterial(u, f, off, this.textures); continue; }
      const prior = old[H.MATERIAL_OFFSET] + i * MAT.WORDS;
      // Texture replacement changes object identity even for an unchanged record.
      if (replaced.size === 0 && sameRecord(old, prior, u, off, MAT.WORDS, [MAT.EXTENSION_OFFSET], [u[off + MAT.EXTENSION_COUNT] * E.WORDS])) continue;
      syncNativeMaterial(this.materials[i], decodeMaterial(u, f, off, this.textures));
    }
    this.materials.length = count;
    for (let i = 0; i < count; i++) this.materials[i].aovId = u[H.MATERIAL_AOV_IDS] ? u[u[H.MATERIAL_AOV_IDS] + i] : i;
  }

  private syncGeometries(u: Uint32Array, f: Float32Array, old: Uint32Array, first: boolean, unchanged: Uint8Array | undefined) {
    const count = u[H.GEOMETRY_COUNT], required = nativeTangentRequirements(u, this.materials);
    for (let i = 0; i < count; i++) {
      if (unchanged && unchanged[i]) continue;
      const off = u[H.GEOMETRY_OFFSET] + i * G.WORDS, vertices = u[off + G.VERTEX_COUNT];
      if (first || i >= old[H.GEOMETRY_COUNT]) { this.geometries[i] = decodeGeometry(u, f, off, undefined, false, required[i]); continue; }
      const prior = old[H.GEOMETRY_OFFSET] + i * G.WORDS;
      const spans = [G.POSITION, G.INDICES, G.NORMAL, G.UV, G.UV1, G.COLOR, G.TANGENT, G.MATERIAL_INDEX];
      const sizes = [vertices * 3, u[off + G.INDEX_COUNT], vertices * 3, vertices * 2, vertices * 2, vertices * 3, vertices * 4, vertices];
      if (sameRecord(old, prior, u, off, G.WORDS, spans, sizes)) continue;
      const geometry = this.geometries[i], fresh = decodeGeometry(u, f, off, undefined, false, required[i] || hasGeneratedVertexTangents(geometry));
      const samePresence = old[prior + G.VERTEX_COUNT] === vertices && old[prior + G.INDEX_COUNT] === u[off + G.INDEX_COUNT] &&
        (old[prior + G.NORMAL] === 0) === (u[off + G.NORMAL] === 0) && (old[prior + G.UV] === 0) === (u[off + G.UV] === 0) &&
        (old[prior + G.UV1] === 0) === (u[off + G.UV1] === 0) && (old[prior + G.COLOR] === 0) === (u[off + G.COLOR] === 0) &&
        (old[prior + G.TANGENT] === 0) === (u[off + G.TANGENT] === 0) &&
        (old[prior + G.MATERIAL_INDEX] === 0) === (u[off + G.MATERIAL_INDEX] === 0);
      if (!samePresence) {
        // New attribute storage: a full mesh update, as in a browser scene.
        geometry.position = fresh.position; geometry.normal = fresh.normal; geometry.indices = fresh.indices;
        geometry.uv = fresh.uv; geometry.uv1 = fresh.uv1; geometry.color = fresh.color; geometry.tangent = fresh.tangent;
        geometry.materialIndex = fresh.materialIndex;
        geometry.markUpdated();
        continue;
      }
      // Generated normals and tangents follow the new positions, as a full commit would.
      copyFloats(geometry.position.array, fresh.position.array);
      copyFloats(geometry.normal.array, fresh.normal.array);
      const uv = geometry.uv, uv1 = geometry.uv1, color = geometry.color, tangent = geometry.tangent;
      if (uv && fresh.uv) copyFloats(uv.array, fresh.uv.array);
      if (uv1 && fresh.uv1) copyFloats(uv1.array, fresh.uv1.array);
      if (color && fresh.color) copyFloats(color.array, fresh.color.array);
      if (tangent && fresh.tangent) copyFloats(tangent.array, fresh.tangent.array);
      const topology = !sameWords(old, old[prior + G.INDICES], u, u[off + G.INDICES], u[off + G.INDEX_COUNT]) ||
        (u[off + G.MATERIAL_INDEX] !== 0 && !sameWords(old, old[prior + G.MATERIAL_INDEX], u, u[off + G.MATERIAL_INDEX], vertices));
      if (topology) {
        const indices = geometry.indices.array, source = fresh.indices.array;
        if (indices instanceof Uint32Array && source instanceof Uint32Array) indices.set(source);
        else geometry.indices = fresh.indices;
        const materialIndex = geometry.materialIndex, sourceIndex = fresh.materialIndex;
        if (materialIndex && sourceIndex) materialIndex.array.set(sourceIndex.array);
        geometry.markUpdated();
      } else geometry.markVerticesUpdated();
    }
    this.geometries.length = count;
  }

  private syncMeshes(u: Uint32Array, f: Float32Array, old: Uint32Array, first: boolean) {
    const count = u[H.MESH_COUNT];
    for (let i = 0; i < count; i++) {
      const off = u[H.MESH_OFFSET] + i * M.WORDS;
      const geometry = this.geometries[u[off + M.GEOMETRY]], materials = decodeMeshMaterials(u, off, this.materials);
      let mesh = i < this.meshes.length && !first ? this.meshes[i] : undefined;
      if (mesh === undefined) {
        mesh = new MeshState(geometry, materials);
        mesh.transform = f.slice(off + M.TRANSFORM, off + M.TRANSFORM + 16);
        this.meshes[i] = mesh;
      } else {
        if (mesh.geometry !== geometry) mesh.geometry = geometry;
        let sameMaterials = mesh.materials.length === materials.length;
        for (let k = 0; sameMaterials && k < materials.length; k++) if (mesh.materials[k] !== materials[k]) sameMaterials = false;
        if (!sameMaterials) mesh.materials = materials;
        const transform = mesh.transform;
        if (transform instanceof Float32Array) {
          let same = true;
          for (let k = 0; k < 16; k++) if (!Object.is(transform[k], f[off + M.TRANSFORM + k])) { same = false; break; }
          if (!same) transform.set(f.subarray(off + M.TRANSFORM, off + M.TRANSFORM + 16));
        } else mesh.transform = f.slice(off + M.TRANSFORM, off + M.TRANSFORM + 16);
      }
      mesh.aovId = u[H.MESH_AOV_IDS] ? u[u[H.MESH_AOV_IDS] + i] : i;
      this.syncInstances(mesh, u, f, first, i);
    }
    this.meshes.length = count;
  }

  private syncInstances(mesh: MeshState, u: Uint32Array, f: Float32Array, first: boolean, index: number) {
    const io = u[H.BATCH_OFFSET] ? u[H.BATCH_OFFSET] + index * B.WORDS : 0;
    const fresh = io ? decodeInstances(u, f, io) : undefined;
    const current = mesh.instanceState;
    if (!fresh) { if (current) mesh.setInstanceState(undefined); return; }
    if (!current || first || current.count !== fresh.count) { mesh.setInstanceState(fresh); return; }
    let transforms = false;
    for (let k = 0; k < fresh.transforms.length; k++) if (!Object.is(current.transforms[k], fresh.transforms[k])) { transforms = true; break; }
    if (transforms) { current.transforms.set(fresh.transforms); current.markTransformsUpdated(); }
    const colors = current.colors, freshColors = fresh.colors;
    if (colors === undefined || freshColors === undefined) {
      if (colors !== undefined || freshColors !== undefined) current.colors = freshColors;
    } else {
      let changed = false;
      for (let k = 0; k < freshColors.length; k++) if (!Object.is(colors[k], freshColors[k])) { changed = true; break; }
      if (changed) { colors.set(freshColors); current.markColorsUpdated(); }
    }
  }

  private syncLights(bytes: Uint8Array, u: Uint32Array, f: Float32Array, old: Uint32Array, first: boolean, replaced: Set<number>) {
    const count = u[H.LIGHT_COUNT], profiles = new Map<string, IESProfile>();
    for (let i = 0; i < count; i++) {
      const off = u[H.LIGHT_OFFSET] + i * L.WORDS;
      if (!first && i < old[H.LIGHT_COUNT] && i < this.analyticLights.length) {
        const prior = old[H.LIGHT_OFFSET] + i * L.WORDS;
        const texture = u[off + L.TEXTURE];
        const ies = u[off + L.IES_BYTES] ? (u[off + L.IES_BYTES] + 3) >> 2 : 0;
        if ((texture === 0 || !replaced.has(texture - 1)) && old[prior + L.IES_BYTES] === u[off + L.IES_BYTES] &&
          sameRecord(old, prior, u, off, L.WORDS, [L.IES_OFFSET], [ies])) continue;
      }
      this.analyticLights[i] = decodeLight(bytes, u, f, off, this.textures, profiles);
    }
    this.analyticLights.length = count;
    const environment = u[H.ENVIRONMENT_TEXTURE] ? this.textures[u[H.ENVIRONMENT_TEXTURE] - 1] : undefined;
    if (!environment) this.environment = undefined;
    else if (!this.environment || this.environment.texture !== environment) this.environment = new NativeEnvironment(environment);
    this.lights.length = 0;
    for (const light of this.analyticLights) this.lights.push(light);
    if (this.environment) this.lights.push(this.environment);
  }

  private syncBackground(u: Uint32Array, f: Float32Array) {
    const background = this.background;
    for (let i = 0; i < 4; i++) if (!Object.is(background.color[i], f[H.BACKGROUND_COLOR + i])) background.color[i] = f[H.BACKGROUND_COLOR + i];
    background.texture = u[H.BACKGROUND_TEXTURE] ? this.textures[u[H.BACKGROUND_TEXTURE] - 1] : undefined;
    background.hidden = (u[H.QUALITY_FLAGS] & 4) !== 0;
    const grounded = u[H.GROUNDED_BACKGROUND];
    background.grounded.set(grounded ? f.subarray(grounded, grounded + 6) : new Float32Array(6));
    const at = u[H.ENVIRONMENT_SETTINGS];
    background.environmentSettings.set(at ? f.subarray(at, at + 4) : new Float32Array([1, 0, 1, 0]));
  }
}

const syncedScenes = new Map<number, SyncedScene>();
function indexOf<T>(list: T[], item: T): number { return list.indexOf(item); }
/**
 * Change packet, version 1: words [1, meshes (0 none, 1 incremental, 2 full),
 * lights, background, camera, resolution, quality, then counts and indices of
 * changed transforms (mesh indices), instance colors (mesh indices), geometries
 * and materials (record indices)].
 */
const unchangedHints = new Map<number, Uint8Array>();
/** Stores unchanged-record hints (see SyncedScene.sync) for the token's next sync. */
export function receiveNativeSyncHints(bytes: Uint8Array, token: number): Uint8Array {
  unchangedHints.set(token, bytes);
  return new Uint8Array(new Uint32Array([1, 0, 0, 0]).buffer);
}
export function syncNativeScene(bytes: Uint8Array, token: number, owned = false): Uint8Array {
  let scene = syncedScenes.get(token);
  if (!scene) { scene = new SyncedScene(); syncedScenes.set(token, scene); }
  const unchanged = unchangedHints.get(token);
  unchangedHints.delete(token);
  const changes = scene.sync(bytes, owned, unchanged), set = changes.scene;
  const words: number[] = [1, set.meshes === 'none' ? 0 : set.meshes === 'incremental' ? 1 : 2, set.lights ? 1 : 0,
    set.background ? 1 : 0, changes.camera ? 1 : 0, changes.resolution ? 1 : 0, changes.quality ? 1 : 0];
  words.push(set.transforms.length); for (const mesh of set.transforms) words.push(indexOf(scene.meshes, mesh));
  words.push(set.colors.length); for (const mesh of set.colors) words.push(indexOf(scene.meshes, mesh));
  words.push(set.geometries.length); for (const geometry of set.geometries) words.push(indexOf(scene.geometries, geometry));
  words.push(set.materials.length); for (const material of set.materials) words.push(indexOf(scene.materials, material));
  return new Uint8Array(new Uint32Array(words).buffer);
}
export function acceptNativeScene(token: number): Uint8Array {
  const scene = syncedScenes.get(token);
  if (scene) scene.accept();
  return new Uint8Array(new Uint32Array([scene ? 1 : 0, 0, 0, 0]).buffer);
}
export function releaseNativeScene(token: number): Uint8Array {
  syncedScenes.delete(token); unchangedHints.delete(token);
  return new Uint8Array(16);
}
