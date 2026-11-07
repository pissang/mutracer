import type MeshState from '../scene/MeshState.js';
import type MaterialState from '../scene/MaterialState.js';
import type Geometry from '../scene/Geometry.js';
import type { Mat4 } from '../types.js';

// Change detection shared by the Web engine and the native core. Platform
// adapters own value snapshots: the Web adapter tolerates loosely typed JS
// values, the native adapter compares typed descriptor state. Unions are
// narrowed before element access or identity comparison so the native
// compiler can lower every path.

export interface SceneChangeSet {
  meshes: 'none' | 'incremental' | 'full';
  /**
   * True when `meshes` is full only because meshes were added, removed or
   * reordered; every retained mesh is unchanged apart from the incremental
   * lists below. `added` lists meshes absent from the previous commit.
   */
  membershipOnly: boolean;
  added: MeshState[];
  /** Retained meshes whose `visible` flag changed. */
  visibility: MeshState[];
  transforms: MeshState[];
  colors: MeshState[];
  geometries: Geometry[];
  materials: MaterialState[];
  lights: boolean;
  background: boolean;
}
export interface TrackedScene<L, B> { meshes: MeshState[]; lights: L[]; background?: B; }
export interface SceneSnapshotAdapter<L, B, MaterialSnapshot, LightSnapshot, BackgroundSnapshot> {
  validateMesh: (mesh: MeshState) => void;
  /** previous: the committed snapshot; retired: storage from the other buffer that may be reused. */
  captureMaterial: (material: MaterialState, previous: MaterialSnapshot | undefined, retired: MaterialSnapshot | undefined) => MaterialSnapshot;
  materialMatches: (material: MaterialState, snapshot: MaterialSnapshot) => boolean;
  captureLight: (light: L) => LightSnapshot;
  lightsEqual: (a: LightSnapshot, b: LightSnapshot) => boolean;
  captureBackground: (background: B | undefined) => BackgroundSnapshot;
  backgroundsEqual: (a: BackgroundSnapshot, b: BackgroundSnapshot) => boolean;
}

function sameFloat32(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return a === b;
}
function sameInt32(a: Int32Array | undefined, b: Int32Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return a === b;
}
function sameIndices(a: Uint16Array | Uint32Array, b: Uint16Array | Uint32Array): boolean {
  if (a instanceof Uint16Array) return b instanceof Uint16Array && a === b;
  if (b instanceof Uint16Array) return false;
  return a === b;
}
function indexLength(indices: Uint16Array | Uint32Array): number {
  if (indices instanceof Uint16Array) return indices.length;
  return indices.length;
}
function matrixEquals(matrix: Mat4, previous: Float64Array, offset: number): boolean {
  if (matrix instanceof Float32Array) {
    for (let k = 0; k < 16; k++) if (!Object.is(matrix[k], previous[offset + k])) return false;
  } else {
    for (let k = 0; k < 16; k++) if (!Object.is(matrix[k], previous[offset + k])) return false;
  }
  return true;
}
function storeMatrix(matrix: Mat4, target: Float64Array, offset: number) {
  if (matrix instanceof Float32Array) target.set(matrix, offset);
  else target.set(matrix, offset);
}

