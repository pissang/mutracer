import Geometry, {Attribute} from '../scene/Geometry.js';
import MaterialState from '../scene/MaterialState.js';
import { vec2, vec3 } from '../math.js';
import { set as setVec3, normalize as normalizeVec3 } from '../math/sceneVec3.js';
import { read, write } from '../math/access.js';
import { attributeValue, attributeLength } from '../scene/attributeData.js';

// Use the same normal offset for software BLASes and native procedural AABBs.
export function displacementBaseGeometry(geometry: Geometry, bias: number): Geometry {
  if (bias === 0) return geometry;
  const positions = geometry.position.array.slice();
  const normals = geometry.normal.array;
  for (let vertex = 0; vertex < geometry.vertexCount; vertex++) {
    const p = vertex * geometry.position.itemSize, n = vertex * geometry.normal.itemSize;
    const length = Math.hypot(normals[n], normals[n + 1], normals[n + 2]);
    if (length > 0) {
      for (let axis = 0; axis < 3; axis++) positions[p + axis] += normals[n + axis] / length * bias;
    }
  }
  const result = new Geometry(geometry);
  result.position = new Attribute(positions, geometry.position.itemSize);
  return result;
}

// Shared CPU displacement math. Pixel acquisition and caching belong to adapters.
export function computeDisplacementMinmax(w: number, sourceChannels: number,
  readHeight: (index: number) => number) {
  const minmaxData: Uint8Array[] = [];
  const maxMipLevel = Math.log2(w);
  let mipmapSize = w;
  for (let lod = 0; lod <= maxMipLevel; lod++) {
    const prevMinmaxData = minmaxData[Math.max(0, lod - 1)];
    const minmax = new Uint8Array(mipmapSize * mipmapSize * 2);
    minmaxData.push(minmax);
    const channels = lod === 0 ? sourceChannels : 2;
    for (let y = 0; y < mipmapSize; y++) {
      for (let x = 0; x < mipmapSize; x++) {
        const yx = y * mipmapSize + x;
        const idx = yx * channels;
        let min = 0;
        let max = 0;
        if (lod == 0) {
          min = readHeight(idx);
          max = min;
          if (y < mipmapSize - 1 && x < mipmapSize - 1) {
            const h = readHeight(idx + (mipmapSize + 1) * channels);
            min = Math.min(min, h);
            max = Math.max(max, h);
          }
          if (y < mipmapSize - 1) {
            const h = readHeight(idx + mipmapSize * channels);
            min = Math.min(min, h);
            max = Math.max(max, h);
          }
          if (x < mipmapSize - 1) {
            const h = readHeight(idx + channels);
            min = Math.min(min, h);
            max = Math.max(max, h);
          }
        } else {
          const x2 = x * 2;
          const y2 = y * 2;
          const prevMipmapSize = mipmapSize * 2;
          const idx2 = (y2 * prevMipmapSize + x2) * channels;
          const idx2_0 = idx2;
          const idx2_1 = idx2 + channels;
          const idx2_2 = idx2 + prevMipmapSize * channels;
          const idx2_3 = idx2 + prevMipmapSize * channels + channels;
          min = Math.min(
            prevMinmaxData[idx2_0],
            prevMinmaxData[idx2_1],
            prevMinmaxData[idx2_2],
            prevMinmaxData[idx2_3]
          );
          max = Math.max(
            prevMinmaxData[idx2_0 + 1],
            prevMinmaxData[idx2_1 + 1],
            prevMinmaxData[idx2_2 + 1],
            prevMinmaxData[idx2_3 + 1]
          );
        }
        minmax[yx * 2] = min;
        minmax[yx * 2 + 1] = max;
      }
    }
    mipmapSize = mipmapSize / 2;
  }

  return minmaxData;
}

function sphericalProjection<T0 extends vec3.Vec3Array, T1 extends vec2.Vec2Array>(n: T0, uv: T1) {
  const theta = Math.atan2(read(n, 0), read(n, 2)) / (2.0 * Math.PI) + 0.5;
  const phi = Math.acos(read(n, 1)) / Math.PI;
  vec2.set(uv, theta, 1.0 - phi);
}

