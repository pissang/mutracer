import type MaterialState from '../../src/scene/MaterialState.js';
import {materialNeedsVertexTangents} from '../../src/renderer/tangentRequirements.js';
import {HEADER as H, MESH as M} from './layout.js';

export function nativeTangentRequirements(u: Uint32Array, materials: MaterialState[]): boolean[] {
  const required: boolean[] = [];
  for (let i = 0; i < u[H.GEOMETRY_COUNT]; i++) required.push(false);
  for (let i = 0; i < u[H.MESH_COUNT]; i++) {
    const off = u[H.MESH_OFFSET] + i * M.WORDS, count = u[off + M.MATERIAL_COUNT];
    let needs = false;
    if (!count) needs = materialNeedsVertexTangents(materials[u[off + M.MATERIAL]]);
    else for (let k = 0; k < count; k++) {
      if (materialNeedsVertexTangents(materials[u[u[off + M.MATERIAL_TABLE] + k]])) needs = true;
    }
    if (needs) required[u[off + M.GEOMETRY]] = true;
  }
  return required;
}
