import type Geometry from '../scene/Geometry.js';
import type MaterialState from '../scene/MaterialState.js';
import type { vec3 } from '../math.js';
import type { FlattendBVH } from './bvhAccel.js';

// The update algorithm needs no renderer resources or browser scene facade.
export interface GeometryUpdateMesh { geometry: Geometry; materials: MaterialState[]; }
export interface GeometryUpdateBinding<M extends GeometryUpdateMesh = GeometryUpdateMesh> {
  mesh: M;
  geometry: Geometry;
  bvhBounds: [vec3.Vec3Array, vec3.Vec3Array];
}
export interface GeometryUpdateRegion { vertexOffset: number; indexOffset: number; materialIndices: number[]; }
export interface GeometryUpdateState<M extends GeometryUpdateMesh = GeometryUpdateMesh> {
  geometry: Geometry;
  mergedAttributes?: boolean;
  geometries: Geometry[];
  geometryRegions: Map<Geometry, GeometryUpdateRegion>;
  geometryStates: Map<Geometry, {topologyVersion: number; indices: Geometry['indices']['array']; indexCount: number}>;
  instanceBindings: GeometryUpdateBinding<M>[];
  blases: {bvh: FlattendBVH}[];
}
