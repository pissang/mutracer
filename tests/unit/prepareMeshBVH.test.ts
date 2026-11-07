import { describe, expect, it } from 'vitest';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Texture from '../../src/scene/Texture';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {
  getTrianglesDisplacementRange,
  getBvhBounds,
  getPreparedMeshGeometry,
  getMeshBlasInput,
  captureMeshBlasSnapshot,
  meshBlasSnapshotIsCurrent,
  updateMeshInstances
} from '../../src/renderer/prepareMeshBVH';
import {appendMergedGeometry, reserveMergedGeometry} from '../../src/renderer/scenePreparation';

describe('merged renderer geometry', () => {
  it('retains every triangle when distinct meshes are prepared together', () => {
    const triangle = (x: number) => new Mesh(new Geometry({
      position: new Attribute(new Float32Array([
        x, 0, 0, x + 1, 0, 0, x, 1, 0
      ]), 3),
      normal: new Attribute(new Float32Array([
        0, 0, 1, 0, 0, 1, 0, 0, 1
      ]), 3),
      indices: new Attribute(new Uint32Array([0, 1, 2]), 1)
    }), new OpenPBRMaterial());
    const prepared = updateMeshInstances([triangle(0), triangle(2)]);
    expect(Array.from(prepared.geometry.indices.array)).toEqual([
      0, 1, 2, 3, 4, 5
    ]);
  });
  it('appends WebGL geometry into reserved CPU arrays without repacking the resident prefix', () => {
    const material = new OpenPBRMaterial();
    const triangle = (x: number) => new Mesh(new Geometry({
      position: new Attribute(new Float32Array([x,0,0, x+1,0,0, x,1,0]), 3),
      normal: new Attribute(new Float32Array([0,0,1, 0,0,1, 0,0,1]), 3),
      indices: new Attribute(new Uint32Array([0,1,2]), 1)
    }), material);
    const meshes = [triangle(0), triangle(2), triangle(4), triangle(6)], first = updateMeshInstances(meshes.slice(0, 3), {displacement: false});
    const resident = reserveMergedGeometry(first.geometry), positionBuffer = resident.position.array.buffer;
    const prepared = updateMeshInstances(meshes, {displacement: false, mergeAttributes: false});
    const appended = appendMergedGeometry(resident, prepared, first.geometries.length)!;
    const reference = updateMeshInstances(meshes, {displacement: false}).geometry;
    expect(appended.position.array.buffer).toBe(positionBuffer);
    expect(Array.from(appended.position.array)).toEqual(Array.from(reference.position.array));
    expect(Array.from(appended.indexArray)).toEqual(Array.from(reference.indexArray));
    expect(Array.from(appended.materialIndex!.array)).toEqual(Array.from(reference.materialIndex!.array));
  });
  it('grows WebGL CPU storage when an append exceeds the reservation', () => {
    const material = new OpenPBRMaterial(), firstMesh = new Mesh(triangleGeometry(), material);
    const first = updateMeshInstances([firstMesh], {displacement: false});
    const resident = reserveMergedGeometry(first.geometry), previousBuffer = resident.position.array.buffer;
    const meshes = [firstMesh, ...Array.from({length: 8}, (_, i) => {
      const mesh = new Mesh(triangleGeometry(), material); mesh.transform[12] = i + 2; return mesh;
    })];
    const prepared = updateMeshInstances(meshes, {displacement: false, mergeAttributes: false});
    const grown = appendMergedGeometry(resident, prepared, first.geometries.length)!;
    const reference = updateMeshInstances(meshes, {displacement: false}).geometry;
    expect(grown.position.array.buffer).not.toBe(previousBuffer);
    expect(Array.from(grown.position.array)).toEqual(Array.from(reference.position.array));
    expect(Array.from(grown.indexArray)).toEqual(Array.from(reference.indexArray));
  });
});

it('rebuilds UV displacement bounds when a height map is added or its height changes', () => {
  const geometry = triangleGeometry();
  const material = new OpenPBRMaterial();
  const mesh = new Mesh(geometry, material);
  updateMeshInstances([mesh]);
  expect(getBvhBounds(getPreparedMeshGeometry(mesh))[1][2]).toBe(0);

  material.displacementMap = heightTexture([1, 1, 1, 1], 2);
  material.displacementScale = .2;
  updateMeshInstances([mesh]);
  expect(getBvhBounds(getPreparedMeshGeometry(mesh))[1][2]).toBeCloseTo(.2);

  material.displacementScale = .4;
  updateMeshInstances([mesh]);
  expect(getBvhBounds(getPreparedMeshGeometry(mesh))[1][2]).toBeCloseTo(.4);

  material.displacementMap = undefined;
  updateMeshInstances([mesh]);
  expect(getPreparedMeshGeometry(mesh)).toBe(geometry);
  expect(getBvhBounds(geometry)[1][2]).toBe(0);
});

