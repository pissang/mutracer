import { describe, expect, it } from 'vitest';
import { mat4 } from '../../src/math';
import { buildBinnedSahBvh, layoutBvh2 } from '../../src/renderer/binnedSahBvh';
import {
  Box3,
  INSTANCE_WORD_STRIDE,
  buildBLAS,
  buildTLAS,
  refitBLAS,
  type BLASInstance,
  type FlattendBVH,
  type TLASInstance
} from '../../src/renderer/bvhAccel';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import { createSphereGeometry } from '../../src/util/commonGeometry';

function triangleGeometry(positions: number[], indices: number[]) {
  return new Geometry({
    position: new Attribute(new Float32Array(positions), 3),
    normal: new Attribute(new Float32Array(positions.length), 3),
    indices: new Attribute(new Uint32Array(indices), 1)
  } as never);
}

/**
 * Walks a BVH2 BLAS buffer and checks that every node is tight around its
 * children or triangles. Returns the leaf entries in traversal order.
 */
function validateBlas(bvh: FlattendBVH, positions: ArrayLike<number>) {
  const floats = new Float32Array(bvh.buffer);
  const ints = new Int32Array(bvh.buffer);
  const entries: number[][] = [];
  let maxDepth = 0;
  let maxLeaf = 0;
  const visit = (index: number, depth: number): number[] => {
    maxDepth = Math.max(maxDepth, depth);
    const base = index * 4;
    const child = ints[base + 3];
    const expected = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const grow = (b: ArrayLike<number>) => {
      for (let k = 0; k < 3; k++) {
        expected[k] = Math.min(expected[k], b[k]);
        expected[k + 3] = Math.max(expected[k + 3], b[k + 3]);
      }
    };
    if (child >= 0) {
      expect(child).toBeGreaterThan(index + 2);
      grow(visit(index + 2, depth + 1));
      grow(visit(child, depth + 1));
    } else {
      maxLeaf = Math.max(maxLeaf, -child);
      for (let i = 0; i < -child; i++) {
        const entry = Array.from(ints.subarray(base + 8 + i * 4, base + 12 + i * 4));
        entries.push(entry);
        for (let j = 0; j < 3; j++) {
          const p = entry[j] * 3;
          grow([positions[p], positions[p + 1], positions[p + 2], positions[p], positions[p + 1], positions[p + 2]]);
        }
      }
    }
    const actual = [floats[base], floats[base + 1], floats[base + 2], floats[base + 4], floats[base + 5], floats[base + 6]];
    expect(actual).toEqual(Array.from(new Float32Array(expected)));
    return actual;
  };
  if (bvh.buffer.byteLength) visit(0, 1);
  expect(bvh.maxDepth).toBe(maxDepth);
  expect(bvh.maxLeafPrimitives).toBe(maxLeaf);
  return entries;
}

