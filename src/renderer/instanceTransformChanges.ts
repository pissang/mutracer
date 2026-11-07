import type InstancedMesh from '../scene/InstancedMesh.js';
import type Mesh from '../scene/Mesh.js';
import {matrixStorage} from '../math/storage.js';
import type {MeshInstances} from './meshInstances.js';
import type {PreparedMeshInstanceBinding} from './prepareMeshBVH.js';

type Range = {start: number; end: number};
type Change = {from: number; to: number; ranges: Range[]};
const changes = new WeakMap<InstancedMesh, Change[]>();

/** Diff the notified snapshot, preserving the existing whole-array commit contract. */
export function recordInstanceTransformChanges(mesh: InstancedMesh, before: Float32Array | undefined,
  after: Float32Array, from: number | undefined, to: number) {
  if (!before || before.length !== after.length || from === undefined) { changes.delete(mesh); return; }
  const ranges: Range[] = [];
  for (let i = 0; i < after.length; i += 16) {
    let different = false;
    for (let j = i; j < Math.min(i + 16, after.length); j++) {
      if (!Object.is(before[j], after[j])) { different = true; break; }
    }
    if (!different) continue;
    const start = i / 16, last = ranges[ranges.length - 1];
    if (last?.end === start) last.end++;
    else ranges.push({start, end: start + 1});
  }
  const history = changes.get(mesh) ?? [];
  // Version can reset on replacement; incomplete history falls back to all slots.
  if (history.length && history[history.length - 1].to !== from) history.length = 0;
  history.push({from, to, ranges});
  if (history.length > 16) history.shift();
  changes.set(mesh, history);
}

type Snapshot = {version: number; storage: Float32Array; parent: Float64Array};
const snapshots = new WeakMap<object, Map<Mesh, Snapshot>>();

export function rememberInstanceTransforms(instances: MeshInstances, bindings: PreparedMeshInstanceBinding[]) {
  const state = new Map<Mesh, Snapshot>();
  for (const {mesh} of bindings) {
    const batch = mesh.instanceData;
    if (batch) state.set(mesh, {version: batch.transformsVersion, storage: batch.transforms, parent: matrixStorage(mesh.transform).slice()});
  }
  snapshots.set(instances, state);
}

/** Geometry edits affect bounds of every shared instance, including unmoved ones. */
export function invalidateInstanceTransformRanges(instances: MeshInstances) { snapshots.delete(instances); }

/** Undefined requests the conservative whole-batch path. */
export function changedInstanceTransformRanges(instances: MeshInstances, mesh: Mesh): Range[] | undefined {
  const batch = mesh.instanceData, previous = snapshots.get(instances)?.get(mesh);
  if (!batch || !previous || previous.storage !== batch.transforms || previous.version === batch.transformsVersion) return;
  const parent = matrixStorage(mesh.transform);
  for (let i = 0; i < 16; i++) if (!Object.is(previous.parent[i], parent[i])) return;
  const history = changes.get(mesh as InstancedMesh);
  let version = previous.version;
  const ranges: Range[] = [];
  for (const entry of history ?? []) {
    if (entry.from !== version) continue;
    for (const range of entry.ranges) ranges.push(range);
    version = entry.to;
  }
  return version === batch.transformsVersion ? ranges : undefined;
}
