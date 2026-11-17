import { attributeValue } from '../scene/attributeData.js';
import * as vec3 from '../math/sceneVec3.js';

/**
 * Smooth vertex normals: each triangle adds its unnormalized face normal (whose
 * length is twice its area) to its three vertices, then every sum is normalized.
 * Without indices, consecutive vertex triples form the triangles.
 */
export function accumulateVertexNormals(positions: ArrayLike<number>, indices: Uint32Array | undefined,
  vertexCount: number): Float32Array {
  const normals = new Float32Array(positions.length);
  const p1 = vec3.create();
  const p2 = vec3.create();
  const p3 = vec3.create();
  const v21 = vec3.create();
  const v32 = vec3.create();
  const n = vec3.create();

  const len = indices ? indices.length : vertexCount;
  let i1, i2, i3;
  for (let f = 0; f < len; ) {
    if (indices) {
      i1 = attributeValue(indices, f++);
      i2 = attributeValue(indices, f++);
      i3 = attributeValue(indices, f++);
    } else {
      i1 = f++;
      i2 = f++;
      i3 = f++;
    }
    vec3.set(p1, positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    vec3.set(p2, positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
    vec3.set(p3, positions[i3 * 3], positions[i3 * 3 + 1], positions[i3 * 3 + 2]);
    vec3.sub(v21, p1, p2);
    vec3.sub(v32, p2, p3);
    vec3.cross(n, v21, v32);
    for (let i = 0; i < 3; i++) {
      normals[i1 * 3 + i] = normals[i1 * 3 + i] + n[i];
      normals[i2 * 3 + i] = normals[i2 * 3 + i] + n[i];
      normals[i3 * 3 + i] = normals[i3 * 3 + i] + n[i];
    }
  }

  for (let i = 0; i < normals.length; ) {
    vec3.set(n, normals[i], normals[i + 1], normals[i + 2]);
    vec3.normalize(n, n);
    normals[i++] = n[0];
    normals[i++] = n[1];
    normals[i++] = n[2];
  }
  return normals;
}
