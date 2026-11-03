// Binned SAH BVH builder ported from TinyBVH's reference builder
// (`BVH::Build( nodeIdx, depth )` in tiny_bvh.h at commit
// 0e4584287823252cf83f0e9cd072848bec5f79c5, https://github.com/jbikker/tinybvh).
// Copyright (c) 2024-2026 Jacco Bikker / Breda University of Applied Sciences.
// MIT License, see src/tinybvh/LICENSE.
//
// By default, like the reference, it bins primitive centroids into 8 bins on all three
// axes, sweeps the bins for the lowest surface area heuristic cost and stops
// splitting when a leaf is cheaper (C_INT = C_TRAV = 1). Siblings are stored
// next to each other: an interior node's children are leftFirst and
// leftFirst + 1. Unlike the reference, node 1 is not left unused, the task
// stack grows instead of turning a node into a leaf after 512 entries, and
// arithmetic is float64: near-equal split costs can resolve differently from
// TinyBVH's float32, giving trees of the same quality that are not
// byte-identical.

const BINS = 8;
const C_INT = 1;
const C_TRAV = 1;
const FAR = 1e30;

export interface BinnedSahBvh {
  nodeCount: number;
  /** Per node: min x, y, z, max x, y, z. */
  bounds: Float32Array;
  /** Interior node: index of the left child. Leaf: first slot in primIndices. */
  leftFirst: Uint32Array;
  /** Primitive count of a leaf; 0 for interior nodes. */
  primCount: Uint32Array;
  /** Primitive indices referenced by leaves. */
  primIndices: Uint32Array;
}

// Scratch shared by all builds; the builder is synchronous.
const defaultBinMin = new Float64Array(3 * BINS * 3);
const defaultBinMax = new Float64Array(3 * BINS * 3);
const defaultBinCount = new Uint32Array(3 * BINS);
// Per split position: half area times primitive count of each side.
const defaultLeftCost = new Float64Array(BINS - 1);
const defaultRightCost = new Float64Array(BINS - 1);

/**
 * Bin of a centroid along one axis. Binning and partitioning both use this,
 * so every primitive ends up on the side whose bounds include its bin.
 */
function binOf(center: number, nodeMin: number, scale: number, bins: number) {
  const bin = ((center - nodeMin) * scale) | 0;
  return bin < 0 ? 0 : bin > bins - 1 ? bins - 1 : bin;
}

function growBin(
  binMin: Float64Array, binMax: Float64Array, o: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number
) {
  binMin[o] = Math.min(binMin[o], minX);
  binMin[o + 1] = Math.min(binMin[o + 1], minY);
  binMin[o + 2] = Math.min(binMin[o + 2], minZ);
  binMax[o] = Math.max(binMax[o], maxX);
  binMax[o + 1] = Math.max(binMax[o + 1], maxY);
  binMax[o + 2] = Math.max(binMax[o + 2], maxZ);
}

/**
 * Builds a binary BVH over axis-aligned boxes.
 * @param aabbs min x, y, z, max x, y, z for each primitive.
 * @param count number of primitives in `aabbs`.
 * @param bins SAH resolution; default 8 retains the shared/native build contract.
 */
