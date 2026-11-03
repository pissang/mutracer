import {matrixStorage, copyNumericStorage} from '../math/storage.js';
import { getGeometryBvh, setGeometryBvh } from './geometryBvh.js';
import { writeMaterialIndices } from './materialIndices.js';
import { isDeformationUpdate } from '../scene/geometryChanges.js';
import type Geometry from '../scene/Geometry.js';
import { Attribute } from '../scene/Geometry.js';
import { attributeValue, type AttributeData } from '../scene/attributeData.js';
import { hasGeneratedVertexTangents } from '../util/geometry.js';
import { buildBLAS, refitBLAS, type FlattendBVH } from './bvhAccel.js';
import type { GeometryUpdateState, GeometryUpdateMesh, GeometryUpdateRegion, GeometryUpdateBinding } from './geometryUpdateState.js';
import {computeGeometryBounds, getBvhBounds } from './geometryBvhBounds.js';

type Prepared = GeometryUpdateState;
type BindingIndices<M extends GeometryUpdateMesh> = {source: Map<Geometry, GeometryUpdateBinding<M>[]>; prepared: Map<Geometry, GeometryUpdateBinding<M>[]>};
const vertexAttributes = ['position', 'normal', 'uv', 'uv1', 'color', 'tangent', 'materialIndex'] as const;
// Box only the identity: widening a generic preparation record for a native
// WeakMap key can otherwise make a copy instead of retaining the caller's key.
const bindingIndices = new WeakMap<object, BindingIndices<GeometryUpdateMesh>>();
function indices<M extends GeometryUpdateMesh>(prepared: GeometryUpdateState<M>) {
  // The prepared object's identity owns its binding type; entries are never
  // shared between preparations with different mesh types.
  let maps = bindingIndices.get(prepared) as BindingIndices<M> | undefined;
  if (!maps) {
    maps = { source: new Map(), prepared: new Map() };
    for (const binding of prepared.instanceBindings) {
      for (const [map, geometry] of [[maps.source, binding.mesh.geometry], [maps.prepared, binding.geometry]] as const) {
        let bindings = map.get(geometry);
        if (!bindings) map.set(geometry, bindings = []);
        bindings.push(binding);
      }
    }
    bindingIndices.set(prepared, maps);
  }
  return maps;
}

/** Displaced geometry must be prepared as a whole. */
export function canUpdateGeometries<M extends GeometryUpdateMesh>(prepared: GeometryUpdateState<M>, geometries: readonly Geometry[]) {
  return geometries.every(geometry => {
    const bindings = indices(prepared).source.get(geometry) ?? [];
    return bindings.length > 0 && bindings.every(b => !b.mesh.materials.some(m => m.displacementMap) &&
      b.geometry.position.array === geometry.position.array);
  });
}

/** Rewrites only a geometry's existing region, preserving global material indices. */
function copyRegion(source: Geometry, merged: Geometry, region: GeometryUpdateRegion, topologyChanged: boolean, deformationOnly: boolean) {
  const { vertexOffset, indexOffset, materialIndices } = region;
  const count = source.vertexCount;
  for (const name of vertexAttributes) {
    if (name === 'materialIndex' || deformationOnly && name !== 'position' && name !== 'normal' && name !== 'tangent') continue;
    const target = merged[name]; if (!target) continue;
    const attribute = name === 'uv1' ? source.uv1 ?? source.uv : source[name];
    const offset = vertexOffset * target.itemSize;
    if (attribute && attribute.itemSize !== target.itemSize) {
      for (let v = 0; v < count; v++) for (let c = 0; c < target.itemSize; c++) {
        target.array[offset + v * target.itemSize + c] = c < attribute.itemSize ? attribute.array[v * attribute.itemSize + c] : name === 'tangent' && !hasGeneratedVertexTangents(source) ? 2 : 0;
      }
    }
    else if (attribute) target.array.set(attribute.array, offset);
    else target.array.fill(name === 'color' ? 1 : 0, offset, offset + count * target.itemSize);
  }
  if (!topologyChanged) return;
  writeMaterialIndices(source, materialIndices, merged.materialIndex!.array, vertexOffset);
  const indices = source.indexArray;
  for (let i = 0; i < indices.length; i++) writeIndex(merged, indexOffset + i, indices[i] + vertexOffset);
}

/** Constant-time topology detection; markUpdated also covers in-place index edits. */
export function geometryTopologyChanged(prepared: {geometryStates: Prepared['geometryStates']} | undefined, source: Geometry) {
  const state = prepared?.geometryStates.get(source);
  return !!state && (state.topologyVersion !== source.topologyVersion ||
    state.indices !== source.indices.array || state.indexCount !== source.indexArray.length);
}

export interface GeometryUpdateOptions {
  softwareBvhs?: boolean;
  displacement?: Map<Geometry, {scale: number; ranges: Float32Array}>;
}

