import type { Scene } from './scene';
/** Compact inline geometry before crossing the worker boundary. Parameter
 * objects are shared with statement locations, so both references see the same
 * transferable view and the original JS number arrays become collectible. */
export function compactScene(scene: Scene): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const shape of [...scene.shapes, ...Object.values(scene.objects).flat()]) {
    for (const key of ['P','N','uv','st','indices']) {
      const parameter = shape.params[key];
      if (!parameter) continue;
      const values = parameter.values;
      if (key === 'indices' && Array.from(values, Number).some(v => !Number.isInteger(v) || v < 0 || v > 0xffffffff)) continue;
      if (!(values instanceof Float32Array || values instanceof Uint32Array)) {
        parameter.values = key === 'indices' ? Uint32Array.from(values as number[]) : Float32Array.from(values as number[]);
      }
      buffers.add((parameter.values as Float32Array | Uint32Array).buffer as ArrayBuffer);
    }
  }
  return [...buffers];
}
