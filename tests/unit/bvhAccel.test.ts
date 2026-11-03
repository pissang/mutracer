import { describe, expect, it } from 'vitest';
import { mat4 } from '../../src/math';
import {
  Box3,
  INSTANCE_WORD_STRIDE,
  WEB_TLAS_BINS,
  buildBLAS,
  buildTLAS,
  buildWebTLAS,
  meshInstanceBounds,
  packBuiltTLAS,
  getTraversalStackSizes,
  refitBLAS,
  refitTLAS,
  type BLASInstance,
  type TLASInstance
} from '../../src/renderer/bvhAccel';
import Geometry, { Attribute } from '../../src/scene/Geometry';

function bounds(minX: number, maxX: number) {
  const result = new Box3();
  result.min.set([minX, 0, 0]);
  result.max.set([maxX, 1, 1]);
  return result;
}

describe('mixed BVH layouts', () => {
  it('packs layout codes without changing the 30-bit BLAS offsets', () => {
    const blases: BLASInstance[] = [
      {
        bvh: { buffer: new ArrayBuffer(64), maxDepth: 1, layout: 'bvh4' },
        trainglesCount: 1,
        verticesCount: 3
      },
      {
        bvh: { buffer: new ArrayBuffer(32), maxDepth: 1, layout: 'bvh2' },
        trainglesCount: 1,
        verticesCount: 3
      },
      {
        bvh: { buffer: new ArrayBuffer(64), maxDepth: 1, layout: 'bvh-gpu' },
        trainglesCount: 1,
        verticesCount: 3
      },
      {
        bvh: { buffer: new ArrayBuffer(80), maxDepth: 1, layout: 'cwbvh' },
        trainglesCount: 1,
        verticesCount: 3
      }
    ];
    const instances: TLASInstance[] = blases.map((_, blasIndex) => ({
      blasIndex,
      bounds: bounds(blasIndex * 2, blasIndex * 2 + 1),
      transform: mat4.identity(new Float64Array(16)),
      materialsIndices: [blasIndex]
    }));

    const flattened = buildTLAS(instances, blases);
    const instanceWords = new Int32Array(flattened.instancesBuffer!);

    expect(instanceWords[0]).toBe(0x40000000);
    expect(instanceWords[INSTANCE_WORD_STRIDE]).toBe(4);
    expect(instanceWords[INSTANCE_WORD_STRIDE * 2]).toBe(-0x80000000 + 6);
    expect(instanceWords[INSTANCE_WORD_STRIDE * 3]).toBe(-0x40000000 + 10);
    expect(flattened.layout).toBe('bvh2');
  });
});

describe('traversal stack sizing', () => {
  it('sizes nested TLAS and BLAS stacks independently', () => {
    const tlas = {
      buffer: new ArrayBuffer(32),
      maxDepth: 6,
      maxLeafPrimitives: 4
    };
    const blases: BLASInstance[] = [12, 18].map((maxDepth) => ({
      bvh: { buffer: new ArrayBuffer(64), maxDepth, layout: 'bvh4' },
      trainglesCount: 1,
      verticesCount: 3
    }));

    expect(getTraversalStackSizes(tlas, blases)).toEqual({
      tlas: 6,
      blas: 18
    });
  });

  it('keeps TinyBVH stack requirements above the old 50-entry limit', () => {
    const tlas = { buffer: new ArrayBuffer(32), maxDepth: 7 };
    const blases: BLASInstance[] = [
      {
        bvh: { buffer: new ArrayBuffer(64), maxDepth: 51, layout: 'bvh4' },
        trainglesCount: 1,
        verticesCount: 3
      }
    ];

    expect(getTraversalStackSizes(tlas, blases)).toEqual({
      tlas: 7,
      blas: 51
    });
  });

});

