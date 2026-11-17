import { getGeometryBvh } from './geometryBvh.js';
import Geometry from '../scene/Geometry.js';
import Mesh from '../scene/Mesh.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import type OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import type { FlattendBVH } from './bvhAccel.js';
import type { MaterialUpdateLevel } from './materialChanges.js';
import { getMaterialHashKey } from '../scene/openPbrSchema.js';
import { getBvhBounds, updateMeshInstances } from './prepareMeshBVH.js';
import { selectVisibleInstances } from './scenePreparation.js';

type Prepared = ReturnType<typeof updateMeshInstances>;
const attributes = ['position', 'normal', 'tangent', 'color', 'uv', 'uv1', 'indices', 'materialIndex'] as const;
function geometryState(geometry: Geometry): unknown[] {
  return [geometry.version, geometry.dynamic, getGeometryBvh(geometry), ...attributes.flatMap(key => {
    const attribute = geometry[key];
    return [attribute?.array, attribute?.array.length, attribute?.itemSize];
  })];
}

/** Reuses resident vertex/BLAS data when only single-material instances change. */
export class MeshMembershipCache {
  private _states = new Map<Geometry, unknown[]>();
  capture(res: Prepared) {
    this._states.clear();
    for (const binding of res.residentBindings) if (binding.mesh.geometry === binding.geometry) {
      this._states.set(binding.geometry, geometryState(binding.geometry));
    }
  }
  update(res: Prepared, meshes: readonly Mesh[]): Prepared | undefined {
    const geometries = new Map(res.geometries.map((geometry, i) => [geometry, i]));
    // Multiple-material vertex indices, displacement have
    // geometry-dependent packing; their structural edits require preparation.
    const checked = new Set<Geometry>();
    for (const mesh of meshes) {
      const previous = this._states.get(mesh.geometry);
      if (!previous || mesh.materials.length !== 1 || mesh.geometry.materialIndex ||
        mesh.materials[0].displacementMap) return;
      if (!checked.has(mesh.geometry)) {
        const next = geometryState(mesh.geometry);
        if (next.some((value, i) => value !== previous[i])) return;
        checked.add(mesh.geometry);
      }
    }
    // Rebuild active material slots when batches are added, removed or reassigned.
    // Retired material identities must not remain in the active table.
    const materials: Prepared['materials'] = [];
    const materialIndices = new Map<Prepared['materials'][number], number>();
    const templates = new Map(res.residentBindings.map(binding => [binding.geometry, binding]));
    const instanceBindings = meshes.filter(mesh => mesh.geometry.position.array.length > 0).map(mesh => {
      const material = mesh.materials[0];
      let index = materialIndices.get(material);
      if (index == null) { index = materials.length; materials.push(material); materialIndices.set(material, index); }
      const template = templates.get(mesh.geometry);
      // Bounds remain valid even after every instance of a geometry was removed.
      // Use the resident geometry bounds for all supported BVH layouts.
      return { mesh, geometry: mesh.geometry, blasIndex: geometries.get(mesh.geometry)!,
        materialIndices: [index], displacementScale: 0,
        bvhBounds: template?.bvhBounds ?? getBvhBounds(mesh.geometry) };
    });
    return selectVisibleInstances({...res, materials, residentBindings: instanceBindings}, meshes);
  }
}
/**
 * Refreshes cached material hash keys of the snapshots that use `changed`,
 * hashing each changed material once.
 */
export function refreshMaterialKeys(snapshots: readonly {materials: readonly Mesh['materials'][number][]; materialKeys: string[]}[],
  changed: readonly Mesh['materials'][number][]) {
  const keys = new Map(changed.map(material => [material, getMaterialHashKey(material)]));
  for (const item of snapshots) {
    for (let k = 0; k < item.materials.length; k++) {
      const key = keys.get(item.materials[k]);
      if (key !== undefined) item.materialKeys[k] = key;
    }
  }
}

