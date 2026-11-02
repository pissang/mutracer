import type {ColorRGB, Mat4, Vec3} from '../types.js';

/** Maximum number of participating volumes in a scene. */
export const MAX_VOLUMES = 8;

/** World-space procedural density modulation. */
export interface SceneVolumeNoise {
  /** Required largest feature size per world axis, finite and positive. */
  size: Vec3;
  /** Fractal layers, integer 1–6. Default 4. */
  octaves?: number;
  /** Approximate filled fraction, 0–1. Default 0.5. */
  coverage?: number;
  /** Transition width, 0–1; zero gives a hard threshold. Default 0.3. */
  softness?: number;
  /** World-space offset; edits reset accumulation. Default [0, 0, 0]. */
  offset?: Vec3;
  /** Breaks up and bends density edges, in multiples of size, nonnegative and finite. Default 0. */
  warp?: number;
}

/** A participating medium filling a bounded box or ellipsoid. */
export interface SceneVolume {
  /** Required finite, nonnegative density multiplier: extinction per world unit at baseHeight, before any density field. */
  density: number;
  /** Multiplies density by world-space procedural noise. Default none. */
  noise?: SceneVolumeNoise;
  /** Boundary fade as a fraction of local half extent, 0–1. Default 0. */
  edgeFade?: number;
  /** Required local bounds, each min strictly below max. Volume is absent outside its shape. */
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
