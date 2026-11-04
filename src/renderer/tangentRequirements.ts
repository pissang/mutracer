import type MaterialState from '../scene/MaterialState.js';

// Both shader families use vertex tangents for anisotropy and coat frames.
// Base normal maps use triangle UV differentials, independently of this attribute.
export function materialNeedsVertexTangents(material: MaterialState): boolean {
  return material.specularAnisotropy > 0 || material.coatAnisotropy > 0 ||
    material.coatWeight > 0 && !!material.coatNormalMap;
}
