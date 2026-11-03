import {matrixStorage} from '../math/storage.js';
import { Box3 } from './Box3.js';
import MeshState from '../scene/MeshState.js';
import MaterialState from '../scene/MaterialState.js';
import Geometry, { Attribute } from '../scene/Geometry.js';
import { mat4, vec3 } from '../math.js';
import { meshInstanceCount, meshInstanceTransform, PackedMeshInstances, type MeshInstances } from './meshInstances.js';
import { getGeometryBvh, setGeometryBvh } from './geometryBvh.js';
import { packMaterialIndexAndWeightToInt, writeMaterialIndices } from './materialIndices.js';
import { type TLASInstance } from './bvhAccel.js';
import { colorLuminance } from './lightSampling.js';
import { getBvhBounds } from './geometryBvhBounds.js';
import { attributeLength, attributeValue } from '../scene/attributeData.js';
import { read } from '../math/access.js';
import { hasGeneratedVertexTangents } from '../util/geometry.js';

// Platform adapters prepare displacement/BLAS inputs; assembly is shared by both hosts.
export function computeBounds(
  _geometry: Geometry,
  m: mat4.Mat4Array,
  bvhBounds: [vec3.Vec3Array, vec3.Vec3Array],
  result: Box3 = makeBounds(),
  p = vec3.create()
) {
  const matrix = matrixStorage(m), lower = matrixStorage(bvhBounds[0]), upper = matrixStorage(bvhBounds[1]);
  const {min, max} = result;
  vec3.set(min, Infinity, Infinity, Infinity);
  vec3.set(max, -Infinity, -Infinity, -Infinity);
  // Transforming the eight BLAS AABB corners is exact for an affine transform
  // and independent of mesh vertex count. The previous rotated path scanned
  // every vertex on every instance update.
  for (let corner = 0; corner < 8; corner++) {
    vec3.set(
      p,
      (corner & 1 ? upper[0] : lower[0]),
      (corner & 2 ? upper[1] : lower[1]),
      (corner & 4 ? upper[2] : lower[2])
    );
    vec3.transformMat4(p, p, matrix);
    if (!finiteValues(p)) continue;
    vec3.min(min, min, p);
    vec3.max(max, max, p);
  }

  return result;
}

export interface PreparedMeshInstanceBinding<M extends MeshState = MeshState> {
  mesh: M;
  geometry: Geometry;
  blasIndex: number;
  materialIndices: number[];
  displacementScale: number;
  bvhBounds: [vec3.Vec3Array, vec3.Vec3Array];
}

export function updateMeshInstanceTransforms<M extends MeshState>(
  bindings: PreparedMeshInstanceBinding<M>[],
  current?: MeshInstances,
  dirtyIndices?: ReadonlySet<number>
) {
  // Dirty indices are packed source slots, as consumed by refitTLAS. Preserve
  // the previous candidate until membership and GPU validation have succeeded.
  if (current && !Array.isArray(current) && dirtyIndices && current.bindingSlots.length === bindings.length &&
    current.bindingSlots.every((slots, i) => slots.length === meshInstanceCount(bindings[i].mesh))) {
    const next = current.copy(), matrix = new Float64Array(16);
    const boundsScratch = makeBounds(), pointScratch = vec3.create();
    let membershipChanged = false;
    const parents = new Map<M, Float64Array>();
    for (const index of dirtyIndices) {
      const binding = bindings[current.bindingIndices[index]];
      const local = current.localIndices[index];
      if (!binding || local >= meshInstanceCount(binding.mesh)) {membershipChanged = true; break;}
      let parent = parents.get(binding.mesh);
      if (!parent) { parent = matrixStorage(binding.mesh.transform); parents.set(binding.mesh, parent); }
      meshInstanceTransform(binding.mesh, local, matrix, parent);
      const bounds = computeBounds(binding.geometry, matrix, binding.bvhBounds, boundsScratch, pointScratch);
      if (!finiteValues(bounds.min) || !finiteValues(bounds.max) || !finiteValues(matrix)) {membershipChanged = true; break;}
      next.transforms.set(matrix, index * 16); next.bounds.set(bounds.min, index * 6); next.bounds.set(bounds.max, index * 6 + 3);
    }
    if (!membershipChanged) return next;
  }
  if (bindings.some(binding => binding.mesh.instanceData != null)) {
    const packed = new PackedMeshInstances(bindings.reduce((count, binding) => count + meshInstanceCount(binding.mesh), 0));
    const matrix = new Float64Array(16);
    const boundsScratch = makeBounds(), pointScratch = vec3.create();
    let sourceIndex = 0;
    for (let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex++) {
      const binding = bindings[bindingIndex];
      const slots: number[] = []; packed.bindingSlots.push(slots);
      const {mesh, geometry, bvhBounds, blasIndex, materialIndices, displacementScale} = binding;
      const parent = matrixStorage(mesh.transform);
      for (let i = 0; i < meshInstanceCount(mesh); i++, sourceIndex++) {
        meshInstanceTransform(mesh, i, matrix, parent);
        const bounds = computeBounds(geometry, matrix, bvhBounds, boundsScratch, pointScratch);
        if (!finiteValues(bounds.min) || !finiteValues(bounds.max) || !finiteValues(matrix)) continue;
        const index = packed.length++;
        packed.sourceIndices[index] = sourceIndex; packed.bindingIndices[index] = bindingIndex; packed.localIndices[index] = i; slots.push(index);
        packed.transforms.set(matrix, index * 16);
        packed.bounds.set(bounds.min, index * 6); packed.bounds.set(bounds.max, index * 6 + 3);
        packed.blasIndices[index] = blasIndex; packed.materials[index] = packMaterialIndexAndWeightToInt(materialIndices[0], 1);
        packed.displacement[index] = displacementScale;
        const colors = mesh.instanceData?.colors;
        for (let k = 0; k < 3; k++) packed.colors[index * 3 + k] = colors?.[i * 3 + k] ?? 1;
      }
    }
    return packed;
  }
  const update = (
    {
      mesh,
      geometry,
      blasIndex,
      materialIndices,
      displacementScale,
      bvhBounds
    }: PreparedMeshInstanceBinding<M>
  ): TLASInstance =>
    ({
      bounds: computeBounds(geometry, mesh.transform, bvhBounds),
      blasIndex,
      transform: matrixStorage(mesh.transform),
      materialsIndices: materialIndices.map((idx) =>
        packMaterialIndexAndWeightToInt(idx, 1)
      ),
      displacementScale
    }) satisfies TLASInstance;
  if (!current || !dirtyIndices || !Array.isArray(current)) return bindings.map(update);
  const next = current.slice();
  dirtyIndices.forEach((index) => {
    const binding = bindings[index];
    if (binding) next[index] = update(binding);
  });
  return next;
}