export function sphericalProjectionTriangle<T0 extends vec3.Vec3Array, T1 extends vec3.Vec3Array, T2 extends vec3.Vec3Array, T3 extends vec2.Vec2Array, T4 extends vec2.Vec2Array, T5 extends vec2.Vec2Array>(
  na: T0,
  nb: T1,
  nc: T2,
  uvA: T3,
  uvB: T4,
  uvC: T5
) {
  sphericalProjection(na, uvA);
  sphericalProjection(nb, uvB);
  sphericalProjection(nc, uvC);
  let onSeam = false;
  for (let i = 0; i < 2; i++) {
    if (
      Math.abs(read(uvA, i) - read(uvB, i)) > 0.5 ||
      Math.abs(read(uvA, i) - read(uvC, i)) > 0.5 ||
      Math.abs(read(uvB, i) - read(uvC, i)) > 0.5
    ) {
      const maxU = Math.max(read(uvA, i), read(uvB, i), read(uvC, i));
      if (maxU - read(uvA, i) > 0.5) {
        write(uvA, i, read(uvA, i) + 1.0);
        onSeam = true;
      }
      if (maxU - read(uvB, i) > 0.5) {
        write(uvB, i, read(uvB, i) + 1.0);
        onSeam = true;
      }
      if (maxU - read(uvC, i) > 0.5) {
        write(uvC, i, read(uvC, i) + 1.0);
        onSeam = true;
      }
    }
  }

  return onSeam;
}

function getMaxAxisIndex<T0 extends vec3.Vec3Array>(n: T0) {
  const x = Math.abs(read(n, 0));
  const y = Math.abs(read(n, 1));
  const z = Math.abs(read(n, 2));
  return x > y && x > z ? 0 : y > z ? 1 : 2;
}

export function triplanarProjectionTriangle<T0 extends vec3.Vec3Array, T1 extends vec3.Vec3Array, T2 extends vec3.Vec3Array, T3 extends vec3.Vec3Array, T4 extends vec3.Vec3Array, T5 extends vec3.Vec3Array, T6 extends vec2.Vec2Array, T7 extends vec2.Vec2Array, T8 extends vec2.Vec2Array>(
  a: T0,
  b: T1,
  c: T2,
  na: T3,
  nb: T4,
  nc: T5,
  uvA: T6,
  uvB: T7,
  uvC: T8
) {
  const tmpMaxX = Math.max(Math.abs(read(na, 0)), Math.abs(read(nb, 0)), Math.abs(read(nc, 0)));
  const tmpMaxY = Math.max(Math.abs(read(na, 1)), Math.abs(read(nb, 1)), Math.abs(read(nc, 1)));
  const tmpMaxZ = Math.max(Math.abs(read(na, 2)), Math.abs(read(nb, 2)), Math.abs(read(nc, 2)));

  if (tmpMaxX > tmpMaxY && tmpMaxX > tmpMaxZ) {
    // yz
    vec2.set(uvA, read(a, 1), read(a, 2));
    vec2.set(uvB, read(b, 1), read(b, 2));
    vec2.set(uvC, read(c, 1), read(c, 2));
  } else if (tmpMaxY > tmpMaxX && tmpMaxY > tmpMaxZ) {
    // xz
    vec2.set(uvA, read(a, 0), read(a, 2));
    vec2.set(uvB, read(b, 0), read(b, 2));
    vec2.set(uvC, read(c, 0), read(c, 2));
  } else {
    // xy
    vec2.set(uvA, read(a, 0), read(a, 1));
    vec2.set(uvB, read(b, 0), read(b, 1));
    vec2.set(uvC, read(c, 0), read(c, 1));
  }
}

function findRoots(
  triAabbMinP: Float32Array,
  triAabbMaxP: Float32Array,
  maxDepth: number,
  roots: Float64Array[]
) {
  let d = vec2.sub(vec2.create(), triAabbMaxP, triAabbMinP);
  let size = Math.max(d[0], d[1]);
  let startMipLevel =
    maxDepth - Math.floor(Math.log2(Math.floor(1.0 / size))) - 1;
  if (!isFinite(startMipLevel)) {
    startMipLevel = maxDepth;
  }
  startMipLevel = Math.max(startMipLevel, 0);
  let rootCount = 0;
  while (true) {
    const mipSize = Math.pow(2.0, maxDepth - startMipLevel);
    const minTexelX = Math.floor(mipSize * read(triAabbMinP, 0));
    const minTexelY = Math.floor(mipSize * read(triAabbMinP, 1));
    const maxTexelX = Math.floor(mipSize * read(triAabbMaxP, 0));
    const maxTexelY = Math.floor(mipSize * read(triAabbMaxP, 1));

    if (
      (maxTexelX - minTexelX < 2 &&
        maxTexelY - minTexelY < 2 &&
        startMipLevel >= 0) ||
      startMipLevel >= maxDepth
    ) {
      for (let y = minTexelY; y <= maxTexelY; y++) {
        for (let x = minTexelX; x <= maxTexelX; x++) {
          if (rootCount < roots.length) {
            setVec3(
              roots[rootCount],
              Math.floor(x),
              Math.floor(y),
              startMipLevel
            );
            rootCount++;
          }
        }
      }
      break;
    }

    startMipLevel++;
  }

  return rootCount;
}