/** Refits/rebuilds changed BLASes and refreshes all shared instances' cached bounds. */
export function updatePreparedGeometries<M extends GeometryUpdateMesh>(prepared: GeometryUpdateState<M>, changed: ReadonlySet<Geometry>, options: GeometryUpdateOptions = {}) {
  const vertices: { first: number; count: number; topologyChanged: boolean; deformationOnly: boolean }[] = [];
  const blases: { blas: FlattendBVH; offset: number }[] = [];
  const meshes = new Set<M>();
  let resized = false, relocated = false, offset = 0;
  const updated = new Map<Geometry, FlattendBVH>();
  prepared.geometries.forEach((geometry, i) => {
    const source = indices(prepared).prepared.get(geometry)?.[0].mesh.geometry ?? geometry;
    const previous = i < prepared.blases.length ? prepared.blases[i].bvh : undefined;
    if (changed.has(source)) {
      const region = prepared.geometryRegions.get(geometry)!;
      const topologyChanged = geometryTopologyChanged(prepared, source);
      const deformationOnly = !topologyChanged && isDeformationUpdate(source);
      if (options.softwareBvhs !== false) {
        const displacement = options.displacement?.get(geometry);
        const key = displacement ? geometry : source;
        let bvh = updated.get(key);
        if (!bvh) {
          bvh = displacement ? getGeometryBvh(geometry) ?? getGeometryBvh(source) : getGeometryBvh(source);
          const detail = displacement ? {normal: source.normal.array,
            scale: displacement.scale, ranges: displacement.ranges} : undefined;
          if (topologyChanged || !bvh || source.dynamic && bvh.builder !== 'builtin' || !refitBLAS(bvh, source, detail)) {
            bvh = buildBLAS(source, displacement?.scale, displacement?.ranges);
          }
          setGeometryBvh(source, bvh); updated.set(key, bvh);
        }
        setGeometryBvh(geometry, bvh);
        prepared.blases[i].bvh = bvh;
        resized ||= previous?.buffer.byteLength !== bvh.buffer.byteLength;
        relocated ||= previous?.buffer.byteLength !== bvh.buffer.byteLength || previous?.layout !== bvh.layout;
        blases.push({blas: bvh, offset});
      }
      geometry.version = source.version;
      if (prepared.mergedAttributes !== false) copyRegion(source, prepared.geometry, region, topologyChanged, deformationOnly);
      const count = source.vertexCount, previousVertices = vertices[vertices.length - 1];
      if (prepared.mergedAttributes !== false && previousVertices && previousVertices.first + previousVertices.count === region.vertexOffset && previousVertices.topologyChanged === topologyChanged && previousVertices.deformationOnly === deformationOnly) previousVertices.count += count;
      else vertices.push({first: region.vertexOffset, count, topologyChanged, deformationOnly});
      for (const binding of indices(prepared).prepared.get(geometry) ?? []) {
        const bounds = options.softwareBvhs === false ? computeGeometryBounds(geometry) : getBvhBounds(geometry);
        // Keep shared bound arrays: native generic-record values read from a Map
        // can be copies, so replacing their tuple does not update the owner view.
        copyNumericStorage(binding.bvhBounds[0], matrixStorage(bounds[0]));
        copyNumericStorage(binding.bvhBounds[1], matrixStorage(bounds[1]));
        meshes.add(binding.mesh);
      }
    }
    if (i < prepared.blases.length) offset += prepared.blases[i].bvh.buffer.byteLength;
  });
  for (const source of changed) prepared.geometryStates.set(source, { topologyVersion: source.topologyVersion,
    indices: source.indices.array, indexCount: source.indexArray.length });
  return { vertices, blases, meshes, resized, relocated };
}

function writeIndex(geometry: Geometry, index: number, value: number) {
  const array = geometry.indexArray;
  array[index] = value;
}

function packAttribute<T extends AttributeData>(attribute: Attribute<T> | undefined,
  output: Float32Array, stride: number, offset: number, first: number, count: number, outputFirst = first) {
  if (!attribute) return;
  const array = attribute.array, size = attribute.itemSize;
  let destination = outputFirst * stride + offset, source = first * size;
  if (size === 1) {
    for (let i = 0; i < count; i++, destination += stride, source += size) {
      output[destination] = attributeValue(array, source);
    }
    return;
  }
  if (size === 2) {
    for (let i = 0; i < count; i++, destination += stride, source += size) {
      output[destination] = attributeValue(array, source);
      output[destination + 1] = attributeValue(array, source + 1);
    }
    return;
  }
  if (size === 3) {
    for (let i = 0; i < count; i++, destination += stride, source += size) {
      output[destination] = attributeValue(array, source);
      output[destination + 1] = attributeValue(array, source + 1);
      output[destination + 2] = attributeValue(array, source + 2);
    }
    return;
  }
  if (size === 4) {
    for (let i = 0; i < count; i++, destination += stride, source += size) {
      output[destination] = attributeValue(array, source);
      output[destination + 1] = attributeValue(array, source + 1);
      output[destination + 2] = attributeValue(array, source + 2);
      output[destination + 3] = attributeValue(array, source + 3);
    }
    return;
  }
  for (let i = 0; i < count; i++, destination += stride, source += size) {
    for (let c = 0; c < size; c++) output[destination + c] = attributeValue(array, source + c);
  }
}

/** Packs the same interleaved vertex layout for full and partial GPU uploads. */
export function packVertexAttributes(geometry: Geometry, output: Float32Array, stride: number,
  offsets: readonly number[], first: number, count: number, includeMaterialIndex = true, deformationOnly = false, outputFirst = first) {
  packAttribute(geometry.position, output, stride, offsets[0], first, count, outputFirst);
  packAttribute(geometry.normal, output, stride, offsets[1], first, count, outputFirst);
  if (!deformationOnly) {
    packAttribute(geometry.uv, output, stride, offsets[2], first, count, outputFirst);
    packAttribute(geometry.uv1, output, stride, offsets[3], first, count, outputFirst);
    packAttribute(geometry.color, output, stride, offsets[4], first, count, outputFirst);
  }
  packAttribute(geometry.tangent, output, stride, offsets[5], first, count, outputFirst);
  if (includeMaterialIndex) packAttribute(geometry.materialIndex, output, stride, offsets[6], first, count, outputFirst);
}
