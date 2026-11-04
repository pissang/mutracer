import type Geometry from '../../src/scene/Geometry.js';
import {computeGeometryBounds} from '../../src/renderer/geometryBvhBounds.js';
import {GEOMETRY_KERNEL_HEADER as H, GEOMETRY_KERNEL_ENTRY as E, VERSION} from './layout.js';

export interface GeometryKernelHint {
  vertexCount: number;
  bounds: Float32Array | undefined;
  tangents: Float32Array | undefined;
}
const pending = new Map<number, GeometryKernelHint[]>();
const boundsByPosition = new WeakMap<Float32Array, {version: number; bounds: Float32Array}>();

export function receiveGeometryKernelHints(bytes: Uint8Array, token: number, owned = false): Uint8Array {
  try {
    if (bytes.length < H.WORDS * 4 || bytes.length > 0xfffffffc || bytes.length % 4) throw new Error('Invalid kernel hints');
    const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    const header = H.WORDS + u[H.COUNT] * E.WORDS;
    if (u[H.VERSION] !== VERSION.GEOMETRY_KERNELS || u[H.LENGTH] !== u.length || u[H.RESERVED] || u[H.COUNT] > 65536 || header > u.length) throw new Error('Invalid kernel header');
    const hints: GeometryKernelHint[] = [];
    let next = header;
    for (let i = 0; i < u[H.COUNT]; i++) {
      const o = H.WORDS + i * E.WORDS, count = u[o + E.VERTEX_COUNT];
      const bounds = u[o + E.BOUNDS], tangent = u[o + E.TANGENTS];
      if (u[o + E.SOURCE] !== i || count === 0 || count > 4_000_000) throw new Error('Invalid kernel geometry');
      // The internal packet is contiguous and ordered. Validate before slicing,
      // so overlaps cannot amplify an otherwise bounded packet's allocations.
      if (bounds) {
        if (bounds !== next || 6 > u.length - next) throw new Error('Invalid kernel bounds');
        next += 6;
      }
      if (tangent) {
        if (tangent !== next || count * 3 > u.length - next) throw new Error('Invalid kernel tangents');
        next += count * 3;
      }
      hints.push({vertexCount: count, bounds: bounds ? f.slice(bounds, bounds + 6) : undefined,
        tangents: tangent ? (owned ? f.subarray(tangent, tangent + count * 3) : f.slice(tangent, tangent + count * 3)) : undefined});
    }
    if (next !== u.length) throw new Error('Unexpected kernel payload');
    pending.set(token, hints);
    return new Uint8Array(new Uint32Array([1, 0, 0, 0]).buffer);
  } catch {
    pending.delete(token);
    return new Uint8Array(new Uint32Array([2, 0, 0, 0]).buffer);
  }
}
export function takeGeometryKernelHints(token: number) {
  const value = pending.get(token);
  pending.delete(token);
  return value;
}
export function releaseGeometryKernelHints(token: number) { pending.delete(token); }
export function rememberKernelBounds(geometry: Geometry, bounds: Float32Array) {
  boundsByPosition.set(geometry.position.array, {version: geometry.version, bounds});
}
export function geometryKernelBounds(geometry: Geometry) {
  const cached = boundsByPosition.get(geometry.position.array);
  return cached && cached.version === geometry.version
    ? [cached.bounds.subarray(0, 3), cached.bounds.subarray(3, 6)] as [Float32Array, Float32Array]
    : computeGeometryBounds(geometry);
}
export function encodeGeometryKernelHints(hints: GeometryKernelHint[], counts: number[]): Uint8Array {
  const header = H.WORDS + hints.length * E.WORDS;
  const total = header + hints.reduce((n, h) => n + (h.bounds ? 6 : 0) + (h.tangents?.length ?? 0), 0);
  const u = new Uint32Array(total), f = new Float32Array(u.buffer);
  u[H.VERSION] = VERSION.GEOMETRY_KERNELS; u[H.COUNT] = hints.length; u[H.LENGTH] = total;
  let next = header;
  for (let i = 0; i < hints.length; i++) {
    const h = hints[i], o = H.WORDS + i * E.WORDS;
    u[o + E.SOURCE] = i; u[o + E.VERTEX_COUNT] = counts[i];
    if (h.bounds) { u[o + E.BOUNDS] = next; f.set(h.bounds, next); next += 6; }
    if (h.tangents) { u[o + E.TANGENTS] = next; f.set(h.tangents, next); next += h.tangents.length; }
  }
  return new Uint8Array(u.buffer);
}