export function buildBinnedSahBvh(aabbs: Float32Array, count: number, bins = BINS): BinnedSahBvh {
  const BINS = bins;
  const binMin = bins === 8 ? defaultBinMin : new Float64Array(3 * bins * 3);
  const binMax = bins === 8 ? defaultBinMax : new Float64Array(3 * bins * 3);
  const binCount = bins === 8 ? defaultBinCount : new Uint32Array(3 * bins);
  const leftCost = bins === 8 ? defaultLeftCost : new Float64Array(bins - 1);
  const rightCost = bins === 8 ? defaultRightCost : new Float64Array(bins - 1);
  const capacity = Math.max(1, count * 2 - 1);
  const bounds = new Float32Array(capacity * 6);
  const leftFirst = new Uint32Array(capacity);
  const primCount = new Uint32Array(capacity);
  const primIndices = new Uint32Array(count);
  if (count === 0) {
    return { nodeCount: 0, bounds, leftFirst, primCount, primIndices };
  }

  const centers = new Float32Array(count * 3);
  let rootMinX = FAR, rootMinY = FAR, rootMinZ = FAR;
  let rootMaxX = -FAR, rootMaxY = -FAR, rootMaxZ = -FAR;
  for (let i = 0; i < count; i++) {
    const b = i * 6, c = i * 3;
    const minX = aabbs[b], minY = aabbs[b + 1], minZ = aabbs[b + 2];
    const maxX = aabbs[b + 3], maxY = aabbs[b + 4], maxZ = aabbs[b + 5];
    centers[c] = (minX + maxX) * 0.5;
    centers[c + 1] = (minY + maxY) * 0.5;
    centers[c + 2] = (minZ + maxZ) * 0.5;
    if (minX < rootMinX) rootMinX = minX;
    if (minY < rootMinY) rootMinY = minY;
    if (minZ < rootMinZ) rootMinZ = minZ;
    if (maxX > rootMaxX) rootMaxX = maxX;
    if (maxY > rootMaxY) rootMaxY = maxY;
    if (maxZ > rootMaxZ) rootMaxZ = maxZ;
    primIndices[i] = i;
  }
  bounds[0] = rootMinX; bounds[1] = rootMinY; bounds[2] = rootMinZ;
  bounds[3] = rootMaxX; bounds[4] = rootMaxY; bounds[5] = rootMaxZ;
  leftFirst[0] = 0;
  primCount[0] = count;

  const minDimX = (rootMaxX - rootMinX) * 1e-20;
  const minDimY = (rootMaxY - rootMinY) * 1e-20;
  const minDimZ = (rootMaxZ - rootMinZ) * 1e-20;

  let newNode = 1;
  const tasks: number[] = [];
  let nodeIndex = 0;
  while (true) {
    while (true) {
      const nb = nodeIndex * 6;
      const nMinX = bounds[nb], nMinY = bounds[nb + 1], nMinZ = bounds[nb + 2];
      const extentX = bounds[nb + 3] - nMinX;
      const extentY = bounds[nb + 4] - nMinY;
      const extentZ = bounds[nb + 5] - nMinZ;
      const area = extentX * extentY + extentY * extentZ + extentZ * extentX;
      if (area === 0) break; // can't split an infinitely small node.

      const first = leftFirst[nodeIndex];
      const nodePrims = primCount[nodeIndex];
      // Every split of a single primitive leaves one side empty.
      if (nodePrims === 1) break;
      const scaleX = extentX > minDimX ? BINS / extentX : 0;
      const scaleY = extentY > minDimY ? BINS / extentY : 0;
      const scaleZ = extentZ > minDimZ ? BINS / extentZ : 0;

      for (let i = 0; i < 3 * BINS * 3; i++) {
        binMin[i] = FAR;
        binMax[i] = -FAR;
      }
      binCount.fill(0);
      for (let i = first, end = first + nodePrims; i < end; i++) {
        const p = primIndices[i];
        const c = p * 3, b = p * 6;
        const minX = aabbs[b], minY = aabbs[b + 1], minZ = aabbs[b + 2];
        const maxX = aabbs[b + 3], maxY = aabbs[b + 4], maxZ = aabbs[b + 5];
        // Axis a, bin i: bounds at ((a * BINS) + i) * 3.
        const bx = binOf(centers[c], nMinX, scaleX, BINS);
        const by = BINS + binOf(centers[c + 1], nMinY, scaleY, BINS);
        const bz = 2 * BINS + binOf(centers[c + 2], nMinZ, scaleZ, BINS);
        binCount[bx]++; binCount[by]++; binCount[bz]++;
        growBin(binMin, binMax, bx * 3, minX, minY, minZ, maxX, maxY, maxZ);
        growBin(binMin, binMax, by * 3, minX, minY, minZ, maxX, maxY, maxZ);
        growBin(binMin, binMax, bz * 3, minX, minY, minZ, maxX, maxY, maxZ);
      }

      // Sweep the bins of each axis for the lowest split cost.
      let splitCost = FAR;
      let bestAxis = 0, bestPos = 0;
      for (let axis = 0; axis < 3; axis++) {
        const extent = axis === 0 ? extentX : axis === 1 ? extentY : extentZ;
        const minDim = axis === 0 ? minDimX : axis === 1 ? minDimY : minDimZ;
        if (!(extent > minDim)) continue;
        let lMinX = FAR, lMinY = FAR, lMinZ = FAR, lMaxX = -FAR, lMaxY = -FAR, lMaxZ = -FAR;
        let rMinX = FAR, rMinY = FAR, rMinZ = FAR, rMaxX = -FAR, rMaxY = -FAR, rMaxZ = -FAR;
        let leftN = 0, rightN = 0;
        for (let i = 0; i < BINS - 1; i++) {
          const l = (axis * BINS + i) * 3;
          const r = (axis * BINS + BINS - 1 - i) * 3;
          lMinX = Math.min(lMinX, binMin[l]); lMinY = Math.min(lMinY, binMin[l + 1]); lMinZ = Math.min(lMinZ, binMin[l + 2]);
          lMaxX = Math.max(lMaxX, binMax[l]); lMaxY = Math.max(lMaxY, binMax[l + 1]); lMaxZ = Math.max(lMaxZ, binMax[l + 2]);
          rMinX = Math.min(rMinX, binMin[r]); rMinY = Math.min(rMinY, binMin[r + 1]); rMinZ = Math.min(rMinZ, binMin[r + 2]);
          rMaxX = Math.max(rMaxX, binMax[r]); rMaxY = Math.max(rMaxY, binMax[r + 1]); rMaxZ = Math.max(rMaxZ, binMax[r + 2]);
          leftN += binCount[axis * BINS + i];
          rightN += binCount[axis * BINS + BINS - 1 - i];
          const lx = lMaxX - lMinX, ly = lMaxY - lMinY, lz = lMaxZ - lMinZ;
          const rx = rMaxX - rMinX, ry = rMaxY - rMinY, rz = rMaxZ - rMinZ;
          leftCost[i] = leftN === 0 ? FAR : (lx * ly + ly * lz + lz * lx) * leftN;
          rightCost[BINS - 2 - i] = rightN === 0 ? FAR : (rx * ry + ry * rz + rz * rx) * rightN;
        }
        for (let i = 0; i < BINS - 1; i++) {
          const cost = leftCost[i] + rightCost[i];
          if (cost < splitCost) {
            splitCost = cost;
            bestAxis = axis;
            bestPos = i;
          }
        }
      }
      splitCost = C_TRAV + C_INT * splitCost / area;
      // Not splitting is better (also stops on non-finite bounds).
      if (!(splitCost < nodePrims * C_INT)) break;

      // In-place partition by the chosen bin.
      const scale = bestAxis === 0 ? scaleX : bestAxis === 1 ? scaleY : scaleZ;
      const nMin = bestAxis === 0 ? nMinX : bestAxis === 1 ? nMinY : nMinZ;
      let j = first + nodePrims, src = first;
      for (let i = 0; i < nodePrims; i++) {
        const p = primIndices[src];
        if (binOf(centers[p * 3 + bestAxis], nMin, scale, BINS) <= bestPos) {
          src++;
        } else {
          // Explicit numeric expression also supports scriptc typed-array stores.
          primIndices[src + 0] = primIndices[--j];
          primIndices[j] = p;
        }
      }
      const leftPrims = src - first;
      const rightPrims = nodePrims - leftPrims;
      if (leftPrims === 0 || rightPrims === 0) break; // should not happen.

      const n = newNode;
      newNode += 2;
      // Child bounds are the unions of the bins on each side of the split.
      const leftBase = n * 6, rightBase = leftBase + 6;
      for (let k = 0; k < 3; k++) {
        bounds[leftBase + k] = bounds[rightBase + k] = FAR;
        bounds[leftBase + 3 + k] = bounds[rightBase + 3 + k] = -FAR;
      }
      for (let i = 0; i < BINS; i++) {
        const o = (bestAxis * BINS + i) * 3;
        const base = i <= bestPos ? leftBase : rightBase;
        for (let k = 0; k < 3; k++) {
          if (binMin[o + k] < bounds[base + k]) bounds[base + k] = binMin[o + k];
          if (binMax[o + k] > bounds[base + 3 + k]) bounds[base + 3 + k] = binMax[o + k];
        }
      }
      leftFirst[n] = first; primCount[n] = leftPrims;
      leftFirst[n + 1] = j; primCount[n + 1] = rightPrims;
      leftFirst[nodeIndex] = n; primCount[nodeIndex] = 0;
      tasks.push(n + 1);
      nodeIndex = n;
    }
    if (!tasks.length) break;
    nodeIndex = tasks.pop()!;
  }

  return { nodeCount: newNode, bounds, leftFirst, primCount, primIndices };
}

