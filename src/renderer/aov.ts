/** Optional primary-surface outputs, separate from beauty and OIDN guides. */
export type AovKind = 'depth' | 'position' | 'roughness' | 'diffuseAlbedo' | 'specularAlbedo' | 'id' | 'motion' | 'diffuseColor' | 'specularColor';
export const AOV_KINDS: readonly AovKind[] = ['depth', 'position', 'roughness', 'diffuseAlbedo', 'specularAlbedo', 'id', 'motion', 'diffuseColor', 'specularColor'];
export const AOV_BACKGROUND_ID = 0xffffffff;
/** Display-resolution AOVs only guide texture detail; 4 jittered samples match 16 within measurement noise. */
export const DISPLAY_AOV_SAMPLE_CAP = 4;
/** Mask bits of directional reflectance quadrature (diffuseAlbedo, specularAlbedo). */
export const AOV_REFLECTANCE_MASK = 24;
/** Mask bits of resolved texture colors (diffuseColor, specularColor). */
export const AOV_COLOR_MASK = 384;
/** Mask bits of kinds accumulated over jittered samples. */
export const AOV_ACCUMULATED_MASK = 31 | AOV_COLOR_MASK;
/** Kinds that fit the compact display-resolution storage. */
export const COMPACT_AOV_KINDS: readonly AovKind[] = ['depth', 'diffuseColor', 'specularColor'];
// Four vec4 lanes for accumulated geometry/reflectance; two for center ID/motion.
// Depth and roughness share a lane; coverage is position.w. A lobe's albedo and
// color share its reflectance lane, so a render requests at most one of them.
export const AOV_LAYOUT = {accumulatedBytes: 64, centerBytes: 32,
  depthRoughness: 0, position: 4, diffuseAlbedo: 8, specularAlbedo: 12,
  id: 0, motion: 4} as const;
/** Kind index read by resolve and display shaders; colors resolve like the albedo sharing their lane. */
export function aovLaneKind(kind: AovKind): number {
  return kind === 'diffuseColor' ? 3 : kind === 'specularColor' ? 4 : AOV_KINDS.indexOf(kind);
}
let nextId = 0;
export function allocateAovId(): number {
  if (nextId >= AOV_BACKGROUND_ID) throw new RangeError('AOV ID space exhausted');
  return nextId++;
}
export function validateAovId(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= AOV_BACKGROUND_ID) throw new RangeError('AOV ID must be uint32 excluding 0xFFFFFFFF');
  return value;
}
export function aovMask(kinds: readonly AovKind[]): number {
  let mask = 0;
  for (const kind of kinds) {
    const index = AOV_KINDS.indexOf(kind);
    if (index < 0) throw new RangeError(`Unknown AOV: ${kind}`);
    mask |= 1 << index;
  }
  if ((mask & 8) && (mask & 128)) throw new RangeError('diffuseAlbedo and diffuseColor cannot be requested together');
  if ((mask & 16) && (mask & 256)) throw new RangeError('specularAlbedo and specularColor cannot be requested together');
  return mask;
}
export interface AovInstanceSnapshot {
  object: number; instance: number; topology: number; vertices: number;
  transform: Float32Array;
}
export interface AovFrameSnapshot {
  width: number; height: number; projection: string;
  cameraEye?: Float32Array; cameraForward?: Float32Array;
  viewProjection: Float32Array; instances: readonly AovInstanceSnapshot[];
}
/** Per-render history; camera pose and rigid transforms may change without resetting. */
export class AovHistory {
  private frame?: AovFrameSnapshot;
  private instances=new Map<string,AovInstanceSnapshot>();
  clear() { this.frame = undefined; this.instances.clear(); }
  previous(next: AovFrameSnapshot): AovFrameSnapshot | undefined {
    const old = this.frame;
    return old && old.width === next.width && old.height === next.height && old.projection === next.projection ? old : undefined;
  }
  match(next: AovFrameSnapshot, instance: AovInstanceSnapshot): AovInstanceSnapshot | undefined {
    const old = this.previous(next) ? this.instances.get(`${instance.object}:${instance.instance}`) : undefined;
    return old && old.topology === instance.topology && old.vertices === instance.vertices ? old : undefined;
  }
  accept(frame: AovFrameSnapshot) {
    this.frame = {...frame, cameraEye: frame.cameraEye?.slice(), cameraForward: frame.cameraForward?.slice(), viewProjection: frame.viewProjection.slice(),
      instances: frame.instances.map(i => ({...i, transform: i.transform.slice()}))};
    this.instances.clear();
    for (const instance of this.frame.instances) this.instances.set(`${instance.object}:${instance.instance}`,instance);
  }
}