/** Attribute array identities, lengths and item sizes; any change needs a full mesh update. */
class GeometryStorage {
  position: Float32Array; positionSize: number;
  normal: Float32Array; normalSize: number;
  indices: Uint16Array | Uint32Array; indicesLength: number; indicesSize: number;
  tangent: Float32Array | undefined = undefined; tangentSize = 0;
  uv: Float32Array | undefined = undefined; uvSize = 0;
  uv1: Float32Array | undefined = undefined; uv1Size = 0;
  color: Float32Array | undefined = undefined; colorSize = 0;
  materialIndex: Int32Array | undefined = undefined; materialIndexSize = 0;
  lengths: number[] = [0, 0, 0, 0, 0, 0, 0];
  constructor(geometry: Geometry) {
    this.position = geometry.position.array; this.positionSize = geometry.position.itemSize;
    this.normal = geometry.normal.array; this.normalSize = geometry.normal.itemSize;
    this.indices = geometry.indices.array; this.indicesLength = indexLength(geometry.indices.array); this.indicesSize = geometry.indices.itemSize;
    this.capture(geometry);
  }
  capture(geometry: Geometry) {
    this.position = geometry.position.array; this.positionSize = geometry.position.itemSize;
    this.normal = geometry.normal.array; this.normalSize = geometry.normal.itemSize;
    this.indices = geometry.indices.array; this.indicesLength = indexLength(geometry.indices.array); this.indicesSize = geometry.indices.itemSize;
    const tangent = geometry.tangent, uv = geometry.uv, uv1 = geometry.uv1, color = geometry.color, materialIndex = geometry.materialIndex;
    this.tangent = tangent ? tangent.array : undefined; this.tangentSize = tangent ? tangent.itemSize : 0;
    this.uv = uv ? uv.array : undefined; this.uvSize = uv ? uv.itemSize : 0;
    this.uv1 = uv1 ? uv1.array : undefined; this.uv1Size = uv1 ? uv1.itemSize : 0;
    this.color = color ? color.array : undefined; this.colorSize = color ? color.itemSize : 0;
    this.materialIndex = materialIndex ? materialIndex.array : undefined; this.materialIndexSize = materialIndex ? materialIndex.itemSize : 0;
    const lengths = this.lengths;
    lengths[0] = geometry.position.array.length; lengths[1] = geometry.normal.array.length;
    lengths[2] = tangent ? tangent.array.length : -1; lengths[3] = uv ? uv.array.length : -1;
    lengths[4] = uv1 ? uv1.array.length : -1; lengths[5] = color ? color.array.length : -1;
    lengths[6] = materialIndex ? materialIndex.array.length : -1;
  }
  matches(geometry: Geometry): boolean {
    const tangent = geometry.tangent, uv = geometry.uv, uv1 = geometry.uv1, color = geometry.color, materialIndex = geometry.materialIndex;
    const lengths = this.lengths;
    return this.position === geometry.position.array && this.positionSize === geometry.position.itemSize &&
      lengths[0] === geometry.position.array.length &&
      this.normal === geometry.normal.array && this.normalSize === geometry.normal.itemSize &&
      lengths[1] === geometry.normal.array.length &&
      sameIndices(this.indices, geometry.indices.array) && this.indicesLength === indexLength(geometry.indices.array) &&
      this.indicesSize === geometry.indices.itemSize &&
      sameFloat32(this.tangent, tangent ? tangent.array : undefined) && this.tangentSize === (tangent ? tangent.itemSize : 0) &&
      lengths[2] === (tangent ? tangent.array.length : -1) &&
      sameFloat32(this.uv, uv ? uv.array : undefined) && this.uvSize === (uv ? uv.itemSize : 0) &&
      lengths[3] === (uv ? uv.array.length : -1) &&
      sameFloat32(this.uv1, uv1 ? uv1.array : undefined) && this.uv1Size === (uv1 ? uv1.itemSize : 0) &&
      lengths[4] === (uv1 ? uv1.array.length : -1) &&
      sameFloat32(this.color, color ? color.array : undefined) && this.colorSize === (color ? color.itemSize : 0) &&
      lengths[5] === (color ? color.array.length : -1) &&
      sameInt32(this.materialIndex, materialIndex ? materialIndex.array : undefined) &&
      this.materialIndexSize === (materialIndex ? materialIndex.itemSize : 0) &&
      lengths[6] === (materialIndex ? materialIndex.array.length : -1);
  }
}

class MeshSnapshot {
  aovId: number;
  visible: boolean;
  mesh: MeshState;
  geometry: Geometry;
  version: number;
  dynamic: boolean;
  storage: GeometryStorage;
  materials: MaterialState[] = [];
  instanced = false;
  instanceCount = 0;
  instanceVersion = 0;
  colorVersion = 0;
  instanceTransforms: Float32Array | undefined = undefined;
  instanceColors: Float32Array | undefined = undefined;
  constructor(mesh: MeshState) {
    this.aovId = mesh.aovId; this.visible = mesh.visible;
    this.mesh = mesh; this.geometry = mesh.geometry; this.version = mesh.geometry.version;
    this.dynamic = mesh.geometry.dynamic; this.storage = new GeometryStorage(mesh.geometry);
  }
  capture(mesh: MeshState) {
    this.aovId = mesh.aovId; this.visible = mesh.visible;
    this.mesh = mesh; this.geometry = mesh.geometry; this.version = mesh.geometry.version;
    this.dynamic = mesh.geometry.dynamic; this.storage.capture(mesh.geometry);
    const instance = mesh.instanceData;
    this.instanced = instance !== undefined;
    this.instanceCount = instance ? instance.count : 0;
    this.instanceVersion = instance ? instance.transformsVersion : 0;
    this.colorVersion = instance ? instance.colorsVersion : 0;
    this.instanceTransforms = instance ? instance.transforms : undefined;
    this.instanceColors = instance ? instance.colors : undefined;
    this.materials.length = 0;
    for (let k = 0; k < mesh.materials.length; k++) this.materials.push(mesh.materials[k]);
  }
}

