import type MaterialState from '../scene/MaterialState.js';

// Both shader families use vertex tangents for anisotropy and coat frames.
// Base normal maps use triangle UV differentials, independently of this attribute.
export function materialNeedsVertexTangents(material: MaterialState): boolean {
  return material.specularAnisotropy > 0 || material.coatAnisotropy > 0 ||
    material.coatWeight > 0 && !!material.coatNormalMap;
}

/** Whether a mesh's materials need tangents its geometry has not generated yet.
 * Engine generates them on the authored geometry without a version change, so
 * the renderer's scene copy receives them only through full mesh preparation;
 * incremental material and membership updates reuse resident vertices. */
export function meshesNeedGeneratedTangents(meshes: readonly {geometry: {tangent?: unknown; uv?: unknown; position?: {array: ArrayLike<number>}}; materials: readonly MaterialState[]}[]) {
  return meshes.some(({geometry, materials}) => !geometry.tangent && !!geometry.uv && !!geometry.position?.array.length &&
    materials.some(materialNeedsVertexTangents));
}