/** Dirty slots shared by Web refits and native range uploads. */
export function dirtyPreparedInstanceIndices<M extends MeshState>(bindings: PreparedMeshInstanceBinding<M>[], meshes: ReadonlySet<M>, instances: MeshInstances) {
  const dirty = new Set<number>();
  for (let i = 0; i < bindings.length; i++) {
    if (!meshes.has(bindings[i].mesh)) continue;
    if (!Array.isArray(instances)) {
      for (const slot of instances.bindingSlots[i] ?? []) dirty.add(slot);
    } else dirty.add(i);
  }
  return dirty;
}

export function prepareSceneMeshes<M extends MeshState>(meshes: M[],
  prepareGeometry: (mesh: M) => {geometry: Geometry; displacementScale: number},
  boundsForGeometry = getBvhBounds, softwareBvhs = true, mergeAttributes = true) {
  const materialIndexMap = new Map<MaterialState, number>();
  const geometryIndexMap = new Map<Geometry, number>();
  const geometryBounds = new Map<Geometry, [Float64Array, Float64Array]>();
  const geometries: Geometry[] = [];
  const materials: M['materials'] = [];
  const globalMaterialIndicesMap: number[][] = [];
  const emissiveBindings: {
    mesh: M;
    geometry: Geometry;
    materialIndices: number[];
  }[] = [];
  const instanceBindings: PreparedMeshInstanceBinding<M>[] = [];


  const instances: TLASInstance[] = meshes
    .filter((mesh) => mesh.geometry.position?.array.length > 0)
    .map((mesh) => {
      let { geometry, displacementScale } = prepareGeometry(mesh);
      let cachedBounds = geometryBounds.get(geometry);
      if (!cachedBounds) {
        const rawBounds = boundsForGeometry(geometry);
        cachedBounds = [matrixStorage(rawBounds[0]), matrixStorage(rawBounds[1])];
        geometryBounds.set(geometry, cachedBounds);
      }
      // Instances share the scan, while retained updates keep independent arrays.
      const bvhBounds: [Float64Array, Float64Array] = [cachedBounds[0].slice(), cachedBounds[1].slice()];
      const bounds = computeBounds(geometry, mesh.transform, bvhBounds);

      let geoIdx = geometryIndexMap.get(geometry);
      const materialsIndices = mesh.materials.map((material) => {
        const key = material;
        if (!materialIndexMap.has(key)) {
          materialIndexMap.set(key, materials.length);
          materials.push(material);
        }
        return materialIndexMap.get(key)!;
      });

      // Explicit vertex indices are global after merging. Batches with a
      // different material table need their own vertex region, even when the
      // table contains just one material. Equal tables can share the region.
      if (geoIdx != null && geometry.materialIndex &&
        (materialsIndices.length !== globalMaterialIndicesMap[geoIdx].length ||
          materialsIndices.some((index, i) => index !== globalMaterialIndicesMap[geoIdx!][i]))) {
        const bvh = getGeometryBvh(geometry);
        geometry = new Geometry(geometry);
        setGeometryBvh(geometry, bvh);
        geoIdx = undefined;
      }

      if (geoIdx == null) {
        geoIdx = geometries.length;
        geometryIndexMap.set(geometry, geometries.length);
        geometries.push(geometry);
        // Same number with geometries.
        globalMaterialIndicesMap.push(materialsIndices);
      }
      const instance: TLASInstance = {
        bounds,
        blasIndex: geoIdx!,
        transform: matrixStorage(mesh.transform),
        materialsIndices: materialsIndices.map((idx) =>
          packMaterialIndexAndWeightToInt(idx, 1)
        ),
        displacementScale
      } satisfies TLASInstance;
      if (mesh.instanceData == null && (
        !finiteValues(bounds.min) ||
        !finiteValues(bounds.max) ||
        !finiteValues(mesh.transform)
      )) {
        return undefined;
      }
      if (mesh.materials.some((material) =>
        !material.unlit && !material.shadowCatcher &&
        colorLuminance(material.emissionColor) * material.emissionLuminance > 1e-8
      )) {
        emissiveBindings.push({ mesh, geometry, materialIndices: materialsIndices });
      }
      instanceBindings.push({
        mesh,
        geometry,
        blasIndex: geoIdx,
        materialIndices: materialsIndices,
        displacementScale,
        bvhBounds
      });
      return instance;
    })
    .filter((instance) => instance != null) as TLASInstance[];

  const geometryRegions = new Map<Geometry, { vertexOffset: number; indexOffset: number; materialIndices: number[] }>();
  const geometry = mergeAttributes ? mergeGeometry(geometries, globalMaterialIndicesMap, geometryRegions) : geometryLayout(geometries);
  if (!mergeAttributes) {
    let vertexOffset = 0, indexOffset = 0;
    geometries.forEach((g, i) => {
      geometryRegions.set(g, {vertexOffset, indexOffset, materialIndices: globalMaterialIndicesMap[i]});
      vertexOffset += g.vertexCount; indexOffset += g.indexArray.length;
    });
  }

  return {
    geometry,
    mergedAttributes: mergeAttributes,
    geometries,
    geometryRegions,
    geometryStates: new Map(instanceBindings.map(binding => {
      const source = binding.mesh.geometry;
      return [source, { topologyVersion: source.topologyVersion, indices: source.indices.array,
        indexCount: source.indexArray.length }];
    })),
    instances: (meshes.some(mesh => mesh.instanceData != null) ? updateMeshInstanceTransforms(instanceBindings) : instances) as MeshInstances,
    materials,
    instanceBindings,
    emissiveBindings,
    blases: softwareBvhs ? geometries.map((geo) => ({
      bvh: getGeometryBvh(geo)!,
      verticesCount: geo.vertexCount,
      trainglesCount: geo.indexArray.length / 3
    })) : []
  };
}