class Snapshot<L, MaterialSnapshot, LightSnapshot, BackgroundSnapshot> {
  meshList: MeshState[];
  meshes: MeshSnapshot[] = [];
  matrices: Float64Array;
  materials = new Map<MaterialState, MaterialSnapshot>();
  lightList: L[];
  lights: LightSnapshot[] = [];
  background: BackgroundSnapshot;
  constructor(meshes: MeshState[], lights: L[], background: BackgroundSnapshot) {
    this.meshList = meshes; this.matrices = new Float64Array(meshes.length * 16);
    this.lightList = lights; this.background = background;
  }
}

/** Detects edits without accepting them until the platform has received the scene. */
export class SceneChangeTracker<L, B, MaterialSnapshot, LightSnapshot, BackgroundSnapshot> {
  private adapter: SceneSnapshotAdapter<L, B, MaterialSnapshot, LightSnapshot, BackgroundSnapshot>;
  private snapshot: Snapshot<L, MaterialSnapshot, LightSnapshot, BackgroundSnapshot> | undefined = undefined;
  private pending: Snapshot<L, MaterialSnapshot, LightSnapshot, BackgroundSnapshot> | undefined = undefined;
  private spare: Snapshot<L, MaterialSnapshot, LightSnapshot, BackgroundSnapshot> | undefined = undefined;
  private seen = new Set<MaterialState>();
  constructor(adapter: SceneSnapshotAdapter<L, B, MaterialSnapshot, LightSnapshot, BackgroundSnapshot>) { this.adapter = adapter; }

