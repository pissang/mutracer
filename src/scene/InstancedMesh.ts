import Mesh from './Mesh.js';
import Geometry from './Geometry.js';
import type OpenPBRMaterial from './OpenPBRMaterial.js';
import type { InstanceData } from './MeshState.js';
import { checkInstanceRange, fillIdentityTransforms, validateInstances, type InstancedMeshOptions } from './instanceStorage.js';
export type { InstancedMeshOptions } from './instanceStorage.js';


/** A batch of instances. World matrices are transform * transforms[i]. */
export default class InstancedMesh extends Mesh {
  // A live view over the public own properties keeps engine snapshots independent.
  /** @internal */
  override get instanceData(): InstanceData { return this; }
  /** Local column-major matrices. Default: count identities. Call markTransformsUpdated after element edits. */
  transforms: Float32Array;
  /** Active prefix length. Default: constructor count; must fit transforms and colors. Changes are detected by engine.update. */
  count: number;
  /** Linear RGB multipliers, 3 floats per instance. Default undefined (white). Call markColorsUpdated after element edits. */
  colors: Float32Array | undefined;
  /** Advanced by any update notification. Default 0. */
  get version(): number { return this._version; }
  private _version = 0;
  private _transformVersion = 0;
  private _colorVersion = 0;
  /** @internal */
  get transformsVersion(): number { return this._transformVersion; }
  /** @internal */
  get colorsVersion(): number { return this._colorVersion; }

  constructor(geometry: Geometry, material: OpenPBRMaterial | OpenPBRMaterial[], options: InstancedMeshOptions) {
    super(geometry, material);
    this.count = options.count;
    this.transforms = options.transforms ?? new Float32Array(this.count * 16);
    this.colors = options.colors;
    this.validate();
    if (!options.transforms) fillIdentityTransforms(this.transforms, this.count);
  }
  /**
   * Notify edits to both local matrices and colors for all active instances.
   * Advances version once. Does not notify geometry or material edits. Returns this.
   * Use the dedicated methods for single-property edits to avoid unnecessary work.
   */
  markUpdated(): this {
    this.validate();
    this._transformVersion++; this._colorVersion++; this._version++;
    return this;
  }
  /**
   * Notify edited local matrices, avoiding copies of unchanged colors.
   * Defaults: start 0, count all active matrices from start. Returns this.
   */
  markTransformsUpdated(start = 0, count = this.count - start): this {
    this.validate();
    checkInstanceRange(start, count, this.count, 'transform');
    this._transformVersion++; this._version++;
    return this;
  }
  /**
   * Notify edited colors without copying matrices or updating BVHs.
   * Defaults: start 0, count all active instances from start. Returns this.
   */
  markColorsUpdated(start = 0, count = this.count - start): this {
    this.validate();
    checkInstanceRange(start, count, this.count, 'color');
    this._colorVersion++; this._version++;
    return this;
  }
  /** @internal */
  validate() {
    validateInstances(this.count, this.transforms, this.colors);
  }
}