// Feature descriptor only: direct WebGPU packing retains the original geometries.
function geometryLayout(geometries: Geometry[]) {
  const empty = new Float32Array(0);
  return new Geometry({position: new Attribute(empty, 3), normal: new Attribute(empty, 3),
    indices: new Attribute(new Uint32Array(0), 1),
    tangent: geometries.some(g => g.tangent) ? new Attribute(empty, 4) : undefined});
}

export function mergeGeometry(
  geometries: Geometry[],
  globalMaterialIndicesMap: number[][],
  regions: Map<Geometry, { vertexOffset: number; indexOffset: number; materialIndices: number[] }>,
  webgl = false
) {
  const totalVertexCount = geometries.reduce(
    (sum, geo) => sum + geo.vertexCount,
    0
  );
  const totalIndexCount = geometries.reduce(
    (sum, geo) => sum + geo.indexArray.length,
    0
  );
  const positionAttrib = new Attribute(
    new Float32Array(3 * totalVertexCount),
    3
  );
  const normalAttrib = new Attribute(new Float32Array(3 * totalVertexCount), 3);
  const uvAttrib = new Attribute(new Float32Array(2 * totalVertexCount), 2);
  const uv1Attrib = new Attribute(new Float32Array(2 * totalVertexCount), 2);
  const indexAttrib = new Attribute(new Uint32Array(totalIndexCount), 1);

  const materialIndexAttrib = new Attribute(
    new Int32Array(4 * totalVertexCount),
    4
  );

  // The flat WebGL buffer keeps its existing XYZ tangents and optional-attribute
  // selection; instanced preparation uses XYZW tangents and independent channels.
  const firstOptional = webgl ? geometries.find(geo => geo.color || geo.tangent) : undefined;
  const hasColor = webgl ? !!firstOptional?.color : geometries.some(geo => geo.color);
  const hasTangent = webgl ? !firstOptional?.color && !!firstOptional?.tangent : geometries.some(geo => geo.tangent);
  const tangentSize = webgl ? 3 : 4;

  const mergedGeometry = new Geometry({
    position: positionAttrib,
    normal: normalAttrib,
    uv: uvAttrib,
    uv1: uv1Attrib,
    materialIndex: materialIndexAttrib,
    color: hasColor
      ? new Attribute(new Float32Array(3 * totalVertexCount).fill(1), 3)
      : undefined,
    tangent: hasTangent
      ? new Attribute(new Float32Array(tangentSize * totalVertexCount), tangentSize)
      : undefined,
    indices: indexAttrib
  });

  let currentVertex = 0;
  let currentIndex = 0;

  geometries.forEach((geometry, idx) => {
    const vertexCount = geometry.vertexCount;
    const globalMaterialIndex = globalMaterialIndicesMap[idx];
    regions.set(geometry, { vertexOffset: currentVertex, indexOffset: currentIndex, materialIndices: globalMaterialIndex });

    positionAttrib.array.set(geometry.position!.array, currentVertex * 3);
    normalAttrib.array.set(geometry.normal!.array, currentVertex * 3);
    if (geometry.uv) {
      uvAttrib.array.set(geometry.uv.array, currentVertex * 2);
    }
    uv1Attrib.array.set(
      (geometry.uv1 ?? geometry.uv)?.array ?? new Float32Array(vertexCount * 2),
      currentVertex * 2
    );
    if (mergedGeometry.color && geometry.color) {
      mergedGeometry.color.array.set(geometry.color.array, currentVertex * 3);
    }
    if (mergedGeometry.tangent && geometry.tangent) {
      const source = geometry.tangent;
      if (webgl) {
        mergedGeometry.tangent.array.set(source.array, currentVertex * tangentSize);
      } else for (let v = 0; v < vertexCount; v++) {
        for (let c = 0; c < 4; c++) mergedGeometry.tangent!.array[(currentVertex + v) * 4 + c] =
          c < source.itemSize ? source.array[v * source.itemSize + c] : hasGeneratedVertexTangents(geometry) ? 0 : 2;
      }
    }

    writeMaterialIndices(geometry, globalMaterialIndex, materialIndexAttrib.array, currentVertex, webgl);

    const meshIndices = geometry.indexArray;
    for (let i = 0; i < attributeLength(meshIndices); i++) {
      indexAttrib.array[currentIndex + i] = currentVertex + attributeValue(meshIndices, i);
    }
    currentVertex += vertexCount;
    currentIndex += attributeLength(meshIndices);
  });

  return mergedGeometry;
}

