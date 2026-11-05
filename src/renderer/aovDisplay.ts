import { AOV_KINDS, aovLaneKind, type AovKind } from './aov.js';
/** ID lane to visualize. Default object. */
export type AovIdComponent = 'object' | 'instance' | 'material' | 'primitive';
export interface AovDisplayOptions {
  depthRange: readonly [number, number];
  positionScale: number;
  motionScale: number;
  idComponent: AovIdComponent;
}
export const DEFAULT_AOV_DISPLAY: AovDisplayOptions = {
  depthRange: [0, 10], positionScale: 1, motionScale: 16, idComponent: 'object'
};
export const AOV_ID_COMPONENTS: readonly AovIdComponent[] = ['object', 'instance', 'material', 'primitive'];
export function displayAovKind(channel: string): AovKind | undefined {
  return AOV_KINDS.find(kind => kind === channel);
}
export function validateAovDisplay(options: AovDisplayOptions) {
  const range = options.depthRange;
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0])
    throw new RangeError('aovDepthRange requires 0 <= near < far');
  if (!range.map(Math.fround).every(Number.isFinite) || Math.fround(range[1]) <= Math.fround(range[0]))
    throw new RangeError('aovDepthRange must remain finite and increasing in float32');
  for (const scale of [options.positionScale, options.motionScale]) {
    if (!Number.isFinite(scale) || !Number.isFinite(Math.fround(scale)) || Math.fround(scale) <= 0) {
      throw new RangeError('AOV display scales must be finite and positive in float32');
    }
  }
  if (!AOV_ID_COMPONENTS.includes(options.idComponent))
    throw new RangeError('Unknown AOV ID component');
}
export function packAovDisplay(width: number, height: number, samples: number, kind: AovKind, options: AovDisplayOptions, linear: boolean) {
  validateAovDisplay(options);
  const words = new Uint32Array(12), floats = new Float32Array(words.buffer);
  words.set([width, height, samples, aovLaneKind(kind)]);
  floats.set([...options.depthRange, options.positionScale, options.motionScale], 4);
  words[8] = AOV_ID_COMPONENTS.indexOf(options.idComponent);
  words[9] = +linear;
  return words;
}