describe('binned SAH builder', () => {
  it.each([8, 16, 32, 64])('references every primitive once and keeps siblings adjacent with %s bins', bins => {
    const count = 1000;
    const aabbs = new Float32Array(count * 6);
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const x = random() * 100, y = random() * 100, z = random() * 100, s = random();
      aabbs.set([x, y, z, x + s, y + s, z + s], i * 6);
    }
    const bvh = buildBinnedSahBvh(aabbs, count, bins);
    expect(Array.from(bvh.primIndices).sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, i) => i)
    );
    let leafPrims = 0;
    for (let node = 0; node < bvh.nodeCount; node++) {
      if (bvh.primCount[node]) {
        leafPrims += bvh.primCount[node];
        continue;
      }
      const left = bvh.leftFirst[node];
      for (const child of [left, left + 1]) {
        for (let k = 0; k < 3; k++) {
          expect(bvh.bounds[child * 6 + k]).toBeGreaterThanOrEqual(bvh.bounds[node * 6 + k]);
          expect(bvh.bounds[child * 6 + k + 3]).toBeLessThanOrEqual(bvh.bounds[node * 6 + k + 3]);
        }
      }
    }
    expect(leafPrims).toBe(count);
    expect(bvh.nodeCount).toBeLessThan(count * 2);
    const layout = layoutBvh2(bvh);
    expect(layout.vec4Count).toBe(bvh.nodeCount * 2 + count);
    expect(layout.order[0]).toBe(0);
  });

  it('partitions a centroid on a bin edge to the side whose bounds include it', () => {
    // The probe's centroid sits on the boundary between bins 3 and 4 of the
    // root split, where any mismatch between binning and partitioning shows.
    const f = Math.fround;
    const lo = -1000, hi = f(1000.3), c = f(0.14999441802501678);
    const boxes = [lo, 0, 0, lo + 0.01, 1, 1, hi - 0.01, 0, 0, hi, 1, 1, c, 0, 0, c, 1, 1];
    for (let bin = 0; bin < 8; bin++) {
      const x = lo + ((bin + 0.5) * (hi - lo)) / 8;
      boxes.push(x - 0.01, 0, 0, x + 0.01, 1, 1);
    }
    const aabbs = new Float32Array(boxes);
    const bvh = buildBinnedSahBvh(aabbs, aabbs.length / 6);
    const contains = (node: number): number[] => {
      const prims = bvh.primCount[node]
        ? Array.from(bvh.primIndices.subarray(bvh.leftFirst[node], bvh.leftFirst[node] + bvh.primCount[node]))
        : [...contains(bvh.leftFirst[node]), ...contains(bvh.leftFirst[node] + 1)];
      for (const p of prims) {
        for (let k = 0; k < 3; k++) {
          expect(aabbs[p * 6 + k]).toBeGreaterThanOrEqual(bvh.bounds[node * 6 + k]);
          expect(aabbs[p * 6 + 3 + k]).toBeLessThanOrEqual(bvh.bounds[node * 6 + 3 + k]);
        }
      }
      return prims;
    };
    expect(contains(0)).toHaveLength(aabbs.length / 6);
  });

  it('keeps primitives with coincident bounds in one leaf', () => {
    const aabbs = new Float32Array(Array.from({ length: 5 }, () => [0, 0, 0, 1, 1, 1]).flat());
    const bvh = buildBinnedSahBvh(aabbs, 5);
    expect(bvh.nodeCount).toBe(1);
    expect(bvh.primCount[0]).toBe(5);
  });

  it('stops splitting when a leaf is cheaper than the split', () => {
    // Two overlapping boxes: splitting costs 1 + 2 * area / area = 3 > 2.
    const bvh = buildBinnedSahBvh(new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1.001]), 2);
    expect(bvh.nodeCount).toBe(1);
    // Two distant boxes split.
    const split = buildBinnedSahBvh(new Float32Array([0, 0, 0, 1, 1, 1, 9, 0, 0, 10, 1, 1]), 2);
    expect(split.nodeCount).toBe(3);
  });

  it('returns an empty hierarchy without primitives', () => {
    expect(buildBinnedSahBvh(new Float32Array(0), 0).nodeCount).toBe(0);
  });
});

