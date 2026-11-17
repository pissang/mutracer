import { attributeLength, attributeValue, indexStorage } from '../scene/attributeData.js';
import { read, write } from '../math/access.js';
import * as vec3 from '../math/sceneVec3.js';
import Geometry, { Attribute } from '../scene/Geometry.js';
import { accumulateVertexNormals } from './vertexNormals.js';

/** Computes smooth, area-weighted vertex normals into `geometry.normal`. */
export function generateVertexNormals(geometry: Geometry) {
  if (!geometry.vertexCount) {
    return;
  }
  // Explicit geometry helpers may run before the renderer is notified of edits.
  // Normalize their current input rather than consulting a revision cache.
  const indices = indexStorage(geometry.indices.array);
  geometry.normal = new Attribute(accumulateVertexNormals(geometry.position.array!, indices, geometry.vertexCount), 3);
}

/**
 * Splits indexed vertices where incident faces exceed the requested dihedral
 * angle, then generates normals for the resulting smoothing groups. This is
 * useful after displacement because a single indexed vertex cannot represent
 * both sides of a hard edge with different normals.
 */
export function generateCreasedVertexNormals(
  geometry: Geometry,
  creaseAngleDegrees = 180
) {
  // Explicit geometry helpers may run before the renderer is notified of edits.
  // Normalize their current input rather than consulting a revision cache.
  const indices = indexStorage(geometry.indices.array);
  const positions = geometry.position?.array;
  if (!indices || !positions || !attributeLength(indices) || !positions.length) {
    generateVertexNormals(geometry);
    return;
  }
  const creaseAngle = Math.min(Math.max(creaseAngleDegrees, 0), 180);
  if (creaseAngle >= 179.999) {
    generateVertexNormals(geometry);
    return;
  }

  interface NormalGroup {
    vertexIndex: number;
    sumX: number;
    sumY: number;
    sumZ: number;
  }
  const originalVertexCount = geometry.vertexCount;
  const groups = Array.from(
    { length: originalVertexCount },
    () => [] as NormalGroup[]
  );
  const generatedIndices = new Uint32Array(attributeLength(indices));
  const generatedPositions = Array.from(positions);
  const generatedUvs = geometry.uv ? Array.from(geometry.uv.array) : undefined;
  const generatedColors = geometry.color
    ? Array.from(geometry.color.array)
    : undefined;
  const generatedMaterialIndices = geometry.materialIndex
    ? Array.from(geometry.materialIndex.array)
    : undefined;
  let generatedVertexCount = originalVertexCount;
  const cosineThreshold = Math.cos((creaseAngle * Math.PI) / 180);

  const duplicateAttribute = (
    target: number[] | undefined,
    sourceIndex: number,
    itemSize: number
  ) => {
    if (!target) return;
    const offset = sourceIndex * itemSize;
    for (let component = 0; component < itemSize; component++) {
      target.push(target[offset + component]);
    }
  };

  for (let offset = 0; offset + 2 < attributeLength(indices); offset += 3) {
    const i0 = attributeValue(indices, offset);
    const i1 = attributeValue(indices, offset + 1);
    const i2 = attributeValue(indices, offset + 2);
    const ax = positions[i1 * 3] - positions[i0 * 3];
    const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
    const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const bx = positions[i2 * 3] - positions[i0 * 3];
    const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
    const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
    const faceX = ay * bz - az * by;
    const faceY = az * bx - ax * bz;
    const faceZ = ax * by - ay * bx;
    const faceLength = Math.hypot(faceX, faceY, faceZ);
    const unitX = faceLength > 1e-12 ? faceX / faceLength : 0;
    const unitY = faceLength > 1e-12 ? faceY / faceLength : 0;
    const unitZ = faceLength > 1e-12 ? faceZ / faceLength : 1;

    [i0, i1, i2].forEach((sourceIndex, corner) => {
      const vertexGroups = groups[sourceIndex];
      let selected: NormalGroup | undefined;
      let selectedDot = -Infinity;
      for (const group of vertexGroups) {
        const groupLength = Math.hypot(group.sumX, group.sumY, group.sumZ);
        const dot = groupLength > 1e-12
          ? (unitX * group.sumX + unitY * group.sumY + unitZ * group.sumZ) /
            groupLength
          : 1;
        if (dot >= cosineThreshold && dot > selectedDot) {
          selected = group;
          selectedDot = dot;
        }
      }
      if (!selected) {
        const vertexIndex = vertexGroups.length === 0
          ? sourceIndex
          : generatedVertexCount++;
        if (vertexIndex !== sourceIndex) {
          duplicateAttribute(generatedPositions, sourceIndex, 3);
          duplicateAttribute(
            generatedUvs,
            sourceIndex,
            geometry.uv?.itemSize ?? 2
          );
          duplicateAttribute(
            generatedColors,
            sourceIndex,
            geometry.color?.itemSize ?? 3
          );
          duplicateAttribute(
            generatedMaterialIndices,
            sourceIndex,
            geometry.materialIndex?.itemSize ?? 1
          );
        }
        selected = {
          vertexIndex,
          sumX: 0,
          sumY: 0,
          sumZ: 0
        };
        vertexGroups.push(selected);
      }
      selected.sumX += faceX;
      selected.sumY += faceY;
      selected.sumZ += faceZ;
      generatedIndices[offset + corner] = selected.vertexIndex;
    });
  }

  geometry.position = new Attribute(new Float32Array(generatedPositions), 3);
  geometry.indices = new Attribute(generatedIndices, 1);
  geometry.uv = generatedUvs
    ? new Attribute(new Float32Array(generatedUvs), geometry.uv!.itemSize)
    : undefined;
  geometry.color = generatedColors
    ? new Attribute(new Float32Array(generatedColors), geometry.color!.itemSize)
    : undefined;
  geometry.materialIndex = generatedMaterialIndices
    ? new Attribute(
        new Int32Array(generatedMaterialIndices),
        geometry.materialIndex!.itemSize
      )
    : undefined;
  geometry.tangent = undefined;
  generateVertexNormals(geometry);
}

