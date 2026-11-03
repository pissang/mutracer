import {expect, it, vi} from 'vitest';
import {Attribute} from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import {compactVertexLayout, encodeNormal, encodeTangent, decodeDirection, packCompactVertices, packTriangleMaterials} from '../../src/renderer/compactVertices';
import {updateMeshInstances} from '../../src/renderer/prepareMeshBVH';
import {buildTLAS} from '../../src/renderer/bvhAccel';
import {markDeformedGeometry} from '../../src/scene/geometryChanges';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass';

it('bounds normal/tangent direction error over both octahedral hemispheres and preserves zero', () => {
  let state = 123456;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < 20000; i++) {
    const v = [random(), random(), random()], length = Math.hypot(...v);
    for (let k = 0; k < 3; k++) v[k] /= length;
    for (const tangent of [false, true]) {
      const encoded = tangent ? encodeTangent(...v as [number, number, number], -1) : encodeNormal(...v as [number, number, number]);
      const decoded = decodeDirection(encoded, tangent);
      expect(Math.hypot(...decoded.map((n, k) => n - v[k]))).toBeLessThan(tangent ? .00026 : .00013);
    }
  }
  for (const v of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, -1, 0], [0, 0, 0]]) {
    expect(decodeDirection(encodeNormal(...v as [number, number, number]))).toEqual(v);
    for (const [w, bits] of [[0, 0], [1, 1], [-1, 2], [2, 3]]) {
      const encoded = encodeTangent(...v as [number, number, number], w);
      expect(encoded >>> 30).toBe(bits);
      expect(decodeDirection(encoded, true)).toEqual(v);
    }
  }
});

it('uses word offsets, retains f32 position/UV precision, aliases UV1 and falls back for HDR colors', () => {
  const g = createCubeGeometry();
  g.tangent = new Attribute(new Float32Array(g.vertexCount * 4), 4);
  g.color = new Attribute(new Float32Array(g.vertexCount * 3).fill(.5), 3);
  g.position.array[0] = 123456.789; g.uv!.array[0] = 100000.123;
  let layout = compactVertexLayout([g]);
  expect(layout.stride * 4).toBe(32);
  expect(layout.offsets).toEqual([0, 3, 4, 4, 6, 7, -1]);
  const words = new Uint32Array(layout.stride * g.vertexCount), floats = new Float32Array(words.buffer);
  packCompactVertices(g, words, layout.stride, layout.offsets, 0, g.vertexCount);
  expect(floats[0]).toBe(g.position.array[0]); expect(floats[4]).toBe(g.uv!.array[0]);
  expect(words[6]).toBe(0xff808080);
  g.uv1 = new Attribute(new Float32Array(g.vertexCount * 2), 2);
  expect(compactVertexLayout([g]).offsets[3]).toBe(6);
  g.color.array[0] = 100000; g.color.array[1] = -.25;
  layout = compactVertexLayout([g]);
  expect(layout.constants.COLOR_FLOAT).toBe(true);
  const hdr = new Uint32Array(layout.stride * g.vertexCount);
  packCompactVertices(g, hdr, layout.stride, layout.offsets, 0, g.vertexCount, 0, false, true);
  expect(new Float32Array(hdr.buffer).slice(layout.offsets[4], layout.offsets[4] + 3)).toEqual(g.color.array.slice(0, 3));
});

