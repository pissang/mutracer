import { allocateAovId, validateAovId } from '../renderer/aov.js';
import Geometry from './Geometry.js';
import SceneNode from './SceneNode.js';
import type MaterialState from './MaterialState.js';
import type InstanceState from './InstanceState.js';
export interface InstanceData { count: number; transforms: Float32Array; colors: Float32Array | undefined; transformsVersion: number; colorsVersion: number; }

/**
 * A geometry rendered with one or more materials. With several materials,
 * `geometry.materialIndex` selects the material of each triangle.
 */
const aovIds = new WeakMap<MeshState, number>();
export default class MeshState extends SceneNode {
  /** Stable unsigned object ID, excluding 0xFFFFFFFF. Default process-unique monotonic ID; assign before committing the scene. */
  get aovId(): number { return aovIds.get(this)!; }
  set aovId(value: number) { aovIds.set(this, validateAovId(value)); }
  /** Materials supplied to the constructor, indexed by per-vertex materialIndex. */
  materials: MaterialState[];
  /** Indexed triangle geometry supplied to the constructor; no default. */
  geometry: Geometry;
  /**
   * Whether the mesh takes part in rendering. Default `true`. A hidden mesh
   * renders exactly as if it were removed from `scene.meshes` (no camera,
   * shadow, indirect, emission, picking or AOV contribution), while its
   * geometry, BLAS and materials stay resident, so toggling it only rebuilds
   * instance data.
   */
  visible = true;

  /** @internal */
  private _instances?: InstanceState;
  /** @internal */
  get instanceData(): InstanceData | undefined {
    const state = this._instances;
    return state ? {count: state.count, transforms: state.transforms, colors: state.colors,
      transformsVersion: state.transformsVersion, colorsVersion: state.colorsVersion} : undefined;
  }
  /** @internal Mutable instance state for in-place native updates. */
  get instanceState(): InstanceState | undefined { return this._instances; }
  /** @internal */
  setInstanceState(state: InstanceState | undefined) { this._instances = state; }

  constructor(
    geometry: Geometry,
    material: MaterialState[] | MaterialState
  ) {
    super();
    aovIds.set(this, allocateAovId());

    this.geometry = geometry;
    this.materials = Array.isArray(material) ? material : [material];
  }

}