const generatedVertexTangents = new WeakSet<Attribute<Float32Array>>();
/** @internal Distinguishes derivative fallback from an authored XYZ tangent. */
export function hasGeneratedVertexTangents(geometry: Geometry) {
  return !!geometry.tangent && generatedVertexTangents.has(geometry.tangent);
}

/** @internal Installs the byte-equivalent result of a native tangent kernel. */
export function installGeneratedVertexTangents(geometry: Geometry, tangents: Float32Array) {
  geometry.tangent = new Attribute(tangents, 3);
  generatedVertexTangents.add(geometry.tangent);
}

/** Generate a UV-aligned tangent for meshes that do not provide one. */
export function generateVertexTangents(geometry: Geometry) {
  if (!geometry.position || !geometry.uv || !geometry.normal) return;
  const count = geometry.vertexCount;
  if (!count) return;
  const tangents = new Float32Array(count * 3);
  computeVertexTangents(geometry, new Float32Array(count * 3), tangents);
  geometry.tangent = new Attribute(tangents, 3);
  generatedVertexTangents.add(geometry.tangent);
}

const dynamicTangentScratch = new WeakMap<Geometry, Float32Array>();
/** @internal Refreshes generated tangents while retaining the attribute and scratch arrays. */
export function updateDynamicTangents(geometry: Geometry) {
  if (!geometry.position || !geometry.uv || !geometry.normal) return;
  const count = geometry.vertexCount;
  if (!count) return;
  let accumulated = dynamicTangentScratch.get(geometry);
  if (accumulated?.length !== count * 3) {
    accumulated = new Float32Array(count * 3); dynamicTangentScratch.set(geometry, accumulated);
  }
  if (geometry.tangent?.array.length !== count * 3) geometry.tangent = new Attribute(new Float32Array(count * 3), 3);
  computeVertexTangents(geometry, accumulated, geometry.tangent.array);
  generatedVertexTangents.add(geometry.tangent);
}

