// Small, token-local work descriptions only. No AOT pointer leaves the runtime.
const enabled = new Set<number>();
const pending = new Map<number, Uint8Array>();
export function compactKernelEnabled(token: number) { return enabled.has(token); }
export function releaseCompactKernel(token: number) { enabled.delete(token); pending.delete(token); }
export function rememberCompactJobs(token: number, words: number[]) {
  pending.set(token, new Uint8Array(new Uint32Array(words).buffer));
}
export function compactKernelParameters(bytes: Uint8Array, token: number): Uint8Array {
  if (bytes.byteLength !== 4) throw new Error('Invalid compact kernel command');
  const mode = new Uint32Array(bytes.buffer, bytes.byteOffset, 1)[0];
  if (mode === 2) {
    const jobs = pending.get(token);
    releaseCompactKernel(token);
    if (!jobs) throw new Error('Missing compact kernel jobs');
    return jobs;
  }
  if (mode > 1) throw new Error('Unknown compact kernel command');
  releaseCompactKernel(token);
  if (mode) enabled.add(token);
  return new Uint8Array(new Uint32Array([1, 0, 0, 0]).buffer);
}
