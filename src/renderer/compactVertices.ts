import {localMaterialIndex} from './materialIndices.js';
import type Geometry from '../scene/Geometry.js';
import {hasGeneratedVertexTangents} from '../util/geometry.js';

// Word offsets, not vec4 slots. Positions and both UV sets remain f32.
// An absent secondary UV aliases the primary UV without duplicating its storage.
export function compactVertexLayout(geometries: readonly Geometry[], normalFloat = false) {
  const has = (name: 'uv' | 'uv1' | 'color' | 'tangent' | 'materialIndex') => geometries.some(g => !!g[name]);
  let colorFloat = false;
  for (const g of geometries) if (g.color) {
    for (const value of g.color.array) if (!(value >= 0 && value <= 1)) {colorFloat = true; break;}
  }
  let stride = normalFloat ? 6 : 4;
  const offsets = [0, 3, stride, stride, stride, stride, -1];
  if (has('uv') || has('uv1')) stride += 2;
  offsets[3] = has('uv1') ? stride : offsets[2];
  if (has('uv1')) stride += 2;
  offsets[4] = stride;
  if (has('color')) stride += colorFloat ? 3 : 1;
  offsets[5] = stride;
  if (has('tangent')) stride++;
  const names = ['POSITION', 'NORMAL', 'UV', 'UV1', 'COLOR', 'TANGENT'];
  const constants: Record<string, boolean | number> = {ATTR_STRIDE: stride, USE_UV: has('uv') || has('uv1'),
    USE_VERTEX_COLOR: has('color'), COLOR_FLOAT: colorFloat, NORMAL_FLOAT: normalFloat, HAS_VERTEX_UV: has('uv') || has('uv1'),
    HAS_VERTEX_TANGENT: has('tangent'), HAS_TRIANGLE_MATERIAL: has('materialIndex'), MATERIALINDEX_OFF: 0};
  names.forEach((name, i) => {constants[name + '_OFF'] = offsets[i];});
  return {stride, offsets, constants};
}

function oct(x: number, y: number, z: number, maximum: number, bits: number) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (!length) return (1 << (bits - 1)) | (1 << (bits * 2 - 1));
  x /= length; y /= length;
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (oldX < 0 ? -1 : 1);
    y = (1 - Math.abs(oldX)) * (y < 0 ? -1 : 1);
  }
  const mask = (1 << bits) - 1;
  return ((Math.round(x * maximum) & mask) | ((Math.round(y * maximum) & mask) << bits)) >>> 0;
}

export function encodeNormal(x: number, y: number, z: number) {return oct(x, y, z, 32767, 16);}
export function encodeTangent(x: number, y: number, z: number, w: number) {
  const sign = w > 1.5 ? 3 : w < 0 ? 2 : w > 0 ? 1 : 0;
  return (oct(x, y, z, 16383, 15) | (sign << 30)) >>> 0;
}

/** CPU decoder for layout/precision checks and backend-independent encoding consumers. */
export function decodeDirection(word: number, tangent = false): [number, number, number] {
  const bits = tangent ? 15 : 16, shift = 32 - bits, maximum = (1 << (bits - 1)) - 1;
  const a = (word << shift) >> shift, b = (word << (32 - 2 * bits)) >> shift;
  if (a === -maximum - 1 && b === -maximum - 1) return [0, 0, 0];
  let x = a / maximum, y = b / maximum;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (oldX < 0 ? -1 : 1);
    y = (1 - Math.abs(oldX)) * (y < 0 ? -1 : 1);
  }
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/** Writes source geometry directly into its resident packed vertex region. */
export function packCompactVertices(geometry: Geometry, output: Uint32Array, stride: number, offsets: readonly number[],
  first: number, count: number, outputFirst = first, deformationOnly = false, colorFloat = false, normalFloat = false) {
  const floats = new Float32Array(output.buffer, output.byteOffset, output.length);
  const p = geometry.position.array, n = geometry.normal.array, tangent = geometry.tangent;
  const uv = geometry.uv, uv1 = geometry.uv1 ?? uv, color = geometry.color;
  for (let i = first, end = first + count, d = outputFirst * stride; i < end; i++, d += stride) {
    floats[d] = p[i * 3]; floats[d + 1] = p[i * 3 + 1]; floats[d + 2] = p[i * 3 + 2];
    if (normalFloat) {
      floats[d + 3] = n[i * 3]; floats[d + 4] = n[i * 3 + 1]; floats[d + 5] = n[i * 3 + 2];
    } else output[d + 3] = encodeNormal(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
    if (offsets[5] < stride) {
      const t = i * (tangent?.itemSize ?? 0);
      output[d + offsets[5]] = tangent ? encodeTangent(tangent.array[t], tangent.array[t + 1], tangent.array[t + 2],
        tangent.itemSize === 4 ? tangent.array[t + 3] : hasGeneratedVertexTangents(geometry) ? 0 : 2) : encodeTangent(0, 0, 0, 0);
    }
    if (deformationOnly) continue;
    if (offsets[2] < offsets[4]) {
      floats[d + offsets[2]] = uv?.array[i * 2] ?? 0; floats[d + offsets[2] + 1] = uv?.array[i * 2 + 1] ?? 0;
      floats[d + offsets[3]] = uv1?.array[i * 2] ?? 0; floats[d + offsets[3] + 1] = uv1?.array[i * 2 + 1] ?? 0;
    }
    if (offsets[4] < offsets[5]) {
      const r = color?.array[i * 3] ?? 1, g = color?.array[i * 3 + 1] ?? 1, b = color?.array[i * 3 + 2] ?? 1;
      if (colorFloat) {floats[d + offsets[4]] = r; floats[d + offsets[4] + 1] = g; floats[d + offsets[4] + 2] = b;}
      else output[d + offsets[4]] = (Math.round(r * 255) | Math.round(g * 255) << 8 | Math.round(b * 255) << 16 | 0xff000000) >>> 0;
    }
  }
}

/** Optional material plane, indexed by BVH triangle record. Unused node entries are never read. */
export function packTriangleMaterials(geometry: Geometry, materialIndices: readonly number[], bvh: ArrayBuffer,
  output: Uint32Array, offset: number) {
  const words = new Uint32Array(bvh);
  for (let record = 0; record < words.length / 4; record++) {
    const vertex = words[record * 4];
    output[offset + record] = geometry.materialIndex && vertex < geometry.vertexCount
      ? (materialIndices[localMaterialIndex(geometry, vertex, materialIndices.length)] ?? 0) + 1 : 0;
  }
}