export interface Bvh2Layout {
  /** Node indices in depth-first order (node, left subtree, right subtree). */
  order: Uint32Array;
  /** Offset of each node in vec4 units: 2 per node plus 1 per leaf primitive. */
  offsets: Uint32Array;
  vec4Count: number;
  maxDepth: number;
  maxLeafPrimitives: number;
}

/**
 * Places nodes in the depth-first BVH2 layout read by the traversal shaders:
 * the left child follows its parent and leaf primitives follow their leaf.
 */
export function layoutBvh2(bvh: BinnedSahBvh): Bvh2Layout {
  const { nodeCount, leftFirst, primCount } = bvh;
  const order = new Uint32Array(nodeCount);
  const offsets = new Uint32Array(nodeCount);
  let vec4Count = 0, maxDepth = 0, maxLeafPrimitives = 0;
  if (!nodeCount) return { order, offsets, vec4Count, maxDepth, maxLeafPrimitives };
  const stack: number[] = [0, 1];
  let written = 0;
  while (stack.length) {
    const depth = stack.pop()!;
    const node = stack.pop()!;
    order[written++] = node;
    offsets[node] = vec4Count;
    if (depth > maxDepth) maxDepth = depth;
    const prims = primCount[node];
    vec4Count += 2 + prims;
    if (prims) {
      if (prims > maxLeafPrimitives) maxLeafPrimitives = prims;
    } else {
      stack.push(leftFirst[node] + 1, depth + 1, leftFirst[node], depth + 1);
    }
  }
  return { order, offsets, vec4Count, maxDepth, maxLeafPrimitives };
}