it('packs mixed optional attributes into disjoint regions and preserves static words during deformation', () => {
  const a = createCubeGeometry(), b = createCubeGeometry();
  a.color = new Attribute(new Float32Array(a.vertexCount * 3).fill(.25), 3);
  a.tangent = new Attribute(new Float32Array(a.vertexCount * 3).fill(1), 3);
  b.uv = undefined;
  const layout = compactVertexLayout([a, b]), words = new Uint32Array((a.vertexCount + b.vertexCount) * layout.stride);
  packCompactVertices(a, words, layout.stride, layout.offsets, 0, a.vertexCount);
  packCompactVertices(b, words, layout.stride, layout.offsets, 0, b.vertexCount, a.vertexCount);
  const first = words.slice(0, a.vertexCount * layout.stride), offset = a.vertexCount * layout.stride;
  expect(words[offset + layout.offsets[4]]).toBe(0xffffffff);
  expect(decodeDirection(words[offset + layout.offsets[5]], true)).toEqual([0, 0, 0]);
  a.position.array[0] += .5; a.uv!.array.fill(99); a.color.array.fill(.75);
  packCompactVertices(a, words, layout.stride, layout.offsets, 0, a.vertexCount, 0, true);
  expect(new Float32Array(words.buffer)[0]).toBe(a.position.array[0]);
  for (let i = 0; i < a.vertexCount; i++) {
    expect(words.slice(i * layout.stride + 4, i * layout.stride + layout.offsets[5])).toEqual(first.slice(i * layout.stride + 4, i * layout.stride + layout.offsets[5]));
  }
});

it('updates direct geometry regions, triangle materials, and BLAS/TLAS uploads without merged geometry', async () => {
  const g = createCubeGeometry(), other = createCubeGeometry(), material = new OpenPBRMaterial(), alternate = new OpenPBRMaterial();
  g.materialIndex = new Attribute(new Int32Array(g.vertexCount), 1);
  const meshes = [new Mesh(other, material), new Mesh(g, [material, alternate])];
  const res = updateMeshInstances(meshes, {mergeAttributes: false}), layout = compactVertexLayout(res.geometries);
  expect(res.geometry.position.array.length).toBe(0);
  expect(res.geometry.indices.array.length).toBe(0);
  const tlas = buildTLAS(res.instances, res.blases), vertexWords = (g.vertexCount + other.vertexCount) * layout.stride;
  const bvhBytes = tlas.buffer.byteLength + res.blases.reduce((sum, b) => sum + b.bvh.buffer.byteLength, 0);
  const pass = Object.create(WGPURayTracePass.prototype) as any;
  const writes: {target: any; offset: number; bytes: Uint8Array}[] = [];
  Object.assign(pass, {_preparedMeshData: res, _tlas: tlas, _attributeStride: layout.stride, _attributeOffsets: layout.offsets,
    _attributeData: new Uint32Array(vertexWords + bvhBytes / 16), _constants: {...layout.constants, MATERIALINDEX_OFF: vertexWords},
    _device: {queue: {writeBuffer(target: any, offset: number, buffer: ArrayBuffer, first = 0, count = buffer.byteLength) {
      writes.push({target, offset, bytes: new Uint8Array(buffer, first, count).slice()});
    }}}, _bvhDataBytes: bvhBytes, _attrBuffers: {size: (vertexWords + bvhBytes / 16) * 4}, _bvhBuffer: {},
    _pendingGeometryUpdates: new Set([g]), _dirtyTransformMeshes: new Set(), _meshSnapshot: []});
  for (const geometry of res.geometries) packCompactVertices(geometry, pass._attributeData, layout.stride, layout.offsets,
    0, geometry.vertexCount, res.geometryRegions.get(geometry)!.vertexOffset);
  const unchanged = pass._attributeData.slice(0, other.vertexCount * layout.stride);
  g.position.array[0] += .125; g.materialIndex.array.fill(1); g.markUpdated();
  pass._updateGeometryData();
  const first = other.vertexCount * layout.stride;
  expect(pass._attributeData.slice(0, first)).toEqual(unchanged);
  expect(new Float32Array(pass._attributeData.buffer)[first]).toBe(g.position.array[0]);
  const recordOffset = tlas.buffer.byteLength / 16 + res.blases[0].bvh.buffer.byteLength / 16;
  const records = new Uint32Array(res.blases[1].bvh.buffer);
  for (let i = 0; i < records.length / 4; i++) if (records[i * 4] < g.vertexCount) {
    expect(pass._attributeData[vertexWords + recordOffset + i]).toBe(2);
  }
  expect(writes.some(w => w.target === pass._bvhBuffer)).toBe(true);
  // A rebuilt TLAS changes every following BLAS material-record address.
  const previousMaterials = pass._attributeData.slice(vertexWords + tlas.buffer.byteLength / 16);
  const largerTlas = {...tlas, buffer: new ArrayBuffer(tlas.buffer.byteLength + 16)};
  pass._bvhDataBytes += 16;
  pass._attrBuffers.size += 4;
  pass._refreshTriangleMaterials(res, largerTlas);
  expect(pass._attributeData.slice(vertexWords + largerTlas.buffer.byteLength / 16)).toEqual(previousMaterials);
  expect(pass._attributeData.slice(0, first)).toEqual(unchanged);
  pass._bvhDataBytes -= 16;
  pass._refreshTriangleMaterials(res, tlas);

  // TLAS refits remain backed by the retained per-tree buffers, including debug assembly.
  pass._bvhCPU = {tlas, blases: res.blases};
  const debug = await pass.getDebugBVHData();
  expect(new Uint8Array(debug.buffer).slice(0, tlas.buffer.byteLength)).toEqual(new Uint8Array(tlas.buffer));
  g.uv!.array.fill(8); markDeformedGeometry(g); pass._pendingGeometryUpdates.add(g);
  const uvWord = pass._attributeData[first + layout.offsets[2]];
  pass._updateGeometryData();
  expect(pass._attributeData[first + layout.offsets[2]]).toBe(uvWord);
});