describe('BVH refit', () => {
  it('updates TLAS bounds and instance transforms without rebuilding topology', () => {
    const blases: BLASInstance[] = [
      {
        bvh: { buffer: new ArrayBuffer(48), maxDepth: 1, layout: 'bvh2' },
        trainglesCount: 1,
        verticesCount: 3
      }
    ];
    const instances: TLASInstance[] = [0, 1].map((i) => ({
      blasIndex: 0,
      bounds: bounds(i * 2, i * 2 + 1),
      transform: mat4.identity(new Float64Array(16)),
      materialsIndices: [i]
    }));
    const flat = buildTLAS(instances, blases);
    const topology = Array.from(new Int32Array(flat.buffer)).filter(
      (_, index) => index % 8 === 3 || index % 8 === 7
    );

    instances[0].bounds = bounds(10, 11);
    instances[1].bounds = bounds(20, 21);
    mat4.translate(instances[0].transform, instances[0].transform, [10, 0, 0]);
    mat4.translate(instances[1].transform, instances[1].transform, [20, 0, 0]);
    refitTLAS(flat, instances, blases);

    const floats = new Float32Array(flat.buffer);
    expect(floats[0]).toBe(10);
    expect(floats[4]).toBe(21);
    expect(
      Array.from(new Int32Array(flat.buffer)).filter(
        (_, index) => index % 8 === 3 || index % 8 === 7
      )
    ).toEqual(topology);
    const instanceData = new Float32Array(flat.instancesBuffer!);
    expect([instanceData[32], instanceData[INSTANCE_WORD_STRIDE + 32]].sort((a, b) => a - b)).toEqual([
      10, 20
    ]);
  });

  it('updates only dirty instance records and their TLAS ancestry', () => {
    const blases: BLASInstance[] = [
      {
        bvh: { buffer: new ArrayBuffer(48), maxDepth: 1, layout: 'bvh2' },
        trainglesCount: 1,
        verticesCount: 3
      }
    ];
    const instances: TLASInstance[] = Array.from({ length: 8 }, (_, index) => ({
      blasIndex: 0,
      bounds: bounds(index * 3, index * 3 + 1),
      transform: mat4.identity(new Float64Array(16)),
      materialsIndices: [index]
    }));
    const flat = buildTLAS(instances, blases);
    const previousInstances = new Float32Array(flat.instancesBuffer!).slice();

    instances[3].bounds = bounds(30, 31);
    mat4.translate(instances[3].transform, instances[3].transform, [30, 0, 0]);
    const result = refitTLAS(flat, instances, blases, new Set([3]));

    const nextInstances = new Float32Array(flat.instancesBuffer!);
    const changedRecords = Array.from({ length: instances.length }, (_, index) =>
      nextInstances
        .subarray(index * INSTANCE_WORD_STRIDE, index * INSTANCE_WORD_STRIDE + INSTANCE_WORD_STRIDE)
        .some((value, word) => value !== previousInstances[index * INSTANCE_WORD_STRIDE + word])
    ).filter(Boolean);
    expect(changedRecords).toHaveLength(1);
    expect(result.instanceRanges).toHaveLength(1);
    expect(
      result.tlasRanges.reduce((bytes, range) => bytes + range.size, 0)
    ).toBeLessThan(flat.buffer.byteLength);
    expect(new Float32Array(flat.buffer)[4]).toBe(31);
  });

  it('refits BVH2 leaf and parent bounds after vertex deformation', () => {
    const geometry = new Geometry({
      position: new Attribute(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]),
        3
      ),
      normal: new Attribute(new Float32Array(18), 3),
      indices: new Attribute(new Uint32Array([0, 1, 2, 3, 4, 5]), 1)
    } as never);
    const flat = buildBLAS(geometry, 0, undefined);
    geometry.position.array[12] = 8;

    expect(refitBLAS(flat, geometry)).toBe(true);
    expect(new Float32Array(flat.buffer)[4]).toBe(8);
  });
});