export function conservativeTrianglesDisplacementRange(triangleCount: number): Float32Array | undefined {
  if (triangleCount < 100_000) return undefined;
  const ranges = new Float32Array(triangleCount * 2);
  for (let i = 0; i < triangleCount; i++) ranges[i * 2 + 1] = 1;
  return ranges;
}

export function computeTrianglesDisplacementRange(geometry: Geometry,
  minmaxData: Uint8Array[], width: number, isFlipY: boolean, material: MaterialState) {
  const indices = geometry.indexArray;
  const uvs = geometry.uv?.array;
  const uvProjection = material.displacementUvProjection;
  if (!uvs && uvProjection === 'none') throw new Error(
    'UV displacement requires texture coordinates; use triplanar, spherical, or cylindrical projection for a UV-less mesh.');
  const conservative = conservativeTrianglesDisplacementRange(attributeLength(indices) / 3);
  if (conservative) return conservative;
  const maxDepth = Math.log2(width);
  const trianglesDisplacementRange = new Float32Array((attributeLength(indices) / 3) * 2);
  const normal = geometry.normal!.array;
  const position = geometry.position!.array;

  const uv1 = vec2.create();
  const uv2 = vec2.create();
  const uv3 = vec2.create();

  const p1 = vec3.create();
  const p2 = vec3.create();
  const p3 = vec3.create();

  const n1 = vec3.create();
  const n2 = vec3.create();
  const n3 = vec3.create();

  const isTriplanar = uvProjection === 'triplanar';
  const isSpherical = uvProjection === 'spherical';
  const isCylindrical = uvProjection === 'cylindrical';
  const uvScale = material.displacementUvProjectionScale;

  const minUv = vec2.create();
  const maxUv = vec2.create();

  const roots: Float64Array[] = [];
  for (let i = 0; i < 100; i++) {
    roots.push(new Float64Array(3));
  }
  for (let i = 0; i < attributeLength(indices); i += 3) {
    const i1 = attributeValue(indices, i);
    const i2 = attributeValue(indices, i + 1);
    const i3 = attributeValue(indices, i + 2);
    const i1_2 = i1 * 2;
    const i2_2 = i2 * 2;
    const i3_2 = i3 * 2;
    const i1_3 = i1 * 3;
    const i2_3 = i2 * 3;
    const i3_3 = i3 * 3;

    if (uvs) {
      vec2.set(uv1, attributeValue(uvs, i1_2), attributeValue(uvs, i1_2 + 1));
      vec2.set(uv2, attributeValue(uvs, i2_2), attributeValue(uvs, i2_2 + 1));
      vec2.set(uv3, attributeValue(uvs, i3_2), attributeValue(uvs, i3_2 + 1));
    } else {
      vec2.set(uv1, 0, 0);
      vec2.set(uv2, 0, 0);
      vec2.set(uv3, 0, 0);
    }

    let onSeam = false;
    if (isTriplanar || isSpherical || isCylindrical) {
      setVec3(n1, attributeValue(normal, i1_3), attributeValue(normal, i1_3 + 1), attributeValue(normal, i1_3 + 2));
      setVec3(n2, attributeValue(normal, i2_3), attributeValue(normal, i2_3 + 1), attributeValue(normal, i2_3 + 2));
      setVec3(n3, attributeValue(normal, i3_3), attributeValue(normal, i3_3 + 1), attributeValue(normal, i3_3 + 2));
      normalizeVec3(n1, n1);
      normalizeVec3(n2, n2);
      normalizeVec3(n3, n3);
      if (isTriplanar || isSpherical || isCylindrical) {
        setVec3(p1, attributeValue(position, i1_3), attributeValue(position, i1_3 + 1), attributeValue(position, i1_3 + 2));
        setVec3(p2, attributeValue(position, i2_3), attributeValue(position, i2_3 + 1), attributeValue(position, i2_3 + 2));
        setVec3(p3, attributeValue(position, i3_3), attributeValue(position, i3_3 + 1), attributeValue(position, i3_3 + 2));
      }
      if (isTriplanar) {
        // Is on the seam. Needs full prism to avoid empty seams.
        const xMaxIndex = getMaxAxisIndex(n1);
        const yMaxIndex = getMaxAxisIndex(n2);
        const zMaxIndex = getMaxAxisIndex(n3);
        if (!(xMaxIndex === yMaxIndex && yMaxIndex === zMaxIndex)) {
          onSeam = true;
        }
        /* prettier-ignore */
        triplanarProjectionTriangle(
          p1, p2, p3,
          n1, n2, n3,
          uv1, uv2, uv3
        );
      } else if (isSpherical) {
        normalizeVec3(p1, p1);
        normalizeVec3(p2, p2);
        normalizeVec3(p3, p3);
        onSeam = sphericalProjectionTriangle(p1, p2, p3, uv1, uv2, uv3);
      } else {
        const u1 = Math.atan2(p1[2], p1[0]) / (Math.PI * 2) + 0.5;
        const u2 = Math.atan2(p2[2], p2[0]) / (Math.PI * 2) + 0.5;
        const u3 = Math.atan2(p3[2], p3[0]) / (Math.PI * 2) + 0.5;
        vec2.set(uv1, u1, p1[1]);
        vec2.set(uv2, u2, p2[1]);
        vec2.set(uv3, u3, p3[1]);
        onSeam = Math.max(u1, u2, u3) - Math.min(u1, u2, u3) > 0.5;
      }
    }
    vec2.scale(uv1, uv1, uvScale);
    vec2.scale(uv2, uv2, uvScale);
    vec2.scale(uv3, uv3, uvScale);

    // TODO PDM don't have zero area triangle issue.

    let minHeight = Infinity;
    let maxHeight = -Infinity;

    if (onSeam) {
      minHeight = 0.0;
      maxHeight = 255.0;
    } else {
      vec2.copy(maxUv, uv1);
      vec2.copy(minUv, uv1);
      vec2.min(minUv, minUv, uv2);
      vec2.min(minUv, minUv, uv3);
      vec2.max(maxUv, maxUv, uv2);
      vec2.max(maxUv, maxUv, uv3);

      const rootCount = findRoots(minUv, maxUv, maxDepth, roots);

      for (let k = 0; k < rootCount; k++) {
        const mipLevel = read(roots[k], 2);
        const mipSize = Math.pow(2, maxDepth - mipLevel);
        const minmax = minmaxData[mipLevel];
        const x = ((read(roots[k], 0) % mipSize) + mipSize) % mipSize;
        let y = ((read(roots[k], 1) % mipSize) + mipSize) % mipSize;
        if (isFlipY) {
          y = mipSize - y - 1;
        }
        const idx = (y * mipSize + x) * 2;

        minHeight = Math.min(minHeight, minmax[idx]);
        maxHeight = Math.max(maxHeight, minmax[idx + 1]);
      }
    }

    // TODO this will cause flat surface optimization fail.
    // But not adding bias will leads to small gap between flat surface and displaced surface.
    trianglesDisplacementRange[(i / 3) * 2] = Math.max(
      (Math.floor(minHeight) - 4) / 255,
      0
    );
    trianglesDisplacementRange[(i / 3) * 2 + 1] = Math.min(
      (Math.ceil(maxHeight) + 4) / 255,
      1
    );
  }

  return trianglesDisplacementRange;
}

