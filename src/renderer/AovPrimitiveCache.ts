import type {AovSceneSource} from './aovScene.js';
import type {FlattendBVH} from './bvhAccel.js';
import type Geometry from '../scene/Geometry.js';
import {AOV_BACKGROUND_ID} from './aov.js';

/** Web AOV identity data is independent of camera, transforms and materials. */
export class AovPrimitiveCache {
  private blases = new WeakMap<ArrayBuffer, {
    geometry: Geometry; indices: Uint16Array | Uint32Array; topology: number;
    triangleIds?: Uint32Array; ids: Uint32Array;
  }>();
  private parts: Uint32Array[] = [];
  private tlasRecords = -1;
  private combined?: Uint32Array;

  get(source: Pick<AovSceneSource, 'blases' | 'geometries'>, tlas: FlattendBVH) {
    const parts = source.blases.map((blas, index) => {
      const geometry = source.geometries[index], indices = geometry.indexArray;
      const buffer = blas.bvh.buffer, triangleIds = blas.bvh.triangleIds;
      const cached = this.blases.get(buffer);
      if (cached && cached.geometry === geometry && cached.indices === indices &&
          cached.topology === geometry.topologyVersion && cached.triangleIds === triangleIds) return cached.ids;
      const bvh = new Uint32Array(buffer), ids = new Uint32Array(bvh.length / 4).fill(AOV_BACKGROUND_ID);
      matchSourceTriangles(bvh, indices, ids);
      // Builder metadata distinguishes displaced/duplicate index triples.
      if (triangleIds) for (let i = 0; i < triangleIds.length; i += 2) ids[triangleIds[i]] = triangleIds[i+1];
      this.blases.set(buffer, {geometry, indices, topology: geometry.topologyVersion, triangleIds, ids});
      return ids;
    });
    const tlasRecords = tlas.buffer.byteLength / 16;
    if (!this.combined || this.tlasRecords !== tlasRecords || parts.length !== this.parts.length ||
        parts.some((part, i) => part !== this.parts[i])) {
      const combined = new Uint32Array(tlasRecords + parts.reduce((count, part) => count + part.length, 0)).fill(AOV_BACKGROUND_ID);
      let offset = tlasRecords;
      for (const part of parts) { combined.set(part, offset); offset += part.length; }
      this.combined = combined; this.parts = parts; this.tlasRecords = tlasRecords;
    }
    return this.combined;
  }
}

/**
 * Writes the source triangle whose index triple equals each record's first
 * three words; the last duplicate wins. Triangles are bucketed by first index
 * in typed arrays, so a lookup compares only the triangles sharing that vertex.
 */
function matchSourceTriangles(bvh: Uint32Array, indices: Uint16Array | Uint32Array, ids: Uint32Array) {
  const triangles = indices.length / 3;
  let vertices = 0;
  for (let i = 0; i < indices.length; i += 3) if (indices[i] >= vertices) vertices = indices[i] + 1;
  const start = new Uint32Array(vertices + 1);
  for (let t = 0; t < triangles; t++) start[indices[t*3] + 1]++;
  for (let v = 0; v < vertices; v++) start[v + 1] += start[v];
  // Each bucket stores (second index, third index, triangle) contiguously, so
  // a lookup touches one random cache line instead of three.
  const entries = new Uint32Array(triangles * 3), next = start.slice(0, vertices);
  for (let t = 0; t < triangles; t++) {
    const e = next[indices[t*3]]++ * 3;
    entries[e] = indices[t*3 + 1]; entries[e + 1] = indices[t*3 + 2]; entries[e + 2] = t;
  }
  for (let record = 0; record < ids.length; record++) {
    const a = bvh[record*4];
    if (a >= vertices) continue;
    const b = bvh[record*4 + 1], c = bvh[record*4 + 2];
    for (let e = start[a + 1] * 3; (e -= 3) >= start[a] * 3;) {
      if (entries[e] === b && entries[e + 1] === c) { ids[record] = entries[e + 2]; break; }
    }
  }
}
