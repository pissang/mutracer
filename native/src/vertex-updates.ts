import Geometry from '../../src/scene/Geometry.js';
import {packCompactVertices} from '../../src/renderer/compactVertices.js';

// Keep whole vertex records: AS input stride and shader offsets share this ABI.
// Generated normals/tangents can widen a position edit to neighbouring vertices.
export function packedVertexChange(previous: Geometry, next: Geometry, stride: number,
  offsets: readonly number[], colorFloat: boolean, normalFloat: boolean) {
  const before = new Uint32Array(previous.vertexCount * stride), after = new Uint32Array(next.vertexCount * stride);
  packCompactVertices(previous, before, stride, offsets, 0, previous.vertexCount, 0, false, colorFloat, normalFloat);
  packCompactVertices(next, after, stride, offsets, 0, next.vertexCount, 0, false, colorFloat, normalFloat);
  let first = 0, end = after.length;
  while (first < end && before[first] === after[first]) first++;
  if (first === end) return {offset: 0, data: new Uint8Array(0)};
  while (end > first && before[end - 1] === after[end - 1]) end--;
  first = Math.floor(first / stride) * stride; end = Math.ceil(end / stride) * stride;
  return {offset: first * 4, data: new Uint8Array(after.buffer.slice(first * 4, end * 4))};
}
