import { getGeometryBvh } from './geometryBvh.js';
import Geometry from '../scene/Geometry.js';
import Mesh from '../scene/Mesh.js';
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
