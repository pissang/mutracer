import type {WGPUShaderFeatures} from '../../src/renderer/wgpuShaderSource.js';

// Process-local AOT-owned bytes. Callers copy them into packets; GPU pipelines
// have their own device cache. Exact signatures also guard fingerprint collisions.
const variants = new Map<number, {signature: string; bytes: Uint8Array}>();
const order: number[] = [];
let generated = 0, hits = 0;
export function nativeShaderVariant(id: number, constants: Record<string, boolean | number>, features: WGPUShaderFeatures,
  flags: number, source: () => string, graphKey = ''): Uint8Array {
  const keys = Object.keys(constants).sort();
  const values: (boolean | number)[] = [];
  for (const key of keys) values.push(constants[key]);
  // Hook fragments are derived entirely from graphKey and the existing frame
  // features; keep them out of the cache identity and its serialized cost.
  const {materialHooks: _materialHooks, ...sourceFeatures} = features;
  const signature = JSON.stringify(graphKey ? {id, keys, values, features: sourceFeatures, flags, graphKey} : {id, keys, values, features: sourceFeatures, flags});
  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) hash = Math.imul(hash ^ signature.charCodeAt(i), 0x01000193);
  hash >>>= 0;
  const previous = variants.get(hash);
  if (previous?.signature === signature) {hits++; return previous.bytes;}
  const bytes = new TextEncoder().encode(source()); generated++;
  variants.set(hash, {signature, bytes});
  if (!previous) order.push(hash);
  if (order.length > 32) variants.delete(order.shift()!);
  return bytes;
}
export function nativeShaderVariantStats() {return {generated, hits, retained: variants.size};}
