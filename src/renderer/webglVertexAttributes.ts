import type Geometry from '../scene/Geometry.js';
import type { Attribute } from '../scene/Geometry.js';

// WebGL 2 guarantees only 16 fragment texture units, so the shading attributes
// share one RGBA32F texture with a fixed number of texels per vertex. Positions
// stay in their own texture because triangle tests read only them.
//   slot 0: normal.xyz, materialIndex.x
//   slot 1: uv.xy, materialIndex.yz
//   optional slots, in order: tangent.xyzw, color.rgb, uv1.xy
export interface VertexAttributeLayout {
  stride: number;
  tangent: number;
  color: number;
  uv1: number;
}

export function vertexAttributeLayout(geometry: Geometry): VertexAttributeLayout {
  let stride = 2;
  const slot = (attribute: Attribute | undefined) => attribute ? stride++ : -1;
  const tangent = slot(geometry.tangent);
  const color = slot(geometry.color);
  const uv1 = slot(geometry.uv1);
  return { stride, tangent, color, uv1 };
}

export function vertexAttributeDefines(layout: VertexAttributeLayout) {
  return {
    VERTEX_ATTRIBUTE_STRIDE: layout.stride,
    VERTEX_TANGENT_SLOT: layout.tangent,
    VERTEX_COLOR_SLOT: layout.color,
    USE_UV1: layout.uv1 >= 0,
    VERTEX_UV1_SLOT: layout.uv1
  };
}

// Copies attribute components [from, from + channels.length) into the given texel channels.
function copy(out: Float32Array, texel: number, channels: number[], attribute: Attribute | undefined, vertex: number, from = 0) {
  if (!attribute) return;
  const array = attribute.array, size = attribute.itemSize;
  for (let i = 0; i < channels.length && from + i < size; i++) out[texel * 4 + channels[i]] = array[vertex * size + from + i];
}

/** Writes vertices [first, first + count) of `geometry` into `out`. */
export function packVertexAttributes(
  geometry: Geometry, layout: VertexAttributeLayout, out: Float32Array, first = 0, count = geometry.vertexCount - first
) {
  out.fill(0, first * layout.stride * 4, (first + count) * layout.stride * 4);
  for (let vertex = first; vertex < first + count; vertex++) {
    const base = vertex * layout.stride;
    copy(out, base, [0, 1, 2], geometry.normal, vertex);
    copy(out, base, [3], geometry.materialIndex, vertex);
    copy(out, base + 1, [0, 1], geometry.uv, vertex);
    copy(out, base + 1, [2, 3], geometry.materialIndex, vertex, 1);
    if (layout.tangent >= 0) copy(out, base + layout.tangent, [0, 1, 2, 3], geometry.tangent, vertex);
    if (layout.color >= 0) copy(out, base + layout.color, [0, 1, 2], geometry.color, vertex);
    if (layout.uv1 >= 0) copy(out, base + layout.uv1, [0, 1], geometry.uv1, vertex);
  }
  return out;
}