describe('platform-built TLAS packing', () => {
  it('preserves source identity, records and refit after platform leaf ordering', () => {
    const blases: BLASInstance[] = [0, 1].map(() => ({
      bvh: {buffer: new ArrayBuffer(48), maxDepth: 1, layout: 'bvh2'},
      trainglesCount: 1, verticesCount: 3
    }));
    const instances: TLASInstance[] = [3, -5, 8, 0].map((x, i) => ({
      blasIndex: i % 2, bounds: bounds(x, x + 1), transform: mat4.identity(new Float64Array(16)), materialsIndices: [i]
    }));
    const expected = buildTLAS(instances, blases);
    const hierarchy = {...expected, buffer: expected.buffer.slice(0), instancesBuffer: undefined};
    const words = new Int32Array(hierarchy.buffer), stack = [0];
    while (stack.length) {
      const node = stack.pop()!, o = node * 4, child = words[o + 3];
      if (child >= 0) {stack.push(child, node + 2); continue;}
      for (let i = 0; i < -child; i++) words[o + 8 + i * 4] = words[o + 10 + i * 4];
    }
    const packed = packBuiltTLAS(instances, blases, hierarchy);
    expect(new Uint8Array(packed.buffer)).toEqual(new Uint8Array(expected.buffer));
    expect(new Uint8Array(packed.instancesBuffer!)).toEqual(new Uint8Array(expected.instancesBuffer!));
    expect(meshInstanceBounds(instances).length).toBe(24);
    mat4.translate(instances[1].transform, instances[1].transform, [2, 0, 0]);
    refitTLAS(packed, instances, blases);
    refitTLAS(expected, instances, blases);
    expect(new Uint8Array(packed.buffer)).toEqual(new Uint8Array(expected.buffer));
    expect(new Uint8Array(packed.instancesBuffer!)).toEqual(new Uint8Array(expected.instancesBuffer!));
  });

  it('packs the existing empty-scene representation', () => {
    expect(meshInstanceBounds([])).toHaveLength(0);
    const actual = packBuiltTLAS([], [], {buffer: new ArrayBuffer(0), maxDepth: 0});
    expect(new Uint8Array(actual.buffer)).toEqual(new Uint8Array(buildTLAS([], []).buffer));
    expect(actual.instancesBuffer?.byteLength).toBe(0);
  });
});


describe('web TLAS leaf boxes', () => {
  it.each([false, true])('packs and refits displaced world boxes (partial=%s)', partial => {
    const blases: BLASInstance[] = [{bvh: {buffer: new ArrayBuffer(48), maxDepth: 1}, trainglesCount: 1, verticesCount: 3}];
    const instances: TLASInstance[] = Array.from({length: 8}, (_, i) => ({
      blasIndex: 0, bounds: bounds(i * 3, i * 3 + 1),
      transform: mat4.identity(new Float64Array(16)), materialsIndices: [i], displacementScale: .25
    }));
    const flat = buildWebTLAS(instances, blases);
    const legacy = buildTLAS(instances, blases, WEB_TLAS_BINS);
    expect(flat.instancesBuffer).toEqual(legacy.instancesBuffer);
    expect(flat.buffer.byteLength - legacy.buffer.byteLength).toBe(instances.length * 32);
    const words = new Int32Array(flat.buffer), floats = new Float32Array(flat.buffer);
    const boxes = new Map<number, number>();
    const visit = (node: number) => {
      const child = words[node * 4 + 3];
      if (child >= 0) { visit(node + 2); visit(child); return; }
      for (let i = 0; i < -child; i++) {
        const entry = (node + 2 + i) * 4;
        const box = words[entry + 3];
        expect(box * 16).toBeGreaterThanOrEqual(legacy.buffer.byteLength);
        boxes.set(words[entry + 2], box);
      }
    };
    visit(0);
    const check = () => {
      const expected = meshInstanceBounds(instances);
      for (const [source, box] of boxes) {
        expect(Array.from(floats.subarray(box * 4, box * 4 + 3))).toEqual(Array.from(expected.subarray(source * 6, source * 6 + 3)));
        expect(Array.from(floats.subarray(box * 4 + 4, box * 4 + 7))).toEqual(Array.from(expected.subarray(source * 6 + 3, source * 6 + 6)));
      }
    };
    check();
    instances[3].bounds = bounds(30, 31);
    mat4.scale(instances[3].transform, instances[3].transform, [2, 3, 4]);
    const ranges = refitTLAS(flat, instances, blases, partial ? new Set([3]) : undefined);
    check();
    const boxByte = boxes.get(3)! * 16;
    expect(ranges.tlasRanges.some(r => r.offset <= boxByte && r.offset + r.size >= boxByte + 32)).toBe(true);
    expect(Array.from(boxes.values())).toHaveLength(instances.length);
  });
});