it('isolates shared geometry by height map and refreshes same-size image replacements', () => {
  const geometry = triangleGeometry();
  const first = new OpenPBRMaterial(), second = new OpenPBRMaterial();
  first.displacementMap = heightTexture([1, 1, 1, 1], 2);
  second.displacementMap = heightTexture([.5, .5, .5, .5], 2);
  first.displacementScale = second.displacementScale = .4;
  const a = new Mesh(geometry, first), b = new Mesh(geometry, second);
  const ordinary = new Mesh(geometry, new OpenPBRMaterial());
  const prepared = updateMeshInstances([a, b, ordinary]);
  expect(prepared.geometries).toHaveLength(3);
  expect(getBvhBounds(getPreparedMeshGeometry(a))[1][2]).toBeCloseTo(.4);
  // Bounds conservatively pad quantized height samples.
  expect(getBvhBounds(getPreparedMeshGeometry(b))[1][2]).toBeCloseTo(.2, 1);
  expect(getBvhBounds(geometry)[1][2]).toBe(0);
  first.displacementMap.image = heightTexture([.25, .25, .25, .25], 2).image;
  updateMeshInstances([a]);
  expect(getBvhBounds(getPreparedMeshGeometry(a))[1][2]).toBeCloseTo(.1, 1);
});

it('uses undisplaced bounds on a backend without height-field intersection', () => {
  const material = new OpenPBRMaterial();
  material.displacementMap = heightTexture([1, 1, 1, 1], 2);
  material.displacementScale = .4;
  const mesh = new Mesh(triangleGeometry(), material);
  updateMeshInstances([mesh]);
  const prepared = updateMeshInstances([mesh], { displacement: false });
  expect(prepared.geometries[0]).toBe(mesh.geometry);
  expect(getBvhBounds(prepared.geometries[0])[1][2]).toBe(0);
  expect(prepared.instanceBindings[0].displacementScale).toBe(0);
  expect(material.displacementMap).toBeDefined();
});

it('prepares height prisms for local heights smaller than a microunit', () => {
  const material = new OpenPBRMaterial();
  material.displacementMap = heightTexture([1, 1, 1, 1], 2);
  material.displacementScale = 1e-7;
  const geometry = triangleGeometry(), mesh = new Mesh(geometry, material);
  updateMeshInstances([mesh]);
  expect(getPreparedMeshGeometry(mesh)).not.toBe(geometry);
  expect(getBvhBounds(getPreparedMeshGeometry(mesh))[1][2]).toBeCloseTo(1e-7, 12);
});

it('assigns material slots by identity and retains them after parameter edits', () => {
  const a = new OpenPBRMaterial();
  const b = new OpenPBRMaterial();
  const geometry = new Geometry({
    position: new Attribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3),
    indices: new Attribute(new Uint32Array([0,1,2]), 1)
  });
  const meshes = [new Mesh(geometry, a), new Mesh(geometry, b), new Mesh(geometry, a)];
  const before = updateMeshInstances(meshes);
  expect(before.materials).toEqual([a,b]);
  expect(before.instanceBindings.map(b => b.materialIndices)).toEqual([[0],[1],[0]]);
  a.specularRoughness = 0.7;
  expect(updateMeshInstances(meshes).instanceBindings.map(b => b.materialIndices)).toEqual([[0],[1],[0]]);
});

it('packs material variants in 160-byte instances and retains material slots during refit', async () => {
  const { createCubeGeometry } = await import('../../src/util/commonGeometry');
  const { buildTLAS, INSTANCE_VEC4_STRIDE, INSTANCE_WORD_STRIDE, refitTLAS } = await import('../../src/renderer/bvhAccel');
  const material = new OpenPBRMaterial(), variant = new OpenPBRMaterial();
  variant.uvProjection = 'triplanar'; variant.displacementUvProjection = 'spherical';
  const geo = createCubeGeometry(), a = new Mesh(geo, material), b = new Mesh(geo, variant);
  b.transform[12] = 2;
  const prepared = updateMeshInstances([a, b]);
  expect(prepared.materials).toEqual([material, variant]);
  expect(prepared.instanceBindings.map(binding => binding.materialIndices)).toEqual([[0], [1]]);
  const packed = buildTLAS(prepared.instances, prepared.blases);
  expect(INSTANCE_VEC4_STRIDE).toBe(10); expect(INSTANCE_WORD_STRIDE).toBe(40);
  expect(packed.instancesBuffer!.byteLength).toBe(2 * 160);
  const data = new Uint32Array(packed.instancesBuffer!).slice();
  refitTLAS(packed, prepared.instances, prepared.blases);
  expect(new Uint32Array(packed.instancesBuffer!)).toEqual(data);
});