it('keeps material fallback per instance and packs explicit triangle records without f32 conversion', () => {
  const g = createCubeGeometry(), materials = [new OpenPBRMaterial(), new OpenPBRMaterial()];
  const res = updateMeshInstances([new Mesh(g, materials[0]), new Mesh(g, materials[1])], {mergeAttributes: false});
  expect(res.geometries).toHaveLength(1);
  expect(res.instanceBindings.map(b => b.materialIndices)).toEqual([[0], [1]]);
  const target = new Uint32Array(res.blases[0].bvh.buffer.byteLength / 16);
  packTriangleMaterials(g, [10000000], res.blases[0].bvh.buffer, target, 0);
  expect(target.every(v => v === 0)).toBe(true);
  g.materialIndex = new Attribute(new Int32Array(g.vertexCount), 1);
  packTriangleMaterials(g, [10000000], res.blases[0].bvh.buffer, target, 0);
  expect(target.some(v => v === 10000001)).toBe(true);
});

it('uploads only a typed view range during mapped creation and reused uploads', () => {
  const pass = Object.create(WGPURayTracePass.prototype) as any, mapped = new ArrayBuffer(16);
  const buffer = {size: 16, getMappedRange: () => mapped, unmap: vi.fn()}, writeBuffer = vi.fn();
  pass._device = {createBuffer: () => buffer, queue: {writeBuffer}};
  vi.stubGlobal('GPUBufferUsage', {STORAGE: 1, COPY_DST: 2, COPY_SRC: 4});
  try {
    const source = new Uint32Array([1, 2, 3, 4]).subarray(1, 3);
    pass._updateGPUBuffer('Attributes', undefined, source, 16);
    expect([...new Uint32Array(mapped)]).toEqual([2, 3, 0, 0]);
    expect(writeBuffer).not.toHaveBeenCalled();
    pass._updateGPUBuffer('Attributes', buffer, source, 16);
    expect(writeBuffer).toHaveBeenCalledWith(buffer, 0, source.buffer, 4, 8);
  } finally {vi.unstubAllGlobals();}
});

it('preserves displacement normals exactly so rendered prisms match CPU BVH bounds', () => {
  const g = createCubeGeometry(); g.normal.array.set([.1234567, .2345678, .6789123]);
  const layout = compactVertexLayout([g], true);
  const output = new Uint32Array(layout.stride * g.vertexCount);
  packCompactVertices(g, output, layout.stride, layout.offsets, 0, g.vertexCount, 0, false, false, true);
  expect(layout.constants.NORMAL_FLOAT).toBe(true);
  expect(layout.offsets[2]).toBe(6);
  expect(new Float32Array(output.buffer).slice(3, 6)).toEqual(g.normal.array.slice(0, 3));
});
