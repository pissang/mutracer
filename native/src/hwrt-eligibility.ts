import {nativeGraphOpacity} from './material-graph.js';
import type MaterialState from '../../src/scene/MaterialState.js';
import {resolveMaterialAlphaMode} from '../../src/scene/MaterialState.js';

interface GeometryMaterialBinding {blasIndex: number; materialIndices: number[]}

// AS geometry flags apply to every instance sharing a BLAS. A single material
// that needs candidate filtering disqualifies the whole geometry.
export function hardwareOpaqueGeometryFlags(materials: MaterialState[], bindings: GeometryMaterialBinding[], geometryCount: number): boolean[] {
  const flags = new Array<boolean>(geometryCount).fill(true);
  const seen = new Array<boolean>(geometryCount).fill(false);
  for (const binding of bindings) {
    seen[binding.blasIndex] = true;
    for (const index of binding.materialIndices) {
      const material = materials[index];
      if (!material || !material.doubleSided || nativeGraphOpacity(material) && material.alphaMode!=='opaque' || resolveMaterialAlphaMode(material) !== 'opaque' || material.displacementMap) {
        flags[binding.blasIndex] = false;
        break;
      }
    }
  }
  for (let i = 0; i < geometryCount; i++) if (!seen[i]) flags[i] = false;
  return flags;
}
