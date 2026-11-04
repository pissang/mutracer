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
  const tangentArray = tangent?.array, tangentSize = tangent?.itemSize ?? 0;
  const tangentSign = tangentSize === 4 ? 0 : hasGeneratedVertexTangents(geometry) ? 0 : 2;
  const uvArray = uv?.array, uv1Array = uv1?.array, colorArray = color?.array;
  const uvOffset = offsets[2], uv1Offset = offsets[3], colorOffset = offsets[4], tangentOffset = offsets[5];
  for (let i = first, end = first + count, d = outputFirst * stride; i < end; i++, d += stride) {
    floats[d] = p[i * 3]; floats[d + 1] = p[i * 3 + 1]; floats[d + 2] = p[i * 3 + 2];
    if (normalFloat) {
      floats[d + 3] = n[i * 3]; floats[d + 4] = n[i * 3 + 1]; floats[d + 5] = n[i * 3 + 2];
    } else output[d + 3] = encodeNormal(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
    if (tangentOffset < stride) {
      const t = i * tangentSize;
      output[d + tangentOffset] = tangentArray ? encodeTangent(tangentArray[t], tangentArray[t + 1], tangentArray[t + 2],
        tangentSize === 4 ? tangentArray[t + 3] : tangentSign) : encodeTangent(0, 0, 0, 0);
    }
    if (deformationOnly) continue;
    if (uvOffset < colorOffset) {
      floats[d + uvOffset] = uvArray?.[i * 2] ?? 0; floats[d + uvOffset + 1] = uvArray?.[i * 2 + 1] ?? 0;
      floats[d + uv1Offset] = uv1Array?.[i * 2] ?? 0; floats[d + uv1Offset + 1] = uv1Array?.[i * 2 + 1] ?? 0;
    }
    if (colorOffset < tangentOffset) {
      const r = colorArray?.[i * 3] ?? 1, g = colorArray?.[i * 3 + 1] ?? 1, b = colorArray?.[i * 3 + 2] ?? 1;
      if (colorFloat) {floats[d + colorOffset] = r; floats[d + colorOffset + 1] = g; floats[d + colorOffset + 2] = b;}
      else output[d + colorOffset] = (Math.round(r * 255) | Math.round(g * 255) << 8 | Math.round(b * 255) << 16 | 0xff000000) >>> 0;
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