function computeVertexTangents(geometry: Geometry, accumulated: Float32Array, tangents: Float32Array) {
  const uvs = geometry.uv?.array;
  const normals = geometry.normal?.array;
  const positions = geometry.position?.array;
  if (!uvs || !normals || !positions || !geometry.vertexCount) {
    return;
  }

  const vertexCount = geometry.vertexCount;
  accumulated.fill(0);
  // Explicit geometry helpers may run before the renderer is notified of edits.
  // Normalize their current input rather than consulting a revision cache.
  const indices = indexStorage(geometry.indices.array);
  const count = indices ? attributeLength(indices) : vertexCount;

  for (let offset = 0; offset + 2 < count; offset += 3) {
    const i0 = indices ? attributeValue(indices, offset) : offset;
    const i1 = indices ? attributeValue(indices, offset + 1) : offset + 1;
    const i2 = indices ? attributeValue(indices, offset + 2) : offset + 2;
    const x1 = positions[i1 * 3] - positions[i0 * 3];
    const y1 = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
    const z1 = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const x2 = positions[i2 * 3] - positions[i0 * 3];
    const y2 = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
    const z2 = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
    const s1 = uvs[i1 * 2] - uvs[i0 * 2];
    const t1 = uvs[i1 * 2 + 1] - uvs[i0 * 2 + 1];
    const s2 = uvs[i2 * 2] - uvs[i0 * 2];
    const t2 = uvs[i2 * 2 + 1] - uvs[i0 * 2 + 1];
    const determinant = s1 * t2 - s2 * t1;
    if (Math.abs(determinant) < 1e-12) continue;
    const inverse = 1 / determinant;
    const tx = (x1 * t2 - x2 * t1) * inverse;
    const ty = (y1 * t2 - y2 * t1) * inverse;
    const tz = (z1 * t2 - z2 * t1) * inverse;
    for (let corner = 0; corner < 3; corner++) {
      const index = corner === 0 ? i0 : corner === 1 ? i1 : i2;
      accumulated[index * 3] += tx;
      accumulated[index * 3 + 1] += ty;
      accumulated[index * 3 + 2] += tz;
    }
  }


  for (let index = 0; index < vertexCount; index++) {
    const base = index * 3;
    const nx = normals[base];
    const ny = normals[base + 1];
    const nz = normals[base + 2];
    const projection = accumulated[base] * nx
      + accumulated[base + 1] * ny
      + accumulated[base + 2] * nz;
    let tx = accumulated[base] - nx * projection;
    let ty = accumulated[base + 1] - ny * projection;
    let tz = accumulated[base + 2] - nz * projection;
    const length = Math.hypot(tx, ty, tz);
    if (length > 1e-8) {
      tx /= length;
      ty /= length;
      tz /= length;
    } else {
      tx = ty = tz = 0;
    }
    tangents[base] = tx;
    tangents[base + 1] = ty;
    tangents[base + 2] = tz;
  }

}

export function updateBoundingBox(geometry: Geometry) {
  const posArr = geometry.position.array;
  const min = geometry.boundingBox.min;
  const max = geometry.boundingBox.max;
  if (posArr && posArr.length) {
    vec3.set(min, posArr[0], posArr[1], posArr[2]);
    vec3.set(max, posArr[0], posArr[1], posArr[2]);
    for (let i = 3; i < posArr.length; ) {
      const x = posArr[i++];
      const y = posArr[i++];
      const z = posArr[i++];
      if (x < read(min, 0)) {
        write(min, 0, x);
      }
      if (y < read(min, 1)) {
        write(min, 1, y);
      }
      if (z < read(min, 2)) {
        write(min, 2, z);
      }

      if (x > read(max, 0)) {
        write(max, 0, x);
      }
      if (y > read(max, 1)) {
        write(max, 1, y);
      }
      if (z > read(max, 2)) {
        write(max, 2, z);
      }
    }
  }
}