  detect(scene: TrackedScene<L, B>): SceneChangeSet {
    const adapter = this.adapter, old = this.snapshot, meshes = scene.meshes;
    // Membership edits (add, remove, reorder) are full for consumers that only
    // read `meshes`; retained meshes are still matched by identity so that
    // `membershipOnly` can tell them apart from structural edits.
    let full = old === undefined;
    let membership = old !== undefined && (old.meshList !== meshes || old.meshes.length !== meshes.length);
    let previousIndices: Map<MeshState, number> | undefined = undefined;
    let matched = 0;
    const added: MeshState[] = [];
    const visibility: MeshState[] = [];
    const transforms: MeshState[] = [];
    const colors: MeshState[] = [];
    const geometries = new Set<Geometry>();
    const materials: MaterialState[] = [];
    const seen = this.seen;
    seen.clear();
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      let prevIndex = -1;
      if (old !== undefined) {
        if (i < old.meshes.length && old.meshes[i].mesh === mesh) prevIndex = i;
        else {
          membership = true;
          if (previousIndices === undefined) {
            previousIndices = new Map<MeshState, number>();
            for (let k = old.meshes.length - 1; k >= 0; k--) previousIndices.set(old.meshes[k].mesh, k);
          }
          const found = previousIndices.get(mesh);
          if (found !== undefined) prevIndex = found;
        }
      }
      const prev = old !== undefined && prevIndex >= 0 ? old.meshes[prevIndex] : undefined;
      if (prev !== undefined) matched++;
      else if (old !== undefined) added.push(mesh);
      if (prev !== undefined && prev.visible !== mesh.visible) visibility.push(mesh);
      let instanceChanged = false;
      const instance = mesh.instanceData;
      if (instance) {
        adapter.validateMesh(mesh);
        if (prev !== undefined && (!prev.instanced || prev.instanceCount !== instance.count)) full = true;
        if (prev !== undefined && prev.mesh === mesh &&
          (prev.colorVersion !== instance.colorsVersion || !sameFloat32(prev.instanceColors, instance.colors))) colors.push(mesh);
        if (prev !== undefined && prev.mesh === mesh &&
          (prev.instanceVersion !== instance.transformsVersion || prev.instanceTransforms !== instance.transforms)) {
          transforms.push(mesh); instanceChanged = true;
        }
      }
      if (prev === undefined) { /* added: membership */ }
      else if (prev.aovId !== mesh.aovId || prev.geometry !== mesh.geometry || prev.dynamic !== mesh.geometry.dynamic ||
        !prev.storage.matches(mesh.geometry) || prev.materials.length !== mesh.materials.length) full = true;
      else for (let k = 0; k < mesh.materials.length; k++) if (prev.materials[k] !== mesh.materials[k]) { full = true; break; }
      if (prev !== undefined && prev.geometry === mesh.geometry && prev.version !== mesh.geometry.version) geometries.add(mesh.geometry);
      if (prev !== undefined && prev.mesh === mesh && old !== undefined && !matrixEquals(mesh.transform, old.matrices, prevIndex * 16)) {
        if (!instanceChanged) transforms.push(mesh);
      }
      for (let k = 0; k < mesh.materials.length; k++) {
        const material = mesh.materials[k];
        if (seen.has(material)) continue;
        seen.add(material);
        const prior = old !== undefined ? old.materials.get(material) : undefined;
        if (prior === undefined || !adapter.materialMatches(material, prior)) materials.push(material);
      }
    }
    const lights: LightSnapshot[] = [];
    for (let i = 0; i < scene.lights.length; i++) lights.push(adapter.captureLight(scene.lights[i]));
    const background = adapter.captureBackground(scene.background);
    let lightsChanged = old === undefined || old.lightList !== scene.lights || lights.length !== old.lights.length;
    if (old !== undefined && !lightsChanged) {
      for (let i = 0; i < lights.length; i++) if (!adapter.lightsEqual(lights[i], old.lights[i])) { lightsChanged = true; break; }
    }
    if (old !== undefined && matched < old.meshes.length) membership = true;
    const changes: SceneChangeSet = {
      meshes: full || membership ? 'full' : transforms.length > 0 || colors.length > 0 || materials.length > 0 || geometries.size > 0 ||
        visibility.length > 0 ? 'incremental' : 'none',
      membershipOnly: membership && !full, added, visibility,
      transforms, colors, materials, geometries: [...geometries],
      lights: lightsChanged,
      background: old === undefined || !adapter.backgroundsEqual(background, old.background)
    };
    if (changes.meshes !== 'none' || changes.lights || changes.background) {
      // Write into the other buffer: detect never mutates committed state.
      // Repeated detects without commit overwrite the same pending buffer.
      let next = this.spare;
      if (next === undefined || next.meshList !== meshes || next.meshes.length !== meshes.length) {
        next = new Snapshot<L, MaterialSnapshot, LightSnapshot, BackgroundSnapshot>(meshes, scene.lights, background);
        this.spare = next;
      }
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        let item = i < next.meshes.length ? next.meshes[i] : undefined;
        if (item === undefined) { item = new MeshSnapshot(mesh); next.meshes.push(item); }
        item.capture(mesh);
        storeMatrix(mesh.transform, next.matrices, i * 16);
      }
      const retiredMaterials = next.materials;
      next.materials = new Map<MaterialState, MaterialSnapshot>();
      const changedMaterials = new Set<MaterialState>(materials);
      for (const material of seen) {
        const previous = old !== undefined ? old.materials.get(material) : undefined;
        if (previous !== undefined && !changedMaterials.has(material)) {
          next.materials.set(material, previous);
        } else {
          // Never overwrite a shared committed entry; the retired entry of the
          // other buffer may lend its storage.
          const retired = retiredMaterials.get(material);
          next.materials.set(material, adapter.captureMaterial(material, previous, retired !== previous ? retired : undefined));
        }
      }
      next.lightList = scene.lights; next.lights = lights; next.background = background;
      this.pending = next;
    } else this.pending = old;
    return changes;
  }

  commit() {
    if (this.pending !== undefined && this.pending !== this.snapshot) {
      this.spare = this.snapshot;
      this.snapshot = this.pending;
    }
    this.pending = undefined;
  }
  reset() { this.snapshot = undefined; this.pending = undefined; this.spare = undefined; this.seen.clear(); }
}
