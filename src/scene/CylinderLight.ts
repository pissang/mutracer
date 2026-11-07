import type { ColorRGB } from '../types.js';
import SceneNode from './SceneNode.js';

/** A two-sided cylindrical area light centered on local X; end caps do not emit. */
export default class CylinderLight extends SceneNode {
  /** Light discriminator. */
  readonly type = 'CylinderLight' as const;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB = [1, 1, 1];
  /** Emitted radiance multiplier, before optional area normalization. Default `1`. */
  intensity = 1;
  /** Cylinder length along local X in scene units; transform scale is ignored. Default `1`. */
  length = 1;
  /** Cylinder radius in scene units; transform scale is ignored. Default `0.5`. */
  radius = 0.5;
  /** Keep total power constant as dimensions change by dividing radiance by lateral area. Default `false`. */
  normalize = false;
  /** UsdLux compatibility hint; MuTracer keeps area-light sampling and ignores the approximation hint. Default `false`. */
  treatAsLine = false;

  /** Creates a cylinder light; omitted options retain the field defaults. */
  constructor(params: {
    /** Linear RGB color. Default `[1, 1, 1]`. */ color?: ColorRGB;
    /** Emitted radiance multiplier, before optional area normalization. Default `1`. */ intensity?: number;
    /** Length along local X in scene units; transform scale is ignored. Default `1`. */ length?: number;
    /** Radius in scene units; transform scale is ignored. Default `0.5`. */ radius?: number;
    /** Keep total power constant as dimensions change. Default `false`. */ normalize?: boolean;
    /** Request a line-light approximation where supported; ignored by MuTracer. Default `false`. */ treatAsLine?: boolean;
  } = {}) {
    super();
    this.color = params.color ?? [1, 1, 1];
    this.intensity = params.intensity ?? 1;
    this.length = params.length ?? 1;
    this.radius = params.radius ?? 0.5;
    this.normalize = params.normalize ?? false;
    this.treatAsLine = params.treatAsLine ?? false;
  }
}
