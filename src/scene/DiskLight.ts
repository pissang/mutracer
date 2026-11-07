import type { ColorRGB } from '../types.js';
import SceneNode from './SceneNode.js';

/** A one-sided circular area light in local XY, emitting along local -Z. */
export default class DiskLight extends SceneNode {
  /** Light discriminator. */
  readonly type = 'DiskLight' as const;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB = [1, 1, 1];
  /** Emitted radiance multiplier, before optional area normalization. Default `1`. */
  intensity = 1;
  /** Radius in scene units; transform scale is ignored. Default `0.5`. */
  radius = 0.5;
  /** Keep total power constant as radius changes by dividing radiance by surface area. Default `false`. */
  normalize = false;

  /** Creates a disk light; omitted options retain the field defaults. */
  constructor(params: {
    /** Linear RGB color. Default `[1, 1, 1]`. */ color?: ColorRGB;
    /** Emitted radiance multiplier, before optional area normalization. Default `1`. */ intensity?: number;
    /** Radius in scene units; transform scale is ignored. Default `0.5`. */ radius?: number;
    /** Keep total power constant as radius changes. Default `false`. */ normalize?: boolean;
  } = {}) {
    super();
    this.color = params.color ?? [1, 1, 1];
    this.intensity = params.intensity ?? 1;
    this.radius = params.radius ?? 0.5;
    this.normalize = params.normalize ?? false;
  }
}
