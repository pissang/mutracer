import {mat4} from '../math.js';
import type Camera from '../scene/Camera.js';
import type MeshState from '../scene/MeshState.js';
import type MaterialState from '../scene/MaterialState.js';
import type Geometry from '../scene/Geometry.js';
import {AovHistory, validateAovId, type AovFrameSnapshot, type AovInstanceSnapshot} from './aov.js';
import {PackedMeshInstances, readMeshInstance, type MeshInstances} from './packedMeshInstances.js';
import type {FlattendBVH, BLASInstance} from './bvhAccel.js';
import type {PreparedMeshInstanceBinding} from './scenePreparation.js';
const geometryIds = new WeakMap<Geometry, number>();
let nextGeometry = 1;
function geometryId(geometry: Geometry) {
  let id = geometryIds.get(geometry);
  if (id === undefined) { id = nextGeometry++; geometryIds.set(geometry, id); }
  return id;
}
export interface AovSceneSource {
  instances: MeshInstances;
  instanceBindings: PreparedMeshInstanceBinding<MeshState>[];
  materials: MaterialState[];
  geometries: Geometry[];
  blases: BLASInstance[];
}
/** Source instance index for each GPU instance, including TLAS leaf reordering. */
export function aovInstanceOrder(tlas: FlattendBVH): Uint32Array {
  const u = new Uint32Array(tlas.buffer), i = new Int32Array(tlas.buffer);
  const order = new Uint32Array((tlas.instancesBuffer?.byteLength ?? 0) / 160);
  // Native indexed HWRT stores instances linearly and has no software TLAS.
  if (!tlas.buffer.byteLength) { for(let i=0;i<order.length;i++)order[i]=i; return order; }
  function visit(node: number) {
    const o = node * 4, count = i[o + 3];
    if (count >= 0) { visit(node + 2); visit(count); }
    else for (let k = 0; k < -count; k++) order[u[o + 8 + k * 4]] = u[o + 10 + k * 4];
  }
  if (order.length) visit(0);
  return order;
}
export function packAovScene(source: AovSceneSource, tlas: FlattendBVH, camera: Camera,
  width: number, height: number, history: AovHistory, primitiveIds?: Uint32Array, includePrimitives = true): {words: Uint32Array; frame: AovFrameSnapshot} {
  const order = aovInstanceOrder(tlas);
  const instances = source.instances;
  const frame: AovFrameSnapshot = {width, height, viewProjection: new Float32Array(16), instances: []};
  const view = mat4.create(); mat4.invert(view, camera.transform);
  mat4.mul(frame.viewProjection, camera.getProjectionMatrix(width / height), view);
  const eye = new Float32Array([camera.transform[12],camera.transform[13],camera.transform[14],1]);
  const length = Math.hypot(camera.transform[8],camera.transform[9],camera.transform[10]);
  const forward = new Float32Array([-camera.transform[8]/length,-camera.transform[9]/length,-camera.transform[10]/length,0]);
  frame.cameraEye=eye; frame.cameraForward=forward;
  const records: AovInstanceSnapshot[] = [];
  for (let gpuIndex = 0; gpuIndex < order.length; gpuIndex++) {
    const index = order[gpuIndex];
    const binding = source.instanceBindings[instances instanceof PackedMeshInstances ? instances.bindingIndices[index] : index];
    const mesh = binding.mesh, geometry = mesh.geometry;
    records.push({object: validateAovId(mesh.aovId), instance: instances instanceof PackedMeshInstances ? instances.localIndices[index] : 0,
      topology: geometryId(geometry) + geometry.topologyVersion * 0x100000000,
      vertices: geometry.version, transform: new Float32Array(readMeshInstance(instances, index).transform)});
  }
  frame.instances = records;
  const materialOffset = 52 + order.length * 24;
  const primitiveOffset = materialOffset + source.materials.length;
  const primitiveCount = primitiveIds?.length ?? tlas.buffer.byteLength / 16 + source.blases.reduce((n, b) => n + b.bvh.buffer.byteLength / 16, 0);
  // Web targets keep the primitive tail resident; only pack the small
  // camera/instance/material prefix when their cached primitive map is supplied.
  const words = new Uint32Array(primitiveOffset + (includePrimitives ? primitiveCount : 0)), floats = new Float32Array(words.buffer);
  const previous = history.previous(frame);
  if (previous) floats.set(previous.viewProjection);
  words[16] = materialOffset; words[17] = primitiveOffset;
  const projection = new Float32Array(Array.from(camera.getProjectionMatrix(width/height)));
  let projectionHash=2166136261;
  for (const word of new Uint32Array(projection.buffer)) projectionHash=Math.imul(projectionHash^word,16777619)>>>0;
  words[18]=projectionHash;
  floats.set(frame.viewProjection,20);
  floats.set(eye,36);floats.set(forward,40);
  if(previous?.cameraEye && previous.cameraForward){floats.set(previous.cameraEye,44);floats.set(previous.cameraForward,48);}
  const objectIds = new Set<number>();
  for (const binding of source.instanceBindings) {
    const id = validateAovId(binding.mesh.aovId);
    if (objectIds.has(id)) throw new Error('AOV object IDs must be unique');
    objectIds.add(id);
  }
  records.forEach((record, index) => {
    const o = 52 + index * 24;
    words[o] = record.object; words[o + 1] = record.instance;
    const old = history.match(frame, record), inverse = mat4.create();
    if (old && mat4.invert(inverse, record.transform)) {
      const reprojection = mat4.create(); mat4.mul(reprojection, old.transform, inverse);
      floats.set(Array.from(reprojection), o + 4); words[o + 2] = 1;
    }
  });
  const materialIds = new Set<number>();
  source.materials.forEach((material, index) => {
    const id = validateAovId(material.aovId);
    if (materialIds.has(id)) throw new Error('AOV material IDs must be unique');
    materialIds.add(id); words[materialOffset + index] = id;
  });
  if (!includePrimitives) return {words, frame};
  words.fill(0xffffffff, primitiveOffset);
  if(primitiveIds){words.set(primitiveIds,primitiveOffset);return {words,frame};}
  let base = tlas.buffer.byteLength / 16;
  source.blases.forEach((blas, index) => {
    const bvh = new Uint32Array(blas.bvh.buffer), indices = source.geometries[index].indexArray;
    const triangles = new Map<string, number>();
    for (let t = 0; t < indices.length / 3; t++) triangles.set(`${indices[t*3]},${indices[t*3+1]},${indices[t*3+2]}`, t);
    for (let record = 0; record < bvh.length / 4; record++) {
      const t = triangles.get(`${bvh[record*4]},${bvh[record*4+1]},${bvh[record*4+2]}`);
      if (t !== undefined) words[primitiveOffset + base + record] = t;
    }
    // Explicit builder metadata disambiguates duplicate index triples.
    const ids = blas.bvh.triangleIds;
    if (ids) for (let i = 0; i < ids.length; i += 2) words[primitiveOffset + base + ids[i]] = ids[i+1];
    base += bvh.length / 4;
  });
  return {words, frame};
}