/** Conservative source-order AABBs for the actual displacement prism. */
export function displacementPrismAabbs(geometry: Geometry, displacementScale: number): Float32Array {
  const indices = geometry.indexArray;
  const count = Math.floor(indices.length / 3);
  const boxes = new Float32Array(count * 6);
  for (let t = 0; t < count; t++) {
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const positions = geometry.position.array;
    const ux = positions[ib]-positions[ia], uy = positions[ib+1]-positions[ia+1], uz = positions[ib+2]-positions[ia+2];
    const vx = positions[ic]-positions[ia], vy = positions[ic+1]-positions[ia+1], vz = positions[ic+2]-positions[ia+2];
    const fx = uy*vz-uz*vy, fy = uz*vx-ux*vz, fz = ux*vy-uy*vx;
    const faceLength = Math.hypot(fx,fy,fz);
    for (let c = 0; c < 3; c++) {
      const v = indices[t * 3 + c];
      const nx = geometry.normal.array[v * 3], ny = geometry.normal.array[v * 3 + 1], nz = geometry.normal.array[v * 3 + 2];
      const length = Math.hypot(nx, ny, nz);
      const cosine = Math.abs((nx*fx+ny*fy+nz*fz)/((length || 1)*(faceLength || 1)));
      const extrusion = cosine > 0 ? displacementScale/cosine : 0;
      for (let a = 0; a < 3; a++) {
        const position = geometry.position.array[v * 3 + a], n = geometry.normal.array[v * 3 + a] / (length || 1);
        const p0 = position;
        const p1 = position + n * extrusion;
        minimum[a] = Math.min(minimum[a], p0, p1); maximum[a] = Math.max(maximum[a], p0, p1);
      }
    }
    for (let a = 0; a < 3; a++) {
      const padding = Math.max(1, Math.abs(minimum[a]), Math.abs(maximum[a])) * 1e-6;
      minimum[a] -= padding; maximum[a] += padding;
    }
    for (let a = 0; a < 3; a++) {
      boxes[t * 6 + a] = minimum[a]; boxes[t * 6 + a + 3] = maximum[a];
    }
  }
  return boxes;
}