it('separates projective displacement BLAS caches for different material projections', async () => {
  const { createCubeGeometry } = await import('../../src/util/commonGeometry');
  const { getPreparedMeshGeometry } = await import('../../src/renderer/prepareMeshBVH');
  const { default: Texture } = await import('../../src/scene/Texture');
  const material = new OpenPBRMaterial();
  material.displacementMap = new Texture({ data: new Uint8Array(16), width: 2, height: 2 }); material.displacementScale = .1;
  const triplanar = Object.assign(new OpenPBRMaterial(), material, { displacementUvProjection: 'triplanar' as const });
  const spherical = Object.assign(new OpenPBRMaterial(), material, { displacementUvProjection: 'spherical' as const });
  const geo = createCubeGeometry(), a = new Mesh(geo, triplanar), b = new Mesh(geo, spherical);
  const ga = getPreparedMeshGeometry(a), gb = getPreparedMeshGeometry(b);
  expect(ga).not.toBe(gb); expect(ga.position).toBe(geo.position);
  expect(getPreparedMeshGeometry(a)).toBe(ga);
  expect(material.displacementUvProjection).toBe('none');
});

it('supports projective range bounds without UVs when using triplanar projection', () => {
  const geometry = triangleGeometry();
  geometry.uv = undefined;
  const material = new OpenPBRMaterial();
  material.displacementUvProjection = 'triplanar';
  const range = getTrianglesDisplacementRange(
    geometry,
    heightTexture([0, 0.25, 0.5, 1], 2),
    material
  );

  expect(range).toBeInstanceOf(Float32Array);
  expect(range).toHaveLength(2);
});

it('supports projective range bounds without UVs when using cylindrical projection', () => {
  const geometry = triangleGeometry();
  geometry.uv = undefined;
  const material = new OpenPBRMaterial();
  material.displacementUvProjection = 'cylindrical';
  material.displacementUvProjectionScale = 2;
  const range = getTrianglesDisplacementRange(
    geometry,
    heightTexture([0, 0.25, 0.5, 1], 2),
    material
  );

  expect(range).toBeInstanceOf(Float32Array);
  expect(range).toHaveLength(2);
});
function triangleGeometry() {
  return new Geometry({
    position: new Attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    normal: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    uv: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2),
    indices: new Attribute(new Uint32Array([0, 1, 2]), 1)
  });
}

function heightTexture(values: number[], width: number, height = width) {
  return new Texture({ data: new Float32Array(values), width, height });
}


it.each([-.3, .2])('adds signed bias %s to height bounds without modifying source vertices', (bias) => {
  const geometry = triangleGeometry();
  const original = geometry.position.array.slice();
  const material = new OpenPBRMaterial({ displacementMap: heightTexture([1, 1, 1, 1], 2), displacementScale: .2 });
  const mesh = new Mesh(geometry, material);
  updateMeshInstances([mesh]);
  const target = getPreparedMeshGeometry(mesh), snapshot = captureMeshBlasSnapshot(mesh, target);
  material.displacementBias = bias;
  expect(meshBlasSnapshotIsCurrent(mesh, target, snapshot)).toBe(false);
  updateMeshInstances([mesh]);
  expect(getBvhBounds(getPreparedMeshGeometry(mesh))[1][2]).toBeCloseTo(.2 + bias);
  expect(geometry.position.array).toEqual(original);
  expect(getPreparedMeshGeometry(mesh).position.array).toEqual(original);
  // Worker/TinyBVH builds receive the same biased base used by the shader.
  expect(getMeshBlasInput(mesh).geometry.position.array[2]).toBeCloseTo(bias);
  material.displacementScale = 0;
  updateMeshInstances([mesh]);
  const [min, max] = getBvhBounds(getPreparedMeshGeometry(mesh));
  expect(min[2]).toBeCloseTo(bias); expect(max[2]).toBeCloseTo(bias);
  const unsupported = updateMeshInstances([mesh], { displacement: false });
  expect(getBvhBounds(unsupported.geometries[0])[1][2]).toBe(0);
  material.displacementMap = undefined;
  updateMeshInstances([mesh]);
  expect(getPreparedMeshGeometry(mesh)).toBe(geometry);
});