export function computeGeometryNormals(geometry: Geometry) {
  const indices = geometry.indexArray;
  const positions = geometry.position.array;
  geometry.normal = new Attribute(new Float32Array(positions.length), 3);
  const normals = geometry.normal.array;

  const p1 = vec3.create();
  const p2 = vec3.create();
  const p3 = vec3.create();

  const v21 = vec3.create();
  const v32 = vec3.create();

  const n = vec3.create();

  const len = indices
    ? indices.length
    : geometry.vertexCount;
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

    vec3.set(
      p1,
      positions[i1 * 3],
      positions[i1 * 3 + 1],
      positions[i1 * 3 + 2]
    );
    vec3.set(
      p2,
      positions[i2 * 3],
      positions[i2 * 3 + 1],
      positions[i2 * 3 + 2]
    );
    vec3.set(
      p3,
      positions[i3 * 3],
      positions[i3 * 3 + 1],
      positions[i3 * 3 + 2]
    );

    vec3.sub(v21, p1, p2);
    vec3.sub(v32, p2, p3);
    vec3.cross(n, v21, v32);
    // Already be weighted by the triangle area
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
}


function finiteValues(values: Float32Array | Float64Array | number[]): boolean {
  if (values instanceof Float32Array) return finiteStorage(values);
  if (values instanceof Float64Array) return finiteStorage(values);
  return finiteStorage(values);
}
function finiteStorage<T extends Float32Array | Float64Array | number[]>(values: T): boolean {
  const length = values.length;
  for (let i = 0; i < length; i++) if (!Number.isFinite(read(values, i))) return false;
  return true;
}

function makeBounds(): Box3 {
  return new Box3();
}