/** Per-mesh state each ray-trace pass compares between setMeshes calls. */
export interface MeshSnapshot {
  mesh: Mesh;
  instanceCount: number;
  instanceVersion: number;
  instanceTransforms?: Float32Array;
  instanceColors?: Float32Array;
  colorVersion: number;
  geometry: Geometry;
  bvh?: FlattendBVH;
  materials: OpenPBRMaterial[];
  materialKeys: string[];
  visible: boolean;
  geometryVersion: number;
  positionArray: Float32Array;
  positionItemSize: number;
  indexArray: Uint16Array | Uint32Array;
  indexItemSize: number;
  materialIndexArray?: Int32Array;
  materialIndexItemSize?: number;
  matrix: number[];
}

export function snapshotMeshes(meshes: readonly Mesh[]): MeshSnapshot[] {
  // Materials are shared by many meshes; hash each once per call.
  const materialKeys = new Map<OpenPBRMaterial, string>();
  const materialKey = (material: OpenPBRMaterial) => {
    let key = materialKeys.get(material);
    if (key === undefined) { key = getMaterialHashKey(material); materialKeys.set(material, key); }
    return key;
  };
  return meshes.map(mesh => ({
    mesh,
    instanceCount: mesh instanceof InstancedMesh ? mesh.count : 1,
    instanceVersion: mesh instanceof InstancedMesh ? mesh.transformsVersion : 0,
    instanceTransforms: mesh instanceof InstancedMesh ? mesh.transforms : undefined,
    instanceColors: mesh instanceof InstancedMesh ? mesh.colors : undefined,
    colorVersion: mesh instanceof InstancedMesh ? mesh.colorsVersion : 0,
    geometry: mesh.geometry,
    bvh: getGeometryBvh(mesh.geometry),
    materials: mesh.materials.slice(),
    materialKeys: mesh.materials.map(materialKey),
    visible: mesh.visible,
    geometryVersion: mesh.geometry.version,
    positionArray: mesh.geometry.position.array,
    positionItemSize: mesh.geometry.position.itemSize,
    indexArray: mesh.geometry.indices.array,
    indexItemSize: mesh.geometry.indices.itemSize,
    materialIndexArray: mesh.geometry.materialIndex?.array,
    materialIndexItemSize: mesh.geometry.materialIndex?.itemSize,
    matrix: Array.from(mesh.transform as ArrayLike<number>)
  }));
}

export function snapshotsByMesh(snapshots: readonly MeshSnapshot[]) {
  const byMesh = new WeakMap<Mesh, MeshSnapshot>();
  snapshots.forEach(item => byMesh.set(item.mesh, item));
  return byMesh;
}

/** Mesh order, instance counts, visibility or material identities changed. */
export function meshMembershipChanged(next: readonly MeshSnapshot[], previous: readonly MeshSnapshot[]) {
  return next.length !== previous.length ||
    next.some((item, i) => item.mesh !== previous[i]?.mesh || item.instanceCount !== previous[i]?.instanceCount ||
      item.visible !== previous[i]?.visible || item.materials.some((material, k) => material !== previous[i]?.materials[k]));
}

/** Whether a membership update's material table differs from the prepared one. */
export function membershipMaterialsChanged(previous: readonly MeshSnapshot[], materials: readonly OpenPBRMaterial[],
  prepared: readonly OpenPBRMaterial[]) {
  const versions = new Map(previous.flatMap(item => item.materials.map((m, i) => [m, item.materialKeys[i]] as const)));
  return materials.length !== prepared.length ||
    materials.some((m, i) => m !== prepared[i] || versions.has(m) && getMaterialHashKey(m) !== versions.get(m));
}

export interface PendingMaterialUpdate {
  level: MaterialUpdateLevel;
  emission: boolean;
  emissiveMap: boolean;
  materials: Set<OpenPBRMaterial>;
}

/** Accumulates material edits until the next frame; textures dominate other levels. */
export function mergeMaterialUpdate(pending: PendingMaterialUpdate | undefined,
  change: { level: MaterialUpdateLevel; emission: boolean; emissiveMap: boolean },
  materials: readonly OpenPBRMaterial[]): PendingMaterialUpdate {
  return {
    level: pending?.level === 'textures' ? 'textures' : change.level,
    emission: !!pending?.emission || change.emission,
    emissiveMap: !!pending?.emissiveMap || change.emissiveMap,
    materials: new Set([...(pending?.materials ?? []), ...materials])
  };
}