describe('BLAS build', () => {
  it('writes tight bounds and every triangle once', () => {
    const geometry = createSphereGeometry(32, 16);
    const bvh = buildBLAS(geometry);
    const entries = validateBlas(bvh, geometry.position.array);
    const indices = geometry.indices.array;
    const expected = Array.from({ length: indices.length / 3 }, (_, t) =>
      [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]].join()
    ).sort();
    expect(entries.map((entry) => entry.slice(0, 3).join()).sort()).toEqual(expected);
    expect(bvh.builder).toBe('builtin');
    expect(bvh.layout).toBe('bvh2');
  });

  it('skips triangles with non-finite vertices', () => {
    const geometry = triangleGeometry(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0, 3, 0, 0, 2, 1, 0],
      [0, 1, 2, 3, 4, 5]
    );
    const entries = validateBlas(buildBLAS(geometry), geometry.position.array);
    expect(entries.map((entry) => entry.slice(0, 3))).toEqual([[0, 1, 2]]);
  });

  it('returns an empty BLAS without valid triangles', () => {
    const geometry = triangleGeometry([NaN, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const bvh = buildBLAS(geometry);
    expect(bvh.buffer.byteLength).toBe(0);
    expect(bvh.maxDepth).toBe(0);
  });

  it('bounds displacement prisms and packs their height ranges', () => {
    const geometry = triangleGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    geometry.normal!.array.set([0, 0, 2, 0, 0, 2, 0, 0, 2]);
    const bvh = buildBLAS(geometry, 0.5, new Float32Array([0.25, 0.75]));
    const floats = new Float32Array(bvh.buffer);
    const ints = new Int32Array(bvh.buffer);
    expect(floats[2]).toBe(0.125);
    expect(floats[6]).toBe(0.375);
    expect(ints[3]).toBe(-1);
    expect(ints[11]).toBe((63 << 8) + 192);
  });

  it('refits to tight bounds and requests a rebuild once the area doubles', () => {
    const geometry = createSphereGeometry(16, 8);
    geometry.dynamic = true;
    const bvh = buildBLAS(geometry);
    const original = geometry.position.array.slice();
    for (const [scale, keep] of [[0.99, true], [1.3, true], [1.6, false]] as const) {
      for (let i = 0; i < original.length; i++) geometry.position.array[i] = original[i] * scale;
      expect(refitBLAS(bvh, geometry)).toBe(keep);
      validateBlas(bvh, geometry.position.array);
    }
  });
});

describe('TLAS build', () => {
  it.each([8, 32])('writes each instance record once and keeps its source index with %s bins', bins => {
    const blases: BLASInstance[] = [
      { bvh: { buffer: new ArrayBuffer(48), maxDepth: 1, layout: 'bvh2' }, trainglesCount: 1, verticesCount: 3 },
      { bvh: { buffer: new ArrayBuffer(96), maxDepth: 1, layout: 'bvh2' }, trainglesCount: 2, verticesCount: 4 }
    ];
    const instances: TLASInstance[] = Array.from({ length: 50 }, (_, i) => {
      const bounds = new Box3();
      bounds.min.set([i * 3, 0, 0]);
      bounds.max.set([i * 3 + 1, 1, 1]);
      const transform = mat4.identity(new Float64Array(16));
      transform[12] = i;
      return { blasIndex: i % 2, bounds, transform, materialsIndices: [i] };
    });
    const tlas = buildTLAS(instances, blases, bins);
    const ints = new Int32Array(tlas.buffer);
    const records = new Int32Array(tlas.instancesBuffer!);
    const recordFloats = new Float32Array(tlas.instancesBuffer!);
    const seen: number[] = [];
    const visit = (index: number) => {
      const child = ints[index * 4 + 3];
      if (child >= 0) {
        visit(index + 2);
        visit(child);
        return;
      }
      for (let i = 0; i < -child; i++) {
        const [target, blasOffset, source] = ints.subarray(index * 4 + 8 + i * 4);
        seen.push(source);
        expect(blasOffset).toBe(source % 2 ? 3 : 0);
        expect(records[target * INSTANCE_WORD_STRIDE + 2]).toBe(source);
        expect(recordFloats[target * INSTANCE_WORD_STRIDE + 20 + 12]).toBe(source);
      }
    };
    visit(0);
    expect(seen.sort((a, b) => a - b)).toEqual(instances.map((_, i) => i));
    expect(tlas.instancesBuffer!.byteLength).toBe(instances.length * INSTANCE_WORD_STRIDE * 4);
  });

  it('pads instance bounds by the scaled displacement', () => {
    const bounds = new Box3();
    bounds.min.set([0, 0, 0]);
    bounds.max.set([1, 1, 1]);
    const transform = mat4.fromScaling(mat4.identity(new Float64Array(16)), [2, 1, 1]);
    const tlas = buildTLAS(
      [{ blasIndex: 0, bounds, transform, materialsIndices: [0], displacementScale: 0.25 }],
      [{ bvh: { buffer: new ArrayBuffer(48), maxDepth: 1 }, trainglesCount: 1, verticesCount: 3 }]
    );
    const floats = new Float32Array(tlas.buffer);
    expect([0, 1, 2, 4, 5, 6].map((i) => floats[i])).toEqual([-0.5, -0.25, -0.25, 1.5, 1.25, 1.25]);
  });
});
