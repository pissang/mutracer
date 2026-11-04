// Compiled shared-TS oracle for the Rust kernel's complete vertex records.
import {compactVertexLayout, packCompactVertices} from '../../src/renderer/compactVertices.js';
import {decodeGeometry} from './scene-records.js';
import {HEADER as H} from './layout.js';
export function compactKernelReference(bytes: Uint8Array, normalFloat: number): Uint8Array {
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const geometry = decodeGeometry(u, f, u[H.GEOMETRY_OFFSET], undefined, false, false);
  const {stride, offsets, constants} = compactVertexLayout([geometry], !!normalFloat);
  const count = geometry.vertexCount, result = new Uint32Array(16 + count * stride);
  result.set([1, stride, 1, Number(!!constants.COLOR_FLOAT) | Number(!!normalFloat) * 2,
    offsets[2], offsets[3], offsets[4], offsets[5], count * stride, 0, 0, 0, 0, 0, count, 0]);
  packCompactVertices(geometry, result.subarray(16), stride, offsets, 0, count, 0, false, !!constants.COLOR_FLOAT, !!normalFloat);
  return new Uint8Array(result.buffer);
}
