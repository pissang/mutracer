import type {ColorRGB, Mat4, Vec3} from '../types.js';

/** Maximum number of participating fog volumes in a scene. */
export const MAX_FOG_VOLUMES = 8;

/** A participating medium filling a bounded box or ellipsoid. */
export interface SceneFog {
  /** Required finite, nonnegative extinction per world unit, at baseHeight. */
  density: number;
  /** Required local bounds, each min strictly below max. Fog is absent outside its shape. */
  bounds: {min: Vec3; max: Vec3};
  /** Box or inscribed ellipsoid. Default 'box'. */
  shape?: 'box' | 'ellipsoid';
  /** Invertible affine column-major local-to-world matrix. Default identity. Scale changes shape, not extinction per world unit. */
  transform?: Mat4;
  /** Single-scattering albedo, each channel in [0, 1]. Default [1, 1, 1]. */
  color?: ColorRGB;
  /** Henyey–Greenstein anisotropy in [-0.999, 0.999]. Default 0. */
  anisotropy?: number;
  /** Nonnegative exponential density decay along world +Y, per world unit. Default 0 (uniform). */
  heightFalloff?: number;
  /** World Y at which density applies. Default the shape's lowest world Y. */
  baseHeight?: number;
}
