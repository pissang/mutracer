import type { Vec3 } from '../types.js';
import { generateVertexNormals } from '../util/geometry.js';
import * as vec3 from '../math/sceneVec3.js';
import { attributeLength, attributeValue } from './attributeData.js';

type AttributeData = Float32Array | Uint16Array | Uint32Array | Int32Array;
export class Attribute<T extends AttributeData = AttributeData> {
  array: T;
  itemSize: number;
  constructor(array: T, itemSize: number) {
    this.array = array;
    this.itemSize = itemSize;
  }

  // Keep concrete storage through calls: native generic class layouts differ.
  static getItem<A extends Attribute>(attr: A, out: number[], vertexIndex: number) {
    const array = attr.array;
    const itemSize = attr.itemSize;
    const offset = vertexIndex * itemSize;
    for (let i = 0; i < itemSize; i++) {
      out[i] = attributeValue(array, offset + i);
    }
  }

  static getCount<A extends Attribute>(attr: A) {
    return attributeLength(attr.array) / attr.itemSize;
  }
}

// Retain union-parameter Attributes accepted by the public API, while also
// naming concrete instantiations so native union conversion has exact arms.
type IndexAttribute = Attribute<Uint16Array | Uint32Array> | Attribute<Uint16Array> | Attribute<Uint32Array>;
function sequentialIndices(count: number): Attribute<Uint32Array> {
  const indices = new Uint32Array(count);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return new Attribute(indices, 1);
}

export type AttributeName =
  | 'position'
  | 'normal'
  | 'tangent'
  | 'uv'
  | 'uv1'
  | 'color';

/** Triangle geometry construction data. */
export interface GeometryInit {
  /** Required vertex positions in scene units, itemSize 3. */
  position: Attribute<Float32Array>;
  /** Triangle vertex indices, itemSize 1. Default: sequential indices 0..vertexCount-1. */
  indices?: IndexAttribute;
  /** Vertex normals, itemSize 3. Default: generated smooth area-weighted normals. */
  normal?: Attribute<Float32Array>;
  /** Vertex tangents (XYZ, optional W handedness). Default undefined. */
  tangent?: Attribute<Float32Array>;
  /** Primary UV coordinates. Default undefined. */
  uv?: Attribute<Float32Array>;
  /** Secondary UV coordinates. Default undefined. */
  uv1?: Attribute<Float32Array>;
  /** Vertex RGB colors. Default undefined. */
  color?: Attribute<Float32Array>;
  /** Raw per-vertex material indices, itemSize 1. Default undefined selects material 0. */
  materialIndex?: Attribute<Int32Array>;
}

/** Triangle mesh data. Only position is required; missing indices and normals are generated at construction. */
export default class Geometry {
  /** Incremented by either update method. Default `0`. */
  version = 0;
  private _topologyVersion = 0;
  /** Index/material-index revision, advanced by markUpdated(). Default `0`. */
  get topologyVersion() { return this._topologyVersion; }
  /**
   * Hint that vertices change often (skinning, morph targets). Keeps a built-in
   * BVH2 layout that can be refit in place. Default `false`.
   */
  dynamic = false;
  /** Required vertex positions in scene units; provided by the constructor. */
  position: Attribute<Float32Array>;
  /** Vertex normals; supplied or generated at construction. */
  normal: Attribute<Float32Array>;
  /** Optional vertex tangents (XYZ, optional W handedness). Default undefined. */
  tangent?: Attribute<Float32Array>;
  /** Optional primary texture coordinates. Default undefined. */
  uv?: Attribute<Float32Array>;
  /** Optional secondary UV set (glTF TEXCOORD_1 / Three.js uv1). Default undefined. */
  uv1?: Attribute<Float32Array>;
  /** Optional vertex RGB colors. Default undefined. */
  color?: Attribute<Float32Array>;
  /**
   * Required triangle vertex indices; three entries per triangle.
   * Uint16 input may retain a cached Uint32 copy, costing 4 extra bytes per index.
   */
  indices: IndexAttribute;
  private _indexSource: Uint16Array | Uint32Array | undefined;
  private _indexVersion = -1;
  private _indices32 = new Uint32Array(0);

  /** @internal Canonical CPU/GPU indices; public index storage remains caller-owned. */
  get indexArray(): Uint32Array {
    const source = this.indices.array;
    if (source instanceof Uint32Array) {
      if (this._indexSource) {
        this._indexSource = undefined;
        this._indices32 = new Uint32Array(0);
        this._indexVersion = -1;
      }
      return source;
    }
    if (this._indexSource !== source || this._indexVersion !== this.topologyVersion || this._indices32.length !== source.length) {
      this._indices32 = new Uint32Array(source);
      this._indexSource = source;
      this._indexVersion = this.topologyVersion;
    }
    return this._indices32;
  }
  /** Optional per-vertex raw material indices, itemSize 1. All three triangle corners must match. Default undefined selects material 0. */
  materialIndex?: Attribute<Int32Array>;

  /** Local-space bounds in scene units; initial min/max are `[0, 0, 0]`. */
  boundingBox: { min: Vec3; max: Vec3 } = {
    min: vec3.create(),
    max: vec3.create()
  };
  constructor(data: GeometryInit) {
    this.position = data.position;
    this.indices = data.indices ?? sequentialIndices(this.vertexCount);
    this.normal = data.normal ?? new Attribute(new Float32Array(this.vertexCount * 3), 3);
    if (!data.normal) generateVertexNormals(this);

    this.tangent = data.tangent;
    this.uv = data.uv;
    this.uv1 = data.uv1;
    this.color = data.color;
    this.materialIndex = data.materialIndex;
  }

  /**
   * Call after index/material-index edits or a general geometry update.
   * Advances version and topologyVersion to request topology processing and
   * BVH rebuilding. For vertex-only edits with unchanged indices
   * and materialIndex, use markVerticesUpdated() to allow refitting instead.
   * Neither notification recalculates normals or tangents.
   * Replacing a mesh's Geometry object is detected without this call.
   */
  markUpdated() {
    this._topologyVersion++;
    this.version++;
    return this;
  }

  /**
   * Call after editing vertex attributes without changing indices or materialIndex.
   * Advances version while preserving topologyVersion, allowing vertex-only uploads.
   * With stable arrays, lengths and item sizes, the next render refits supported
   * BVHs or rebuilds when needed. Changed storage or displacement still requires
   * full scene data preparation. Does not recalculate normals or tangents.
   */
  markVerticesUpdated() {
    this.version++;
    return this;
  }

  /** Returns the number of vertices in the position attribute. */
  get vertexCount() {
    return this.position.array.length / this.position.itemSize;
  }

  /** Number of triangles in the index attribute. */
  get triangleCount() {
    return attributeLength(this.indices.array) / 3;
  }




}
